---
name: Atlas Improve
description: Monthly self-improvement loop for the atlas — diffs recent atlas.json snapshots for surprises, picks one, proposes a minimal instrumentation/code change that would have surfaced it better, opens one capped PR
var: ""
tags: [meta, autoresearch]
---

Today is ${today}. Find one thing the atlas should have surfaced better in the last 30 days, propose a minimal change that fixes it, open a PR.

**Cap: at most one open `atlas-improve/*` PR at any time.** If one already exists, exit silently — don't pile up unreviewed improvement work. (Same discipline as `self-improve`.)

## Steps

### 1. Bail if there's an open improvement PR

```bash
OPEN=$(gh pr list --state open --search "head:atlas-improve/" --json number --jq 'length')
if [ "$OPEN" -gt 0 ]; then
  echo "atlas-improve: $OPEN open improvement PR(s), exiting silently"
  exit 0
fi
```

No notify, no further work. The operator hasn't acted on the previous proposal yet; a new one would just be noise.

### 2. Compute surprises from the last 30 days

The atlas weekly skill commits an updated `atlas.json` whenever something changed (silent on no-change). 30 days ≈ 4 weekly runs. Find the oldest atlas.json commit in that window and diff:

```bash
THIRTY_DAYS_AGO=$(git log --since="30 days ago" --format=%H -- atlas.json | tail -1)
if [ -z "$THIRTY_DAYS_AGO" ]; then
  echo "atlas-improve: not enough atlas.json history yet (need ≥ 1 commit older than today); exiting silently"
  exit 0
fi
node scripts/atlas-snapshot-diff.mjs --git "$THIRTY_DAYS_AGO" HEAD > /tmp/atlas-surprises.json
```

The output is a sorted `surprises` array. Each entry has `kind`, `magnitude`, fields specific to the kind, and a `why` line.

If the surprises array is empty, the atlas is stable — exit silently with `ATLAS_IMPROVE_NOTHING_TO_DO`. This is the expected outcome on a quiet month.

### 3. Pick one surprise

Take `surprises[0]` — the highest-magnitude one — as the seed. **Don't try to address multiple in one PR.** The whole point of capping at 1 open PR is that improvements have to be reviewed one at a time.

If the headline surprise's `kind` is one you've already addressed recently (check `memory/state/atlas-improve.json` for the last 6 months of seeds), drop to the next surprise. If all surprises were seeds before, exit silently.

### 4. Propose 2–3 candidate improvements

For the chosen surprise, brainstorm what specific change to the atlas would have **surfaced this earlier or more prominently**. Examples by surprise kind:

| Surprise kind | Candidate improvements |
|---|---|
| `star_jump` | (a) New "★ jumps" section in `docs/atlas.md`. (b) Notify when delta ≥ 5. (c) Color recently-trending forks distinctly in the Cytoscape view. |
| `dormant_active` | (a) "Resurrected" badge / section. (b) `dormancy_days` field on nodes so the universe view can render it. (c) Notify when ≥ 60d dormant fork resumes. |
| `new_pack` | (a) Auto-check whether pack skills overlap with novel-skills (creates new edge type). (b) Surface new packs in a `## This week's additions` section in skill-packs.md. |
| `novel_skill_spread` | (a) New `## Spreading novel skills` section in innovations.md. (b) Edge color in universe view scales with adoption count. (c) Notify when a novel skill crosses an adoption threshold (e.g. 5+ forks). |
| `ecosystem_match_drop` | (a) Add a test-fixture script that checks matcher recall against known-good pairs and fails CI on drop. (b) Log unmatched-but-near-match candidates to stderr for manual review. |
| `overlap_cluster_birth` | (a) "Notable new clusters this run" callout in atlas.md. (b) Edge thickness in atlas.html scales with weight. |
| `metric_drift` | (a) Per-metric trend chart in atlas.md showing last 6 weekly values. (b) Notify on any > 25% drift in `withCustomSkills` or `novelSkillsCount`. |
| `new_fork` | (a) Already in the digest; check if highest-promise new forks (high initial ★ or carrying novel skills) get a special call-out. |

**Score each candidate** on three axes (1–3 each):

1. **Signal**: does it actually make the surprise visible in the operator's normal review path (the auto-PR body, the Pages site, a notify), not just in raw JSON?
2. **Cost**: small (1) = ≤ 20 lines / one file. Medium (2) = ≤ 100 lines / two files. Large (3) = touches multiple subsystems.
3. **Falsifiability**: can the change be tested? Best (1) = byte-diff against a fixture. OK (2) = the surprise would now show up where it didn't before. Worst (3) = "trust me, this is better."

Pick the one with the **highest (signal / cost / falsifiability) ratio** — preferring small, falsifiable, signal-bearing changes.

### 5. Implement it

Make the change. Run `node scripts/atlas.mjs --cache` and the affected renderer. Verify the new surfacing actually surfaces the seed surprise in the rebuilt artifact (look for it in the file you just edited).

**Don't touch unrelated code.** No drive-by cleanups. Keep the diff minimal so the reviewer can decide on the merit of *this one change* in isolation.

Update `memory/state/atlas-improve.json`:

```json
{
  "history": [
    { "date": "${today}", "seed_kind": "...", "seed_summary": "...", "pr": "<url>", "candidate_picked": "<one-line>" },
    ...
  ]
}
```

Keep the last 12 entries (one per monthly run if every month produces a PR — most won't).

### 6. Open PR

```bash
git checkout -b atlas-improve/${today}
git add scripts/ docs/ skills/ memory/state/atlas-improve.json
git commit -m "atlas: ${candidate_one_line}"
git push -u origin atlas-improve/${today}
gh pr create --title "atlas: ${candidate_one_line}" --body "Auto-proposed by the \`atlas-improve\` skill on ${today}.

## Seed surprise
${surprise.kind} — ${surprise.why}

\`\`\`json
${JSON.stringify(surprise, null, 2)}
\`\`\`

## Why this change
${rationale — 2–3 sentences explaining the candidate over the alternatives}

## Falsifiability
${what to look at in the diff to confirm the surprise is now surfaced}

## Rollback
If this proposal isn't useful, close the PR and edit \`memory/state/atlas-improve.json\`'s last entry to add \`\"rejected\": true\` so the skill doesn't seed off this kind again for 6 months."
```

### 7. Notify

```bash
./notify "*atlas-improve* — ${candidate_one_line}. Review PR: ${pr_url}"
```

Always notify when a PR opens. Improvements are corpus mutations, not silent housekeeping.

## Spam prevention summary

- **One open PR cap** (step 1) — no piling up unreviewed proposals.
- **Seed deduplication** (step 3) — don't propose the same kind of fix twice in 6 months unless the operator rejected it.
- **Silent on no surprises** (step 2) — most months will exit silently if the atlas is stable.
- **One candidate per PR** (step 4) — even if multiple improvements look good, only the single highest-ratio one ships.

## Sandbox note

Pure local work. The skill calls `git log`, `node scripts/atlas-snapshot-diff.mjs`, and edits files in the repo. `gh pr create` handles its own auth. No outbound network needed beyond what `gh` already does.

## Exit modes

- `ATLAS_IMPROVE_CAPPED` — open PR already exists; silent exit
- `ATLAS_IMPROVE_NOTHING_TO_DO` — no surprises in the 30-day window; silent exit (expected on quiet months)
- `ATLAS_IMPROVE_RECYCLED` — all surprises are kinds we've already proposed for in the last 6 months; silent exit
- `ATLAS_IMPROVE_OK` — implemented + PR opened + notify sent
- `ATLAS_IMPROVE_ERROR` — diff or implementation failed; notify with error and exit non-zero
