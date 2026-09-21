/*
 * Builds tests/fixtures/ratio/no-concessions.png — the three ratio columns for
 * a run of sales where nobody paid a concession.
 *
 * CONC is blank far more often than not, so a crop where it is empty in every
 * row is the ordinary case rather than an edge one. The column is still there,
 * still headed, and still the thing that tells Sold Pr from Orig List Pr — the
 * ratios have to come out all the same, with the concession taken as zero.
 *
 * Prices are the real rows of RatioNarrowTest.png, so the glyphs and the row
 * pitch are screenshot pixels; only the concession values are erased. Each
 * scanline is refilled from its own background, sampled out of the gutter to
 * its left, so the selected row keeps its highlight across the cleared cells.
 */

const { loadImage, createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'fixtures', 'RatioNarrowTest.png');
const OUT = path.join(__dirname, 'fixtures', 'ratio', 'no-concessions.png');

/* Source pixels. The CONC column runs x=76–119 between gutters at 60 and 136;
 * the header sits above y=30, and the data rows start at y=39. */
const CLEAR_X = 66, CLEAR_W = 62, CLEAR_Y = 30;
const SAMPLE_X = 63;               /* gutter between Sold Pr and CONC */

(async () => {
  const src = await loadImage(SRC);
  const canvas = createCanvas(src.width, src.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(src, 0, 0);

  const img = ctx.getImageData(0, 0, src.width, src.height);
  const px = img.data;
  for (let y = CLEAR_Y; y < src.height; y++) {
    const s = (y * src.width + SAMPLE_X) * 4;
    for (let x = CLEAR_X; x < CLEAR_X + CLEAR_W; x++) {
      const d = (y * src.width + x) * 4;
      px[d] = px[s]; px[d + 1] = px[s + 1]; px[d + 2] = px[s + 2]; px[d + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, canvas.toBuffer('image/png'));
  console.log(`Wrote ${OUT} (${src.width}×${src.height}, CONC cleared at x=${CLEAR_X}–${CLEAR_X + CLEAR_W}, y≥${CLEAR_Y})`);
})();
