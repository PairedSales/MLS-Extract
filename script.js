/* ===== MLS Extract — Deterministic 8-Digit OCR ===== */

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

const DIGIT_RENDER_W = 24;
const DIGIT_RENDER_H = 36;

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

function preprocessBinary(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width, height } = canvas;
  const img = ctx.getImageData(0, 0, width, height);
  const d = img.data;

  let sum = 0;
  let sq = 0;
  const lum = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const l = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    lum[p] = l;
    sum += l;
    sq += l * l;
  }

  const mean = sum / lum.length;
  const variance = Math.max(1, sq / lum.length - mean * mean);
  const std = Math.sqrt(variance);
  const threshold = Math.max(40, Math.min(190, mean - std * 0.55));

  const binary = new Uint8Array(width * height);
  for (let i = 0; i < lum.length; i++) binary[i] = lum[i] < threshold ? 1 : 0;
  return { binary, width, height };
}

function findMLSColumn(binaryMap) {
  const { binary, width, height } = binaryMap;
  const colInk = new Float32Array(width);

  for (let x = 0; x < width; x++) {
    let ink = 0;
    for (let y = 0; y < height; y++) ink += binary[y * width + x];
    colInk[x] = ink / height;
  }

  const windowW = Math.max(80, Math.floor(width * 0.18));
  let bestStart = 0;
  let bestScore = -1;
  let rolling = 0;

  for (let x = 0; x < width; x++) {
    rolling += colInk[x];
    if (x >= windowW) rolling -= colInk[x - windowW];
    if (x >= windowW - 1 && rolling > bestScore) {
      bestScore = rolling;
      bestStart = x - windowW + 1;
    }
  }

  return {
    x0: Math.max(0, bestStart - 10),
    x1: Math.min(width - 1, bestStart + windowW + 10)
  };
}

function detectTextRows(binaryMap, col) {
  const { binary, width, height } = binaryMap;
  const yInk = new Float32Array(height);
  const span = Math.max(1, col.x1 - col.x0 + 1);

  for (let y = 0; y < height; y++) {
    let ink = 0;
    for (let x = col.x0; x <= col.x1; x++) ink += binary[y * width + x];
    yInk[y] = ink / span;
  }

  const rows = [];
  const minInk = 0.03;
  let start = -1;
  for (let y = 0; y < height; y++) {
    if (yInk[y] > minInk && start === -1) start = y;
    if ((yInk[y] <= minInk || y === height - 1) && start !== -1) {
      const end = yInk[y] <= minInk ? y - 1 : y;
      if (end - start >= 10) rows.push({ y0: Math.max(0, start - 2), y1: Math.min(height - 1, end + 2) });
      start = -1;
    }
  }
  return rows;
}

function renderDigitTemplate(char) {
  const c = document.createElement('canvas');
  c.width = DIGIT_RENDER_W;
  c.height = DIGIT_RENDER_H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#000';
  ctx.font = '700 32px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(char, c.width / 2, c.height / 2 + 1);
  return toBinary(c);
}

function toBinary(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width, height } = canvas;
  const { data } = ctx.getImageData(0, 0, width, height);
  const out = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i += 4) out[i / 4] = data[i] < 128 ? 1 : 0;
  return { data: out, width, height };
}

const DIGIT_TEMPLATES = Array.from({ length: 10 }, (_, d) => ({ digit: String(d), bmp: renderDigitTemplate(String(d)) }));

function extractRowDigits(binaryMap, col, row) {
  const { binary, width } = binaryMap;
  const rowW = col.x1 - col.x0 + 1;
  const rowH = row.y1 - row.y0 + 1;

  const xInk = new Float32Array(rowW);
  for (let x = col.x0; x <= col.x1; x++) {
    let ink = 0;
    for (let y = row.y0; y <= row.y1; y++) ink += binary[y * width + x];
    xInk[x - col.x0] = ink / rowH;
  }

  const segments = [];
  let start = -1;
  for (let i = 0; i < xInk.length; i++) {
    if (xInk[i] > 0.05 && start === -1) start = i;
    if ((xInk[i] <= 0.05 || i === xInk.length - 1) && start !== -1) {
      const end = xInk[i] <= 0.05 ? i - 1 : i;
      if (end - start + 1 >= 4) segments.push({ x0: col.x0 + start, x1: col.x0 + end });
      start = -1;
    }
  }

  let text = '';
  for (const seg of segments) {
    const digitCanvas = document.createElement('canvas');
    digitCanvas.width = seg.x1 - seg.x0 + 1;
    digitCanvas.height = rowH;
    const dctx = digitCanvas.getContext('2d');
    const out = dctx.createImageData(digitCanvas.width, digitCanvas.height);

    for (let y = 0; y < rowH; y++) {
      for (let x = 0; x < digitCanvas.width; x++) {
        const src = (row.y0 + y) * width + (seg.x0 + x);
        const v = binary[src] ? 0 : 255;
        const p = (y * digitCanvas.width + x) * 4;
        out.data[p] = out.data[p + 1] = out.data[p + 2] = v;
        out.data[p + 3] = 255;
      }
    }
    dctx.putImageData(out, 0, 0);
    text += matchDigit(digitCanvas);
  }

  return text;
}

function matchDigit(canvas) {
  const c = document.createElement('canvas');
  c.width = DIGIT_RENDER_W;
  c.height = DIGIT_RENDER_H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(canvas, 0, 0, DIGIT_RENDER_W, DIGIT_RENDER_H);
  const candidate = toBinary(c);

  let bestDigit = '0';
  let best = Number.POSITIVE_INFINITY;
  for (const t of DIGIT_TEMPLATES) {
    let diff = 0;
    for (let i = 0; i < candidate.data.length; i++) if (candidate.data[i] !== t.bmp.data[i]) diff++;
    if (diff < best) {
      best = diff;
      bestDigit = t.digit;
    }
  }
  return bestDigit;
}

function extractMLSNumbers(binaryMap) {
  const col = findMLSColumn(binaryMap);
  const rows = detectTextRows(binaryMap, col);
  const unique = new Set();
  const ordered = [];

  for (const row of rows) {
    const rowText = extractRowDigits(binaryMap, col, row);
    const matches = rowText.match(/\b\d{8}\b/g) || [];
    for (const m of matches) {
      if (!unique.has(m)) {
        unique.add(m);
        ordered.push(m);
      }
    }
  }

  return ordered;
}

/* ===== OCR Extraction ===== */

async function runExtraction() {
  if (!currentImageBlob) return;

  extractBtn.disabled = true;
  copyBtn.disabled = true;
  resultCard.classList.add('hidden');
  countBadge.classList.add('hidden');
  outputBox.value = '';
  clearStatus();
  progressWrap.classList.remove('hidden');
  updateProgress(10);

  try {
    showStatus('Running deterministic OCR pipeline…', 'info');
    const img = await loadImageFromBlob(currentImageBlob);
    const canvas = canvasFromImage(img);
    updateProgress(35);

    const binaryMap = preprocessBinary(canvas);
    updateProgress(65);

    const results = extractMLSNumbers(binaryMap);
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
    showStatus('Extraction complete and copied to clipboard.', 'success');
  } catch (err) {
    console.error('OCR Error:', err);
    showStatus('Text extraction failed. Try a clearer image.', 'error');
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
