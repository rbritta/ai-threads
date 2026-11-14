"""A second implementation of the ai-threads file protocol (docs/PROTOCOL.md), in Python's standard
library only, so the tests can check that another language reads and writes the same files.

    python protocol.py send    <home> <session> <text> [--footer TEXT] [--notice]   prints the id
    python protocol.py claim   <home> <session> <via>                              prints the records (JSON)
    python protocol.py retract <home> <session> <id> [--reason TEXT]               prints true or false
"""
import json
import os
import secrets
import sys
import time
from pathlib import Path

_last_ms = 0


def iso(t=None):
    t = time.time() if t is None else t
    return time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(t)) + f'.{int(t * 1000) % 1000:03d}Z'


def b36(n):
    digits = '0123456789abcdefghijklmnopqrstuvwxyz'
    out = ''
    while n:
        n, r = divmod(n, 36)
        out = digits[r] + out
    return out or '0'


def new_id():
    global _last_ms
    ms = max(int(time.time() * 1000), _last_ms + 1)  # one writer never repeats the time part
    _last_ms = ms
    return f'{b36(ms).rjust(9, "0")}-{secrets.token_hex(4)}'


def write_atomic(path, data):
    tmp = path.parent / f'.{path.name}.{os.getpid()}.tmp'
    tmp.write_text(json.dumps(data, indent=1) + '\n', encoding='utf-8')
    os.replace(tmp, path)


def event(home, name, sid, **fields):
    with open(home / 'events.jsonl', 'a', encoding='utf-8') as fh:
        fh.write(json.dumps({'at': iso(), 'event': name, 'session_id': sid, **fields}) + '\n')


def touch(s, reason):
    """Rewrites the signal in place; creates it with an exclusive create. Never removes or renames it."""
    signal = s / 'signal'
    try:
        fd = os.open(signal, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
        os.close(fd)
    except FileExistsError:
        pass
    with open(signal, 'r+', encoding='utf-8') as fh:
        fh.seek(0)
        fh.truncate()
        fh.write(json.dumps({'at': iso(), 'reason': reason}))


class ClaimLock:
    def __init__(self, s, wait_s=4.0, stale_s=10.0):
        self.file = s / 'state' / 'claim.lock'
        self.wait_s, self.stale_s = wait_s, stale_s

    def __enter__(self):
        self.file.parent.mkdir(parents=True, exist_ok=True)
        until = time.time() + self.wait_s
        while True:
            try:
                fd = os.open(self.file, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
                os.write(fd, str(os.getpid()).encode())
                os.close(fd)
                return self
            except FileExistsError:
                try:
                    if time.time() - self.file.stat().st_mtime > self.stale_s:
                        self.file.unlink()
                        continue
                except FileNotFoundError:
                    continue
                if time.time() > until:
                    raise TimeoutError(f'lock busy: {self.file}')
                time.sleep(0.02)

    def __exit__(self, *exc):
        try:
            self.file.unlink()
        except FileNotFoundError:
            pass


def send(home, sid, text, footer=None, kind='turn'):
    s = home / 'sessions' / sid
    (s / 'inbox').mkdir(parents=True, exist_ok=True)
    mid = new_id()
    msg = {'v': 1, 'id': mid, 'session_id': sid, 'thread': None, 'kind': kind, 'from': 'app', 'text': text.strip(),
           'meta': {'writer': 'python'}, 'at': iso()}
    if footer and footer.strip():
        msg['footer'] = footer.strip()
    tmp = s / 'inbox' / f'.{mid}.{os.getpid()}.tmp'
    tmp.write_text(json.dumps(msg), encoding='utf-8')
    os.replace(tmp, s / 'inbox' / f'{mid}.json')
    touch(s, 'message')
    return mid


def claim(home, sid, via):
    s = home / 'sessions' / sid
    out = []
    with ClaimLock(s):
        (s / 'delivered').mkdir(parents=True, exist_ok=True)
        for name in sorted(n for n in os.listdir(s / 'inbox') if n.endswith('.json') and not n.startswith('.')):
            to = s / 'delivered' / name
            try:
                os.rename(s / 'inbox' / name, to)
            except OSError:
                continue  # someone else took it
            m = json.loads(to.read_text(encoding='utf-8'))
            m.update(delivered_at=iso(), session_id=sid, via=via)
            write_atomic(to, m)
            event(home, 'delivered', sid, id=m['id'], thread=m.get('thread'), kind=m.get('kind'), via=via)
            out.append(m)
    return out


def retract(home, sid, mid, reason=None):
    s = home / 'sessions' / sid
    with ClaimLock(s):
        (s / 'retracted').mkdir(parents=True, exist_ok=True)
        to = s / 'retracted' / f'{mid}.json'
        try:
            os.rename(s / 'inbox' / f'{mid}.json', to)
        except OSError:
            return False
        m = json.loads(to.read_text(encoding='utf-8'))
        m['retracted_at'] = iso()
        if reason:
            m['retracted_reason'] = reason
        write_atomic(to, m)
        event(home, 'retracted', sid, id=mid, **({'reason': reason} if reason else {}))
        return True


def opt(args, name):
    if name in args:
        i = args.index(name)
        value = args[i + 1]
        del args[i:i + 2]
        return value
    return None


def main(argv):
    cmd, home, sid, *rest = argv
    home = Path(home)
    if cmd == 'send':
        footer = opt(rest, '--footer')
        kind = 'notice' if '--notice' in rest else 'turn'
        rest = [a for a in rest if a != '--notice']
        print(send(home, sid, ' '.join(rest), footer, kind))
    elif cmd == 'claim':
        print(json.dumps(claim(home, sid, rest[0])))
    elif cmd == 'retract':
        reason = opt(rest, '--reason')
        print(json.dumps(retract(home, sid, rest[0], reason)))
    else:
        sys.exit(f'unknown command: {cmd}')


if __name__ == '__main__':
    main(sys.argv[1:])
