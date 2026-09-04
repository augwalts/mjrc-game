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
#
# deal-lab.html IS shipped, which reverses that rule for one file. The rule was
# written when the demo was copied into the WEBSITE's repo, where anything in
# public/ is world-readable; a development tool had no business there. This is
# now its own project behind a password gate that covers every path from the
# root, so the lab is a private review surface rather than published content —
# and being able to look at the opening animation from a phone is most of what
# it is for. The other two labs are one line away if they are wanted too.
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
for f in index.html game.js tile-engine.js bots.js deal-lab.html; do
  cp "$src/$f" "$dst/$f"
  printf '  %-18s %6s KB\n' "$f" "$(( $(wc -c < "$dst/$f") / 1024 ))"
done

echo
echo "deploy/ ready — $(du -sh "$dst" | cut -f1)"
echo "  npx wrangler pages deploy deploy --project-name mjrc-game"
