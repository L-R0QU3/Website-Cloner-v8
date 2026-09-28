// TEMPORAL: captura screenshots de la UI rediseñada (desktop + mobile).
const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const fileUrl = 'file:///' + path.resolve('public/index.html').replace(/\\/g, '/');

  const desktop = await browser.newPage();
  await desktop.setViewport({ width: 1280, height: 900 });
  await desktop.goto(fileUrl, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 400));
  await desktop.screenshot({ path: 'shot-desktop.png', fullPage: true });

  const mobile = await browser.newPage();
  await mobile.setViewport({ width: 390, height: 844 });
  await mobile.goto(fileUrl, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 400));
  await mobile.screenshot({ path: 'shot-mobile.png', fullPage: true });

  await browser.close();
  console.log('OK desktop + mobile');
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
