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

/* ===== Image Preprocessing Helpers ===== */

/**
 * Convert canvas to grayscale and apply contrast normalization.
 * Stretches pixel intensities to full 0-255 range.
 */
function preprocessGrayscaleContrast(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imageData.data;

  // Pass 1: convert to grayscale and find min/max
  let min = 255, max = 0;
  for (let i = 0; i < d.length; i += 4) {
    const gray = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    d[i] = d[i + 1] = d[i + 2] = gray;
    if (gray < min) min = gray;
    if (gray > max) max = gray;
  }

  // Pass 2: histogram stretch to full 0-255 range
  const range = max - min || 1;
  for (let i = 0; i < d.length; i += 4) {
    const stretched = Math.round(((d[i] - min) / range) * 255);
    d[i] = d[i + 1] = d[i + 2] = stretched;
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/**
 * Apply a mild 3×3 unsharp mask to enhance digit edges.
 * strength controls the sharpening intensity (0.5 = conservative).
 */
function applySharpen(canvas, strength = 0.5) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const src = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const dst = ctx.createImageData(canvas.width, canvas.height);
  const s = src.data;
  const d = dst.data;
  const w = canvas.width;
  const h = canvas.height;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      if (y === 0 || y === h - 1 || x === 0 || x === w - 1) {
        // Border pixels: copy as-is
        d[idx] = s[idx]; d[idx+1] = s[idx+1]; d[idx+2] = s[idx+2]; d[idx+3] = s[idx+3];
        continue;
      }
      // 3×3 neighbor average (box blur approximation for unsharp mask)
      for (let c = 0; c < 3; c++) {
        const center = s[idx + c];
        const blur =
          (s[((y-1)*w+(x-1))*4+c] + s[((y-1)*w+x)*4+c] + s[((y-1)*w+(x+1))*4+c] +
           s[(y*w+(x-1))*4+c]     +  center              + s[(y*w+(x+1))*4+c] +
           s[((y+1)*w+(x-1))*4+c] + s[((y+1)*w+x)*4+c] + s[((y+1)*w+(x+1))*4+c]) / 9;
        // Unsharp mask: original + strength * (original - blur)
        d[idx + c] = Math.max(0, Math.min(255, Math.round(center + strength * (center - blur))));
      }
      d[idx + 3] = s[idx + 3]; // alpha
    }
  }

  ctx.putImageData(dst, 0, 0);
  return canvas;
}

/**
 * Resolve low-confidence digits by analyzing glyph pixel density.
 * For 0/9 confusion: a '9' has significantly more dark pixels in the
 * top half than bottom half, while '0' is roughly symmetric.
 * For 0/8 confusion: an '8' has more dark pixels overall (two enclosed regions).
 */
function resolveConfusedDigit(sourceCanvas, bbox, recognizedDigit, confidence) {
  // Only intervene for known confusion pairs at low confidence
  const confusionPairs = { '0': '9', '9': '0', '8': '0', '0b': '8' };
  if (confidence >= 80) return recognizedDigit;
  if (recognizedDigit !== '0' && recognizedDigit !== '9' && recognizedDigit !== '8') return recognizedDigit;

  try {
    const ctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
    const x = Math.max(0, bbox.x0);
    const y = Math.max(0, bbox.y0);
    const w = Math.min(bbox.x1 - bbox.x0, sourceCanvas.width - x);
    const h = Math.min(bbox.y1 - bbox.y0, sourceCanvas.height - y);
    if (w <= 0 || h <= 0) return recognizedDigit;

    const glyphData = ctx.getImageData(x, y, w, h).data;
    const midY = Math.floor(h / 2);
    let topDark = 0, bottomDark = 0, totalPixels = 0;

    for (let gy = 0; gy < h; gy++) {
      for (let gx = 0; gx < w; gx++) {
        const idx = (gy * w + gx) * 4;
        const intensity = glyphData[idx]; // already grayscale
        if (intensity < 128) { // dark pixel
          if (gy < midY) topDark++;
          else bottomDark++;
        }
        totalPixels++;
      }
    }

    const totalDark = topDark + bottomDark;
    if (totalDark === 0) return recognizedDigit;

    const topRatio = topDark / totalDark;
    const bottomRatio = bottomDark / totalDark;

    console.log(`  Glyph analysis for '${recognizedDigit}' (conf=${confidence.toFixed(1)}%): ` +
      `topDark=${topDark}, bottomDark=${bottomDark}, topRatio=${topRatio.toFixed(3)}, bottomRatio=${bottomRatio.toFixed(3)}`);

    // 0 vs 9 resolution:
    // '9' has a closed loop on top + tail on bottom-right, so top-heavy dark pixels (topRatio > 0.58)
    // '0' is roughly symmetric vertically (topRatio ≈ 0.45-0.55)
    if (recognizedDigit === '0' || recognizedDigit === '9') {
      if (topRatio > 0.58) {
        if (recognizedDigit !== '9') {
          console.log(`  → Correcting '${recognizedDigit}' to '9' (top-heavy glyph)`);
          return '9';
        }
      } else if (topRatio >= 0.40 && topRatio <= 0.55) {
        if (recognizedDigit !== '0') {
          console.log(`  → Correcting '${recognizedDigit}' to '0' (symmetric glyph)`);
          return '0';
        }
      }
    }
  } catch (e) {
    console.warn('Glyph analysis failed:', e);
  }
  return recognizedDigit;
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
    
    // Phase 1: Detect MLS Header (Column Detection) — full-page OCR pass
    const { data: fullData } = await worker.recognize(canvas);
    console.log('--- RAW OCR FULL OUTPUT ---');
    console.log(fullData.text);
    console.log('---------------------------');
    
    let headerBox = null;
    
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
      // Phase 2: Find rows aligned with MLS header X-coordinate
      for (const line of fullData.lines) {
        const txt = line.text.toUpperCase();
        if (txt.includes('MLS') || txt.includes('MS#')) continue;
        const center = (line.bbox.x0 + line.bbox.x1) / 2;
        if (center >= headerBox.x0 - 50 && center <= headerBox.x1 + 50) {
          rowsToCrop.push(line.bbox);
        }
      }
    } else {
      console.warn('Column detection failed: MLS header not found. Falling back to all potential number rows.');
      for (const line of fullData.lines) {
        if (/\d/.test(line.text)) rowsToCrop.push(line.bbox);
      }
    }
    
    console.log('Row detection: Found', rowsToCrop.length, 'rows.');

    // Phase 3: Configure Tesseract for digit-only recognition
    await worker.setParameters({
      tessedit_char_whitelist: '0123456789',
      tessedit_pageseg_mode: '7',  // PSM 7: single text line (better for fixed-format numbers)
    });

    const orderedResults = [];
    const unique = new Set();
    
    // Phase 4: Crop, preprocess, and OCR individual rows
    for (let i = 0; i < rowsToCrop.length; i++) {
      const bbox = rowsToCrop[i];
      const pad = 8;
      const cropW = bbox.x1 - bbox.x0 + pad * 2;
      const cropH = bbox.y1 - bbox.y0 + pad * 2;
      
      // Step 1: Upscale 4x with nearest-neighbor (preserves sharp digit edges)
      const scale = 4;
      const rowCanvas = document.createElement('canvas');
      rowCanvas.width = cropW * scale;
      rowCanvas.height = cropH * scale;
      const ctx = rowCanvas.getContext('2d', { willReadFrequently: true });
      
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, rowCanvas.width, rowCanvas.height);
      
      // CRITICAL FIX: nearest-neighbor upscale preserves the '9' tail
      // that bilinear smoothing was destroying
      ctx.imageSmoothingEnabled = false;
      
      const srcX = Math.max(0, bbox.x0 - pad);
      const srcY = Math.max(0, bbox.y0 - pad);
      ctx.drawImage(canvas, srcX, srcY, cropW, cropH, 0, 0, cropW * scale, cropH * scale);
      
      // Step 3: Grayscale + contrast normalization
      preprocessGrayscaleContrast(rowCanvas);
      
      // Step 4: Mild sharpening to enhance digit edges
      applySharpen(rowCanvas, 0.5);
      
      showStatus(`Processing row ${i+1}/${rowsToCrop.length}...`, 'info');
      updateProgress(20 + Math.round((i / rowsToCrop.length) * 80));
      
      const { data: rowData } = await worker.recognize(rowCanvas);
      const rawText = rowData.text.trim();
      console.log(`Raw OCR Output [Row ${i}]:`, rawText, `(confidence: ${rowData.confidence}%)`);
      
      // Step 5: Parse with per-digit confidence heuristics
      const matches = rawText.match(/\b\d{8}\b/g) || [];
      
      // Extract all symbols from the Tesseract.js nested result hierarchy
      const allSymbols = [];
      if (rowData.lines) {
        for (const line of rowData.lines) {
          for (const word of (line.words || [])) {
            for (const sym of (word.symbols || [])) {
              allSymbols.push(sym);
            }
          }
        }
      }
      
      for (const m of matches) {
        let correctedNumber = m;
        
        // Check per-symbol confidence and resolve confused digits
        if (allSymbols.length >= 8) {
          // Filter to digit symbols only
          const digitSymbols = allSymbols.filter(
            s => s.text >= '0' && s.text <= '9'
          );
          
          if (digitSymbols.length >= 8) {
            const digits = correctedNumber.split('');
            let corrected = false;
            
            for (let d = 0; d < 8 && d < digitSymbols.length; d++) {
              const sym = digitSymbols[d];
              const conf = sym.confidence;
              
              if (conf < 80) {
                console.log(`  Low confidence digit [${d}]: '${sym.text}' = ${conf.toFixed(1)}%`);
                const resolved = resolveConfusedDigit(rowCanvas, sym.bbox, sym.text, conf);
                if (resolved !== sym.text) {
                  digits[d] = resolved;
                  corrected = true;
                }
              }
            }
            
            if (corrected) {
              correctedNumber = digits.join('');
              console.log(`  Corrected: ${m} → ${correctedNumber}`);
            }
          }
        }
        
        if (/^\d{8}$/.test(correctedNumber) && !unique.has(correctedNumber)) {
          unique.add(correctedNumber);
          orderedResults.push(correctedNumber);
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
