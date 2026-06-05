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

(async () => {
  const browser = await puppeteer.launch({
    args: ['--allow-file-access-from-files', '--disable-web-security']
  });
  const page = await browser.newPage();

  const rowLogs = [];
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('[P1] Row') || text.includes('[P2] Row') || 
        text.includes('→') || text.includes('[Result]') ||
        text.includes('[Seg]') || text.includes('[Pre]')) {
      rowLogs.push(text);
    }
  });

  const htmlPath = path.resolve(__dirname, 'index.html');
  await page.goto(`file://${htmlPath}`);

  const imgPath = path.resolve(__dirname, 'MainTest.png');
  const imgData = fs.readFileSync(imgPath).toString('base64');

  await page.evaluate(async (imgBase64) => {
    const res = await fetch(`data:image/png;base64,${imgBase64}`);
    const blob = await res.blob();
    window.handleImageFile(blob);
  }, imgData);

  await page.waitForFunction(() => {
    const output = document.querySelector('#output-box').value;
    const status = document.querySelector('#status-area').textContent;
    return output !== '' || status.includes('failed') || status.includes('No valid');
  }, { timeout: 60000 });

  const output = await page.$eval('#output-box', el => el.value);
  const found = output ? output.split(', ').map(s => s.trim()).filter(Boolean) : [];

  console.log('\n========== BASELINE RESULTS ==========');
  console.log('\n--- Pipeline Logs ---');
  rowLogs.forEach(l => console.log(l));

  console.log('\n--- Accuracy Report ---');
  console.log(`Expected: ${EXPECTED.length}`);
  console.log(`Found:    ${found.length}`);

  const correct = EXPECTED.filter(e => found.includes(e));
  const missing = EXPECTED.filter(e => !found.includes(e));
  const extra = found.filter(f => !EXPECTED.includes(f));

  console.log(`Correct:  ${correct.length}/${EXPECTED.length} (${(100*correct.length/EXPECTED.length).toFixed(1)}%)`);
  console.log(`Missing:  ${missing.length}`);
  console.log(`Extra:    ${extra.length}`);

  if (missing.length > 0) {
    console.log('\nMISSING (expected but not found):');
    missing.forEach(m => console.log(`  ${m}`));
  }
  if (extra.length > 0) {
    console.log('\nEXTRA (found but not expected):');
    extra.forEach(e => console.log(`  ${e}`));
  }

  // Check for misidentified - extra numbers that might be corrupted versions of missing ones
  if (extra.length > 0 && missing.length > 0) {
    console.log('\nPOSSIBLE MISIDENTIFICATIONS:');
    for (const e of extra) {
      for (const m of missing) {
        let diffs = 0;
        for (let i = 0; i < 8; i++) {
          if (e[i] !== m[i]) diffs++;
        }
        if (diffs <= 2) {
          console.log(`  ${e} (found) ← ${m} (expected)  [${diffs} digit(s) differ]`);
        }
      }
    }
  }

  console.log('\n--- Raw Output ---');
  console.log(output || '(empty)');
  console.log('======================================\n');

  await browser.close();
  process.exit(correct.length === EXPECTED.length ? 0 : 1);
})();
