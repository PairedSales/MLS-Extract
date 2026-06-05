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

  const debugRows = await page.evaluate(() => {
    const rows = document.querySelectorAll('.debug-table tbody tr');
    return Array.from(rows).map(row => {
      const tds = row.querySelectorAll('td');
      if (tds.length < 11) return null;
      return {
        pos: tds[0].textContent,
        cand1: tds[2].textContent,
        score1: tds[3].textContent,
        cand2: tds[4].textContent,
        score2: tds[5].textContent,
        cand3: tds[6].textContent,
        score3: tds[7].textContent,
        margin: tds[8].textContent,
        holes: tds[9].textContent,
        density: tds[10].textContent,
        status: tds[11].textContent,
      };
    }).filter(Boolean);
  });
  console.log('DEBUG TABLE CLASSIFICATION DATA:');
  console.table(debugRows);

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
  const browser = await puppeteer.launch({
    args: ['--allow-file-access-from-files', '--disable-web-security']
  });
  const page = await browser.newPage();

  // Listen to console logs from the page
  page.on('console', msg => console.log('BROWSER:', msg.text()));

  const htmlPath = path.resolve(__dirname, 'index.html');
  await page.goto(`file://${htmlPath}`);

  let allPassed = true;

  // Load and run manifest fixtures
  const manifestPath = path.resolve(__dirname, 'tests/fixtures/manifest.json');
  if (fs.existsSync(manifestPath)) {
    console.log(`Loading manifest fixtures from ${manifestPath}`);
    const fixtures = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const fixture of fixtures) {
      const imgPath = path.resolve(__dirname, 'tests/fixtures', fixture.file);
      const res = await runTest(page, imgPath, fixture.label, fixture.expected);
      if (res === false) allPassed = false;
    }
  } else {
    console.warn(`Manifest not found at ${manifestPath}`);
  }

  // Test root Sample.png as a format check if manifest wasn't run, or as extra assurance
  const sampleResult = await runTest(
    page,
    path.resolve(__dirname, 'Sample.png'),
    'Sample.png (Root Check)',
    ['12401432', '12487333', '12349664', '12375820']
  );
  if (sampleResult === false) allPassed = false;

  // Test root TestImage.png (exact match validation if present)
  const testImgResult = await runTest(
    page,
    path.resolve(__dirname, 'TestImage.png'),
    'TestImage.png (Root Check)',
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
