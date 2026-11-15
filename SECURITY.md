# Security policy

## Supported versions

Fixes go into the latest minor release only.

| Version | Supported |
| --- | --- |
| 0.3.x | Yes |
| older | No |

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub instead: on the repository's **Security** tab, choose **Report a vulnerability** ([direct link](https://github.com/rbritta/ai-threads/security/advisories/new)).

Say which version or commit you used, what an attacker can do, and the smallest example that shows it. You will get an answer as soon as possible; once a fix is released, the advisory is published with credit to you, unless you would rather stay anonymous.

## What counts

ai-threads moves text from an app into an AI coding session and runs hooks inside Claude Code, so these are in scope:

- a message, a thread title, a footer or a session id that escapes its place: a path outside `<home>/sessions/<session>/`, text that forges another thread's mark or the instruction, or a file written where the protocol does not say;
- a hook that throws into the session, removes or renames a watched file, or waits on the network;
- a configured command (`onDelivered`, `tick`) run with input an outside sender controls, beyond the payload the protocol documents;
- the installer changing Claude Code settings it should not touch.

ai-threads trusts whoever can write to its home folder and to the Claude Code settings: anyone with that access already controls the session. A report that needs it is not a vulnerability, unless the library hands it to someone who should not have it.
