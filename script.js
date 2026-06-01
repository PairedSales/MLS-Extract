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
  updateProgress(0);

  let worker = null;

  try {
    showStatus('Loading Tesseract...', 'info');
    worker = await Tesseract.createWorker('eng', 1, {
      logger: m => {
        if (m.status === 'recognizing text') updateProgress(Math.round(m.progress * 20));
      }
    });

    const img = await loadImageFromBlob(currentImageBlob);
    const canvas = canvasFromImage(img);

    showStatus('Finding column header...', 'info');
    
    // Step 1: Detect MLS Header (Column Detection)
    const { data: fullData } = await worker.recognize(canvas);
    console.log('--- RAW OCR FULL OUTPUT ---');
    console.log(fullData.text);
    console.log('---------------------------');
    
    let headerBox = null;
    let fallbackColumnX = 0;
    
    for (const line of fullData.lines) {
      const txt = line.text.toUpperCase();
      if (txt.includes('MLS') || txt.includes('MS#')) {
        headerBox = line.bbox;
        console.log('MLS Header Found At:', headerBox);
        break;
      }
    }
    
    let rowsToCrop = [];
    
    if (headerBox) {
      // Step 2: Stop using geometric column detection. Find rows aligned with MLS header X-coordinate.
      for (const line of fullData.lines) {
        const txt = line.text.toUpperCase();
        if (txt.includes('MLS') || txt.includes('MS#')) continue;
        const center = (line.bbox.x0 + line.bbox.x1) / 2;
        // Check if aligned with header
        if (center >= headerBox.x0 - 50 && center <= headerBox.x1 + 50) {
          rowsToCrop.push(line.bbox);
        }
      }
    } else {
      console.warn('Column detection failed: MLS header not found. Falling back to all potential number rows.');
      // Fallback: take any line that looks like it has numbers
      for (const line of fullData.lines) {
        if (/\d/.test(line.text)) rowsToCrop.push(line.bbox);
      }
    }
    
    console.log('Row detection: Found', rowsToCrop.length, 'rows.');

    // Step 3: Restrict recognition to digits only and set PSM to single word
    await worker.setParameters({
      tessedit_char_whitelist: '0123456789',
      tessedit_pageseg_mode: '8',
    });

    const orderedResults = [];
    const unique = new Set();
    
    // Step 4: Crop, scale, and OCR individual rows
    for (let i = 0; i < rowsToCrop.length; i++) {
      const bbox = rowsToCrop[i];
      const pad = 8;
      const cropW = bbox.x1 - bbox.x0 + pad * 2;
      const cropH = bbox.y1 - bbox.y0 + pad * 2;
      
      // Upscale 3x to improve Tesseract accuracy for small digits
      const scale = 3;
      const rowCanvas = document.createElement('canvas');
      rowCanvas.width = cropW * scale;
      rowCanvas.height = cropH * scale;
      const ctx = rowCanvas.getContext('2d');
      
      // Fill background white
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, rowCanvas.width, rowCanvas.height);
      
      // Smooth interpolation often helps Tesseract read upscaled small web fonts
      ctx.imageSmoothingEnabled = true;
      
      const srcX = Math.max(0, bbox.x0 - pad);
      const srcY = Math.max(0, bbox.y0 - pad);
      ctx.drawImage(canvas, srcX, srcY, cropW, cropH, 0, 0, cropW * scale, cropH * scale);
      
      showStatus(`Processing row ${i+1}/${rowsToCrop.length}...`, 'info');
      updateProgress(20 + Math.round((i / rowsToCrop.length) * 80));
      
      const { data: rowData } = await worker.recognize(rowCanvas);
      const rawText = rowData.text.trim();
      console.log(`Raw OCR Output [Row ${i}]:`, rawText);
      
      // Step 5: Parsing & Validation
      const matches = rawText.match(/\b\d{8}\b/g) || [];
      for (const m of matches) {
        if (!unique.has(m)) {
          unique.add(m);
          orderedResults.push(m);
        }
      }
    }
    
    updateProgress(100);

    if (!orderedResults.length) {
      showStatus('No valid 8-digit MLS numbers detected.', 'error');
      progressWrap.classList.add('hidden');
      return;
    }

    outputBox.value = orderedResults.join(', ');
    resultCard.classList.remove('hidden');
    countNumber.textContent = orderedResults.length;
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
    if (worker) await worker.terminate();
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
