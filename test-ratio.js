/*
 * Sale-to-list ratio test.
 *
 * (Sold Pr − CONC) ÷ Orig List Pr × 100, to one decimal, read off three crops
 * of the same grid: a three-column grab holding nothing but Sold Pr, CONC and
 * Orig List Pr, the full-width page those columns were cut from, and the narrow
 * grab again with the concessions erased.
 *
 * The first two share rows, so the narrow crop's six ratios must appear among
 * the full page's eighteen — the feature is meant to be indifferent to how much
 * of the grid it is handed. The full page also carries the MLS # column, which
 * keeps the clipboard; the narrow crops have none, so the ratios take it.
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const NARROW = 'tests/fixtures/RatioNarrowTest.png';
const GRID = 'tests/fixtures/RatioGridTest.webp';
const NO_CONC = 'tests/fixtures/ratio/no-concessions.png';
const INDEX = `file://${path.resolve(__dirname, 'index.html')}`;

/* Six rows, each with a concession where the grid shows one. */
const NARROW_RATIOS = ['97.0%', '104.7%', '103.1%', '104.2%', '100.0%', '97.9%'];

/* The same six rows with the CONC column emptied. Only the two rows that had a
 * concession move — 1322.45 off row 1 and 2000 off row 3 — which is what shows
 * the subtraction is really happening rather than the column being ignored. */
const NO_CONC_RATIOS = ['97.3%', '104.7%', '103.6%', '104.2%', '100.0%', '97.9%'];

/* All eighteen closed rows of the full page, in row order. The two active
 * listings at the bottom have no sale price and must not appear. */
const GRID_RATIOS = [
  '115.3%', '103.2%', '95.3%', '95.1%', '93.3%', '104.4%', '95.1%', '93.1%',
  '93.4%', '104.2%', '103.1%', '100.0%', '102.2%', '97.9%', '97.0%', '104.7%',
  '93.5%', '102.7%',
];

/** Run one image through a fresh page so the adaptive bank never carries over. */
async function extract(browser, file) {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', m => { const t = m.text(); if (t.includes('[Ratio]')) logs.push(t); });
  page.on('pageerror', e => logs.push(`PAGEERROR: ${e.message}`));

  await page.goto(INDEX);
  const b64 = fs.readFileSync(path.resolve(__dirname, file)).toString('base64');
  const mime = file.endsWith('.webp') ? 'image/webp' : 'image/png';
  await page.evaluate(async (d, m) => {
    const res = await fetch(`data:${m};base64,${d}`);
    window.handleImageFile(await res.blob());
  }, b64, mime);

  await page.waitForFunction(() => {
    const o = document.querySelector('#output-box').value;
    const s = document.querySelector('#status-area').textContent;
    return o !== '' || s.includes('failed') || s.includes('No valid');
  }, { timeout: 120000 });

  const output = await page.$eval('#output-box', el => el.value);
  const copied = await page.evaluate(() => valueToCopy);
  await page.close();

  const ratioLine = (output.match(/^Sale\/List Ratios: (.*)$/m) || [])[1] || '';
  const mlsLine = (output.match(/^MLS Numbers: (.*)$/m) || [])[1] || '';
  return {
    output, copied, logs,
    ratios: ratioLine ? ratioLine.split(', ') : [],
    numbers: mlsLine ? mlsLine.split(', ') : [],
  };
}

let passed = true;
function check(ok, message) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${message}`);
  if (!ok) passed = false;
}

(async () => {
  console.log('\n========== TESTING SALE-TO-LIST RATIOS ==========');

  for (const f of [NARROW, GRID, NO_CONC]) {
    if (!fs.existsSync(path.resolve(__dirname, f))) {
      console.error(`ERROR: fixture missing — ${f}`
        + (f === NO_CONC ? ' — run "node tests/make-ratio-fixtures.js" first' : ''));
      process.exit(1);
    }
  }

  const browser = await puppeteer.launch({
    args: ['--allow-file-access-from-files', '--disable-web-security']
  });
  const narrow = await extract(browser, NARROW);
  const grid = await extract(browser, GRID);
  const noConc = await extract(browser, NO_CONC);
  await browser.close();

  console.log('\n--- Three-Column Crop ---');
  console.log(narrow.output);
  check(
    narrow.ratios.join(', ') === NARROW_RATIOS.join(', '),
    `narrow crop reads ${NARROW_RATIOS.length} ratios in order `
      + `(got ${narrow.ratios.length}: ${narrow.ratios.join(', ') || 'none'})`
  );
  check(narrow.numbers.length === 0, 'narrow crop reports no MLS numbers — the column is not in the crop');
  check(
    narrow.copied === NARROW_RATIOS.join(', '),
    `narrow crop copies the ratios (got "${narrow.copied}")`
  );

  console.log('\n--- Full Page ---');
  console.log(grid.output);
  check(
    grid.ratios.join(', ') === GRID_RATIOS.join(', '),
    `full page reads ${GRID_RATIOS.length} ratios in order `
      + `(got ${grid.ratios.length}: ${grid.ratios.join(', ') || 'none'})`
  );
  check(grid.numbers.length > 0, `full page also reads the MLS # column (${grid.numbers.length} numbers)`);
  check(
    grid.copied === grid.numbers.join(', '),
    'full page copies the MLS numbers rather than the ratios'
  );

  console.log('\n--- Empty CONC Column ---');
  console.log(noConc.output);
  check(
    noConc.ratios.join(', ') === NO_CONC_RATIOS.join(', '),
    `an empty CONC column still anchors the triple and reads ${NO_CONC_RATIOS.length} ratios `
      + `(got ${noConc.ratios.length}: ${noConc.ratios.join(', ') || 'none'})`
  );
  const moved = NARROW_RATIOS.filter((r, i) => r !== NO_CONC_RATIOS[i]).length;
  check(moved === 2, `exactly the 2 rows with concessions change when CONC is cleared (got ${moved})`);

  console.log('\n--- Parity Between Crops ---');
  const missing = NARROW_RATIOS.filter(r => !grid.ratios.includes(r));
  check(
    missing.length === 0,
    `every ratio from the narrow crop is also read from the full page${missing.length ? ` (missing ${missing.join(', ')})` : ''}`
  );

  const errors = [grid, narrow, noConc].flatMap(r => r.logs.filter(l => l.startsWith('PAGEERROR')));
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);

  console.log('\n=================================================\n');
  process.exit(passed ? 0 : 1);
})();
