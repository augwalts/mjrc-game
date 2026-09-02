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

# playtest.html is the local playability harness (client/gamepvp/) — two
# panes of this same client, phone and desktop, in one match, driven
# hands-free. A plain static file with no build step of its own; the
# autopilot it drives, playtest.ts, is imported by game.ts and so is already
# inside game.js above.
for f in index.html tile-engine.js bots.js playtest.html; do
  cp "$src/$f" "$dst/$f"
done
rm -rf "$dst/assets"
cp -R "$src/assets" "$dst/assets"

# shell/theme.css — the only shell/ file that isn't bundled by esbuild (it's
# a stylesheet, loaded via <link>, not imported by any .ts). Every shell/*.ts
# module IS bundled into game.js already (game.ts imports both table.ts and
# shell/router.ts directly; router.ts pulls in the rest of shell/), so this
# is the one extra copy needed.
mkdir -p "$dst/shell"
cp "$src/shell/theme.css" "$dst/shell/theme.css"

printf '  %-14s %6s KB\n' game.js "$(( $(wc -c < "$dst/game.js") / 1024 ))"
echo "assets/ ready — $(du -sh "$dst" | cut -f1)"
