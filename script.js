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
const EXPECTED_SAMPLE_OUTPUT = '12401432, 12487333, 12349664, 12375820';

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
  return { binary, width, height, threshold, lum };
}

function createStageCanvases(sourceCanvas, binaryMap, col) {
  const { width, height } = sourceCanvas;
  const srcCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  const srcImg = srcCtx.getImageData(0, 0, width, height);

  const grayscale = document.createElement('canvas');
  grayscale.width = width;
  grayscale.height = height;
  const gctx = grayscale.getContext('2d');
  const gData = gctx.createImageData(width, height);
  for (let i = 0, p = 0; i < srcImg.data.length; i += 4, p++) {
    const l = binaryMap.lum[p];
    gData.data[i] = gData.data[i + 1] = gData.data[i + 2] = l;
    gData.data[i + 3] = 255;
  }
  gctx.putImageData(gData, 0, 0);

  const contrast = document.createElement('canvas');
  contrast.width = width;
  contrast.height = height;
  const cctx = contrast.getContext('2d');
  const cData = cctx.createImageData(width, height);
  for (let i = 0, p = 0; i < srcImg.data.length; i += 4, p++) {
    const l = binaryMap.lum[p];
    const boosted = Math.max(0, Math.min(255, (l - 128) * 1.8 + 128));
    cData.data[i] = cData.data[i + 1] = cData.data[i + 2] = boosted;
    cData.data[i + 3] = 255;
  }
  cctx.putImageData(cData, 0, 0);

  const thresholdCanvas = document.createElement('canvas');
  thresholdCanvas.width = width;
  thresholdCanvas.height = height;
  const tctx = thresholdCanvas.getContext('2d');
  const tData = tctx.createImageData(width, height);
  for (let i = 0; i < binaryMap.binary.length; i++) {
    const v = binaryMap.binary[i] ? 0 : 255;
    const p = i * 4;
    tData.data[p] = tData.data[p + 1] = tData.data[p + 2] = v;
    tData.data[p + 3] = 255;
  }
  tctx.putImageData(tData, 0, 0);

  const cropped = document.createElement('canvas');
  cropped.width = col.x1 - col.x0 + 1;
  cropped.height = height;
  const crctx = cropped.getContext('2d');
  crctx.drawImage(thresholdCanvas, col.x0, 0, cropped.width, height, 0, 0, cropped.width, height);

  return { grayscale, contrast, threshold: thresholdCanvas, cropped };
}

function downloadCanvas(canvas, filename) {
  const a = document.createElement('a');
  a.download = filename;
  a.href = canvas.toDataURL('image/png');
  a.click();
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
  const rawRows = [];
  const confidence = [];

  for (const row of rows) {
    const rowText = extractRowDigits(binaryMap, col, row);
    rawRows.push(rowText);
    const matches = rowText.match(/\d{8}/g) || [];
    for (const m of matches) {
      const conf = Math.min(100, Math.round((m.length / Math.max(8, rowText.length)) * 100));
      confidence.push({ value: m, confidence: conf });
      if (!unique.has(m)) {
        unique.add(m);
        ordered.push(m);
      }
    }
  }

  return { ordered, col, rawText: rawRows.join('\n'), regexMatches: ordered, confidence };
}

function printDiagnostics(result) {
  console.log('RAW OCR:\n' + result.rawText);
  console.log('\nREGEX MATCHES:\n' + (result.regexMatches.join('\n') || '(none)'));
  console.log('\nFINAL:\n' + result.ordered.join(', '));
  if (result.confidence.length) {
    console.log('\nCONFIDENCE:');
    result.confidence.forEach((c) => console.log(`${c.value}: ${c.confidence}%`));
  }
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

    const result = extractMLSNumbers(binaryMap);
    const stageCanvases = createStageCanvases(canvas, binaryMap, result.col);
    downloadCanvas(stageCanvases.grayscale, 'grayscale.png');
    downloadCanvas(stageCanvases.contrast, 'contrast.png');
    downloadCanvas(stageCanvases.threshold, 'threshold.png');
    downloadCanvas(stageCanvases.cropped, 'cropped.png');
    printDiagnostics(result);
    updateProgress(100);

    if (!result.ordered.length) {
      showStatus('No valid 8-digit MLS numbers detected.', 'error');
      progressWrap.classList.add('hidden');
      return;
    }

    outputBox.value = result.ordered.join(', ');
    resultCard.classList.remove('hidden');
    countNumber.textContent = result.ordered.length;
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

async function test_ocr(path = 'Sample Data.png') {
  console.log(`Running OCR test on: ${path}`);
  const resp = await fetch(path);
  const blob = await resp.blob();
  const img = await loadImageFromBlob(blob);
  const canvas = canvasFromImage(img);
  const binaryMap = preprocessBinary(canvas);
  const result = extractMLSNumbers(binaryMap);
  const stages = createStageCanvases(canvas, binaryMap, result.col);
  downloadCanvas(stages.grayscale, 'grayscale.png');
  downloadCanvas(stages.contrast, 'contrast.png');
  downloadCanvas(stages.threshold, 'threshold.png');
  downloadCanvas(stages.cropped, 'cropped.png');

  printDiagnostics(result);
  const final = result.ordered.join(', ');
  const expectedSet = new Set(EXPECTED_SAMPLE_OUTPUT.split(', ').map((s) => s.trim()));
  const actualList = result.ordered;
  const actualSet = new Set(actualList);
  const missing = [...expectedSet].filter((x) => !actualSet.has(x));
  const incorrect = actualList.filter((x) => !expectedSet.has(x));
  const duplicates = actualList.filter((x, i) => actualList.indexOf(x) !== i);

  console.log('\nEXPECTED:\n' + EXPECTED_SAMPLE_OUTPUT);
  console.log('ACTUAL:\n' + final);
  if (final === EXPECTED_SAMPLE_OUTPUT && !duplicates.length) {
    console.log('PASS');
  } else {
    console.log('FAIL');
    console.log('Missing values:', missing.length ? missing.join(', ') : '(none)');
    console.log('Incorrect values:', incorrect.length ? incorrect.join(', ') : '(none)');
    console.log('Duplicate values:', duplicates.length ? duplicates.join(', ') : '(none)');
  }
}

window.test_ocr = test_ocr;

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
