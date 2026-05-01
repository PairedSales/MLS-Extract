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

// Paste from clipboard (Ctrl+V anywhere)
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

// File input change
fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    handleImageFile(fileInput.files[0]);
  }
});

// Drag & drop visual states
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

// Clear preview
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
  // Reset results when new image loaded
  outputBox.value = '';
  countBadge.classList.add('hidden');
  resultCard.classList.add('hidden');
  clearStatus();
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

/* ===== OCR Extraction ===== */

extractBtn.addEventListener('click', async () => {
  if (!currentImageBlob) return;

  extractBtn.disabled = true;
  copyBtn.disabled = true;
  resultCard.classList.add('hidden');
  countBadge.classList.add('hidden');
  outputBox.value = '';
  clearStatus();

  // Show progress
  progressWrap.classList.remove('hidden');
  updateProgress(0);

  try {
    showStatus('Initializing OCR engine…', 'info');

    const worker = await Tesseract.createWorker('eng', 1, {
      logger: (msg) => {
        if (msg.status === 'recognizing text') {
          updateProgress(Math.round(msg.progress * 100));
        }
      },
    });

    showStatus('Extracting text from image…', 'info');

    const { data: { text } } = await worker.recognize(currentImageBlob);
    await worker.terminate();

    updateProgress(100);

    // Extract 8-digit MLS numbers
    const matches = text.match(/\b\d{8}\b/g) || [];

    if (matches.length === 0) {
      showStatus('No valid MLS numbers detected.', 'error');
      progressWrap.classList.add('hidden');
      extractBtn.disabled = false;
      return;
    }

    const formatted = matches.join(', ');
    outputBox.value = formatted;

    // Show result card & count
    resultCard.classList.remove('hidden');
    countNumber.textContent = matches.length;
    countBadge.classList.remove('hidden');
    copyBtn.disabled = false;

    // Auto-copy
    progressWrap.classList.add('hidden');
    await copyToClipboard(formatted);
  } catch (err) {
    console.error('OCR Error:', err);
    showStatus('Text extraction failed. Try a clearer image.', 'error');
    progressWrap.classList.add('hidden');
  } finally {
    extractBtn.disabled = false;
  }
});

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
    console.warn('Auto-copy failed:', err);
    showStatus('Auto-copy blocked — use the Copy button.', 'error');
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
