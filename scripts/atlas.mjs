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
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_UPSTREAM = "aaronjmars/aeon";
// Outputs live under docs/ so GitHub Pages serves them at their natural URLs.
// docs/atlas.json is the public machine-readable artifact; we ALSO keep a
// copy at repo root for backward-compat with tools that already point there.
const OUT_JSON = resolve(ROOT, "atlas.json");
const OUT_JSON_DOCS = resolve(ROOT, "docs/atlas.json");
const OUT_MD = resolve(ROOT, "docs/atlas.md");
const OUT_HTML = resolve(ROOT, "docs/atlas.html");
const OUT_INNOVATIONS = resolve(ROOT, "docs/innovations.md");
const OUT_DISABLED_DEFAULTS = resolve(ROOT, "docs/disabled-defaults.md");
const CACHE_DIR = resolve(ROOT, ".atlas-cache");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ── argv ───────────────────────────────────────────────────────────────────
function parseArgv(argv) {
  const opts = { upstream: DEFAULT_UPSTREAM, depth: 1, json: false, cache: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--upstream") opts.upstream = argv[++i];
    else if (a === "--depth") opts.depth = Number(argv[++i]);
    else if (a === "--json") opts.json = true;
    else if (a === "--cache") opts.cache = true;
    else if (a === "-h" || a === "--help") opts.help = true;
  }
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
  // Resolve branch → commit SHA so the tree API call is stable.
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
  // Nodes: every repo, with metadata
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
    level: r.level,
    archived: !!r.archived,
    description: r.description || "",
    htmlUrl: r.htmlUrl,
    enabledSkills: r.enabledSkills || [],
    skillCount: (r.enabledSkills || []).length,
    shippedSkills: r.shippedSkills || [],
  }));
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const edges = [];
  // fork-of edges
  for (const n of nodes) {
    if (n.parentFullName && byId.has(n.parentFullName)) {
      edges.push({ source: n.id, target: n.parentFullName, kind: "fork-of", weight: 1.0 });
    }
  }
  // Skill-overlap edges — surface forks that made *similar customizations*,
  // not forks that simply cloned the upstream baseline. We compute jaccard
  // on each fork's delta from upstream (skills it enabled that upstream did
  // not, and vice versa). Top-K per fork to keep density bounded.
  const upstreamNode = nodes.find((n) => n.isRoot);
  const upstreamSkills = new Set(upstreamNode?.enabledSkills || []);
  const SIM_TOP_K = 4;
  const SIM_MIN = 0.30;
  const delta = (set) => {
    const d = new Set();
    for (const s of set) if (!upstreamSkills.has(s)) d.add(`+${s}`);
    for (const s of upstreamSkills) if (!set.has(s)) d.add(`-${s}`);
    return d;
  };
  const nonRoot = nodes.filter((n) => !n.isRoot && n.skillCount > 0);
  const deltas = new Map(nonRoot.map((n) => [n.id, delta(new Set(n.enabledSkills))]));
  // perFork[i] = scored candidates [{target, score, shared}] for top-K selection
  const perFork = new Map();
  for (let i = 0; i < nonRoot.length; i++) {
    const aSet = deltas.get(nonRoot[i].id);
    if (aSet.size === 0) continue; // vanilla fork — no customization to share
    const scored = [];
    for (let j = 0; j < nonRoot.length; j++) {
      if (i === j) continue;
      const bSet = deltas.get(nonRoot[j].id);
      if (bSet.size === 0) continue;
      let inter = 0;
      for (const s of aSet) if (bSet.has(s)) inter++;
      if (inter < 2) continue; // require at least 2 shared customizations
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
  const seen = new Set();
  for (const [source, list] of perFork) {
    for (const e of list) {
      const key = source < e.target ? `${source}|${e.target}` : `${e.target}|${source}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source, target: e.target, kind: "skill-overlap", weight: e.score, shared: e.shared });
    }
  }

  // Skill popularity table: which skill is enabled in how many forks
  const skillPopularity = new Map();
  for (const n of nodes) {
    if (n.isRoot) continue; // upstream baseline; not a "choice"
    for (const s of n.enabledSkills) skillPopularity.set(s, (skillPopularity.get(s) || 0) + 1);
  }

  // ── Innovations: skills present in a fork's skills/ tree but NOT upstream's.
  // This is where actual code-level customization lives — the atlas was blind
  // to this when it only parsed aeon.yml. Per-skill: which forks ship it;
  // per-fork: which custom skills it carries.
  const upstreamShipped = new Set(upstreamNode?.shippedSkills || []);
  const innovationsByFork = nodes
    .filter((n) => !n.isRoot && n.shippedSkills.length > 0)
    .map((n) => ({
      fork: n.id,
      stars: n.stars,
      novel: n.shippedSkills.filter((s) => !upstreamShipped.has(s)),
    }))
    .filter((x) => x.novel.length > 0)
    .sort((a, b) => b.novel.length - a.novel.length);

  const innovationsBySkill = new Map(); // slug → [forks shipping it]
  for (const f of innovationsByFork) {
    for (const slug of f.novel) {
      if (!innovationsBySkill.has(slug)) innovationsBySkill.set(slug, []);
      innovationsBySkill.get(slug).push(f.fork);
    }
  }

  // ── Disabled-defaults audit: which skills does upstream ship enabled that
  // forks systematically turn off? Counts and rates make the case for
  // "these defaults are wrong" or "these defaults need a better explainer."
  const upstreamEnabled = new Set(upstreamNode?.enabledSkills || []);
  const forksWithYml = nodes.filter((n) => !n.isRoot && n.skillCount > 0);
  const disabledDefaults = [...upstreamEnabled].map((slug) => {
    const disablingForks = forksWithYml.filter((n) => !n.enabledSkills.includes(slug));
    return {
      slug,
      disabledIn: disablingForks.length,
      totalForksWithYml: forksWithYml.length,
      disabledRate: forksWithYml.length > 0 ? Math.round((disablingForks.length / forksWithYml.length) * 1000) / 1000 : 0,
    };
  }).sort((a, b) => b.disabledRate - a.disabledRate);

  return {
    generatedAt: new Date().toISOString(),
    upstream: nodes.find((n) => n.isRoot)?.id || null,
    stats: {
      repos: nodes.length,
      forks: nodes.filter((n) => !n.isRoot).length,
      withAeonYml: nodes.filter((n) => n.skillCount > 0).length,
      withCustomSkills: innovationsByFork.length,
      novelSkillsCount: innovationsBySkill.size,
      archived: nodes.filter((n) => n.archived).length,
      forkEdges: edges.filter((e) => e.kind === "fork-of").length,
      skillEdges: edges.filter((e) => e.kind === "skill-overlap").length,
      totalStars: nodes.filter((n) => !n.isRoot).reduce((a, n) => a + (n.stars || 0), 0),
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
  out += `> Auto-generated by \`scripts/atlas.mjs\` on ${graph.generatedAt.slice(0, 10)}. Source: GitHub Forks API for [${graph.upstream}](https://github.com/${graph.upstream}).\n\n`;
  out += `**${s.repos} repos** (${s.forks} forks of \`${graph.upstream}\`), ${s.withAeonYml} carry an \`aeon.yml\`, ${s.archived} archived, ${s.totalStars} ★ across the fork network.\n\n`;
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
  out += `Upstream (\`${graph.upstream}\`) ships **${graph.disabledDefaults.length}** skill(s) enabled by default. Across **${n}** forks with parseable \`aeon.yml\`, the disable rates are:\n\n`;
  out += `| Skill | Disabled by | Rate |\n|---|---:|---:|\n`;
  for (const d of graph.disabledDefaults) {
    const pct = (d.disabledRate * 100).toFixed(0);
    out += `| \`${d.slug}\` | ${d.disabledIn} / ${d.totalForksWithYml} | **${pct}%** |\n`;
  }

  const strongRejects = graph.disabledDefaults.filter((d) => d.disabledRate >= 0.5);
  if (strongRejects.length > 0) {
    out += `\n## ≥ 50% disable rate → defaults to reconsider\n\n`;
    out += `Skills disabled by a majority of operators are strong candidates for upstream to either (a) ship disabled-by-default, (b) document better what the trade-off is, or (c) fix whatever's making them unwelcome.\n\n`;
    for (const d of strongRejects) {
      const pct = (d.disabledRate * 100).toFixed(0);
      out += `- **\`${d.slug}\`** — disabled by ${pct}% of forks (${d.disabledIn} / ${d.totalForksWithYml}).\n`;
    }
  }

  const accepted = graph.disabledDefaults.filter((d) => d.disabledRate < 0.05);
  if (accepted.length > 0) {
    out += `\n## Universally accepted defaults (< 5% disable rate)\n\n`;
    out += `These defaults are working — almost no one turns them off.\n\n`;
    for (const d of accepted) {
      const pct = (d.disabledRate * 100).toFixed(1);
      out += `- **\`${d.slug}\`** — disabled by only ${pct}% of forks.\n`;
    }
  }

  out += `\n## How this is computed\n\n`;
  out += `For each skill upstream has \`enabled: true\` in \`aeon.yml\`, count how many forks have \`enabled: false\` (or no entry for it) in their own \`aeon.yml\`. Forks that don't carry a parseable \`aeon.yml\` are excluded from the denominator.\n\n`;
  out += `**Caveat:** the YAML probe is a regex (see \`scripts/atlas.mjs:parseEnabledSkills\`) that handles the single-line dict form (\`skill: { enabled: true, … }\`) but skips multi-line block dicts. Real disable rates may therefore be slightly under-counted for skills only ever set via the block form.\n`;
  return out;
}

function renderHtml(graph) {
  const json = JSON.stringify(graph);
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

  console.log(`atlas: enumerating forks of ${opts.upstream} (depth ${opts.depth})`);
  let repos;
  if (opts.cache) {
    repos = readCache(`forks-${opts.upstream.replace("/", "-")}-d${opts.depth}`);
    if (repos) console.log(`  cache hit: ${repos.length} repos`);
  }
  if (!repos) {
    repos = fetchAllForks(opts.upstream, opts.depth);
    writeCache(`forks-${opts.upstream.replace("/", "-")}-d${opts.depth}`, repos);
  }
  console.log(`  found ${repos.length} repo(s) (including the upstream root)`);

  // fetch aeon.yml + skills/ tree for each
  console.log(`atlas: fetching aeon.yml and skills/ from each fork`);
  for (const r of repos) {
    if (r.isRoot || !r.defaultBranch) continue;
    const yml = ghRaw(r.fullName, r.defaultBranch, "aeon.yml");
    r.enabledSkills = parseEnabledSkills(yml);
    r.shippedSkills = fetchSkillSlugs(r.fullName, r.defaultBranch);
  }
  // upstream itself
  const upstream = repos.find((r) => r.isRoot);
  if (upstream) {
    const yml = ghRaw(upstream.fullName, "main", "aeon.yml");
    upstream.enabledSkills = parseEnabledSkills(yml);
    upstream.shippedSkills = fetchSkillSlugs(upstream.fullName, "main");
  }

  const graph = buildGraph(repos);

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

  const s = graph.stats;
  console.log(`\natlas: ${s.repos} repos · ${s.withAeonYml} with aeon.yml · ${s.forkEdges} fork edges · ${s.skillEdges} skill-overlap edges · ${s.totalStars} ★`);
  console.log(`  innovations: ${s.withCustomSkills} forks ship custom skills · ${s.novelSkillsCount} distinct novel slugs`);
  console.log(`  wrote atlas.json`);
  console.log(`  wrote docs/atlas.json`);
  console.log(`  wrote docs/atlas.md`);
  console.log(`  wrote docs/atlas.html`);
  console.log(`  wrote docs/innovations.md`);
  console.log(`  wrote docs/disabled-defaults.md`);
}

main();
