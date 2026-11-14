'use strict';
/*
 * ai-threads on the command line. Every command takes --home <dir> (default AI_THREADS_HOME or
 * ~/.ai-threads). Free text can come from --file <path> (or `-` for stdin), so nothing needs quoting.
 */
const fs = require('fs');
const core = require('./core');
const markup = require('./markup');

/** `--release git,deploy`: one key or a list. */
const releaseOf = (v) => (typeof v === 'string' && v.includes(',') ? v.split(',') : v);

const BOOL = new Set(['json', 'notice', 'alert', 'retouch', 'help', 'persist', 'instructed', 'no-alert']);

const HELP = `ai-threads: threads between a person and one AI coding session.

  ai-threads send <session> [text | --file F | -] [--thread N | --ref R] [--title T] [--notice] [--from W]
                  [--type T] [--alert] [--release K[,K2]] [--parent N] [--footer T] [--retouch] [--json]
  ai-threads list [<session>] [--json]          messages not delivered yet
  ai-threads threads <session> [--json]         the thread registry
  ai-threads view <session> [--persist]         threads as chat-thread's createThreads takes them (JSON)
  ai-threads open <session> [text | --file F] --title T [--by session|person] [--type T] [--alert]
                  [--release K[,K2]] [--parent N] [--ref R]   open a thread (an ask, when by the session)
  ai-threads rename <session> <n> <title> | resolve <session> <n> | reopen <session> <n>
  ai-threads retract <session> <id> [--reason T]   take back a message still pending
  ai-threads handback <session> [--to S]        move what the session never read
  ai-threads answers <session> [--release K] [--since ISO] [--json]
  ai-threads replies <session> <n | --ref R> [--since ISO] [--json]   what the session answered in a thread
  ai-threads register <session> [--title T] [--app A] [--lang en|pt] [--cwd D] [--instructed]
  ai-threads status [<session>] [--json]        hooks installed, sessions, who listens now
  ai-threads events [--session S] [--since ISO] [--json]
  ai-threads install [--settings F] [--claude-dir D] [--rewake-message T] [--rewake-summary T]
                                                       add the Claude Code hooks
  ai-threads remove  [--settings F] [--claude-dir D]   take them out
  ai-threads hook <start|wake|vigia|prompt|end>        what the hooks run (input on stdin)

Every command takes --home <dir>.`;

function parse(argv) {
  const out = { _: [], f: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '#ai-threads') continue; // the installer's tag
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) out.f[k] = a.slice(eq + 1);
      else if (BOOL.has(k)) out.f[k] = true;
      else out.f[k] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch (_) { return ''; }
}

function textOf(words, f, io) {
  if (f.file === '-' || (words.length === 1 && words[0] === '-')) return io.stdin();
  if (f.file) return fs.readFileSync(f.file, 'utf8');
  return words.join(' ');
}

async function main(argv = process.argv.slice(2), io = {}) {
  const out = io.stdout || ((s) => process.stdout.write(s));
  const err = io.stderr || ((s) => process.stderr.write(s));
  io.stdin = io.stdin || readStdin;
  const env = io.env || process.env;
  const { _: args, f } = parse(argv);
  const cmd = args.shift();
  const json = (v) => out(`${JSON.stringify(v, null, 2)}\n`);
  if (!cmd || cmd === 'help' || f.help) { out(`${HELP}\n`); return 0; }

  if (cmd === 'hook') {
    const { runHook } = require('./claude-code');
    let input = {};
    try { input = JSON.parse(io.stdin() || '{}'); } catch (_) { input = {}; }
    const res = await runHook(args[0], input, { home: f.home, env, claudeDir: f['claude-dir'] });
    if (res.stdout) out(res.stdout);
    if (res.stderr) err(`${res.stderr}\n`);
    return res.code;
  }

  const at = core.open({ home: f.home, env, claudeDir: f['claude-dir'] });

  if (cmd === 'touch') {
    const { makeHooks } = require('./claude-code');
    await makeHooks(at, { env }).touch(args[0]);
    return 0;
  }

  try {
    switch (cmd) {
      case 'send': {
        const sid = args.shift();
        const text = textOf(args, f, io);
        const opts = {
          thread: f.thread, ref: f.ref, title: f.title, from: f.from, type: f.type, alert: !!f.alert,
          release: releaseOf(f.release), parent: f.parent, footer: f.footer, retouch: !!f.retouch,
          kind: f.notice ? 'notice' : 'turn',
        };
        const r = await at.deliver(sid, text, opts);
        if (f.json) json(r);
        else out(`queued ${r.id}${r.thread ? ` in ${r.thread}` : ''}\n`);
        return 0;
      }
      case 'list': {
        const sids = args[0] ? [args[0]] : at.sessions().map((s) => s.session_id);
        const rows = sids.flatMap((sid) => at.pending(sid));
        if (f.json) json(rows);
        else for (const m of rows) out(`${m.session_id}  ${m.id}  ${m.thread || m.kind}  ${markup.oneLine(m.text, 80)}\n`);
        return 0;
      }
      case 'threads': {
        const list = at.threads(args[0]);
        if (f.json) json(list);
        else for (const t of list) out(`Q${t.n}  ${t.status}${t.alert ? '  !' : ''}${t.release ? `  [${t.release}]` : ''}  ${t.title || ''}\n`);
        return 0;
      }
      case 'view':
        json(at.view(args[0], { persist: !!f.persist }));
        return 0;
      case 'open': {
        const sid = args.shift();
        const t = at.openThread(sid, {
          title: f.title, text: textOf(args, f, io), by: f.by || 'session', type: f.type, alert: !!f.alert,
          release: releaseOf(f.release), parent: f.parent, ref: f.ref,
        });
        if (f.json) json(t);
        else out(`opened Q${t.n}\n`);
        return 0;
      }
      case 'rename': { const [sid, n, ...words] = args; at.rename(sid, n, words.join(' ') || f.title, { by: f.by || 'person' }); return 0; }
      case 'resolve': at.resolve(args[0], args[1], { by: f.by || 'person' }); return 0;
      case 'reopen': at.reopen(args[0], args[1]); return 0;
      case 'retract': {
        const ok = at.retract(args[0], args[1], { reason: f.reason || null });
        out(ok ? 'retracted\n' : 'not pending\n');
        return ok ? 0 : 1;
      }
      case 'handback': {
        const moved = at.handBack(args[0], { to: f.to || null });
        if (f.json) json(moved);
        else out(`${moved.length} handed back${f.to ? ` to ${f.to}` : ''}\n`);
        return 0;
      }
      case 'answers': {
        const list = at.answers(args[0], { release: f.release, since: f.since });
        if (f.json) json(list);
        else for (const a of list) out(`${a.at}  ${a.thread}  [${a.release}]  ${markup.oneLine(a.text, 80)}\n`);
        return 0;
      }
      case 'replies': {
        const which = f.ref ? { ref: f.ref } : args[1];
        const list = at.replies(args[0], which, { since: f.since });
        if (f.json) json(list);
        else for (const r of list) out(`${r.at || ''}  ${markup.oneLine(r.text, 100)}
`);
        return 0;
      }
      case 'register': {
        const fields = {};
        for (const k of ['title', 'app', 'lang', 'cwd']) if (f[k]) fields[k] = f[k];
        if (f.instructed) fields.instructed = true;
        json(at.register(args[0], fields));
        return 0;
      }
      case 'status': {
        const { install } = require('./claude-code');
        const hooks = install.status({ claudeDir: f['claude-dir'], settings: f.settings });
        const list = args[0] ? [{ session_id: args[0], pending: at.pending(args[0]).length, ...at.listening(args[0]) }] : at.sessions();
        if (f.json) { json({ hooks, sessions: list }); return 0; }
        out(`hooks ${hooks.installed ? 'installed' : 'not installed'} in ${hooks.settings}${hooks.error ? ` (${hooks.error})` : ''}\n`);
        for (const s of list) out(`${s.session_id}  ${s.listening ? `listening (${s.why})` : 'not listening'}  ${s.pending} pending\n`);
        return 0;
      }
      case 'events': {
        const list = at.events({ session: f.session, since: f.since });
        if (f.json) json(list);
        else for (const e of list) out(`${e.at}  ${e.event}  ${e.session_id}${e.id ? `  ${e.id}` : ''}${e.via ? `  via ${e.via}` : ''}\n`);
        return 0;
      }
      case 'install': {
        const { install } = require('./claude-code');
        const r = install.install({
          home: at.home, settings: f.settings, claudeDir: f['claude-dir'],
          rewakeMessage: f['rewake-message'], rewakeSummary: f['rewake-summary'],
        });
        out(`${r.changed ? 'installed' : 'already installed'} in ${r.settings}${r.backup ? ` (backup: ${r.backup})` : ''}\nhooks run from ${r.runtime}\n`);
        return 0;
      }
      case 'remove': {
        const { install } = require('./claude-code');
        const r = install.remove({ settings: f.settings, claudeDir: f['claude-dir'] });
        out(`${r.changed ? 'removed from' : 'not installed in'} ${r.settings}\n`);
        return 0;
      }
      default:
        err(`unknown command: ${cmd}\n\n${HELP}\n`);
        return 2;
    }
  } catch (e) {
    err(`ai-threads ${cmd}: ${e.message}\n`);
    return 1;
  }
}

module.exports = { main, parse, HELP };
