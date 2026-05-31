#!/usr/bin/env node
/**
 * atlas-snapshot-diff — compute structured "surprises" between two atlas.json
 * snapshots so the atlas-improve skill can pick what to instrument or fix.
 *
 * Usage:
 *   node scripts/atlas-snapshot-diff.mjs <prev.json> <curr.json>
 *   node scripts/atlas-snapshot-diff.mjs --git HEAD~30 HEAD   # diff vs 30 commits ago
 *
 * Output: JSON on stdout, one structured `surprises` array with each surprise
 * tagged by kind + magnitude + a one-line "why-it-matters". Sorted by magnitude
 * so the consumer can `[0]` to get the headline.
 *
 * Surprise kinds
 *   star_jump        — a fork's ★ count increased by ≥ 3 since prev
 *   new_fork         — a public fork appeared that wasn't in prev
 *   dormant_active   — a fork's pushedAt advanced > 7 days (vs being stale)
 *   new_pack         — a new entry in skill-packs.json registry
 *   new_ecosystem    — a new project in ECOSYSTEM.md
 *   novel_skill_spread — a custom skill spread to ≥ 1 more fork
 *   ecosystem_match_drop — fewer matched ecosystem projects (matcher regression)
 *   overlap_cluster_birth — a skill-overlap edge weight ≥ 0.7 that didn't exist
 *   metric_drift     — any aggregate stat shifted > 15%
 *
 * The skill that consumes this picks one surprise and asks: "what edge, metric,
 * section, or instrumentation would have caught this earlier or surfaced it
 * more prominently?" — then proposes that as an improvement.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

function loadJsonFromGit(ref, path = "atlas.json") {
  const r = spawnSync("git", ["show", `${ref}:${path}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git show ${ref}:${path} failed:\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

function loadJsonFromFile(path) {
  if (!existsSync(path)) throw new Error(`not found: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function indexById(nodes) {
  return new Map(nodes.map((n) => [n.id, n]));
}

function pctChange(prev, curr) {
  // Zero-baseline returns null (a metric appearing for the first time isn't
  // "infinite drift" — the call site treats null as "skip this metric"
  // because other surprise kinds will catch first-time appearances).
  // Returning Infinity here corrupted the structured output: JSON.stringify
  // serialized pct as `null` while the why text said "+Infinity%".
  if (!prev) return null;
  return Math.round(((curr - prev) / prev) * 1000) / 10; // percent, 1dp
}

function compute(prev, curr) {
  const surprises = [];
  const prevNodes = indexById(prev.nodes);
  const currNodes = indexById(curr.nodes);

  // ── star_jump ──────────────────────────────────────────────────────────
  for (const n of curr.nodes) {
    const p = prevNodes.get(n.id);
    if (!p) continue;
    const delta = (n.stars || 0) - (p.stars || 0);
    if (delta >= 3) {
      surprises.push({
        kind: "star_jump",
        magnitude: delta,
        fork: n.id,
        prev_stars: p.stars,
        curr_stars: n.stars,
        why: `${n.id} gained ${delta}★ — that's a clearly visible event the atlas doesn't currently highlight in any digest`,
      });
    }
  }

  // ── new_fork ───────────────────────────────────────────────────────────
  for (const n of curr.nodes) {
    if (n.isRoot) continue;
    if (prevNodes.has(n.id)) continue;
    surprises.push({
      kind: "new_fork",
      magnitude: n.stars || 1,
      fork: n.id,
      why: `${n.id} joined the network; if it ships a novel skill, instrument that path more prominently`,
    });
  }

  // ── dormant_active ─────────────────────────────────────────────────────
  for (const n of curr.nodes) {
    const p = prevNodes.get(n.id);
    if (!p || !p.pushedAt || !n.pushedAt) continue;
    const advance = (new Date(n.pushedAt) - new Date(p.pushedAt)) / 86400000;
    const prevDormancy = (Date.parse(prev.generatedAt) - Date.parse(p.pushedAt)) / 86400000;
    if (advance > 7 && prevDormancy > 60) {
      surprises.push({
        kind: "dormant_active",
        magnitude: Math.round(prevDormancy),
        fork: n.id,
        prev_dormant_days: Math.round(prevDormancy),
        why: `${n.id} resumed activity after ${Math.round(prevDormancy)}d dormant — the atlas treats it as a generic active fork, no "resurrected" surfacing`,
      });
    }
  }

  // ── new_pack ───────────────────────────────────────────────────────────
  const prevPacks = new Set((prev.skillPacks || []).map((p) => p.repo));
  for (const p of curr.skillPacks || []) {
    if (!prevPacks.has(p.repo)) {
      surprises.push({
        kind: "new_pack",
        magnitude: (p.skills || []).length,
        pack: p.repo,
        why: `${p.repo} entered the community skill-packs registry; check whether the author's fork is detected and whether any pack skills are novel-skill candidates`,
      });
    }
  }

  // ── new_ecosystem ──────────────────────────────────────────────────────
  const prevEco = new Set((prev.ecosystemProjects || []).map((p) => p.name));
  for (const p of curr.ecosystemProjects || []) {
    if (!prevEco.has(p.name)) {
      surprises.push({
        kind: "new_ecosystem",
        magnitude: p.matchedFork ? 2 : 1, // matched = stronger signal
        project: p.name,
        matched: !!p.matchedFork,
        why: `${p.name} added to ECOSYSTEM.md; matched=${!!p.matchedFork}. If unmatched, consider whether the matcher could have caught it`,
      });
    }
  }

  // ── novel_skill_spread ─────────────────────────────────────────────────
  const prevNovel = new Map((prev.innovationsBySkill || []).map((s) => [s.slug, s.count]));
  for (const s of curr.innovationsBySkill || []) {
    const prevCount = prevNovel.get(s.slug) || 0;
    const delta = s.count - prevCount;
    if (delta > 0 && s.count >= 3) {
      surprises.push({
        kind: "novel_skill_spread",
        magnitude: s.count,
        skill: s.slug,
        prev_adoption: prevCount,
        curr_adoption: s.count,
        why: `${s.slug} now shipped by ${s.count} forks (was ${prevCount}). High-adoption custom skills are the strongest upstream-contribution candidate`,
      });
    }
  }

  // ── ecosystem_match_drop ───────────────────────────────────────────────
  const prevMatched = (prev.stats && prev.stats.ecosystemMatched) || 0;
  const currMatched = (curr.stats && curr.stats.ecosystemMatched) || 0;
  if (currMatched < prevMatched - 1) {
    surprises.push({
      kind: "ecosystem_match_drop",
      magnitude: prevMatched - currMatched,
      prev_matched: prevMatched,
      curr_matched: currMatched,
      why: `ecosystem matcher recall dropped from ${prevMatched} to ${currMatched} matched — likely a regression in matchEcosystemToFork; investigate`,
    });
  }

  // ── overlap_cluster_birth ──────────────────────────────────────────────
  const prevHighOverlap = new Set(
    (prev.edges || [])
      .filter((e) => e.kind === "skill-overlap" && e.weight >= 0.7)
      .map((e) => [e.source, e.target].sort().join("|")),
  );
  for (const e of curr.edges || []) {
    if (e.kind !== "skill-overlap" || e.weight < 0.7) continue;
    const key = [e.source, e.target].sort().join("|");
    if (!prevHighOverlap.has(key)) {
      surprises.push({
        kind: "overlap_cluster_birth",
        magnitude: Math.round(e.weight * 10),
        a: e.source,
        b: e.target,
        weight: e.weight,
        shared: e.shared,
        why: `${e.source} ↔ ${e.target} formed a high-overlap pair (${e.weight}). Pairs this strong often signal coordinated cohorts worth featuring`,
      });
    }
  }

  // ── metric_drift ───────────────────────────────────────────────────────
  for (const key of ["repos", "totalStars", "withCustomSkills", "novelSkillsCount", "skillPacks", "ecosystemProjects", "forksNotPubliclyListed"]) {
    const prevV = (prev.stats && prev.stats[key]) ?? 0;
    const currV = (curr.stats && curr.stats[key]) ?? 0;
    const pct = pctChange(prevV, currV);
    // Skip zero-baselines — pctChange returns null and a "metric first
    // appeared" event is better captured by the new_fork / new_pack /
    // new_ecosystem surprise kinds than by an artificial drift number.
    if (pct === null) continue;
    if (Math.abs(pct) >= 15 && Math.abs(currV - prevV) >= 2) {
      surprises.push({
        kind: "metric_drift",
        magnitude: Math.abs(currV - prevV),
        metric: key,
        prev: prevV,
        curr: currV,
        pct,
        why: `${key} shifted ${pct >= 0 ? "+" : ""}${pct}% (${prevV} → ${currV}). Worth a section in the digest explaining what's behind it`,
      });
    }
  }

  surprises.sort((a, b) => (b.magnitude || 0) - (a.magnitude || 0));
  return {
    prev_generated: prev.generatedAt,
    curr_generated: curr.generatedAt,
    surprises,
  };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help")) {
    process.stdout.write(
      `Usage:\n` +
      `  node scripts/atlas-snapshot-diff.mjs <prev.json> <curr.json>\n` +
      `  node scripts/atlas-snapshot-diff.mjs --git <prev-ref> <curr-ref>\n`,
    );
    return;
  }
  let prev, curr;
  if (argv[0] === "--git") {
    prev = loadJsonFromGit(argv[1] || "HEAD~30");
    curr = loadJsonFromGit(argv[2] || "HEAD");
  } else {
    prev = loadJsonFromFile(argv[0]);
    curr = loadJsonFromFile(argv[1]);
  }
  const out = compute(prev, curr);
  process.stdout.write(JSON.stringify(out, null, 2));
}

main();
