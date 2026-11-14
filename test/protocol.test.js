'use strict';
/* The file protocol from another language: test/fixtures/protocol.py (Python's standard library only)
 * writes, claims and retracts, and the library reads what it did, and the other way round. Skipped when
 * no Python is on the PATH. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { SID, api } = require('./helpers');

const SCRIPT = path.join(__dirname, 'fixtures', 'protocol.py');
const PYTHON = ['python3', 'python'].find((exe) => {
  const r = spawnSync(exe, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'], { windowsHide: true });
  return r.status === 0;
});

function py(home, ...args) {
  const r = spawnSync(PYTHON, ['-I', SCRIPT, args[0], home, ...args.slice(1)], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

test('Python writes a message with a footer; the library claims it and prints the footer once', { skip: !PYTHON && 'no Python' }, (t) => {
  const { at } = api(t);
  const a = py(at.home, 'send', SID, 'Build is green.', '--footer', 'Reply in the app.');
  const b = py(at.home, 'send', SID, 'CI is slow today.', '--notice', '--footer', 'Reply in the app.');
  assert.ok(fs.readFileSync(at.layout(SID).signal, 'utf8').includes('message'));
  const got = at.claim(SID, { via: 'wake' });
  assert.deepEqual(got.map((m) => [m.id, m.kind, m.meta.writer]), [[a, 'turn', 'python'], [b, 'notice', 'python']]);
  assert.equal(at.formatDelivery(SID, got), 'Build is green.\n\nCI is slow today.\n\nReply in the app.');
});

test('the library writes; Python claims, and the library sees the delivered records and events', { skip: !PYTHON && 'no Python' }, (t) => {
  const { at } = api(t);
  const one = at.deliverSync(SID, 'one', { thread: false });
  const two = at.deliverSync(SID, 'two', { thread: 1 });
  const claimed = JSON.parse(py(at.home, 'claim', SID, 'router'));
  assert.deepEqual(claimed.map((m) => m.id), [one.id, two.id]);
  assert.deepEqual(at.pending(SID), []);
  assert.deepEqual(at.delivered(SID).map((m) => [m.id, m.via, m.session_id]), [[one.id, 'router', SID], [two.id, 'router', SID]]);
  assert.deepEqual(at.events().filter((e) => e.event === 'delivered').map((e) => e.id), [one.id, two.id]);
  assert.equal(fs.existsSync(path.join(at.layout(SID).state, 'claim.lock')), false);
});

test('Python retracts what the library queued; it is never delivered', { skip: !PYTHON && 'no Python' }, (t) => {
  const { at } = api(t);
  const m = at.deliverSync(SID, 'goes elsewhere', { thread: false });
  assert.equal(py(at.home, 'retract', SID, m.id, '--reason', 'rerouted'), 'true');
  assert.equal(py(at.home, 'retract', SID, m.id), 'false');
  assert.deepEqual(at.retracted(SID).map((r) => [r.id, r.retracted_reason]), [[m.id, 'rerouted']]);
  assert.deepEqual(at.claim(SID), []);
});
