# Aeon Atlas

A map of the [aeon](https://github.com/aaronjmars/aeon) fork ecosystem — every public fork, what they enable, where they cluster.

This repo is a fork of [`aaronjmars/aeon`](https://github.com/aaronjmars/aeon) whose sole purpose is to keep that map fresh. One skill is enabled (`atlas`, weekly); everything else from the upstream skill catalog ships disabled.

For what aeon itself is, see [the upstream README](https://github.com/aaronjmars/aeon).

## Demo

<video src="https://github.com/swarm-ai-safety/aeon-atlas/raw/main/docs/assets/universe-graph-dark.mp4" controls muted loop playsinline width="100%"></video>

> Quartz graph of the fork ecosystem — three clusters, one per upstream root (`aeon`, `aeon-agent`, `miroshark-aeon`), connected by skill-overlap edges. Interactive version at **[swarm-ai-safety.github.io/aeon-atlas/universe/](https://swarm-ai-safety.github.io/aeon-atlas/universe/)**. Re-record with `node scripts/screenshot-universe.mjs --video --theme dark`.

## What you get

| Artifact | What it shows |
|---|---|
| [`/universe/`](https://swarm-ai-safety.github.io/aeon-atlas/universe/) | Quartz-rendered graph + per-entity notes for every fork, ecosystem project, skill pack, and novel skill. Backlinks + tag clusters + global graph view. |
| [`docs/atlas.html`](docs/atlas.html) | Interactive Cytoscape map. Fork tree, colored by recent activity. Click any node for its enabled-skill list, ★, last-push date. |
| [`docs/atlas.md`](docs/atlas.md) | Readable digest — top forks by ★, most-active recent pushes, most-enabled skills across the fleet, strongest customization-overlap pairs. |
| [`docs/whats-new.md`](docs/whats-new.md) | Diff vs the most recent prior `history/` snapshot — new/removed forks, ★ movers, new novel skills, ecosystem additions, activity transitions. |
| [`atlas.json`](atlas.json) | Machine-readable: nodes (repos with metadata), edges (`fork-of` + `skill-overlap`), per-skill popularity. |

## How it builds the graph

For every public fork of `aaronjmars/aeon` (via the GitHub Forks API):

1. **Fetch** the fork's `aeon.yml` and parse which skills it has `enabled: true`.
2. **Compute its delta** from upstream (which skills it added or disabled vs. the upstream baseline). Vanilla forks — those that cloned and never customized — have an empty delta and don't get overlap edges. The signal of interest is **customization patterns**, not identical clones.
3. **Score overlap** between any two non-vanilla forks as the Jaccard similarity of their deltas. Keep the top 4 per fork above 0.30 with at least 2 shared customizations.

So the dense edges of the graph aren't "these forks both contain heartbeat" (universal — heartbeat ships enabled in upstream) but "these forks both enabled `narrative-tracker` and `defi-monitor` while disabling `morning-brief`."

## Refresh cadence

Weekly, Sunday 04:00 UTC. The `atlas` skill (see [`skills/atlas/SKILL.md`](skills/atlas/SKILL.md)) regenerates everything, diffs against the prior run, and opens a PR only when something changed materially (new fork, ★ jump, dormant fork resumed, new high-overlap pair, etc.).

To regenerate locally:

```bash
node scripts/atlas.mjs              # fresh fetch + write all artifacts
node scripts/atlas.mjs --cache      # reuse cached fork list if < 24h old
node scripts/atlas.mjs --json       # print atlas.json to stdout
node scripts/atlas.mjs --depth 2    # include forks-of-forks (default 1)
```

The script uses `gh api` for auth headroom; with no auth it falls back to unauthenticated `curl` (60 req/hr rate limit — usually fine for one run).

## What it isn't

- **Not a skill marketplace.** It catalogs what's enabled in `aeon.yml`, not what's available in `skills/`. A fork can ship skills nobody runs; those don't show here.
- **Not a contribution graph.** Doesn't currently look at committers or contributor overlap — could be added later.
- **Not real-time.** Weekly cadence is enough for an ecosystem that adds a few forks per day.
- **Not portable to other forks.** The atlas always maps `aaronjmars/aeon`'s descendants. Use `--upstream owner/repo` if you want to point it elsewhere.

## Relationship to upstream

This is a vanilla GitHub fork — all upstream commits flow in via `git fetch upstream main`. The only divergence is `scripts/atlas.mjs`, `skills/atlas/`, the `atlas` line in `aeon.yml`, the rewritten README, and the regenerated artifacts. Periodic merges from upstream keep the rest in sync.

---

Originally created with the methodology pioneered in [`rsavitt/aeon`'s notegraph](https://github.com/rsavitt/aeon/blob/main/docs/notegraph.html) work (PRs #64–#79). Same TF-IDF + clustering tooling, applied to the fork network instead of internal notes.
