/* ===== MLS Extract — Template-Matching Digit Recognizer ===== */
/* Zero dependencies. Pure client-side pixel matching for 8-digit MLS numbers. */

const $ = (sel) => document.querySelector(sel);

// DOM refs
const dropZone = $('#drop-zone');
const fileInput = $('#file-input');
const previewWrap = $('#preview-wrapper');
const previewImg = $('#preview-img');
const clearBtn = $('#clear-btn');
const extractBtn = $('#extract-btn');
const outputBox = $('#output-box');
const copyBtn = $('#copy-btn');
const statusArea = $('#status-area');
const progressWrap = $('#progress-container');
const progressFill = $('#progress-fill');
const progressPct = $('#progress-pct');
const countBadge = $('#count-badge');
const countNumber = $('#count-number');
const resultCard = $('#result-card');

let currentImageBlob = null;

/* ===== Image Input ===== */

document.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      handleImageFile(item.getAsFile());
      return;
    }
  }
});

fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) handleImageFile(fileInput.files[0]);
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  if (e.dataTransfer.files.length > 0) handleImageFile(e.dataTransfer.files[0]);
});

clearBtn.addEventListener('click', resetState);
extractBtn.addEventListener('click', runExtraction);

function handleImageFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    showStatus('Please provide a valid image file (PNG, JPG).', 'error');
    return;
  }

  currentImageBlob = file;
  previewImg.src = URL.createObjectURL(file);
  previewWrap.classList.remove('hidden');
  extractBtn.disabled = false;

  outputBox.value = '';
  countBadge.classList.add('hidden');
  resultCard.classList.add('hidden');
  clearStatus();

  runExtraction();
}

function resetState() {
  currentImageBlob = null;
  previewImg.src = '';
  previewWrap.classList.add('hidden');
  fileInput.value = '';
  extractBtn.disabled = true;
  outputBox.value = '';
  countBadge.classList.add('hidden');
  resultCard.classList.add('hidden');
  progressWrap.classList.add('hidden');
  clearStatus();
}

function loadImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(blob);
  });
}

function canvasFromImage(img) {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  return canvas;
}

/* ================================================================
   TEMPLATE-MATCHING DIGIT RECOGNITION PIPELINE
   ================================================================
   Purpose-built for extracting 8-digit MLS numbers from fixed-format
   column screenshots. Treats recognition as a constrained glyph-matching
   problem — NOT general OCR.

   Pipeline:
   1. Upscale 4× (nearest-neighbor) → Grayscale → Otsu binarize
   2. Horizontal projection → detect text rows
   3. Vertical projection → segment individual digits (require exactly 8)
   4. Tight-bbox extraction → normalize to fixed canvas size
   5. NCC match against pre-rendered multi-font digit templates
   6. Two-pass: refine bank from high-confidence pass-1 glyphs
   7. Reject ambiguous matches; enforce exact 8-digit output
   ================================================================ */

/* ===== Configuration ===== */
const CFG = {
  UPSCALE: 4,                // Nearest-neighbor upscale factor
  NORM_W: 24,                // Normalized digit width for NCC comparison
  NORM_H: 32,                // Normalized digit height for NCC comparison
  NORM_PAD: 2,               // Padding inside normalized canvas
  MIN_NCC: 0.35,             // Minimum NCC score to accept a digit
  MIN_MARGIN: 0.02,          // Minimum gap between 1st and 2nd NCC scores
  MIN_ROW_DENSITY: 0.012,    // Fraction of dark pixels per row to count as text
  MIN_DIGIT_W_SRC: 2,        // Min digit segment width (source px)
  MIN_DIGIT_H_SRC: 4,        // Min tight-bbox height (source px)
  REFINE_SCORE: 0.80,        // Min NCC to use glyph for pass-2 bank refinement (high to prevent poisoning)
  REFINE_MARGIN: 0.18,       // Min margin to use glyph for pass-2 bank refinement (high to prevent poisoning)
  TEMPLATE_FONTS: [           // System fonts + weight variants for template rendering
    'Arial', 'Segoe UI', 'Tahoma', 'Verdana',
    'Helvetica Neue', 'Helvetica', 'sans-serif',
  ],
  TEMPLATE_WEIGHTS: ['normal', 'bold'],  // Font weight variants
  TMPL_RENDER_PX: 120,       // Render templates at this size before normalizing
};

/* ===== Preprocessing ===== */

/** Upscale canvas with nearest-neighbor (preserves sharp pixel edges). */
function upscaleCanvas(src, factor) {
  const c = document.createElement('canvas');
  c.width = src.width * factor;
  c.height = src.height * factor;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/** Convert canvas to grayscale in-place. */
function toGrayscale(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);
}

/** Compute Otsu's optimal binarization threshold for a grayscale array. */
function computeOtsu(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let sumBg = 0, wBg = 0, best = 0, thr = 0;
  for (let t = 0; t < 256; t++) {
    wBg += hist[t];
    if (wBg === 0) continue;
    const wFg = total - wBg;
    if (wFg === 0) break;
    sumBg += t * hist[t];
    const diff = sumBg / wBg - (sumAll - sumBg) / wFg;
    const v = wBg * wFg * diff * diff;
    if (v > best) { best = v; thr = t; }
  }
  return thr;
}

/** Binarize a grayscale canvas using Otsu's method. Returns the threshold. */
function binarize(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const n = canvas.width * canvas.height;
  const gray = new Uint8Array(n);
  for (let i = 0; i < n; i++) gray[i] = d[i * 4];
  const thr = computeOtsu(gray);
  for (let i = 0; i < n; i++) {
    const v = gray[i] <= thr ? 0 : 255;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return thr;
}

/* ===== Binary Data Helpers ===== */

/** Get flat binary array from a binarized canvas. 0 = ink (black), 1 = bg (white). */
function getBinary(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const n = canvas.width * canvas.height;
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = d[i * 4] < 128 ? 0 : 1;
  return b;
}

/**
 * Find the tight bounding box of dark (ink) pixels within a rectangular region.
 * Returns absolute coordinates { x, y, w, h } or null if no ink found.
 */
function tightBBox(bin, W, rx, ry, rw, rh) {
  let x0 = rw, y0 = rh, x1 = -1, y1 = -1;
  for (let dy = 0; dy < rh; dy++) {
    for (let dx = 0; dx < rw; dx++) {
      if (bin[(ry + dy) * W + rx + dx] === 0) {
        if (dx < x0) x0 = dx;
        if (dx > x1) x1 = dx;
        if (dy < y0) y0 = dy;
        if (dy > y1) y1 = dy;
      }
    }
  }
  if (x1 < 0) return null;
  return { x: rx + x0, y: ry + y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Find tight bounding box of dark pixels in a canvas (for template rendering). */
function canvasTightBBox(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const W = canvas.width, H = canvas.height;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (d[(y * W + x) * 4] < 128) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/* ===== Segmentation ===== */

/** Horizontal projection: count ink pixels per row across full width. */
function hProjection(bin, W, H) {
  const p = new Uint32Array(H);
  for (let y = 0; y < H; y++) {
    let c = 0;
    const base = y * W;
    for (let x = 0; x < W; x++) {
      if (bin[base + x] === 0) c++;
    }
    p[y] = c;
  }
  return p;
}

/** Find contiguous text-row bands from horizontal projection. */
function findRows(hP, W, minRatio) {
  const thr = Math.max(1, Math.floor(W * minRatio));
  const rows = [];
  let inside = false, sy = 0;
  for (let y = 0; y <= hP.length; y++) {
    const val = y < hP.length ? hP[y] : 0;
    if (val >= thr) {
      if (!inside) { sy = y; inside = true; }
    } else if (inside) {
      rows.push({ y: sy, h: y - sy });
      inside = false;
    }
  }
  return rows;
}

/** Vertical projection within a row: count ink pixels per column. */
function vProjection(bin, W, ry, rh) {
  const p = new Uint32Array(W);
  for (let x = 0; x < W; x++) {
    let c = 0;
    for (let y = ry; y < ry + rh; y++) {
      if (bin[y * W + x] === 0) c++;
    }
    p[x] = c;
  }
  return p;
}

/** Find digit segment boundaries from vertical projection (zero-crossing). */
function findSegmentsRaw(vP, minW) {
  const segs = [];
  let inside = false, sx = 0;
  for (let x = 0; x <= vP.length; x++) {
    const val = x < vP.length ? vP[x] : 0;
    if (val > 0) {
      if (!inside) { sx = x; inside = true; }
    } else if (inside) {
      const w = x - sx;
      if (w >= minW) segs.push({ x: sx, w });
      inside = false;
    }
  }
  return segs;
}

/**
 * Find exactly 8 digit segments for a row. Applies adaptive splitting/merging
 * if the raw zero-crossing count is close but not exactly 8.
 */
function findDigitSegments(vP, minW) {
  let segs = findSegmentsRaw(vP, minW);

  if (segs.length === 8) return segs;

  // Too many segments (e.g. digit split by thin vertical gap): merge closest pairs
  if (segs.length > 8 && segs.length <= 12) {
    segs = mergeClosest(segs, 8);
  }

  // Too few segments (e.g. two digits touching): split widest at projection minimum
  if (segs.length >= 4 && segs.length < 8) {
    segs = splitWidest(segs, vP, minW, 8);
  }

  return segs;
}

/** Merge the closest adjacent segment pairs until we reach the target count. */
function mergeClosest(segs, target) {
  segs = segs.slice(); // copy
  while (segs.length > target) {
    let minGap = Infinity, minIdx = -1;
    for (let i = 0; i < segs.length - 1; i++) {
      const gap = segs[i + 1].x - (segs[i].x + segs[i].w);
      if (gap < minGap) { minGap = gap; minIdx = i; }
    }
    if (minIdx < 0) break;
    const a = segs[minIdx], b = segs[minIdx + 1];
    segs.splice(minIdx, 2, { x: a.x, w: (b.x + b.w) - a.x });
  }
  return segs;
}

/** Split the widest segment at its projection minimum until we reach the target count. */
function splitWidest(segs, vP, minW, target) {
  segs = segs.slice(); // copy
  while (segs.length < target) {
    // Find widest segment
    let maxW = 0, maxIdx = -1;
    for (let i = 0; i < segs.length; i++) {
      if (segs[i].w > maxW) { maxW = segs[i].w; maxIdx = i; }
    }
    if (maxIdx < 0 || maxW < minW * 2) break;

    const seg = segs[maxIdx];
    // Search for projection minimum in the middle third
    const lo = seg.x + Math.floor(seg.w * 0.25);
    const hi = seg.x + Math.floor(seg.w * 0.75);
    let minVal = Infinity, minPos = -1;
    for (let x = lo; x <= hi; x++) {
      if (vP[x] < minVal) { minVal = vP[x]; minPos = x; }
    }
    if (minPos < 0) break;

    const left = { x: seg.x, w: minPos - seg.x };
    const right = { x: minPos, w: seg.x + seg.w - minPos };
    if (left.w < minW || right.w < minW) break;

    segs.splice(maxIdx, 1, left, right);
  }
  return segs;
}

/* ===== Normalization ===== */

/**
 * Extract a glyph region from a canvas and normalize it to NORM_W × NORM_H.
 * Preserves aspect ratio, centers within frame, re-binarizes.
 * Returns { canvas, binary } where binary is Uint8Array with 1=ink, 0=bg.
 */
function normalizeGlyph(srcCanvas, sx, sy, sw, sh) {
  const { NORM_W: NW, NORM_H: NH, NORM_PAD: P } = CFG;
  const c = document.createElement('canvas');
  c.width = NW;
  c.height = NH;
  const ctx = c.getContext('2d', { willReadFrequently: true });

  // White background
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, NW, NH);

  // Scale to fit with padding, preserving aspect ratio
  const aW = NW - P * 2, aH = NH - P * 2;
  const sc = Math.min(aW / sw, aH / sh);
  const dw = sw * sc, dh = sh * sc;
  const dx = (NW - dw) / 2, dy = (NH - dh) / 2;

  // Use bilinear for smoother normalization; re-binarize below
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(srcCanvas, sx, sy, sw, sh, dx, dy, dw, dh);

  // Re-binarize to clean binary
  const img = ctx.getImageData(0, 0, NW, NH);
  const d = img.data;
  const bin = new Uint8Array(NW * NH);
  for (let i = 0; i < d.length; i += 4) {
    const dark = d[i] < 128;
    bin[i >> 2] = dark ? 1 : 0;   // 1 = ink, 0 = bg (for NCC)
    d[i] = d[i + 1] = d[i + 2] = dark ? 0 : 255;
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: c, binary: bin };
}

/* ===== Template Bank ===== */

let _templates = null;

/**
 * Build template bank: render digits 0-9 in multiple system fonts,
 * extract tight bounding box, normalize to standard size.
 * Returns bank[digit] = [binaryArray, ...]
 */
function buildTemplateBank() {
  const { TEMPLATE_FONTS, TEMPLATE_WEIGHTS } = CFG;
  const bank = {};
  for (let d = 0; d <= 9; d++) bank[d] = [];

  // Render at multiple sizes: large (smooth curves) and small (pixelated, closer to
  // the actual upscaled digit resolution). Small-render templates often match better
  // because they have similar pixel-level artifacts to the source digits.
  const renderSizes = [120, 48, 32];

  for (const SZ of renderSizes) {
    for (const font of TEMPLATE_FONTS) {
      for (const weight of TEMPLATE_WEIGHTS) {
        for (let d = 0; d <= 9; d++) {
          const tmp = document.createElement('canvas');
          tmp.width = SZ;
          tmp.height = SZ;
          const ctx = tmp.getContext('2d', { willReadFrequently: true });
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, SZ, SZ);
          ctx.fillStyle = '#000';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.font = `${weight} ${Math.floor(SZ * 0.75)}px "${font}"`;
          ctx.fillText(String(d), SZ / 2, SZ / 2);

          const bbox = canvasTightBBox(tmp);
          if (!bbox || bbox.w < 2 || bbox.h < 2) continue;

          // Same normalization pipeline as extracted digits
          const { binary } = normalizeGlyph(tmp, bbox.x, bbox.y, bbox.w, bbox.h);
          bank[d].push(binary);
        }
      }
    }
  }

  const perDigit = bank[0].length;
  console.log(`[Templates] Built bank: 10 digits × ${perDigit} variants = ${10 * perDigit} templates`);
  return bank;
}

function ensureTemplates() {
  if (!_templates) _templates = buildTemplateBank();
  return _templates;
}

/* ===== NCC Matching ===== */

/**
 * Normalized Cross-Correlation between two binary arrays (same length).
 * Returns value in [-1, 1] where 1 = perfect match.
 */
function ncc(a, b) {
  const n = a.length;
  let sA = 0, sB = 0;
  for (let i = 0; i < n; i++) { sA += a[i]; sB += b[i]; }
  const mA = sA / n, mB = sB / n;
  let num = 0, dA = 0, dB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - mA, db = b[i] - mB;
    num += da * db;
    dA += da * da;
    dB += db * db;
  }
  const den = Math.sqrt(dA * dB);
  return den < 1e-10 ? 0 : num / den;
}

/**
 * Match a candidate binary glyph against all templates in the bank.
 * Returns { digit, score, second, secondScore, margin, ambiguous, allScores }.
 */
function matchDigit(bin, bank) {
  const scores = [];
  for (let d = 0; d <= 9; d++) {
    let best = -Infinity;
    for (const t of bank[d]) {
      const s = ncc(t, bin);
      if (s > best) best = s;
    }
    scores.push({ d, s: best });
  }
  scores.sort((a, b) => b.s - a.s);
  const top = scores[0], sec = scores[1];
  const margin = top.s - sec.s;
  return {
    digit: top.d,
    score: top.s,
    second: sec.d,
    secondScore: sec.s,
    margin,
    ambiguous: top.s < CFG.MIN_NCC || margin < CFG.MIN_MARGIN,
    allScores: scores,
  };
}

/* ===== Row Recognition ===== */

/**
 * Process a list of row bands: segment digits, NCC-match, validate.
 * Returns { accepted: string[], allGlyphs: [...] }.
 *
 * @param {Array} rows - { y, h } row bands
 * @param {Uint8Array} bin - flat binary image (0=ink, 1=bg)
 * @param {HTMLCanvasElement} canvas - the binarized upscaled canvas
 * @param {Object} bank - template bank
 * @param {number} minDW - minimum digit segment width (upscaled px)
 * @param {number} minDH - minimum tight-bbox height (upscaled px)
 * @param {string} tag - log prefix ('P1' or 'P2')
 */
function recognizeRows(rows, bin, canvas, bank, minDW, minDH, tag) {
  const accepted = [];
  const seen = new Set();
  const allGlyphs = [];  // for template refinement

  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    const vP = vProjection(bin, canvas.width, row.y, row.h);
    const segs = findDigitSegments(vP, minDW);

    if (segs.length !== 8) {
      if (segs.length >= 6 && segs.length <= 10) {
        console.log(`[${tag}] Row ${ri} y=${row.y} h=${row.h}: ${segs.length} segs (need 8, skip)`);
      }
      continue;
    }

    let num = '';
    let minS = Infinity;
    let amb = false;
    const details = [];

    for (let di = 0; di < 8; di++) {
      const seg = segs[di];
      const bb = tightBBox(bin, canvas.width, seg.x, row.y, seg.w, row.h);
      if (!bb || bb.w < 3 || bb.h < minDH) {
        amb = true;
        details.push({ p: di, d: '?', s: 0, s2d: '?', s2: 0, m: 0 });
        num += '?';
        continue;
      }

      const { binary: nb } = normalizeGlyph(canvas, bb.x, bb.y, bb.w, bb.h);
      const m = matchDigit(nb, bank);

      num += String(m.digit);
      if (m.score < minS) minS = m.score;
      if (m.ambiguous) amb = true;
      details.push({
        p: di, d: m.digit, s: m.score,
        s2d: m.second, s2: m.secondScore, m: m.margin,
      });

      allGlyphs.push({
        digit: m.digit, binary: nb,
        score: m.score, margin: m.margin,
      });
    }

    // Log per-digit results
    const flags = details.map(dd =>
      `${dd.d}(${typeof dd.s === 'number' ? dd.s.toFixed(2) : '?'},Δ${typeof dd.m === 'number' ? dd.m.toFixed(2) : '?'})`
    ).join(' ');
    console.log(`[${tag}] Row ${ri}: ${num}  [${flags}]`);

    // --- Validation gates ---
    if (num.length !== 8 || !/^\d{8}$/.test(num)) {
      console.log(`  → REJECTED: invalid "${num}"`);
      continue;
    }
    if (amb) {
      const ambIdx = details
        .filter(dd => dd.s < CFG.MIN_NCC || dd.m < CFG.MIN_MARGIN)
        .map(dd => `pos${dd.p}:'${dd.d}'(s=${typeof dd.s === 'number' ? dd.s.toFixed(2) : '?'},Δ=${typeof dd.m === 'number' ? dd.m.toFixed(2) : '?'})`);
      console.log(`  → REJECTED: ambiguous [${ambIdx.join(', ')}]`);
      continue;
    }
    if (seen.has(num)) {
      console.log(`  → SKIP: duplicate`);
      continue;
    }

    console.log(`  → ACCEPTED (min NCC=${minS.toFixed(3)})`);
    seen.add(num);
    accepted.push(num);
  }

  return { accepted, allGlyphs };
}

/* ===== Main Extraction Pipeline ===== */

async function runExtraction() {
  if (!currentImageBlob) return;

  extractBtn.disabled = true;
  copyBtn.disabled = true;
  resultCard.classList.add('hidden');
  countBadge.classList.add('hidden');
  outputBox.value = '';
  clearStatus();
  progressWrap.classList.remove('hidden');
  updateProgress(0);

  try {
    /* --- Template bank (lazy init, cached after first call) --- */
    const bank = ensureTemplates();
    showStatus('Loading image…', 'info');
    updateProgress(5);

    /* --- Phase 1: Preprocess --- */
    const img = await loadImageFromBlob(currentImageBlob);
    const src = canvasFromImage(img);
    console.log(`\n========== MLS EXTRACT PIPELINE ==========`);
    console.log(`[Pre] Source: ${src.width}×${src.height}`);

    const up = upscaleCanvas(src, CFG.UPSCALE);
    console.log(`[Pre] Upscaled ${CFG.UPSCALE}× → ${up.width}×${up.height}`);

    showStatus('Preprocessing…', 'info');
    updateProgress(10);
    toGrayscale(up);
    const thr = binarize(up);
    console.log(`[Pre] Otsu threshold: ${thr}`);
    updateProgress(15);

    // Allow UI to render
    await new Promise(r => setTimeout(r, 0));

    /* --- Phase 2: Row detection --- */
    showStatus('Detecting rows…', 'info');
    const bin = getBinary(up);
    const hP = hProjection(bin, up.width, up.height);
    const rawRows = findRows(hP, up.width, CFG.MIN_ROW_DENSITY);
    console.log(`[Seg] ${rawRows.length} raw row bands detected`);

    const minH = CFG.UPSCALE * 5;
    const maxH = CFG.UPSCALE * 30;
    const rows = rawRows.filter(r => r.h >= minH && r.h <= maxH);
    console.log(`[Seg] ${rows.length} rows after height filter [${minH}–${maxH}px]`);
    updateProgress(25);

    const minDW = CFG.MIN_DIGIT_W_SRC * CFG.UPSCALE;
    const minDH = CFG.MIN_DIGIT_H_SRC * CFG.UPSCALE;

    /* --- Phase 3: Pass 1 — pre-rendered templates --- */
    showStatus('Recognizing digits (pass 1)…', 'info');
    await new Promise(r => setTimeout(r, 0));

    const p1 = recognizeRows(rows, bin, up, bank, minDW, minDH, 'P1');
    console.log(`[P1] Accepted ${p1.accepted.length} numbers: ${p1.accepted.join(', ')}`);
    updateProgress(50);

    /* --- Phase 4: Build enhanced bank from P1 high-confidence glyphs --- */
    const enhanced = {};
    for (let d = 0; d <= 9; d++) enhanced[d] = [...bank[d]];
    let added = 0;
    for (const g of p1.allGlyphs) {
      if (g.score >= CFG.REFINE_SCORE && g.margin >= CFG.REFINE_MARGIN) {
        enhanced[g.digit].push(g.binary);
        added++;
      }
    }
    console.log(`[Refine] Added ${added} high-confidence extracted glyphs to bank`);

    /* --- Phase 5: Pass 2 — enhanced bank --- */
    showStatus('Recognizing digits (pass 2)…', 'info');
    await new Promise(r => setTimeout(r, 0));

    const p2 = recognizeRows(rows, bin, up, enhanced, minDW, minDH, 'P2');
    console.log(`[P2] Accepted ${p2.accepted.length} numbers: ${p2.accepted.join(', ')}`);
    updateProgress(90);

    /* --- Phase 6: Choose best pass result --- */
    // P2 is only trusted if it is a strict superset of P1 (all P1 numbers present,
    // possibly more). If P2 changed any P1 numbers, that's template poisoning → use P1.
    let results, passUsed;
    const p1Set = new Set(p1.accepted);
    const p2SupersetOfP1 = p1.accepted.every(n => p2.accepted.includes(n));

    if (p2SupersetOfP1 && p2.accepted.length >= p1.accepted.length) {
      results = p2.accepted;
      passUsed = 'P2';
    } else {
      results = p1.accepted;
      passUsed = 'P1';
      if (!p2SupersetOfP1) {
        console.log('[Result] P2 changed P1 numbers (possible poisoning) — falling back to P1');
      }
    }
    console.log(`[Result] Using ${passUsed}: ${results.length} MLS numbers`);
    console.log(`==========================================\n`);

    updateProgress(100);

    if (!results.length) {
      showStatus('No valid 8-digit MLS numbers detected.', 'error');
      progressWrap.classList.add('hidden');
      return;
    }

    outputBox.value = results.join(', ');
    resultCard.classList.remove('hidden');
    countNumber.textContent = results.length;
    countBadge.classList.remove('hidden');
    copyBtn.disabled = false;
    progressWrap.classList.add('hidden');
    await copyToClipboard(outputBox.value);
    showStatus('Extraction complete — copied to clipboard.', 'success');

  } catch (err) {
    console.error('Pipeline error:', err);
    showStatus('Extraction failed. Try a clearer image.', 'error');
    progressWrap.classList.add('hidden');
  } finally {
    extractBtn.disabled = false;
  }
}

/* ===== Clipboard ===== */

copyBtn.addEventListener('click', async () => {
  const text = outputBox.value;
  if (!text) return;
  await copyToClipboard(text);
});

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    copyBtn.classList.add('copied');
    copyBtn.innerHTML = '<span>✓</span> Copied!';
    setTimeout(() => {
      copyBtn.classList.remove('copied');
      copyBtn.innerHTML = '<span>📋</span> Copy to Clipboard';
    }, 2500);
  } catch (err) {
    console.warn('Copy failed:', err);
    showStatus('Copy failed — use manual select/copy.', 'error');
  }
}

function showStatus(message, type) {
  statusArea.className = `status status--${type}`;
  const icons = { success: '✓', error: '⚠', info: 'ℹ' };
  statusArea.innerHTML = `<span>${icons[type] || ''}</span> ${message}`;
  statusArea.classList.remove('hidden');
}

function clearStatus() {
  statusArea.classList.add('hidden');
  statusArea.innerHTML = '';
}

function updateProgress(pct) {
  progressFill.style.width = `${pct}%`;
  progressPct.textContent = `${pct}%`;
}
