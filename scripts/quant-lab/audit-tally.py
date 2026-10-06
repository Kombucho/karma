"""Majority-vote tally of a grading round, split by confirmed (neckline broken) vs still forming.
Usage: python scripts/quant-lab/audit-tally.py data/lab/audit8   (reads grades-*.json + pattern-sample.json)"""
import json, sys, glob, collections
d = sys.argv[1]
S = json.load(open("data/lab/pattern-sample.json"))
kinds = sorted(set(s["kind"] for s in S))
panel = {}
for k in kinds:
    xs = [s for s in S if s["kind"] == k]
    pages = [xs[i:i + 12] for i in range(0, len(xs), 12)]
    for pi, page in enumerate(pages):
        name = k if len(pages) == 1 else f"{k}_{pi + 1}"
        for j, s in enumerate(page): panel[(name, j + 1)] = s
votes = collections.defaultdict(list)
files = sorted(glob.glob(f"{d}/grades-*.json"))
for f in files:
    for g in json.load(open(f)):
        votes[(g["image"].split("/")[-1].replace(".png", ""), int(g["panel"]))].append(g["verdict"] == "VALID")
agg = collections.defaultdict(lambda: [0, 0])
for key, v in votes.items():
    s = panel.get(key)
    if not s: continue
    ok = sum(v) * 2 > len(v)
    for bucket in ["all", "confirmed" if s["p"]["confirmed"] else "forming", s["kind"]]:
        agg[bucket][0] += ok; agg[bucket][1] += 1
print(f"graders: {len(files)}")
for b in ["all", "confirmed", "forming"] + kinds:
    if b in agg: print(f"{b:20} {agg[b][0]}/{agg[b][1]}  {agg[b][0] / agg[b][1]:.0%}")
