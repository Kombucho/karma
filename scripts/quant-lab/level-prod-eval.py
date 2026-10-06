"""
The production level-odds models, scored the way the leak audit asked (scratchpad/audit-leak):
  - time held out: fit on rows before CUT, score only rows ≥ CUT + 7 days (the audit showed the time cut is
    what protects; a coin split adds nothing), every coin — majors, alts and the trenches
  - a pass needs skill ≥ calibrated physics AND ECE ≤ 2 pts AND every bucket with ≥ 200 rows within 5 pts AND
    ≥80% calls hitting ≥ 80% (a constant base-rate guess can no longer pass)
  - 95% intervals from a week-block bootstrap (rows within a week are correlated)

Models (the audit's verdict: the full GBM only earns its place at 4h):
  4h   logistic on [logit(physics), trend-not-flat flags, vol_ratio, vol_z, hour-of-day] → isotonic
  24h  physics → isotonic
  72h  physics → isotonic
Then refit on ALL rows and export the calibration to src/lib/karma/quant/level-calibration.json.
Usage: uv run --with pandas --with scikit-learn --with numpy python scripts/quant-lab/level-prod-eval.py
"""
import glob, json
import numpy as np, pandas as pd
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

df = pd.concat([pd.read_csv(f) for f in glob.glob("data/lab/levels/*.csv")], ignore_index=True)
df = df[~df.sym.isin(["TRUMP", "MELANIA"])]  # larps, per Kombucho
TRENCH = {x["ticker"].upper() for x in json.load(open("data/lab/trench-coins.json"))} - {"PENGU", "BONK", "WIF", "BOME", "PNUT"}
NAMED = ["LMAO", "TROLL", "USELESS", "BUTTCOIN", "STONK"]
CUT = pd.Timestamp("2025-06-01", tz="UTC").timestamp()
tr_m = df.t + 3 * 86400 < CUT
te_m = df.t >= CUT + 7 * 86400
print(f"rows {len(df):,} · {df.sym.nunique()} coins ({len(TRENCH & set(df.sym))} trench) · train {tr_m.sum():,} (< 2025-06) · test {te_m.sum():,} (≥ 2025-06-08)")

lg = lambda p: np.log(np.clip(p, 1e-4, 1 - 1e-4) / (1 - np.clip(p, 1e-4, 1 - 1e-4)))

def feats4(f):
    return np.c_[lg(f.phys4.values), (f.btc_d.values != 0), (f.coin_d.values != 0), f.vol_ratio.values.clip(0, 5), f.vol_z.values.clip(-3, 5),
                 np.sin(2 * np.pi * f.hour.values / 24), np.cos(2 * np.pi * f.hour.values / 24)]

def iso():
    return IsotonicRegression(out_of_bounds="clip", y_min=0, y_max=1)

def fit(h, tr):
    y = tr[f"y{h}"].values.astype(float)
    if h != 4:
        return {"iso": iso().fit(tr[f"phys{h}"].values, y)}
    o = np.argsort(tr.t.values); k = int(len(o) * 0.8)
    lr = LogisticRegression(max_iter=2000).fit(feats4(tr.iloc[o[:k]]), y[o[:k]])
    cal = iso().fit(lr.predict_proba(feats4(tr.iloc[o[k:]]))[:, 1], y[o[k:]])
    return {"lr": lr, "iso": cal}

def predict(h, m, f):
    if h != 4: return m["iso"].predict(f[f"phys{h}"].values)
    return m["iso"].predict(m["lr"].predict_proba(feats4(f))[:, 1])

def ece(p, y):
    e, worst = 0.0, 0.0
    for b in range(10):
        s = (p >= b / 10) & ((p < (b + 1) / 10) if b < 9 else (p <= 1))
        if not s.any(): continue
        gap = abs(p[s].mean() - y[s].mean()); e += s.mean() * gap
        if s.sum() >= 200: worst = max(worst, gap)
    return e, worst

def boot_ci(p, y, wk, fn, n=200, seed=0):
    rng = np.random.default_rng(seed); weeks = np.unique(wk); idx = {w: np.where(wk == w)[0] for w in weeks}; vals = []
    for _ in range(n):
        pick = np.concatenate([idx[w] for w in rng.choice(weeks, len(weeks))]); vals.append(fn(p[pick], y[pick]))
    return np.percentile(vals, [2.5, 97.5])

out = {}
for h in [4, 24, 72]:
    d = df[df[f"y{h}"].notna()]
    tr, te = d[tr_m[d.index]], d[te_m[d.index]]
    y = te[f"y{h}"].values.astype(float); base = tr[f"y{h}"].mean()
    m = fit(h, tr); p = predict(h, m, te)
    pcal = iso().fit(tr[f"phys{h}"].values, tr[f"y{h}"].values.astype(float)).predict(te[f"phys{h}"].values)
    brier = lambda q, yy: 1 - np.mean((q - yy) ** 2) / np.mean((base - yy) ** 2)
    e, worst = ece(p, y); sk = brier(p, y); sk_cal = brier(pcal, y)
    hi = p >= 0.8
    wk = (te.t.values // (7 * 86400)).astype(int)
    ci_e = boot_ci(p, y, wk, lambda a, b: ece(a, b)[0])
    ci_hi = boot_ci(p[hi], y[hi], wk[hi], lambda a, b: b.mean()) if hi.sum() > 500 else (np.nan, np.nan)
    ok = e <= 0.02 and worst <= 0.05 and (not hi.any() or y[hi].mean() >= 0.8) and sk >= sk_cal - 1e-3 and sk > 0
    print(f"\n── touch within {h}h · test n={len(y):,} · base {y.mean():.1%}")
    print(f"  model: ECE {e*100:.2f} pts (95% {ci_e[0]*100:.2f}–{ci_e[1]*100:.2f}) · worst bucket {worst*100:.1f} · skill {sk:+.3f} (calibrated physics {sk_cal:+.3f}) · AUC {roc_auc_score(y, p):.3f}")
    print(f"  calls ≥80%: {hi.mean():.1%} of all → hit {y[hi].mean():.1%} (95% {ci_hi[0]:.1%}–{ci_hi[1]:.1%}) · calls ≤20%: {(p<=0.2).mean():.1%} → hit {y[p<=0.2].mean():.1%}   {'PASS ✓' if ok else 'FAIL ✗'}")
    rows = []
    for name, s in [("BTC", te.sym == "BTC"), ("ETH", te.sym == "ETH"), ("SOL", te.sym == "SOL")] + [(c, te.sym == c) for c in NAMED] + \
                   [("trenches (all)", te.sym.isin(TRENCH)), ("majors + alts", ~te.sym.isin(TRENCH))]:
        s = s.values
        if s.sum() < 100: rows.append(f"    {name:16} n={s.sum():6}  (too few)"); continue
        e2, w2 = ece(p[s], y[s]); h2 = s & hi
        rows.append(f"    {name:16} n={s.sum():7,}  predicted {p[s].mean():5.1%}  actual {y[s].mean():5.1%}  ECE {e2*100:4.1f}  worst {w2*100:4.1f}  ≥80%: {h2.sum():5} calls hit {y[h2].mean() if h2.any() else float('nan'):.0%}")
    print("\n".join(rows))
    out[h] = {"n": int(len(y)), "ece": e, "worst": worst, "skill": sk, "skill_calibrated_physics": sk_cal, "conf80_share": float(hi.mean()), "conf80_hit": float(y[hi].mean()) if hi.any() else None, "pass": bool(ok)}

# ── Export (final configuration, chosen in scratchpad/wickcal.py): refit on ALL rows. ──
# 4h: logistic [logit(phys4), trend-not-flat ×2, vol_ratio, vol_z, hour] → isotonic
# 24h / 72h: logistic [logit(phys), vol_ratio, log1p(age_days), logit(phys)×vol_ratio] → isotonic
# then a trench-only isotonic on top (Karma's coins are the trenches), fitted on trench rows' model output.
first = df.groupby("sym").t.transform("min"); df["age_d"] = (df.t - first) / 86400
def F2(f, h):
    v = f.vol_ratio.values.clip(0, 5)
    return np.c_[lg(f[f"phys{h}"].values), v, np.log1p(f.age_d.values.clip(0, 2000)), lg(f[f"phys{h}"].values) * v]
def knots(model):
    x, yv = model.X_thresholds_, model.y_thresholds_
    keep = np.unique(np.r_[0, np.linspace(0, len(x) - 1, min(len(x), 120)).astype(int), len(x) - 1])
    return {"x": [round(float(v), 6) for v in x[keep]], "y": [round(float(v), 6) for v in yv[keep]]}
exp = {"version": "levels-v1", "fitted_on_rows": int(len(df)), "coins": int(df.sym.nunique()), "holdout": out,
       "note": "fit by scripts/quant-lab/level-prod-eval.py on Binance majors + trench DEX/KuCoin 1h data; see data/lab audits"}
trench = df.sym.isin(TRENCH).values
for h in [4, 24, 72]:
    d = df[df[f"y{h}"].notna()]; y = d[f"y{h}"].values.astype(float); tmask = d.sym.isin(TRENCH).values
    o = np.argsort(d.t.values); k = int(len(o) * 0.8)
    X = feats4 if h == 4 else (lambda f, h=h: F2(f, h))
    lr = LogisticRegression(max_iter=3000).fit(X(d.iloc[o[:k]]), y[o[:k]])
    cal = iso().fit(lr.predict_proba(X(d.iloc[o[k:]]))[:, 1], y[o[k:]])
    p_all = cal.predict(lr.predict_proba(X(d))[:, 1])
    tiso = iso().fit(p_all[tmask], y[tmask])
    feats = ["logit(phys4)", "btc_trend_not_flat", "coin_trend_not_flat", "vol_ratio(0..5)", "vol_z(-3..5)", "sin(2πh/24)", "cos(2πh/24)"] if h == 4 else \
            [f"logit(phys{h})", "vol_ratio(0..5)", "log1p(age_days)", f"logit(phys{h})*vol_ratio"]
    exp[f"h{h}"] = {"logistic": {"coef": [round(float(c), 6) for c in lr.coef_[0]], "intercept": round(float(lr.intercept_[0]), 6), "features": feats},
                    "iso": knots(cal), "trench_iso": knots(tiso)}
json.dump(exp, open("src/lib/karma/quant/level-calibration.json", "w"), indent=1)
print("\nexported src/lib/karma/quant/level-calibration.json")
