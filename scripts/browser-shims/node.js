'use strict';
/* os, crypto, child_process and process, as far as the library touches them in a browser. */
const { Buffer } = require('buffer');

const os = { homedir: () => '/home/demo', tmpdir: () => '/tmp', platform: () => 'browser', EOL: '\n' };

const crypto = {
  randomBytes(size) {
    const b = Buffer.alloc(size);
    globalThis.crypto.getRandomValues(b);
    return b;
  },
};

const childProcess = {
  spawn() { throw new Error('child_process.spawn is not available in a browser'); },
};

const proc = {
  env: {},
  pid: 1,
  platform: 'browser',
  execPath: '/usr/bin/node',
  cwd: () => '/',
  kill() { throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' }); },
};

module.exports = { os, crypto, childProcess, process: proc };
