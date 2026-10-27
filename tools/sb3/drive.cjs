// Plays a project in headless Edge and runs scripted sessions against it.
//   node tools/sb3/drive.cjs <project.sb3> <script.cjs> [shotDir]      runs one script and exits
//   node tools/sb3/drive.cjs <project.sb3> --serve <dir> [shotDir]     stays loaded and runs each <dir>/*.cjs dropped in, writing <name>.out
// A script exports async (h) => {...} with h.press, h.hold, h.wait, h.shot, h.v, h.setv, h.eval, h.log and h.reload.
// Stop a server by creating <dir>/STOP.
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const sb3 = args[0];
const serveDir = args[1] === '--serve' ? path.resolve(args[2]) : null;
const scriptPath = serveDir ? null : args[1];
const shotDir = path.resolve((serveDir ? args[3] : args[2]) || path.join(root, 'out', 'shots'));
fs.mkdirSync(shotDir, { recursive: true });

function serve() {
  const types = { '.html': 'text/html', '.js': 'text/javascript' };
  const server = http.createServer((req, res) => {
    const file = path.join(root, decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(0, () => r(server)));
}

(async () => {
  const server = await serve();
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 960, height: 760 } });
  let out = [];
  const log = (...a) => { const s = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); out.push(s); console.log(s); };
  page.on('pageerror', e => log(`[pageerror] ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/404/.test(m.text())) log(`[console] ${m.text().slice(0, 300)}`); });
  const url = `http://localhost:${server.address().port}/tools/sb3/player.html?f=${encodeURIComponent(path.relative(root, path.resolve(sb3)).split(path.sep).join('/'))}`;
  const load = async () => {
    const t0 = Date.now();
    await page.goto(url);
    await page.waitForFunction(() => window.ready || window.loadError, null, { timeout: 900000, polling: 500 });
    const err = await page.evaluate(() => window.loadError);
    if (err) throw new Error(err);
    log(`loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  };
  await load();
  const h = {
    page,
    wait: ms => page.waitForTimeout(ms),
    press: (k, ms = 120) => page.evaluate(([k, ms]) => window.press(k, ms), [k, ms]),
    hold: (k, down) => page.evaluate(([k, d]) => window.hold(k, d), [k, down]),
    v: name => page.evaluate(n => window.v(n), name),
    setv: (name, val) => page.evaluate(([n, x]) => window.setv(n, x), [name, val]),
    eval: (fn, arg) => page.evaluate(fn, arg),
    shot: async name => { const f = path.join(shotDir, `${name}.png`); await page.locator('#stage').screenshot({ path: f }); log(`shot ${f}`); },
    reload: load,
    log,
  };
  const runScript = async file => {
    out = [];
    const errorsBefore = await page.evaluate(() => window.errors.length);
    try {
      delete require.cache[require.resolve(file)];
      await require(file)(h);
    } catch (e) {
      log(`[script error] ${e.stack || e}`);
    }
    const errors = await page.evaluate(n => window.errors.slice(n), errorsBefore).catch(() => []);
    if (errors.length) log('runtime errors:', errors.slice(0, 20));
  };
  if (!serveDir) {
    await runScript(path.resolve(scriptPath));
  } else {
    fs.mkdirSync(serveDir, { recursive: true });
    fs.writeFileSync(path.join(serveDir, 'READY'), new Date().toISOString());
    for (;;) {
      if (fs.existsSync(path.join(serveDir, 'STOP'))) break;
      const jobs = fs.readdirSync(serveDir).filter(f => f.endsWith('.cjs')).sort();
      for (const j of jobs) {
        const file = path.join(serveDir, j);
        await runScript(file);
        fs.writeFileSync(file.replace(/\.cjs$/, '.out'), out.join('\n') + '\nDONE\n');
        fs.renameSync(file, file + '.done');
      }
      await new Promise(r => setTimeout(r, 300));
    }
    fs.rmSync(path.join(serveDir, 'READY'), { force: true });
  }
  await browser.close();
  server.close();
})().catch(e => { console.error(e); process.exit(1); });
