#!/usr/bin/env bash
# build-universe.sh — regenerate atlas data → emit Quartz markdown content →
# build Quartz → ship to docs/universe/ for GitHub Pages.
#
# Quartz upstream scaffold is gitignored (it's ~22 MB) and bootstrapped here
# from the official repo when missing. Only our config, content, and lockfiles
# are committed.
#
# Run from anywhere in the repo. Idempotent. Safe to commit the result.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

QUARTZ_DIR="$ROOT/quartz"
QUARTZ_UPSTREAM="https://github.com/jackyzha0/quartz.git"
QUARTZ_VERSION="${QUARTZ_VERSION:-v4.5.2}"  # pin for reproducibility

mkdir -p "$QUARTZ_DIR"

# Bootstrap: if the upstream scaffold isn't present, fetch it into a tmp
# clone and copy the gitignored pieces in. Preserves our config + content.
if [ ! -d "$QUARTZ_DIR/quartz" ]; then
  echo "→ bootstrapping Quartz scaffold (upstream $QUARTZ_VERSION)"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  git clone --quiet --depth 1 --branch "$QUARTZ_VERSION" "$QUARTZ_UPSTREAM" "$TMP/quartz" 2>&1 \
    || git clone --quiet --depth 1 "$QUARTZ_UPSTREAM" "$TMP/quartz"
  # Copy everything except things we own (content, our config, lockfiles).
  rsync -a \
    --exclude content/ \
    --exclude quartz.config.yaml \
    --exclude quartz.lock.json \
    --exclude package-lock.json \
    --exclude .git/ \
    --exclude node_modules/ \
    "$TMP/quartz/" "$QUARTZ_DIR/"
fi

# Install deps (cheap if node_modules is fresh)
cd "$QUARTZ_DIR"
if [ ! -d node_modules ]; then
  npm install --silent
fi

# Make sure our pinned plugin set is installed (idempotent)
npx --yes quartz plugin install --from-config 2>&1 | tail -3

cd "$ROOT"
# Refresh atlas data + emit per-entity markdown into quartz/content/
node scripts/atlas.mjs --cache

# Build with Quartz. Output ships to docs/universe/ so GitHub Pages serves it
# at /aeon-atlas/universe/ alongside the Jekyll-built top-level pages.
cd "$QUARTZ_DIR"
npx quartz build --output "$ROOT/docs/universe"

# Quartz emits a CNAME from baseUrl that would hijack the Pages domain — our
# baseUrl is project-pages-style (host + path), so the CNAME is wrong.
rm -f "$ROOT/docs/universe/CNAME"

echo ""
echo "✓ built → $ROOT/docs/universe/"
echo "  preview locally: cd quartz && npx quartz build --serve"
echo "  commit + push, then visit: https://rsavitt.github.io/aeon-atlas/universe/"
