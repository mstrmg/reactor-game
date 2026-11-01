import { chromium } from 'playwright';
const styles = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
for (const s of styles) {
  const t = Date.now();
  await page.goto(`http://localhost:8123/index.html?style=${s.split('&')[0]}${s.includes('&')?'&'+s.split('&')[1]:''}`);
  try { await page.waitForFunction(() => window.__ready || window.__err, null, { timeout: 180000 }); } catch (e) { console.log(s, 'TIMEOUT'); continue; }
  const err = await page.evaluate(() => window.__err);
  if (err) console.log(s, 'ERR', err);
  await page.locator('#wrap').screenshot({ path: `/tmp/art/shots/${s.replace('&','_')}.png` });
  console.log(s, 'ok', ((Date.now() - t) / 1000).toFixed(1) + 's');
}
await browser.close();
