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
  MIN_MARGIN: 0.02,             // Min gap between 1st and 2nd combined scores
  NCC_WEIGHT: 0.8,              // Weight of NCC in combined score
  STRUCTURAL_WEIGHT: 0.2,       // Weight of structural features in combined score

  /* Confused-pair rejection (stricter margin for known confusable digits) */
  CONFUSABLE_MARGIN: 0.05,
  CONFUSABLE_PAIRS: [
    [0, 9], [0, 8], [3, 5], [3, 8],
    [5, 6], [6, 9], [1, 7],
  ],

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
    let minVal = Infinity, minPos = -1;
    for (let x = lo; x <= hi; x++) {
      if (vP[x] < minVal) { minVal = vP[x]; minPos = x; }
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
 * Load the canonical reference image and segment it into 10 digit templates.
 * The image contains digits in order: 1 2 3 4 5 6 7 8 9 0.
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
    const features = computeStructuralFeatures(glyph.binary, CFG.NORM_W, CFG.NORM_H);

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

  console.log(`[Templates] Bank loaded: 10 digits, 1 template each (reference)`);
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
  for (let d = 0; d <= 9; d++) {
    clone[d] = bank[d].map(t => ({ ...t }));
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
 * Compute structural features from a binary glyph (1 = ink, 0 = bg).
 * Used alongside NCC for robust classification.
 */
function computeStructuralFeatures(binary, W, H) {
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

  /* Hole count via flood-fill */
  const holeCount = countHoles(binary, W, H);

  return { density, upperDensity, lowerDensity, aspectRatio, holeCount };
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
 * Combines grayscale NCC (80%) with structural features (20%).
 *
 * Returns { digit, score, nccScore, structScore, margin, top3, allScores, features }.
 */
function classifyGlyph(glyph, bank) {
  const results = [];

  for (let d = 0; d <= 9; d++) {
    let bestCombined = -Infinity, bestNCC = -Infinity, bestStruct = 0;

    for (const tmpl of bank[d]) {
      const nccS = ncc(glyph.grayscale, tmpl.grayscale);
      const strS = structuralScore(glyph.features, tmpl.features);
      const combined = nccS * CFG.NCC_WEIGHT + strS * CFG.STRUCTURAL_WEIGHT;

      if (combined > bestCombined) {
        bestCombined = combined;
        bestNCC = nccS;
        bestStruct = strS;
      }
    }

    results.push({ d, combined: bestCombined, ncc: bestNCC, structural: bestStruct });
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
 */
function isAmbiguous(result) {
  /* Hard rejection: below minimum thresholds */
  if (result.score < CFG.MIN_COMBINED) return 'score-below-min';
  if (result.margin < CFG.MIN_MARGIN) return 'margin-below-min';

  /* Confused-pair rejection: stricter margin for known confusable pairs */
  const top2 = [result.top3[0].d, result.top3[1].d];
  for (const [a, b] of CFG.CONFUSABLE_PAIRS) {
    if (top2.includes(a) && top2.includes(b)) {
      if (result.margin < CFG.CONFUSABLE_MARGIN) {
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

        /* Holes */
        const tdHoles = document.createElement('td');
        tdHoles.textContent = dd.classification?.features?.holeCount ?? '—';
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
/*  SECTION 10 — MAIN PIPELINE                                        */
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
      glyph.features = computeStructuralFeatures(glyph.binary, CFG.NORM_W, CFG.NORM_H);

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
    const rows = rawRows.filter(r => r.h >= minH && r.h <= maxH);
    console.log(`[Seg] ${rows.length} rows after height filter [${minH}–${maxH}px]`);
    perf.segmentation = Perf.end('segmentation');
    updateProgress(25);

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

    /* --- Choose best result set (anti-poisoning check) --- */
    const p2SupersetOfP1 = p1.accepted.every(n => p2.accepted.includes(n));
    let results, finalRowResults, passUsed;

    if (p2SupersetOfP1 && p2.accepted.length >= p1.accepted.length) {
      results = p2.accepted;
      finalRowResults = p2.rowResults;
      passUsed = 'P2';
    } else {
      results = p1.accepted;
      finalRowResults = p1.rowResults;
      passUsed = 'P1';
      if (!p2SupersetOfP1) {
        console.log('[Result] P2 changed P1 numbers (poisoning risk) — using P1');
      }
    }
    console.log(`[Result] Using ${passUsed}: ${results.length} MLS numbers`);

    /* --- Accumulate to persistent bank (for next extraction) --- */
    const glyphsForBank = passUsed === 'P2' ? p2.allGlyphs : p1.allGlyphs;
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
    resultCard.classList.remove('hidden');
    countNumber.textContent = results.length;
    countBadge.classList.remove('hidden');
    copyBtn.disabled = false;
    progressWrap.classList.add('hidden');
    await copyToClipboard(outputBox.value);
    showStatus(`Extraction complete — ${results.length} numbers copied to clipboard.`, 'success');

    /* --- Debug rendering (completely decoupled from classification) --- */
    if (debugCard) {
      Perf.start('debug_render');
      renderDebugOverlay(grayCanvas, finalRowResults);
      renderDebugTable(finalRowResults, perf);
      debugCard.classList.remove('hidden');
      perf.debug_render = Perf.end('debug_render');
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
/* ================================================================== */

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
