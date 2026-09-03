/*
 * Builds tests/fixtures/shaded/cropped-with-rules.png — a grid column grabbed
 * the way a user actually grabs one.
 *
 * The selection starts on the column separator and cuts through the header, so
 * the crop keeps two cell borders running its full height and the header's
 * underline running its full width. The last row is the selected one; its
 * highlight is painted over the left border, which leaves that rule short of
 * the bottom edge, and reaches the bottom of the image.
 *
 * Digits are real rows cut from MainTest.png, so the glyphs and the row pitch
 * are screenshot pixels; only the chrome around them is drawn in.
 */

const { loadImage, createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'fixtures', 'shaded', 'cropped-with-rules.png');

const CROP_Y = 32, CROP_H = 135;   /* rows 0–4 of MainTest.png */
const HEADER_H = 14;               /* header, clipped through the glyphs */
const ROW_PITCH = 27;

(async () => {
  const src = await loadImage(path.join(ROOT, 'MainTest.png'));
  const W = src.width, H = HEADER_H + CROP_H;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  /* Header, sitting high enough that the crop takes the top off its glyphs */
  ctx.fillStyle = '#333333';
  ctx.font = 'bold 11px sans-serif';
  ctx.fillText('MLS #', 12, 6);
  ctx.fillStyle = '#9aa0a6';
  ctx.fillRect(0, HEADER_H - 2, W, 1);

  ctx.drawImage(src, 0, CROP_Y, W, CROP_H, 0, HEADER_H, W, CROP_H);

  /* Selected row: the last one, running to the bottom edge. Multiplied over
   * the digits so the ink darkens with the fill, as a real highlight does. */
  const bandY = H - ROW_PITCH;
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = '#cfe4f7';
  ctx.fillRect(0, bandY, W, ROW_PITCH);
  ctx.globalCompositeOperation = 'source-over';

  /* Left border stops at the highlight; right border is drawn over it. */
  ctx.fillStyle = '#9aa0a6';
  ctx.fillRect(1, 0, 1, bandY);
  ctx.fillRect(W - 2, 0, 1, H);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, canvas.toBuffer('image/png'));
  console.log(`Wrote ${OUT} (${W}×${H}, 5 rows from y=${CROP_Y}, highlight at y=${bandY})`);
})();
