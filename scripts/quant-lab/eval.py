"""
Quant lab scorecard. Everything is scored on HELD-OUT COINS (never seen by any fitted piece).

Per question, per contender:
  - ECE   expected calibration error, 10 equal-width bins: Σ (n_b/N)·|mean p − event rate|. Target ≤ 0.10.
  - BSS   Brier skill vs always predicting the TRAIN base rate. > 0 means it knows something.
  - AUC   ranking skill (0.5 = coin flip). ECE alone is gameable by predicting the base rate; AUC isn't.
Contenders:
  jev      Jev's raw probability
  jev+cal  Jev's probability through an isotonic map fitted on the train coins
  code     gradient-boosted trees on the same features Jev sees, trained on the train coins
  stack    code + Jev as two inputs to a logistic fit on train (does Jev add anything over code?)

Usage: uv run --with scikit-learn --with numpy python scripts/quant-lab/eval.py lab-v2 [lab-v1 ...]
"""
import json, sys, hashlib, math
import numpy as np
from sklearn.isotonic import IsotonicRegression
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

rows = [json.loads(l) for l in open("data/lab/dataset.jsonl")]
by_id = {r["id"]: r for r in rows}
coins = sorted(set(r["sym"] for r in rows))
# Fixed held-out third of coins, by hash so it never drifts between runs.
TEST = {c for c in coins if int(hashlib.md5(c.encode()).hexdigest(), 16) % 3 == 0}
TRAIN = set(coins) - TEST
# Time split on top: held-out coins AND the future. Train rows end before CUT; test rows start 14 days after
# (so no 7-day outcome window straddles the gap). Stops the model learning "this date crashed" from other
# coins' same-day rows via the market-tide features.
import os
CUT = int(os.environ.get("LAB_CUT", "1756684800"))  # 2025-09-01
GAP = 14 * 86400
MODE = os.environ.get("LAB_SPLIT", "coin+time")
def is_train(r):
    return r["sym"] in TRAIN and (MODE == "coin" or r["t"] + 7 * 86400 < CUT)
def is_test(r):
    return r["sym"] in TEST and (MODE == "coin" or r["t"] >= CUT + GAP)

PATTERN_KINDS = ["double_top", "double_bottom", "head_shoulders", "inv_head_shoulders", "bull_flag", "bear_flag", "accumulation", "distribution", "asc_triangle", "desc_triangle"]

def top_pattern(r):
    best, bs = None, -1
    for i, p in enumerate(r["f"]["patterns"]):
        s = (1 if p["confirmed"] else 0) + float(p["quality"])
        if s > bs: best, bs = (i, p), s
    return best

# Outcome definitions — must match rubrics.ts.
def y_of(q, r):
    h24, h168 = r["y"]["h24"], r["y"]["h168"]
    if q == "up25_7d": return int(h168["up"] >= 0.25)
    if q == "down25_7d": return int(h168["dd"] >= 0.25)
    if q == "higher_7d": return int(h168["ret"] > 0)
    if q == "dump_24h": return int(h24["dd"] >= 0.3)
    if q == "dump_7d": return int(h168["dd"] >= 0.5)
    if q == "pump_7d": return int(h168["up"] >= 1)
    if q == "pattern_works":
        tp = top_pattern(r)
        if not tp: return None
        o = r["y"]["patterns"][tp[0]]
        return None if o is None else int(o == "target")
    raise KeyError(q)

def feats(r):
    f = r["f"]; v = []
    for k in ["age_days", "from_ath", "days_since_ath", "ret_24h", "ret_7d", "ret_30d", "vol_30d", "range_pos_30d", "up_from_30d_low", "volume_7d_vs_30d"]:
        v.append(f["coin"].get(k))
    ch = f["chart"] or {}
    for k in ["rsi14", "macd_hist", "bb_pos", "bb_width", "ema20_vs_ema50", "atr_pct", "roc_24h", "roc_6h", "drawdown_from_high", "range_pos", "vol_z", "obv_slope", "vwap_dist", "stoch_rsi"]:
        v.append(ch.get(k))
    v.append({"bull": 1, "bear": -1}.get(ch.get("macd_cross"), 0))
    v.append(1 if ch.get("higher_lows") else 0)
    for k in ["btc_ret_24h", "btc_ret_7d", "btc_trend", "sol_ret_24h", "sol_ret_7d", "sol_trend"]:
        v.append(f["tide"].get(k))
    tp = top_pattern(r)
    for kind in PATTERN_KINDS: v.append(1 if tp and tp[1]["kind"] == kind else 0)
    for k in ["to_trigger", "to_target", "to_stop", "quality"]: v.append(tp[1][k] if tp else None)
    v.append(1 if tp and tp[1]["confirmed"] else 0)
    return [np.nan if x is None else float(x) for x in v]

# Barrier questions: (direction, level as a fraction, horizon in days). The volatility baseline answers them
# with the reflection principle for a driftless random walk in log price:
#   P(touch level within T) = 2·(1 − Φ(|ln level| / (k·σ_daily·√T)))
# σ = realised 30-day daily vol (known at t); k is ONE scale factor fitted on train (memecoin tails are fat).
BARRIERS = {"up25_7d": (+1, 0.25, 7), "down25_7d": (-1, 0.25, 7), "dump_24h": (-1, 0.30, 1), "dump_7d": (-1, 0.50, 7), "pump_7d": (+1, 1.0, 7)}
from math import erf, sqrt, log
def barrier_p(q, r, k, w=1.0):
    if q == "higher_7d": return 0.5
    if q not in BARRIERS: return None
    sgn, lvl, T = BARRIERS[q]
    v = r["f"]["coin"].get("vol_30d")
    if not v: return None
    atr = (r["f"]["chart"] or {}).get("atr_pct")
    # Blend 30-day daily vol with the recent hourly ATR scaled to a day: volatility clusters.
    sig = w * v + (1 - w) * (atr * sqrt(24) if atr else v)
    a = abs(log(1 + lvl)) if sgn > 0 else abs(log(1 - lvl))
    z = a / (k * sig * sqrt(T))
    return max(1e-4, min(1 - 1e-4, 2 * (1 - 0.5 * (1 + erf(z / sqrt(2))))))

def ece(p, y, bins=10):
    p, y = np.asarray(p), np.asarray(y); e = 0.0
    for b in range(bins):
        m = (p >= b / bins) & (p < (b + 1) / bins) if b < bins - 1 else (p >= b / bins)
        if m.any(): e += m.mean() * abs(p[m].mean() - y[m].mean())
    return e

def score(p, y, base):
    p, y = np.clip(np.asarray(p, float), 0, 1), np.asarray(y)
    brier = np.mean((p - y) ** 2); ref = np.mean((base - y) ** 2)
    auc = roc_auc_score(y, p) if 0 < y.mean() < 1 else float("nan")
    return {"ece": ece(p, y), "bss": 1 - brier / ref if ref > 0 else float("nan"), "auc": auc}

def load_answers(version):
    out = {}
    try:
        for l in open(f"data/lab/answers-{version}.jsonl"):
            a = json.loads(l); out[a["id"]] = a["answers"]
    except FileNotFoundError:
        pass
    return out

def ok(s): return s["ece"] <= 0.10 and s["bss"] > 0 and s["auc"] >= 0.6  # nan compares False → never ok

def gbm():
    return HistGradientBoostingClassifier(max_iter=200, learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=40, l2_regularization=1.0)

def logit(x):
    x = np.clip(x, 1e-4, 1 - 1e-4)
    return np.log(x / (1 - x))

def run(version):
    ans = load_answers(version)
    qs = sorted({q for a in ans.values() for q in a})
    print(f"\n## {version}  —  split {MODE} (cut {CUT}) · {len(ans)} answered rows · train coins {len(TRAIN)} · held-out {sorted(TEST)}")
    print(f"{'question':15} {'n_test':>6} {'base':>5} | {'vol (reflection)':^21} | {'vol+jev':^21} | {'jev ece/bss/auc':^21} | {'jev+cal':^21} | {'code':^21} | {'stack':^21}")
    out = {}
    for q in qs:
        data = []
        for rid, a in ans.items():
            r = by_id.get(rid)
            if not r or q not in a or a[q].get("noul") is None: continue
            y = y_of(q, r)
            if y is None: continue
            data.append((r["sym"], a[q]["noul"], y, feats(r), is_train(r), is_test(r), r))
        tr = [d for d in data if d[4]]; te = [d for d in data if d[5]]
        if len(tr) < 50 or len(te) < 30 or len({d[2] for d in te}) < 2: continue
        s_tr = np.array([d[0] for d in tr])
        ptr, ytr, Xtr = np.array([d[1] for d in tr]), np.array([d[2] for d in tr]), np.array([d[3] for d in tr])
        pte, yte, Xte = np.array([d[1] for d in te]), np.array([d[2] for d in te]), np.array([d[3] for d in te])
        base = ytr.mean()
        iso = IsotonicRegression(out_of_bounds="clip", y_min=0, y_max=1).fit(ptr, ytr)
        cte = gbm().fit(Xtr, ytr).predict_proba(Xte)[:, 1]
        # Stack: code's train predictions must be out-of-fold (4 folds by coin) or the stack learns to trust
        # an overfit code model.
        trs = sorted(set(s_tr)); oof = np.full(len(tr), base)
        for k in range(4):
            m = np.isin(s_tr, trs[k::4])
            if m.all() or not m.any() or len(set(ytr[~m])) < 2: continue
            oof[m] = gbm().fit(Xtr[~m], ytr[~m]).predict_proba(Xtr[m])[:, 1]
        st = LogisticRegression().fit(np.c_[logit(oof), logit(ptr)], ytr)
        # Volatility baseline: fit the one scale factor k on train, by Brier.
        vol_res = None
        vol_jev = None
        if q in BARRIERS or q == "higher_7d":
            rtr = [d[6] for d in tr]; rte = [d[6] for d in te]
            best = (9, 1.0, 1.0)
            for w in [0, 0.25, 0.5, 0.75, 1.0]:
                for k in [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.4, 1.6, 2.0, 2.4]:
                    pv = np.array([barrier_p(q, rr, k, w) or base for rr in rtr])
                    b = np.mean((pv - ytr) ** 2)
                    if b < best[0]: best = (b, k, w)
            _, bk, bw = best
            vtr = np.array([barrier_p(q, rr, bk, bw) or base for rr in rtr])
            vte = np.array([barrier_p(q, rr, bk, bw) or base for rr in rte])
            vol_res = score(vte, yte, base)
            vol_res.update(k=bk, w=bw)
            # The deployable blend: the physics anchor, adjusted by Jev (two weights fitted on train).
            vj = LogisticRegression().fit(np.c_[logit(vtr), logit(ptr)], ytr)
            vol_jev = score(vj.predict_proba(np.c_[logit(vte), logit(pte)])[:, 1], yte, base)
        res = {
            "vol": vol_res or {"ece": float("nan"), "bss": float("nan"), "auc": float("nan")},
            "vol+jev": vol_jev or {"ece": float("nan"), "bss": float("nan"), "auc": float("nan")},
            "jev": score(pte, yte, base),
            "jev+cal": score(iso.predict(pte), yte, base),
            "code": score(cte, yte, base),
            "stack": score(st.predict_proba(np.c_[logit(cte), logit(pte)])[:, 1], yte, base),
        }
        out[q] = {"n_test": len(te), "base": float(yte.mean()), **res}
        cell = lambda s: f"{s['ece']:.3f}/{s['bss']:+.2f}/{s['auc']:.2f}{'✓' if ok(s) else ' '}"
        print(f"{q:15} {len(te):>6} {yte.mean():>5.2f} | {cell(res['vol']):^21} | {cell(res['vol+jev']):^21} | {cell(res['jev']):^21} | {cell(res['jev+cal']):^21} | {cell(res['code']):^21} | {cell(res['stack']):^21}")
    return out

_RNG = np.random.default_rng(7)
def rw_first_passage(a, b, sig_daily, days=14, paths=4000):
    """P(a driftless hourly random walk with this daily vol touches +a before −b within `days`), Monte
    Carlo. The fair benchmark for a pattern's target-before-stop rate over the same window."""
    steps = days * 24
    x = np.cumsum(_RNG.normal(0, sig_daily / math.sqrt(24), size=(paths, steps)), axis=1)
    up = np.where((x >= a).any(1), (x >= a).argmax(1), steps + 1)
    dn = np.where((x <= -b).any(1), (x <= -b).argmax(1), steps + 1)
    return float(np.mean(up < dn))

def pattern_table():
    """Does the pattern beat a coin flip? For a driftless random walk the chance of touching the target
    (log distance a) before the stop (log distance b) within the same 14 days, simulated with the coin's own
    volatility. A pattern has an edge only if its real target rate beats that. One count per
    distinct pattern (first sighting), so a shape seen in 10 snapshots isn't counted 10 times."""
    print("\n## pattern follow-through vs a random walk (distinct patterns, 14d, target before stop)")
    seen, stats = set(), {}
    for r in sorted(rows, key=lambda r: (r["sym"], r["t"])):
        for p, o in zip(r["f"]["patterns"], r["y"]["patterns"]):
            if o is None: continue
            key = (r["sym"], p["kind"], round(p["to_target"] + p["to_stop"], 2), p.get("bars_old", 0) // 6)
            ident = (r["sym"], p["kind"], r["t"] // (7 * 86400))
            if ident in seen: continue
            seen.add(ident)
            a = abs(math.log(1 + p["to_target"])); b = abs(math.log(1 + p["to_stop"]))
            sig = r["f"]["coin"].get("vol_30d")
            if not sig: continue
            st = stats.setdefault(p["kind"], {"n": 0, "hit": 0, "rw": 0.0})
            st["n"] += 1; st["hit"] += o == "target"; st["rw"] += rw_first_passage(a, b, sig)
    print(f"{'pattern':20} {'n':>4} {'target hit':>10} {'random-walk':>11} {'edge':>7}")
    for k, st in sorted(stats.items()):
        hit, rw = st["hit"] / st["n"], st["rw"] / st["n"]
        print(f"{k:20} {st['n']:>4} {hit:>10.0%} {rw:>11.0%} {hit - rw:>+7.0%}")

if __name__ == "__main__":
    pattern_table()
    report = {v: run(v) for v in sys.argv[1:]}
    json.dump(report, open("data/lab/scorecard.json", "w"), indent=1, default=float)
