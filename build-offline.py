#!/usr/bin/env python3
"""Bundle index.html + style.css + app.js into one self-contained HTML file
that works when opened straight from disk (file://).

The CSP allows the inlined style and script by SHA-256 hash instead of 'self',
because browsers disagree on what 'self' means for local files.

Usage: python3 build-offline.py [out.html]   (default: wtslot-converter-offline.html)
"""
import base64
import hashlib
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
read = lambda name: open(os.path.join(here, name), encoding='utf-8').read()
sha = lambda s: "'sha256-" + base64.b64encode(hashlib.sha256(s.encode('utf-8')).digest()).decode() + "'"

html, css, js = read('index.html'), read('style.css'), read('app.js')
style = '\n' + css
script = '\n' + js

old_csp = ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; "
           "connect-src 'none'; form-action 'none'; base-uri 'none'")
new_csp = (f"default-src 'none'; script-src {sha(script)}; style-src {sha(style)}; img-src data: blob:; "
           "connect-src 'none'; form-action 'none'; base-uri 'none'")
for old, new in [(old_csp, new_csp),
                 ('<link rel="stylesheet" href="style.css">', f'<style>{style}</style>'),
                 ('<script src="app.js"></script>', f'<script>{script}</script>')]:
    assert html.count(old) == 1, f'expected exactly one: {old[:40]}'
    html = html.replace(old, new)

out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, 'wtslot-converter-offline.html')
open(out, 'w', encoding='utf-8').write(html)
print(f'wrote {out} ({len(html) // 1024} KB)')
