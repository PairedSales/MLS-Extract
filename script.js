/* ===== MLS Extract — Client-Side OCR ===== */

const $ = (sel) => document.querySelector(sel);

// DOM refs
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

let currentImageBlob = null;

const OCR_ROW_CONFIDENCE_MIN = 45;
const ROW_TEXT_DARK_THRESHOLD = 208;
const ROW_MIN_DARK_PIXELS = 3;
const ROW_MIN_HEIGHT = 10;
const ROW_PADDING_Y = 3;
const ROW_MAX_SCAN_RATIO = 0.9;
const COLUMN_SEARCH_START = 0.45;
const COLUMN_SEARCH_END = 0.95;

/* ===== Image Input ===== */

document.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const blob = item.getAsFile();
      handleImageFile(blob);
      return;
    }
  }
});

fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    handleImageFile(fileInput.files[0]);
  }
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  if (e.dataTransfer.files.length > 0) {
    handleImageFile(e.dataTransfer.files[0]);
  }
});

clearBtn.addEventListener('click', () => {
  resetState();
});

function handleImageFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    showStatus('Please provide a valid image file (PNG, JPG).', 'error');
    return;
  }

  currentImageBlob = file;
  const url = URL.createObjectURL(file);
  previewImg.src = url;
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

/* ===== Preprocessing / Segmentation ===== */

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

function cropCanvas(sourceCanvas, x, y, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(w));
  canvas.height = Math.max(1, Math.floor(h));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(sourceCanvas, Math.floor(x), Math.floor(y), Math.floor(w), Math.floor(h), 0, 0, canvas.width, canvas.height);
  return canvas;
}

function scaleCanvas(sourceCanvas, scaleFactor) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(sourceCanvas.width * scaleFactor));
  canvas.height = Math.max(1, Math.floor(sourceCanvas.height * scaleFactor));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sourceCanvas, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function grayscaleCanvas(sourceCanvas) {
  const canvas = cropCanvas(sourceCanvas, 0, 0, sourceCanvas.width, sourceCanvas.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = imageData;
  for (let i = 0; i < data.length; i += 4) {
    const lum = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    data[i] = data[i + 1] = data[i + 2] = lum;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

function sharpenCanvas(sourceCanvas, amount = 0.9) {
  const canvas = grayscaleCanvas(sourceCanvas);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { width, height, data } = imageData;
  const gray = new Uint8ClampedArray(width * height);

  for (let i = 0; i < data.length; i += 4) gray[i / 4] = data[i];

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      const blur = (
        gray[idx] * 4 +
        gray[idx - 1] + gray[idx + 1] +
        gray[idx - width] + gray[idx + width]
      ) / 8;
      const value = Math.max(0, Math.min(255, gray[idx] + amount * (gray[idx] - blur)));
      const p = idx * 4;
      data[p] = data[p + 1] = data[p + 2] = value;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

function detectMlsColumnBounds(baseCanvas) {
  const ctx = baseCanvas.getContext('2d', { willReadFrequently: true });
  const { width, height } = baseCanvas;
  const imageData = ctx.getImageData(0, 0, width, height);
  const { data } = imageData;
  const colDark = new Float32Array(width);

  for (let x = 0; x < width; x++) {
    let score = 0;
    for (let y = 0; y < height; y++) {
      const p = (y * width + x) * 4;
      const lum = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      if (lum < 210) score += (210 - lum);
    }
    colDark[x] = score;
  }

  const start = Math.floor(width * COLUMN_SEARCH_START);
  const end = Math.floor(width * COLUMN_SEARCH_END);
  let bestX = start;
  let bestScore = -1;
  const window = Math.max(30, Math.floor(width * 0.07));

  for (let x = start; x < end - window; x++) {
    let wScore = 0;
    for (let i = 0; i < window; i++) wScore += colDark[x + i];
    if (wScore > bestScore) {
      bestScore = wScore;
      bestX = x;
    }
  }

  const left = Math.max(0, bestX - Math.floor(window * 0.28));
  const right = Math.min(width, bestX + Math.floor(window * 1.35));
  return { x: left, w: Math.max(1, right - left), y: 0, h: height };
}

function detectRowBands(columnCanvas) {
  const gray = grayscaleCanvas(columnCanvas);
  const ctx = gray.getContext('2d', { willReadFrequently: true });
  const { width, height } = gray;
  const { data } = ctx.getImageData(0, 0, width, height);

  const rowActivity = new Uint16Array(height);
  for (let y = 0; y < height; y++) {
    let darkPixels = 0;
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      if (data[p] < ROW_TEXT_DARK_THRESHOLD) darkPixels++;
    }
    rowActivity[y] = darkPixels;
  }

  const maxScanY = Math.floor(height * ROW_MAX_SCAN_RATIO);
  const rows = [];
  let inBand = false;
  let start = 0;

  for (let y = 0; y < maxScanY; y++) {
    const active = rowActivity[y] >= ROW_MIN_DARK_PIXELS;
    if (active && !inBand) {
      inBand = true;
      start = y;
    } else if (!active && inBand) {
      inBand = false;
      const end = y;
      if (end - start >= ROW_MIN_HEIGHT) {
        rows.push({ y0: Math.max(0, start - ROW_PADDING_Y), y1: Math.min(height, end + ROW_PADDING_Y) });
      }
    }
  }

  if (inBand) {
    const end = maxScanY;
    if (end - start >= ROW_MIN_HEIGHT) {
      rows.push({ y0: Math.max(0, start - ROW_PADDING_Y), y1: Math.min(height, end + ROW_PADDING_Y) });
    }
  }

  return rows;
}

function buildOcrVariants(rowCanvas) {
  return [
    { name: 'raw', canvas: rowCanvas },
    { name: 'grayscale', canvas: grayscaleCanvas(rowCanvas) },
    { name: 'enlarged', canvas: scaleCanvas(rowCanvas, 2.2) },
    { name: 'sharpened', canvas: sharpenCanvas(scaleCanvas(rowCanvas, 2.0), 0.95) },
  ];
}

function normalizeMlsDigits(text) {
  const digits = (text || '').replace(/\D+/g, '');
  if (digits.length < 7 || digits.length > 8) return null;
  return digits;
}

/* ===== OCR Extraction ===== */

extractBtn.addEventListener('click', () => runExtraction());

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

  let worker;

  try {
    showStatus('Preparing image and row segments…', 'info');
    const img = await loadImageFromBlob(currentImageBlob);
    const baseCanvas = canvasFromImage(img);
    const column = detectMlsColumnBounds(baseCanvas);
    const columnCanvas = cropCanvas(baseCanvas, column.x, column.y, column.w, column.h);
    const rowBands = detectRowBands(columnCanvas);

    if (!rowBands.length) {
      showStatus('No MLS rows detected in the screenshot.', 'error');
      progressWrap.classList.add('hidden');
      return;
    }

    showStatus('Initializing OCR engine…', 'info');
    worker = await Tesseract.createWorker('eng', 1, {
      logger: (msg) => {
        if (msg.status === 'recognizing text') {
          updateProgress(Math.round(msg.progress * 100));
        }
      },
    });

    await worker.setParameters({
      tessedit_char_whitelist: '0123456789',
      tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
      preserve_interword_spaces: '0',
      classify_bln_numeric_mode: '1',
      load_system_dawg: '0',
      load_freq_dawg: '0',
    });

    showStatus('OCR on each MLS row…', 'info');

    const accepted = [];
    const seen = new Set();

    for (let i = 0; i < rowBands.length; i++) {
      const band = rowBands[i];
      const rowCanvas = cropCanvas(columnCanvas, 0, band.y0, columnCanvas.width, band.y1 - band.y0);
      const variants = buildOcrVariants(rowCanvas);

      let best = { digits: null, confidence: -Infinity };

      for (const variant of variants) {
        const { data: result } = await worker.recognize(variant.canvas);
        const digits = normalizeMlsDigits(result.text);
        const confidence = Number.isFinite(result.confidence) ? result.confidence : -1;
        if (digits && confidence > best.confidence) {
          best = { digits, confidence };
        }
      }

      if (best.digits && best.confidence >= OCR_ROW_CONFIDENCE_MIN && !seen.has(best.digits)) {
        seen.add(best.digits);
        accepted.push(best.digits);
      }

      const pct = Math.round(((i + 1) / rowBands.length) * 100);
      updateProgress(Math.max(1, pct));
    }

    if (accepted.length === 0) {
      showStatus('No valid MLS numbers passed confidence and format checks.', 'error');
      progressWrap.classList.add('hidden');
      return;
    }

    const formatted = accepted.join(', ');
    outputBox.value = formatted;
    resultCard.classList.remove('hidden');
    countNumber.textContent = accepted.length;
    countBadge.classList.remove('hidden');
    copyBtn.disabled = false;
    progressWrap.classList.add('hidden');
    showStatus('Extraction complete.', 'success');
  } catch (err) {
    console.error('OCR Error:', err);
    showStatus('Text extraction failed. Try a clearer image.', 'error');
    progressWrap.classList.add('hidden');
  } finally {
    if (worker) {
      await worker.terminate();
    }
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
    showStatus('Copied to clipboard ✓', 'success');
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

/* ===== UI Helpers ===== */

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
