HEARTBEAT_OK · STATUS_PAGE=DEGRADED

## Summary

Ran the heartbeat skill for 2026-06-08 15:19 UTC (Monday). All P0–P3 checks executed against `cron-state.json`, open PRs/issues, and `aeon.yml`.

**Findings (all standing, already notified within 48h → no new notification):**
- **P0** — `heartbeat` trips the chronic threshold (success_rate 15%, 5/34) but it's the known **ISS-001** recorder misclassification: `last_status=success`, `consecutive_failures=0`, last success 2026-06-07 20:55 UTC (self-check <36h, OK). `atlas-layers` healthy. No failed or stuck skills.
- **P1** — PR #10 still open (~49h, stalled); STALLED-notified 2026-06-07. No urgent issues.
- **P2** — none.
- **P3** — `atlas` still missing its Sunday 04:00 slot (no cron-state entry); P3-notified 2026-06-07.

Every flag was already announced inside the 48h dedup window, so no `./notify` was sent (same posture as yesterday's 20:55 run).

**Files modified:**
- `docs/status.md` — regenerated, Overall 🔴 DEGRADED, Updated 2026-06-08 15:19 UTC, next run heartbeat 20:00 UTC, 1 open issue (Token pulse section omitted — no `articles/token-report-*.md`).
- `memory/logs/2026-06-08.md` — created with this run's log entry.

**Follow-ups (operator-owned, unchanged):** merge PR #10 to refresh the public atlas-layers page; investigate why `atlas` never dispatched its Sunday slot; resolve ISS-001 (heartbeat success/fail recorder misclassification).
