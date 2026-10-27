// Renders SVG or PNG files side by side into one PNG for inspection: node tools/sb3/render-svg.cjs out.png a.svg b.svg ...
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const [, , outFile, ...files] = process.argv;
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 400 } });
  const imgs = files.map(f => {
    const type = f.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
    return `<figure style="display:inline-block;margin:4px;background:#888"><img src="data:${type};base64,${fs.readFileSync(f).toString('base64')}" style="max-width:960px"><figcaption>${path.basename(f)}</figcaption></figure>`;
  }).join('');
  await page.setContent(`<body style="margin:0;background:#444;color:#fff;font:11px sans-serif">${imgs}</body>`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: outFile, fullPage: true });
  await browser.close();
})();
