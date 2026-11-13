# wtslot Converter

A static web page that turns wavetable WAVs (single-cycle frames, e.g. Serum/Surge
tables or 2048-sample transwaves) into Waldorf M 16-bit user wavetables:
`wtslot00.wav`–`wtslot31.wav`, 64 waves × 256 samples, plain 44-byte WAV header.

Everything runs in the visitor's browser. There is no server code and no upload.

## Files

- `index.html`, `style.css`, `app.js` — the whole site, no dependencies or build step
- `_headers` — security headers for Cloudflare Pages / Netlify (GitHub Pages ignores it;
  the same CSP is also set in a `<meta>` tag)

## Offline copy to share

```bash
python3 build-offline.py
```

writes `wtslot-converter-offline.html`: one self-contained file that runs when opened
straight from disk. Its CSP allows the inlined style and script by SHA-256 hash rather
than `'self'`, which browsers handle inconsistently for `file://` pages. Rebuild it
after any change to the three source files.

## Run locally

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

then open http://127.0.0.1:8765/.

## Security model

- No backend: there is nothing on the server to attack beyond the static host itself.
- The Content-Security-Policy allows only this site's own script and stylesheet, and
  `connect-src 'none'` stops the page from sending anything anywhere, even if a bug
  or a hostile WAV tried to.
- WAV parsing is bounds-checked and capped at 128 MB per file; a malformed file only
  produces an error on that row, in the visitor's own tab.
- No third-party fonts, analytics or CDNs, so visitors aren't tracked.

## Conversion

Frames are split at the frame size (Auto reads Serum `clm ` / Surge `srge` tags, else
2048), 64 positions are spread evenly across them with linear blending between
neighbours, and each wave is resampled to 256 samples keeping harmonics 1–127 (DC
removed). The table is normalized to −0.3 dBFS. Output matches
`waldorf-m-fw/tools/fizmo_to_uwt.py` sample for sample.

The M (host FW 1.11) reads the file from byte 44 without parsing the header, and a
missing `wtslotNN.wav` on import hangs the unit until power-cycled.
