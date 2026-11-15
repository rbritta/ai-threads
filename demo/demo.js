// The ai-threads demo: a person and one AI coding session in numbered threads, all inside this tab.
//
// Real: ai-threads itself (ai-threads.js is the library's own src/, built for the browser by
// scripts/build-demo.mjs) keeping its files in a file system in memory, its hooks, its Q markup and
// view(), and chat-thread drawing the threads. Pretend: the session. This script plays Claude Code
// (it watches the session's signal file, runs the wake hook, writes the transcript) and the AI behind
// it (canned answers written in the Q markup). Nothing calls a model; every name and message is made up.
import { createThreads } from './vendor/chat-thread.mjs';

const { open, makeHooks, fs } = window.AiThreads;

const SID = 'demo-session';
const TRANSCRIPT = '/claude/projects/demo/demo-session.jsonl';
const HOME = '/ai-threads';
/** How long the pretend session takes: to notice the signal, to look around, to answer (ms). */
const PACE = { wake: 700, look: 900, answer: 1100 };

// The clock: real time, kept going by performance.now(), so the threads stay in order even under a
// test that freezes Date.now(). The made-up past at the start runs it back (`shift`).
const origin = Date.now() - performance.now();
let shift = 0;
const now = () => Math.round(origin + performance.now()) + shift;
const iso = () => new Date(now()).toISOString();

const session = { startedAt: 0, busy: false, waking: false, wakeAgain: false, answers: 0 };
const liveness = () => ({ known: true, alive: true, busy: session.busy, startedAt: session.startedAt });

const at = open({
  home: HOME,
  claudeDir: '/claude',
  env: {},
  now,
  liveness,
  config: { app: 'the ai-threads demo' },
  spawnToucher: () => {},
  runCommand: () => {},
});
const hooks = makeHooks(at, { env: {} });

const $ = (id) => document.getElementById(id);

// ── the pretend Claude Code: the transcript it writes, and the hooks it runs ──

let entries = 0;
function transcript(entry) {
  entries += 1;
  fs.appendFileSync(TRANSCRIPT, `${JSON.stringify({ uuid: `entry-${entries}`, timestamp: iso(), ...entry })}\n`);
}
const toolCall = (name, input) => transcript({ type: 'assistant', message: { id: `msg-${entries}`, model: 'demo', role: 'assistant', content: [{ type: 'tool_use', id: `tool-${entries}`, name, input }] } });
const say = (text) => transcript({ type: 'assistant', message: { id: `msg-${entries}`, model: 'demo', role: 'assistant', content: [{ type: 'text', text }] } });

/** SessionStart: the start hook arms the session and says which file to watch. */
function startSession() {
  fs.mkdirSync('/claude/projects/demo', { recursive: true });
  fs.writeFileSync(TRANSCRIPT, '');
  session.startedAt = now() - 1000;
  const out = JSON.parse(hooks.start({ session_id: SID, source: 'startup', transcript_path: TRANSCRIPT }).stdout);
  return out.hookSpecificOutput.watchPaths;
}

/** FileChanged: the wake hook claims what waits; its stderr is what the session reads next, as Claude Code puts it. */
function wake() {
  const out = hooks.wake({ session_id: SID, file_path: at.layout(SID).signal });
  if (!out) return null;
  transcript({
    type: 'user',
    origin: { kind: 'task-notification' },
    message: { role: 'user', content: `<task-notification>\n<summary>ai-threads: messages</summary>\n</task-notification>\n<system-reminder>\nai-threads: messages for this session. ${out.stderr}\n</system-reminder>` },
  });
  $('read').textContent = out.stderr;
  return out.stderr;
}

// ── the pretend AI: canned answers, written in the Q markup ──

const ANSWERS = [
  'Done. I made the change and ran the tests again: all green.',
  'Checked: nothing else calls that code, so the change is safe. Updated it, and the docs that mention it.',
  'Good catch. Fixed, with a test that fails without the fix.',
  'It was there on purpose, for older clients. I kept it and wrote down why in a comment next to it.',
];
const SIDE = [
  ['Add a line to the CHANGELOG?', 'While I was there: should the CHANGELOG get a line for this?'],
  ['Cover the empty case too?', 'The empty input is not tested yet. Should I add a test for it before moving on?'],
];
const LOOKS = [
  ['Read', { file_path: '/repo/src/deploy.js' }],
  ['Bash', { command: 'npm test', description: 'Run the tests' }],
  ['Grep', { pattern: 'dry-run' }],
];

/** The session's answer to a batch: one part per thread, and now and then a separate question of its own. */
function compose(batch) {
  const threads = [...new Set(batch.map((m) => m.n))];
  const answer = () => ANSWERS[session.answers++ % ANSWERS.length];
  let text = threads.length === 1 ? answer() : threads.map((n) => `[Q${n}]\n${answer()}`).join('\n\n');
  if (session.answers % 3 === 0) {
    const [title, ask] = SIDE[(session.answers / 3 - 1) % SIDE.length];
    text += `\n\n[Q new · ${title}]\n${ask}`;
  }
  return text;
}

function answer(batch) {
  session.busy = true;
  refresh();
  setTimeout(() => {
    toolCall(...LOOKS[session.answers % LOOKS.length]);
    refresh();
    setTimeout(() => {
      const text = compose(batch);
      say(text);
      $('wrote').textContent = text;
      session.busy = false;
      refresh();
      if (session.wakeAgain) {
        session.wakeAgain = false;
        signalled();
      }
    }, PACE.answer);
  }, PACE.look);
}

/** Claude Code's watch on the signal: a touch wakes the session, or waits for its turn to end. */
function signalled() {
  refresh();
  if (session.busy || session.waking) {
    session.wakeAgain = true;
    return;
  }
  session.waking = true;
  setTimeout(() => {
    session.waking = false;
    const read = wake();
    if (read) answer(window.AiThreads.markup.parseDelivered(read));
    else refresh();
  }, PACE.wake);
}

// ── the made-up past, so the page does not start empty ──

function past() {
  const minutes = (n) => { shift += n * 60e3; };
  shift = -40 * 60e3;
  const watch = startSession();
  at.deliverSync(SID, 'The deploy to staging fails at the migrate step. Can you look?');
  minutes(1);
  wake();
  minutes(3);
  toolCall('Bash', { command: 'npm run migrate -- --target staging-copy', description: 'Run the migration on a copy of staging' });
  minutes(2);
  say('[Q1 → Staging deploy: migrate step fails]\nFound it: the migration adds a NOT NULL column, and the seed script that runs before it drops the default. I made the seed idempotent and kept the default; the migrate step passes on a copy of staging.\n\n[Q new · Run the seed only in the deploy job?]\nThe seed also runs on every CI job, which is how it reached staging. Should it run only in the deploy job?');
  minutes(6);
  at.view(SID, { persist: true }); // gives the thread the session opened its number, Q2
  at.deliverSync(SID, 'Yes, only in the deploy job.', { thread: 2 });
  at.deliverSync(SID, 'And document the new --dry-run flag in the README.');
  minutes(1);
  wake();
  minutes(2);
  toolCall('Read', { file_path: '/repo/README.md' });
  minutes(2);
  const last = '[Q2]\nDone: the seed runs in the deploy job only, so CI no longer touches staging.\n\n[Q3]\nAdded a "Dry run" section under Usage, with an example of what it prints.';
  say(last);
  $('wrote').textContent = last;
  minutes(4);
  at.resolve(SID, 2);
  shift = 0;
  // from here on, Claude Code's watch on the signal drives the session
  for (const file of watch) fs.watch(file, signalled);
}

// ── the page ──

function showFiles() {
  const list = $('files');
  list.replaceChildren(...fs.list().map(({ path, size }) => {
    const li = document.createElement('li');
    const name = document.createElement('code');
    name.textContent = path.startsWith(`${HOME}/`) ? path.slice(HOME.length + 1) : path;
    li.append(name, ` ${size} B`);
    return li;
  }));
}

const STATES = { working: 'working on it', waiting: 'waiting for you', queued: 'a message is queued', open: 'idle, listening', stopped: 'closed' };
let box = null;
function refresh() {
  const view = at.view(SID, { persist: true });
  if (box) for (const thread of view.threads) box.upsert(thread);
  const s = view.session;
  $('status').textContent = `Session ${s.id}: ${STATES[s.state] || s.state}${s.listening ? ` · delivery by ${s.why}` : ''}`;
  showFiles();
  return view;
}

past();
$('instruction').textContent = at.instructionText(SID);
$('as-session').value = '[Q1]\nThe fix is merged and staging deployed cleanly.\n\n[Q new · Remove the old seed flag?]\nThe --reseed flag is unused now. Remove it?';

box = createThreads($('threads'), {
  mode: 'questions',
  theme: 'auto',
  threads: refresh().threads,
  chat: {
    author: 'Session',
    strings: { placeholder: 'Write to the session' },
    // the × on a queued message takes it back, if the session has not read it yet
    onRemove: (message) => { at.retract(SID, message.id); setTimeout(refresh, 0); },
  },
  // what an app's server does: deliver, then answer with the message (or the new thread) as view() has it;
  // the touch of the signal wakes the session, and the page follows with upsert()
  onSend(id, text) {
    const sent = at.deliverSync(SID, text, { thread: id });
    return at.view(SID).threads.find((t) => t.id === sent.thread).messages.find((m) => m.id === sent.id);
  },
  onNewThread(text, parentId) {
    const sent = at.deliverSync(SID, text, { parent: parentId });
    return at.view(SID, { persist: true }).threads.find((t) => t.id === sent.thread);
  },
  onResolve: (id) => { at.resolve(SID, id); refresh(); },
  onReopen: (id) => { at.reopen(SID, id); refresh(); },
  onRename: (id, title) => { at.rename(SID, id, title, { by: 'person' }); refresh(); },
});

$('write').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('as-session').value.trim();
  if (!text) return;
  say(text);
  $('wrote').textContent = text;
  refresh();
});

window.demo = { at, refresh, SID };
