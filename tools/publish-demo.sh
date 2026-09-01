#!/usr/bin/env bash
# Build the playable demo into deploy/, ready for Cloudflare Pages.
#
#   ./tools/publish-demo.sh
#   npx wrangler pages deploy deploy --project-name mjrc-game
#
# The game is a self-contained static folder — index.html plus three scripts —
# so there is no bundler beyond esbuild on game.ts. `functions/` is picked up
# from the repo root by wrangler and is NOT copied here.
#
# NOT shipped: pile-lab.html and call-lab.html (development tools) and the .md
# documents. They stay in client/game.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
src="$here/client/game"
dst="$here/deploy"
esbuild="$here/../mjrc-app/web/node_modules/.bin/esbuild"

[ -x "$esbuild" ] || { echo "esbuild not found at $esbuild" >&2; exit 1; }

echo "building…"
"$esbuild" "$src/game.ts" --bundle --platform=browser --format=iife \
  --outfile="$src/game.js" --log-level=warning

# The tile art must match the website's, or the game and the scoring pages draw
# different tiles. They are byte-identical today; fail loudly if that changes.
app_tiles="$here/../mjrc-app/web/public/tiles/tile-engine.js"
if [ -f "$app_tiles" ] && ! diff -q "$src/tile-engine.js" "$app_tiles" >/dev/null; then
  echo "tile-engine.js has DIVERGED from the website's copy — reconcile first." >&2
  exit 1
fi

rm -rf "$dst"
mkdir -p "$dst"
for f in index.html game.js tile-engine.js bots.js; do
  cp "$src/$f" "$dst/$f"
  printf '  %-18s %6s KB\n' "$f" "$(( $(wc -c < "$dst/$f") / 1024 ))"
done

echo
echo "deploy/ ready — $(du -sh "$dst" | cut -f1)"
echo "  npx wrangler pages deploy deploy --project-name mjrc-game"
