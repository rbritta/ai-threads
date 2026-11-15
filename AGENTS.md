# ai-threads for AI agents

How to use and change this library without breaking a running session.

## Using it

- Send with `deliverSync(session, text, { thread })` (or `ai-threads send`). Never write into a
  session's files any other way than [docs/PROTOCOL.md](docs/PROTOCOL.md) says.
- To know whether a message will arrive by itself, ask `listening(session)`. When it says no, the message
  waits in the inbox until the session's next start, Stop or prompt.
- Read the threads with `view(session)`; it returns chat-thread's thread shape. Pass `persist: true` from
  one place only (the app's server), so numbers given to threads the session opened are written once.
- Free text on the command line: `--file <path>`, so nothing needs shell quoting.

## Inside a session that ai-threads delivers to

Messages arrive marked `[Qn · title]`. Answer each in its thread: start a part with a line `[Qn]`
alone; open a separate question with a line `[Q new · short title]` and the question below it; rename
with `[Qn → short title]`. Text with no mark goes to the thread of the last message you got.

## Changing it

- `npm test` runs everything, offline: the library's tests take about two seconds, the demo's browser
  test a few more. Tests use temp folders and a fake Claude Code registry; they never touch `~/.claude`
  and never call a model. `npm run test:coverage` adds a coverage summary of `src/`.
- Zero runtime dependencies, CommonJS, Node 22+. Keep it that way. `playwright-core` is the only dev
  dependency (the demo's browser test and screenshot).
- The demo (`demo/`) runs `src/` itself in a browser: `scripts/build-demo.mjs` wraps the modules it needs
  with the stand-ins in `scripts/browser-shims/` (fs in memory, POSIX path, Buffer, os, crypto). A module
  the demo loads that starts using another Node API needs a stand-in there; `test/demo-bundle.test.js`
  runs the bundle in a bare `vm` context and fails first. `demo/ai-threads.js` is built, never committed.
  `demo/vendor/` is chat-thread's `dist/`, copied as it is. Demo data is made up.
- The browser test gets its browser and context from `test/browser.js` (en-US, UTC, a fixed clock); with
  no browser it skips and prints why, and CI sets `PW_REQUIRE=1` so a missing browser fails there.
- Every change gets a line under `Unreleased` in `CHANGELOG.md` (Keep a Changelog). A release moves those
  lines into a dated `## [x.y.z] - YYYY-MM-DD` section; `release.yml` publishes it as the release notes when
  the `vx.y.z` tag is pushed, and `test/release-notes.test.js` checks the shape.
- **The signal file is never removed or renamed**, by any code path. There is a test that watches
  `unlinkSync`, `renameSync` and `rmSync` for it; extend it when you add a path that writes there.
- **No hook returns `watchPaths` except SessionStart.** A FileChanged hook that returns them can replace
  the watches other tools armed in the same session.
- Hooks never throw: `runHook` turns any error into a line in `<home>/errors.log` and an exit 0.
- A hook never waits on the network or a model. The transform runs in the sender's process. A configured
  command (`onDelivered`, `tick`) runs detached and is never waited on.
- Messages are claimed by rename under the session's claim lock; keep that, it is what makes delivery
  exactly once across the watch, the vigia and the prompt hook.
- The file protocol is public: a change to a file's shape is a protocol version change (`v`), with
  readers that still accept the old one.

## Layout

| Path | What |
|---|---|
| `src/markup.js` | The Q markup: format, parse, the instruction texts. Pure. |
| `src/core.js` | `open()`: inbox, claim, threads, listening, hand back, answers, events. |
| `src/registry.js` | `threads.json` under its lock. |
| `src/command.js` | The commands an app configures (`onDelivered`, `tick`): detached, payload on stdin. |
| `src/view.js` | Threads for chat-thread, from the registry, the inbox, delivered records and the transcript. |
| `src/claude-code/` | Hooks, transcript reader, live-session registry, settings installer. |
| `src/cli.js` | The `ai-threads` command. |
| `demo/` | The live demo: `index.html`, `demo.js` (a pretend Claude Code and AI around the real library), `vendor/` (chat-thread). |
| `scripts/` | `build-demo.mjs` and `browser-shims/` (the demo's browser build), `serve-demo.mjs`, `screenshots.mjs`, `release-notes.mjs`. |
| `test/` | `node --test`; `helpers.js` has the temp homes, the fake registry and the fake transcripts. |
