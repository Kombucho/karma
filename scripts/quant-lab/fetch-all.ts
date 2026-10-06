/** Warm the lab cache: 1h candles for every coin + the tide (BTC, SOL). */
import { kucoinHourly, LAB_COINS, TIDE } from "./data";

async function main() {
  for (const s of [...TIDE, ...LAB_COINS]) {
    const c = await kucoinHourly(s);
    console.log(`candles ${s}: ${c.length}h from ${new Date(c[0].t * 1000).toISOString().slice(0, 10)}`);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
