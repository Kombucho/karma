/**
 * Design drift check: does the running site still match Front-end/*.dc.html?
 *
 * The design files are the source of truth for the skin, but they're Claude Design exports —
 * markup we port by hand, not a library we import. That makes drift silent: a colour gets
 * tweaked in the design, nobody notices for a week. This makes it loud.
 *
 * It extracts the checkable facts from the .dc.html (palette, fonts, radius policy, section
 * anchors, key copy) and asserts them against the implementation. It cannot check layout —
 * that still needs eyes — but it catches every drift that is expressible as a token.
 *
 *   npm run design-check
 *
 * Exit code is non-zero on drift, so it can gate a deploy.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const DESIGN_DIR = path.join(ROOT, "Front-end");
const CSS = path.join(ROOT, "src", "app", "globals.css");

interface Finding { level: "ok" | "drift" | "note"; what: string; detail: string }

async function main() {
  const findings: Finding[] = [];
  const ok = (what: string, detail = "") => findings.push({ level: "ok", what, detail });
  const drift = (what: string, detail: string) => findings.push({ level: "drift", what, detail });
  const note = (what: string, detail: string) => findings.push({ level: "note", what, detail });

  let files: string[];
  try {
    // Only the current design generation. Older exports are kept for history, not as truth —
    // checking against them reports drift the design itself already decided against.
    const CURRENT = ["Karma v3.dc.html", "Karma Card.dc.html", "KarmaCardUnit.dc.html"];
    const all = (await readdir(DESIGN_DIR)).filter((f) => f.endsWith(".dc.html"));
    files = all.filter((f) => CURRENT.includes(f));
    const stale = all.filter((f) => !CURRENT.includes(f));
    if (stale.length) console.log(`  (ignoring superseded: ${stale.join(", ")})`);
  } catch {
    console.log("\n  No Front-end/ directory — nothing to check against.\n");
    return;
  }
  const design = (await Promise.all(files.map((f) => readFile(path.join(DESIGN_DIR, f), "utf8")))).join("\n");
  const css = await readFile(CSS, "utf8");

  console.log(`\n  Design sources: ${files.join(", ")}`);
  console.log(`  Checked against: src/app/globals.css + components\n`);

  // ── 1. palette: every colour used 3+ times in the design must exist in the CSS ──
  const counts = new Map<string, number>();
  for (const m of design.matchAll(/#[0-9a-fA-F]{6}\b/g)) {
    const c = m[0].toLowerCase();
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const significant = [...counts.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
  const cssLower = css.toLowerCase();
  const missing = significant.filter(([c]) => !cssLower.includes(c));
  if (missing.length) drift("palette", `${missing.length} design colours absent from globals.css: ${missing.map(([c, n]) => `${c}(${n}×)`).join(" ")}`);
  else ok("palette", `all ${significant.length} significant design colours present`);

  // ── 2. radius policy: the design has none, so the implementation must not add any ──
  const designRadius = [...design.matchAll(/border-radius:\s*([^;"']+)/g)].map((m) => m[1].trim()).filter((v) => v !== "0" && v !== "0px");
  if (designRadius.length === 0) {
    const guard = css.includes("border-radius: 0 !important");
    if (guard) ok("radius", "design uses none; .kcard enforces none");
    else drift("radius", "design has zero border-radius but no guard exists in globals.css");
  } else {
    note("radius", `design now uses radius (${[...new Set(designRadius)].join(", ")}) — the no-radius guard may be stale`);
  }

  // ── 3. typography ──
  const fonts = new Set([...design.matchAll(/font-family:\s*'?([A-Za-z0-9 ]+)/g)].map((m) => m[1].trim()).filter((f) => f && f !== "inherit"));
  for (const f of fonts) {
    const key = f.split(" ")[0].toLowerCase();
    if (!cssLower.includes(key) && !["ui-monospace", "monospace", "serif"].includes(key)) drift("font", `design uses "${f}" — not referenced in globals.css`);
  }
  if (!findings.some((f) => f.what === "font")) ok("fonts", [...fonts].join(", "));

  // ── 4. section anchors the design links to must exist as ids in the app ──
  const anchors = new Set([...design.matchAll(/href="#([a-z-]+)"/g)].map((m) => m[1]));
  const appSrc = await readAll(path.join(ROOT, "src", "app"));
  for (const a of anchors) {
    if (!appSrc.includes(`id="${a}"`)) drift("anchor", `design links to #${a} but no element carries that id`);
  }
  if (!findings.some((f) => f.what === "anchor")) ok("anchors", [...anchors].map((a) => `#${a}`).join(" ") || "none");

  // ── 5. signature copy the design commits to ──
  const SIGNATURE = [
    "KARMA HAS NO MENU",
    "NO MENU · NO SPECIALS · NO REFUNDS",
    "THE GUY WHO GOT RUGGED",
    "HE CHECKED THE WALLET TOO LATE",
    "THE ORACLE",
    "FORTUNE COOKIE",
    "ADD YOUR PROFILE WITH $KARMA",
  ];
  const absent = SIGNATURE.filter((line) => design.includes(line) && !appSrc.includes(line));
  if (absent.length) drift("copy", `design copy not present in the app: ${absent.map((l) => `"${l}"`).join(", ")}`);
  else ok("signature copy", `${SIGNATURE.length} design lines present`);

  // ── report ──
  const pad = (s: string) => s.padEnd(16);
  for (const f of findings) {
    const mark = f.level === "ok" ? "✓" : f.level === "drift" ? "✗" : "·";
    console.log(`  ${mark} ${pad(f.what)} ${f.detail}`);
  }
  const drifts = findings.filter((f) => f.level === "drift").length;
  console.log(
    drifts
      ? `\n  ${drifts} drift${drifts === 1 ? "" : "s"} — the site and the design folder disagree.\n`
      : `\n  No token-level drift. Layout still needs eyes.\n`,
  );
  if (drifts) process.exitCode = 1;
}

async function readAll(dir: string): Promise<string> {
  let out = "";
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out += await readAll(p);
    else if (/\.(tsx?|css)$/.test(e.name)) out += await readFile(p, "utf8");
  }
  return out;
}

main().catch((e) => { console.error(e); process.exit(1); });
