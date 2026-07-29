/*
 * Builds tests/fixtures/FullPageTest.png — a multi-column MLS scan.
 *
 * Columns are cut from MainTest.png so the glyphs are real screenshot pixels at
 * the real row pitch; only one column carries all 8 digits. Table rules and row
 * shading are drawn in to exercise gridline suppression and gutter detection.
 */

const { loadImage, createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'fixtures', 'FullPageTest.png');

/* MainTest.png layout (source px): the 8 digits span x=14–65 with inter-digit
 * boundaries at 19, 25, 32, 38, 45, 52, 58. Rows start at y=38, 27px pitch. */
const DIGITS_X = 14;
const ROW_Y0 = 38, ROW_PITCH = 27, ROW_COUNT = 45;

/* [srcX, srcW, destX] — digit count in the comment. Only one column is 8 wide. */
const COLUMNS = [
  [DIGITS_X, 12, 20],   // 2 digits — row index
  [DIGITS_X, 25, 70],   // 4 digits — year built
  [DIGITS_X, 52, 160],  // 8 digits — MLS #  ← the target
  [DIGITS_X, 39, 280],  // 6 digits — sq ft
  [39,       27, 400],  // 4 digits — list price fragment
  [DIGITS_X, 12, 500],  // 2 digits — beds/baths
  [DIGITS_X, 32, 560],  // 5 digits — misc
];

const VRULES = [10, 55, 130, 250, 370, 470, 540, 620];

(async () => {
  const src = await loadImage(path.join(ROOT, 'MainTest.png'));
  const W = 700, H = src.height;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  /* Alternating row shading */
  ctx.fillStyle = '#f5f5f5';
  for (let i = 1; i < ROW_COUNT; i += 2) {
    ctx.fillRect(0, ROW_Y0 + i * ROW_PITCH - 6, W, ROW_PITCH);
  }

  for (const [sx, sw, dx] of COLUMNS) {
    ctx.drawImage(src, sx, 0, sw, H, dx, 0, sw, H);
  }

  /* Table rules: a full-width header rule and vertical column separators */
  ctx.fillStyle = '#9aa0a6';
  ctx.fillRect(0, 29, W, 1);
  for (const gx of VRULES) ctx.fillRect(gx, 0, 1, H);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, canvas.toBuffer('image/png'));
  console.log(`Wrote ${OUT} (${W}×${H}, ${COLUMNS.length} columns)`);
})();
