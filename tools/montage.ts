// Tiles saved frames into one image of half-size frames with their frame numbers, for looking at many frames at once.
// Usage: npx tsx tools/montage.ts <out.png> <image> [image...]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const [out, ...files] = process.argv.slice(2);
const W = 320;
const H = 180;
const cols = 2;
const html = `<!doctype html><body style="margin:0;background:#111"><canvas id="c"></canvas><script>
const files = ${JSON.stringify(files.map((f) => `data:image/png;base64,${fs.readFileSync(path.resolve(f)).toString('base64')}`))};
const names = ${JSON.stringify(files.map((f) => path.basename(f, '.png')))};
const c = document.getElementById('c');
c.width = ${W * cols}; c.height = ${H} * Math.ceil(files.length / ${cols});
const g = c.getContext('2d');
g.font = '14px sans-serif';
window.done = Promise.all(files.map((f) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = f; }))).then((imgs) => {
  imgs.forEach((im, k) => {
    const x = (k % ${cols}) * ${W}, y = Math.floor(k / ${cols}) * ${H};
    g.drawImage(im, x, y, ${W}, ${H});
    g.fillStyle = '#000'; g.fillRect(x, y, 110, 18); g.fillStyle = '#ff0'; g.fillText(names[k], x + 4, y + 14);
  });
  return c.toDataURL('image/png');
});
</script></body>`;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage();
await page.setContent(html);
const url = (await page.evaluate(() => (window as unknown as { done: Promise<string> }).done)) as string;
fs.writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
await browser.close();
console.log(`wrote ${out}`);
