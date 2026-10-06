/**
 * Turn each scored KOL's pump.fun avatar into an on-brand pixel-phosphor portrait.
 * Deterministic filter (no AI): grayscale → 4-tone green palette with Bayer dithering →
 * pixelated. Cached to public/avatars/<wallet>.png so cards + OG images bind to a real asset.
 *
 *   npm run avatars            # all scored callout wallets missing an avatar
 *   npm run avatars -- --force # re-process everyone
 *   npm run avatars -- @handle # single wallet
 *
 * Zero runtime cost: run once at score-time, serve the cached PNG forever.
 */

import { mkdir, readFile, readdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { RateLimiter } from "../src/lib/karma/http";

for (const f of [".env.local", ".env"]) { try { process.loadEnvFile(f); } catch {} }

const ROOT = process.cwd();
const VALIDATION_DIR = path.join(ROOT, "validation");
const OUT_DIR = path.join(ROOT, "public", "avatars");
const KOLS_PATH = path.join(ROOT, "seed", "kols.json");
const GRID = 64; // portrait resolution before nearest-neighbor upscale

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
  "Origin": "https://pump.fun",
  "Referer": "https://pump.fun/",
};

// Card palette, dark → bright. Luminance maps into these four green tones.
const PALETTE: Array<[number, number, number]> = [
  [13, 18, 13],    // near-black bg
  [26, 58, 42],    // dark green
  [74, 157, 95],   // mid green
  [124, 252, 139], // bright #7CFC8B
];

// 4×4 Bayer matrix (0..15) for ordered dithering — gives the chunky phosphor texture.
const BAYER = [
  [0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5],
].map((r) => r.map((v) => v / 16 - 0.5));

// Deliberately gentle: one pump.fun call every ~2s, long backoff on any block (403/429/530),
// so we never trip Cloudflare again. Avatars are a nice-to-have — slow is fine.
const pace = new RateLimiter(2000);

async function pacedFetch(url: string): Promise<Response | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    await pace.take();
    const res = await fetch(url, { headers: BROWSER_HEADERS });
    if (res.ok) return res;
    if (res.status === 403 || res.status === 429 || res.status >= 500) {
      pace.penalize(Math.min(60_000, 5000 * 2 ** attempt)); // 5s,10s,20s… whole-limiter cooldown
      continue;
    }
    return res;
  }
  return null;
}

async function fetchProfileImage(wallet: string): Promise<string | null> {
  const res = await pacedFetch(`https://frontend-api-v3.pump.fun/users/${wallet}`);
  if (!res || !res.ok) return null;
  try { return (await res.json() as { profile_image?: string }).profile_image ?? null; }
  catch { return null; }
}

async function phosphorize(imgBytes: Buffer, wallet: string): Promise<void> {
  // Downscale, normalize to full range, boost contrast, grayscale, raw bytes.
  const { data, info } = await sharp(imgBytes)
    .resize(GRID, GRID, { fit: "cover" })
    .normalize()
    .linear(1.3, -20)          // punch up contrast so the subject separates from its bg
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width, h = info.height, ch = info.channels;
  const out = Buffer.alloc(w * h * 3);
  const GAMMA = 1.8;

  // Adaptive: if the avatar is predominantly light (white/pale background), invert so the
  // dominant region falls to near-black and the subject glows green — always dark-card-friendly.
  let sum = 0;
  for (let i = 0; i < w * h; i++) sum += data[i * ch];
  const invert = sum / (w * h) / 255 > 0.5;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let lum = data[(y * w + x) * ch] / 255;
      if (invert) lum = 1 - lum;
      lum = Math.pow(lum, GAMMA);     // dark-biased: only the brightest signal glows
      const dithered = lum + BAYER[y % 4][x % 4] * 0.45;
      const idx = Math.max(0, Math.min(3, Math.round(dithered * 3))); // → palette band
      const [r, g, b] = PALETTE[idx];
      const o = (y * w + x) * 3;
      out[o] = r; out[o + 1] = g; out[o + 2] = b;
    }
  }

  // Upscale nearest-neighbor to crisp 512px, save.
  await sharp(out, { raw: { width: w, height: h, channels: 3 } })
    .resize(512, 512, { kernel: "nearest" })
    .png()
    .toFile(path.join(OUT_DIR, `${wallet}.png`));
}

async function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const handleArg = argv.find((a) => !a.startsWith("--"));
  await mkdir(OUT_DIR, { recursive: true });

  // Resolve targets: single handle, or every callout-scored wallet.
  let wallets: string[];
  if (handleArg) {
    const kols = JSON.parse(await readFile(KOLS_PATH, "utf8")) as Array<{ handle: string | null; wallet_address: string }>;
    const kol = kols.find((k) => k.handle?.toLowerCase() === handleArg.replace(/^@/, "").toLowerCase());
    if (!kol) { console.error(`"${handleArg}" not found`); process.exit(1); }
    wallets = [kol.wallet_address];
  } else {
    const files = (await readdir(VALIDATION_DIR)).filter((f) => f.endsWith(".json"));
    wallets = [];
    for (const f of files) {
      const d = JSON.parse(await readFile(path.join(VALIDATION_DIR, f), "utf8"));
      if (String(d.config_version ?? "").includes("callout")) wallets.push(d.wallet);
    }
  }

  let made = 0, skipped = 0, noImg = 0;
  for (const wallet of wallets) {
    const outFile = path.join(OUT_DIR, `${wallet}.png`);
    if (!force) {
      try { await access(outFile); skipped++; continue; } catch {}
    }
    const url = await fetchProfileImage(wallet);
    if (!url) { noImg++; continue; }
    try {
      const res = await pacedFetch(url);
      if (!res || !res.ok) { noImg++; continue; }
      await phosphorize(Buffer.from(await res.arrayBuffer()), wallet);
      made++;
      process.stdout.write(`\r  made ${made} · skipped ${skipped} · no-image ${noImg}`);
    } catch { noImg++; }
  }
  console.log(`\nDone: ${made} portraits · ${skipped} cached · ${noImg} no image → public/avatars/`);
}

main().catch((e) => { console.error(e); process.exit(1); });
