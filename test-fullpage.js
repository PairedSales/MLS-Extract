/*
 * Full-page column isolation test.
 *
 * Feeds a multi-column scan (tests/fixtures/FullPageTest.png) through the app and
 * checks the MLS # column is isolated and read.
 *
 * The pass criterion is parity with MainTest.png — the same column, cropped by
 * hand — so this test measures the isolation stage rather than the recognizer's
 * standing accuracy. The reference list is reported for information only.
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const EXPECTED = [
  '12548300', '12630428', '12272485', '12513418', '12487613',
  '12391601', '12573657', '12600214', '12596916', '12540716',
  '12339497', '12613469', '12556758', '12630698', '12548598',
  '12331351', '12592089', '12387129', '12157315', '12404968',
  '12636048', '12404929', '12379575', '12604577', '12279065',
  '12530928', '12556801', '12661287', '12645438', '12556782',
  '12625133', '12631135', '12588798', '12647624', '12592073',
  '12507734', '12283602', '12573795', '12610831', '12641801',
  '12474712', '12378723', '12381989', '12603764', '12463722',
];

const FULLPAGE = path.resolve(__dirname, 'tests/fixtures/FullPageTest.png');
const CROPPED = path.resolve(__dirname, 'MainTest.png');
const INDEX = `file://${path.resolve(__dirname, 'index.html')}`;

/** Run one image through a fresh page so the adaptive bank never carries over. */
async function extract(browser, file, collectLogs) {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', msg => {
    const t = msg.text();
    if (collectLogs && (t.includes('[Column]') || t.includes('[Seg]') || t.includes('[Pre]'))) logs.push(t);
  });

  await page.goto(INDEX);
  const imgData = fs.readFileSync(file).toString('base64');
  await page.evaluate(async (b64) => {
    const res = await fetch(`data:image/png;base64,${b64}`);
    window.handleImageFile(await res.blob());
  }, imgData);

  await page.waitForFunction(() => {
    const output = document.querySelector('#output-box').value;
    const status = document.querySelector('#status-area').textContent;
    return output !== '' || status.includes('failed') || status.includes('No valid');
  }, { timeout: 60000 });

  const output = await page.$eval('#output-box', el => el.value);
  await page.close();
  return { numbers: output ? output.split(', ').map(s => s.trim()).filter(Boolean) : [], logs };
}

(async () => {
  console.log('\n========== TESTING FULL-PAGE COLUMN ISOLATION ==========');

  if (!fs.existsSync(FULLPAGE)) {
    console.error('ERROR: fixture missing — run "node tests/make-fullpage-fixture.js" first');
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    args: ['--allow-file-access-from-files', '--disable-web-security']
  });

  const full = await extract(browser, FULLPAGE, true);
  const cropped = await extract(browser, CROPPED, false);
  await browser.close();

  console.log('\n--- Column Isolation Logs ---');
  full.logs.forEach(l => console.log(l));

  console.log('\n--- Parity With Hand-Cropped MainTest.png ---');
  console.log(`Full page:  ${full.numbers.length} numbers`);
  console.log(`Hand crop:  ${cropped.numbers.length} numbers`);

  const missing = cropped.numbers.filter(n => !full.numbers.includes(n));
  const extra = full.numbers.filter(n => !cropped.numbers.includes(n));
  if (missing.length) { console.log('\nLOST BY ISOLATION:'); missing.forEach(m => console.log(`  ${m}`)); }
  if (extra.length)   { console.log('\nONLY IN FULL PAGE:'); extra.forEach(e => console.log(`  ${e}`)); }

  const isolated = full.logs.some(l => l.includes('Isolated MLS # column'));
  const parity = missing.length === 0 && extra.length === 0;

  const correct = EXPECTED.filter(e => full.numbers.includes(e));
  console.log(`\n--- Recognizer Reference (informational) ---`);
  console.log(`Against known MLS numbers: ${correct.length}/${EXPECTED.length} (${(100 * correct.length / EXPECTED.length).toFixed(1)}%)`);

  console.log('\n--- Verification ---');
  console.log(isolated ? 'PASS: MLS # column was isolated from the multi-column scan.'
                       : 'FAIL: no column was isolated — the page was read as-is.');
  console.log(parity ? 'PASS: full-page output matches the hand-cropped column exactly.'
                     : 'FAIL: isolation changed the extracted numbers.');
  console.log('=======================================================\n');

  process.exit(isolated && parity && full.numbers.length > 0 ? 0 : 1);
})();
