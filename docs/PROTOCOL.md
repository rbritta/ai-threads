# The ai-threads file protocol

Everything ai-threads knows is in plain files under one folder, the home: `AI_THREADS_HOME`, else
`~/.ai-threads`. Any program in any language can send messages, read what was delivered and follow the
threads by reading and writing these files the way this page says. The JavaScript library and the
`ai-threads` command line are one implementation of it.

Files are UTF-8 JSON (or JSON Lines). Times are ISO 8601 in UTC (`2026-11-14T10:02:00.000Z`). Version 1.

## Layout

```
<home>/
  config.json                     optional settings (README, "Configuration")
  events.jsonl                    every queued, delivered, handed-back... event, all sessions
  returned/<id>.json              messages handed back to nobody in particular
  runtime/                        the copy of the package the installed hooks run from
  errors.log                      what a hook swallowed instead of breaking the session
  sessions/<session id>/
    signal                        the file the session watches; rewritten in place, never removed
    inbox/<id>.json               messages waiting for the session
    delivered/<id>.json           messages the session got
    retracted/<id>.json           messages taken back before delivery
    threads.json                  the thread registry
    messages.jsonl                messages shown in a thread but never delivered (the session's asks)
    answers.jsonl                 the person's answers to threads that carry a release key
    session.json                  optional: what an app registered about the session
    state/armed.json              written by the start hook: the session watches its signal
    state/vigia                   present while the session's Stop vigia runs
    state/instructed              the session was told about the Q markup
    state/claim.lock              held while a batch is claimed
    state/threads.lock            held while threads.json changes
```

A session id is what the AI tool calls the session (Claude Code: a UUID). Accepted: letters, digits,
`.`, `_` and `-`, up to 128 characters, starting with a letter or digit, no `..`.

Names that start with a dot are temp files: every listing skips them.

## A message

```json
{
  "v": 1,
  "id": "0mwg0g5m2-9c4ec01c",
  "session_id": "11111111-2222-4333-8444-555555555555",
  "thread": "q3",
  "kind": "turn",
  "from": "person",
  "text": "Is the deploy fixed?",
  "meta": {},
  "at": "2026-11-14T10:02:00.000Z"
}
```

| Field | Meaning |
|---|---|
| `id` | Unique, and sorts in the order messages were written: the time in milliseconds in base 36, padded to 9 characters, a dash, 8 hex characters. A writer never repeats the time part (a second id in the same millisecond takes the next one); between two writers in the same millisecond the order is not defined. The file is `<id>.json`. |
| `thread` | `q<n>`, or `null` for a message with no thread. |
| `kind` | `turn` (the person, or an app on their behalf, talks to the session) or `notice` (no reply expected, never in a thread). |
| `from` | `person`, `app`, or a name. |
| `text` | What the session reads, after any transform. |
| `original` | Only when a transform changed the text: what was written. |
| `meta` | Anything the sender wants back; ai-threads never reads it. |
| `at` | When it was written. |

Once delivered, the record in `delivered/` gains:

| Field | Meaning |
|---|---|
| `delivered_at` | When it was claimed. |
| `session_id` | The session that got it. |
| `via` | How: `wake` (the watch), `vigia` (the Stop fallback), `prompt` (rode along with a typed prompt), or what the claimer said. |

A message moved to another session gains `moved_from`; one handed back to nobody gains `returned_from`
and `returned_at`.

## Sending

1. Write the message to `inbox/.<id>.<anything>.tmp`, then rename it to `inbox/<id>.json`. A reader
   never sees half a message.
2. Touch the signal: overwrite `signal` in place with anything that changes (ai-threads writes
   `{"at": ..., "reason": ..., "pending": n}`). Create it if it does not exist yet, with an exclusive
   create (`O_EXCL`), never by writing a temp file and renaming it.

**The signal is never removed and never renamed, by anyone.** Claude Code keeps one file watcher per
session, shared by every tool that asked it to watch something. Removing or renaming a watched file can
take that watcher down for all of them, and the session then stops getting anything until it restarts.

If the message opens a thread or goes to one, update `threads.json` first (below).

## Claiming

What the hooks do; a router can do it too.

1. Take `state/claim.lock` with an exclusive create. If it exists and is older than 10 seconds, its
   holder died: remove it and try again. Otherwise wait (ai-threads waits up to 4 s, then leaves the
   batch to the holder).
2. List `inbox/*.json` (not dot files), sorted by name.
3. Rename each into `delivered/<same name>`. A rename that fails means someone else took it: skip it.
4. Rewrite each claimed file whole (temp + rename) with `delivered_at`, `session_id` and `via`.
5. Append a `delivered` event for each.
6. Remove the lock.

The rename is the claim: a message is delivered at most once even without the lock. The lock keeps a
batch whole when two hooks fire at the same moment.

## What the session reads

The batch, oldest first, a blank line between messages:

```
[Q3 · Deploy fails] Is it fixed now?

CI is slow today.

[Q5 · Docs] Update the README too.
```

A thread message is headed by its mark, `[Q<n> · <title>]`, with the thread's current title on one line
(at most 60 characters, brackets taken out); a notice is its text alone. The first batch with a thread
in a session also starts with the instruction (README, "What the session is told"), once.

## Events

`events.jsonl`, one JSON object per line, appended with a single write:

```json
{"at":"2026-11-14T10:02:00.000Z","event":"delivered","session_id":"...","id":"0mwg0g5m2-9c4ec01c","thread":"q3","kind":"turn","via":"wake"}
```

| Event | Extra fields |
|---|---|
| `queued` | `id`, `thread`, `kind`, `from` |
| `delivered` | `id`, `thread`, `kind`, `via` |
| `retracted` | `id` |
| `handed_back` | `id`, `to` (a session, or `null` for `returned/`), `reason` |
| `armed` | `source` (startup, resume, clear, compact) |
| `ended` | `reason`, `pending` (ids still in the inbox) |
| `opened` | `thread`, `by`, `type`, `alert`, `release` |
| `renamed`, `resolved`, `reopened` | `thread`, `by` |

A person's app that wants ticks follows this file: `queued` is one tick, `delivered` two.

## Threads

`threads.json`:

```json
{
  "v": 1,
  "threads": [
    {
      "id": "q3", "n": 3, "title": "Deploy fails", "title_by": "person", "title_at": null,
      "type": null, "alert": false, "release": null,
      "opened_by": "person", "key": null, "parent": "q1",
      "at": "2026-11-14T10:02:00.000Z", "status": "open", "resolved_at": null, "resolved_by": null
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `id`, `n` | Thread `n` of this session; the id is `q<n>`. Numbers start at 1 and are never reused. Across sessions, `<session id>:q<n>` is unique. |
| `title`, `title_by`, `title_at` | The title and who gave it (`person`, `session`, `app`, or `null` when it came from the first message). |
| `type` | Free text: `question`, `review`, `authorization`... |
| `alert` | A red flag: the person should look at it first. |
| `release` | A short key a policy hook looks for (`git`, `deploy`), see "Answers". |
| `opened_by` | `person`, `session`, `app`, or `ide` (the thread of what was typed straight into the session). |
| `key` | For threads found in a transcript: `ide`, or `new:<entry uuid>:<i>` for the i-th thread (from 0) one transcript entry of the session opened. |
| `parent` | The thread it was derived from, `q<n>`. |
| `status` | `open` or `resolved`. Either side resolves; a person writing again reopens it. |

Change it only while holding `state/threads.lock` (same rules as the claim lock), reading it again after
taking the lock and writing it back whole (temp + rename).

### Thread states

Worked out when the threads are read, never stored:

| State | When | chat-thread |
|---|---|---|
| `resolved` | `status` is `resolved` | `status: 'resolved'` |
| `queued` | its last message from the person is still in the inbox | `tone: 'idle'` |
| `working` | the session is mid-turn on this thread | `tone: 'busy'` |
| `waiting` | the last message is the session's: the person's turn ("answered") | `tone: 'wait'` |
| `sent` | the last message is the person's, delivered, the session alive | `tone: 'idle'` |
| `stopped` | the same, with the session gone | `tone: 'idle'` |
| `empty` | no messages yet | `tone: 'idle'` |

Open, answered and closed, in a router's words, are `status: open`, the state `waiting`, and
`status: resolved`.

## The Q markup

| Mark | Where | Meaning |
|---|---|---|
| `[Q3 · title]` | heads a delivered message | what follows is thread 3 |
| `[Q3]` or `[Q3 · title]` alone on a line | in the session's reply | the text below goes to thread 3, until the next mark |
| `[Q new · title]` or `[Q nova · title]` alone on a line | in the session's reply | the session opens a thread; the text below is its first message; its parent is the thread it was written in |
| `[Q3 → title]` or `[Q3 -> title]` alone on a line | in the session's reply | the session renames thread 3; the line is taken out of the text |

How a reply is attributed:

- Text with no mark goes to the thread of the last message delivered (or typed) before it.
- A mark holds until the next mark or the next message to the session, across the blocks of one turn.
- Text the person types straight into the session, with no mark, is the `ide` thread.
- A mark in the middle of a sentence is just text.

## Listening

A session "listens now", gets a message by itself with nobody typing in it, when it is alive and one of:

- `state/armed.json` exists, written after the session started (`at_ms` not older than its start);
- `state/vigia` exists;
- it is mid-turn (Claude Code's own registry says `busy`).

`armed.json`: `{ "at", "at_ms", "source", "transcript_path", "cwd", "entrypoint" }`. The end hook
removes it and `state/vigia`.

The vigia runs only for a session that has `session.json` or ever had a message (`inbox/` or
`delivered/` not empty); any other session listens through its watch alone.

## Handing back

When a session will not read its inbox (it ended, or a router wants the messages elsewhere), move each
message with one rename: to another session's `inbox/` (then add `session_id` and `moved_from` and touch
that session's signal), or to `<home>/returned/` (then add `returned_from` and `returned_at`). The
source session's claim lock is held while moving. Thread references stay as they are: `q3` keeps
meaning thread 3 of the session it came from.

## Answers

When the person writes in a thread that has a `release` key, `answers.jsonl` gets a line:

```json
{"at":"2026-11-14T10:05:00.000Z","session_id":"...","thread":"q4","release":"git","text":"yes, push it","id":"0mwg0h1k2-1a2b3c4d"}
```

A policy hook (one that allows or blocks what the session is about to do) reads it to know which ask
was answered, by what, and when. Deciding whether the text says yes is the policy's job.

## Logged messages

`messages.jsonl` holds messages that belong in a thread but are never delivered: the session's own ask,
opened through the API or `ai-threads open`, and an app's notes.
`{ "id", "thread", "from": "session" | "app" | "person", "text", "at" }`.

## session.json

Optional, written by an app: `{ "session_id", "title", "app", "lang", "instruction", "instructed",
"cwd", "transcript", "created_at", "updated_at" }`. `lang` (`en`, `pt`), `app` and `instruction` (a text
of its own, or `false`) shape the instruction; `instructed: true` says the app already told the session.

## From Python

```python
import json, os, time, secrets, pathlib

home = pathlib.Path(os.environ.get('AI_THREADS_HOME') or pathlib.Path.home() / '.ai-threads')

def send(session_id, text, thread=None, kind='turn'):
    s = home / 'sessions' / session_id
    (s / 'inbox').mkdir(parents=True, exist_ok=True)
    now = time.time()
    mid = f"{_b36(int(now * 1000)).rjust(9, '0')}-{secrets.token_hex(4)}"
    msg = {'v': 1, 'id': mid, 'session_id': session_id, 'thread': thread, 'kind': kind,
           'from': 'app', 'text': text, 'meta': {}, 'at': time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime(now))}
    tmp = s / 'inbox' / f'.{mid}.tmp'
    tmp.write_text(json.dumps(msg), encoding='utf-8')
    os.replace(tmp, s / 'inbox' / f'{mid}.json')
    signal = s / 'signal'
    with open(signal, 'a+', encoding='utf-8') as fh:  # opens in place, creates if missing
        fh.seek(0); fh.truncate(); fh.write(json.dumps({'at': msg['at'], 'reason': 'message'}))
    return mid

def _b36(n):
    digits = '0123456789abcdefghijklmnopqrstuvwxyz'
    out = ''
    while n:
        n, r = divmod(n, 36)
        out = digits[r] + out
    return out or '0'
```

A message to an existing thread must name a thread that `threads.json` has; a new thread is added
there first, under its lock.
