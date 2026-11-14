#!/usr/bin/env node
'use strict';
require('../src/cli').main().then((code) => { process.exitCode = code; }, (e) => {
  process.stderr.write(`ai-threads: ${e && e.message ? e.message : e}\n`);
  process.exitCode = 1;
});
