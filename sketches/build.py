#!/usr/bin/env python3
"""Inline tiles.gen.js + engine.js + ui.js into one portable HTML file.
Sources stay separate for editing; the built file is what you open.
  python3 build.py   ->  mjrc-game-sketches.html
"""
import pathlib, re
d = pathlib.Path(__file__).parent
html = (d / "index.html").read_text()
for src in ("tiles.gen.js", "engine.js", "ui.js"):
    js = (d / src).read_text()
    html = html.replace(
        '<script src="%s"></script>' % src,
        "<script>/* ---- %s ---- */\n%s\n</script>" % (src, js))
out = d / "mjrc-game-sketches.html"
out.write_text(html)
print("built %s  (%.0f KB)" % (out, out.stat().st_size / 1024))
