---
layout: default
title: "Aeon Atlas"
---

<div class="hero">
  <h1><span>Aeon Atlas</span></h1>
  <p>
    A live map of the <a href="https://github.com/aaronjmars/aeon">aeon</a> fork ecosystem —
    every public fork, what they enable, where they cluster.
    Regenerated weekly.
  </p>
  <div class="hero-links">
    <a class="btn btn-primary" href="atlas.html">Open the interactive map</a>
    <a class="btn btn-outline" href="atlas/">Digest</a>
    <a class="btn btn-outline" href="https://github.com/rsavitt/aeon-atlas" target="_blank" rel="noopener">Source on GitHub</a>
  </div>
</div>

## What this is

This site publishes a single artifact: a navigable map of every public fork of [`aaronjmars/aeon`](https://github.com/aaronjmars/aeon), built from the GitHub Forks API and each fork's `aeon.yml`.

- **[`atlas.html`](atlas.html)** — interactive Cytoscape view. Nodes are repos, sized by ★, colored by recent activity. Click any fork to see its enabled-skill list. Edges show the fork tree (`fork-of`) plus dashed purple edges for forks that made similar customizations to upstream.
- **[`atlas.md`](atlas.html)** — readable digest: top forks by ★, most-active recent pushes, most-enabled skills across the fleet, strongest customization-overlap pairs. *(Markdown rendered by GitHub when viewed in the repo.)*
- **`atlas.json`** — full machine-readable graph, including per-skill popularity counts.

## Edge design

Naive "skill-overlap = jaccard(enabled_A, enabled_B)" produces a hairball because most forks are unmodified clones — everyone has `heartbeat` enabled, so everyone overlaps with everyone. The atlas instead scores overlap on each fork's **delta from upstream** (which skills it added or disabled vs. the baseline). The visible clusters are therefore "these forks made similar customizations," not "these forks both shipped heartbeat."

Top-4 per fork, jaccard ≥ 0.30, ≥ 2 shared deltas. On the first snapshot this cut overlap edges from **7047 to 394**, all meaningful.

## Refresh cadence

The [`atlas` skill](https://github.com/rsavitt/aeon-atlas/blob/main/skills/atlas/SKILL.md) runs every Sunday at 04:00 UTC. It fetches the fork list, parses each `aeon.yml`, regenerates these artifacts, and opens a PR only when something material changed — a new fork joined, a fork's ★ jumped, a dormant fork resumed activity, or a high-confidence overlap pair appeared.

## What it isn't

- **Not a skill marketplace.** It catalogs what's *enabled* in `aeon.yml`, not what's available in `skills/`. A fork can ship skills nobody runs; those don't show here.
- **Not a contribution graph.** No committer or contributor data yet.
- **Not real-time.** Weekly is enough for an ecosystem adding a few forks per day.
- **Not portable.** Always maps `aaronjmars/aeon`'s descendants. `node scripts/atlas.mjs --upstream owner/repo` points it elsewhere if you fork the atlas for your own ecosystem.

## Source

[`rsavitt/aeon-atlas`](https://github.com/rsavitt/aeon-atlas) on GitHub. This Pages site is built from the `docs/` directory of `main`.

The atlas is itself an aeon fork — a vanilla descendant of `aaronjmars/aeon` whose only divergence is the `atlas` script and skill. Upstream commits merge cleanly via `git fetch upstream main`.
