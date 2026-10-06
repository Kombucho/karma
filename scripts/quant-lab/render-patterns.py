"""Pattern audit, step 2: one PNG per pattern kind, a grid of sampled detections.
Black = 4h closes (shaded high-low), orange = the swing points the detector used, green/red dashed =
target/stop, grey dotted = trigger, vertical line = detection time (everything right of it is the future).
Usage: uv run --with matplotlib python scripts/quant-lab/render-patterns.py"""
import json, os, datetime as dt
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

S = json.load(open(os.environ.get("SAMPLE", "data/lab/pattern-sample.json")))
OUT = os.environ.get("AUDIT_DIR", "data/lab/audit")
os.makedirs(OUT, exist_ok=True)
kinds = sorted(set(s["kind"] for s in S))
PAGE = 12
jobs = []
for k in kinds:
    allx = [s for s in S if s["kind"] == k]
    pages = [allx[i:i + PAGE] for i in range(0, len(allx), PAGE)]
    for pi, xs in enumerate(pages):
        jobs.append((k if len(pages) == 1 else f"{k}_{pi + 1}", k, xs))
for name, k, xs in jobs:
    cols = 3
    rows = (len(xs) + cols - 1) // cols
    fig, axes = plt.subplots(rows, cols, figsize=(cols * 5.2, rows * 3.2), squeeze=False)
    for ax, s in zip(axes.flat, xs):
        bars = s["bars"]
        t = [dt.datetime.utcfromtimestamp(b["t"]) for b in bars]
        ax.fill_between(t, [b["l"] for b in bars], [b["h"] for b in bars], color="#ccc", lw=0)
        ax.plot(t, [b["c"] for b in bars], color="black", lw=0.8)
        p = s["p"]
        ax.plot([dt.datetime.utcfromtimestamp(q["t"]) for q in p["points"]], [q["price"] for q in p["points"]], "o-", color="orange", ms=4, lw=1.2)
        ax.axhline(p["target"], color="green", ls="--", lw=0.8)
        ax.axhline(p["stop"], color="red", ls="--", lw=0.8)
        ax.axhline(p["trigger"], color="grey", ls=":", lw=0.8)
        ax.axvline(dt.datetime.utcfromtimestamp(s["at"]), color="blue", lw=0.8)
        ax.set_yscale("log")
        ax.set_title(f'{s["sym"]} {dt.datetime.utcfromtimestamp(s["at"]).date()} → {s["outcome"]}', fontsize=9)
        ax.tick_params(labelsize=6)
    for ax in axes.flat[len(xs):]:
        ax.axis("off")
    fig.suptitle(name, fontsize=13)
    fig.tight_layout()
    fig.savefig(f"{OUT}/{name}.png", dpi=80)
    plt.close(fig)
    print("wrote", name)
