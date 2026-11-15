'use strict';
/* POSIX paths, enough for the library: every path in the demo is absolute and starts at /. */
function normalize(p) {
  const absolute = String(p).startsWith('/');
  const out = [];
  for (const part of String(p).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return (absolute ? '/' : '') + out.join('/') || (absolute ? '/' : '.');
}

function resolve(...parts) {
  let p = '';
  for (let i = parts.length - 1; i >= 0 && !p.startsWith('/'); i--) {
    if (parts[i]) p = p ? `${parts[i]}/${p}` : String(parts[i]);
  }
  return normalize(p.startsWith('/') ? p : `/${p}`);
}

const join = (...parts) => normalize(parts.filter((x) => x !== '').join('/'));

function dirname(p) {
  const n = normalize(p);
  const i = n.lastIndexOf('/');
  return i > 0 ? n.slice(0, i) : i === 0 ? '/' : '.';
}

function basename(p, ext) {
  const b = normalize(p).split('/').pop() || '';
  return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
}

function extname(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i) : '';
}

module.exports = { sep: '/', delimiter: ':', normalize, resolve, join, dirname, basename, extname, isAbsolute: (p) => String(p).startsWith('/') };
