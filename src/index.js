'use strict';
/*
 * ai-threads: threads between a person and one AI coding session, and the delivery of their messages
 * into it.
 *
 *   const threads = require('ai-threads');
 *   const at = threads.open();                       // <home> = AI_THREADS_HOME or ~/.ai-threads
 *   at.deliverSync(sessionId, 'Is the deploy fixed?');           // a new thread, Q1
 *   at.deliverSync(sessionId, 'And on staging?', { thread: 1 }); // more in Q1
 *   at.view(sessionId).threads;                      // for chat-thread's createThreads
 */
const core = require('./core');
const markup = require('./markup');
const { DEFAULTS } = require('./config');

module.exports = {
  open: core.open,
  layout: core.layout,
  markup,
  DEFAULTS,
  get claudeCode() { return require('./claude-code'); },
  version: require('../package.json').version,
};
