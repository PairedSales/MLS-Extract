const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const EXPECTED_PRICES = [
  572000, 680000, 700000, 735000, 750000, 765000, 770000, 775000,
  900000, 950000, 950000, 960000, 1015000, 1029000, 1050000, 1050000,
  1070000, 1150000, 1315000
];

const EXPECTED_MEDIAN_FORMATTED = '$950,000';

(async () => {
  console.log('\n========== TESTING PRICE EXTRACT PIPELINE ==========');

  const imagePath = path.resolve(__dirname, 'PriceTest.png');
  if (!fs.existsSync(imagePath)) {
    console.error(`ERROR: PriceTest.png not found at ${imagePath}`);
    process.exit(1);
  }

  const imgData = fs.readFileSync(imagePath).toString('base64');

  const browser = await puppeteer.launch({
    args: ['--allow-file-access-from-files', '--disable-web-security']
  });
  const page = await browser.newPage();

  // Listen to console logs from the page
  page.on('console', msg => console.log('BROWSER:', msg.text()));

  const htmlPath = path.resolve(__dirname, 'index.html');
  await page.goto(`file://${htmlPath}`);

  console.log('Loading PriceTest.png into extraction pipeline...');
  await page.evaluate(async (imgBase64) => {
    const res = await fetch(`data:image/png;base64,${imgBase64}`);
    const blob = await res.blob();
    window.handleImageFile(blob);
  }, imgData);

  // Wait for extraction to complete
  await page.waitForFunction(
    () => {
      const output = document.querySelector('#output-box').value;
      const status = document.querySelector('#status-area').textContent;
      return output !== '' || status.includes('failed') || status.includes('No valid');
    },
    { timeout: 30000 }
  );

  const output = await page.$eval('#output-box', el => el.value);
  const status = await page.$eval('#status-area', el => el.textContent);
  const valToCopy = await page.evaluate(() => valueToCopy);

  console.log('\n--- Extraction Output ---');
  console.log(output);
  console.log('STATUS:', status);
  console.log('COPIED TO CLIPBOARD:', valToCopy);

  console.log('\n--- Verification ---');
  let passed = true;

  // Verify it contains the median
  if (!output.includes(`Median Price: ${EXPECTED_MEDIAN_FORMATTED}`)) {
    console.error(`FAIL: Output does not contain expected Median Price: ${EXPECTED_MEDIAN_FORMATTED}`);
    passed = false;
  } else {
    console.log(`PASS: Output contains expected Median Price: ${EXPECTED_MEDIAN_FORMATTED}`);
  }

  // Verify clipboard copy value is exactly the median
  if (valToCopy !== EXPECTED_MEDIAN_FORMATTED) {
    console.error(`FAIL: Clipboard valueToCopy (${valToCopy}) does not match expected Median (${EXPECTED_MEDIAN_FORMATTED})`);
    passed = false;
  } else {
    console.log(`PASS: Clipboard valueToCopy matches expected Median: ${EXPECTED_MEDIAN_FORMATTED}`);
  }

  // Verify all expected prices are in the output list
  for (const price of EXPECTED_PRICES) {
    const formattedPrice = '$' + price.toLocaleString('en-US');
    if (!output.includes(formattedPrice)) {
      console.error(`FAIL: Output is missing expected price: ${formattedPrice}`);
      passed = false;
    }
  }

  if (passed) {
    console.log('\nPASS: Price extraction and median calculation successfully verified!');
  }

  await browser.close();
  process.exit(passed ? 0 : 1);
})();
