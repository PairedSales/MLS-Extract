/* ===== MLS Extract — Reference-Image Template Matching Pipeline ===== */
/* Deterministic digit recognition for 8-digit MLS numbers.              */
/* Uses canonical glyph templates from a reference image, with adaptive  */
/* template accumulation, grayscale NCC + structural feature scoring.    */

/* ================================================================== */
/*  SECTION 1 — CONFIGURATION                                         */
/* ================================================================== */

const CFG = {
  /* Preprocessing */
  UPSCALE: 4,                   // Nearest-neighbor upscale factor

  /* Normalization — 24×32 kept after benchmarking (20px risks 8/0 collapse) */
  NORM_W: 24,
  NORM_H: 32,
  NORM_PAD: 2,

  /* Classification thresholds */
  MIN_COMBINED: 0.35,           // Min combined score to accept a digit
  MIN_DIGIT_SCORE: 0.60,        // Min combined score for ANY digit in a valid row
  MIN_MARGIN: 0.02,             // Min gap between 1st and 2nd combined scores
  NCC_WEIGHT: 0.8,              // Weight of NCC in combined score
  STRUCTURAL_WEIGHT: 0.2,       // Weight of structural features in combined score

  /* Confused-pair rejection (stricter margin for known confusable digits) */
  CONFUSABLE_MARGIN: 0.05,
  CONFUSABLE_PAIRS: [
    [0, 9], [0, 8], [3, 5], [3, 8],
    [5, 6], [6, 9], [1, 7], [8, 9],
  ],

  /* Row-shading normalization (selected/alternating row highlights) */
  SHADE_LEVEL_PCT: 0.50,        // Percentile taken as a scanline's dominant surface
  SHADE_FG_PCT: 0.02,           // Percentile taken as an ink level (mirrored for light text)
  SHADE_MIN_DELTA: 12,          // How much darker than the page a band must be
  SHADE_MIN_BAND_H_SRC: 3,      // Min band height (source px) — skips rules & borders
  SHADE_MIN_CONTRAST: 20,       // Min fill−ink spread inside a band before rescaling
  SHADE_MIN_PAGE_CONTRAST: 40,  // Min page-wide bg−ink spread for a usable target

  /* Segmentation */
  MIN_ROW_DENSITY: 0.012,       // Fraction of dark pixels per row for text detection
  MIN_DIGIT_W_SRC: 2,           // Min digit segment width (source px)
  MIN_DIGIT_H_SRC: 4,           // Min tight-bbox height (source px)
  MIN_CC_AREA: 10,              // Min connected-component area (upscaled px²)

  /* Adaptive template bank */
  MAX_TEMPLATES_PER_DIGIT: 16,
  REFINE_SCORE: 0.80,           // Min combined score for bank accumulation
  REFINE_MARGIN: 0.18,          // Min margin for bank accumulation
  DEDUP_THRESHOLD: 0.97,        // NCC threshold to reject near-duplicate templates

  /* Robust hole analysis (multi-threshold + morphological closing) */
  HOLE_THRESHOLDS: [0.40],
  HOLE_MATCH_BOOST: 0.04,         // Combined score bonus when hole count matches template
  HOLE_MISMATCH_PENALTY: 0.02,    // Combined score penalty on hole count mismatch

  /* Sub-pixel alignment: ±1px shifts for NCC matching */
  NCC_SHIFT_OFFSETS: [[0,0], [1,0], [-1,0], [0,1], [0,-1]],

  /* Full-page column isolation (multi-column screenshots) */
  MLS_DIGITS: 8,                // Digit count that identifies the MLS # column
  COL_MIN_BANDS: 3,             // Bands required before treating input as a full page
  COL_GUTTER_RATIO: 0.5,        // Min gutter width as a fraction of median row height
  COL_HLINE_RATIO: 0.5,         // Horizontal ink run ≥ this × width → table border
  COL_VLINE_RATIO: 3.0,         // Vertical ink run ≥ this × median row height → separator
  COL_MIN_COVERAGE: 0.4,        // Min fraction of rows a band must fill with 8 segments
  COL_SAMPLE_ROWS: 8,           // Rows classified per candidate band while scoring
  COL_MIN_VALID: 0.35,          // Min fraction of sampled rows yielding 8 clean digits
  COL_PAD_SRC: 3,               // Padding (source px) kept around the isolated column

  /* Reference image */
  REF_IMAGE: 'reference-digits.png',
  REF_DIGIT_ORDER: [1, 2, 3, 4, 5, 6, 7, 8, 9, 0],

  /* Feature flag — Tesseract kept available but disabled */
  USE_TESSERACT_FALLBACK: false,
};

/* ================================================================== */
/*  SECTION 2 — DOM REFS, UI WIRING, IMAGE INPUT                      */
/* ================================================================== */

const $ = (sel) => document.querySelector(sel);

/* DOM references */
const dropZone      = $('#drop-zone');
const fileInput     = $('#file-input');
const previewWrap   = $('#preview-wrapper');
const previewImg    = $('#preview-img');
const clearBtn      = $('#clear-btn');
const extractBtn    = $('#extract-btn');
const outputBox     = $('#output-box');
const copyBtn       = $('#copy-btn');
const statusArea    = $('#status-area');
const progressWrap  = $('#progress-container');
const progressFill  = $('#progress-fill');
const progressPct   = $('#progress-pct');
const countBadge    = $('#count-badge');
const countNumber   = $('#count-number');
const resultCard    = $('#result-card');
const debugCard     = $('#debug-card');
const debugToggle   = $('#debug-toggle');
const debugBody     = $('#debug-body');
const debugCanvasEl = $('#debug-canvas');
const debugRowsEl   = $('#debug-rows');

let currentImageBlob = null;
let valueToCopy = '';

/* Paste handler */
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

/* File picker */
fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) handleImageFile(fileInput.files[0]);
});

/* Drag & drop */
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

/* Clear & extract buttons */
clearBtn.addEventListener('click', resetState);
extractBtn.addEventListener('click', runExtraction);

/* Debug panel toggle */
if (debugToggle) {
  debugToggle.addEventListener('click', () => {
    debugBody.classList.toggle('hidden');
    const chev = debugToggle.querySelector('.debug-chevron');
    if (chev) chev.textContent = debugBody.classList.contains('hidden') ? '▸' : '▾';
  });
}

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
  if (debugCard) debugCard.classList.add('hidden');
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
  if (debugCard) debugCard.classList.add('hidden');
  progressWrap.classList.add('hidden');
  clearStatus();
}

/* ================================================================== */
/*  SECTION 3 — IMAGE PREPROCESSING                                   */
/* ================================================================== */

/** Load an image element from a URL or blob URL. */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}

/** Load an image element from a Blob. */
function loadImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(blob);
  });
}

/** Create a canvas from an image element. */
function canvasFromImage(img) {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  return c;
}

/** Clone a canvas (same dimensions, same pixel data). */
function cloneCanvas(src) {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0);
  return c;
}

/** Crop a rectangular region out of a canvas into a new canvas. */
function cropCanvas(src, x, y, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, x, y, w, h, 0, 0, w, h);
  return c;
}

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

/** Convert canvas to grayscale in-place. Returns the canvas. */
function toGrayscale(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Value at percentile `p` (0–1) of a 256-bin histogram holding `total` samples. */
function histPercentile(hist, total, p) {
  const want = Math.max(1, Math.round(total * p));
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += hist[v];
    if (seen >= want) return v;
  }
  return 255;
}

/**
 * Neutralize row shading — the coloured highlight a grid paints behind the
 * selected row (and similar banded backgrounds).
 *
 * A shaded band's background is darker than the rest of the table, and the
 * single global Otsu threshold applied afterwards cannot serve both. Depending
 * on how dark the highlight is, the band either binarizes to a solid block —
 * losing that row outright — or loses enough contrast that its digits merge and
 * segmentation returns the wrong count. The band's extra dark pixels also skew
 * the global threshold, so one highlighted row shifts the result for every
 * other row in the image.
 *
 * Each shaded band is linearly rescaled so its background and ink levels match
 * the unshaded rows, which restores both the band itself and the global
 * histogram. Operates on (and expects) a grayscale canvas. An image with no
 * shaded bands is left unchanged.
 *
 * Returns the list of bands that were normalized.
 */
function normalizeShadedBands(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const W = canvas.width, H = canvas.height;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;

  /* Dominant surface level per scanline. The median is deliberate: it lands on
   * whichever colour fills most of the scanline, so it reports the fill for a
   * dark highlight (light text) just as reliably as the paper for ordinary
   * dark-on-light text. A high percentile would latch onto light glyphs and
   * miss dark bands entirely. */
  const levelOf = new Uint8Array(H);
  const line = new Uint32Array(256);
  for (let y = 0; y < H; y++) {
    line.fill(0);
    const base = y * W * 4;
    for (let x = 0; x < W; x++) line[d[base + x * 4]]++;
    levelOf[y] = histPercentile(line, W, CFG.SHADE_LEVEL_PCT);
  }

  /* Page background = median scanline level. Robust as long as shaded rows
   * are the minority; if most of the table is shaded there is no unshaded
   * reference to normalize toward and we correctly do nothing. */
  const pageBg = [...levelOf].sort((a, b) => a - b)[H >> 1];
  const shaded = new Uint8Array(H);
  let shadedCount = 0;
  for (let y = 0; y < H; y++) {
    if (levelOf[y] <= pageBg - CFG.SHADE_MIN_DELTA) { shaded[y] = 1; shadedCount++; }
  }
  if (shadedCount === 0) return [];

  /* Page ink level, measured only where the page is not shaded. */
  const pageHist = new Uint32Array(256);
  let pageN = 0;
  for (let y = 0; y < H; y++) {
    if (shaded[y]) continue;
    const base = y * W * 4;
    for (let x = 0; x < W; x++) { pageHist[d[base + x * 4]]++; pageN++; }
  }
  const pageFg = histPercentile(pageHist, pageN, CFG.SHADE_FG_PCT);
  if (pageBg - pageFg < CFG.SHADE_MIN_PAGE_CONTRAST) return [];

  /* Group shaded scanlines into contiguous bands. */
  const bands = [];
  let inside = false, sy = 0;
  for (let y = 0; y <= H; y++) {
    const s = y < H ? shaded[y] : 0;
    if (s) { if (!inside) { sy = y; inside = true; } }
    else if (inside) { bands.push({ y: sy, h: y - sy }); inside = false; }
  }

  const minH = CFG.SHADE_MIN_BAND_H_SRC * CFG.UPSCALE;
  const applied = [];
  for (const band of bands) {
    /* Thin bands are rules, borders and underlines, not row highlights. */
    if (band.h < minH) continue;

    const bandHist = new Uint32Array(256);
    let bandN = 0;
    for (let y = band.y; y < band.y + band.h; y++) {
      const base = y * W * 4;
      for (let x = 0; x < W; x++) { bandHist[d[base + x * 4]]++; bandN++; }
    }
    /* The fill is whatever covers most of the band, so its level is the band
     * median — true for any glyph coverage, unlike an outer percentile, which
     * collapses onto the fill once the text is sparse. The glyphs are then the
     * extreme lying furthest from that fill, on whichever side that is: dark
     * text on a light highlight, or light text on a dark one. */
    const bandBg = histPercentile(bandHist, bandN, 0.5);
    const darkEnd = histPercentile(bandHist, bandN, CFG.SHADE_FG_PCT);
    const lightEnd = histPercentile(bandHist, bandN, 1 - CFG.SHADE_FG_PCT);

    const inverted = (lightEnd - bandBg) > (bandBg - darkEnd);
    const bandFg = inverted ? lightEnd : darkEnd;

    /* A flat band carries no text to recover; rescaling it only amplifies
     * noise, so leave solid fills, rules and gradients alone. */
    const contrast = Math.abs(bandBg - bandFg);
    if (contrast < CFG.SHADE_MIN_CONTRAST) continue;

    const scale = (pageBg - pageFg) / contrast;
    for (let y = band.y; y < band.y + band.h; y++) {
      const base = y * W * 4;
      for (let x = 0; x < W; x++) {
        const i = base + x * 4;
        /* 0 at the glyph level, `contrast` at the fill level, either polarity. */
        const rel = inverted ? bandFg - d[i] : d[i] - bandFg;
        const v = Math.max(0, Math.min(255, Math.round(pageFg + rel * scale)));
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    }
    applied.push({ ...band, bandBg, bandFg, scale, inverted });
  }

  if (applied.length) ctx.putImageData(img, 0, 0);
  return applied;
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

/** Binarize a grayscale canvas using Otsu's method. Returns the threshold used. */
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

/**
 * Get flat binary array from a binarized canvas.
 * Convention: 0 = ink (dark), 1 = background (light).
 */
function getBinary(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const n = canvas.width * canvas.height;
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = d[i * 4] < 128 ? 0 : 1;
  return b;
}

/* ================================================================== */
/*  SECTION 4 — SEGMENTATION                                          */
/* ================================================================== */

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

/**
 * Vertical projection within a row: count ink pixels per column.
 * Optionally restricted to the x-range [bx, bx+bw); columns outside stay 0 so
 * segment coordinates remain absolute.
 */
function vProjection(bin, W, ry, rh, bx = 0, bw = W) {
  const p = new Uint32Array(W);
  const x0 = Math.max(0, bx);
  const x1 = Math.min(W, bx + bw);
  for (let x = x0; x < x1; x++) {
    let c = 0;
    for (let y = ry; y < ry + rh; y++) {
      if (bin[y * W + x] === 0) c++;
    }
    p[x] = c;
  }
  return p;
}

/** Find segment boundaries from vertical projection (zero-crossing). */
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

/** Merge the closest adjacent segment pairs until we reach the target count. */
function mergeClosest(segs, target) {
  segs = segs.slice();
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
  segs = segs.slice();
  while (segs.length < target) {
    let maxW = 0, maxIdx = -1;
    for (let i = 0; i < segs.length; i++) {
      if (segs[i].w > maxW) { maxW = segs[i].w; maxIdx = i; }
    }
    if (maxIdx < 0 || maxW < minW * 2) break;
    const seg = segs[maxIdx];
    const lo = seg.x + Math.floor(seg.w * 0.25);
    const hi = seg.x + Math.floor(seg.w * 0.75);
    const center = seg.x + seg.w / 2;
    let minVal = Infinity, minPos = -1;
    for (let x = lo; x <= hi; x++) {
      const dist = Math.abs(x - center);
      const val = vP[x] + dist * 1.5;
      if (val < minVal) { minVal = val; minPos = x; }
    }
    if (minPos < 0) break;
    const left  = { x: seg.x, w: minPos - seg.x };
    const right = { x: minPos, w: seg.x + seg.w - minPos };
    if (left.w < minW || right.w < minW) break;
    segs.splice(maxIdx, 1, left, right);
  }
  return segs;
}

/**
 * Find exactly `target` digit segments for a row.
 * Primary: projection-based with merge/split heuristics.
 * Fallback: connected-component analysis (only if projection fails).
 */
function findDigitSegments(vP, minW, target, bin, W, row) {
  let segs = findSegmentsRaw(vP, minW);
  if (segs.length === target) return { segs, method: 'projection' };

  /* Projection heuristics: merge if too many, split if too few */
  if (segs.length > target && segs.length <= target + 4) {
    segs = mergeClosest(segs, target);
  }
  if (segs.length >= Math.max(4, target - 4) && segs.length < target) {
    segs = splitWidest(segs, vP, minW, target);
  }
  if (segs.length === target) return { segs, method: 'projection-adjusted' };

  /* Connected-component fallback (more expensive, only if projection failed) */
  if (bin && W && row) {
    const ccSegs = fallbackSegmentation(bin, W, row, target);
    if (ccSegs && ccSegs.length === target) return { segs: ccSegs, method: 'cc-fallback' };
  }

  return { segs, method: 'projection-failed' };
}

/**
 * Find the tight bounding box of dark (ink) pixels within a rectangular region.
 * Returns { x, y, w, h } in absolute coordinates, or null if no ink found.
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

/* --- Connected-Component Analysis (fallback segmentation) --- */

/**
 * Flood-fill connected-component labeling within a row region (4-connected).
 * Returns array of { x, y, w, h, area } bounding boxes for ink components.
 */
function connectedComponents(bin, W, rx, ry, rw, rh) {
  const labels = new Int32Array(rw * rh);
  const components = [];
  let nextLabel = 1;

  for (let ly = 0; ly < rh; ly++) {
    for (let lx = 0; lx < rw; lx++) {
      const gi = (ry + ly) * W + (rx + lx);
      if (bin[gi] !== 0 || labels[ly * rw + lx] !== 0) continue;

      /* BFS flood fill */
      let minX = lx, maxX = lx, minY = ly, maxY = ly, area = 0;
      const queue = [lx, ly];
      labels[ly * rw + lx] = nextLabel;
      let qi = 0;
      while (qi < queue.length) {
        const cx = queue[qi++], cy = queue[qi++];
        area++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx >= 0 && nx < rw && ny >= 0 && ny < rh) {
            const ni = ny * rw + nx;
            const ngi = (ry + ny) * W + (rx + nx);
            if (labels[ni] === 0 && bin[ngi] === 0) {
              labels[ni] = nextLabel;
              queue.push(nx, ny);
            }
          }
        }
      }
      components.push({
        x: rx + minX, y: ry + minY,
        w: maxX - minX + 1, h: maxY - minY + 1,
        area,
      });
      nextLabel++;
    }
  }
  return components;
}

/**
 * Fallback segmentation using connected components.
 * Groups spatially close components, then merges/filters to target count.
 */
function fallbackSegmentation(bin, W, row, target) {
  const ccs = connectedComponents(bin, W, 0, row.y, W, row.h);
  /* Filter tiny noise components */
  const minArea = CFG.MIN_CC_AREA * CFG.UPSCALE;
  const valid = ccs.filter(c => c.area >= minArea);
  if (valid.length === 0) return null;

  /* Sort by x */
  valid.sort((a, b) => a.x - b.x);

  /* Group components that are spatially close (likely parts of same digit) */
  const groups = [];
  let cur = { x: valid[0].x, w: valid[0].w, components: [valid[0]] };
  for (let i = 1; i < valid.length; i++) {
    const c = valid[i];
    const curEnd = cur.x + cur.w;
    const overlap = curEnd - c.x;
    /* If overlapping or very close, merge into same group */
    if (overlap >= -2) {
      const newEnd = Math.max(curEnd, c.x + c.w);
      cur.w = newEnd - cur.x;
      cur.components.push(c);
    } else {
      groups.push({ x: cur.x, w: cur.w });
      cur = { x: c.x, w: c.w, components: [c] };
    }
  }
  groups.push({ x: cur.x, w: cur.w });

  if (groups.length === target) return groups;

  /* Try merge/split to hit target */
  if (groups.length > target && groups.length <= target + 4) {
    return mergeClosest(groups, target);
  }

  return null;
}

/* ================================================================== */
/*  SECTION 5 — NORMALIZATION (dual grayscale + binary)                */
/* ================================================================== */

/**
 * Extract a glyph region from a GRAYSCALE canvas and normalize to NORM_W × NORM_H.
 * Returns { canvas, grayscale: Float32Array, binary: Uint8Array }.
 *
 * - grayscale: inverted luminance (1.0 = ink, 0.0 = bg) for NCC matching
 * - binary: thresholded at 0.5 (1 = ink, 0 = bg) for structural features
 * - canvas: visual preview (dark ink on white bg)
 */
function normalizeGlyph(srcCanvas, sx, sy, sw, sh) {
  const { NORM_W: NW, NORM_H: NH, NORM_PAD: P } = CFG;
  const c = document.createElement('canvas');
  c.width = NW;
  c.height = NH;
  const ctx = c.getContext('2d', { willReadFrequently: true });

  /* White background */
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, NW, NH);

  /* Scale to fit with padding, preserving aspect ratio */
  const aW = NW - P * 2, aH = NH - P * 2;
  const sc = Math.min(aW / sw, aH / sh);
  const dw = sw * sc, dh = sh * sc;
  const dx = (NW - dw) / 2, dy = (NH - dh) / 2;

  /* Bilinear for smoother normalization — preserves anti-alias gradients */
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(srcCanvas, sx, sy, sw, sh, dx, dy, dw, dh);

  /* Extract dual representation */
  const img = ctx.getImageData(0, 0, NW, NH);
  const d = img.data;
  const n = NW * NH;
  const grayscale = new Float32Array(n);
  const binary = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    /* Luminance → inverted (ink = 1.0, bg = 0.0) */
    const lum = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
    grayscale[i] = 1.0 - lum;
  }

  /* Contrast stretching: map min grayscale to 0.0 and max to 1.0 if range is significant */
  let minG = 1.0, maxG = 0.0;
  for (let i = 0; i < n; i++) {
    if (grayscale[i] < minG) minG = grayscale[i];
    if (grayscale[i] > maxG) maxG = grayscale[i];
  }
  const rangeG = maxG - minG;
  if (rangeG > 0.15) {
    for (let i = 0; i < n; i++) {
      grayscale[i] = (grayscale[i] - minG) / rangeG;
    }
  }

  for (let i = 0; i < n; i++) {
    binary[i] = grayscale[i] > 0.5 ? 1 : 0;
  }

  /* Also update canvas pixels to clean binary preview */
  for (let i = 0; i < n; i++) {
    const v = binary[i] ? 0 : 255;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
  }
  ctx.putImageData(img, 0, 0);

  return { canvas: c, grayscale, binary };
}

/* ================================================================== */
/*  SECTION 6 — TEMPLATE BANK (reference image + adaptive)            */
/* ================================================================== */

let _templateBank = null;
let _templateBankPromise = null;

/**
 * Load a template from a 24x32 or arbitrary size image file.
 * Automatically extracts the tight bbox and normalizes to NORM_W x NORM_H.
 */
async function loadTemplateFromImage(srcPath, rx = 0) {
  const img = await loadImage(srcPath);
  const c = canvasFromImage(img);
  toGrayscale(c);
  const binCanvas = cloneCanvas(c);
  binarize(binCanvas);
  const bin = getBinary(binCanvas);

  const bb = tightBBox(bin, c.width, rx, 0, c.width - rx, c.height);
  if (!bb || bb.w < 2 || bb.h < 2) {
    throw new Error(`Failed to find tight bbox for template image: ${srcPath}`);
  }

  const glyph = normalizeGlyph(c, bb.x, bb.y, bb.w, bb.h);
  const features = computeStructuralFeatures(glyph.binary, CFG.NORM_W, CFG.NORM_H, glyph.grayscale);
  return {
    grayscale: glyph.grayscale,
    binary: glyph.binary,
    features,
    score: 1.0,
    isReference: true,
  };
}

/**
 * Dynamically render a character on a canvas and normalize it as a template.
 */
function createSynthesizedTemplate(char, fontWeight = 'bold', fontSize = 36) {
  const c = document.createElement('canvas');
  c.width = 100;
  c.height = 100;
  const ctx = c.getContext('2d', { willReadFrequently: true });

  // Fill white
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);

  // Draw black text
  ctx.fillStyle = '#000000';
  ctx.font = `${fontWeight} ${fontSize}px Arial, "Helvetica Neue", Helvetica, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(char, c.width / 2, c.height / 2);

  // Binarize to find bbox
  const imgData = ctx.getImageData(0, 0, c.width, c.height);
  const d = imgData.data;
  const bin = new Uint8Array(c.width * c.height);
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    bin[i / 4] = g < 128 ? 0 : 1; // 0 = ink
  }

  const bb = tightBBox(bin, c.width, 0, 0, c.width, c.height);
  if (!bb) {
    throw new Error(`Failed to find bounding box for synthesized character: ${char}`);
  }

  const glyph = normalizeGlyph(c, bb.x, bb.y, bb.w, bb.h);
  const features = computeStructuralFeatures(glyph.binary, CFG.NORM_W, CFG.NORM_H, glyph.grayscale);
  return {
    grayscale: glyph.grayscale,
    binary: glyph.binary,
    features,
    score: 1.0,
    isReference: true,
  };
}

/**
 * Load the canonical reference image and segment it into 10 digit templates.
 * The image contains digits in order: 1 2 3 4 5 6 7 8 9 0.
 * Also loads synthesized or image-based templates for '$' and ','.
 */
async function loadReferenceTemplates() {
  console.log(`[Templates] Loading reference image: ${CFG.REF_IMAGE}`);

  const img = await loadImage(CFG.REF_IMAGE);
  const srcCanvas = canvasFromImage(img);
  console.log(`[Templates] Reference image: ${srcCanvas.width}×${srcCanvas.height}`);

  /* Convert to grayscale (keep a copy for template extraction) */
  toGrayscale(srcCanvas);
  const grayCanvas = cloneCanvas(srcCanvas);

  /* Binarize a separate copy for segmentation */
  const binCanvas = cloneCanvas(srcCanvas);
  const thr = binarize(binCanvas);
  const bin = getBinary(binCanvas);
  console.log(`[Templates] Otsu threshold: ${thr}`);

  /* Find the text row */
  const hP = hProjection(bin, binCanvas.width, binCanvas.height);
  const rows = findRows(hP, binCanvas.width, 0.01);
  if (rows.length === 0) throw new Error('No text rows found in reference image');

  /* Use the tallest row (should be the only one) */
  const row = rows.reduce((a, b) => a.h > b.h ? a : b);
  console.log(`[Templates] Reference row: y=${row.y}, h=${row.h}`);

  /* Segment digits using vertical projection */
  const vP = vProjection(bin, binCanvas.width, row.y, row.h);
  const { segs, method } = findDigitSegments(vP, 2, 10, bin, binCanvas.width, row);
  console.log(`[Templates] Found ${segs.length} segments (method: ${method})`);

  if (segs.length !== 10) {
    throw new Error(`Expected 10 digit segments in reference, got ${segs.length}`);
  }

  /* Build bank */
  const bank = {};
  for (let d = 0; d <= 9; d++) bank[d] = [];
  bank['$'] = [];

  for (let i = 0; i < 10; i++) {
    const seg = segs[i];
    const digit = CFG.REF_DIGIT_ORDER[i];

    /* Tight bounding box */
    const bb = tightBBox(bin, binCanvas.width, seg.x, row.y, seg.w, row.h);
    if (!bb || bb.w < 2 || bb.h < 2) {
      console.warn(`[Templates] Skipping segment ${i} (digit ${digit}): no tight bbox`);
      continue;
    }

    /* Normalize from GRAYSCALE canvas (preserves anti-alias gradients) */
    const glyph = normalizeGlyph(grayCanvas, bb.x, bb.y, bb.w, bb.h);
    const features = computeStructuralFeatures(glyph.binary, CFG.NORM_W, CFG.NORM_H, glyph.grayscale);

    bank[digit].push({
      grayscale: glyph.grayscale,
      binary: glyph.binary,
      features,
      score: 1.0,       /* Reference templates get max score */
      isReference: true, /* Never evicted */
    });

    console.log(`[Templates] Digit ${digit}: bbox=${bb.w}×${bb.h}, `
      + `density=${features.density.toFixed(3)}, holes=${features.holeCount}`);
  }

  /* Verify all 10 digits have templates */
  const missing = [];
  for (let d = 0; d <= 9; d++) {
    if (bank[d].length === 0) missing.push(d);
  }
  if (missing.length > 0) {
    throw new Error(`Missing templates for digits: ${missing.join(', ')}`);
  }

  /* Load exact dollar references */
  try {
    const t1 = await loadTemplateFromImage('dollar-ref1.png', 4);
    bank['$'].push(t1);
    console.log('[Templates] Loaded dollar-ref1.png');
  } catch (err) {
    console.warn('[Templates] Error loading dollar-ref1.png, using fallback:', err);
    bank['$'].push(createSynthesizedTemplate('$'));
  }

  try {
    const t2 = await loadTemplateFromImage('dollar-ref2.png', 4);
    bank['$'].push(t2);
    console.log('[Templates] Loaded dollar-ref2.png');
  } catch (err) {
    console.warn('[Templates] Error loading dollar-ref2.png:', err);
  }

  /* Load synthesized S template into dollar bucket to handle cases where vertical line is lost during binarization */
  try {
    bank['$'].push(createSynthesizedTemplate('S'));
    console.log('[Templates] Loaded synthesized S template into dollar bucket');
  } catch (err) {
    console.warn('[Templates] Error synthesizing S template:', err);
  }

  console.log(`[Templates] Bank loaded: 10 digits + '$' templates`);
  return bank;
}

/**
 * Accumulate a high-confidence extracted glyph into the adaptive bank.
 * Deduplicates against existing templates (NCC > DEDUP_THRESHOLD → reject).
 * Evicts weakest non-reference template when cap is reached.
 * Returns true if template was added.
 */
function accumulateTemplate(bank, digit, grayscale, binary, features, score) {
  const bucket = bank[digit];

  /* Deduplication: reject if too similar to any existing template */
  for (const tmpl of bucket) {
    if (ncc(grayscale, tmpl.grayscale) > CFG.DEDUP_THRESHOLD) return false;
  }

  const entry = { grayscale, binary, features, score, isReference: false };

  if (bucket.length < CFG.MAX_TEMPLATES_PER_DIGIT) {
    bucket.push(entry);
    return true;
  }

  /* Cap reached: find weakest non-reference template to evict */
  let minScore = Infinity, minIdx = -1;
  for (let i = 0; i < bucket.length; i++) {
    if (bucket[i].isReference) continue;
    if (bucket[i].score < minScore) {
      minScore = bucket[i].score;
      minIdx = i;
    }
  }

  if (minIdx >= 0 && score > minScore) {
    bucket[minIdx] = entry;
    return true;
  }

  return false;
}

/** Shallow-clone the template bank (shares arrays, allows independent accumulation). */
function cloneBank(bank) {
  const clone = {};
  for (const key of Object.keys(bank)) {
    clone[key] = bank[key].map(t => ({ ...t }));
  }
  return clone;
}

/** Ensure template bank is loaded. Async due to image loading. */
async function ensureTemplates() {
  if (_templateBank) return _templateBank;
  if (_templateBankPromise) return _templateBankPromise;
  _templateBankPromise = loadReferenceTemplates();
  _templateBank = await _templateBankPromise;
  _templateBankPromise = null;
  return _templateBank;
}

/* ================================================================== */
/*  SECTION 7 — CLASSIFICATION (grayscale NCC + structural features)   */
/* ================================================================== */

/**
 * Normalized Cross-Correlation between two arrays (same length).
 * Works on Float32Array (grayscale) or Uint8Array (binary).
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
 * NCC with sub-pixel shift: correlate a[y][x] against b[y+dy][x+dx]
 * over their overlapping region. Returns NCC in [-1, 1].
 */
function shiftedNCC(a, b, W, H, dx, dy) {
  const x0 = Math.max(0, -dx), y0 = Math.max(0, -dy);
  const x1 = Math.min(W, W - dx), y1 = Math.min(H, H - dy);
  const count = (x1 - x0) * (y1 - y0);
  if (count <= 0) return -1;
  let sA = 0, sB = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      sA += a[y * W + x];
      sB += b[(y + dy) * W + (x + dx)];
    }
  }
  const mA = sA / count, mB = sB / count;
  let num = 0, dA = 0, dB = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const da = a[y * W + x] - mA;
      const db = b[(y + dy) * W + (x + dx)] - mB;
      num += da * db;
      dA += da * da;
      dB += db * db;
    }
  }
  const den = Math.sqrt(dA * dB);
  return den < 1e-10 ? 0 : num / den;
}

/**
 * Compute structural features from a binary glyph (1 = ink, 0 = bg).
 * Used alongside NCC for robust classification.
 * If grayscale is provided, uses multi-threshold robust hole counting.
 */
function computeStructuralFeatures(binary, W, H, grayscale) {
  const n = W * H;
  const halfH = Math.floor(H / 2);

  /* Density: fraction of ink pixels */
  let inkCount = 0;
  for (let i = 0; i < n; i++) { if (binary[i] === 1) inkCount++; }
  const density = inkCount / n;

  /* Upper/lower density */
  let upperInk = 0, lowerInk = 0;
  const upperN = halfH * W;
  const lowerN = (H - halfH) * W;
  for (let y = 0; y < halfH; y++) {
    for (let x = 0; x < W; x++) {
      if (binary[y * W + x] === 1) upperInk++;
    }
  }
  for (let y = halfH; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (binary[y * W + x] === 1) lowerInk++;
    }
  }
  const upperDensity = upperN > 0 ? upperInk / upperN : 0;
  const lowerDensity = lowerN > 0 ? lowerInk / lowerN : 0;

  /* Aspect ratio of tight ink bounding box */
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (binary[y * W + x] === 1) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  const bboxW = x1 >= 0 ? x1 - x0 + 1 : 1;
  const bboxH = y1 >= 0 ? y1 - y0 + 1 : 1;
  const aspectRatio = bboxW / bboxH;

  /* Hole count — robust multi-threshold with morphological closing */
  let holeCount, holeDetail;
  if (grayscale) {
    const hResult = robustHoleCount(grayscale, W, H);
    holeCount = hResult.max;
    holeDetail = hResult;
  } else {
    holeCount = countHoles(binary, W, H);
    holeDetail = { max: holeCount, perThreshold: [] };
  }

  return { density, upperDensity, lowerDensity, aspectRatio, holeCount, holeDetail };
}

/**
 * Count enclosed background regions (holes) in a binary glyph.
 * 4-connected flood-fill from border → remaining unvisited bg = holes.
 */
function countHoles(binary, W, H) {
  const visited = new Uint8Array(W * H);

  /* Mark all ink pixels as visited */
  for (let i = 0; i < W * H; i++) {
    if (binary[i] === 1) visited[i] = 1;
  }

  /* Flood-fill "outside" from all border background pixels */
  const queue = [];
  const tryEnqueue = (x, y) => {
    if (x >= 0 && x < W && y >= 0 && y < H) {
      const i = y * W + x;
      if (!visited[i]) { visited[i] = 1; queue.push(i); }
    }
  };
  for (let x = 0; x < W; x++) { tryEnqueue(x, 0); tryEnqueue(x, H - 1); }
  for (let y = 1; y < H - 1; y++) { tryEnqueue(0, y); tryEnqueue(W - 1, y); }

  let qi = 0;
  while (qi < queue.length) {
    const idx = queue[qi++];
    const x = idx % W, y = (idx - x) / W;
    tryEnqueue(x - 1, y);
    tryEnqueue(x + 1, y);
    tryEnqueue(x, y - 1);
    tryEnqueue(x, y + 1);
  }

  /* Count remaining unvisited background regions */
  let holes = 0;
  for (let i = 0; i < W * H; i++) {
    if (!visited[i]) {
      holes++;
      /* Flood-fill this hole so it's not counted again */
      const hq = [i];
      visited[i] = 1;
      let hi = 0;
      while (hi < hq.length) {
        const idx = hq[hi++];
        const x = idx % W, y = (idx - x) / W;
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
            const ni = ny * W + nx;
            if (!visited[ni]) { visited[ni] = 1; hq.push(ni); }
          }
        }
      }
    }
  }

  return holes;
}

/**
 * Morphological closing (dilate → erode) with a 3×3 cross structuring element.
 * Bridges 1px gaps in thin strokes (e.g., middle bar of '8').
 */
function morphClose(binary, W, H) {
  const n = W * H;
  /* Dilate: pixel is ink if it or any 4-neighbor is ink */
  const dilated = new Uint8Array(n);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (binary[i] === 1 ||
          (x > 0 && binary[i - 1] === 1) ||
          (x < W - 1 && binary[i + 1] === 1) ||
          (y > 0 && binary[i - W] === 1) ||
          (y < H - 1 && binary[i + W] === 1)) {
        dilated[i] = 1;
      }
    }
  }
  /* Erode: pixel is ink only if it and all existing 4-neighbors are ink */
  const closed = new Uint8Array(n);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (dilated[i] !== 1) continue;
      if ((x === 0 || dilated[i - 1] === 1) &&
          (x === W - 1 || dilated[i + 1] === 1) &&
          (y === 0 || dilated[i - W] === 1) &&
          (y === H - 1 || dilated[i + W] === 1)) {
        closed[i] = 1;
      }
    }
  }
  return closed;
}

/**
 * Robust hole counting: multi-threshold approach WITHOUT morphological closing.
 * Tries multiple binarization thresholds and takes the maximum hole count.
 *
 * At lower thresholds (0.35, 0.40), more pixels count as ink, which
 * naturally bridges thin strokes like 8's waist. Meanwhile 9's opening
 * remains open because it's a true structural gap, not a thin stroke.
 * Returns { max, perThreshold }.
 */
function robustHoleCount(grayscale, W, H) {
  let max = 0;
  const perThreshold = [];

  for (const thr of CFG.HOLE_THRESHOLDS) {
    const bin = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      bin[i] = grayscale[i] > thr ? 1 : 0;
    }
    const holes = countHolesMinSize(bin, W, H, 3);
    perThreshold.push([thr, holes]);
    if (holes > max) max = holes;
  }

  return { max, perThreshold };
}

/**
 * Count holes with a minimum size filter.
 * Same as countHoles but only counts background regions with >= minSize pixels.
 * This prevents tiny 1-2px noise holes from being counted.
 */
function countHolesMinSize(binary, W, H, minSize) {
  const visited = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (binary[i] === 1) visited[i] = 1;
  }

  /* Flood-fill outside from border */
  const queue = [];
  const tryEnqueue = (x, y) => {
    if (x >= 0 && x < W && y >= 0 && y < H) {
      const i = y * W + x;
      if (!visited[i]) { visited[i] = 1; queue.push(i); }
    }
  };
  for (let x = 0; x < W; x++) { tryEnqueue(x, 0); tryEnqueue(x, H - 1); }
  for (let y = 1; y < H - 1; y++) { tryEnqueue(0, y); tryEnqueue(W - 1, y); }
  let qi = 0;
  while (qi < queue.length) {
    const idx = queue[qi++];
    const x = idx % W, y = (idx - x) / W;
    tryEnqueue(x - 1, y); tryEnqueue(x + 1, y);
    tryEnqueue(x, y - 1); tryEnqueue(x, y + 1);
  }

  /* Count remaining unvisited regions, filtering by size */
  let holes = 0;
  for (let i = 0; i < W * H; i++) {
    if (!visited[i]) {
      /* Flood-fill this region and count its size */
      const hq = [i];
      visited[i] = 1;
      let hi = 0;
      while (hi < hq.length) {
        const idx = hq[hi++];
        const x = idx % W, y = (idx - x) / W;
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
            const ni = ny * W + nx;
            if (!visited[ni]) { visited[ni] = 1; hq.push(ni); }
          }
        }
      }
      if (hq.length >= minSize) holes++;
    }
  }
  return holes;
}

/** Canonical expected hole counts per digit (for structural discrimination) */
const CANONICAL_HOLES = { 0: 1, 1: 0, 2: 0, 3: 0, 4: 1, 5: 0, 6: 1, 7: 0, 8: 2, 9: 1 };

/**
 * Compute structural similarity between a candidate and a template.
 * Returns score in [0, 1] where 1 = perfect structural match.
 */
function structuralScore(candidateFeatures, templateFeatures) {
  /* Hole count mismatch: strongest discriminator */
  const holeDiff = Math.abs(candidateFeatures.holeCount - templateFeatures.holeCount);
  const holePenalty = Math.min(holeDiff, 2) / 2;

  /* Density difference */
  const densityPenalty = Math.abs(candidateFeatures.density - templateFeatures.density);

  /* Vertical balance: upper-lower asymmetry difference */
  const candBalance = candidateFeatures.upperDensity - candidateFeatures.lowerDensity;
  const tmplBalance = templateFeatures.upperDensity - templateFeatures.lowerDensity;
  const balancePenalty = Math.min(Math.abs(candBalance - tmplBalance), 1.0);

  /* Aspect ratio difference */
  const arPenalty = Math.min(Math.abs(candidateFeatures.aspectRatio - templateFeatures.aspectRatio), 1.0);

  /* Weighted penalty → score */
  const penalty = holePenalty * 0.4 + densityPenalty * 0.2 + balancePenalty * 0.2 + arPenalty * 0.2;
  return Math.max(0, 1.0 - penalty);
}

/**
 * Classify a normalized glyph against the template bank.
 * Combines grayscale NCC (with ±1px shifts), structural features,
 * and hole-match bias for robust digit discrimination.
 *
 * Returns { digit, score, nccScore, structScore, margin, top3, allScores, features }.
 */
function classifyGlyph(glyph, bank) {
  const results = [];
  const { NORM_W: W, NORM_H: H } = CFG;
  const candHoles = glyph.features.holeCount;

  for (const d of Object.keys(bank)) {
    let bestCombined = -Infinity, bestNCC_val = -Infinity, bestStruct = 0;
    const dNum = parseInt(d, 10);

    for (const tmpl of bank[d]) {
      /* Shifted NCC: try original + ±1px offsets, take best */
      let nccS = ncc(glyph.grayscale, tmpl.grayscale);
      for (const [dx, dy] of CFG.NCC_SHIFT_OFFSETS) {
        if (dx === 0 && dy === 0) continue;
        const s = shiftedNCC(glyph.grayscale, tmpl.grayscale, W, H, dx, dy);
        if (s > nccS) nccS = s;
      }

      const strS = structuralScore(glyph.features, tmpl.features);
      let combined = nccS * CFG.NCC_WEIGHT + strS * CFG.STRUCTURAL_WEIGHT;

      /* Hole-match bias: small boost/penalty based on hole count agreement.
       * This biases, not overrides — magnitudes are small relative to NCC. */
      const tmplHoles = tmpl.features.holeCount;
      if (candHoles === tmplHoles) {
        combined += CFG.HOLE_MATCH_BOOST;
      } else if (Math.abs(candHoles - tmplHoles) >= 1) {
        combined -= CFG.HOLE_MISMATCH_PENALTY;
      }

      /* Vertical density balance bias for 8/9 discrimination.
       * 8 is vertically balanced (upper/lower ratio ~0.8–1.2).
       * 9 is top-heavy (ratio > 1.2). Apply a small bias accordingly. */
      if (!isNaN(dNum) && (dNum === 8 || dNum === 9)) {
        const ud = glyph.features.upperDensity;
        const ld = glyph.features.lowerDensity;
        const balance = ld > 0.001 ? ud / ld : 10;
        if (dNum === 8 && balance > 1.2) {
          /* Glyph is top-heavy: penalize 8 (which should be balanced) */
          combined -= 0.01;
        } else if (dNum === 9 && balance > 1.2) {
          /* Glyph is top-heavy: boost 9 (which is top-heavy) */
          combined += 0.01;
        } else if (dNum === 9 && balance <= 1.2) {
          /* Glyph is balanced: penalize 9 (which should be top-heavy) */
          combined -= 0.01;
        } else if (dNum === 8 && balance <= 1.2) {
          /* Glyph is balanced: boost 8 (which should be balanced) */
          combined += 0.01;
        }
      }

      if (combined > bestCombined) {
        bestCombined = combined;
        bestNCC_val = nccS;
        bestStruct = strS;
      }
    }

    const parsedD = isNaN(dNum) ? d : dNum;
    results.push({ d: parsedD, combined: bestCombined, ncc: bestNCC_val, structural: bestStruct });
  }

  results.sort((a, b) => b.combined - a.combined);
  const top = results[0], sec = results[1];
  const margin = top.combined - sec.combined;

  return {
    digit: top.d,
    score: top.combined,
    nccScore: top.ncc,
    structScore: top.structural,
    margin,
    top3: results.slice(0, 3),
    allScores: results,
    features: glyph.features,
  };
}

/* ================================================================== */
/*  SECTION 8 — AMBIGUITY + VALIDATION                                */
/* ================================================================== */

/**
 * Determine if a classification result is too ambiguous to trust.
 * Favors false negatives over false positives.
 * Uses hole-count discrimination to relax confusable-pair margins when
 * structural features provide strong evidence.
 * For 8/9 confusion: uses vertical density balance to discriminate.
 */
function isAmbiguous(result) {
  /* Hard rejection: below minimum thresholds */
  if (result.score < CFG.MIN_COMBINED) return 'score-below-min';
  if (result.margin < CFG.MIN_MARGIN) return 'margin-below-min';

  /* Confused-pair rejection: stricter margin for known confusable pairs */
  const top2 = [result.top3[0].d, result.top3[1].d];
  for (const [a, b] of CFG.CONFUSABLE_PAIRS) {
    if (top2.includes(a) && top2.includes(b)) {
      let effectiveMargin = CFG.CONFUSABLE_MARGIN;

      /* Relax margin when hole count definitively discriminates.
       * Only when candidate holes match top but not second candidate. */
      const candHoles = result.features.holeCount;
      const topExpected = CANONICAL_HOLES[result.top3[0].d];
      const secExpected = CANONICAL_HOLES[result.top3[1].d];
      if (topExpected !== undefined && secExpected !== undefined &&
          topExpected !== secExpected &&
          candHoles === topExpected && candHoles !== secExpected) {
        effectiveMargin = CFG.MIN_MARGIN;
      }

      /* Special 8/9 discrimination via vertical density balance.
       * 8 has balanced upper/lower density (ratio ~0.8–1.2).
       * 9 is top-heavy (upper density >> lower density, ratio > 1.15).
       * If the top pick is 8 but vertical balance suggests 9, require wide margin. */
      if (top2.includes(8) && top2.includes(9)) {
        const ud = result.features.upperDensity;
        const ld = result.features.lowerDensity;
        const balance = ld > 0.001 ? ud / ld : 10;
        if (result.top3[0].d === 8 && balance > 1.15) {
          /* Glyph is top-heavy like a 9, but classified as 8 — require strict margin */
          effectiveMargin = Math.max(effectiveMargin, 0.20);
        } else if (result.top3[0].d === 9 && balance < 1.15) {
          /* Glyph is balanced like an 8, but classified as 9 — require strict margin */
          effectiveMargin = Math.max(effectiveMargin, 0.20);
        }
      }

      if (result.margin < effectiveMargin) {
        return `confusable-${a}/${b}`;
      }
    }
  }

  return null; /* Not ambiguous */
}

/* ================================================================== */
/*  SECTION 9 — DEBUG RENDERING                                        */
/* ================================================================== */

/**
 * Render the debug overlay canvas showing detected rows and digit segments.
 * Completely decoupled from extraction — runs after classification completes.
 */
function renderDebugOverlay(grayCanvas, rowResults) {
  if (!debugCanvasEl) return;

  /* Scale to fit card width (~580px max) */
  const maxW = 580;
  const scale = Math.min(1, maxW / grayCanvas.width);
  const dw = Math.floor(grayCanvas.width * scale);
  const dh = Math.floor(grayCanvas.height * scale);

  debugCanvasEl.width = dw;
  debugCanvasEl.height = dh;
  const ctx = debugCanvasEl.getContext('2d');

  /* Draw the grayscale source image */
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(grayCanvas, 0, 0, dw, dh);

  /* Draw row bands */
  for (const rr of rowResults) {
    const ry = rr.row.y * scale, rh = rr.row.h * scale;
    const isAccepted = rr.status === 'accepted' || rr.status === 'accepted-pass2';

    /* Row band highlight */
    ctx.fillStyle = isAccepted ? 'rgba(80, 250, 123, 0.12)' : 'rgba(255, 85, 85, 0.08)';
    ctx.fillRect(0, ry, dw, rh);
    ctx.strokeStyle = isAccepted ? 'rgba(80, 250, 123, 0.5)' : 'rgba(255, 85, 85, 0.3)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, ry, dw, rh);

    /* Digit segment boxes */
    if (rr.digits) {
      for (const dd of rr.digits) {
        if (!dd.tightBounds) continue;
        const bb = dd.tightBounds;
        const bx = bb.x * scale, by = bb.y * scale;
        const bw = bb.w * scale, bh = bb.h * scale;

        let color;
        if (dd.status === 'accepted') color = 'rgba(80, 250, 123, 0.6)';
        else if (dd.status === 'ambiguous') color = 'rgba(255, 184, 108, 0.6)';
        else color = 'rgba(255, 85, 85, 0.6)';

        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(bx, by, bw, bh);

        /* Digit label */
        if (dd.classification) {
          ctx.fillStyle = color;
          ctx.font = `bold ${Math.max(9, Math.floor(12 * scale))}px monospace`;
          ctx.fillText(String(dd.classification.digit), bx + 1, by - 2);
        }
      }
    }
  }
}

/**
 * Render per-row debug tables with top-3 candidates, scores, and features.
 */
function renderDebugTable(rowResults, perfTimings) {
  if (!debugRowsEl) return;
  debugRowsEl.innerHTML = '';

  /* Performance summary */
  if (perfTimings) {
    const perfDiv = document.createElement('div');
    perfDiv.className = 'debug-perf';
    perfDiv.innerHTML = '<strong>⏱ Performance</strong><br>'
      + Object.entries(perfTimings)
          .map(([k, v]) => `${k}: ${v.toFixed(1)}ms`)
          .join(' · ');
    debugRowsEl.appendChild(perfDiv);
  }

  /* Per-row details */
  for (let ri = 0; ri < rowResults.length; ri++) {
    const rr = rowResults[ri];
    const isAccepted = rr.status === 'accepted' || rr.status === 'accepted-pass2';

    const rowDiv = document.createElement('div');
    rowDiv.className = `debug-row ${isAccepted ? 'debug-row--accepted' : 'debug-row--rejected'}`;

    /* Header */
    const header = document.createElement('div');
    header.className = 'debug-row__header';
    const statusIcon = isAccepted ? '✓' : rr.status.startsWith('rejected-segments') ? '⊘' : '✗';
    header.innerHTML = `<span>${statusIcon}</span> `
      + `Row ${ri} <small>(y=${rr.row.y} h=${rr.row.h})</small> `
      + `— <strong>${rr.result || 'no digits'}</strong> `
      + `<span class="debug-tag">${rr.status}</span> `
      + `<span class="debug-tag">${rr.segMethod || ''}</span>`;
    rowDiv.appendChild(header);

    /* Digit table (only if we have digit-level data) */
    if (rr.digits && rr.digits.length > 0) {
      const table = document.createElement('table');
      table.className = 'debug-table';
      table.innerHTML = `<thead><tr>
        <th>Pos</th><th>Glyph</th>
        <th>#1</th><th>Score</th>
        <th>#2</th><th>Score</th>
        <th>#3</th><th>Score</th>
        <th>Margin</th><th>Holes</th><th>Density</th><th>Status</th>
      </tr></thead>`;

      const tbody = document.createElement('tbody');
      for (let di = 0; di < rr.digits.length; di++) {
        const dd = rr.digits[di];
        const tr = document.createElement('tr');
        tr.className = dd.status === 'accepted' ? '' : 'debug-table__row--rejected';

        /* Position */
        const tdPos = document.createElement('td');
        tdPos.textContent = di;
        tr.appendChild(tdPos);

        /* Glyph preview canvas */
        const tdGlyph = document.createElement('td');
        if (dd.glyphCanvas) {
          const preview = document.createElement('canvas');
          preview.width = CFG.NORM_W;
          preview.height = CFG.NORM_H;
          preview.className = 'debug-glyph';
          preview.getContext('2d').drawImage(dd.glyphCanvas, 0, 0);
          tdGlyph.appendChild(preview);
        } else {
          tdGlyph.textContent = '—';
        }
        tr.appendChild(tdGlyph);

        /* Top-3 candidates */
        if (dd.classification && dd.classification.top3) {
          for (let ti = 0; ti < 3; ti++) {
            const cand = dd.classification.top3[ti];
            const tdD = document.createElement('td');
            tdD.textContent = cand ? cand.d : '—';
            tdD.className = 'debug-digit';
            tr.appendChild(tdD);
            const tdS = document.createElement('td');
            tdS.textContent = cand ? cand.combined.toFixed(3) : '—';
            tdS.className = scoreClass(cand?.combined);
            tr.appendChild(tdS);
          }
        } else {
          for (let ti = 0; ti < 6; ti++) {
            const td = document.createElement('td');
            td.textContent = '—';
            tr.appendChild(td);
          }
        }

        /* Margin */
        const tdMargin = document.createElement('td');
        tdMargin.textContent = dd.classification ? dd.classification.margin.toFixed(3) : '—';
        tdMargin.className = dd.classification ? marginClass(dd.classification.margin) : '';
        tr.appendChild(tdMargin);

        /* Holes (with per-threshold detail on hover) */
        const tdHoles = document.createElement('td');
        const holeDetail = dd.classification?.features?.holeDetail;
        if (holeDetail && holeDetail.perThreshold && holeDetail.perThreshold.length > 0) {
          tdHoles.textContent = `${holeDetail.max}`;
          tdHoles.title = holeDetail.perThreshold.map(([t, h]) => `thr=${t}→${h}holes`).join(', ');
          tdHoles.style.cursor = 'help';
        } else {
          tdHoles.textContent = dd.classification?.features?.holeCount ?? '—';
        }
        tr.appendChild(tdHoles);

        /* Density */
        const tdDensity = document.createElement('td');
        tdDensity.textContent = dd.classification?.features?.density?.toFixed(3) ?? '—';
        tr.appendChild(tdDensity);

        /* Status */
        const tdStatus = document.createElement('td');
        tdStatus.textContent = dd.status === 'accepted' ? '✓' : dd.rejectReason || dd.status;
        tdStatus.className = dd.status === 'accepted' ? 'debug-status--ok' : 'debug-status--bad';
        tr.appendChild(tdStatus);

        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      rowDiv.appendChild(table);
    }

    debugRowsEl.appendChild(rowDiv);
  }
}

function scoreClass(score) {
  if (score == null) return '';
  if (score >= 0.7) return 'debug-score--high';
  if (score >= 0.45) return 'debug-score--med';
  return 'debug-score--low';
}

function marginClass(margin) {
  if (margin >= 0.15) return 'debug-score--high';
  if (margin >= 0.05) return 'debug-score--med';
  return 'debug-score--low';
}

/* ================================================================== */
/*  SECTION 10 — FULL-PAGE COLUMN ISOLATION                           */
/* ================================================================== */

/*
 * A full-page MLS scan holds ~20 columns. The recognizer only knows how to
 * read a single column of 8-digit numbers, so before anything else we find the
 * MLS # column and crop to it. The image then looks exactly like the
 * pre-cropped screenshots the rest of the pipeline already handles.
 */

/**
 * Binarize + detect row bands for an upscaled grayscale canvas.
 * Returns { gray, bin, W, H, rows, thr }.
 */
function analyzeSurface(grayCanvas) {
  const work = cloneCanvas(grayCanvas);
  const thr = binarize(work);
  const bin = getBinary(work);
  const W = work.width, H = work.height;

  const hP = hProjection(bin, W, H);
  const rawRows = findRows(hP, W, CFG.MIN_ROW_DENSITY);
  const minH = CFG.UPSCALE * 5;
  const maxH = CFG.UPSCALE * 30;
  const rows = rawRows.filter(r => r.h >= minH && r.h <= maxH);

  return { gray: grayCanvas, bin, W, H, rows, rawRows, thr, minH, maxH };
}

/** Median row-band height, used to scale every gutter/gridline threshold. */
function medianRowHeight(rows) {
  if (!rows.length) return CFG.UPSCALE * 8;
  const hs = rows.map(r => r.h).sort((a, b) => a - b);
  return hs[Math.floor(hs.length / 2)];
}

/**
 * Copy `bin` with table rules erased: any horizontal ink run spanning a large
 * fraction of the width, or any vertical run far taller than a text row, is a
 * border rather than a glyph. Left in place they bridge every gutter and the
 * page reads as one solid column.
 */
function suppressGridLines(bin, W, H, medH) {
  const out = Uint8Array.from(bin);
  const hMin = Math.max(8, Math.round(W * CFG.COL_HLINE_RATIO));
  const vMin = Math.max(8, Math.round(medH * CFG.COL_VLINE_RATIO));

  /* Horizontal rules */
  for (let y = 0; y < H; y++) {
    const base = y * W;
    let run = 0;
    for (let x = 0; x <= W; x++) {
      const ink = x < W && bin[base + x] === 0;
      if (ink) { run++; continue; }
      if (run >= hMin) for (let k = x - run; k < x; k++) out[base + k] = 1;
      run = 0;
    }
  }

  /* Vertical rules */
  for (let x = 0; x < W; x++) {
    let run = 0;
    for (let y = 0; y <= H; y++) {
      const ink = y < H && bin[y * W + x] === 0;
      if (ink) { run++; continue; }
      if (run >= vMin) for (let k = y - run; k < y; k++) out[k * W + x] = 1;
      run = 0;
    }
  }

  return out;
}

/**
 * Split the page into column bands: x-ranges of ink separated by gutters that
 * are empty in *every* text row. Ragged cell contents never close a gutter, so
 * only real column padding survives.
 */
function findColumnBands(bin, W, rows, medH) {
  const inked = new Uint8Array(W);
  for (const row of rows) {
    for (let y = row.y; y < row.y + row.h; y++) {
      const base = y * W;
      for (let x = 0; x < W; x++) {
        if (bin[base + x] === 0) inked[x] = 1;
      }
    }
  }

  const minGutter = Math.max(2, Math.round(medH * CFG.COL_GUTTER_RATIO));
  const minBandW = CFG.MIN_DIGIT_W_SRC * CFG.UPSCALE;
  const bands = [];

  let x = 0;
  while (x < W) {
    if (!inked[x]) { x++; continue; }

    const start = x;
    let end = x, gap = 0;
    x++;
    while (x < W) {
      if (inked[x]) { end = x; gap = 0; }
      else if (++gap >= minGutter) break;
      x++;
    }
    bands.push({ x: start, w: end - start + 1 });
  }

  return bands.filter(b => b.w >= minBandW);
}

/**
 * Score one band as an MLS # candidate.
 *
 * Coverage comes first (cheap): the MLS column segments into exactly 8 glyphs
 * in nearly every row, which drops short numerics, dates and street names.
 * Bands that survive get a sample of rows classified, which is what separates
 * MLS numbers from the other 8-glyph cells — "$755,000" segments into 8 too,
 * but its glyphs come back as '$' and a comma rather than digits.
 */
function scoreColumnBand(band, surf, bank) {
  const { bin, W, rows, gray } = surf;
  const minDW = CFG.MIN_DIGIT_W_SRC * CFG.UPSCALE;
  const minDH = CFG.MIN_DIGIT_H_SRC * CFG.UPSCALE;
  const target = CFG.MLS_DIGITS;

  /* Projection-only segmentation: the connected-component fallback is not
   * band-aware and would scan the whole page width for every row. */
  const candidates = [];
  for (const row of rows) {
    const vP = vProjection(bin, W, row.y, row.h, band.x, band.w);
    const { segs } = findDigitSegments(vP, minDW, target);
    if (segs.length === target) candidates.push({ row, segs });
  }

  const coverage = rows.length ? candidates.length / rows.length : 0;
  if (coverage < CFG.COL_MIN_COVERAGE) {
    return { band, coverage, valid: 0, score: 0, reason: 'coverage' };
  }

  /* Classify an evenly spread sample rather than every row. */
  const step = Math.max(1, Math.floor(candidates.length / CFG.COL_SAMPLE_ROWS));
  const sample = [];
  for (let i = 0; i < candidates.length && sample.length < CFG.COL_SAMPLE_ROWS; i += step) {
    sample.push(candidates[i]);
  }

  let valid = 0, scoreSum = 0;
  for (const { row, segs } of sample) {
    let num = '', worst = 1;
    for (const seg of segs) {
      const bb = tightBBox(bin, W, seg.x, row.y, seg.w, row.h);
      if (!bb || bb.w < 3 || bb.h < minDH) { num += '?'; worst = 0; break; }
      const glyph = normalizeGlyph(gray, bb.x, bb.y, bb.w, bb.h);
      glyph.features = computeStructuralFeatures(glyph.binary, CFG.NORM_W, CFG.NORM_H, glyph.grayscale);
      const cls = classifyGlyph(glyph, bank);
      num += String(cls.digit);
      worst = Math.min(worst, cls.score);
    }
    if (/^\d{8}$/.test(num) && worst >= CFG.MIN_DIGIT_SCORE) {
      valid++;
      scoreSum += worst;
    }
  }

  const validFrac = sample.length ? valid / sample.length : 0;
  if (validFrac < CFG.COL_MIN_VALID) {
    return { band, coverage, valid: validFrac, score: 0, reason: 'not-digits' };
  }

  const meanScore = valid ? scoreSum / valid : 0;
  return {
    band, coverage, valid: validFrac, reason: 'ok',
    score: coverage * 0.35 + validFrac * 0.45 + meanScore * 0.2,
  };
}

/**
 * Locate the MLS # column in a multi-column scan.
 * Returns { x, w } in upscaled coordinates, or null when the image is already a
 * single column (or no band looks like MLS numbers).
 */
function isolateMlsColumn(surf, bank) {
  const { bin, W, H, rows } = surf;
  if (rows.length < 3) return null;

  const medH = medianRowHeight(rows);
  const clean = suppressGridLines(bin, W, H, medH);
  const bands = findColumnBands(clean, W, rows, medH);
  console.log(`[Column] ${bands.length} bands (medH=${medH}, gutter≥${Math.max(2, Math.round(medH * CFG.COL_GUTTER_RATIO))}px)`);

  if (bands.length < CFG.COL_MIN_BANDS) {
    console.log(`[Column] < ${CFG.COL_MIN_BANDS} bands → already a single column, no isolation`);
    return null;
  }

  const scan = { ...surf, bin: clean };
  let best = null;
  for (const band of bands) {
    const res = scoreColumnBand(band, scan, bank);
    console.log(`[Column] band x=${band.x} w=${band.w}: coverage=${res.coverage.toFixed(2)} valid=${res.valid.toFixed(2)} score=${res.score.toFixed(3)} (${res.reason})`);
    if (res.score > 0 && (!best || res.score > best.score)) best = res;
  }

  if (!best) {
    console.log('[Column] No band matched the MLS # signature — falling back to full image');
    return null;
  }

  /* Pad, then snap to the upscale grid so cropping stays pixel-exact. */
  const pad = CFG.COL_PAD_SRC * CFG.UPSCALE;
  const x0 = Math.max(0, Math.floor((best.band.x - pad) / CFG.UPSCALE) * CFG.UPSCALE);
  const x1 = Math.min(W, Math.ceil((best.band.x + best.band.w + pad) / CFG.UPSCALE) * CFG.UPSCALE);
  console.log(`[Column] Isolated MLS # column at x=${x0}–${x1} (score ${best.score.toFixed(3)})`);
  return { x: x0, w: x1 - x0 };
}

/* ================================================================== */
/*  SECTION 11 — MAIN PIPELINE                                        */
/* ================================================================== */

/**
 * Process all row bands: segment → classify → validate → accept/reject.
 *
 * Uses grayCanvas for glyph extraction (preserves anti-alias).
 * Uses bin (binary array) for segmentation.
 *
 * Returns { accepted, rowResults, allGlyphs }.
 */
function recognizeRows(rows, bin, grayCanvas, bank, tag) {
  const W = grayCanvas.width;
  const minDW = CFG.MIN_DIGIT_W_SRC * CFG.UPSCALE;
  const minDH = CFG.MIN_DIGIT_H_SRC * CFG.UPSCALE;

  const accepted = [];
  const seen = new Set();
  const rowResults = [];
  const allGlyphs = [];

  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];

    /* Segment digits */
    const vP = vProjection(bin, W, row.y, row.h);
    const { segs, method } = findDigitSegments(vP, minDW, 8, bin, W, row);

    const rr = {
      row, segments: segs, segMethod: method,
      digits: [], result: null, status: null,
    };

    if (segs.length !== 8) {
      rr.status = `rejected-segments-${segs.length}`;
      if (segs.length >= 6 && segs.length <= 10) {
        console.log(`[${tag}] Row ${ri} y=${row.y} h=${row.h}: ${segs.length} segs (need 8, skip)`);
      }
      rowResults.push(rr);
      continue;
    }

    /* Classify each digit */
    let num = '';
    let anyAmbiguous = false;

    for (let di = 0; di < 8; di++) {
      const seg = segs[di];
      const bb = tightBBox(bin, W, seg.x, row.y, seg.w, row.h);

      if (!bb || bb.w < 3 || bb.h < minDH) {
        rr.digits.push({
          segBounds: seg, tightBounds: bb, glyphCanvas: null,
          classification: null, status: 'rejected', rejectReason: 'invalid-bounds',
        });
        num += '?';
        anyAmbiguous = true;
        continue;
      }

      /* Normalize from GRAYSCALE canvas */
      const glyph = normalizeGlyph(grayCanvas, bb.x, bb.y, bb.w, bb.h);
      glyph.features = computeStructuralFeatures(glyph.binary, CFG.NORM_W, CFG.NORM_H, glyph.grayscale);

      /* Classify */
      const cls = classifyGlyph(glyph, bank);
      const ambiguity = isAmbiguous(cls);

      rr.digits.push({
        segBounds: { x: seg.x, w: seg.w },
        tightBounds: bb,
        glyphCanvas: glyph.canvas,
        classification: cls,
        status: ambiguity ? 'ambiguous' : 'accepted',
        rejectReason: ambiguity,
      });

      if (ambiguity) {
        anyAmbiguous = true;
        num += '?';
      } else {
        num += String(cls.digit);
        allGlyphs.push({
          digit: cls.digit,
          grayscale: glyph.grayscale,
          binary: glyph.binary,
          features: glyph.features,
          score: cls.score,
          margin: cls.margin,
        });
      }
    }

    rr.result = num;

    /* Per-digit log */
    const flags = rr.digits.map(dd => {
      if (!dd.classification) return '?(no-bbox)';
      const c = dd.classification;
      return `${c.digit}(${c.score.toFixed(2)},Δ${c.margin.toFixed(2)})`;
    }).join(' ');
    console.log(`[${tag}] Row ${ri}: ${num}  [${flags}]`);

    /* Validation */
    if (num.length !== 8 || !/^\d{8}$/.test(num)) {
      rr.status = anyAmbiguous ? 'rejected-ambiguous' : 'rejected-format';
      console.log(`  → REJECTED: ${rr.status}`);
      rowResults.push(rr);
      continue;
    }

    /* Reject rows where any digit has very low confidence (e.g., header rows) */
    const minDigitScore = Math.min(...rr.digits
      .filter(dd => dd.classification)
      .map(dd => dd.classification.score));
    if (minDigitScore < CFG.MIN_DIGIT_SCORE) {
      rr.status = 'rejected-low-confidence';
      console.log(`  → REJECTED: min digit score ${minDigitScore.toFixed(2)} < ${CFG.MIN_DIGIT_SCORE}`);
      rowResults.push(rr);
      continue;
    }

    if (seen.has(num)) {
      rr.status = 'duplicate';
      console.log(`  → SKIP: duplicate`);
      rowResults.push(rr);
      continue;
    }

    console.log(`  → ACCEPTED`);
    seen.add(num);
    accepted.push(num);
    rr.status = 'accepted';
    rowResults.push(rr);
  }

  return { accepted, rowResults, allGlyphs };
}

/**
 * Split character segments that are too wide (merged) at vertical projection minimums.
 */
function splitWideSegments(segs, vP, minW) {
  const maxW = 35; // Maximum width for a single character segment
  const result = [];
  
  for (const seg of segs) {
    if (seg.w >= maxW) {
      // Find the best split point in the middle 50% of the segment
      const lo = seg.x + Math.floor(seg.w * 0.25);
      const hi = seg.x + Math.floor(seg.w * 0.75);
      const center = seg.x + seg.w / 2;
      let minVal = Infinity, minPos = -1;
      
      for (let x = lo; x <= hi; x++) {
        const dist = Math.abs(x - center);
        const val = vP[x] + dist * 1.5;
        if (val < minVal) {
          minVal = val;
          minPos = x;
        }
      }
      
      if (minPos > 0) {
        const left = { x: seg.x, w: minPos - seg.x };
        const right = { x: minPos, w: seg.x + seg.w - minPos };
        
        if (left.w >= minW && right.w >= minW) {
          // Recursively split the children in case there are 3 merged characters
          const leftSplit = splitWideSegments([left], vP, minW);
          const rightSplit = splitWideSegments([right], vP, minW);
          result.push(...leftSplit, ...rightSplit);
          continue;
        }
      }
    }
    result.push(seg);
  }
  return result;
}

/**
 * Process all row bands for the price pipeline: segment → classify → validate → accept/reject.
 */
function recognizePriceRows(rows, bin, grayCanvas, bank, tag) {
  const W = grayCanvas.width;
  const minDW = Math.max(4, Math.floor(CFG.MIN_DIGIT_W_SRC * CFG.UPSCALE / 2));
  const minDH = Math.max(4, Math.floor(CFG.MIN_DIGIT_H_SRC * CFG.UPSCALE / 2));

  const accepted = [];
  const rowResults = [];
  const allGlyphs = [];

  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    const vP = vProjection(bin, W, row.y, row.h);
    let segs = findSegmentsRaw(vP, minDW);
    segs = splitWideSegments(segs, vP, minDW);

    // Stop at space character gap (e.g. space before suffix)
    let priceEndSegIdx = segs.length - 1;
    for (let di = 0; di < segs.length - 1; di++) {
      const gap = segs[di + 1].x - (segs[di].x + segs[di].w);
      if (gap >= 15) { // 3.75 source pixels space gap (safe spacing before suffix)
        priceEndSegIdx = di;
        break;
      }
    }
    const finalSegs = segs.slice(0, priceEndSegIdx + 1);

    // Disregard commas / small noise based on vertical height
    const digitSegs = [];
    for (const seg of finalSegs) {
      const bb = tightBBox(bin, W, seg.x, row.y, seg.w, row.h);
      if (bb && bb.h >= row.h * 0.50) {
        digitSegs.push(seg);
      }
    }

    const rr = {
      row, segments: digitSegs, segMethod: 'raw-projection',
      digits: [], result: null, status: null,
    };

    if (digitSegs.length === 0) {
      rr.status = 'rejected-empty';
      rowResults.push(rr);
      continue;
    }

    let firstDigitIdx = -1;
    let lastDigitIdx = -1;
    const classifiedSegs = [];

    for (let di = 0; di < digitSegs.length; di++) {
      const seg = digitSegs[di];
      const bb = tightBBox(bin, W, seg.x, row.y, seg.w, row.h);

      if (!bb || bb.w < 2 || bb.h < minDH) {
        classifiedSegs.push({
          segBounds: seg, tightBounds: bb, glyphCanvas: null,
          classification: null, status: 'rejected', rejectReason: 'invalid-bounds',
        });
        continue;
      }

      const glyph = normalizeGlyph(grayCanvas, bb.x, bb.y, bb.w, bb.h);
      glyph.features = computeStructuralFeatures(glyph.binary, CFG.NORM_W, CFG.NORM_H, glyph.grayscale);
      const cls = classifyGlyph(glyph, bank);
      const ambiguity = isAmbiguous(cls);

      classifiedSegs.push({
        segBounds: { x: seg.x, w: seg.w },
        tightBounds: bb,
        glyphCanvas: glyph.canvas,
        classification: cls,
        status: ambiguity ? 'ambiguous' : 'accepted',
        rejectReason: ambiguity,
      });

      if (!ambiguity) {
        const char = String(cls.digit);
        if (char !== '$' && char !== ',') {
          if (firstDigitIdx === -1) firstDigitIdx = di;
          lastDigitIdx = di;
        }
      }
    }

    // Validation
    let isValid = true;
    let rejectReason = '';

    if (firstDigitIdx === -1) {
      isValid = false;
      rejectReason = 'no-digits';
    } else {
      // All segments from firstDigitIdx to lastDigitIdx must be accepted digits or commas
      for (let di = firstDigitIdx; di <= lastDigitIdx; di++) {
        const cs = classifiedSegs[di];
        if (cs.status !== 'accepted') {
          isValid = false;
          rejectReason = `invalid-middle-segment-${di}`;
          break;
        }
        const char = String(cs.classification.digit);
        if (char === '$') {
          isValid = false;
          rejectReason = `dollar-in-middle-segment-${di}`;
          break;
        }
      }

      // Check if there is a dollar sign before the first digit
      if (isValid) {
        let dollarFound = false;
        for (let di = 0; di < firstDigitIdx; di++) {
          const cs = classifiedSegs[di];
          if (cs.status === 'accepted' && cs.classification.digit === '$') {
            dollarFound = true;
            break;
          }
        }
        if (!dollarFound) {
          isValid = false;
          rejectReason = 'no-leading-dollar';
        }
      }
    }

    if (!isValid) {
      rr.status = rejectReason;
      rr.digits = classifiedSegs;
      console.log(`[${tag}] Row ${ri} y=${row.y} h=${row.h} → REJECTED: ${rejectReason}`);
      rowResults.push(rr);
      continue;
    }

    // Build the final number string
    let priceStr = '';
    for (let di = firstDigitIdx; di <= lastDigitIdx; di++) {
      const cs = classifiedSegs[di];
      const char = String(cs.classification.digit);
      if (char !== ',') {
        priceStr += char;
      }
    }

    rr.result = priceStr;
    rr.digits = classifiedSegs;

    // Validate length of digits (e.g. $572,000 has 6 digits, $1,050,000 has 7 digits)
    if (priceStr.length < 3 || priceStr.length > 9) {
      rr.status = 'rejected-format';
      console.log(`[${tag}] Row ${ri} y=${row.y} h=${row.h} → REJECTED: length ${priceStr.length}`);
      rowResults.push(rr);
      continue;
    }

    // Check confidence of the digits
    const digitCS = classifiedSegs.slice(firstDigitIdx, lastDigitIdx + 1).filter(cs => cs.classification.digit !== ',');
    const minDigitScore = Math.min(...digitCS.map(cs => cs.classification.score));
    if (minDigitScore < CFG.MIN_DIGIT_SCORE) {
      rr.status = 'rejected-low-confidence';
      console.log(`[${tag}] Row ${ri} y=${row.y} h=${row.h} → REJECTED: min score ${minDigitScore.toFixed(2)} < ${CFG.MIN_DIGIT_SCORE}`);
      rowResults.push(rr);
      continue;
    }

    console.log(`[${tag}] Row ${ri}: ${priceStr} (accepted)`);
    const priceVal = parseInt(priceStr, 10);
    accepted.push(priceVal);
    rr.status = 'accepted';
    rowResults.push(rr);

    // Collect glyph details for potential bank refinement (only digits 0-9)
    for (let di = firstDigitIdx; di <= lastDigitIdx; di++) {
      const cs = classifiedSegs[di];
      const char = cs.classification.digit;
      if (char !== ',' && char !== '$') {
        const bb = cs.tightBounds;
        const glyph = normalizeGlyph(grayCanvas, bb.x, bb.y, bb.w, bb.h);
        allGlyphs.push({
          digit: char,
          grayscale: glyph.grayscale,
          binary: glyph.binary,
          features: cs.classification.features,
          score: cs.classification.score,
        margin: cs.classification.margin,
        });
      }
    }
  }

  return { accepted, rowResults, allGlyphs };
}

/** Calculate the median of an array of numbers. */
function calculateMedian(arr) {
  if (arr.length === 0) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) {
    return sorted[mid];
  }
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Format an integer as a currency string. */
function formatPrice(val) {
  return '$' + val.toLocaleString('en-US');
}

/** Update count badge label and count number dynamically. */
function updateCountBadge(count, isPrice) {
  const numEl = document.getElementById('count-number');
  if (numEl) numEl.textContent = count;
  
  const textNode = Array.from(countBadge.childNodes).find(n => n.nodeType === Node.TEXT_NODE && n.textContent.includes('found'));
  if (textNode) {
    textNode.textContent = isPrice ? ' prices found' : ' MLS numbers found';
  } else {
    countBadge.innerHTML = `<span>🔢</span> <span id="count-number">${count}</span> ${isPrice ? 'prices' : 'MLS numbers'} found`;
  }
}

/** Main extraction pipeline with performance instrumentation. */
async function runExtraction() {
  if (!currentImageBlob) return;

  extractBtn.disabled = true;
  copyBtn.disabled = true;
  resultCard.classList.add('hidden');
  if (debugCard) debugCard.classList.add('hidden');
  countBadge.classList.add('hidden');
  outputBox.value = '';
  clearStatus();
  progressWrap.classList.remove('hidden');
  updateProgress(0);

  const perf = {};

  try {
    Perf.start('total');

    /* --- Templates (lazy init) --- */
    Perf.start('templates');
    showStatus('Loading templates…', 'info');
    const bank = await ensureTemplates();
    perf.templates = Perf.end('templates');
    updateProgress(5);

    /* --- Load & preprocess --- */
    Perf.start('preprocessing');
    showStatus('Preprocessing…', 'info');
    const img = await loadImageFromBlob(currentImageBlob);
    const src = canvasFromImage(img);
    console.log(`\n========== MLS EXTRACT PIPELINE ==========`);
    console.log(`[Pre] Source: ${src.width}×${src.height}`);

    const up = upscaleCanvas(src, CFG.UPSCALE);
    console.log(`[Pre] Upscaled ${CFG.UPSCALE}× → ${up.width}×${up.height}`);

    toGrayscale(up);

    /* Flatten selected-row highlights before the global threshold is chosen,
     * so a shaded band neither swallows its own row nor skews the rest. */
    const shadedBands = normalizeShadedBands(up);
    if (shadedBands.length) {
      console.log(`[Pre] Normalized ${shadedBands.length} shaded band(s): ` +
        shadedBands.map(b => `y=${b.y} h=${b.h} bg=${b.bandBg}→ink=${b.bandFg} ×${b.scale.toFixed(2)}${b.inverted ? ' (inverted)' : ''}`).join('; '));
    }

    const grayCanvas = cloneCanvas(up); /* Keep grayscale for glyph extraction */
    const thr = binarize(up);           /* Binarize for segmentation */
    console.log(`[Pre] Otsu threshold: ${thr}`);
    perf.preprocessing = Perf.end('preprocessing');
    updateProgress(15);

    /* Allow UI to render */
    await new Promise(r => setTimeout(r, 0));

    /* --- Row detection --- */
    Perf.start('segmentation');
    showStatus('Detecting rows…', 'info');
    const bin = getBinary(up);
    const hP = hProjection(bin, up.width, up.height);
    const rawRows = findRows(hP, up.width, CFG.MIN_ROW_DENSITY);
    console.log(`[Seg] ${rawRows.length} raw row bands`);

    const minH = CFG.UPSCALE * 5;
    const maxH = CFG.UPSCALE * 30;
    let rows = rawRows.filter(r => r.h >= minH && r.h <= maxH);
    console.log(`[Seg] ${rows.length} rows after height filter [${minH}–${maxH}px]`);

    /* --- Full-page column isolation ---
     * A multi-column scan is cropped down to the MLS # column, then re-analyzed
     * so binarization and row bands are computed on the isolated column alone. */
    Perf.start('column_isolation');
    let W = up.width, H = up.height;
    const surfInitial = { gray: grayCanvas, bin, W, H, rows, rawRows, thr, minH, maxH };
    const column = isolateMlsColumn(surfInitial, bank);
    if (column) {
      showStatus('Isolating MLS # column…', 'info');
      const cropped = cropCanvas(grayCanvas, column.x, 0, column.w, grayCanvas.height);
      const surfCropped = analyzeSurface(cropped);
      rows = surfCropped.rows;
      W = surfCropped.W;
      H = surfCropped.H;
      console.log(`[Column] Re-analyzed crop ${W}×${H}: Otsu ${surfCropped.thr}, ${rows.length} rows`);
    }
    perf.column_isolation = Perf.end('column_isolation');
    perf.segmentation = Perf.end('segmentation');
    updateProgress(25);

    /* --- Price Pipeline Detection ---
     * Skipped once a column was isolated: that path already committed to MLS #. */
    let isPricePipeline = false;
    let dollarMatches = 0;
    const testRows = column ? [] : rows.slice(0, Math.min(5, rows.length));
    const minDW_price = Math.max(4, Math.floor(CFG.MIN_DIGIT_W_SRC * CFG.UPSCALE / 2));
    const minDH_price = Math.max(4, Math.floor(CFG.MIN_DIGIT_H_SRC * CFG.UPSCALE / 2));

    for (const row of testRows) {
      const vP = vProjection(bin, W, row.y, row.h);
      let segs = findSegmentsRaw(vP, minDW_price);
      segs = splitWideSegments(segs, vP, minDW_price);
      if (segs.length === 0) continue;

      const firstSeg = segs[0];
      const bb = tightBBox(bin, W, firstSeg.x, row.y, firstSeg.w, row.h);
      if (!bb || bb.w < 2 || bb.h < minDH_price) continue;

      const glyph = normalizeGlyph(grayCanvas, bb.x, bb.y, bb.w, bb.h);
      glyph.features = computeStructuralFeatures(glyph.binary, CFG.NORM_W, CFG.NORM_H, glyph.grayscale);
      const cls = classifyGlyph(glyph, bank);

      console.log(`[Detect] row y=${row.y} firstSeg x=${firstSeg.x} w=${firstSeg.w} bb=${bb.w}x${bb.h} → top=${cls.digit} score=${cls.score.toFixed(3)} margin=${cls.margin.toFixed(3)}`);
      console.log(`  Candidates: ${cls.top3.map(c => `${c.d}:${c.combined.toFixed(3)}`).join(', ')}`);
      // Also print specific score for '$' if not in top3
      const dollarScore = cls.allScores.find(s => s.d === '$');
      if (dollarScore) {
        console.log(`  Dollar Score: ${dollarScore.combined.toFixed(3)} (ncc: ${dollarScore.ncc.toFixed(3)}, struct: ${dollarScore.structural.toFixed(3)})`);
      }

      if (cls.digit === '$' && cls.score >= 0.50) {
        dollarMatches++;
      }
    }

    if (dollarMatches >= Math.max(1, Math.min(2, testRows.length))) {
      isPricePipeline = true;
    }
    console.log(`[Pipeline Detection] Dollar sign matches: ${dollarMatches}/${testRows.length} → isPricePipeline = ${isPricePipeline}`);

    if (isPricePipeline) {
      /* --- Price Pipeline --- */
      Perf.start('classification_price');
      showStatus('Recognizing prices…', 'info');
      await new Promise(r => setTimeout(r, 0));

      const priceResult = recognizePriceRows(rows, bin, grayCanvas, bank, 'Price');
      console.log(`[Price] Accepted ${priceResult.accepted.length} prices: ${priceResult.accepted.join(', ')}`);
      perf.classification_p1 = Perf.end('classification_price');
      updateProgress(85);

      const results = priceResult.accepted;
      const finalRowResults = priceResult.rowResults;

      /* --- Accumulate to persistent bank (for next extraction) --- */
      const glyphsForBank = priceResult.allGlyphs;
      let persisted = 0;
      for (const g of glyphsForBank) {
        if (g.score >= CFG.REFINE_SCORE && g.margin >= CFG.REFINE_MARGIN) {
          if (accumulateTemplate(bank, g.digit, g.grayscale, g.binary, g.features, g.score)) {
            persisted++;
          }
        }
      }
      if (persisted > 0) {
        const counts = {};
        for (let d = 0; d <= 9; d++) counts[d] = bank[d].length;
        console.log(`[Bank] Persisted ${persisted} templates. Bank sizes:`, counts);
      }

      perf.total = Perf.end('total');
      updateProgress(100);
      console.log(`==========================================\n`);

      if (!results.length) {
        showStatus('No valid prices detected.', 'error');
        progressWrap.classList.add('hidden');

        /* Still render debug even on failure */
        if (debugCard) {
          Perf.start('debug_render');
          renderDebugOverlay(grayCanvas, finalRowResults);
          renderDebugTable(finalRowResults, perf);
          debugCard.classList.remove('hidden');
          Perf.end('debug_render');
        }
        return;
      }

      // Calculate median
      const median = calculateMedian(results);
      const formattedMedian = formatPrice(median);
      const formattedList = results.map(formatPrice).join(', ');

      outputBox.value = `Extracted Prices: ${formattedList}\nMedian Price: ${formattedMedian}`;
      valueToCopy = formattedMedian;

      resultCard.classList.remove('hidden');
      updateCountBadge(results.length, true);
      countBadge.classList.remove('hidden');
      copyBtn.disabled = false;
      progressWrap.classList.add('hidden');
      await copyToClipboard(valueToCopy);
      showStatus(`Extraction complete — Median price ${formattedMedian} copied to clipboard.`, 'success');

      /* --- Debug rendering --- */
      if (debugCard) {
        Perf.start('debug_render');
        renderDebugOverlay(grayCanvas, finalRowResults);
        renderDebugTable(finalRowResults, perf);
        debugCard.classList.remove('hidden');
        perf.debug_render = Perf.end('debug_render');
      }

    } else {
      /* --- Original MLS# Pipeline --- */
      /* --- Pass 1: reference templates --- */
      Perf.start('classification_p1');
      showStatus('Recognizing digits (pass 1)…', 'info');
      await new Promise(r => setTimeout(r, 0));

      const p1 = recognizeRows(rows, bin, grayCanvas, bank, 'P1');
      console.log(`[P1] Accepted ${p1.accepted.length}: ${p1.accepted.join(', ')}`);
      perf.classification_p1 = Perf.end('classification_p1');
      updateProgress(50);

      /* --- Enhance bank with high-confidence P1 glyphs --- */
      Perf.start('bank_refinement');
      const enhanced = cloneBank(bank);
      let added = 0;
      for (const g of p1.allGlyphs) {
        if (g.score >= CFG.REFINE_SCORE && g.margin >= CFG.REFINE_MARGIN) {
          if (accumulateTemplate(enhanced, g.digit, g.grayscale, g.binary, g.features, g.score)) {
            added++;
          }
        }
      }
      console.log(`[Refine] Added ${added} high-confidence glyphs to enhanced bank`);
      perf.bank_refinement = Perf.end('bank_refinement');

      /* --- Pass 2: enhanced bank --- */
      Perf.start('classification_p2');
      showStatus('Recognizing digits (pass 2)…', 'info');
      await new Promise(r => setTimeout(r, 0));

      const p2 = recognizeRows(rows, bin, grayCanvas, enhanced, 'P2');
      console.log(`[P2] Accepted ${p2.accepted.length}: ${p2.accepted.join(', ')}`);
      perf.classification_p2 = Perf.end('classification_p2');
      updateProgress(85);

      /* --- Conservative P1/P2 merge ---
       * P1 accepted results are NEVER overridden.
       * P2 may ADD numbers from rows that P1 rejected, but only if P2
       * accepted them with all digits having margin ≥ CONFUSABLE_MARGIN. */
      const p1Set = new Set(p1.accepted);
      const mergedResults = [...p1.accepted];
      const mergedRowResults = p1.rowResults.map(rr => ({ ...rr }));
      let p2Additions = 0;

      for (let i = 0; i < p2.rowResults.length; i++) {
        const p2rr = p2.rowResults[i];
        const p1rr = p1.rowResults[i];
        const p1Acc = p1rr.status === 'accepted' || p1rr.status === 'accepted-pass2';
        const p2Acc = p2rr.status === 'accepted' || p2rr.status === 'accepted-pass2';

        if (!p1Acc && p2Acc && p2rr.result && /^\d{8}$/.test(p2rr.result)) {
          const allConfident = p2rr.digits.every(dd =>
            dd.classification && dd.classification.margin >= CFG.CONFUSABLE_MARGIN
          );
          if (allConfident && !p1Set.has(p2rr.result)) {
            mergedResults.push(p2rr.result);
            p1Set.add(p2rr.result);
            mergedRowResults[i] = { ...p2rr, status: 'accepted-pass2' };
            p2Additions++;
            console.log(`[Merge] P2 recovered row ${i}: ${p2rr.result}`);
          }
        }
      }

      const results = mergedResults;
      const finalRowResults = mergedRowResults;
      console.log(`[Result] P1: ${p1.accepted.length}, P2 additions: ${p2Additions}, total: ${results.length}`);

      /* --- Accumulate to persistent bank (for next extraction) --- */
      const glyphsForBank = p1.allGlyphs;
      let persisted = 0;
      for (const g of glyphsForBank) {
        if (g.score >= CFG.REFINE_SCORE && g.margin >= CFG.REFINE_MARGIN) {
          if (accumulateTemplate(bank, g.digit, g.grayscale, g.binary, g.features, g.score)) {
            persisted++;
          }
        }
      }
      if (persisted > 0) {
        const counts = {};
        for (let d = 0; d <= 9; d++) counts[d] = bank[d].length;
        console.log(`[Bank] Persisted ${persisted} templates. Bank sizes:`, counts);
      }

      perf.total = Perf.end('total');
      updateProgress(100);
      console.log(`==========================================\n`);

      /* --- Display results --- */
      if (!results.length) {
        showStatus('No valid 8-digit MLS numbers detected.', 'error');
        progressWrap.classList.add('hidden');

        /* Still render debug even on failure */
        if (debugCard) {
          Perf.start('debug_render');
          renderDebugOverlay(grayCanvas, finalRowResults);
          renderDebugTable(finalRowResults, perf);
          debugCard.classList.remove('hidden');
          Perf.end('debug_render');
        }
        return;
      }

      outputBox.value = results.join(', ');
      valueToCopy = outputBox.value;

      resultCard.classList.remove('hidden');
      updateCountBadge(results.length, false);
      countBadge.classList.remove('hidden');
      copyBtn.disabled = false;
      progressWrap.classList.add('hidden');
      await copyToClipboard(valueToCopy);
      showStatus(`Extraction complete — ${results.length} numbers copied to clipboard.`, 'success');

      /* --- Debug rendering (completely decoupled from classification) --- */
      if (debugCard) {
        Perf.start('debug_render');
        renderDebugOverlay(grayCanvas, finalRowResults);
        renderDebugTable(finalRowResults, perf);
        debugCard.classList.remove('hidden');
        perf.debug_render = Perf.end('debug_render');
      }
    }

  } catch (err) {
    console.error('Pipeline error:', err);
    showStatus(`Extraction failed: ${err.message}`, 'error');
    progressWrap.classList.add('hidden');
  } finally {
    extractBtn.disabled = false;
  }
}

/* ================================================================== */
/*  SECTION 11 — CLIPBOARD, STATUS, PERFORMANCE                       */
/* --- Performance instrumentation --- */
const Perf = {
  _timers: {},
  start(label) { this._timers[label] = performance.now(); },
  end(label) {
    const dt = performance.now() - (this._timers[label] || performance.now());
    console.log(`[Perf] ${label}: ${dt.toFixed(1)}ms`);
    delete this._timers[label];
    return dt;
  },
};

/* --- Clipboard --- */
copyBtn.addEventListener('click', async () => {
  const text = valueToCopy || outputBox.value;
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

/* --- Status messages --- */
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

/* --- Progress bar --- */
function updateProgress(pct) {
  progressFill.style.width = `${pct}%`;
  progressPct.textContent = `${pct}%`;
}
