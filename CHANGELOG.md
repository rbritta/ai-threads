# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.1] - 2026-11-14

A live demo and project housekeeping. The library and the file protocol (version 1) are unchanged.

### Added

- A live demo at https://rbritta.github.io/ai-threads/demo/: a person and one AI coding session in numbered threads, entirely in the browser. It runs the library's own `src/` (built for the browser by `scripts/build-demo.mjs`, with a file system in memory standing in for Node's), its hooks deliver each message, its markup splits the answers and `view()` hands the threads to chat-thread, which draws them. The session is a script with canned answers; nothing calls a model. It runs under `default-src 'self'` and fits a 360 px phone. `npm run demo` serves it locally; `pages.yml` publishes it.
- Tests for the demo: one runs its bundle in a bare `vm` context (the stand-ins, and deliver, wake, transcript and `view()` through them), and a browser test loads the page and fails on any console error or CSP violation.
- `CONTRIBUTING.md`, `SECURITY.md` (private vulnerability reporting), `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), issue forms, a pull request template and Dependabot for the actions and npm.
- `release.yml`: a `v*` tag runs the tests and publishes a GitHub Release with that version's section of this file as its notes and the `npm pack` tarball attached. `scripts/release-notes.mjs` cuts the section and refuses a tag that is not the version in `package.json`.
- `npm run test:coverage`: the tests with a coverage summary of `src/`.
- `playwright-core` as the only dev dependency, for the browser test and the screenshot; the package still has no runtime dependency.

### Changed

- CI installs with `npm ci` (cached), runs with read-only permissions, cancels a run that a newer push replaces, and prints the coverage summary, still on Ubuntu and Windows with Node 22 and 24. The browser test always runs there (`PW_REQUIRE=1`): a missing browser fails the run instead of skipping it.
- The README follows the shape of its sibling repositories (badges, the demo, install, quick start, the family table with all five projects).
- This file follows Keep a Changelog, with the dates of the earlier releases filled in.

## [0.3.0] - 2026-11-14

English only. The file protocol stays version 1.

- The second built-in language of the instruction is gone, with the `lang` option (config, `register`,
  `--lang`): an app that tells its sessions in another language passes its own text in `instructions`
  (or per session in `instruction`). A `lang` left in a config or a session file is ignored.
- `newWords` (config): words besides `new` that open a thread, `[Q <word> · title]`, for such a text. Only
  `new` opens one by default; the other word 0.2 took is now listed there by the app that wants it.
- `markup.parseReply(text, current, { newWords })` and `markup.newWords(extra)`; `markup.INSTRUCTION`
  (one text) replaces `markup.INSTRUCTIONS`.

## [0.2.0] - 2026-11-14

For an app that routes messages to many sessions and keeps conversations of its own. Everything is optional
and the file protocol stays version 1: 0.1 files read the same, and a 0.1 reader ignores the new fields.

- `onDelivered` (config): a command run detached after every claimed batch, by whichever hook claimed it,
  with the delivered records as JSON on stdin. An app ticks a message delivered the moment it is, without
  following `events.jsonl`.
- `tick` (config): a command run while a session sits idle (by its vigia, at most once per `everyMs`) and on
  every touch of its signal (by the wake). A co-installed tool keeps its periodic check without an idle
  process or a watch of its own, so ai-threads stays the one owner of watches in the session.
- The texts around a delivery: `install --rewake-message` / `--rewake-summary` (kept when installing again
  without them), and `piggybackHeader` in the config (`""` for none).
- Footers: a message may carry a `footer`; a batch prints each distinct footer once, after its messages.
- Retracting is documented as a protocol procedure; the record gains `retracted_at` (and
  `retracted_reason`), the event a `reason`, and `retracted(session)` lists what was taken back.
- `ref`: an app's own id for a thread. A message sent with a `ref` and no thread goes to the thread that
  has it, or opens one that keeps it; `thread(session, { ref })`, `rename`/`resolve`/`reopen`/`setThread`
  with `{ ref }`, and `ref` on each thread of `view`.
- `replies(session, n or { ref }, { since })`: what the session answered in one thread, from its transcript.
- `release` may be a list of keys (one ask that allows more than one thing); an answer counts for each.
- CLI: `send --ref --footer`, `--release a,b`, `open --ref`, `retract --reason`, `replies`.
- The tests run a second implementation of the protocol in Python's standard library
  (`test/fixtures/protocol.py`) against the library: send, claim and retract, both ways. Skipped where no
  Python 3.8+ is on the PATH.

## [0.1.1] - 2026-11-14

- Message ids keep the order they were written in when two land in the same millisecond (one writer never
  repeats the time part); before, the random part could put them out of order on a fast machine.
- Test transcripts take their times from the run, so the suite passes at any hour.

## [0.1.0] - 2026-11-14

First release.

- A per-session inbox with a documented, language-neutral file protocol: messages written atomically,
  claimed exactly once by rename into `delivered/` (with `delivered_at`, `session_id`, `via`), an
  `events.jsonl` of what was queued, delivered, retracted and handed back.
- Threads opened by either side, with a type, a red flag and a release key; resolved from either side,
  reopened when the person writes again; derived threads keep their parent.
- The Q markup (`[Qn · title]`, `[Qn]`, `[Q new · title]`, `[Qn → title]`) with the instruction in two
  built-in languages (one left in 0.3.0), sent once and recalled after a resume, clear or compaction.
- Claude Code hooks: start (watch + re-touch), wake (FileChanged `asyncRewake`), vigia (Stop
  `asyncRewake`, only in sessions ai-threads is used in), prompt (piggyback), end. Never in a subagent;
  an optional entrypoint filter. The watched file is only ever overwritten.
- `listening()`: whether a session gets a message by itself now (watch armed, vigia up, or mid-turn).
- Hand back what a session never read, to another session or to `returned/`; retract a message still
  waiting.
- Answers to threads with a release key, for policy hooks.
- `view()`: a session's threads in chat-thread's `createThreads` shape, from the registry, the inbox, the
  delivered records and the transcript.
- An optional transform before queueing (translation, say), keeping the original.
- The `ai-threads` command: send, list, threads, view, open, rename, resolve, reopen, retract, handback,
  answers, register, status, events, install, remove, hook.

[Unreleased]: https://github.com/rbritta/ai-threads/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/rbritta/ai-threads/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/rbritta/ai-threads/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/rbritta/ai-threads/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/rbritta/ai-threads/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/rbritta/ai-threads/releases/tag/v0.1.0
