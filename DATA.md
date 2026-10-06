# Karma dataset

Ground truth for one question: if you had copied a crypto caller's buys, what would have happened, and did they sell into you?

Snapshot: scans run 2026-09-16 to 2026-10-03, scoring model `trust-v3` (priors `trust-v3-fairwindow-2026-09`). Data is CC BY 4.0 (see `LICENSE-DATA`), code is MIT.

## At a glance

| | |
|---|---|
| Callers (Solana wallets) | 733, 361 linked to a public X handle |
| Callouts | 10,756 (8,433 Solana mints, 2,323 EVM) |
| Scored against price outcomes | 5,668 (53%) |
| Not scorable | 2,730 no price data, 2,358 incomplete |
| Callers with enough history to grade | 389 (344 marked unproven) |

Almost half the callouts have no usable outcome. That is the honest state of memecoin price data: pools die, indexers drop them. Filter on `status == "scored"` before computing anything.

## The finding

Split each caller's history in half chronologically, measure a trait in the first half, see if it predicts the second (`seed/calibration.json`, field `reliability`):

| trait | split-half r | Spearman-Brown |
|---|---|---|
| calls that hit 2× (picking) | 0.09 | 0.16 |
| dumps on followers | 0.44 | 0.61 |
| calls that rug | 0.52 | 0.69 |

Picking winners barely persists. Integrity does. A copy-trade strategy that ranks callers by past hit rate is ranking mostly noise.

Separately, the quant lab (`scripts/quant-lab/`) found textbook chart patterns hit their measured-move targets less often than a same-volatility random walk (double top 12% vs 28%, double bottom 18% vs 25%, 24 coins, held-out coins and months). The raw price cache is not committed, `scripts/quant-lab/fetch-all.ts` refetches it.

## Files

`validation/<wallet>.json`, one per caller, the core table.
- `identity`: pump.fun username, `x_username`, followers, bio
- `score`: wins, losses, dumps, rugs, `follower_hit_rate`, `median_copy_return`, `karma_score`, `grade`, `title`
- `trust`: the trust-v3 grade with a confidence interval (`karma_low`, `karma_high`) and rates vs market base rates
- `tokens[]`: one row per callout. Key fields: `entry_time`, `entry_price`, `price_1h/6h/24h/7d`, `peak_price_after_entry`, `copy_return_24h`, `copy_peak_multiple`, `caller_exited`, `fraction_sold`, `exit_vwap`, `dumped`, `rugged`, `held_through_rug`, `label` (WIN, LOSS, DUMP, RUG, NEUTRAL), `status` (scored, incomplete, no_price_data)

`seed/`
- `kols.json`: the 733 callers with wallet, X handle and where the link came from (`source_url`, `source_note`)
- `leaderboard.json`: ranked output, `highest` / `shame` / `unproven`
- `calibration.json`: base rates, split-half reliability, predictive validity, precision at top K
- `sybil_clusters.json`: manufactured holder bases (deployer farms, top-holder bundles) per coin
- `cex_funders.json`: exchange hot wallets excluded from Sybil detection
- `pnl_leaderboard_harvest.json`, `pump_top_callers.json`, `active_callers.json`: how callers were found
- `pumpfun_callouts/`: raw callout text (thesis) for two callers, as a sample of the source
- `pumpfun_sweep.json`, `top_coin_scan.json`: coin-side scans

`data/`
- `backtests/postmortem-2026-09-25.json`: rubric postmortem over held-out coins
- `lab/scorecard.json`: calibration (ECE), Brier skill and AUC for each predictor on held-out data
- `lab/audit*/grades-*.json`: blind three-grader audit of detected chart patterns

`db/schema.sql`: the Postgres schema the app persists to.

## Reproduce

```bash
npm install
npm run score -- <wallet>        # score one wallet (or @handle)
npm run calibrate -- --write    # recompute seed/calibration.json
```

Copy `.env.example` to `.env.local`. A free Helius key (`HELIUS_API_KEY`) makes wallet scans about 10× faster, without it the engine falls back to the public Solana RPC.

## Caveats

- Wallet to X handle links come from public sources (kolscan.io, pump.fun profiles that link their own X account, pump.fun leaderboards). A link can be wrong. Treat `identity` as a claim with a source, not a fact.
- Grades and titles ("Exit Liquidity", "Larper") are model output on on-chain behaviour, not a judgement of anyone's intent.
- Survivorship: callers were found through leaderboards and directories, so this is not a random sample of everyone who posts calls.
- It is a snapshot. Callers change, and the live app at karmawtf.vercel.app rescans.

If you are listed and believe a wallet link is wrong, open an issue and it will be reviewed.
