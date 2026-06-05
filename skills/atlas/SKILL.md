---
name: Atlas
description: Weekly map of every public fork of aaronjmars/aeon — fork tree + skill-overlap clustering + readable digest of who's running what
var: ""
tags: [meta, ecosystem]
---

Today is ${today}. Regenerate the ecosystem atlas — every public fork of `aaronjmars/aeon` with their enabled skill sets, grouped by what they actually run.

**Skip notify and PR when nothing material changed.** Silence on a stable ecosystem is the expected weekly outcome.

## Steps

### 1. Run the extractor

```bash
node scripts/atlas.mjs
```

The script writes:

- `atlas.json` — machine-readable, full node/edge data + per-skill popularity
- `docs/atlas.md` — readable digest (top forks by ★, most-enabled skills, strongest customization-overlap pairs)
- `docs/atlas.html` — Cytoscape map (fork tree colored by recent activity, click for skill list)

It prints a one-line summary like `atlas: 142 repos · 139 with aeon.yml · 141 fork edges · 394 skill-overlap edges · 10 ★`. Capture for the verdict.

It also emits per-entity markdown into `quartz/content/` (gated on `quartz/` existing — present in CI by design). This is the source for the universe view; the build step below converts it to HTML.

The GitHub API calls use the workflow's `GITHUB_TOKEN` automatically (`gh api`). Public-only data; no secrets needed.

### 2. Rebuild the Quartz universe view

```bash
scripts/build-universe.sh
```

Bootstraps the Quartz upstream scaffold (gitignored, pulled from `github.com/jackyzha0/quartz.git` at the version pinned in the script, default `v5.0.0`), runs `npm install` in `quartz/` if needed, then `quartz plugin install` + `quartz build --output docs/universe`. Idempotent — Quartz builds are deterministic for the same input, so a run with no `quartz/content/` change produces a byte-identical `docs/universe/`.

Wall-clock cost: ~30 s cold (npm install + bootstrap), ~15 s warm (just the build). Worth it on the weekly cadence; the alternative is a stale `/universe/` until the next manual run.

If the build fails (Quartz upstream API drift, npm registry hiccup, etc.), capture the stderr in the PR body's `**Universe build failed:**` section, do not abort the atlas regen, and skip the universe-related parts of step 3.

### 3. Diff against the prior run

Compare new `atlas.json` against `HEAD:atlas.json`. Compute:

- `new_forks` = repos in current.nodes but not in previous.nodes
- `archived_forks` = repos that flipped `archived: false → true`
- `dormant_now_active` = forks whose `pushedAt` advanced > 7 days
- `star_jumps` = forks whose `stars` increased by ≥ 3 since last run
- `new_high_overlap` = skill-overlap pairs (weight ≥ 0.5) that didn't exist last run

Build `verdict_one_line`:

- `new_forks.length > 0` → `${new_forks.length} new fork(s) (top: ${first.id})`
- `star_jumps.length > 0` → `${star_jumps[0].id} +${first.delta}★`
- `dormant_now_active.length > 0` → `${first.id} resumed activity after dormancy`
- otherwise → `atlas refreshed (${current.stats.repos}r / ${current.stats.totalStars}★)`

If `git diff --quiet atlas.json docs/atlas.{md,html}` reports no change, exit silently — no PR, no notify.

### 4. Open PR

```bash
git checkout -b atlas/${today} 2>/dev/null || git checkout atlas/${today}
git add atlas.json docs/atlas.md docs/atlas.html docs/atlas.json docs/innovations.md docs/disabled-defaults.md docs/ecosystem.md docs/skill-packs.md docs/operators.md docs/non-fork-users.md docs/whats-new.md docs/digest.md docs/digest/ docs/feed.xml history/ quartz/content/ docs/universe/
git commit -m "atlas: ${verdict_one_line}"
git push -u origin atlas/${today}
gh pr create --title "atlas: ${verdict_one_line}" --body "Weekly ecosystem refresh — ${current.stats.repos} repos, ${current.stats.forkEdges} fork edges, ${current.stats.skillEdges} skill-overlap edges, ${current.stats.totalStars} ★ across the fork network.

$( [ -n \"$new_forks\" ] && echo \"**New forks since last run:** $new_forks\" )
$( [ -n \"$star_jumps\" ] && echo \"**★ jumps:** $star_jumps\" )
$( [ -n \"$dormant_now_active\" ] && echo \"**Resumed activity:** $dormant_now_active\" )

Interactive map: \`docs/atlas.html\`. Digest: \`docs/atlas.md\`."
```

### 5. Notify

```bash
./notify "*Atlas updated* — ${verdict_one_line}. PR: ${pr_url}"
```

Skip the notify when `verdict_one_line` is the bland `atlas refreshed (…)` form and `new_forks`, `star_jumps`, and `dormant_now_active` are all empty — that's mechanical regeneration without operator-relevant signal.

## Sandbox note

`gh api` works inside the GitHub Actions runner with the default `GITHUB_TOKEN` (read-only on public repos is enough). For local dev, the operator's authenticated `gh` does the same. Falls back to `curl https://api.github.com` if `gh` is missing (degraded rate limit; usually fine for one run).

The script writes to `.atlas-cache/` to cache fork-list and contents-API responses for 24h — re-runs within the day are cheap.

## Exit modes

- `ATLAS_NO_CHANGE` — diff was empty, silent exit (the expected weekly path)
- `ATLAS_OK` — regenerated + PR opened, notify only when verdict is interesting
- `ATLAS_NEW_FORK` — at least one new fork detected; always notify
- `ATLAS_ERROR` — GitHub API failed or git op failed; notify with error and exit non-zero
