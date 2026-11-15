'use strict';
/* The part of Node's Buffer the library uses (the transcript reader): alloc, subarray, lastIndexOf and toString. */
class Buffer extends Uint8Array {
  static alloc(size) { return new Buffer(size); }

  static from(value) {
    if (typeof value === 'string') return new Buffer(new TextEncoder().encode(value));
    return new Buffer(value);
  }

  toString(encoding = 'utf8', start = 0, end = this.length) {
    const part = this.subarray(start, end);
    if (encoding === 'hex') return Array.from(part, (b) => b.toString(16).padStart(2, '0')).join('');
    return new TextDecoder().decode(part);
  }
}

module.exports = { Buffer };
