const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

/**
 * Test the MLS Extract pipeline against known sample images.
 * 
 * Test cases:
 *  - Sample.png: small column with a few MLS numbers (format validation)
 *  - TestImage.png: primary validation image with 13 known MLS numbers (if present)
 */

const EXPECTED_TEST_IMAGE = [
  '12644253', '12625136', '12629777', '12557267', '12432351',
  '12385811', '12414568', '12323876', '12274046', '12162197',
  '12110994', '12045319', '12155254',
];

async function runTest(page, imagePath, label, expectedNumbers) {
  console.log(`\n--- Testing: ${label} (${imagePath}) ---`);

  if (!fs.existsSync(imagePath)) {
    console.log(`SKIP: ${imagePath} not found`);
    return null;
  }

  const imgData = fs.readFileSync(imagePath).toString('base64');
  const ext = path.extname(imagePath).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';

  // Reset the app state
  await page.evaluate(() => {
    document.querySelector('#output-box').value = '';
    document.querySelector('#status-area').textContent = '';
  });

  await page.evaluate(async ({ imgBase64, mimeType }) => {
    const res = await fetch(`data:${mimeType};base64,${imgBase64}`);
    const blob = await res.blob();
    window.handleImageFile(blob);
  }, { imgBase64: imgData, mimeType: mime });

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

  console.log('OUTPUT:', output || '(empty)');
  console.log('STATUS:', status);

  if (!output) {
    console.log(`FAIL [${label}]: No output produced`);
    return false;
  }

  const numbers = output.split(', ').map(s => s.trim()).filter(Boolean);

  // Check format: all must be 8-digit numbers
  const allValid = numbers.every(n => /^\d{8}$/.test(n));
  if (!allValid) {
    console.log(`FAIL [${label}]: Output contains non-8-digit values`);
    return false;
  }

  console.log(`Found ${numbers.length} valid 8-digit numbers`);

  // If we have expected values, check exact match
  if (expectedNumbers) {
    const missing = expectedNumbers.filter(e => !numbers.includes(e));
    const extra = numbers.filter(n => !expectedNumbers.includes(n));

    if (missing.length > 0) {
      console.log(`FAIL [${label}]: Missing expected numbers: ${missing.join(', ')}`);
    }
    if (extra.length > 0) {
      console.log(`WARN [${label}]: Extra numbers not in expected: ${extra.join(', ')}`);
    }
    if (missing.length === 0 && extra.length === 0) {
      console.log(`PASS [${label}]: All ${expectedNumbers.length} expected numbers matched exactly`);
      return true;
    }

    // Partial match
    const matched = expectedNumbers.length - missing.length;
    console.log(`PARTIAL [${label}]: ${matched}/${expectedNumbers.length} matched`);
    return false;
  }

  // No expected values — just format check
  console.log(`PASS [${label}]: ${numbers.length} valid 8-digit numbers extracted`);
  return true;
}

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  // Listen to console logs from the page
  page.on('console', msg => console.log('BROWSER:', msg.text()));

  const htmlPath = path.resolve(__dirname, 'index.html');
  await page.goto(`file://${htmlPath}`);

  let allPassed = true;

  // Test 1: Sample.png (format validation)
  const sampleResult = await runTest(
    page,
    path.resolve(__dirname, 'Sample.png'),
    'Sample.png',
    null  // format-only check
  );
  if (sampleResult === false) allPassed = false;

  // Test 2: TestImage.png (exact match validation)
  const testImgResult = await runTest(
    page,
    path.resolve(__dirname, 'TestImage.png'),
    'TestImage.png',
    EXPECTED_TEST_IMAGE
  );
  if (testImgResult === false) allPassed = false;

  await browser.close();

  if (allPassed) {
    console.log('\n=== ALL TESTS PASSED ===');
    process.exit(0);
  } else {
    console.log('\n=== SOME TESTS FAILED ===');
    process.exit(1);
  }
})();
