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
  return parseEcosystemMd(md);
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

function writeUniverseContent(graph) {
  // Wipe & recreate so deletions in atlas.json don't leave stale notes behind.
  const subs = ["forks", "ecosystem", "packs", "novel-skills"];
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

    // Parent fork
    if (n.parentFullName && !n.isRoot) {
      lines.push(``, `## Parent`, ``, `- [[forks/${forkSlug(n.parentFullName)}|${n.parentFullName}]]`);
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
    `- **${(graph.ecosystemProjects || []).length} ecosystem projects** publicly identifying as built on Aeon`,
    `- **${(graph.skillPacks || []).length} community skill packs** in the installable registry`,
    `- **${spreadingNovel.length} novel skills** shipped by ≥ 2 forks (i.e. spreading outside upstream)`,
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

  // Pull each upstream's two curated lists (only some roots ship them).
  // Each entry is tagged with the root it came from so renderers can show
  // per-root sections.
  console.log(`atlas: fetching ECOSYSTEM.md + skill-packs.json per root`);
  const ecosystem = [];
  const skillPacks = [];
  for (const root of opts.upstreams) {
    const eco = fetchEcosystem(root);
    for (const p of eco) ecosystem.push({ ...p, root });
    const packs = fetchSkillPacks(root);
    for (const p of packs) skillPacks.push({ ...p, root });
  }

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
  // Quartz-content emit is optional — only writes if the quartz/ subdirectory
  // exists (i.e. the operator has set up Quartz locally). Keeps the script
  // usable on installs without the Quartz toolchain.
  if (existsSync(resolve(ROOT, "quartz"))) writeUniverseContent(graph);

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
  if (existsSync(resolve(ROOT, "quartz"))) console.log(`  wrote quartz/content/{forks,ecosystem,packs,novel-skills}/*.md`);
}

main();
