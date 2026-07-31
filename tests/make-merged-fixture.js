/*
 * Builds tests/fixtures/clean/merged-glyphs.png — a short, narrow MLS # column.
 *
 * Six real rows cut straight out of MainTest.png. Nothing is synthesized: on a
 * crop this small the global Otsu threshold settles a few levels hotter than it
 * does over the full page, which is enough for the '4' in row 0 to bleed into
 * the '8' beside it and put three glyphs in one ink run. That run is what the
 * segmenter has to split correctly, and a short column is the everyday case —
 * a handful of listings pasted from a grid.
 */

const { loadImage, createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'fixtures', 'clean', 'merged-glyphs.png');

const CROP_Y = 32, CROP_H = 168;   /* rows 0–5 of MainTest.png */

(async () => {
  const src = await loadImage(path.join(ROOT, 'MainTest.png'));
  const canvas = createCanvas(src.width, CROP_H);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, src.width, CROP_H);
  ctx.drawImage(src, 0, CROP_Y, src.width, CROP_H, 0, 0, src.width, CROP_H);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, canvas.toBuffer('image/png'));
  console.log(`Wrote ${OUT} (${src.width}×${CROP_H}, 6 rows from y=${CROP_Y})`);
})();
