"""
Score the replayed chart-v1 read (PR #47) on held-out coins/months with its own targets.

Per claim type: ECE (calibration error), BSS (skill vs the base rate of the OTHER coins), AUC.
For level touches, three contenders on the same levels:
  jev        chart-v1's published P(touch 24h)
  physics    reflection-principle touch probability from the coin's own volatility (no fitting)
  phys+jev   logistic blend of the two, fitted leave-one-coin-out (each coin scored by a fit on the others)
Usage: uv run --with scikit-learn --with numpy python scripts/quant-lab/eval-chart-read.py
"""
import json, numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

rows = [json.loads(l) for l in open("data/lab/replay-chart-v1.jsonl")]

def ece(p, y, bins=10):
    e = 0.0
    for b in range(bins):
        m = (p >= b / bins) & (p < (b + 1) / bins) if b < bins - 1 else (p >= b / bins)
        if m.any(): e += m.mean() * abs(p[m].mean() - y[m].mean())
    return e

def logit(x):
    x = np.clip(x, 1e-4, 1 - 1e-4); return np.log(x / (1 - x))

def loco_score(sym, p, y):
    """Brier skill vs the base rate of the other coins, plus ECE and AUC."""
    base = np.array([y[sym != s].mean() for s in sym])
    brier = np.mean((p - y) ** 2); ref = np.mean((base - y) ** 2)
    auc = roc_auc_score(y, p) if 0 < y.mean() < 1 else float("nan")
    return ece(p, y), 1 - brier / ref, auc

def cell(t):
    e, b, a = t
    ok = e <= 0.10 and b > 0 and a >= 0.6
    return f"ece {e:.3f} bss {b:+.2f} auc {a:.2f}{' ✓' if ok else '  '}"

print(f"chart-v1 replay: {len(rows)} reads, coins {sorted(set(r['sym'] for r in rows))}")
for claim in ["touch", "hold", "resolves"]:
    T = [(r["sym"], t["p"], t["y"], t.get("phys")) for r in rows for t in r["targets"] if t["claim"] == claim and t["y"] in (0, 1)]
    if len(T) < 30: print(f"{claim}: n={len(T)} (too few)"); continue
    sym = np.array([x[0] for x in T]); p = np.array([x[1] for x in T], float); y = np.array([x[2] for x in T], float)
    print(f"\n{claim:9} n={len(T)} base={y.mean():.2f}")
    print(f"  jev       {cell(loco_score(sym, p, y))}")
    if claim == "touch":
        ph = np.array([x[3] if x[3] is not None else np.nan for x in T], float)
        m = ~np.isnan(ph)
        s2, p2, y2, ph2 = sym[m], p[m], y[m], ph[m]
        print(f"  physics   {cell(loco_score(s2, ph2, y2))}")
        blend = np.zeros(len(y2))
        for s in sorted(set(s2)):
            tr, te = s2 != s, s2 == s
            lr = LogisticRegression().fit(np.c_[logit(ph2[tr]), logit(p2[tr])], y2[tr])
            blend[te] = lr.predict_proba(np.c_[logit(ph2[te]), logit(p2[te])])[:, 1]
        print(f"  phys+jev  {cell(loco_score(s2, blend, y2))}")
# next_move: which of S1 / R1 first, or chop. Multi-class Brier vs the other coins' frequencies.
F = [(r["sym"], t["probabilities"], t["y"]) for r in rows for t in r["targets"] if t["claim"] == "first" and isinstance(t["y"], str)]
if F:
    keys = ["retest_support", "push_resistance", "chop"]
    sym = np.array([f[0] for f in F])
    P = np.array([[f[1].get(k, 0) for k in keys] for f in F]); Y = np.array([[f[2] == k for k in keys] for f in F], float)
    base = np.array([Y[sym != s].mean(0) for s in sym])
    bs = np.mean(np.sum((P - Y) ** 2, 1)); ref = np.mean(np.sum((base - Y) ** 2, 1))
    hit = np.mean(P.argmax(1) == Y.argmax(1)); maj = np.mean(base.argmax(1) == Y.argmax(1))
    print(f"\nnext_move n={len(F)} freq {dict(zip(keys, Y.mean(0).round(2)))}  skill {1 - bs / ref:+.2f}  top-pick hit {hit:.0%} (always-most-common: {maj:.0%})")

# ── chart-v2 (run with CHART=v2): the claims the card shows, as published ──────────────────────────────
import os
if os.environ.get("CHART") == "v2":
    rows = [json.loads(l) for l in open("data/lab/replay-chart-v2.jsonl")]
    print(f"\n\n=== chart-v2 replay: {len(rows)} reads ===")
    fams = {
        "touch 24h (physics+Jev, shown)": lambda t: t["claim"] == "touch" and t["horizon_h"] == 24,
        "touch 7d (physics, shown)": lambda t: t["claim"] == "touch" and t["horizon_h"] == 168,
        "pattern target-first 7d (physics)": lambda t: t["claim"] == "resolves",
        "week ±25% (physics, shown)": lambda t: t["claim"] == "move",
    }
    for name, f in fams.items():
        T = [(r["sym"], t["p"], t["y"], t.get("jev")) for r in rows for t in r["targets"] if f(t) and t["y"] in (0, 1)]
        if len(T) < 30: print(f"{name}: n={len(T)} (too few)"); continue
        sym = np.array([x[0] for x in T]); p = np.array([x[1] for x in T], float); y = np.array([x[2] for x in T], float)
        print(f"{name:36} n={len(T):5} base={y.mean():.2f}  {cell(loco_score(sym, p, y))}")
        if name.startswith("week"):
            J = [(s, j, yy) for s, _, yy, j in T if j is not None]
            if len(J) >= 30:
                s2 = np.array([x[0] for x in J]); j2 = np.array([x[1] for x in J], float); y2 = np.array([x[2] for x in J], float)
                print(f"{'  week ±25% (Jev shadow)':36} n={len(J):5} base={y2.mean():.2f}  {cell(loco_score(s2, j2, y2))}")
