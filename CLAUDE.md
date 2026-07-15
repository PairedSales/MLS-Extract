# MLS Extract — Project Documentation

## Overview

**MLS Extract** is a high-precision digit recognition system for extracting numeric data from real estate listing images. The system uses **reference-image template matching** instead of traditional OCR, achieving deterministic digit recognition with adaptive template accumulation.

**Key Achievement**: 100% accuracy on test images through hybrid scoring (grayscale Normalized Cross-Correlation + structural feature analysis).

### Supported List Types (auto-detected — no user mode selection)

The pasted/uploaded image is automatically routed to one of three pipelines by `detectListType()` (`script.js`), all sharing the same recognition architecture:

- **MLS numbers** — lists every 8-digit number (original behavior).
- **Sale Prices** — detected by a leading `$` glyph; extracts all values and reports the **median**.
- **Days on Market (DOM)** — short integer lists; extracts all values and reports the **median**.

Median-based types (Sale Price, DOM) share `finishMedianExtraction()` + the `LIST_DISPLAY` config table, so adding a new list type is: write a recognizer, add one `LIST_DISPLAY` entry, add one detection branch. The median (`calculateMedian`) sorts internally, so results are correct regardless of the order values appear in the image.

## Architecture

### Core Components

1. **Reference-Image Template Matching Pipeline** (`script.js` — lines 1–250+)
   - Canonical glyphs extracted from `reference-digits.png` 
   - Adaptive template bank with deduplication (max 16 templates per digit)
   - Multi-threshold hole analysis for structural verification

2. **Hybrid Scoring Mechanism**
   - Normalized Cross-Correlation (NCC): 80% weight
   - Structural features (hole count): 20% weight
   - Confused-pair rejection for [0/9], [3/5], [6/9], [1/7], [8/9]

3. **Image Preprocessing**
   - 4× nearest-neighbor upscaling
   - Contrast stretching
   - Sharpening
   - 24×32px normalization with 2px padding

4. **Segmentation Strategy**
   - Text-region detection via row-density heuristics (min 1.2% dark pixels)
   - Connected-component analysis for digit isolation
   - Distance-weighted split heuristic to prevent false splits through loops (e.g., "8" interior)

5. **Web UI** (`index.html`, `styles.css`)
   - Drag-drop image upload
   - Real-time preview with bounding boxes
   - Debug visualization (segmented rows, template matches, confidence scores)
   - Copy-to-clipboard output

## Key Recent Improvements

- **Distance-weighted split heuristic** (commit 2c04ca7): Prevents erroneous digit splits through looped character interiors
- **Price extraction pipeline** (commits 97d5a6e, bbfd909, 47a85df): Median-based price column extraction with dollar template matching
- **Template-matching digit recognizer** (commit f4107da): Replaced Tesseract.js with deterministic reference-image matching
- **Digit OCR accuracy** (commit ccca462): Resolved 9/0 confusion via contrast normalization and per-digit confidence heuristics

## Configuration (`script.js`, lines 10–59)

Key tunable parameters:

```javascript
MIN_COMBINED: 0.35           // Min combined score threshold
MIN_DIGIT_SCORE: 0.60        // Min for any digit in valid row
MIN_MARGIN: 0.02             // Margin between 1st/2nd candidate
NCC_WEIGHT: 0.8              // NCC vs structural weight split
MAX_TEMPLATES_PER_DIGIT: 16  // Adaptive bank size
UPSCALE: 4                   // Nearest-neighbor upscale
NORM_W: 24, NORM_H: 32       // Normalized digit size
```

Adjust thresholds in CFG for precision vs recall tradeoffs.

## Data Files

- `reference-digits.png` — Canonical glyphs (digits 1–9, 0 in order)
- `MainTest.png` — Primary test image (100% accuracy target)
- `PriceTest.png` — Price extraction test image
- `dollar-ref*.png` — Dollar symbol templates for price extraction

## Testing

Run test suites:

```bash
node test-pup.js       # Puppeteer-based integration tests
node test-baseline.js  # Baseline accuracy tests
node test-price.js     # Price extraction tests
node test-lists.js     # Auto-detection (price/mls/dom) + median order-independence
```

## UI Workflow

1. **Load Image**: Drag/drop or paste from clipboard into the web UI
2. **Preview**: Real-time display with segmented text regions highlighted
3. **Extract**: Click "Extract" to run the pipeline
4. **Debug**: Toggle debug panel to inspect:
   - Row segmentation visualization (canvas)
   - Per-row confidence scores
   - Template match details

## Fallbacks & Flags

- `USE_TESSERACT_FALLBACK: false` — Tesseract.js kept available but disabled; enable for secondary validation only

## Development Notes

- **DOM-centric**: Heavy reliance on canvas manipulation and real-time DOM updates for preview/debug UI
- **Memory-efficient**: Reference image loaded once; templates cached in adaptive bank
- **No external OCR**: Completely self-contained; no API calls or model downloads required
- **Deterministic**: Same input always produces same output (useful for testing and reproducibility)

## Common Tasks

### Adjust Recognition Accuracy
- Tweak `MIN_COMBINED`, `MIN_MARGIN`, `CONFUSABLE_MARGIN` in CFG
- Increase `MAX_TEMPLATES_PER_DIGIT` for more diversity
- Modify `HOLE_MATCH_BOOST` / `HOLE_MISMATCH_PENALTY` for structural weighting

### Debug Failed Extractions
1. Open the UI in a browser (use local HTTP server if needed)
2. Load the failing image
3. Toggle the debug panel to inspect row segmentation and template scores
4. Check console for trace logs

### Add New Test Image
- Place in project root
- Reference in test files or via drag-drop UI
- Run test suite to verify accuracy

## Dependencies

- `puppeteer` (v25.1.0) — Browser automation for integration tests
- `canvas` (v3.2.3) — Image processing and canvas API
- `tesseract.js` (v7.0.0) — OCR fallback (currently disabled)

## Repository

- **GitHub**: https://github.com/PairedSales/MLS-Extract
- **Main Branch**: `main` — always production-ready, 100% test pass

---

**Last Updated**: 2025-06-16  
**Status**: Stable — ready for MLS extraction workflows
