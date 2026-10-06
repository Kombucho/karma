"""Jev as the higher-timeframe judge vs the random walk and the code tests, leave-one-coin-out.
Usage: uv run --with scikit-learn --with numpy python scripts/quant-lab/eval-funnel-jev.py"""
import json, numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
R = [json.loads(l) for l in open("data/lab/funnel-jev.jsonl")]
R = [r for r in R if r["p_jev"] is not None]
lg = lambda x: np.log(np.clip(x, 1e-4, 1 - 1e-4) / (1 - np.clip(x, 1e-4, 1 - 1e-4)))
def ece(p, y):
    e = 0
    for b in range(10):
        m = (p >= b / 10) & ((p < (b + 1) / 10) if b < 9 else (p <= 1))
        if m.any(): e += m.mean() * abs(p[m].mean() - y[m].mean())
    return e
for tf in ["1h", "4h", "all"]:
    rs = [r for r in R if tf == "all" or r["tf"] == tf]
    sym = np.array([r["sym"] for r in rs]); y = np.array([r["y"] for r in rs], float)
    rw = np.array([r["p_rw"] for r in rs]); jv = np.array([r["p_jev"] for r in rs])
    T = np.array([[r["tests"]["d1"], r["tests"]["w1"], r["tests"]["clear"], r["tests"]["protected"]] for r in rs], float)
    def fit(X):
        out = np.zeros(len(y))
        for s in set(sym):
            m = sym == s
            out[m] = LogisticRegression(max_iter=500).fit(X[~m], y[~m]).predict_proba(X[m])[:, 1]
        return out
    code = fit(np.c_[lg(rw), T]); both = fit(np.c_[lg(rw), T, lg(jv)])
    base = np.array([y[sym != s].mean() for s in sym])
    def sc(p):
        return f"ece {ece(p, y)*100:4.1f} pts  skill {1 - np.mean((p-y)**2)/np.mean((base-y)**2):+.3f}  auc {roc_auc_score(y, p):.3f}"
    print(f"\n{tf}: n={len(y)} hit {y.mean():.1%}")
    print(f"  random walk            {sc(rw)}")
    print(f"  Jev (raw)              {sc(jv)}")
    print(f"  rw + code tests        {sc(code)}")
    print(f"  rw + code tests + Jev  {sc(both)}")
