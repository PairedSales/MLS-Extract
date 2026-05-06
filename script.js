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

/* ===== Image Preprocessing ===== */

function loadImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(blob);
  });
}

function applyUnsharpMask(imageData, amount = 1.1) {
  const { width, height, data } = imageData;
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0; i < data.length; i += 4) {
    gray[i / 4] = data[i];
  }

  const blurred = new Uint8ClampedArray(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      const sum =
        gray[idx] * 4 +
        gray[idx - 1] + gray[idx + 1] +
        gray[idx - width] + gray[idx + width];
      blurred[idx] = sum / 8;
    }
  }

  for (let i = 0; i < gray.length; i++) {
    const val = Math.max(0, Math.min(255, gray[i] + amount * (gray[i] - blurred[i])));
    const p = i * 4;
    data[p] = data[p + 1] = data[p + 2] = val;
    data[p + 3] = 255;
  }

  return imageData;
}

function otsuThreshold(histogram, totalPixels) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];

  let sumB = 0;
  let wB = 0;
  let maxVariance = 0;
  let threshold = 128;

  for (let t = 0; t < 256; t++) {
    wB += histogram[t];
    if (wB === 0) continue;

    const wF = totalPixels - wB;
    if (wF === 0) break;

    sumB += t * histogram[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const variance = wB * wF * (mB - mF) ** 2;

    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = t;
    }
  }

  return threshold;
}

function preprocessCanvasForOCR(sourceCanvas, scaleFactor) {
  const scaledCanvas = document.createElement('canvas');
  scaledCanvas.width = sourceCanvas.width * scaleFactor;
  scaledCanvas.height = sourceCanvas.height * scaleFactor;
  const sctx = scaledCanvas.getContext('2d', { willReadFrequently: true });
  sctx.imageSmoothingEnabled = false;
  sctx.drawImage(sourceCanvas, 0, 0, scaledCanvas.width, scaledCanvas.height);

  const imageData = sctx.getImageData(0, 0, scaledCanvas.width, scaledCanvas.height);
  const { data } = imageData;

  const histogram = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    const lum = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    const contrasted = Math.max(0, Math.min(255, (lum - 128) * 1.5 + 128));
    data[i] = data[i + 1] = data[i + 2] = contrasted;
    histogram[contrasted]++;
  }

  applyUnsharpMask(imageData, 1.15);

  const threshold = otsuThreshold(histogram, data.length / 4);
  for (let i = 0; i < data.length; i += 4) {
    const pixel = data[i] < threshold ? 0 : 255;
    data[i] = data[i + 1] = data[i + 2] = pixel;
    data[i + 3] = 255;
  }

  sctx.putImageData(imageData, 0, 0);
  return scaledCanvas;
}

async function preprocessImageVariants(blob) {
  const img = await loadImageFromBlob(blob);

  const baseCanvas = document.createElement('canvas');
  baseCanvas.width = img.width;
  baseCanvas.height = img.height;
  const bctx = baseCanvas.getContext('2d');
  bctx.drawImage(img, 0, 0);

  const fullImage = preprocessCanvasForOCR(baseCanvas, 3);

  const columnCrop = document.createElement('canvas');
  const cropX = Math.floor(baseCanvas.width * 0.55);
  const cropW = Math.max(1, Math.floor(baseCanvas.width * 0.45));
  columnCrop.width = cropW;
  columnCrop.height = baseCanvas.height;
  const cctx = columnCrop.getContext('2d');
  cctx.drawImage(baseCanvas, cropX, 0, cropW, baseCanvas.height, 0, 0, cropW, baseCanvas.height);

  const columnImage = preprocessCanvasForOCR(columnCrop, 4);
  return [fullImage, columnImage];
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
    showStatus('Preprocessing image…', 'info');
    const variants = await preprocessImageVariants(currentImageBlob);

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
      preserve_interword_spaces: '0',
      tessedit_pageseg_mode: '6',
      classify_bln_numeric_mode: '1',
      load_system_dawg: '0',
      load_freq_dawg: '0',
    });

    showStatus('Extracting text from image…', 'info');

    const textChunks = [];
    for (const variant of variants) {
      const { data: { text } } = await worker.recognize(variant);
      textChunks.push(text);
    }

    updateProgress(100);

    const combinedText = textChunks.join('\n');
    const matches = combinedText.match(/\b\d{7,8}\b/g) || [];
    const deduped = [];
    const seen = new Set();
    for (const mls of matches) {
      if (!seen.has(mls)) {
        seen.add(mls);
        deduped.push(mls);
      }
    }

    if (deduped.length === 0) {
      showStatus('No valid MLS numbers detected.', 'error');
      progressWrap.classList.add('hidden');
      return;
    }

    const formatted = deduped.join(', ');
    outputBox.value = formatted;
    resultCard.classList.remove('hidden');
    countNumber.textContent = deduped.length;
    countBadge.classList.remove('hidden');
    copyBtn.disabled = false;

    progressWrap.classList.add('hidden');
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
