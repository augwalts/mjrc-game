#!/usr/bin/env bash
# Build the gamepvp client into gamepvp/assets/, the Worker's static assets.
#
#   ./gamepvp/build.sh
#   cd gamepvp && npx wrangler dev --port 8787
#
# Source is ../client/gamepvp (a copy of Solo's client being retrofitted to the
# wire). Same shape as tools/publish-demo.sh: esbuild on game.ts, copy the rest.
# assets/ is a build product and is gitignored.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
src="$here/client/gamepvp"
dst="$here/gamepvp/assets"
esbuild="$here/node_modules/.bin/esbuild"
[ -x "$esbuild" ] || esbuild="$here/../mjrc-app/web/node_modules/.bin/esbuild"
[ -x "$esbuild" ] || { echo "esbuild not found" >&2; exit 1; }

echo "building…"
"$esbuild" "$src/game.ts" --bundle --platform=browser --format=iife \
  --outfile="$dst/game.js" --log-level=warning

for f in index.html tile-engine.js bots.js; do
  cp "$src/$f" "$dst/$f"
done
rm -rf "$dst/assets"
cp -R "$src/assets" "$dst/assets"

printf '  %-14s %6s KB\n' game.js "$(( $(wc -c < "$dst/game.js") / 1024 ))"
echo "assets/ ready — $(du -sh "$dst" | cut -f1)"
