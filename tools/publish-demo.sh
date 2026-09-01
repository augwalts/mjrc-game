#!/usr/bin/env bash
# Publish the playable demo into the website's static folder.
#
#   ./tools/publish-demo.sh
#
# The game is a self-contained static folder — index.html plus three scripts —
# so the website needs no build integration at all: Astro passes `public/`
# through untouched, which is how /tiles is already served.
#
# The two repos are separate, so this copy is the seam. It is a script rather
# than a documented `cp` so it cannot be half-done, and it rebuilds first so
# what ships is never a stale bundle.
#
# NOT copied: pile-lab.html and call-lab.html (development tools) and the .md
# documents. They stay in mjrc-game.
#
# tile-engine.js IS copied, even though mjrc-app already serves an identical
# copy at /tiles/. Pointing the game at that absolute path would couple it to
# this one site's URL layout and break both the standalone server and the labs.
# 57 KB is cheaper than that coupling — but the check below fails loudly if the
# two ever diverge, which is the risk that mattered.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
app="$here/../mjrc-app/web"
src="$here/client/game"
dst="$app/public/game"

[ -d "$app" ] || { echo "mjrc-app not found beside mjrc-game at $app" >&2; exit 1; }

echo "building…"
"$app/node_modules/.bin/esbuild" "$src/game.ts" \
  --bundle --platform=browser --format=iife --outfile="$src/game.js" --log-level=warning

if ! diff -q "$src/tile-engine.js" "$app/public/tiles/tile-engine.js" >/dev/null; then
  echo "tile-engine.js has DIVERGED from the app's copy at public/tiles/." >&2
  echo "Reconcile them before publishing — the game and the scoring pages must" >&2
  echo "draw the same tiles." >&2
  exit 1
fi

mkdir -p "$dst"
for f in index.html game.js tile-engine.js bots.js; do
  cp "$src/$f" "$dst/$f"
  printf '  %-18s %6s KB\n' "$f" "$(( $(wc -c < "$dst/$f") / 1024 ))"
done

echo
echo "published to $dst"
echo "total: $(du -sh "$dst" | cut -f1)"
echo
echo "next: commit in mjrc-app, and make sure GAME_PASSWORD is set —"
echo "  wrangler pages secret put GAME_PASSWORD --project-name mjrc"
