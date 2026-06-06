#!/usr/bin/env node
/**
 * atlas — map the public ecosystem of aeon forks and the skills they enable.
 *
 * For every public fork of aaronjmars/aeon (transitively), this:
 *
 *   1. Lists forks via the GitHub Forks API (paginates).
 *   2. Optionally pulls the network of forks-of-forks (depth-limited).
 *   3. Fetches each fork's `aeon.yml` to learn which skills are enabled.
 *   4. Builds a weighted graph:
 *        node = repo (owner, name, ★, lastPush, defaultBranch, parentFullName)
 *        edge = fork-of (hard, always)
 *             = skill-overlap (soft, weight = jaccard of enabled skills)
 *   5. Emits:
 *        atlas.json                — machine-readable
 *        docs/atlas.md             — readable digest (top forks, top skills,
 *                                    most-overlapping pairs)
 *        docs/atlas.html           — Cytoscape view, fork tree, click for
 *                                    enabled-skill list and ★/push metadata
 *
 * Reads GITHUB_TOKEN from gh CLI (calls `gh api` for rate-limit headroom)
 * with a `curl` fallback for unauthenticated runs. Public-only data.
 *
 * Usage:
 *   node scripts/atlas.mjs                     # fetch + write all artifacts
 *   node scripts/atlas.mjs --upstream X/Y      # different upstream
 *   node scripts/atlas.mjs --depth 2           # forks of forks (default 1)
 *   node scripts/atlas.mjs --json              # print atlas.json to stdout
 *   node scripts/atlas.mjs --cache             # reuse cached fork list if <24h old
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
// Atlas is multi-root. Each upstream is enumerated independently (own fork
// tree, own ECOSYSTEM.md and skill-packs.json if present, own enabled-skill
// baseline for delta computation). The resulting graph is the union.
const DEFAULT_UPSTREAMS = [
  "aaronjmars/aeon",
  "aaronjmars/aeon-agent",
  "aaronjmars/miroshark-aeon",
];
// Outputs live under docs/ so GitHub Pages serves them at their natural URLs.
// docs/atlas.json is the public machine-readable artifact; we ALSO keep a
// copy at repo root for backward-compat with tools that already point there.
const OUT_JSON = resolve(ROOT, "atlas.json");
const OUT_JSON_DOCS = resolve(ROOT, "docs/atlas.json");
const OUT_MD = resolve(ROOT, "docs/atlas.md");
const OUT_HTML = resolve(ROOT, "docs/atlas.html");
const OUT_INNOVATIONS = resolve(ROOT, "docs/innovations.md");
const OUT_DISABLED_DEFAULTS = resolve(ROOT, "docs/disabled-defaults.md");
const OUT_ECOSYSTEM = resolve(ROOT, "docs/ecosystem.md");
const OUT_SKILL_PACKS = resolve(ROOT, "docs/skill-packs.md");
const OUT_OPERATORS = resolve(ROOT, "docs/operators.md");
const OUT_NON_FORK = resolve(ROOT, "docs/non-fork-users.md");
const OUT_WHATS_NEW = resolve(ROOT, "docs/whats-new.md");
const OUT_DIGEST_DIR = resolve(ROOT, "docs/digest");
const OUT_DIGEST_INDEX = resolve(ROOT, "docs/digest.md");
const OUT_FEED = resolve(ROOT, "docs/feed.xml");
// Used by the Atom feed's <link rel="alternate"> + <id> URIs.
const SITE_BASE = "https://swarm-ai-research.github.io/aeon-atlas";
const HISTORY_DIR = resolve(ROOT, "history");
const QUARTZ_CONTENT = resolve(ROOT, "quartz/content");
const CACHE_DIR = resolve(ROOT, ".atlas-cache");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ── safe inline-JSON escape (XSS prevention for embedded graph data) ──
// Fork descriptions are externally-derived — a malicious fork owner can
// set a description containing `</script>` and inject script into the
// published atlas page when their fork is enumerated. Standard escape
// pattern: 5 replacements covering script termination (<), attribute /
// comment vectors (>, &), and U+2028/U+2029 line separators (legal in
// JSON, illegal in JS string literals). Matches what Webpack, lodash,
// and most server-render libs do.
function safeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/[\u2028\u2029]/g, (c) => c === "\u2028" ? "\\u2028" : "\\u2029");
}

// ── argv ───────────────────────────────────────────────────────────────────
function parseArgv(argv) {
  // `--upstream owner/repo` may be repeated, or passed comma-separated. If
  // omitted entirely, the DEFAULT_UPSTREAMS list above is used.
  const opts = { upstreams: [], depth: 1, json: false, cache: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--upstream") {
      const v = argv[++i] || "";
      for (const s of v.split(",")) if (s.trim()) opts.upstreams.push(s.trim());
    }
    else if (a === "--depth") opts.depth = Number(argv[++i]);
    else if (a === "--json") opts.json = true;
    else if (a === "--cache") opts.cache = true;
    else if (a === "-h" || a === "--help") opts.help = true;
  }
  if (opts.upstreams.length === 0) opts.upstreams = [...DEFAULT_UPSTREAMS];
  return opts;
}

// ── GitHub API client ──────────────────────────────────────────────────────
function ghApi(path) {
  // gh api handles auth + rate-limit headers transparently. Fall back to
  // curl if gh is missing (degraded — unauth rate limit is 60/hr).
  const r = spawnSync("gh", ["api", path, "--cache", "10m"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status === 0) return JSON.parse(r.stdout);
  if (r.stderr.includes("not found") || r.stderr.includes("Not Found")) return null;
  // fall back to curl (rare)
  const fb = spawnSync("curl", ["-fsSL", `https://api.github.com${path}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (fb.status !== 0) throw new Error(`gh and curl both failed for ${path}: ${r.stderr}\n${fb.stderr}`);
  return JSON.parse(fb.stdout);
}

function ghRaw(repoFullName, ref, path) {
  // raw file fetch. Uses gh api repos/.../contents → base64 decode, with a
  // 10m cache so repeated runs are cheap. Returns null on 404.
  const apiPath = `/repos/${repoFullName}/contents/${path}?ref=${encodeURIComponent(ref)}`;
  const obj = (() => {
    try { return ghApi(apiPath); } catch { return null; }
  })();
  if (!obj || !obj.content) return null;
  return Buffer.from(obj.content, "base64").toString("utf8");
}

// Discover repos using Aeon that AREN'T forks of one of our roots. People
// clone, copy-as-template, or build their own aeon.yml without forking; those
// repos show up nowhere in the descendant fork tree. Code search for a
// distinctive marker that ships in every aeon.yml ("morning-brief") inside
// files literally named aeon.yml gives a near-zero-noise list. Returns repo
// fullNames; caller cross-references against the fork list.
function fetchNonForkRepoNames() {
  try {
    const all = new Set();
    // Search API caps at 1000 results across 10 pages of 100. Multiple
    // distinctive queries widen the net without losing precision.
    const queries = [
      "morning-brief+filename:aeon.yml",
      "paper-digest+filename:aeon.yml",
      "hacker-news-digest+filename:aeon.yml",
    ];
    for (const q of queries) {
      for (let page = 1; page <= 10; page++) {
        const res = ghApi(`/search/code?q=${q}&per_page=100&page=${page}`);
        if (!res || !Array.isArray(res.items) || res.items.length === 0) break;
        for (const it of res.items) {
          if (it.repository?.full_name) all.add(it.repository.full_name);
        }
        if (res.items.length < 100) break;
      }
    }
    return [...all];
  } catch (err) {
    console.warn(`  code search failed: ${err.message}`);
    return [];
  }
}

// Fetch raw commit dates for the last `daysBack` days. Paginates until the
// repo returns a partial page (< 100), so totals aren't artificially capped.
// Hard ceiling at 10 pages (= 1000 commits) as a safety valve against
// pathological repos. Returns ISO date strings, or [] on any failure.
function fetchCommitDates(repoFullName, daysBack = 30) {
  try {
    const since = new Date(Date.now() - daysBack * 86400000).toISOString();
    const all = [];
    for (let page = 1; page <= 10; page++) {
      const commits = ghApi(`/repos/${repoFullName}/commits?since=${since}&per_page=100&page=${page}`);
      if (!Array.isArray(commits) || commits.length === 0) break;
      for (const c of commits) {
        const d = c.commit?.author?.date;
        if (d) all.push(d);
      }
      if (commits.length < 100) break;
    }
    return all;
  } catch (err) {
    // 409 = empty repo. 404 = deleted. Suppress — common and not interesting.
    if (!/409|404/.test(err.message)) {
      console.warn(`  commits fetch failed for ${repoFullName}: ${err.message}`);
    }
    return [];
  }
}

// Bucket commit timestamps into per-day counts for the last `days` days,
// aligned to a calendar grid. Returns 7 × ⌈days/7⌉ cells where each cell is
// { date: 'YYYY-MM-DD', count: N }. Empty days carry count 0 so the SVG grid
// is always rectangular.
function buildHeatmap(dates, days = 90, now = new Date()) {
  // Align grid end to "yesterday" (today often partial) and walk back.
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // Snap end to the Saturday that ends its week, so every column is a full week.
  // Sun=0..Sat=6 — walk forward to Saturday.
  const endShift = (6 - end.getUTCDay() + 7) % 7;
  end.setUTCDate(end.getUTCDate() + endShift);
  // Start is `days-1` cells back, then snap back to Sunday for a clean grid.
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - (days - 1));
  const startShift = -start.getUTCDay(); // back to Sunday (day 0)
  start.setUTCDate(start.getUTCDate() + startShift);

  const totalDays = Math.floor((end - start) / 86400000) + 1;
  const cells = [];
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    cells.push({ date: d.toISOString().slice(0, 10), count: 0 });
  }
  const byDate = new Map(cells.map((c, i) => [c.date, i]));
  for (const iso of dates) {
    const key = iso.slice(0, 10);
    if (byDate.has(key)) cells[byDate.get(key)].count++;
  }
  return cells;
}

function heatmapSvg(cells, opts = {}) {
  const { size = 11, gap = 2 } = opts;
  if (!cells || cells.length === 0) return "";
  const rows = 7;
  const cols = Math.ceil(cells.length / rows);
  const width = cols * (size + gap);
  const height = rows * (size + gap);
  const max = Math.max(1, ...cells.map((c) => c.count));
  // 5-level scale, GitHub-style. CSS variables let the theme palette take over
  // in Quartz's dark mode without re-rendering.
  function color(count) {
    if (count === 0) return "var(--lightgray, #ebedf0)";
    const t = count / max;
    if (t < 0.25) return "#9be9a8";
    if (t < 0.5) return "#40c463";
    if (t < 0.75) return "#30a14e";
    return "#216e39";
  }
  const rects = [];
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const col = Math.floor(i / rows);
    const row = i % rows;
    rects.push(
      `<rect x="${col * (size + gap)}" y="${row * (size + gap)}" width="${size}" height="${size}" rx="2" ry="2" fill="${color(c.count)}"><title>${c.date}: ${c.count} commit${c.count === 1 ? "" : "s"}</title></rect>`,
    );
  }
  const total = cells.reduce((a, c) => a + c.count, 0);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-label="${total} commits in the last ${cells.length} days">${rects.join("")}</svg>`;
}

// List every skills/<slug>/SKILL.md path in a repo via the git tree API.
// One call per repo (vs N for contents-API recursion), uses the ref's
// commit SHA so the response is cacheable. Returns [] on any failure.
function fetchSkillSlugs(repoFullName, ref) {
  if (!ref) return [];
  // Wrap the whole thing — a deleted default branch, transient 5xx, or
  // rate-limit blowup on ONE fork should not abort the entire weekly run.
  // ghApi throws on any error except 404 (which it returns as null), so a
  // catch here gives us per-fork resilience.
  try {
    const branch = ghApi(`/repos/${repoFullName}/branches/${encodeURIComponent(ref)}`);
    const sha = branch?.commit?.sha;
    if (!sha) return [];
    const tree = ghApi(`/repos/${repoFullName}/git/trees/${sha}?recursive=1`);
    if (!tree || !Array.isArray(tree.tree)) return [];
    const slugs = new Set();
    for (const node of tree.tree) {
      // Only paths matching `skills/<slug>/SKILL.md` — drop nested dirs and
      // unrelated files. Same convention as upstream's skill layout.
      const m = node.path && node.path.match(/^skills\/([a-z0-9][a-z0-9_-]*)\/SKILL\.md$/i);
      if (m) slugs.add(m[1]);
    }
    return [...slugs].sort();
  } catch (err) {
    console.warn(`  skill-tree fetch failed for ${repoFullName}: ${err.message}`);
    return [];
  }
}

// ── parse upstream ECOSYSTEM.md table (curated projects built on Aeon) ────
// Format is a markdown table: `| Project | Links |` with each Links cell
// holding one or more `[label](url)` separated by ` · `. Returns
// [{ name, links: [{ label, url, x_handle? }] }].
function parseEcosystemMd(md) {
  if (!md) return [];
  const lines = md.split("\n");
  const start = lines.findIndex((l) => /^\|\s*Project\s*\|\s*Links\s*\|/.test(l));
  if (start < 0) return [];
  const out = [];
  for (let i = start + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("|")) break;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    const name = cells[0].replace(/^\*\*|\*\*$/g, "").trim();
    if (!name || /^-+$/.test(name)) continue;
    const links = [];
    for (const part of cells[1].split(/\s·\s/)) {
      const m = part.match(/^\[([^\]]+)\]\(([^)]+)\)/);
      if (!m) continue;
      const link = { label: m[1].trim(), url: m[2].trim() };
      const x = link.url.match(/^https?:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]+)/);
      if (x) link.x_handle = x[1];
      links.push(link);
    }
    out.push({ name, links });
  }
  return out;
}

function fetchEcosystem(upstreamRepo) {
  const md = ghRaw(upstreamRepo, "main", "ECOSYSTEM.md");
  const upstream = parseEcosystemMd(md);
  // Merge with local supplements (this fork's additions, not yet upstreamed).
  const localPath = resolve(ROOT, "ECOSYSTEM.local.md");
  if (!existsSync(localPath)) return upstream;
  const local = parseEcosystemMd(readFileSync(localPath, "utf8"));
  // De-dupe by normalized name. Local wins on collision so a fork can
  // override upstream (e.g. add a GitHub link to an entry that upstream
  // only listed by X handle).
  const norm = (n) => n.toLowerCase().replace(/\s+/g, "");
  const localNames = new Set(local.map((p) => norm(p.name)));
  return [...upstream.filter((p) => !localNames.has(norm(p.name))), ...local];
}

function fetchSkillPacks(upstreamRepo) {
  // skill-packs.json is a machine-readable mirror of the README table.
  const raw = ghRaw(upstreamRepo, "main", "skill-packs.json");
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    return Array.isArray(j.packs) ? j.packs : [];
  } catch { return []; }
}

// Fuzzy match an ecosystem project name against the fork list. Lowercase
// + alpha-only token comparison against owner name, repo name, and
// description. Returns the best matching fork id or null.
function matchEcosystemToFork(project, nodes) {
  const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const projectNorm = norm(project.name);
  if (projectNorm.length < 3) return null;
  // Short project names (≤ 4 chars) cause false positives via substring
  // containment (e.g. "Liq" matches every owner with "liq" anywhere).
  // For those, require the X handle to align with the fork — name-only
  // matches aren't trustworthy when the name is essentially noise.
  const isShortName = projectNorm.length <= 4;
  const xHandles = (project.links || []).map((l) => norm(l.x_handle)).filter(Boolean);
  let best = null;
  for (const n of nodes) {
    if (n.isRoot) continue;
    const ownerN = norm(n.owner);
    const nameN = norm(n.name);
    const descN = norm(n.description);
    let score = 0;
    let xHandleMatched = false;
    for (const x of xHandles) {
      if (x.length >= 4 && (ownerN.includes(x) || x.includes(ownerN))) { score += 3; xHandleMatched = true; }
      if (x.length >= 4 && nameN.includes(x)) { score += 2; xHandleMatched = true; }
    }
    // Owner / repo name match only counts for long-enough project names,
    // or when the X handle already corroborates.
    if (!isShortName || xHandleMatched) {
      if (ownerN.includes(projectNorm) || projectNorm.includes(ownerN)) score += 3;
      if (nameN.includes(projectNorm)) score += 2;
    }
    if (descN.includes(projectNorm) && projectNorm.length >= 5) score += 1;
    if (score > (best?.score || 0)) best = { id: n.id, score };
  }
  return best && best.score >= 2 ? best.id : null;
}

// Multi-root entrypoint: enumerate forks of each upstream independently and
// tag every node with the root it descends from. Same node showing up under
// two different roots is theoretically possible (cross-network fork) — the
// first root we process claims it, subsequent roots see it in `globalFound`
// and skip re-recording (would otherwise change parent/level).
function fetchAllForksMulti(upstreams, depth) {
  const all = [];
  const globalFound = new Set();
  for (const root of upstreams) {
    const nodes = fetchAllForks(root, depth);
    for (const n of nodes) {
      if (globalFound.has(n.fullName)) continue;
      globalFound.add(n.fullName);
      n.root = root; // which upstream tree this node descends from
      all.push(n);
    }
  }
  return all;
}

// ── enumerate forks (depth-limited BFS) ───────────────────────────────────
function fetchAllForks(rootRepo, depth) {
  // Two structures: `found` carries metadata for every repo discovered;
  // `enumerated` tracks which repos have already had their child fork list
  // fetched. Previously the same `visited` map served both roles, which made
  // the BFS skip enumeration of any level-1 fork (because the parent had
  // already recorded its metadata before we got to enumerate it). Separating
  // the two lets us discover-once / enumerate-once independently.
  const found = new Map();
  const enumerated = new Set();
  found.set(rootRepo, { fullName: rootRepo, level: 0, isRoot: true });
  const queue = [{ repo: rootRepo, level: 0 }];
  while (queue.length) {
    const { repo, level } = queue.shift();
    if (enumerated.has(repo)) continue;
    enumerated.add(repo);
    if (level >= depth) continue;
    let page = 1;
    while (true) {
      const forks = ghApi(`/repos/${repo}/forks?per_page=100&sort=newest&page=${page}`);
      if (!Array.isArray(forks) || forks.length === 0) break;
      for (const f of forks) {
        if (!found.has(f.full_name)) {
          found.set(f.full_name, {
            fullName: f.full_name,
            owner: f.owner.login,
            name: f.name,
            stars: f.stargazers_count,
            forks: f.forks_count,
            pushedAt: f.pushed_at,
            defaultBranch: f.default_branch,
            parentFullName: repo,
            private: f.private,
            archived: f.archived,
            description: f.description || "",
            htmlUrl: f.html_url,
            level: level + 1,
          });
        }
        // Enumerate this fork's children only if we haven't yet and we still
        // have depth budget. level+1 < depth means "the children we'd find
        // are within the depth cap." (depth=1 → only enumerate at level 0.)
        if (level + 1 < depth && !enumerated.has(f.full_name)) {
          queue.push({ repo: f.full_name, level: level + 1 });
        }
      }
      if (forks.length < 100) break;
      page++;
    }
  }
  return [...found.values()];
}

// ── parse aeon.yml → list of enabled skills ────────────────────────────────
const RE_SKILL_LINE = /^\s{2}([a-z0-9][a-z0-9_-]+)\s*:\s*(\{[^}]*\}|.*)$/gim;

function parseEnabledSkills(yaml) {
  // Lightweight YAML probe — looks at the `skills:` section and pulls slugs
  // whose entry contains `enabled: true`. Skips multi-line block dicts where
  // detection is fragile; that's an under-count, not a wrong-count.
  if (!yaml) return [];
  const startMatch = yaml.match(/^skills:\s*$/m);
  if (!startMatch) return [];
  // Begin scanning AFTER the `skills:` line itself, so the next-top-level
  // search doesn't immediately re-match `skills:` at offset 0.
  const bodyStart = startMatch.index + startMatch[0].length;
  const body = yaml.slice(bodyStart);
  const end = body.search(/^[a-z][a-z0-9_-]*:\s*$/m); // next top-level section
  const section = end >= 0 ? body.slice(0, end) : body;

  const enabled = new Set();
  for (const m of section.matchAll(RE_SKILL_LINE)) {
    const slug = m[1];
    const rest = m[2];
    if (/enabled\s*:\s*true/.test(rest)) enabled.add(slug);
  }
  return [...enabled].sort();
}

// ── build graph ────────────────────────────────────────────────────────────
function buildGraph(repos) {
  // Nodes: every repo, with metadata. The `root` field on each node tells us
  // which upstream tree it descends from — used everywhere downstream that
  // previously assumed a single root (delta computation, innovations,
  // disabled-defaults audits, etc.).
  const nodes = repos.map((r) => ({
    id: r.fullName,
    label: r.fullName,
    owner: r.owner,
    name: r.name,
    stars: r.stars || 0,
    forks: r.forks || 0,
    pushedAt: r.pushedAt,
    defaultBranch: r.defaultBranch,
    parentFullName: r.parentFullName,
    isRoot: !!r.isRoot,
    root: r.root || (r.isRoot ? r.fullName : null), // which upstream tree
    level: r.level,
    archived: !!r.archived,
    description: r.description || "",
    htmlUrl: r.htmlUrl,
    enabledSkills: r.enabledSkills || [],
    skillCount: (r.enabledSkills || []).length,
    shippedSkills: r.shippedSkills || [],
    recentCommits: r.recentCommits || [],
    recentCommitCount: (r.recentCommits || []).length,
  }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const roots = nodes.filter((n) => n.isRoot);
  const rootById = new Map(roots.map((n) => [n.id, n]));

  const edges = [];
  // fork-of edges
  for (const n of nodes) {
    if (n.parentFullName && byId.has(n.parentFullName)) {
      edges.push({ source: n.id, target: n.parentFullName, kind: "fork-of", weight: 1.0 });
    }
  }

  // Skill-overlap edges — surface forks that made *similar customizations*
  // relative to THEIR specific root. Computed per-root (each root has its
  // own enabled-skill baseline) but pairs are scored only within the same
  // root's tree — cross-root overlap is rare and semantically muddier.
  const SIM_TOP_K = 4;
  const SIM_MIN = 0.30;
  const perFork = new Map();
  for (const root of roots) {
    const baseline = new Set(root.enabledSkills || []);
    const delta = (set) => {
      const d = new Set();
      for (const s of set) if (!baseline.has(s)) d.add(`+${s}`);
      for (const s of baseline) if (!set.has(s)) d.add(`-${s}`);
      return d;
    };
    const nonRoot = nodes.filter((n) => !n.isRoot && n.root === root.id && n.skillCount > 0);
    const deltas = new Map(nonRoot.map((n) => [n.id, delta(new Set(n.enabledSkills))]));
    for (let i = 0; i < nonRoot.length; i++) {
      const aSet = deltas.get(nonRoot[i].id);
      if (aSet.size === 0) continue;
      const scored = [];
      for (let j = 0; j < nonRoot.length; j++) {
        if (i === j) continue;
        const bSet = deltas.get(nonRoot[j].id);
        if (bSet.size === 0) continue;
        let inter = 0;
        for (const s of aSet) if (bSet.has(s)) inter++;
        if (inter < 2) continue;
        const union = aSet.size + bSet.size - inter;
        const j2 = inter / union;
        if (j2 < SIM_MIN) continue;
        scored.push({
          target: nonRoot[j].id,
          score: Math.round(j2 * 1000) / 1000,
          shared: [...aSet].filter((s) => bSet.has(s)).slice(0, 8),
        });
      }
      scored.sort((a, b) => b.score - a.score);
      perFork.set(nonRoot[i].id, scored.slice(0, SIM_TOP_K));
    }
  }
  const seen = new Set();
  for (const [source, list] of perFork) {
    for (const e of list) {
      const key = source < e.target ? `${source}|${e.target}` : `${e.target}|${source}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source, target: e.target, kind: "skill-overlap", weight: e.score, shared: e.shared });
    }
  }

  // Skill popularity — global across all non-root forks (any root). A skill
  // shipped widely by forks of multiple roots is an even stronger adoption
  // signal than one only in a single root's tree.
  const skillPopularity = new Map();
  for (const n of nodes) {
    if (n.isRoot) continue;
    for (const s of n.enabledSkills) skillPopularity.set(s, (skillPopularity.get(s) || 0) + 1);
  }

  // ── Innovations: skills in a fork's skills/ tree that aren't in ITS root's.
  // Per-root because each root ships a different skill set; a skill that's
  // novel relative to aeon-agent might be vanilla relative to aeon.
  const rootShippedById = new Map(roots.map((r) => [r.id, new Set(r.shippedSkills || [])]));
  const innovationsByFork = nodes
    .filter((n) => !n.isRoot && n.shippedSkills.length > 0 && rootShippedById.has(n.root))
    .map((n) => ({
      fork: n.id,
      root: n.root,
      stars: n.stars,
      novel: n.shippedSkills.filter((s) => !rootShippedById.get(n.root).has(s)),
    }))
    .filter((x) => x.novel.length > 0)
    .sort((a, b) => b.novel.length - a.novel.length);

  const innovationsBySkill = new Map();
  for (const f of innovationsByFork) {
    for (const slug of f.novel) {
      if (!innovationsBySkill.has(slug)) innovationsBySkill.set(slug, []);
      innovationsBySkill.get(slug).push(f.fork);
    }
  }

  // ── Disabled-defaults audit per root. Each root has different defaults;
  // surface separately so the reader knows whose defaults are being rejected.
  const disabledDefaults = [];
  for (const root of roots) {
    const upstreamEnabled = new Set(root.enabledSkills || []);
    const forksWithYml = nodes.filter((n) => !n.isRoot && n.root === root.id && n.skillCount > 0);
    for (const slug of upstreamEnabled) {
      const disablingForks = forksWithYml.filter((n) => !n.enabledSkills.includes(slug));
      disabledDefaults.push({
        root: root.id,
        slug,
        disabledIn: disablingForks.length,
        totalForksWithYml: forksWithYml.length,
        disabledRate: forksWithYml.length > 0 ? Math.round((disablingForks.length / forksWithYml.length) * 1000) / 1000 : 0,
      });
    }
  }
  disabledDefaults.sort((a, b) => b.disabledRate - a.disabledRate);

  return {
    generatedAt: new Date().toISOString(),
    // Multi-root: `upstream` is now an array; `upstream` (singular) kept as
    // the first one for back-compat with consumers that hard-coded it.
    upstreams: roots.map((r) => r.id),
    upstream: roots[0]?.id || null,
    stats: {
      roots: roots.length,
      repos: nodes.length,
      forks: nodes.filter((n) => !n.isRoot).length,
      withAeonYml: nodes.filter((n) => n.skillCount > 0).length,
      withCustomSkills: innovationsByFork.length,
      novelSkillsCount: innovationsBySkill.size,
      archived: nodes.filter((n) => n.archived).length,
      forkEdges: edges.filter((e) => e.kind === "fork-of").length,
      skillEdges: edges.filter((e) => e.kind === "skill-overlap").length,
      totalStars: nodes.filter((n) => !n.isRoot).reduce((a, n) => a + (n.stars || 0), 0),
      perRoot: roots.map((r) => ({
        root: r.id,
        forks: nodes.filter((n) => !n.isRoot && n.root === r.id).length,
        withAeonYml: nodes.filter((n) => !n.isRoot && n.root === r.id && n.skillCount > 0).length,
        stars: nodes.filter((n) => !n.isRoot && n.root === r.id).reduce((a, n) => a + (n.stars || 0), 0),
      })),
    },
    skillPopularity: [...skillPopularity.entries()].sort((a, b) => b[1] - a[1])
      .map(([slug, count]) => ({ slug, count })),
    innovationsByFork,
    innovationsBySkill: [...innovationsBySkill.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([slug, forks]) => ({ slug, count: forks.length, forks })),
    disabledDefaults,
    nodes,
    edges,
  };
}

// ── renderers ──────────────────────────────────────────────────────────────
function renderMarkdown(graph) {
  const s = graph.stats;
  const top10 = graph.nodes.filter((n) => !n.isRoot).sort((a, b) => b.stars - a.stars).slice(0, 10);
  const recent = graph.nodes.filter((n) => !n.isRoot).sort((a, b) => new Date(b.pushedAt) - new Date(a.pushedAt)).slice(0, 10);
  const topSkills = graph.skillPopularity.slice(0, 15);
  const topOverlap = graph.edges.filter((e) => e.kind === "skill-overlap").sort((a, b) => b.weight - a.weight).slice(0, 10);

  // YAML front matter so Jekyll renders this as a page at /atlas/ on Pages.
  // Layout `default` matches the inherited theme (minima + skin overrides).
  let out = `---\nlayout: default\ntitle: "Aeon Atlas — Digest"\npermalink: /atlas/\n---\n\n`;
  out += `# Aeon Atlas\n\n`;
  const rootList = (graph.upstreams || [graph.upstream]).map((u) => `[${u}](https://github.com/${u})`).join(", ");
  out += `> Auto-generated by \`scripts/atlas.mjs\` on ${graph.generatedAt.slice(0, 10)}. Tracking ${(graph.upstreams || [graph.upstream]).length} upstream root(s): ${rootList}.\n\n`;
  out += `**${s.repos} repos** across ${s.roots} roots, ${s.withAeonYml} carry an \`aeon.yml\`, ${s.archived} archived, ${s.totalStars} ★ across the fork network.\n\n`;
  if (s.perRoot && s.perRoot.length > 1) {
    out += `Per-root breakdown:\n\n| Root | Forks | With \`aeon.yml\` | ★ |\n|---|---:|---:|---:|\n`;
    for (const r of s.perRoot) {
      out += `| \`${r.root}\` | ${r.forks} | ${r.withAeonYml} | ${r.stars} |\n`;
    }
    out += `\n`;
  }
  out += `Interactive map: [\`atlas.html\`](./atlas.html).\n\n`;

  out += `## Top forks by ★\n\n| ★ | Repo | Last push | Skills enabled |\n|---:|---|---|---:|\n`;
  for (const n of top10) {
    out += `| ${n.stars} | [${n.id}](${n.htmlUrl}) | ${(n.pushedAt || "").slice(0, 10)} | ${n.skillCount} |\n`;
  }

  out += `\n## Most active forks (recent pushes)\n\n| Repo | Last push | ★ |\n|---|---|---:|\n`;
  for (const n of recent) {
    out += `| [${n.id}](${n.htmlUrl}) | ${(n.pushedAt || "").slice(0, 10)} | ${n.stars} |\n`;
  }

  out += `\n## Most-enabled skills across forks\n\n| Skill | Enabled in |\n|---|---:|\n`;
  for (const { slug, count } of topSkills) {
    out += `| \`${slug}\` | ${count} forks |\n`;
  }

  out += `\n## Strongest skill-set overlaps (jaccard ≥ 0.20)\n\n| Score | Fork A | Fork B | Shared |\n|---:|---|---|---|\n`;
  for (const e of topOverlap) {
    out += `| ${e.weight} | ${e.source} | ${e.target} | ${e.shared.join(", ")} |\n`;
  }

  return out;
}

function renderInnovations(graph) {
  const s = graph.stats;
  let out = `---\nlayout: default\ntitle: "Aeon Atlas — Innovations"\npermalink: /innovations/\n---\n\n`;
  out += `# Innovations\n\n`;
  out += `> Auto-generated by \`scripts/atlas.mjs\` on ${graph.generatedAt.slice(0, 10)}. Skills that exist in a fork's \`skills/\` directory but **not** in [\`${graph.upstream}\`](https://github.com/${graph.upstream}).\n\n`;
  out += `**${s.withCustomSkills}** of ${s.forks} forks ship at least one custom skill. **${s.novelSkillsCount}** distinct novel skills across the network.\n\n`;
  out += `The atlas reads each fork's git tree (not just \`aeon.yml\`), so this catches skills that exist in code even when they're not enabled — the actual long tail of code-level innovation in the ecosystem.\n\n`;

  out += `## Top creators (forks with the most novel skills)\n\n`;
  out += `| Fork | Novel skills | ★ |\n|---|---:|---:|\n`;
  for (const f of graph.innovationsByFork.slice(0, 12)) {
    out += `| [${f.fork}](https://github.com/${f.fork}) | ${f.novel.length} | ${f.stars} |\n`;
  }

  const adoptedByMany = graph.innovationsBySkill.filter((s) => s.count >= 2);
  out += `\n## Novel skills adopted by ≥ 2 forks\n\n`;
  if (adoptedByMany.length === 0) {
    out += `_None yet. Every novel skill in the ecosystem is shipped by exactly one fork._\n`;
  } else {
    out += `Skills that originated outside upstream and spread to multiple forks — strong candidates to surface upstream-side.\n\n`;
    out += `| Skill | Shipped in | First forks |\n|---|---:|---|\n`;
    for (const s of adoptedByMany.slice(0, 20)) {
      out += `| \`${s.slug}\` | ${s.count} | ${s.forks.slice(0, 3).join(", ")}${s.forks.length > 3 ? " …" : ""} |\n`;
    }
  }

  out += `\n## Full novel-skill inventory (per fork)\n\n`;
  out += `<details><summary>Expand</summary>\n\n`;
  for (const f of graph.innovationsByFork) {
    out += `**[${f.fork}](https://github.com/${f.fork})** (${f.novel.length} novel)\n`;
    out += `\n${f.novel.map((s) => "  - `" + s + "`").join("\n")}\n\n`;
  }
  out += `</details>\n`;

  return out;
}

function renderDisabledDefaults(graph) {
  let out = `---\nlayout: default\ntitle: "Aeon Atlas — Disabled Defaults"\npermalink: /disabled-defaults/\n---\n\n`;
  out += `# Disabled defaults\n\n`;
  out += `> Auto-generated by \`scripts/atlas.mjs\` on ${graph.generatedAt.slice(0, 10)}. Which upstream-enabled skills are systematically turned off by forks?\n\n`;

  if (graph.disabledDefaults.length === 0) {
    out += `Upstream currently ships **0 skills enabled by default**, so there are no defaults to disable.\n`;
    return out;
  }

  const n = graph.stats.withAeonYml;
  // Group disabled-defaults by root since each upstream has its own baseline.
  // For roots with < 3 forks the rate is meaningless (everything will be
  // 0% or 100%); we still surface them but with a sample-size disclaimer.
  const byRoot = new Map();
  for (const d of graph.disabledDefaults) {
    if (!byRoot.has(d.root)) byRoot.set(d.root, []);
    byRoot.get(d.root).push(d);
  }
  out += `Tracking ${byRoot.size} upstream root(s). Per-root tables below.\n\n`;
  for (const [root, defaults] of byRoot) {
    const sampleSize = defaults[0]?.totalForksWithYml || 0;
    out += `## \`${root}\`\n\n`;
    if (sampleSize < 3) {
      out += `_Sample size: ${sampleSize} fork(s) — rates are not statistically meaningful at this scale; treat as descriptive only._\n\n`;
    }
    out += `Ships **${defaults.length}** skill(s) enabled by default. Disable rates across **${sampleSize}** forks:\n\n`;
    out += `| Skill | Disabled by | Rate |\n|---|---:|---:|\n`;
    for (const d of defaults) {
      const pct = (d.disabledRate * 100).toFixed(0);
      out += `| \`${d.slug}\` | ${d.disabledIn} / ${d.totalForksWithYml} | **${pct}%** |\n`;
    }
    out += `\n`;
  }

  // "Strong rejects" only useful for roots with a non-trivial sample.
  const strongRejects = graph.disabledDefaults.filter((d) => d.disabledRate >= 0.5 && d.totalForksWithYml >= 5);
  if (strongRejects.length > 0) {
    out += `\n## ≥ 50% disable rate → defaults to reconsider (roots with ≥ 5 forks)\n\n`;
    out += `Skills disabled by a majority of operators are strong candidates for upstream to either (a) ship disabled-by-default, (b) document better what the trade-off is, or (c) fix whatever's making them unwelcome.\n\n`;
    for (const d of strongRejects) {
      const pct = (d.disabledRate * 100).toFixed(0);
      out += `- **\`${d.root}\` → \`${d.slug}\`** — disabled by ${pct}% of forks (${d.disabledIn} / ${d.totalForksWithYml}).\n`;
    }
  }

  const accepted = graph.disabledDefaults.filter((d) => d.disabledRate < 0.05 && d.totalForksWithYml >= 5);
  if (accepted.length > 0) {
    out += `\n## Universally accepted defaults (< 5% disable rate, roots with ≥ 5 forks)\n\n`;
    out += `These defaults are working — almost no one turns them off.\n\n`;
    for (const d of accepted) {
      const pct = (d.disabledRate * 100).toFixed(1);
      out += `- **\`${d.root}\` → \`${d.slug}\`** — disabled by only ${pct}% of forks.\n`;
    }
  }

  out += `\n## How this is computed\n\n`;
  out += `For each skill upstream has \`enabled: true\` in \`aeon.yml\`, count how many forks have \`enabled: false\` (or no entry for it) in their own \`aeon.yml\`. Forks that don't carry a parseable \`aeon.yml\` are excluded from the denominator.\n\n`;
  out += `**Caveat:** the YAML probe is a regex (see \`scripts/atlas.mjs:parseEnabledSkills\`) that handles the single-line dict form (\`skill: { enabled: true, … }\`) but skips multi-line block dicts. Real disable rates may therefore be slightly under-counted for skills only ever set via the block form.\n`;
  return out;
}

function renderEcosystem(graph) {
  const s = graph.stats;
  const projects = graph.ecosystemProjects || [];
  let out = `---\nlayout: default\ntitle: "Aeon Atlas — Ecosystem"\npermalink: /ecosystem/\n---\n\n`;
  out += `# Ecosystem\n\n`;
  out += `> Auto-generated by \`scripts/atlas.mjs\` on ${graph.generatedAt.slice(0, 10)}. Source: [\`ECOSYSTEM.md\`](https://github.com/${graph.upstream}/blob/main/ECOSYSTEM.md) on [\`${graph.upstream}\`](https://github.com/${graph.upstream}), cross-matched against the public fork list.\n\n`;
  out += `**${projects.length}** projects publicly identify as building on Aeon. **${s.ecosystemMatched}** have a known public GitHub fork; **${projects.length - s.ecosystemMatched}** run privately or don't expose their fork.\n\n`;

  const matched = projects.filter((p) => p.matchedFork);
  const unmatched = projects.filter((p) => !p.matchedFork);

  out += `## Projects with a known public fork\n\n`;
  out += `These projects publicly identify as built on Aeon AND have a GitHub fork we can map.\n\n`;
  out += `| Project | Links | Public fork | ★ | Last push |\n|---|---|---|---:|---|\n`;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const p of matched) {
    const links = p.links.map((l) => `[${l.label}](${l.url})`).join(" · ");
    const f = byId.get(p.matchedFork);
    out += `| **${p.name}** | ${links} | [${p.matchedFork}](https://github.com/${p.matchedFork}) | ${f?.stars ?? "—"} | ${(f?.pushedAt || "").slice(0, 10) || "—"} |\n`;
  }

  out += `\n## Projects without a known public fork\n\n`;
  out += `Listed in ECOSYSTEM.md but our fuzzy matcher couldn't find a public fork (could be running aeon privately, using a non-obvious owner-name, or the matcher missed a real fit — open an issue if so).\n\n`;
  out += `| Project | Links |\n|---|---|\n`;
  for (const p of unmatched) {
    const links = p.links.map((l) => `[${l.label}](${l.url})`).join(" · ");
    out += `| **${p.name}** | ${links} |\n`;
  }

  out += `\n## Forks not listed in ECOSYSTEM.md or skill-packs\n\n`;
  const ecosystemMatchedIds = new Set(matched.map((p) => p.matchedFork));
  const packMatchedIds = new Set((graph.skillPacks || []).filter((p) => p.authorFork).map((p) => p.authorFork));
  const listedIds = new Set([...ecosystemMatchedIds, ...packMatchedIds]);
  const privateForks = graph.nodes.filter((n) => !n.isRoot && !listedIds.has(n.id) && n.stars > 0);
  if (privateForks.length === 0) {
    out += `_Every fork with ★ ≥ 1 is also listed somewhere upstream-side — clean overlap._\n`;
  } else {
    out += `Forks with ★ ≥ 1 that aren't in either curated list. Their operators might be candidates to invite into ECOSYSTEM.md (with their consent).\n\n`;
    out += `| Fork | ★ | Last push | Description |\n|---|---:|---|---|\n`;
    privateForks.sort((a, b) => b.stars - a.stars).forEach((n) => {
      out += `| [${n.id}](${n.htmlUrl}) | ${n.stars} | ${(n.pushedAt || "").slice(0, 10)} | ${(n.description || "").slice(0, 80).replace(/\|/g, "\\|")} |\n`;
    });
  }

  out += `\n## Matching method\n\n`;
  out += `Each ECOSYSTEM.md project name is tokenized (lowercased, alphanumeric only) and scored against every fork's owner name, repo name, description, and the X handle in the project's link cell. The owner-name match and the X-handle match each contribute up to 3 points; the repo-name match contributes 2; a description match contributes 1. Any fork scoring ≥ 2 is considered a match (best score wins). False positives and missed matches can be fixed by editing the helper in \`scripts/atlas.mjs:matchEcosystemToFork\`.\n`;
  return out;
}

function renderSkillPacks(graph) {
  const s = graph.stats;
  const packs = graph.skillPacks || [];
  let out = `---\nlayout: default\ntitle: "Aeon Atlas — Skill Packs"\npermalink: /skill-packs/\n---\n\n`;
  out += `# Community skill packs\n\n`;
  out += `> Auto-generated by \`scripts/atlas.mjs\` on ${graph.generatedAt.slice(0, 10)}. Source: [\`skill-packs.json\`](https://github.com/${graph.upstream}/blob/main/skill-packs.json) registry on [\`${graph.upstream}\`](https://github.com/${graph.upstream}).\n\n`;
  out += `**${packs.length}** installable skill packs in the community registry. **${s.skillPacksWithFork}** of the pack authors also have public aeon forks (deeper engagement signal — they're not just shipping a pack, they're running aeon).\n\n`;
  out += `Install any of these with \`./install-skill-pack <repo>\` from a checked-out aeon fork (see [\`docs/community-skill-packs.md\`](https://github.com/${graph.upstream}/blob/main/docs/community-skill-packs.md) for details).\n\n`;

  out += `## All packs\n\n`;
  out += `| Pack | Skills | Author | Author fork | Category | Trust | Description |\n|---|---:|---|---|---|---|---|\n`;
  for (const p of packs) {
    const skills = (p.skills || []).length;
    const forkLink = p.authorFork ? `[${p.authorFork}](https://github.com/${p.authorFork})` : "—";
    const desc = (p.description || "").replace(/\|/g, "\\|");
    out += `| [${p.name}](https://github.com/${p.repo}) | ${skills} | ${p.author} | ${forkLink} | ${p.category || "—"} | ${p.trust_level || "—"} | ${desc} |\n`;
  }

  // Category breakdown
  const byCategory = new Map();
  for (const p of packs) {
    const c = p.category || "uncategorized";
    if (!byCategory.has(c)) byCategory.set(c, 0);
    byCategory.set(c, byCategory.get(c) + 1);
  }
  out += `\n## By category\n\n`;
  for (const [cat, count] of [...byCategory.entries()].sort((a, b) => b[1] - a[1])) {
    out += `- **${cat}** — ${count} pack${count === 1 ? "" : "s"}\n`;
  }

  // Pack authors who don't yet have a fork
  const noFork = packs.filter((p) => !p.authorFork);
  if (noFork.length > 0) {
    out += `\n## Pack authors without a known fork\n\n`;
    out += `Authors who shipped a community pack but don't appear in the fork list. Either they don't run aeon themselves, run it under a different GitHub identity, or have a non-conventional repo name.\n\n`;
    for (const p of noFork) {
      out += `- **${p.author}** ([${p.name}](https://github.com/${p.repo}))\n`;
    }
  }

  out += `\n## How this is computed\n\n`;
  out += `Pulls \`skill-packs.json\` from upstream — it's the machine-readable mirror of the README's Community Skill Packs table. Each pack's \`author\` field is exact-matched (case-insensitive) against fork owners. Mismatches happen when the pack author publishes under one GitHub account and forks under another — fixable with a manual override map if it becomes annoying.\n`;
  return out;
}

// ── operator aggregation ───────────────────────────────────────────────────
// An "operator" is a GitHub owner that shows up across multiple atlas entities
// (≥ 2 forks, or a fork + an authored pack, or a fork + a matched ecosystem
// project). Singletons aren't profiled — they'd add hundreds of empty pages.
// Footprint scores the operator's depth of engagement so leaderboards / tags
// can rank them.
function aggregateOperators(graph) {
  const byOwner = new Map();
  function ensure(owner) {
    if (!byOwner.has(owner)) {
      byOwner.set(owner, {
        owner,
        forks: [],
        packs: [],
        ecosystem: [],
        novelSkills: new Set(),
        totalStars: 0,
        xHandles: new Set(),
      });
    }
    return byOwner.get(owner);
  }

  // Walk forks. Root nodes count as operator footprint too (an upstream root
  // like aaronjmars is the highest-footprint operator there is) so include them.
  // Some node shapes (notably root nodes) don't carry an explicit `owner` field
  // — derive it from `id` (owner/repo) as a fallback.
  for (const n of graph.nodes) {
    const owner = n.owner || (n.id ? n.id.split("/")[0] : null);
    if (!owner) continue;
    const op = ensure(owner);
    op.forks.push({ id: n.id, stars: n.stars || 0, archived: !!n.archived, isRoot: !!n.isRoot, pushedAt: n.pushedAt });
    op.totalStars += n.stars || 0;
    for (const s of n.novelSkills || []) op.novelSkills.add(s.slug || s);
  }

  // Walk non-fork users (code-search discoveries).
  if (!byOwner.nonForkInitialized) byOwner.nonForkInitialized = true;
  for (const u of graph.nonForkUsers || []) {
    const op = ensure(u.owner);
    if (!op.nonForkRepos) op.nonForkRepos = [];
    op.nonForkRepos.push({ id: u.id, stars: u.stars, htmlUrl: u.htmlUrl, pushedAt: u.pushedAt });
    op.totalStars += u.stars || 0;
  }

  // Walk skill packs by author (which is a fork-owner string from skill-packs.json).
  for (const p of graph.skillPacks || []) {
    if (!p.author) continue;
    const op = ensure(p.author);
    op.packs.push({ name: p.name, repo: p.repo, skills: (p.skills || []).length });
  }

  // Walk matched ecosystem projects. Group by the owner of the matched fork
  // (otherwise we have no GitHub identity to key on). Also collect X handles.
  for (const p of graph.ecosystemProjects || []) {
    if (!p.matchedFork) continue;
    const owner = p.matchedFork.split("/")[0];
    const op = ensure(owner);
    op.ecosystem.push({ name: p.name, matchedFork: p.matchedFork });
    for (const l of p.links || []) if (l.x_handle) op.xHandles.add(l.x_handle);
  }

  // Threshold: keep operators with ≥ 2 distinct artifacts. An "artifact" is
  // one fork OR one pack OR one matched ecosystem entry OR one non-fork user
  // repo, summed.
  const profiles = [];
  for (const op of byOwner.values()) {
    op.nonForkRepos = op.nonForkRepos || [];
    const artifactCount = op.forks.length + op.packs.length + op.ecosystem.length + op.nonForkRepos.length;
    if (artifactCount < 2) continue;
    // Footprint: weighted. Stars are the easiest-to-cheat signal, so cap their
    // contribution. Packs + ecosystem matches + novel skills carry more weight.
    const starsCapped = Math.min(op.totalStars, 50);
    op.footprint =
      starsCapped +
      op.novelSkills.size * 3 +
      op.packs.length * 5 +
      op.ecosystem.length * 5 +
      op.nonForkRepos.length * 2 +
      (op.forks.length - 1) * 2; // additional forks beyond the first
    op.artifactCount = artifactCount;
    op.novelSkills = [...op.novelSkills].sort();
    op.xHandles = [...op.xHandles];
    profiles.push(op);
  }
  profiles.sort((a, b) => b.footprint - a.footprint);
  return profiles;
}

function renderNonForkUsers(graph) {
  const users = graph.nonForkUsers || [];
  let out = `---\nlayout: default\ntitle: "Aeon Atlas — Non-fork users"\npermalink: /non-fork-users/\n---\n\n`;
  out += `# Non-fork users\n\n`;
  out += `> Auto-generated by \`scripts/atlas.mjs\` on ${graph.generatedAt.slice(0, 10)}. Repos with a recognisable \`aeon.yml\` that aren't in the fork tree of any tracked root — clones, templates, private patterns made public, or forks GitHub doesn't surface in the descendants list.\n\n`;
  out += `**${users.length}** non-fork repos discovered via code search. Forks undercount real adoption — these are operators who built their config standalone.\n\n`;
  if (!users.length) {
    out += `_None found in this run._\n`;
    return out;
  }
  out += `| Repo | ★ | Last push | Description |\n|---|---:|---|---|\n`;
  for (const u of users) {
    const desc = (u.description || "").replace(/\|/g, "\\|");
    out += `| [\`${u.id}\`](${u.htmlUrl}) | ${u.stars} | ${(u.pushedAt || "").slice(0, 10)} | ${desc} |\n`;
  }
  out += `\n## How this is computed\n\n`;
  out += `GitHub code-search for \`morning-brief filename:aeon.yml\` (and similar markers — every aeon.yml ships with these skill slugs). Results are cross-referenced against the fork list; anything code-search returns that isn't a known fork ends up here.\n\n`;
  out += `Search isn't exhaustive — GitHub indexes a sample, and private repos never surface. The number is a lower bound on standalone adoption.\n`;
  return out;
}

// Listed-on-Atlas badge. Tiny "shields"-style SVG operators can drop into
// their README, with a backlink to their operator profile. Static dimensions
// because we don't want to ship webfonts; widths are hand-tuned for the
// most common owner-name lengths (5-15 chars), with a generous right-padding
// so it doesn't clip on slightly longer names.
function renderBadgeSvg(operator) {
  const labelW = 105; // "Aeon Atlas •"
  const valueText = `${operator.footprint}`;
  const valueW = Math.max(28, valueText.length * 7 + 16);
  const totalW = labelW + valueW;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20" role="img" aria-label="Aeon Atlas footprint: ${operator.footprint}">
  <linearGradient id="g" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${totalW}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelW}" height="20" fill="#555"/>
    <rect x="${labelW}" width="${valueW}" height="20" fill="#216e39"/>
    <rect width="${totalW}" height="20" fill="url(#g)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelW / 2}" y="14">Aeon Atlas •</text>
    <text x="${labelW + valueW / 2}" y="14">${operator.footprint}</text>
  </g>
</svg>`;
}

function writeBadges(operators) {
  const dir = resolve(ROOT, "docs/badges");
  mkdirSync(dir, { recursive: true });
  // Wipe so removed operators don't keep stale badges.
  for (const f of readdirSyncSafe(dir)) {
    if (f.endsWith(".svg")) unlinkSyncSafe(resolve(dir, f));
  }
  for (const op of operators) {
    writeFileSync(resolve(dir, `${slugify(op.owner)}.svg`), renderBadgeSvg(op));
  }
}

function renderOperators(graph, operators) {
  let out = `---\nlayout: default\ntitle: "Aeon Atlas — Operators"\npermalink: /operators/\n---\n\n`;
  out += `# Operators\n\n`;
  out += `> Auto-generated by \`scripts/atlas.mjs\` on ${graph.generatedAt.slice(0, 10)}. Operators with ≥ 2 atlas artifacts (forks, authored packs, matched ecosystem entries). Footprint weighs novel-skill output and pack authorship higher than star counts.\n\n`;
  out += `**${operators.length}** operators tracked across this network. The leaderboard surfaces who's actually building vs who cloned once and walked away.\n\n`;
  out += `## Leaderboard\n\n`;
  out += `| Operator | Footprint | Forks | ★ | Packs | Ecosystem | Novel skills |\n|---|---:|---:|---:|---:|---:|---:|\n`;
  for (const op of operators.slice(0, 25)) {
    out += `| [${op.owner}](https://github.com/${op.owner}) | ${op.footprint} | ${op.forks.length} | ${op.totalStars} | ${op.packs.length} | ${op.ecosystem.length} | ${op.novelSkills.length} |\n`;
  }
  out += `\n## How this is computed\n\n`;
  out += `Every fork is grouped by GitHub owner. Skill packs and matched ecosystem projects are attributed to the same owner (packs via the pack's \`author\` field, ecosystem via the matched fork's owner). Footprint = clamped stars + 3 × novel-skill count + 5 × packs + 5 × ecosystem matches + 2 × additional forks. The cap on stars stops a single popular fork from dominating the ranking — engagement breadth matters as much as one viral asset.\n`;
  return out;
}

// ── Quartz content generator ───────────────────────────────────────────────
// Writes one markdown file per entity into quartz/content/<category>/<slug>.md
// with wikilinks to related entities. Quartz indexes wikilinks → graph edges,
// so the natural relationships in atlas.json become the graph the operator
// browses at /universe/.
function slugify(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function forkSlug(fullName) {
  // owner/repo → owner-repo (slashes aren't valid in filenames)
  return fullName.replace(/\//g, "-");
}

function escapeYamlString(s) {
  // YAML frontmatter — quote anything that contains chars YAML would interpret.
  return '"' + (s || "").replace(/"/g, '\\"').replace(/\n/g, " ") + '"';
}

function writeUniverseContent(graph, operators) {
  // Wipe & recreate so deletions in atlas.json don't leave stale notes behind.
  const subs = ["forks", "ecosystem", "packs", "novel-skills", "operators"];
  for (const sub of subs) {
    const dir = resolve(QUARTZ_CONTENT, sub);
    if (existsSync(dir)) {
      for (const f of readdirSyncSafe(dir)) unlinkSyncSafe(resolve(dir, f));
    } else {
      mkdirSync(dir, { recursive: true });
    }
  }

  const upstreamNode = graph.nodes.find((n) => n.isRoot);
  const upstreamSlug = upstreamNode ? forkSlug(upstreamNode.id) : null;
  const matchedForkIdsByProject = new Map(
    (graph.ecosystemProjects || []).filter((p) => p.matchedFork).map((p) => [p.matchedFork, p]),
  );
  const packsByAuthorFork = new Map();
  for (const p of graph.skillPacks || []) {
    if (!p.authorFork) continue;
    if (!packsByAuthorFork.has(p.authorFork)) packsByAuthorFork.set(p.authorFork, []);
    packsByAuthorFork.get(p.authorFork).push(p);
  }
  // Lookup: which owners have an operator profile? Drives backlinks from fork notes.
  const profiledOwners = new Set((operators || []).map((op) => op.owner));
  const novelByFork = new Map(
    (graph.innovationsByFork || []).map((f) => [f.fork, f.novel]),
  );
  // Only render novel-skill notes for skills that spread to ≥ 2 forks — singletons
  // create lots of orphan nodes that bloat the graph without informing it.
  const spreadingNovel = (graph.innovationsBySkill || []).filter((s) => s.count >= 2);
  const spreadingNovelSet = new Set(spreadingNovel.map((s) => s.slug));

  // ── forks ────────────────────────────────────────────────────────────────
  for (const n of graph.nodes) {
    const slug = forkSlug(n.id);
    const lines = [
      `---`,
      `title: ${escapeYamlString(n.id)}`,
      `tags: [fork${n.isRoot ? ", upstream" : ""}${n.archived ? ", archived" : ""}]`,
      `stars: ${n.stars}`,
      `pushed: "${(n.pushedAt || "").slice(0, 10)}"`,
      `enabled_skills: ${n.skillCount || 0}`,
      `shipped_skills: ${(n.shippedSkills || []).length}`,
      `---`,
      ``,
      `# ${n.id}${n.isRoot ? " *(upstream)*" : ""}`,
      ``,
      n.description ? n.description : "_(no description)_",
      ``,
      `[Repository on GitHub](${n.htmlUrl})`,
      ``,
      `- **★** ${n.stars}`,
      `- **Last push:** ${(n.pushedAt || "").slice(0, 10)}`,
      `- **Default branch:** \`${n.defaultBranch}\``,
      `- **Enabled skills in \`aeon.yml\`:** ${n.skillCount || 0}`,
      `- **Skills shipped in \`skills/\`:** ${(n.shippedSkills || []).length}`,
    ];

    // 30-day commit-activity heatmap. Inline SVG so it renders without any
    // Quartz-specific shortcode; gracefully degrades to a blank grid when
    // the fetch returned nothing (private repo, empty commit history, etc).
    const heatmap = buildHeatmap(n.recentCommits || [], 30);
    const totalRecent = heatmap.reduce((a, c) => a + c.count, 0);
    lines.push(``, `## Activity (last 30 days)`, ``);
    lines.push(`**${totalRecent}** commit${totalRecent === 1 ? "" : "s"}.`);
    lines.push(``, heatmapSvg(heatmap), ``);

    // Parent fork
    if (n.parentFullName && !n.isRoot) {
      lines.push(``, `## Parent`, ``, `- [[forks/${forkSlug(n.parentFullName)}|${n.parentFullName}]]`);
    }

    // Operator (backlink to owner's aggregate page if they qualify as multi-artifact).
    if (profiledOwners.has(n.owner)) {
      lines.push(``, `## Operator`, ``, `- [[operators/${slugify(n.owner)}|${n.owner}]]`);
    }

    // Ecosystem project this fork is identified as
    if (matchedForkIdsByProject.has(n.id)) {
      const p = matchedForkIdsByProject.get(n.id);
      lines.push(``, `## Ecosystem identity`, ``, `- [[ecosystem/${slugify(p.name)}|${p.name}]]`);
    }

    // Skill packs authored by this fork's owner
    if (packsByAuthorFork.has(n.id)) {
      lines.push(``, `## Authored skill pack(s)`);
      lines.push(``);
      for (const p of packsByAuthorFork.get(n.id)) {
        lines.push(`- [[packs/${slugify(p.repo)}|${p.name}]]`);
      }
    }

    // Novel skills this fork ships (only the spreading ones get notes)
    const novel = (novelByFork.get(n.id) || []).filter((s) => spreadingNovelSet.has(s));
    if (novel.length > 0) {
      lines.push(``, `## Novel skills shipped (spread to ≥ 2 forks)`);
      lines.push(``);
      for (const s of novel) lines.push(`- [[novel-skills/${slugify(s)}|${s}]]`);
    }

    writeFileSync(resolve(QUARTZ_CONTENT, "forks", `${slug}.md`), lines.join("\n") + "\n");
  }

  // ── ecosystem ────────────────────────────────────────────────────────────
  for (const p of graph.ecosystemProjects || []) {
    const slug = slugify(p.name);
    const lines = [
      `---`,
      `title: ${escapeYamlString(p.name)}`,
      `tags: [ecosystem${p.matchedFork ? ", matched" : ", unmatched"}]`,
      `---`,
      ``,
      `# ${p.name}`,
      ``,
      `Project listed in upstream's [ECOSYSTEM.md](https://github.com/${graph.upstream}/blob/main/ECOSYSTEM.md) as building on Aeon.`,
      ``,
    ];
    if (p.links && p.links.length) {
      lines.push(`## Links`, ``);
      for (const l of p.links) lines.push(`- [${l.label}](${l.url})`);
    }
    if (p.matchedFork) {
      lines.push(``, `## Public fork`, ``, `- [[forks/${forkSlug(p.matchedFork)}|${p.matchedFork}]]`);
    } else {
      lines.push(``, `_(no known public fork — runs privately or uses non-obvious owner name)_`);
    }
    writeFileSync(resolve(QUARTZ_CONTENT, "ecosystem", `${slug}.md`), lines.join("\n") + "\n");
  }

  // ── packs ────────────────────────────────────────────────────────────────
  for (const p of graph.skillPacks || []) {
    const slug = slugify(p.repo);
    const lines = [
      `---`,
      `title: ${escapeYamlString(p.name)}`,
      `tags: [skill-pack, ${p.category || "uncategorized"}, ${p.trust_level || "community"}]`,
      `author: ${escapeYamlString(p.author)}`,
      `---`,
      ``,
      `# ${p.name}`,
      ``,
      p.description || "",
      ``,
      `[Pack repository](https://github.com/${p.repo})`,
      ``,
      `- **Author:** ${p.author}`,
      `- **Category:** ${p.category || "—"}`,
      `- **Trust level:** ${p.trust_level || "—"}`,
      `- **License:** ${p.license || "—"}`,
      `- **Skills shipped:** ${(p.skills || []).length}`,
    ];
    if (p.authorFork) {
      lines.push(``, `## Author's fork`, ``, `- [[forks/${forkSlug(p.authorFork)}|${p.authorFork}]]`);
    }
    if (p.skills && p.skills.length) {
      lines.push(``, `## Skills in this pack`, ``);
      for (const s of p.skills) {
        const target = spreadingNovelSet.has(s) ? `[[novel-skills/${slugify(s)}|${s}]]` : `\`${s}\``;
        lines.push(`- ${target}`);
      }
    }
    writeFileSync(resolve(QUARTZ_CONTENT, "packs", `${slug}.md`), lines.join("\n") + "\n");
  }

  // ── novel skills (only spreading ones) ──────────────────────────────────
  for (const s of spreadingNovel) {
    const slug = slugify(s.slug);
    const lines = [
      `---`,
      `title: ${escapeYamlString(s.slug)}`,
      `tags: [novel-skill]`,
      `adoption: ${s.count}`,
      `---`,
      ``,
      `# \`${s.slug}\``,
      ``,
      `Custom skill shipped by ${s.count} fork${s.count === 1 ? "" : "s"}. Not present in upstream \`${graph.upstream}/skills/\` — strong candidate for upstream contribution.`,
      ``,
      `## Forks shipping this`,
      ``,
    ];
    for (const fork of s.forks) lines.push(`- [[forks/${forkSlug(fork)}|${fork}]]`);
    writeFileSync(resolve(QUARTZ_CONTENT, "novel-skills", `${slug}.md`), lines.join("\n") + "\n");
  }

  // ── operators ────────────────────────────────────────────────────────────
  for (const op of operators || []) {
    const slug = slugify(op.owner);
    const lines = [
      `---`,
      `title: ${escapeYamlString(op.owner)}`,
      `tags: [operator]`,
      `footprint: ${op.footprint}`,
      `forks: ${op.forks.length}`,
      `stars: ${op.totalStars}`,
      `---`,
      ``,
      `# ${op.owner}`,
      ``,
      `Operator profile: ${op.artifactCount} atlas artifact${op.artifactCount === 1 ? "" : "s"} (${op.forks.length} fork${op.forks.length === 1 ? "" : "s"}, ${op.packs.length} pack${op.packs.length === 1 ? "" : "s"}, ${op.ecosystem.length} ecosystem entr${op.ecosystem.length === 1 ? "y" : "ies"}). Footprint **${op.footprint}**, **${op.totalStars} ★** across all forks.`,
      ``,
      `[GitHub profile](https://github.com/${op.owner})`,
      ``,
    ];
    if (op.xHandles.length) {
      lines.push(`## Linked social handles`, ``);
      for (const h of op.xHandles) lines.push(`- [@${h}](https://x.com/${h})`);
      lines.push(``);
    }
    if (op.forks.length) {
      lines.push(`## Forks (${op.forks.length})`, ``);
      const sortedForks = [...op.forks].sort((a, b) => b.stars - a.stars);
      for (const f of sortedForks) {
        const tags = [];
        if (f.isRoot) tags.push("upstream");
        if (f.archived) tags.push("archived");
        const tagStr = tags.length ? ` _(${tags.join(", ")})_` : "";
        lines.push(`- [[forks/${forkSlug(f.id)}|${f.id}]] — ${f.stars} ★${tagStr}`);
      }
      lines.push(``);
    }
    if (op.packs.length) {
      lines.push(`## Authored skill packs (${op.packs.length})`, ``);
      for (const p of op.packs) lines.push(`- [[packs/${slugify(p.repo)}|${p.name}]] — ${p.skills} skill${p.skills === 1 ? "" : "s"}`);
      lines.push(``);
    }
    if (op.ecosystem.length) {
      lines.push(`## Ecosystem identities (${op.ecosystem.length})`, ``);
      for (const e of op.ecosystem) lines.push(`- [[ecosystem/${slugify(e.name)}|${e.name}]]`);
      lines.push(``);
    }
    if ((op.nonForkRepos || []).length) {
      lines.push(`## Standalone repos using aeon (${op.nonForkRepos.length})`, ``);
      for (const r of op.nonForkRepos) lines.push(`- [\`${r.id}\`](${r.htmlUrl}) — ${r.stars} ★`);
      lines.push(``);
    }
    if (op.novelSkills.length) {
      lines.push(`## Novel skills shipped`, ``);
      for (const s of op.novelSkills) {
        const target = spreadingNovelSet.has(s) ? `[[novel-skills/${slugify(s)}|${s}]]` : `\`${s}\``;
        lines.push(`- ${target}`);
      }
      lines.push(``);
    }
    // Shareable badge — small SVG operators can paste into their own README.
    const badgeUrl = `${SITE_BASE}/badges/${slug}.svg`;
    const profileUrl = `${SITE_BASE}/universe/operators/${slug}`;
    const snippet = `[![Listed on Aeon Atlas](${badgeUrl})](${profileUrl})`;
    lines.push(`## Get the badge`, ``);
    lines.push(`![](${badgeUrl})`);
    lines.push(``);
    lines.push(`Add to your README:`);
    lines.push(``, "```markdown", snippet, "```", ``);
    writeFileSync(resolve(QUARTZ_CONTENT, "operators", `${slug}.md`), lines.join("\n") + "\n");
  }

  // ── index ────────────────────────────────────────────────────────────────
  const indexLines = [
    `---`,
    `title: Aeon Atlas — Universe`,
    `---`,
    ``,
    `# Aeon Atlas — Universe`,
    ``,
    `Every entity in the aeon ecosystem we know about, rendered as one navigable graph.`,
    ``,
    `Click the graph icon in the corner to open the global view (every node + edge), or browse via these starting points:`,
    ``,
    `- **${graph.nodes.length} forks** of [\`${graph.upstream}\`](https://github.com/${graph.upstream}) — sample: [[forks/${upstreamSlug}|upstream]]`,
    `- **${(operators || []).length} operators** with ≥ 2 atlas artifacts (multi-fork or fork+pack/ecosystem)`,
    `- **${(graph.ecosystemProjects || []).length} ecosystem projects** publicly identifying as built on Aeon`,
    `- **${(graph.skillPacks || []).length} community skill packs** in the installable registry`,
    `- **${spreadingNovel.length} novel skills** shipped by ≥ 2 forks (i.e. spreading outside upstream)`,
    ``,
    `Or browse the ecosystem by function: [[atlas-layers|seven layers]] — operator fork, fleet, skill packs, discovery infra, storefronts, audit, intake.`,
    ``,
    `## How edges form`,
    ``,
    `Every wikilink in these notes becomes a graph edge. A fork links to its parent fork, its matched ecosystem project, its authored pack, and the novel skills it ships. Ecosystem projects and packs link back. Open the graph view in the top-right corner.`,
    ``,
    `## Source data`,
    ``,
    `Generated by \`scripts/atlas.mjs\` from \`atlas.json\` on ${graph.generatedAt.slice(0, 10)}. The same data backs the [interactive Cytoscape map](../atlas.html), the [ecosystem digest](../ecosystem/), the [packs page](../skill-packs/), the [innovations report](../innovations/), and the [disabled-defaults audit](../disabled-defaults/).`,
  ];
  writeFileSync(resolve(QUARTZ_CONTENT, "index.md"), indexLines.join("\n") + "\n");
}

// readdirSync that tolerates missing dirs (returns []) and unlinkSync that
// tolerates missing files. Wipe-and-recreate uses these to avoid stale notes.
function readdirSyncSafe(dir) { try { return readdirSync(dir); } catch { return []; } }
function unlinkSyncSafe(file) { try { unlinkSync(file); } catch {} }

function renderHtml(graph) {
  const json = safeJsonForScript(graph);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Aeon Atlas — fork ecosystem map</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:dark}
html,body{margin:0;height:100%;font:14px/1.4 system-ui,sans-serif;background:#0e0f12;color:#e6e6e6}
#toolbar{position:fixed;top:8px;left:8px;right:8px;z-index:10;display:flex;gap:8px;align-items:center;padding:8px 12px;background:rgba(20,22,28,0.92);border:1px solid #2a2d35;border-radius:8px}
#toolbar input[type=search]{flex:1;padding:6px 10px;background:#1a1c22;border:1px solid #2a2d35;border-radius:6px;color:#e6e6e6}
#toolbar label{display:flex;align-items:center;gap:4px;user-select:none;font-size:12px}
#stats{color:#888;font-size:12px}
#cy{width:100vw;height:100vh}
#panel{position:fixed;right:8px;top:56px;width:340px;max-height:calc(100vh - 80px);overflow:auto;padding:12px 14px;background:rgba(20,22,28,0.95);border:1px solid #2a2d35;border-radius:8px;display:none}
#panel h3{margin:0 0 6px;font-size:14px}
#panel .meta{color:#888;font-size:12px;margin-bottom:6px}
#panel a{color:#7cc1ff;text-decoration:none}
#panel ul{padding-left:18px;margin:4px 0}
</style></head><body>
<div id="toolbar">
  <strong>Aeon Atlas</strong>
  <input id="search" type="search" placeholder="Search owner/name…">
  <label><input id="overlapToggle" type="checkbox" checked> skill overlap</label>
  <span id="stats"></span>
</div>
<div id="cy"></div><div id="panel"></div>
<script src="https://unpkg.com/cytoscape@3.30.2/dist/cytoscape.min.js"></script>
<script>
const G = ${json};
// Color: root (gold), high-activity recent push (green), archived (gray), default (blue).
const RECENT_DAYS = 90;
const now = Date.now();
function colorFor(n) {
  if (n.isRoot) return '#fbbf24';
  if (n.archived) return '#666';
  const days = n.pushedAt ? (now - new Date(n.pushedAt).getTime()) / 86400000 : 9999;
  if (days < RECENT_DAYS) return '#86efac';
  return '#7cc1ff';
}
function sizeFor(n) { return 10 + Math.log2(1 + (n.stars || 0)) * 5; }

const els = [
  ...G.nodes.map(n => ({ data: { id: n.id, label: n.label, stars: n.stars, pushedAt: n.pushedAt, archived: n.archived, isRoot: n.isRoot, skills: n.enabledSkills, skillCount: n.skillCount, html: n.htmlUrl, desc: n.description } })),
  ...G.edges.map((e, i) => ({ data: { id: 'e' + i, source: e.source, target: e.target, kind: e.kind, weight: e.weight, shared: e.shared || [] }, classes: e.kind })),
];

const cy = cytoscape({
  container: document.getElementById('cy'),
  elements: els,
  style: [
    { selector: 'node', style: {
      'background-color': (n) => colorFor(n.data()),
      'label': 'data(label)', 'color': '#e6e6e6', 'font-size': 9,
      'text-valign': 'bottom', 'text-margin-y': 4,
      'text-outline-color': '#0e0f12', 'text-outline-width': 1.5,
      'width': (n) => sizeFor(n.data()),
      'height': (n) => sizeFor(n.data()),
    }},
    { selector: 'edge', style: {
      'width': 0.8, 'curve-style': 'bezier',
      'line-color': '#3a3d45', 'target-arrow-color': '#3a3d45',
      'target-arrow-shape': 'triangle', 'arrow-scale': 0.7, 'opacity': 0.5,
    }},
    { selector: 'edge.fork-of', style: { 'line-color': '#7cc1ff', 'target-arrow-color': '#7cc1ff', 'opacity': 0.7 }},
    { selector: 'edge.skill-overlap', style: { 'line-color': '#a78bfa', 'line-style': 'dashed', 'opacity': 0.35, 'width': (e) => 0.6 + e.data('weight') * 2 }},
    { selector: 'node.faded, edge.faded', style: { 'opacity': 0.08 }},
    { selector: 'node.hit', style: { 'border-width': 2, 'border-color': '#fff' }},
  ],
  layout: { name: 'cose', animate: false, idealEdgeLength: 110, nodeRepulsion: 7000, gravity: 0.3 },
});

document.getElementById('stats').textContent =
  G.stats.repos + ' repos · ' + G.stats.forkEdges + ' fork edges · ' + G.stats.skillEdges + ' overlap edges · ' + G.stats.totalStars + ' ★';

document.getElementById('overlapToggle').addEventListener('change', (e) => {
  cy.edges('.skill-overlap').style('display', e.target.checked ? 'element' : 'none');
});

const el = (t,o={}) => { const n=document.createElement(t); if(o.text!==undefined)n.textContent=o.text; if(o.className)n.className=o.className; if(o.attrs)for(const[k,v]of Object.entries(o.attrs))n.setAttribute(k,v); if(o.children)for(const c of o.children)n.appendChild(c); return n; };
const panel = document.getElementById('panel');

cy.on('tap', 'node', (evt) => {
  const n = evt.target.data();
  panel.replaceChildren();
  panel.style.display = 'block';
  const titleA = el('a', { text: n.label, attrs: { href: n.html, target: '_blank' } });
  panel.appendChild(el('h3', { children: [titleA] }));
  if (n.desc) panel.appendChild(el('div', { className: 'meta', text: n.desc }));
  panel.appendChild(el('div', { className: 'meta', text: '★ ' + n.stars + ' · last push ' + (n.pushedAt || '—').slice(0, 10) + (n.archived ? ' · archived' : '') + (n.isRoot ? ' · upstream root' : '') }));
  if (n.skills && n.skills.length) {
    panel.appendChild(el('strong', { text: 'Enabled skills (' + n.skillCount + ')' }));
    const ul = el('ul');
    for (const s of n.skills) ul.appendChild(el('li', { text: s }));
    panel.appendChild(ul);
  } else {
    panel.appendChild(el('div', { className: 'meta', text: '(no aeon.yml fetched or no skills enabled)' }));
  }
});
cy.on('tap', (evt) => { if (evt.target === cy) panel.style.display = 'none'; });

document.getElementById('search').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  cy.elements().removeClass('faded hit');
  if (!q) return;
  const matches = cy.nodes().filter(n => n.data('label').toLowerCase().includes(q));
  if (matches.length === 0) return;
  cy.elements().not(matches.union(matches.neighborhood())).addClass('faded');
  matches.addClass('hit');
});
</script></body></html>
`;
}

// ── caching ────────────────────────────────────────────────────────────────
function readCache(name) {
  const path = resolve(CACHE_DIR, `${name}.json`);
  if (!existsSync(path)) return null;
  const age = Date.now() - statSync(path).mtimeMs;
  if (age > CACHE_TTL_MS) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeCache(name, data) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(resolve(CACHE_DIR, `${name}.json`), JSON.stringify(data, null, 2));
}

// ── main ───────────────────────────────────────────────────────────────────
function main() {
  const opts = parseArgv(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`Usage: node scripts/atlas.mjs [--upstream owner/repo] [--depth N] [--cache] [--json]\n`);
    return;
  }

  console.log(`atlas: enumerating forks of ${opts.upstreams.length} upstream(s) [${opts.upstreams.join(", ")}] depth=${opts.depth}`);
  const cacheKey = `forks-${opts.upstreams.map((u) => u.replace("/", "-")).join("+")}-d${opts.depth}`;
  let repos;
  if (opts.cache) {
    repos = readCache(cacheKey);
    if (repos) console.log(`  cache hit: ${repos.length} repos`);
  }
  if (!repos) {
    repos = fetchAllForksMulti(opts.upstreams, opts.depth);
    writeCache(cacheKey, repos);
  }
  console.log(`  found ${repos.length} repo(s) across all roots`);

  // fetch aeon.yml + skills/ tree for each (incl. root nodes)
  console.log(`atlas: fetching aeon.yml and skills/ from each fork`);
  for (const r of repos) {
    if (!r.defaultBranch && !r.isRoot) continue;
    const ref = r.defaultBranch || "main";
    const yml = ghRaw(r.fullName, ref, "aeon.yml");
    r.enabledSkills = parseEnabledSkills(yml);
    r.shippedSkills = fetchSkillSlugs(r.fullName, ref);
  }

  // Fetch commit activity per fork for the 30-day heatmap. Per-fork cache so
  // a re-run within the TTL doesn't replay 148+ commit calls.
  console.log(`atlas: fetching recent commit activity (30d) per fork`);
  for (const r of repos) {
    const cacheName = `commits-${r.fullName.replace("/", "-")}`;
    let dates;
    if (opts.cache) dates = readCache(cacheName);
    if (!dates) {
      dates = fetchCommitDates(r.fullName, 30);
      writeCache(cacheName, dates);
    }
    r.recentCommits = dates;
  }

  // Non-fork discovery: GitHub code-search for distinctive aeon.yml markers,
  // then drop any repos that are already in the fork tree. Result is the
  // population of aeon users who cloned standalone, used template-copy, or
  // built their own config without ever forking.
  console.log(`atlas: scanning code search for non-fork aeon users`);
  const knownIds = new Set(repos.map((r) => r.fullName));
  let nonForkRepoNames;
  if (opts.cache) nonForkRepoNames = readCache("non-fork-repos");
  if (!nonForkRepoNames) {
    nonForkRepoNames = fetchNonForkRepoNames();
    writeCache("non-fork-repos", nonForkRepoNames);
  }
  const discovered = nonForkRepoNames.filter((fn) => !knownIds.has(fn));
  console.log(`  ${nonForkRepoNames.length} repos match aeon code-search · ${discovered.length} are new (non-fork)`);
  const nonForkUsers = [];
  for (const fn of discovered) {
    const cacheName = `nonfork-meta-${fn.replace("/", "-")}`;
    let meta;
    if (opts.cache) meta = readCache(cacheName);
    if (!meta) {
      try {
        meta = ghApi(`/repos/${fn}`);
      } catch { meta = null; }
      writeCache(cacheName, meta || {});
    }
    if (!meta || !meta.full_name) continue;
    nonForkUsers.push({
      id: meta.full_name,
      owner: meta.owner?.login || meta.full_name.split("/")[0],
      name: meta.name,
      stars: meta.stargazers_count || 0,
      pushedAt: meta.pushed_at,
      defaultBranch: meta.default_branch,
      description: meta.description || "",
      htmlUrl: meta.html_url,
      archived: !!meta.archived,
      // GitHub may classify some of these as "fork" of an unrelated parent,
      // or of an aeon root we just haven't enumerated yet. Preserve so we
      // can audit later.
      isFork: !!meta.fork,
      parentFullName: meta.parent?.full_name || null,
    });
  }
  nonForkUsers.sort((a, b) => b.stars - a.stars);

  // Pull each upstream's two curated lists (only some roots ship them).
  // Multiple roots often list the SAME entries — aeon-agent's ECOSYSTEM.md
  // mostly mirrors aeon's. Merge by stable key (name for ecosystem, repo
  // for packs) and preserve which roots list each entry as `listedBy[]`.
  // Without this, downstream digests would double-count: same project
  // appearing twice in ecosystem.md, same pack twice in skill-packs.md.
  console.log(`atlas: fetching ECOSYSTEM.md + skill-packs.json per root`);
  const ecosystemByName = new Map();
  const skillPacksByRepo = new Map();
  for (const root of opts.upstreams) {
    const eco = fetchEcosystem(root);
    for (const p of eco) {
      const key = p.name;
      if (!ecosystemByName.has(key)) {
        ecosystemByName.set(key, { ...p, listedBy: [root] });
      } else {
        ecosystemByName.get(key).listedBy.push(root);
      }
    }
    const packs = fetchSkillPacks(root);
    for (const p of packs) {
      const key = p.repo;
      if (!skillPacksByRepo.has(key)) {
        skillPacksByRepo.set(key, { ...p, listedBy: [root] });
      } else {
        skillPacksByRepo.get(key).listedBy.push(root);
      }
    }
  }
  const ecosystem = [...ecosystemByName.values()];
  const skillPacks = [...skillPacksByRepo.values()];

  const graph = buildGraph(repos);
  // Cross-match ecosystem projects → forks (fuzzy)
  graph.ecosystemProjects = ecosystem.map((p) => ({
    ...p,
    matchedFork: matchEcosystemToFork(p, graph.nodes),
  }));
  // Cross-match skill packs → forks via author username
  graph.skillPacks = skillPacks.map((p) => {
    const author = (p.author || "").toLowerCase();
    const authorFork = graph.nodes.find((n) => !n.isRoot && n.owner.toLowerCase() === author);
    return { ...p, authorFork: authorFork?.id || null };
  });
  // Reverse: which forks listed in NEITHER (private operators)
  const matchedForkIds = new Set([
    ...graph.ecosystemProjects.filter((p) => p.matchedFork).map((p) => p.matchedFork),
    ...graph.skillPacks.filter((p) => p.authorFork).map((p) => p.authorFork),
  ]);
  graph.stats.ecosystemProjects = ecosystem.length;
  graph.stats.ecosystemMatched = graph.ecosystemProjects.filter((p) => p.matchedFork).length;
  graph.stats.skillPacks = skillPacks.length;
  graph.stats.skillPacksWithFork = graph.skillPacks.filter((p) => p.authorFork).length;
  graph.stats.forksNotPubliclyListed = graph.nodes.filter((n) => !n.isRoot && !matchedForkIds.has(n.id)).length;
  graph.nonForkUsers = nonForkUsers;
  graph.stats.nonForkUsers = nonForkUsers.length;

  // Aggregate operator profiles before JSON serialization so atlas.json
  // reflects them too. Detail object is held separately for renderers.
  const operators = aggregateOperators(graph);
  graph.operators = operators.map((op) => ({
    owner: op.owner,
    footprint: op.footprint,
    forks: op.forks.length,
    totalStars: op.totalStars,
    packs: op.packs.length,
    ecosystem: op.ecosystem.length,
    novelSkills: op.novelSkills.length,
  }));
  graph.stats.operators = operators.length;

  if (opts.json) {
    process.stdout.write(JSON.stringify(graph, null, 2));
    return;
  }

  mkdirSync(dirname(OUT_HTML), { recursive: true });
  const json = JSON.stringify(graph, null, 2);
  writeFileSync(OUT_JSON, json);
  writeFileSync(OUT_JSON_DOCS, json);
  writeFileSync(OUT_MD, renderMarkdown(graph));
  writeFileSync(OUT_HTML, renderHtml(graph));
  writeFileSync(OUT_INNOVATIONS, renderInnovations(graph));
  writeFileSync(OUT_DISABLED_DEFAULTS, renderDisabledDefaults(graph));
  writeFileSync(OUT_ECOSYSTEM, renderEcosystem(graph));
  writeFileSync(OUT_SKILL_PACKS, renderSkillPacks(graph));
  writeFileSync(OUT_OPERATORS, renderOperators(graph, operators));
  writeFileSync(OUT_NON_FORK, renderNonForkUsers(graph));
  writeBadges(operators);
  // Quartz-content emit is optional — only writes if the quartz/ subdirectory
  // exists (i.e. the operator has set up Quartz locally). Keeps the script
  // usable on installs without the Quartz toolchain.
  if (existsSync(resolve(ROOT, "quartz"))) writeUniverseContent(graph, operators);
  const whatsNew = writeWhatsNew(graph);
  const digest = writeDigestAndFeed();

  const s = graph.stats;
  console.log(`\natlas: ${s.repos} repos · ${s.withAeonYml} with aeon.yml · ${s.forkEdges} fork edges · ${s.skillEdges} skill-overlap edges · ${s.totalStars} ★`);
  console.log(`  innovations: ${s.withCustomSkills} forks ship custom skills · ${s.novelSkillsCount} distinct novel slugs`);
  console.log(`  ecosystem: ${s.ecosystemProjects} projects in ECOSYSTEM.md · ${s.ecosystemMatched} matched to forks`);
  console.log(`  skill-packs: ${s.skillPacks} packs in registry · ${s.skillPacksWithFork} authors also have aeon forks`);
  console.log(`  ${s.forksNotPubliclyListed} forks not in ECOSYSTEM.md or skill-packs (private operators)`);
  console.log(`  wrote atlas.json`);
  console.log(`  wrote docs/atlas.json`);
  console.log(`  wrote docs/atlas.md`);
  console.log(`  wrote docs/atlas.html`);
  console.log(`  wrote docs/innovations.md`);
  console.log(`  wrote docs/disabled-defaults.md`);
  console.log(`  wrote docs/ecosystem.md`);
  console.log(`  wrote docs/skill-packs.md`);
  console.log(`  wrote docs/operators.md (${operators.length} multi-artifact operators)`);
  console.log(`  wrote docs/non-fork-users.md (${nonForkUsers.length} standalone aeon repos)`);
  if (existsSync(resolve(ROOT, "quartz"))) console.log(`  wrote quartz/content/{forks,ecosystem,packs,novel-skills,operators}/*.md`);
  if (whatsNew.hadPrior) {
    const d = whatsNew.diff;
    console.log(`  whats-new: +${d.newForks.length} forks, -${d.removedForks.length}, +${d.newNovelSkills.length} novel skills, +${d.newEcosystem.length} ecosystem entries`);
  } else {
    console.log(`  whats-new: first snapshot recorded (no diff yet)`);
  }
  console.log(`  digest: ${digest.entryCount} entr${digest.entryCount === 1 ? "y" : "ies"} → docs/digest/, docs/feed.xml`);
}

// ── weekly diff: snapshot graph, diff against the prior snapshot, render. ──
// Snapshot is a trimmed projection (id + stars + lastPushed + novel skills +
// matched ecosystem name) — big enough to diff meaningfully, small enough to
// commit one per run without bloating the repo.
function buildSnapshot(graph) {
  const ecosystemByFork = new Map(
    (graph.ecosystemProjects || [])
      .filter((p) => p.matchedFork)
      .map((p) => [p.matchedFork, p.name]),
  );
  return {
    generatedAt: graph.generatedAt,
    upstreams: graph.upstreams || [graph.upstream],
    stats: {
      repos: graph.stats.repos,
      forks: graph.stats.forks,
      withAeonYml: graph.stats.withAeonYml,
      totalStars: graph.stats.totalStars,
      ecosystemProjects: graph.stats.ecosystemProjects,
      skillPacks: graph.stats.skillPacks,
    },
    nodes: graph.nodes
      .filter((n) => !n.isRoot)
      .map((n) => ({
        id: n.id,
        stars: n.stars || 0,
        pushedAt: n.pushedAt || null,
        archived: !!n.archived,
        novelSkills: (n.novelSkills || []).map((s) => s.slug || s).sort(),
        ecosystemName: ecosystemByFork.get(n.id) || null,
      })),
    ecosystemProjects: (graph.ecosystemProjects || []).map((p) => p.name).sort(),
    skillPacks: (graph.skillPacks || []).map((p) => `${p.author || ""}/${p.name || ""}`).sort(),
    novelSkillSlugs: (graph.innovationsBySkill || []).map((s) => s.slug).sort(),
  };
}

function loadPriorSnapshot(todayIso) {
  if (!existsSync(HISTORY_DIR)) return null;
  const today = todayIso.slice(0, 10);
  const files = readdirSync(HISTORY_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .filter((f) => f.slice(0, 10) < today)
    .sort();
  const latest = files[files.length - 1];
  if (!latest) return null;
  try {
    return { date: latest.slice(0, 10), data: JSON.parse(readFileSync(resolve(HISTORY_DIR, latest), "utf8")) };
  } catch { return null; }
}

function diffSnapshots(prev, curr) {
  const prevIds = new Set(prev.nodes.map((n) => n.id));
  const currIds = new Set(curr.nodes.map((n) => n.id));
  const prevById = new Map(prev.nodes.map((n) => [n.id, n]));
  const currById = new Map(curr.nodes.map((n) => [n.id, n]));

  const newForks = curr.nodes.filter((n) => !prevIds.has(n.id));
  const removedForks = prev.nodes.filter((n) => !currIds.has(n.id));

  const starDeltas = [];
  for (const n of curr.nodes) {
    const p = prevById.get(n.id);
    if (!p) continue;
    const d = (n.stars || 0) - (p.stars || 0);
    if (d !== 0) starDeltas.push({ id: n.id, delta: d, stars: n.stars });
  }
  starDeltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const prevNovel = new Set(prev.novelSkillSlugs || []);
  const newNovelSkills = (curr.novelSkillSlugs || []).filter((s) => !prevNovel.has(s));
  const currNovel = new Set(curr.novelSkillSlugs || []);
  const droppedNovelSkills = (prev.novelSkillSlugs || []).filter((s) => !currNovel.has(s));

  const prevEco = new Set(prev.ecosystemProjects || []);
  const currEco = new Set(curr.ecosystemProjects || []);
  const newEcosystem = [...currEco].filter((p) => !prevEco.has(p));
  const removedEcosystem = [...prevEco].filter((p) => !currEco.has(p));

  const prevPacks = new Set(prev.skillPacks || []);
  const currPacks = new Set(curr.skillPacks || []);
  const newPacks = [...currPacks].filter((p) => !prevPacks.has(p));
  const removedPacks = [...prevPacks].filter((p) => !currPacks.has(p));

  // Activity transition: was active (pushed ≤ 60d before prev snapshot) and
  // is now dormant (pushed > 60d before curr snapshot) — or vice versa.
  const dormantThresholdDays = 60;
  const dormancyWasActiveNowDormant = [];
  const dormancyWasDormantNowActive = [];
  const prevSnapshotMs = new Date(prev.generatedAt).getTime();
  const currSnapshotMs = new Date(curr.generatedAt).getTime();
  for (const n of curr.nodes) {
    const p = prevById.get(n.id);
    if (!p || !p.pushedAt || !n.pushedAt) continue;
    const prevAgeDays = (prevSnapshotMs - new Date(p.pushedAt).getTime()) / 86400000;
    const currAgeDays = (currSnapshotMs - new Date(n.pushedAt).getTime()) / 86400000;
    if (prevAgeDays <= dormantThresholdDays && currAgeDays > dormantThresholdDays) {
      dormancyWasActiveNowDormant.push({ id: n.id, lastPushed: n.pushedAt });
    } else if (prevAgeDays > dormantThresholdDays && currAgeDays <= dormantThresholdDays) {
      dormancyWasDormantNowActive.push({ id: n.id, lastPushed: n.pushedAt });
    }
  }

  return {
    newForks,
    removedForks,
    starDeltas,
    newNovelSkills,
    droppedNovelSkills,
    newEcosystem,
    removedEcosystem,
    newPacks,
    removedPacks,
    dormancyWasActiveNowDormant,
    dormancyWasDormantNowActive,
  };
}

function renderWhatsNewBody(diff, prev, curr) {
  const lines = [];
  const days = Math.round((new Date(curr.generatedAt) - new Date(prev.generatedAt)) / 86400000);
  const since = prev.date || prev.generatedAt.slice(0, 10);
  const totals = [
    `${diff.newForks.length} new forks`,
    `${diff.removedForks.length} removed`,
    `${diff.newNovelSkills.length} new novel skills`,
    `${diff.newEcosystem.length} new ecosystem entries`,
    `${diff.newPacks.length} new skill packs`,
  ];
  lines.push(`> Diff vs snapshot from **${since}** (${days} day${days === 1 ? "" : "s"} ago). ${totals.join(" · ")}.\n`);

  function section(title, body) {
    lines.push(`## ${title}\n`);
    lines.push(body);
    lines.push("");
  }

  if (diff.newForks.length) {
    section(
      `New forks (${diff.newForks.length})`,
      diff.newForks
        .slice(0, 25)
        .map((f) => `- [\`${f.id}\`](https://github.com/${f.id}) — ${f.stars} ★`)
        .join("\n") + (diff.newForks.length > 25 ? `\n\n_…and ${diff.newForks.length - 25} more._` : ""),
    );
  }

  if (diff.removedForks.length) {
    section(
      `Removed forks (${diff.removedForks.length})`,
      diff.removedForks.map((f) => `- \`${f.id}\` (deleted or unforked)`).join("\n"),
    );
  }

  if (diff.newNovelSkills.length) {
    section(
      `New novel skills (${diff.newNovelSkills.length})`,
      diff.newNovelSkills.map((s) => `- \`${s}\``).join("\n"),
    );
  }

  const gainers = diff.starDeltas.filter((d) => d.delta > 0).slice(0, 10);
  const losers = diff.starDeltas.filter((d) => d.delta < 0).slice(0, 5);
  if (gainers.length) {
    section(
      `Top ★ gainers`,
      gainers.map((d) => `- [\`${d.id}\`](https://github.com/${d.id}) +${d.delta} (now ${d.stars} ★)`).join("\n"),
    );
  }
  if (losers.length) {
    section(
      `Top ★ losers`,
      losers.map((d) => `- [\`${d.id}\`](https://github.com/${d.id}) ${d.delta} (now ${d.stars} ★)`).join("\n"),
    );
  }

  if (diff.dormancyWasActiveNowDormant.length) {
    section(
      `Went dormant (no push in 60+ days)`,
      diff.dormancyWasActiveNowDormant
        .slice(0, 15)
        .map((d) => `- \`${d.id}\` — last push ${d.lastPushed.slice(0, 10)}`)
        .join("\n"),
    );
  }
  if (diff.dormancyWasDormantNowActive.length) {
    section(
      `Woke up`,
      diff.dormancyWasDormantNowActive
        .map((d) => `- \`${d.id}\` — pushed ${d.lastPushed.slice(0, 10)}`)
        .join("\n"),
    );
  }

  if (diff.newEcosystem.length) {
    section(`New ecosystem entries`, diff.newEcosystem.map((p) => `- ${p}`).join("\n"));
  }
  if (diff.removedEcosystem.length) {
    section(`Removed ecosystem entries`, diff.removedEcosystem.map((p) => `- ${p}`).join("\n"));
  }
  if (diff.newPacks.length) {
    section(`New skill packs`, diff.newPacks.map((p) => `- \`${p}\``).join("\n"));
  }

  return lines.join("\n");
}

function renderWhatsNew(graph, diff, prev, curr) {
  let out = `---\nlayout: default\ntitle: "Aeon Atlas — What's new"\npermalink: /whats-new/\n---\n\n`;
  out += `# What's new\n\n`;
  if (!prev || !diff) {
    out += `> First snapshot recorded ${curr.generatedAt.slice(0, 10)}. No prior history to diff against yet — next run will produce the first delta.\n`;
    return out;
  }
  out += renderWhatsNewBody(diff, prev, curr);
  return out;
}

function renderWhatsNewUniverse(graph, diff, prev, curr) {
  let out = `---\ntitle: "What's new"\ntags: [meta]\n---\n\n`;
  if (!prev || !diff) {
    out += `_First snapshot recorded ${curr.generatedAt.slice(0, 10)}. No prior history to diff against yet._\n`;
    return out;
  }
  out += renderWhatsNewBody(diff, prev, curr);
  return out;
}

function writeWhatsNew(graph) {
  mkdirSync(HISTORY_DIR, { recursive: true });
  const curr = buildSnapshot(graph);
  const today = curr.generatedAt.slice(0, 10);
  // Load prior BEFORE writing today's snapshot — otherwise the first run of
  // a new day would diff against itself.
  const prior = loadPriorSnapshot(curr.generatedAt);
  const diff = prior ? diffSnapshots(prior.data, curr) : null;
  // Write today's snapshot (overwrites if same date — last run of the day wins).
  writeFileSync(resolve(HISTORY_DIR, `${today}.json`), JSON.stringify(curr, null, 2));
  writeFileSync(OUT_WHATS_NEW, renderWhatsNew(graph, diff, prior ? prior.data : null, curr));
  if (existsSync(resolve(ROOT, "quartz"))) {
    writeFileSync(
      resolve(QUARTZ_CONTENT, "whats-new.md"),
      renderWhatsNewUniverse(graph, diff, prior ? prior.data : null, curr),
    );
  }
  return { hadPrior: !!prior, diff };
}

// ── digest pages + Atom feed ──────────────────────────────────────────────
// Per-date permalink pages for every diff between adjacent history snapshots.
// Each page survives forever as the canonical record of that week. The Atom
// feed indexes the most recent ones so feed readers (and bots) can subscribe.
function loadAllSnapshots() {
  if (!existsSync(HISTORY_DIR)) return [];
  return readdirSync(HISTORY_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .map((f) => {
      try {
        return { date: f.slice(0, 10), data: JSON.parse(readFileSync(resolve(HISTORY_DIR, f), "utf8")) };
      } catch { return null; }
    })
    .filter(Boolean);
}

function digestSummary(diff) {
  const parts = [];
  if (diff.newForks.length) parts.push(`${diff.newForks.length} new fork${diff.newForks.length === 1 ? "" : "s"}`);
  if (diff.removedForks.length) parts.push(`${diff.removedForks.length} removed`);
  if (diff.newNovelSkills.length) parts.push(`${diff.newNovelSkills.length} new novel skill${diff.newNovelSkills.length === 1 ? "" : "s"}`);
  if (diff.newEcosystem.length) parts.push(`${diff.newEcosystem.length} new ecosystem entr${diff.newEcosystem.length === 1 ? "y" : "ies"}`);
  if (diff.newPacks.length) parts.push(`${diff.newPacks.length} new pack${diff.newPacks.length === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : "no material changes";
}

// Tiny Markdown → HTML pass for feed content. Atom <content type="html"> wants
// real HTML; converting the diff body via a full md parser pulls in deps we
// don't otherwise need, so this handles only the constructs renderWhatsNewBody
// actually emits: headings, bullets, **bold**, `code`, [text](url), blockquotes.
function mdToHtml(md) {
  const lines = md.split("\n");
  const out = [];
  let inList = false, inBlock = false;
  const closeList = () => { if (inList) { out.push("</ul>"); inList = false; } };
  const closeBlock = () => { if (inBlock) { out.push("</blockquote>"); inBlock = false; } };
  function inline(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  }
  for (const raw of lines) {
    if (/^##\s/.test(raw)) {
      closeList(); closeBlock();
      out.push(`<h2>${inline(raw.replace(/^##\s+/, ""))}</h2>`);
    } else if (/^>\s?/.test(raw)) {
      closeList();
      if (!inBlock) { out.push("<blockquote>"); inBlock = true; }
      out.push(`<p>${inline(raw.replace(/^>\s?/, ""))}</p>`);
    } else if (/^-\s/.test(raw)) {
      closeBlock();
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inline(raw.replace(/^-\s+/, ""))}</li>`);
    } else if (raw.trim() === "") {
      closeList(); closeBlock();
    } else {
      closeList(); closeBlock();
      out.push(`<p>${inline(raw)}</p>`);
    }
  }
  closeList(); closeBlock();
  return out.join("\n");
}

function xmlEscape(s) {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function writeDigestAndFeed() {
  const snaps = loadAllSnapshots();
  if (snaps.length < 2) return { entryCount: 0 };

  // Build one diff per adjacent pair.
  const entries = [];
  for (let i = 1; i < snaps.length; i++) {
    const prev = snaps[i - 1];
    const curr = snaps[i];
    const diff = diffSnapshots(prev.data, curr.data);
    const hasContent =
      diff.newForks.length || diff.removedForks.length ||
      diff.newNovelSkills.length || diff.newEcosystem.length ||
      diff.newPacks.length || diff.dormancyWasActiveNowDormant.length ||
      diff.dormancyWasDormantNowActive.length;
    if (!hasContent) continue;
    const body = renderWhatsNewBody(diff, { ...prev.data, date: prev.date }, curr.data);
    entries.push({
      date: curr.date,
      prevDate: prev.date,
      summary: digestSummary(diff),
      body,
    });
  }

  // Per-date permalink pages.
  mkdirSync(OUT_DIGEST_DIR, { recursive: true });
  for (const e of entries) {
    const page = `---\nlayout: default\ntitle: "Aeon Atlas — Digest ${e.date}"\npermalink: /digest/${e.date}/\n---\n\n# ${e.date}\n\n${e.body}`;
    writeFileSync(resolve(OUT_DIGEST_DIR, `${e.date}.md`), page);
  }

  // Index page.
  let idx = `---\nlayout: default\ntitle: "Aeon Atlas — Weekly digest"\npermalink: /digest/\n---\n\n# Weekly digest\n\n`;
  idx += `Auto-generated diff between each pair of [history snapshots](https://github.com/swarm-ai-research/aeon-atlas/tree/main/history). Subscribe via [Atom feed](/aeon-atlas/feed.xml).\n\n`;
  for (const e of [...entries].reverse()) {
    idx += `- **[${e.date}](/aeon-atlas/digest/${e.date}/)** — ${e.summary}\n`;
  }
  writeFileSync(OUT_DIGEST_INDEX, idx);

  // Atom feed (last 20 entries).
  const recent = [...entries].reverse().slice(0, 20);
  const updated = recent[0]?.date || new Date().toISOString().slice(0, 10);
  const feed = [];
  feed.push(`<?xml version="1.0" encoding="utf-8"?>`);
  feed.push(`<feed xmlns="http://www.w3.org/2005/Atom">`);
  feed.push(`  <title>Aeon Atlas — Weekly digest</title>`);
  feed.push(`  <id>${SITE_BASE}/feed.xml</id>`);
  feed.push(`  <link href="${SITE_BASE}/" rel="alternate"/>`);
  feed.push(`  <link href="${SITE_BASE}/feed.xml" rel="self"/>`);
  feed.push(`  <updated>${updated}T00:00:00Z</updated>`);
  feed.push(`  <author><name>scripts/atlas.mjs</name></author>`);
  for (const e of recent) {
    const url = `${SITE_BASE}/digest/${e.date}/`;
    feed.push(`  <entry>`);
    feed.push(`    <title>${xmlEscape(`Digest ${e.date}: ${e.summary}`)}</title>`);
    feed.push(`    <id>${url}</id>`);
    feed.push(`    <link href="${url}" rel="alternate"/>`);
    feed.push(`    <updated>${e.date}T00:00:00Z</updated>`);
    feed.push(`    <summary>${xmlEscape(e.summary)}</summary>`);
    feed.push(`    <content type="html">${xmlEscape(mdToHtml(e.body))}</content>`);
    feed.push(`  </entry>`);
  }
  feed.push(`</feed>`);
  writeFileSync(OUT_FEED, feed.join("\n") + "\n");

  return { entryCount: entries.length };
}

main();
