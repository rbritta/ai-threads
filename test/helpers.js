'use strict';
/* Temp homes, a fake Claude Code registry and fake transcripts: the tests never touch a real ~/.claude. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const threads = require('../src');

const SID = '11111111-2222-4333-8444-555555555555';
const SID2 = '66666666-7777-4888-8999-aaaaaaaaaaaa';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-threads-test-'));
  if (t && t.after) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A liveness function the test controls: live.set(sid, { alive, busy, startedAt }). */
function fakeLiveness() {
  const map = new Map();
  const fn = (sid) => {
    const s = map.get(sid);
    return s ? { known: true, alive: !!s.alive, busy: !!s.busy, startedAt: s.startedAt || null } : { known: false, alive: false, busy: false, startedAt: null };
  };
  fn.set = (sid, s) => map.set(sid, s);
  return fn;
}

/** An API over a temp home with no real registry and no detached processes. */
function api(t, opts = {}) {
  const root = tmp(t);
  const live = opts.liveness || fakeLiveness();
  const touched = [];
  const at = threads.open({
    home: path.join(root, 'home'),
    claudeDir: path.join(root, 'claude'),
    env: {},
    liveness: live,
    spawnToucher: (sid) => touched.push(sid),
    config: opts.config,
    now: opts.now,
  });
  return { at, root, live, touched };
}

/** Lines of a fake transcript. Their default times sit an hour ahead of the run, so they always come after
 * what the code stamps with the real clock (a delivery's `delivered_at`), whatever the hour the tests run. */
const BASE = Date.now() + 3600e3;
const stamp = (s) => new Date(BASE + s * 1000).toISOString();
const T = {
  user: (uuid, content, extra = {}) => ({ type: 'user', uuid, timestamp: extra.timestamp || stamp(0), message: { role: 'user', content }, ...extra }),
  rewake: (uuid, summary, body, extra = {}) => T.user(uuid, `<task-notification>\n<summary>${summary}</summary>\n</task-notification>\n<system-reminder>\nai-threads: messages for this session. ${body}\n</system-reminder>`, { origin: { kind: 'task-notification' }, ...extra }),
  assistant: (uuid, blocks, extra = {}) => ({ type: 'assistant', uuid, timestamp: extra.timestamp || stamp(60), message: { id: `msg_${uuid}`, model: 'claude-x', role: 'assistant', content: blocks }, ...extra }),
  text: (text) => ({ type: 'text', text }),
  tool: (name, input) => ({ type: 'tool_use', id: `tu_${name}`, name, input }),
  attachment: (uuid, hookEvent, content, extra = {}) => ({ type: 'attachment', uuid, timestamp: extra.timestamp || stamp(30), attachment: { type: 'hook_additional_context', hookEvent, content } }),
};

function writeTranscript(file, lines, { append = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  if (append) fs.appendFileSync(file, body);
  else fs.writeFileSync(file, body);
}

module.exports = { SID, SID2, tmp, fakeLiveness, api, T, writeTranscript };
