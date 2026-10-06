/** Warm the level lab cache: Binance 1h klines for every LEVEL_COINS symbol since 2020. */
import { binanceHourly, LEVEL_COINS } from "./data";

async function main() {
  for (const s of LEVEL_COINS) {
    const c = await binanceHourly(s);
    console.log(`${s}: ${c.length}h from ${new Date(c[0].t * 1000).toISOString().slice(0, 10)}`);
  }
}
main();
