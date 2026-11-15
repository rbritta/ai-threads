// Regenerates the README image from the demo: `npm run screenshots` (needs Chrome or Edge).
// docs/demo.png is the demo a moment after a message was sent: the session at work in its thread.
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { serve } from './serve-demo.mjs';

const docs = fileURLToPath(new URL('../docs/', import.meta.url));
const server = await serve(0);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE } : { channel: process.env.PW_CHANNEL || 'chrome' }),
});

try {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 860 }, deviceScaleFactor: 2, reducedMotion: 'reduce', colorScheme: 'dark', locale: 'en-US', timezoneId: 'UTC' });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/demo/`);
  await page.waitForSelector('#threads .ct-th');
  await page.evaluate(() => document.fonts.ready);
  const box = page.locator('#threads .ct-th--active .ct-input');
  await box.fill('Does the rollback still work after this change?');
  await box.press('Enter');
  await page.locator('#threads .ct-th--active .ct-msg--theirs', { hasText: 'Done.' }).waitFor();
  await mkdir(docs, { recursive: true });
  await page.locator('.layout').screenshot({ path: `${docs}demo.png` });
  console.log('docs/demo.png');
  await ctx.close();
} finally {
  await browser.close();
  server.close();
}
