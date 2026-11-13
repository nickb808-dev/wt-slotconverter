# wtslot Converter

An offline tool that turns wavetable WAVs (single-cycle frames, e.g. Serum/Surge tables
or 2048-sample transwaves) into Waldorf M 16-bit user wavetables:
`wtslot00.wav`–`wtslot31.wav`, 64 waves × 256 samples.

It is one HTML file that runs in your web browser with no internet connection. Nothing
is installed, nothing is uploaded, and the page cannot send data anywhere.

## Using it

1. Open `wtslot-converter-offline.html` in a current web browser (double-click it).
   Tested in Firefox; it uses only standard features every current browser has.
2. Drop in WAV files, or click **choose files**. Mono or stereo; 8/16/24/32-bit or float.
3. Check the frame size. **Auto** reads the tag in Serum and Surge tables and otherwise
   assumes 2048 samples per frame. A "samples left over" warning means it's probably wrong.
4. Give each table a slot (00–31), then **Download** each one or **Download all (.zip)**.

### Loading them on the M

1. Copy the `wtslotNN.wav` files to the **root** of the M's SD card.
2. On the M, set **UWT Slot** to the file's number and **Skip** to **1**.
3. In the SD Card utility, run **Import 16bit User WT (from SD)**. Repeat for each slot.

**Check the slot number first.** On firmware 1.11, importing a slot that has no matching
file on the card freezes the M until it is power-cycled.

## Privacy and security

- The tool runs entirely on your computer. It has no server, account, analytics or
  third-party code, and needs no network.
- Its Content-Security-Policy allows only the page's own built-in script and stylesheet
  (pinned by SHA-256 hash) and blocks every network request (`connect-src 'none'`), so
  even a bug or a malicious WAV could not send data out.
- WAV parsing is bounds-checked and capped at 128 MB per file. A malformed file only
  shows an error on its own row.

## How the conversion works

The file is split into frames at the frame size. 64 positions are spread evenly across
the frames, blending neighbouring frames where a position falls between two, so short
tables are interpolated and long ones thinned out. Each wave is resampled to 256 samples
from its harmonics 1–127 (no aliasing; DC removed), and the whole table is normalized to
−0.3 dBFS so the waves keep their relative levels.

The output always uses a plain 44-byte WAV header, because the M (host FW 1.11) reads
the audio from byte 44 without parsing the header. Output matches
`waldorf-m-fw/tools/fizmo_to_uwt.py` sample for sample.

## Maintaining it

The source is three files; `wtslot-converter-offline.html` is built from them.

- `index.html`, `style.css`, `app.js` — the page, with no dependencies
- `build-offline.py` — inlines the CSS and JS into the single file and pins them in the
  Content-Security-Policy by SHA-256 hash (browsers disagree about `'self'` for pages
  opened from disk, so the source files' policy can't be used as is)

After changing any source file, rebuild and commit the result:

```bash
python3 build-offline.py
```

To try the source files directly, serve the folder locally and open
http://127.0.0.1:8765/:

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

Only distribute `wtslot-converter-offline.html`. Don't bundle wavetables with it; users
bring their own.
