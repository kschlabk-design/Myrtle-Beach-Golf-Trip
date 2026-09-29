import { createRequire } from 'node:module';
const { chromium } = createRequire(process.env.PW_ROOT + '/')('playwright');
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await p.goto('http://127.0.0.1:4321'); await p.waitForTimeout(500);
await p.click('.scorer-link'); for (const d of '446') await p.click(`[data-a="pinkey"][data-v="${d}"]`);
await p.screenshot({ path: process.env.OUT + '/pin.png' });
await p.click('[data-a="close"]'); await p.evaluate(() => window.scrollTo(0, 99999)); await p.waitForTimeout(150);
await p.screenshot({ path: process.env.OUT + '/footer-login.png' });
await b.close();
