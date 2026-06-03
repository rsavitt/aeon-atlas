#!/usr/bin/env node
// screenshot-universe.mjs — capture the Quartz global graph as a still image.
//
// Usage:
//   # 1) Start the Quartz dev server (or use the live site)
//   cd quartz && npm run quartz -- build --serve --port 8080
//
//   # 2) In another terminal:
//   node scripts/screenshot-universe.mjs                    # defaults
//   node scripts/screenshot-universe.mjs --url https://swarm-ai-research.github.io/aeon-atlas/universe/
//   node scripts/screenshot-universe.mjs --theme dark --out docs/assets/universe-dark.png
//   node scripts/screenshot-universe.mjs --note forks/aaronjmars-aeon --settle 6000
//   node scripts/screenshot-universe.mjs --all              # capture light + dark, local + global
//
//   # Record the physics-settling animation as MP4 (requires ffmpeg):
//   node scripts/screenshot-universe.mjs --video --theme dark --duration 8000
//   node scripts/screenshot-universe.mjs --video --out docs/assets/intro.mp4 --duration 12000
//
// Requires playwright (one-time):
//   npm i -D playwright && npx playwright install chromium

import { chromium } from "playwright";
import { mkdirSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgv(argv) {
  const opts = {
    // Local dev server (npm run quartz -- build --serve) serves the site at
    // root; the `/universe/` mount only exists on the deployed Pages site.
    // Pass --url https://swarm-ai-research.github.io/aeon-atlas/universe/ to
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
    video: false,            // record video instead of stillshot
    duration: 8000,          // ms of recording after the graph opens (video mode)
    fps: 30,                 // ffmpeg output fps when converting webm→mp4
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
    else if (a === "--video") opts.video = true;
    else if (a === "--duration") opts.duration = Number(argv[++i]);
    else if (a === "--fps") opts.fps = Number(argv[++i]);
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

// Record the physics-settling animation of the global graph. webm comes
// out of playwright; we convert to mp4 with ffmpeg if available so the
// asset works as a Markdown <video> or twitter upload.
async function record(opts) {
  const tmpDir = resolve(tmpdir(), `aeon-video-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  const browser = await chromium.launch({ headless: !opts.headed });
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.height },
    // recordVideo doesn't honor deviceScaleFactor — capture at 1x.
    recordVideo: { dir: tmpDir, size: { width: opts.width, height: opts.height } },
  });
  const page = await context.newPage();
  await context.addInitScript((theme) => {
    try { localStorage.setItem("saved-theme", theme); } catch {}
  }, opts.theme);
  if (opts.theme === "dark") await page.emulateMedia({ colorScheme: "dark" });

  const target = opts.note
    ? new URL(opts.note, opts.url.endsWith("/") ? opts.url : opts.url + "/").toString()
    : opts.url;

  console.log(`→ recording ${target} (theme=${opts.theme}, duration=${opts.duration}ms)`);
  await page.goto(target, { waitUntil: "networkidle" });
  await page.evaluate((theme) => {
    document.documentElement.setAttribute("saved-theme", theme);
  }, opts.theme);

  await page.locator(".graph").first().scrollIntoViewIfNeeded();
  await page.waitForSelector(".graph-container canvas", { timeout: 15000 });

  if (opts.mode === "global") {
    await page.locator(".global-graph-icon").first().click();
    await page.waitForSelector(".global-graph-outer.active", { timeout: 5000 });
  }
  // Let the simulation run for the requested duration — this is what's captured.
  await page.waitForTimeout(opts.duration);

  const videoHandle = page.video();
  await context.close();
  await browser.close();
  const webmPath = await videoHandle.path();

  const outAbs = resolve(ROOT, opts.out);
  mkdirSync(dirname(outAbs), { recursive: true });

  const ffmpeg = spawnSync("which", ["ffmpeg"], { encoding: "utf8" });
  if (outAbs.endsWith(".webm") || ffmpeg.status !== 0) {
    // No ffmpeg or user explicitly asked for webm — just move it.
    const dst = outAbs.endsWith(".webm") ? outAbs : outAbs.replace(/\.mp4$/, ".webm");
    renameSync(webmPath, dst);
    console.log(`✓ wrote ${dst}`);
    if (ffmpeg.status !== 0) console.log("  (install ffmpeg to get mp4 output)");
    return;
  }
  // Convert webm→mp4 (h264 + aac-stripped). yuv420p for broad compatibility.
  console.log(`→ converting to mp4`);
  const r = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-i", webmPath,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-r", String(opts.fps),
      "-movflags", "+faststart",
      "-an",
      outAbs,
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    console.error(r.stderr);
    throw new Error("ffmpeg conversion failed");
  }
  try { unlinkSync(webmPath); } catch {}
  console.log(`✓ wrote ${outAbs}`);
}

async function main() {
  const opts = parseArgv(process.argv);
  if (opts.help) {
    console.log("see file header for usage");
    return;
  }
  if (opts.video) {
    if (opts.out === "docs/assets/universe-graph.png") {
      opts.out = `docs/assets/universe-graph-${opts.theme}.mp4`;
    }
    await record(opts);
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
