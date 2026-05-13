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

const MIN_BLOB_AREA = 20;
const MAX_BLOB_WIDTH_RATIO = 0.18;
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

/* ===== Deterministic OCR Core ===== */

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

function buildBinaryMap(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width, height } = canvas;
  const { data } = ctx.getImageData(0, 0, width, height);
  const binary = new Uint8Array(width * height);

  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    sum += lum;
  }
  const avgLum = sum / (width * height);
  const threshold = Math.max(45, Math.min(170, avgLum - 35));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const lum = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      binary[y * width + x] = lum < threshold ? 1 : 0;
    }
  }

  return { binary, width, height };
}

function connectedComponents(binary, width, height) {
  const visited = new Uint8Array(width * height);
  const blobs = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = y * width + x;
      if (!binary[start] || visited[start]) continue;

      const stack = [start];
      visited[start] = 1;
      let minX = x, maxX = x, minY = y, maxY = y, area = 0;

      while (stack.length) {
        const idx = stack.pop();
        const px = idx % width;
        const py = Math.floor(idx / width);
        area++;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;

        const neighbors = [idx - 1, idx + 1, idx - width, idx + width];
        for (const n of neighbors) {
          if (n < 0 || n >= binary.length || visited[n] || !binary[n]) continue;
          const nx = n % width;
          if (Math.abs(nx - px) > 1) continue;
          visited[n] = 1;
          stack.push(n);
        }
      }

      const w = maxX - minX + 1;
      const h = maxY - minY + 1;
      if (area >= MIN_BLOB_AREA && h > 8 && w > 2 && w <= width * MAX_BLOB_WIDTH_RATIO) {
        blobs.push({ x: minX, y: minY, w, h, area });
      }
    }
  }

  return blobs.sort((a, b) => (a.y - b.y) || (a.x - b.x));
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

function cropToCanvas(binaryMap, blob) {
  const c = document.createElement('canvas');
  c.width = blob.w;
  c.height = blob.h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(blob.w, blob.h);
  for (let y = 0; y < blob.h; y++) {
    for (let x = 0; x < blob.w; x++) {
      const src = (blob.y + y) * binaryMap.width + (blob.x + x);
      const v = binaryMap.binary[src] ? 0 : 255;
      const p = (y * blob.w + x) * 4;
      img.data[p] = img.data[p + 1] = img.data[p + 2] = v;
      img.data[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function resizeBinary(srcCanvas, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(srcCanvas, 0, 0, w, h);
  return toBinary(c);
}

function matchDigit(blobCanvas) {
  const candidate = resizeBinary(blobCanvas, DIGIT_RENDER_W, DIGIT_RENDER_H);
  let best = { digit: null, score: Number.POSITIVE_INFINITY, second: Number.POSITIVE_INFINITY };

  for (const t of DIGIT_TEMPLATES) {
    let diff = 0;
    for (let i = 0; i < candidate.data.length; i++) {
      if (candidate.data[i] !== t.bmp.data[i]) diff++;
    }
    if (diff < best.score) {
      best.second = best.score;
      best.score = diff;
      best.digit = t.digit;
    } else if (diff < best.second) {
      best.second = diff;
    }
  }

  // Deterministic ambiguity handling: 3/8 and 1/7
  const margin = best.second - best.score;
  if ((best.digit === '8' || best.digit === '3') && margin < 28) {
    best.digit = disambiguate38(candidate);
  }
  if ((best.digit === '1' || best.digit === '7') && margin < 24) {
    best.digit = disambiguate17(candidate);
  }

  return { digit: best.digit, confidence: 1 - best.score / candidate.data.length };
}

function disambiguate38(bmp) {
  let midGap = 0;
  const midY = Math.floor(bmp.height / 2);
  for (let x = 0; x < bmp.width; x++) midGap += bmp.data[midY * bmp.width + x];
  return midGap > bmp.width * 0.55 ? '8' : '3';
}

function disambiguate17(bmp) {
  let topBar = 0;
  for (let y = 0; y < Math.floor(bmp.height * 0.2); y++) {
    for (let x = 0; x < bmp.width; x++) topBar += bmp.data[y * bmp.width + x];
  }
  return topBar > bmp.width * 2.2 ? '7' : '1';
}

function extractEightDigitSequences(blobs, binaryMap) {
  const annotated = blobs.map((blob) => {
    const { digit, confidence } = matchDigit(cropToCanvas(binaryMap, blob));
    return { ...blob, digit, confidence, cx: blob.x + blob.w / 2, cy: blob.y + blob.h / 2 };
  });

  annotated.sort((a, b) => (a.cy - b.cy) || (a.cx - b.cx));
  const sequences = [];

  for (let i = 0; i <= annotated.length - 8; i++) {
    const group = annotated.slice(i, i + 8);
    const ySpread = Math.max(...group.map((d) => d.cy)) - Math.min(...group.map((d) => d.cy));
    if (ySpread > Math.max(...group.map((d) => d.h)) * 0.65) continue;

    const gaps = [];
    for (let g = 1; g < group.length; g++) gaps.push(group[g].x - (group[g - 1].x + group[g - 1].w));
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    if (avgGap < -2 || avgGap > 20) continue;

    const text = group.map((d) => d.digit).join('');
    if (/^\d{8}$/.test(text)) {
      const avgConf = group.reduce((a, b) => a + b.confidence, 0) / group.length;
      sequences.push({ text, y: group[0].y, x: group[0].x, conf: avgConf });
    }
  }

  const unique = new Map();
  for (const s of sequences.sort((a, b) => (a.y - b.y) || (a.x - b.x))) {
    if (!unique.has(s.text)) unique.set(s.text, s);
  }

  return [...unique.values()].sort((a, b) => (a.y - b.y) || (a.x - b.x)).map((s) => s.text);
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
    showStatus('Running deterministic digit scan…', 'info');
    const img = await loadImageFromBlob(currentImageBlob);
    const canvas = canvasFromImage(img);
    updateProgress(40);
    const binaryMap = buildBinaryMap(canvas);
    const blobs = connectedComponents(binaryMap.binary, binaryMap.width, binaryMap.height);
    updateProgress(70);
    const results = extractEightDigitSequences(blobs, binaryMap);
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
    showStatus('Extraction complete.', 'success');
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
