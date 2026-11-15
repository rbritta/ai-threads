'use strict';
/*
 * The live demo in a real browser (test/browser.js finds the browser and pins the language, the time
 * zone and the clock). The page runs the library's own src/, built for the browser on the fly by the
 * demo server, so this also proves that build works: deliver, the wake hook, the transcript, the
 * markup and view(), drawn by chat-thread.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { launch, newContext } = require('./browser');

let browser;
let skip;
let server;
let base;

test.before(async () => {
  ({ browser, skip } = await launch());
  const { serve } = await import('../scripts/serve-demo.mjs');
  server = await serve(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
});

async function page(width = 1200, height = 900) {
  const ctx = await newContext(browser, { viewport: { width, height }, reducedMotion: 'reduce' });
  // every CSP violation lands in the errors, even one the console would not show
  await ctx.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP: ${e.violatedDirective} ${e.blockedURI}`)));
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(`${base}/demo/`);
  await p.waitForSelector('#threads .ct-th');
  return { p, ctx, errors };
}

const thread = (p, n) => p.locator('#threads .ct-th', { has: p.locator('.ct-th-n', { hasText: new RegExp(`^Q${n}$`) }) });

test('the demo loads under a strict CSP with no errors, and shows its made-up past through the real view()', async (t) => {
  if (!browser) return t.skip(skip);
  const { p, ctx, errors } = await page();
  assert.match(await p.getAttribute('meta[http-equiv="Content-Security-Policy"]', 'content'), /^default-src 'self'; script-src 'self'; style-src 'self'/);
  assert.equal(await p.locator('script:not([src])').count(), 0, 'no inline script');
  assert.equal(await p.locator('script[src^="http"], link[href^="http"]').count(), 0, 'nothing from another origin');

  // three threads: Q2, opened by the session, is resolved and folded behind the button on top
  assert.equal(await p.locator('#threads .ct-th').count(), 3);
  assert.equal(await p.locator('#threads .ct-th-more').textContent(), 'Show 1 resolved');
  assert.equal(await thread(p, 1).locator('.ct-th-tt').textContent(), 'Staging deploy: migrate step fails', 'renamed by the session with [Q1 → ...]');
  assert.match(await thread(p, 1).locator('.ct-th-ai').textContent(), /✦/);
  assert.match(await thread(p, 2).getAttribute('class'), /ct-th--resolved/);
  assert.match(await thread(p, 3).locator('.ct-th-tt').textContent(), /--dry-run flag/);

  // inside the session: the last batch with its marks, the answer split by them, the instruction, the files
  const read = await p.textContent('#read');
  assert.match(read, /^\[Q2 · Run the seed only in the deploy job\?\] Yes, only in the deploy job\.\n\n\[Q3 · And document the new --dry-run flag in the README\.\] And document/);
  assert.match(await p.textContent('#wrote'), /^\[Q2\]\nDone/);
  assert.match(await p.textContent('#instruction'), /^This session is followed in the ai-threads demo, where the conversation is split into threads/);
  const files = await p.textContent('#files');
  for (const f of ['sessions/demo-session/threads.json', 'sessions/demo-session/signal', 'events.jsonl', '/claude/projects/demo/demo-session.jsonl']) assert.ok(files.includes(f), f);
  assert.match(await p.textContent('#status'), /^Session demo-session: waiting for you · delivery by watch$/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a message written in a thread waits queued, the wake hook delivers it, and the answer comes back in that thread', async (t) => {
  if (!browser) return t.skip(skip);
  const { p, ctx, errors } = await page();
  const active = p.locator('#threads .ct-th--active');
  const n = (await active.locator('.ct-th-n').textContent()).slice(1);
  const box = active.locator('.ct-input');
  await box.fill('Please check the logs too.');
  await box.press('Enter');
  await active.locator('.ct-msg--mine.ct-msg--queued', { hasText: 'Please check the logs too.' }).waitFor();

  await p.waitForFunction((want) => document.getElementById('read').textContent.includes(want), `] Please check the logs too.`);
  assert.match(await p.textContent('#read'), new RegExp(`^\\[Q${n} · [^\\]]+\\] Please check the logs too\\.$`));
  await active.locator('.ct-msg--theirs', { hasText: 'Done. I made the change and ran the tests again: all green.' }).waitFor();
  assert.equal(await p.textContent('#wrote'), 'Done. I made the change and ran the tests again: all green.');
  await active.locator('.ct-msg--mine', { hasText: 'Please check the logs too.' }).locator('.ct-tick--read').waitFor();
  assert.equal(await active.locator('.ct-msg--queued').count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('what the session writes is split by its marks: more in Q1, and a thread it opens', async (t) => {
  if (!browser) return t.skip(skip);
  const { p, ctx, errors } = await page();
  await p.click('#write button[type=submit]');
  await thread(p, 4).waitFor();
  assert.equal(await thread(p, 4).locator('.ct-th-tt').textContent(), 'Remove the old seed flag?');
  assert.ok((await thread(p, 4).textContent()).includes('The --reseed flag is unused now. Remove it?'));
  assert.ok((await thread(p, 1).textContent()).includes('The fix is merged and staging deployed cleanly.'));
  assert.equal(await p.textContent('#wrote'), await p.inputValue('#as-session'));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the box at the bottom opens a thread; the session answers it', async (t) => {
  if (!browser) return t.skip(skip);
  const { p, ctx, errors } = await page();
  while (await p.locator('#threads .ct-th--open').count()) await p.locator('#threads .ct-th--open .ct-th-toggle').first().click();
  const fresh = p.locator('#threads .ct-th-new .ct-input');
  await fresh.fill('Can the release script tag the commit too?');
  await fresh.press('Enter');
  await thread(p, 4).waitFor();
  assert.equal(await thread(p, 4).locator('.ct-th-tt').textContent(), 'Can the release script tag the commit too?');
  await thread(p, 4).locator('.ct-th-activity', { hasText: 'Thinking' }).waitFor();
  await thread(p, 4).locator('.ct-msg--theirs', { hasText: 'Done. I made the change' }).waitFor();
  assert.match(await p.textContent('#read'), /^\[Q4 · Can the release script tag the commit too\?\] Can the release script tag the commit too\?$/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('on a 360 px phone: one column and no horizontal scroll', async (t) => {
  if (!browser) return t.skip(skip);
  const { p, ctx, errors } = await page(360, 740);
  const layout = await p.evaluate(() => {
    const person = document.querySelector('.person').getBoundingClientRect();
    const session = document.querySelector('.session').getBoundingClientRect();
    return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, stacked: session.top >= person.bottom, right: Math.max(person.right, session.right) };
  });
  assert.equal(layout.overflow, 0, 'no horizontal scroll');
  assert.ok(layout.stacked, 'the session panel sits below the threads');
  assert.ok(layout.right <= 360, 'both panels fit the width');
  assert.deepEqual(errors, []);
  await ctx.close();
});
