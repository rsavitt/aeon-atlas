#!/usr/bin/env node
// ecosystem-from-issue.mjs — parse a GitHub Issue Forms body, validate, and
// append a row to ECOSYSTEM.local.md.
//
// Invoked by .github/workflows/ecosystem-from-issue.yml on issues labeled
// `ecosystem`. Reads the issue body from $ISSUE_BODY (workflow env), writes
// the updated file in place, and prints a short summary to stdout that the
// workflow uses for the PR body.
//
// Exits 0 on success (file changed), 78 (EX_TEMPFAIL) on validation failure
// — the workflow surfaces that as a comment on the issue and doesn't open a
// PR. Any other non-zero exit is an unexpected bug.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_PATH = resolve(ROOT, "ECOSYSTEM.local.md");

const VALIDATION_FAIL = 78;

function fail(msg) {
  // Single line, prefixed — the workflow surfaces this as the issue comment.
  console.error(`VALIDATION_FAIL: ${msg}`);
  process.exit(VALIDATION_FAIL);
}

function bug(msg) {
  console.error(`UNEXPECTED: ${msg}`);
  process.exit(1);
}

// GitHub Issue Forms render submitted values as ATX headers followed by the
// value, separated by blank lines:
//
//   ### Project name
//
//   Sparkleware
//
//   ### GitHub repo URL
//
//   https://github.com/sparkleware/sparkleware
//
// Optional fields the user left blank come through as "_No response_".
function parseIssueBody(body) {
  const fields = {};
  const blocks = body.split(/\r?\n###\s+/);
  // First block precedes any header; skip if no leading "### " was present.
  const start = body.startsWith("###") ? 0 : 1;
  for (let i = start; i < blocks.length; i++) {
    const block = blocks[i].replace(/^###\s+/, "");
    const nl = block.indexOf("\n");
    if (nl < 0) continue;
    const label = block.slice(0, nl).trim().toLowerCase();
    const value = block.slice(nl).trim();
    if (value === "_No response_" || value === "") continue;
    fields[label] = value;
  }
  return fields;
}

function normalizeGithubUrl(raw) {
  // Accept https://github.com/owner/repo and trailing slash / .git suffix.
  const m = raw.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s.]+)(?:\.git)?\/?$/i);
  if (!m) return null;
  return `https://github.com/${m[1]}/${m[2]}`;
}

function normalizeXHandle(raw) {
  if (!raw) return null;
  const m = raw.match(/^@?([A-Za-z0-9_]{1,15})$/);
  return m ? m[1] : null;
}

function normalizeOtherUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.toString().replace(/\/$/, "");
  } catch { return null; }
}

function escapeTableCell(s) {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function parseLocalTable(md) {
  // Mirror of parseEcosystemMd() in atlas.mjs — keep the dedupe logic in sync.
  const lines = md.split("\n");
  const start = lines.findIndex((l) => /^\|\s*Project\s*\|\s*Links\s*\|/.test(l));
  if (start < 0) return { headerIdx: -1, names: new Set() };
  const names = new Set();
  for (let i = start + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("|")) break;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (!cells[0] || /^-+$/.test(cells[0])) continue;
    names.add(cells[0].replace(/^\*\*|\*\*$/g, "").trim().toLowerCase());
  }
  return { headerIdx: start, names };
}

function buildLinksCell({ githubUrl, xHandle, otherUrl }) {
  const parts = [`[github](${githubUrl})`];
  if (otherUrl) parts.push(`[${new URL(otherUrl).host}](${otherUrl})`);
  if (xHandle) parts.push(`[@${xHandle}](https://x.com/${xHandle})`);
  return parts.join(" · ");
}

function main() {
  const body = process.env.ISSUE_BODY || "";
  if (!body.trim()) fail("Issue body is empty — were you using the form template?");

  const fields = parseIssueBody(body);
  const name = (fields["project name"] || "").trim();
  if (!name) fail("Missing required field: Project name.");
  if (name.length > 80) fail("Project name is too long (max 80 chars).");

  const rawGithub = fields["github repo url"] || "";
  const githubUrl = normalizeGithubUrl(rawGithub);
  if (!githubUrl) fail(`GitHub repo URL is not a valid github.com/owner/repo URL: \`${rawGithub}\``);

  const xHandle = normalizeXHandle(fields["x / twitter handle (optional)"]);
  if (fields["x / twitter handle (optional)"] && !xHandle) {
    fail(`X handle isn't valid (1–15 chars, letters/digits/underscore only): \`${fields["x / twitter handle (optional)"]}\``);
  }

  const rawOther = fields["other link (optional)"];
  const otherUrl = rawOther ? normalizeOtherUrl(rawOther) : null;
  if (rawOther && !otherUrl) fail(`Other link isn't a valid http(s) URL: \`${rawOther}\``);

  const description = (fields["one-line description (optional)"] || "").trim();

  // De-dupe vs current ECOSYSTEM.local.md.
  let local;
  try { local = readFileSync(LOCAL_PATH, "utf8"); } catch { bug(`Cannot read ${LOCAL_PATH}`); }
  const { headerIdx, names } = parseLocalTable(local);
  if (headerIdx < 0) bug("ECOSYSTEM.local.md has no `| Project | Links |` table header.");
  if (names.has(name.toLowerCase())) fail(`\`${name}\` already exists in ECOSYSTEM.local.md — nothing to do.`);

  const linksCell = buildLinksCell({ githubUrl, xHandle, otherUrl });
  const nameCell = escapeTableCell(name);
  const newRow = `| ${nameCell} | ${linksCell} |`;

  // Append the row to the END of the table (after the last row that starts
  // with "|"). Splitting by lines keeps any trailing prose/headers intact.
  const lines = local.split("\n");
  let lastRow = headerIdx + 1;
  for (let i = headerIdx + 2; i < lines.length; i++) {
    if (lines[i].startsWith("|")) lastRow = i;
    else break;
  }
  lines.splice(lastRow + 1, 0, newRow);
  writeFileSync(LOCAL_PATH, lines.join("\n"));

  // Structured stdout — workflow parses these for PR title + body.
  console.log(`ADDED_NAME: ${name}`);
  console.log(`ADDED_ROW: ${newRow}`);
  console.log(`GITHUB_URL: ${githubUrl}`);
  if (xHandle) console.log(`X_HANDLE: ${xHandle}`);
  if (otherUrl) console.log(`OTHER_URL: ${otherUrl}`);
  if (description) console.log(`DESCRIPTION: ${description}`);
}

main();
