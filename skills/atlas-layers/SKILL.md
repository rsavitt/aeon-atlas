---
name: Atlas Layers
description: Weekly seven-layer categorical view of the Aeon constellation — operator fork, fleet, skill packs, discovery infra, storefronts, audit, intake. Notifies only when new entrants land in a curated layer or in the unclassified candidate pool.
var: ""
tags: [meta, ecosystem]
---

Today is ${today}. Regenerate the categorical Atlas — the seven-layer functional view at `quartz/content/atlas-layers.md` — and notify only when an outsider's project lands in one of the layers or shows up unclassified for the first time.

**Skip notify and PR when no new entrants appeared.** Silence on a stable orbit is the expected weekly outcome. The same long tail of forks and packs is not news.

This skill consumes the outputs of the `atlas` skill (`atlas.json`) and the live `skill-packs.json`. Run order: `atlas` (Sunday 04:00) → `atlas-layers` (Sunday 05:00).

## Steps

### 1. Run the generator

```bash
node scripts/atlas-layers.mjs
```

The script reads `data/atlas-layers.json` (hand-curated layer assignments + per-layer copy), `atlas.json` (fork graph), and `skill-packs.json` (installable pack registry), then writes:

- `quartz/content/atlas-layers.md` — the rendered seven-layer page, picked up by the Quartz universe build

It prints a one-line summary like `atlas-layers: 7 layers · 8 hand entries · 31 forks · 16 packs · 2 ecosystem → quartz/content/atlas-layers.md`. Capture for the verdict.

The generator is deterministic for the same inputs. No GitHub API calls — all data is pre-fetched into `atlas.json` by the upstream `atlas` skill.

### 2. Diff against the prior run

Compare new `quartz/content/atlas-layers.md` against `HEAD:quartz/content/atlas-layers.md`. Compute:

- `new_hand_entries` = entries appearing under a curated layer (Layers 1, 4–7) that weren't there before — these are the *signal*, since they imply a hand promotion happened in `data/atlas-layers.json` since last week
- `new_packs` = entries newly appearing under Layer 3
- `new_fleet` = forks newly appearing under Layer 2
- `new_unclassified_ecosystem` = ecosystem projects newly listed under *Unclassified candidates* (these are candidate platform-layer entrants worth a human look)

Build `verdict_one_line`:

- `new_hand_entries.length > 0` → `${first.title} added to ${first.layer}`
- `new_unclassified_ecosystem.length > 0` → `${new_unclassified_ecosystem.length} new ecosystem candidate(s) (top: ${first.name})`
- `new_packs.length > 0` → `${new_packs.length} new pack(s) (top: ${first.repo})`
- `new_fleet.length > 0` and stars ≥ 1 → `${first.id} entered the fleet (★${first.stars})`
- otherwise → `atlas-layers refreshed (${counts.placed} entities placed)`

If `git diff --quiet quartz/content/atlas-layers.md` reports no change, exit silently — no PR, no notify.

### 3. Open PR

```bash
git checkout -b atlas-layers/${today} 2>/dev/null || git checkout atlas-layers/${today}
git add quartz/content/atlas-layers.md data/atlas-layers.json
git commit -m "atlas-layers: ${verdict_one_line}"
git push -u origin atlas-layers/${today}
gh pr create --title "atlas-layers: ${verdict_one_line}" --body "Weekly categorical Atlas refresh.

$( [ -n \"$new_hand_entries\" ] && echo \"**Promoted into curated layers:** $new_hand_entries\" )
$( [ -n \"$new_unclassified_ecosystem\" ] && echo \"**New unclassified ecosystem candidates** — review for layer assignment in \`data/atlas-layers.json\`: $new_unclassified_ecosystem\" )
$( [ -n \"$new_packs\" ] && echo \"**New skill packs (Layer 3):** $new_packs\" )
$( [ -n \"$new_fleet\" ] && echo \"**New active forks (Layer 2):** $new_fleet\" )

Page: \`quartz/content/atlas-layers.md\` (linked from universe index)."
```

### 4. Notify

```bash
./notify "*Atlas layers* — ${verdict_one_line}. PR: ${pr_url}"
```

Skip the notify when `verdict_one_line` is the bland `atlas-layers refreshed (…)` form *and* `new_hand_entries`, `new_unclassified_ecosystem`, `new_packs`, and `new_fleet` are all empty — that's mechanical regeneration without operator-relevant signal.

A **new unclassified ecosystem candidate** is the highest-priority signal of the four: it means a project showed up in the underlying `atlas.json` feed that no layer has claimed yet. That's exactly the moment to decide which layer it belongs in (or whether it implies a new layer Aeon doesn't have yet — the *blank spaces* in `data/atlas-layers.json`).

## Sandbox note

This skill makes no network calls. All inputs are local files written by upstream skills (`atlas` for `atlas.json`, hand edits for `data/atlas-layers.json`, the maintainer for `skill-packs.json`). The diff and PR open use `gh` and `git`, which work inside the GitHub Actions runner with the default `GITHUB_TOKEN`.

## Why this exists

Hermes Atlas, the community-maintained directory of tools around Nous Research's Hermes Agent, marked the moment that project became a platform: someone outside the kernel drew the map. This skill builds Aeon's equivalent, but inverts the direction — the maintainer seeds the seven-layer scaffold so outside contributors can see where their work lands, and the *unclassified candidates* section surfaces every entrant that no layer has claimed, week over week. The blank spaces section names categories Hermes has and Aeon doesn't yet, so the next outside-built layer is visible *as a gap* instead of having to be discovered after the fact.

## Exit modes

- `LAYERS_NO_CHANGE` — diff was empty, silent exit (expected weekly path)
- `LAYERS_OK` — regenerated + PR opened, notify only when verdict is interesting
- `LAYERS_NEW_CANDIDATE` — at least one new unclassified ecosystem candidate; always notify
- `LAYERS_ERROR` — generator failed or git op failed; notify with error and exit non-zero
