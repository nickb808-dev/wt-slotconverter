'use strict';

// Waldorf M (host FW 1.11) "Import 16bit User WT (from SD)" reads wtslotNN.wav
// blindly from byte 44: 64 waves x 256 int16, wave i at sample i*256*Skip.
const WAVES = 64;
const WAVE_LEN = 256;
const SLOTS = 32;
const PEAK = 32767 * Math.pow(10, -0.3 / 20);
const DEFAULT_FRAME = 2048;
const MAX_BYTES = 128 * 1024 * 1024;

// ---------- WAV reading ----------

function fourcc(v, o) {
  return String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
}

// Returns { samples: Float64Array (mono), rate, frameHint|null }. Throws Error with a readable message.
function parseWav(buf) {
  const v = new DataView(buf);
  if (buf.byteLength < 12 || fourcc(v, 0) !== 'RIFF' || fourcc(v, 8) !== 'WAVE') {
    throw new Error('Not a WAV file (no RIFF/WAVE header).');
  }
  let fmt = null, data = null, frameHint = null;
  let o = 12;
  while (o + 8 <= buf.byteLength) {
    const id = fourcc(v, o);
    const size = v.getUint32(o + 4, true);
    const body = o + 8;
    const end = Math.min(body + size, buf.byteLength);
    if (id === 'fmt ' && end - body >= 16) {
      let tag = v.getUint16(body, true);
      const bits = v.getUint16(body + 14, true);
      if (tag === 0xFFFE && end - body >= 26) tag = v.getUint16(body + 24, true);
      fmt = { tag, channels: v.getUint16(body + 2, true), rate: v.getUint32(body + 4, true),
              align: v.getUint16(body + 12, true), bits };
    } else if (id === 'data') {
      data = { off: body, len: end - body };
    } else if (id === 'clm ') {
      // Serum: "<!>2048 ..."
      let s = '';
      for (let i = body; i < Math.min(end, body + 32); i++) s += String.fromCharCode(v.getUint8(i));
      const m = /<!>\s*(\d+)/.exec(s);
      if (m) frameHint = parseInt(m[1], 10);
    } else if (id === 'srge' && end - body >= 8) {
      frameHint = v.getUint32(body + 4, true); // Surge: version, frame size
    }
    o = body + size + (size & 1);
  }
  if (!fmt) throw new Error('WAV has no fmt chunk.');
  if (!data) throw new Error('WAV has no audio data.');
  const { tag, channels, bits } = fmt;
  const bytes = bits / 8;
  if (channels < 1 || !Number.isInteger(bytes) || bytes < 1) throw new Error('Unsupported WAV layout.');
  const align = fmt.align || channels * bytes;
  const n = Math.floor(data.len / align);
  let read;
  if (tag === 1 && bits === 8) read = (p) => v.getUint8(p) - 128;
  else if (tag === 1 && bits === 16) read = (p) => v.getInt16(p, true);
  else if (tag === 1 && bits === 24) read = (p) => ((v.getUint8(p + 2) << 24) | (v.getUint8(p + 1) << 16) | (v.getUint8(p) << 8)) >> 8;
  else if (tag === 1 && bits === 32) read = (p) => v.getInt32(p, true);
  else if (tag === 3 && bits === 32) read = (p) => v.getFloat32(p, true);
  else if (tag === 3 && bits === 64) read = (p) => v.getFloat64(p, true);
  else throw new Error(`Unsupported sample format (${tag === 3 ? 'float' : 'PCM'} ${bits}-bit).`);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const base = data.off + i * align;
    let s = 0;
    for (let c = 0; c < channels; c++) s += read(base + c * bytes);
    out[i] = s / channels;
  }
  return { samples: out, rate: fmt.rate, frameHint: frameHint && frameHint >= 16 ? frameHint : null };
}

// ---------- conversion ----------

// numpy rounds half to even; match it so output equals the reference script.
function roundHalfEven(x) {
  const r = Math.round(x);
  return (Math.abs(x % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r;
}

// samples: Float64Array, frame: samples per cycle. Returns { waves: Int16Array(64*256), frames, leftover }.
function convert(samples, frame) {
  const F = frame;
  const n = Math.floor(samples.length / F);
  if (n < 1) throw new Error(`File is shorter than one ${F}-sample frame.`);
  const H = Math.min(WAVE_LEN / 2 - 1, Math.ceil(F / 2) - 1);
  const cosF = new Float64Array(F), sinF = new Float64Array(F);
  for (let i = 0; i < F; i++) { cosF[i] = Math.cos(2 * Math.PI * i / F); sinF[i] = Math.sin(2 * Math.PI * i / F); }

  const specCache = new Map();
  const spectrum = (fi) => {
    let s = specCache.get(fi);
    if (s) return s;
    const re = new Float64Array(H + 1), im = new Float64Array(H + 1);
    const off = fi * F;
    for (let k = 1; k <= H; k++) {
      let a = 0, b = 0, idx = 0;
      for (let m = 0; m < F; m++) {
        const x = samples[off + m];
        a += x * cosF[idx]; b -= x * sinF[idx];
        idx += k; if (idx >= F) idx -= F;
      }
      re[k] = a; im[k] = b;
    }
    s = { re, im };
    specCache.set(fi, s);
    return s;
  };

  const cosW = new Float64Array(WAVE_LEN), sinW = new Float64Array(WAVE_LEN);
  for (let i = 0; i < WAVE_LEN; i++) { cosW[i] = Math.cos(2 * Math.PI * i / WAVE_LEN); sinW[i] = Math.sin(2 * Math.PI * i / WAVE_LEN); }

  const out = new Float64Array(WAVES * WAVE_LEN);
  let peak = 0;
  for (let w = 0; w < WAVES; w++) {
    const pos = n === 1 ? 0 : w * (n - 1) / (WAVES - 1);
    const lo = Math.floor(pos), hi = Math.min(lo + 1, n - 1), t = pos - lo;
    const A = spectrum(lo), B = spectrum(hi);
    for (let i = 0; i < WAVE_LEN; i++) {
      let y = 0, idx = 0;
      for (let k = 1; k <= H; k++) {
        idx += i; if (idx >= WAVE_LEN) idx -= WAVE_LEN;
        const re = A.re[k] * (1 - t) + B.re[k] * t;
        const im = A.im[k] * (1 - t) + B.im[k] * t;
        y += re * cosW[idx] - im * sinW[idx];
      }
      y *= 2 / F;
      out[w * WAVE_LEN + i] = y;
      if (Math.abs(y) > peak) peak = Math.abs(y);
    }
  }
  const waves = new Int16Array(WAVES * WAVE_LEN);
  const g = peak > 0 ? PEAK / peak : 0;
  for (let i = 0; i < waves.length; i++) waves[i] = roundHalfEven(out[i] * g);
  return { waves, frames: n, leftover: samples.length - n * F };
}

// ---------- WAV / ZIP writing ----------

function wavBytes(int16, rate = 44100) {
  const dataLen = int16.length * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const put = (o, s) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  put(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); put(8, 'WAVE');
  put(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  put(36, 'data'); v.setUint32(40, dataLen, true);
  for (let i = 0; i < int16.length; i++) v.setInt16(44 + 2 * i, int16[i], true);
  return new Uint8Array(buf);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// Store-only zip of [{ name, data: Uint8Array }]
function zipBytes(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  const DOS_TIME = 0, DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, DOS_TIME, true); lh.setUint16(12, DOS_DATE, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0, true);
    ch.setUint16(10, 0, true); ch.setUint16(12, DOS_TIME, true); ch.setUint16(14, DOS_DATE, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true); ch.setUint32(24, size, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((a, p) => a + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

if (typeof module !== 'undefined') module.exports = { parseWav, convert, wavBytes, zipBytes, crc32 };

// ---------- UI ----------

if (typeof document !== 'undefined') (() => {
  const $ = (id) => document.getElementById(id);
  const list = $('tables'), status = $('status'), frameSel = $('frame');
  let tables = []; // { id, name, samples, rate, frameHint, example, slot, result, error }
  let nextId = 1;

  const slotName = (s) => `wtslot${String(s).padStart(2, '0')}.wav`;
  const say = (msg, err = false) => { status.textContent = msg; status.classList.toggle('err', err); };

  function frameFor(t) {
    const v = frameSel.value;
    return v === 'auto' ? (t.frameHint || DEFAULT_FRAME) : parseInt(v, 10);
  }

  function process(t) {
    t.error = null; t.result = null;
    try { t.result = convert(t.samples, frameFor(t)); } catch (e) { t.error = e.message; }
  }
  function freeSlot() {
    const used = new Set(tables.map((t) => t.slot));
    for (let s = 0; s < SLOTS; s++) if (!used.has(s)) return s;
    return -1;
  }

  function draw(canvas, waves) {
    const css = getComputedStyle(document.documentElement);
    const bg = css.getPropertyValue('--lcd').trim(), fg = css.getPropertyValue('--lcd-wave').trim();
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth || 168, Hh = canvas.clientHeight || 84;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(Hh * dpr);
    const c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = bg; c.fillRect(0, 0, W, Hh);
    if (!waves) return;
    // waterfall: wave 63 at the back (up-right), wave 0 in front
    const dx = W * 0.22, dy = Hh * 0.42, ww = W - dx - 8, amp = (Hh - dy) * 0.38;
    for (let w = WAVES - 1; w >= 0; w -= 3) {
      const f = w / (WAVES - 1), ox = 4 + dx * f, oy = Hh - amp - 6 - dy * f;
      c.beginPath();
      for (let i = 0; i < WAVE_LEN; i++) {
        const x = ox + ww * i / (WAVE_LEN - 1), y = oy - amp * waves[w * WAVE_LEN + i] / 32768;
        i ? c.lineTo(x, y) : c.moveTo(x, y);
      }
      c.lineTo(ox + ww, oy + amp + 2); c.lineTo(ox, oy + amp + 2); c.closePath();
      c.fillStyle = bg; c.fill();
      c.beginPath();
      for (let i = 0; i < WAVE_LEN; i++) {
        const x = ox + ww * i / (WAVE_LEN - 1), y = oy - amp * waves[w * WAVE_LEN + i] / 32768;
        i ? c.lineTo(x, y) : c.moveTo(x, y);
      }
      c.globalAlpha = 0.35 + 0.65 * (1 - f); c.strokeStyle = fg; c.lineWidth = 1; c.stroke(); c.globalAlpha = 1;
    }
  }

  function save(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function render() {
    list.replaceChildren();
    const counts = new Map();
    for (const t of tables) if (t.slot >= 0) counts.set(t.slot, (counts.get(t.slot) || 0) + 1);
    for (const t of tables) {
      const li = el('li', 'row');
      const cv = el('canvas');
      cv.setAttribute('aria-label', `Preview of ${t.name}`);
      const meta = el('div', 'meta');
      meta.append(el('div', 'name', t.name));
      const chips = el('div', 'chips');
      if (t.example) chips.append(el('span', 'chip ex', 'Example, generated'));
      if (t.error) {
        meta.append(el('div', 'info', '—'));
        chips.append(el('span', 'chip warn', t.error));
      } else {
        const r = t.result, F = frameFor(t);
        meta.append(el('div', 'info', `${r.frames} frames × ${F} → 64 × 256` + (t.rate ? ` · ${(t.rate / 1000).toFixed(1)} kHz` : '')));
        if (r.frames < WAVES) chips.append(el('span', 'chip', `${r.frames} frames, blended up to 64`));
        if (r.leftover) chips.append(el('span', 'chip warn', `${r.leftover} samples left over: check frame size`));
      }
      if (t.slot >= 0 && counts.get(t.slot) > 1) chips.append(el('span', 'chip warn', 'Slot used twice'));
      if (chips.childElementCount) meta.append(chips);

      const ctrl = el('div', 'ctrl');
      const selId = `slot-${t.id}`;
      const lab = el('label', null, 'Slot'); lab.htmlFor = selId;
      const sel = el('select'); sel.id = selId;
      sel.append(new Option('none', '-1'));
      for (let s = 0; s < SLOTS; s++) sel.append(new Option(String(s).padStart(2, '0'), String(s)));
      sel.value = String(t.slot);
      sel.addEventListener('change', () => { t.slot = parseInt(sel.value, 10); render(); });
      const slotWrap = el('div', 'slotsel'); slotWrap.append(lab, sel);
      const btns = el('div', 'btns');
      const dl = el('button', 'small', 'Download'); dl.type = 'button';
      dl.disabled = !t.result;
      dl.title = t.slot >= 0 ? slotName(t.slot) : `${t.name}.wav`;
      dl.addEventListener('click', () => save(t.slot >= 0 ? slotName(t.slot) : `${t.name}.wav`, new Blob([wavBytes(t.result.waves)], { type: 'audio/wav' })));
      const rm = el('button', 'small', 'Remove'); rm.type = 'button';
      rm.addEventListener('click', () => { tables = tables.filter((x) => x !== t); render(); });
      btns.append(dl, rm);
      ctrl.append(slotWrap, btns);

      li.append(cv, meta, ctrl);
      list.append(li);
      draw(cv, t.result && t.result.waves);
    }
    const ready = tables.filter((t) => t.result && t.slot >= 0);
    const dup = [...counts.values()].some((c) => c > 1);
    $('zip').disabled = !ready.length || dup;
    $('clear').disabled = !tables.length;
    if (dup) say('Two tables share a slot. Give each a different slot to download the zip.', true);
    else if (!tables.length) say('No tables yet. Add some WAV files above.');
    else say(`${ready.length} of ${tables.length} table${tables.length === 1 ? '' : 's'} assigned to slots.`);
  }

  async function addFiles(files) {
    if (tables.length && tables.every((t) => t.example)) tables = [];
    const errors = [];
    for (const f of files) {
      if (!/\.wav$/i.test(f.name)) { errors.push(`${f.name}: not a .wav file`); continue; }
      if (f.size > MAX_BYTES) { errors.push(`${f.name}: larger than 128 MB`); continue; }
      say(`Converting ${f.name}…`);
      await new Promise((r) => setTimeout(r, 0));
      const t = { id: nextId++, name: f.name.replace(/\.wav$/i, ''), slot: freeSlot() };
      try {
        const w = parseWav(await f.arrayBuffer());
        Object.assign(t, { samples: w.samples, rate: w.rate, frameHint: w.frameHint });
        process(t);
      } catch (e) { t.error = e.message; }
      if (t.error) t.slot = -1;
      tables.push(t);
    }
    render();
    if (errors.length) say(errors.join(' · '), true);
  }

  function exampleTable() {
    // 32 frames of a pulse whose width sweeps from 50% to 5%, as a stand-in until files are added
    const F = 2048, N = 32, s = new Float64Array(F * N);
    for (let f = 0; f < N; f++) {
      const pw = 0.5 - 0.45 * f / (N - 1);
      for (let i = 0; i < F; i++) s[f * F + i] = (i / F < pw ? 1 : -1) * 20000;
    }
    const t = { id: nextId++, name: 'PWM sweep', samples: s, rate: 44100, frameHint: null, example: true, slot: 0 };
    process(t);
    return t;
  }

  const drop = $('drop'), input = $('file');
  $('pick').addEventListener('click', (e) => { e.stopPropagation(); input.click(); });
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => { addFiles([...input.files]); input.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => addFiles([...e.dataTransfer.files]));
  // keep stray drops elsewhere from navigating away to the file
  ['dragover', 'drop'].forEach((ev) => window.addEventListener(ev, (e) => e.preventDefault()));

  frameSel.addEventListener('change', () => { say('Converting…'); setTimeout(() => { tables.forEach((t) => t.samples && process(t)); render(); }, 0); });
  $('clear').addEventListener('click', () => { tables = []; render(); });
  $('zip').addEventListener('click', () => {
    const files = tables.filter((t) => t.result && t.slot >= 0).sort((a, b) => a.slot - b.slot)
      .map((t) => ({ name: slotName(t.slot), data: wavBytes(t.result.waves) }));
    const lines = tables.filter((t) => t.result && t.slot >= 0).sort((a, b) => a.slot - b.slot)
      .map((t) => `${slotName(t.slot)}  ${t.name}`);
    files.push({ name: 'slots.txt', data: new TextEncoder().encode(
      'Copy the wtslotNN.wav files to the root of the SD card. On the M: UWT Slot = NN, Skip = 1,\r\n' +
      'then SD Card utility > Import 16bit User WT (from SD).\r\n\r\n' + lines.join('\r\n') + '\r\n') });
    save('m-user-wavetables.zip', zipBytes(files));
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
  new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  tables = [exampleTable()];
  render();
})();
