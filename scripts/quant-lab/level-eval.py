"""
LEVEL LAB scorecard: are the price-level percentages accurate?

Held out BOTH ways: a third of the coins never seen in training, and only months after the training cut
(with a 7-day embargo so no outcome window straddles it). Rows overlap in time (several levels per snapshot,
windows overlap), so treat the ± on rates as optimistic.

Contenders per horizon (4h / 24h / 3d):
  physics        reflection-principle touch probability, the coin's own volatility, no fitting
  physics+cal    physics through an isotonic map fitted on training rows
  full           gradient boosting on logit(physics) + every internal input (market tide, coin trend,
                 level strength/sources, pattern ideas, volume, time), then isotonic-calibrated on the
                 last 20% (by time) of training
  full −X        the same without one input group: which inputs earn their place

Accuracy (the target): ECE ≤ 2 pts and every populated 10%-bucket within 5 pts; "confident" calls
(p ≥ 0.8) hit ≥ 80% on held-out data.
Usage: uv run --with pandas --with scikit-learn --with numpy python scripts/quant-lab/level-eval.py
"""
import glob, hashlib, json, sys
import numpy as np, pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import roc_auc_score

df = pd.concat([pd.read_csv(f) for f in glob.glob("data/lab/levels/*.csv")], ignore_index=True)
TRENCH = {x["ticker"].upper() for x in json.load(open("data/lab/trench-coins.json"))} if glob.glob("data/lab/trench-coins.json") else set()
coins = sorted(df.sym.unique())
TEST_COINS = {c for c in coins if int(hashlib.md5(c.encode()).hexdigest(), 16) % 3 == 0} | {"BTC", "ETH", "SOL"}
# BTC/ETH/SOL are the cross-check anchors: always held out, so every run reports them on unseen data.
CUT = pd.Timestamp("2025-06-01", tz="UTC").timestamp()
EMB = 7 * 86400
t = df.t.values
train = (~df.sym.isin(TEST_COINS)) & (t + 3 * 86400 < CUT)
test = df.sym.isin(TEST_COINS) & (t >= CUT + EMB)
print(f"rows {len(df):,} · coins {len(coins)} · train {train.sum():,} rows on {df[train].sym.nunique()} coins < 2025-06 · test {test.sum():,} rows on {df[test].sym.nunique()} held-out coins ≥ 2025-06-08")

GROUPS = {
    "tide": ["btc_d", "btc_w", "btc_r24", "btc_r7d", "breadth"],
    "coin_trend": ["coin_d", "coin_w", "r24", "r7d", "rsi1h"],
    "level": ["score", "touches", "n_src", "src_pivot", "src_volume", "src_vwap", "src_fib", "src_round", "src_extreme", "src_band"],
    "ideas": ["hyp_through", "hyp_against", "hyp_n"],
    "flow": ["vol_ratio", "vol_z", "hour", "dow"],
}
BASE = ["side", "dist", "dist_atr", "sigma"]

def lg(p):
    p = np.clip(p, 1e-4, 1 - 1e-4)
    return np.log(p / (1 - p))

def ece(p, y):
    e, worst = 0.0, 0.0
    for b in range(10):
        m = (p >= b / 10) & ((p < (b + 1) / 10) if b < 9 else (p <= 1))
        if m.sum() >= 200:
            gap = abs(p[m].mean() - y[m].mean())
            e += m.mean() * gap
            worst = max(worst, gap)
        elif m.any():
            e += m.mean() * abs(p[m].mean() - y[m].mean())
    return e, worst

def report(name, p, y, base):
    e, worst = ece(p, y)
    skill = 1 - np.mean((p - y) ** 2) / np.mean((base - y) ** 2)
    auc = roc_auc_score(y, p)
    hi = p >= 0.8
    lo = p <= 0.2
    ok = e <= 0.02 and worst <= 0.05 and (not hi.any() or y[hi].mean() >= 0.8)
    return {"name": name, "ece": e, "worst_bucket": worst, "skill": skill, "auc": auc,
            "conf80_share": hi.mean(), "conf80_hit": y[hi].mean() if hi.any() else None,
            "conf20_share": lo.mean(), "conf20_hit": y[lo].mean() if lo.any() else None, "pass": ok}

def fmt(r):
    c80 = f"{r['conf80_share']:5.1%} of calls ≥80% → hit {r['conf80_hit']:.1%}" if r["conf80_hit"] is not None else "no calls ≥80%"
    return f"  {r['name']:14} ECE {r['ece']*100:4.1f} pts · worst bucket {r['worst_bucket']*100:4.1f} · skill {r['skill']:+.3f} · AUC {r['auc']:.3f} · {c80} {'✓' if r['pass'] else ''}"

def gbm():
    return HistGradientBoostingClassifier(max_iter=300, learning_rate=0.05, max_leaf_nodes=31, min_samples_leaf=200, l2_regularization=1.0)

results = {}
for h in [4, 24, 72]:
    yc, pc = f"y{h}", f"phys{h}"
    d = df[df[yc].notna()]
    tr, te = d[train[d.index]], d[test[d.index]]
    ytr, yte = tr[yc].values.astype(float), te[yc].values.astype(float)
    base = np.full(len(yte), ytr.mean())
    out = []
    out.append(report("physics", te[pc].values, yte, base))
    iso = IsotonicRegression(out_of_bounds="clip", y_min=0, y_max=1).fit(tr[pc].values, ytr)
    out.append(report("physics+cal", iso.predict(te[pc].values), yte, base))
    # Full model: fit on the first 80% of train (by time), calibrate on the last 20%.
    order = np.argsort(tr.t.values)
    k = int(len(order) * 0.8)
    fit_i, cal_i = order[:k], order[k:]
    def full(cols, label):
        X = lambda f: np.c_[lg(f[pc].values), f[cols].values]
        m = gbm().fit(X(tr.iloc[fit_i]), ytr[fit_i])
        cal = IsotonicRegression(out_of_bounds="clip", y_min=0, y_max=1).fit(m.predict_proba(X(tr.iloc[cal_i]))[:, 1], ytr[cal_i])
        return cal.predict(m.predict_proba(X(te))[:, 1]), m, cal
    allc = BASE + sum(GROUPS.values(), [])
    pf, model, cal = full(allc, "full")
    out.append(report("full", pf, yte, base))
    for g, cols in GROUPS.items():
        p_abl, _, _ = full([c for c in allc if c not in cols], f"-{g}")
        out.append(report(f"full −{g}", p_abl, yte, base))
    print(f"\n── touch within {h}h · held-out n={len(yte):,} · base rate {yte.mean():.1%}")
    for r in out: print(fmt(r))
    # Slices of the full model: anchors, trenches, market condition toward the level.
    te = te.assign(p=pf)
    print("  slices (full model):")
    for name, m in [("BTC", te.sym == "BTC"), ("ETH", te.sym == "ETH"), ("SOL", te.sym == "SOL"),
                    ("trenches", te.sym.isin(TRENCH)), ("majors/alts", ~te.sym.isin(TRENCH)),
                    ("tide toward level", te.btc_d == 1), ("tide flat", te.btc_d == 0), ("tide away", te.btc_d == -1)]:
        if m.sum() < 300: continue
        e, worst = ece(te.p.values[m], te[yc].values[m])
        print(f"    {name:18} n={m.sum():7,}  predicted {te.p.values[m].mean():5.1%}  actual {te[yc].values[m].mean():5.1%}  ECE {e*100:4.1f} pts  worst {worst*100:4.1f}")
    results[h] = out

json.dump(results, open("data/lab/level-scorecard.json", "w"), indent=1, default=float)
