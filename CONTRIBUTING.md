# Contributing to ai-threads

Thanks for helping. Bug reports, fixes and ideas are all welcome. For a large change, open an issue first so we can agree on the shape before you write the code; the [roadmap](TODO.md) lists what is already planned. The file protocol is public: a change to a file's shape is a protocol version change, so talk about it in an issue first.

## Set up

You need Node 22 or newer and, for the demo's browser test, an installed Chrome or Edge. Python 3.8 or newer is optional: with it, the tests also run the protocol's Python implementation against the library.

```sh
git clone https://github.com/rbritta/ai-threads.git
cd ai-threads
npm ci               # only playwright-core, for the demo's browser test and screenshot
```

## Run the tests

```sh
npm test             # everything, offline
npm run test:coverage   # the same, with a coverage summary of src/
```

The tests run in temp folders with a fake Claude Code registry and fake transcripts (`test/helpers.js`): they never touch `~/.claude`, never call a model and never start a real hook in your sessions.

The demo's browser test drives an installed Chrome, headless, through playwright-core (`test/browser.js`). Set `PW_CHANNEL=msedge` to use Edge, or `PW_EXECUTABLE=/path/to/chrome` for another Chromium. Without a browser it is skipped and the reason is printed; CI sets `PW_REQUIRE=1`, so there a missing browser fails the run. The page runs in en-US, in UTC and at a fixed moment, so the result does not depend on the machine.

## Run the demo

```sh
npm run demo         # http://localhost:5177/demo/
npm run build:demo   # writes demo/ai-threads.js, as pages.yml does
npm run screenshots  # docs/demo.png
```

The demo runs the library's own `src/` in the browser: `scripts/build-demo.mjs` wraps it with the stand-ins in `scripts/browser-shims/` (a file system in memory, POSIX paths, Buffer). `npm run demo` builds it fresh on every request, so a change in `src/` shows on reload; the built file is never committed. `demo/vendor/` is chat-thread's `dist/`, copied as it is. Every name and message in the demo is made up; keep it that way.

## Commits

One change per commit, with a message that says in plain English what changed and why it matters, in one short line (more below it when needed). A release commit starts with the version, as in `0.3.1: ...`.

## Pull requests

A pull request needs:

- tests for the new behavior, and, for a bug fix, a test that fails without the fix;
- `npm test` passing;
- a line in `CHANGELOG.md` under `Unreleased`;
- the README, `AGENTS.md` and `docs/PROTOCOL.md` updated when the API, the configuration, the files or the behavior change;
- no runtime dependency.

[AGENTS.md](AGENTS.md) lists the invariants the code keeps (the signal file is never removed, only SessionStart returns `watchPaths`, hooks never throw); they apply to people too.

## Releases

For maintainers: move the `Unreleased` notes into a new dated section of `CHANGELOG.md`, bump `version` in `package.json` (and `package-lock.json`), commit, then tag `vX.Y.Z` and push the tag. `release.yml` runs the tests and creates the GitHub Release with that section as its notes and the `npm pack` tarball attached. Nothing is published to npm.
