# Karma

On-chain karma for crypto callers. One question, answered from the blockchain: if you had copied this person's calls, what happened to you, and did they sell into you?

Live: [karmawtf.vercel.app](https://karmawtf.vercel.app)

## What's here

- **The engine**: reads a caller's pump.fun callouts and on-chain trades, prices every call at 1h / 6h / 24h / 7d, and checks whether the caller exited before their followers could. Output is a trust grade with a confidence interval, not a vibe.
- **Coin x-ray**: holder book scan that flags manufactured holder bases (deployer wallet farms, funder-clustered bundles).
- **The dataset**: 733 callers, 10,756 callouts, 5,668 scored against what the price actually did. See [DATA.md](DATA.md).

## The finding

Split each caller's history in half and ask whether the first half predicts the second:

| trait | split-half r |
|---|---|
| picks that hit 2× | 0.09 |
| dumping on followers | 0.44 |
| calls that rug | 0.52 |

Picking skill barely persists. Integrity does. So Karma scores callers on what you can actually forecast: whether they will dump on you. Numbers in `seed/calibration.json`, method in `scripts/calibrate.ts`.

## Run it

```bash
npm install
cp .env.example .env.local   # optional: add a free Helius key
npm run dev                  # http://localhost:3000
npm run score -- <wallet>    # score a wallet from the terminal
```

The app boots with no keys, reading the committed dataset.

## License

Code: MIT ([LICENSE](LICENSE)). Data: CC BY 4.0 ([LICENSE-DATA](LICENSE-DATA)). Build on it, credit the source.
