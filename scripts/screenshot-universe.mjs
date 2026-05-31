#!/usr/bin/env node
// screenshot-universe.mjs — capture the Quartz global graph as a still image.
//
// Usage:
//   # 1) Start the Quartz dev server (or use the live site)
//   cd quartz && npm run quartz -- build --serve --port 8080
//
//   # 2) In another terminal:
//   node scripts/screenshot-universe.mjs                    # defaults
//   node scripts/screenshot-universe.mjs --url https://swarm-ai-safety.github.io/aeon-atlas/universe/
//   node scripts/screenshot-universe.mjs --theme dark --out docs/assets/universe-dark.png
//   node scripts/screenshot-universe.mjs --note forks/aaronjmars-aeon --settle 6000
//   node scripts/screenshot-universe.mjs --all              # capture light + dark, local + global
//
// Requires playwright (one-time):
//   npm i -D playwright && npx playwright install chromium

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgv(argv) {
  const opts = {
    // Local dev server (npm run quartz -- build --serve) serves the site at
    // root; the `/universe/` mount only exists on the deployed Pages site.
    // Pass --url https://swarm-ai-safety.github.io/aeon-atlas/universe/ to
    // capture from prod instead.
    url: "http://localhost:8080/",
    // Default to a graph-rich content note. List/index pages have no Graph
    // component — only single-page content notes do.
    note: "forks/aaronjmars-aeon",
    theme: "light",          // light | dark
    out: "docs/assets/universe-graph.png",
    settle: 4500,            // ms to let the physics relax before capture
    width: 1920,
    height: 1080,
    mode: "global",          // global | local
    all: false,              // shortcut: render light+dark × local+global
    headed: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") opts.url = argv[++i];
    else if (a === "--note") opts.note = argv[++i].replace(/^\//, "");
    else if (a === "--theme") opts.theme = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--settle") opts.settle = Number(argv[++i]);
    else if (a === "--width") opts.width = Number(argv[++i]);
    else if (a === "--height") opts.height = Number(argv[++i]);
    else if (a === "--mode") opts.mode = argv[++i];
    else if (a === "--all") opts.all = true;
    else if (a === "--headed") opts.headed = true;
    else if (a === "-h" || a === "--help") opts.help = true;
  }
  return opts;
}

async function capture(opts) {
  const browser = await chromium.launch({ headless: !opts.headed });
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.height },
    deviceScaleFactor: 2, // retina-quality output
  });
  const page = await context.newPage();

  // Quartz reads `saved-theme` from localStorage on load AND applies it as
  // an attribute on <html>. Seed both so the inline theme-init script and
  // CSS [saved-theme="…"] selectors match before paint.
  await context.addInitScript((theme) => {
    try { localStorage.setItem("saved-theme", theme); } catch {}
  }, opts.theme);
  if (opts.theme === "dark") await page.emulateMedia({ colorScheme: "dark" });

  const target = opts.note
    ? new URL(opts.note, opts.url.endsWith("/") ? opts.url : opts.url + "/").toString()
    : opts.url;

  console.log(`→ navigating to ${target} (theme=${opts.theme}, mode=${opts.mode})`);
  await page.goto(target, { waitUntil: "networkidle" });

  // Belt-and-suspenders: force the attribute after load too. Quartz's graph
  // PIXI render reads CSS vars at init, so we then trigger a re-render by
  // re-scrolling the graph into view.
  await page.evaluate((theme) => {
    document.documentElement.setAttribute("saved-theme", theme);
  }, opts.theme);

  // Quartz lazy-inits the graph on intersection. Make sure it's in view.
  await page.locator(".graph").first().scrollIntoViewIfNeeded();
  await page.waitForSelector(".graph-container canvas", { timeout: 15000 });

  if (opts.mode === "global") {
    await page.locator(".global-graph-icon").first().click();
    await page.waitForSelector(".global-graph-outer.active", { timeout: 5000 });
    // Allow physics to relax before snapping.
    await page.waitForTimeout(opts.settle);
    const outPath = resolve(ROOT, opts.out);
    mkdirSync(dirname(outPath), { recursive: true });
    await page
      .locator(".global-graph-outer.active .global-graph-container")
      .screenshot({ path: outPath, omitBackground: false });
    console.log(`✓ wrote ${outPath}`);
  } else {
    // Local sidebar graph
    await page.waitForTimeout(opts.settle);
    const outPath = resolve(ROOT, opts.out);
    mkdirSync(dirname(outPath), { recursive: true });
    await page.locator(".graph > .graph-outer").first().screenshot({ path: outPath, omitBackground: false });
    console.log(`✓ wrote ${outPath}`);
  }

  await browser.close();
}

async function main() {
  const opts = parseArgv(process.argv);
  if (opts.help) {
    console.log("see file header for usage");
    return;
  }
  if (!opts.all) {
    await capture(opts);
    return;
  }
  // --all: produce 4 stills — light/dark × local/global.
  const matrix = [
    { theme: "light", mode: "global", out: "docs/assets/universe-graph-light.png", note: "" },
    { theme: "dark", mode: "global", out: "docs/assets/universe-graph-dark.png", note: "" },
    { theme: "light", mode: "local", out: "docs/assets/universe-local-light.png", note: "forks/aaronjmars-aeon" },
    { theme: "dark", mode: "local", out: "docs/assets/universe-local-dark.png", note: "forks/aaronjmars-aeon" },
  ];
  for (const m of matrix) {
    await capture({ ...opts, ...m });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
