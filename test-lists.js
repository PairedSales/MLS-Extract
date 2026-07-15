/*
 * Integration test for automatic list-type detection.
 * Runs each example image through the pipeline and reports the detected
 * type, the extracted values, and the copied (median / list) result.
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const IMAGES = [
  { file: 'Example Sale Price List.png', expectType: 'price' },
  { file: 'Example Days on Market List.png', expectType: 'dom' },
  { file: 'MainTest.png', expectType: 'mls' },
];

(async () => {
  const browser = await puppeteer.launch({
    args: ['--allow-file-access-from-files', '--disable-web-security'],
  });

  let allPass = true;

  for (const { file, expectType } of IMAGES) {
    const imagePath = path.resolve(__dirname, file);
    if (!fs.existsSync(imagePath)) {
      console.error(`ERROR: ${file} not found`);
      allPass = false;
      continue;
    }

    const imgData = fs.readFileSync(imagePath).toString('base64');
    const page = await browser.newPage();
    let detectedType = null;
    page.on('console', (msg) => {
      const t = msg.text();
      const m = t.match(/listType = (\w+)/);
      if (m) detectedType = m[1];
    });

    const htmlPath = path.resolve(__dirname, 'index.html');
    await page.goto(`file://${htmlPath}`);

    await page.evaluate(async (imgBase64) => {
      const res = await fetch(`data:image/png;base64,${imgBase64}`);
      const blob = await res.blob();
      window.handleImageFile(blob);
    }, imgData);

    await page.waitForFunction(
      () => {
        const output = document.querySelector('#output-box').value;
        const status = document.querySelector('#status-area').textContent;
        return output !== '' || status.includes('failed') || status.includes('No valid');
      },
      { timeout: 30000 }
    );

    const output = await page.$eval('#output-box', (el) => el.value);
    const valToCopy = await page.evaluate(() => valueToCopy);

    console.log(`\n========== ${file} ==========`);
    console.log(`Detected type: ${detectedType} (expected: ${expectType})`);
    console.log(`Output:\n${output}`);
    console.log(`Copied: ${valToCopy}`);

    if (detectedType !== expectType) {
      console.error(`FAIL: detected ${detectedType}, expected ${expectType}`);
      allPass = false;
    } else {
      console.log(`PASS: type detection`);
    }

    await page.close();
  }

  /* --- Median order-independence ---
   * Sale Price / DOM lists are not guaranteed to be sorted in the image.
   * calculateMedian must return the same value regardless of input order. */
  console.log(`\n========== Median order-independence ==========`);
  const page = await browser.newPage();
  await page.goto(`file://${path.resolve(__dirname, 'index.html')}`);

  const cases = [
    { name: 'odd, shuffled', input: [152, 1, 11, 5, 37, 3, 97], expected: 11 },
    { name: 'even, shuffled', input: [400000, 185000, 302500, 302000, 220000, 390000], expected: 302250 },
    { name: 'reverse-sorted', input: [61, 48, 31, 18, 13, 8, 4], expected: 18 },
    { name: 'duplicates, unordered', input: [5, 8, 5, 8, 5], expected: 5 },
  ];

  for (const c of cases) {
    const got = await page.evaluate((arr) => calculateMedian(arr), c.input);
    const shuffled = c.input.slice().reverse();
    const gotShuffled = await page.evaluate((arr) => calculateMedian(arr), shuffled);
    const ok = got === c.expected && gotShuffled === c.expected;
    console.log(`${ok ? 'PASS' : 'FAIL'}: ${c.name} → ${got} (expected ${c.expected})`);
    if (!ok) allPass = false;
  }
  await page.close();

  await browser.close();
  console.log(`\n${allPass ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'}`);
  process.exit(allPass ? 0 : 1);
})();
