// Fetch a Dart package and all its transitive deps from pub.dev, extract
// them, and emit a DPKG bundle in the format the in-browser analyzer reads.
//
// Usage:
//   node pack_pub_packages.mjs <out.bin> <pkg1> [pkg2 ...]
//
// "Latest version satisfying its parent's constraint" is what we pick at each
// node, with no diamond-conflict reconciliation. Good enough for prototype
// runs against well-behaved package trees.

import { writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('usage: pack_pub_packages.mjs <out.bin> <pkg1> [pkg2 ...]');
  process.exit(2);
}
const outPath = args[0];
const seeds = args.slice(1);

const pubBase = 'https://pub.dev/api';
const metaCache = new Map();

async function fetchMeta(name) {
  if (metaCache.has(name)) return metaCache.get(name);
  const r = await fetch(`${pubBase}/packages/${name}`);
  if (!r.ok) throw new Error(`pub.dev meta ${name}: ${r.status}`);
  const j = await r.json();
  metaCache.set(name, j);
  return j;
}

function parseConstraint(c) {
  if (typeof c !== 'string') return { any: true };
  if (c === 'any') return { any: true };
  // Very small subset: ^x.y.z and >=x.y.z <a.b.c
  const caret = c.match(/^\^(\d+)\.(\d+)\.(\d+)$/);
  if (caret) {
    const [_, a, b, d] = caret;
    return { min: [+a, +b, +d], maxMajor: +a + 1 };
  }
  // Fallback: accept anything.
  return { any: true };
}

function cmpVer(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function pickLatest(versionsMeta, constraint) {
  // versionsMeta is a list of version metadata objects (from /api/packages/X).
  // We want to pick the newest stable-ish version that satisfies the constraint.
  const candidates = [];
  for (const v of versionsMeta.versions) {
    const ver = v.version;
    const m = ver.match(/^(\d+)\.(\d+)\.(\d+)([-+].*)?$/);
    if (!m) continue;
    const num = [+m[1], +m[2], +m[3]];
    const isPre = !!m[4] && m[4].startsWith('-');
    if (isPre) continue;
    if (constraint.any) {
      candidates.push({ ver, num });
    } else if (constraint.min) {
      if (cmpVer(num, constraint.min) >= 0 && num[0] < constraint.maxMajor) {
        candidates.push({ ver, num });
      }
    }
  }
  candidates.sort((a, b) => cmpVer(b.num, a.num));
  return candidates[0]?.ver ?? versionsMeta.latest.version;
}

// Minimal POSIX tar reader on a Uint8Array, returning [{path, content}].
function untar(buf) {
  const view = new Uint8Array(buf);
  const out = [];
  let off = 0;
  let longName = null;
  const decUtf8 = new TextDecoder('utf-8');
  while (off + 512 <= view.length) {
    const header = view.subarray(off, off + 512);
    // empty block = end of archive
    if (header.every(b => b === 0)) break;
    const nameRaw = decUtf8.decode(header.subarray(0, 100)).replace(/\0.*$/, '');
    const prefix = decUtf8.decode(header.subarray(345, 500)).replace(/\0.*$/, '');
    const sizeStr = decUtf8.decode(header.subarray(124, 136)).replace(/\0.*$/, '').trim();
    const size = parseInt(sizeStr || '0', 8);
    const typeFlag = String.fromCharCode(header[156]) || '0';
    let name = prefix ? `${prefix}/${nameRaw}` : nameRaw;
    if (longName) { name = longName; longName = null; }
    const dataStart = off + 512;
    const dataEnd = dataStart + size;
    const padded = Math.ceil(size / 512) * 512;
    if (typeFlag === 'L') {
      // GNU long-name extension
      longName = decUtf8.decode(view.subarray(dataStart, dataEnd)).replace(/\0.*$/, '');
    } else if (typeFlag === '0' || typeFlag === '' || typeFlag === '\0') {
      // regular file
      out.push({ path: name, content: view.subarray(dataStart, dataEnd) });
    }
    off = dataStart + padded;
  }
  return out;
}

async function fetchTarball(name, ver) {
  const url = `${pubBase}/archives/${name}-${ver}.tar.gz`;
  console.error(`  fetching ${url}`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`tarball ${name}-${ver}: ${r.status}`);
  const gz = new Uint8Array(await r.arrayBuffer());
  const tar = gunzipSync(gz);
  return untar(tar);
}

// Discover transitive deps. Pick a version per package, store its file list.
const resolved = new Map(); // name -> { ver, files }
async function resolveAndFetch(name, constraint) {
  if (resolved.has(name)) return; // First-write-wins; no conflict resolution.
  const meta = await fetchMeta(name);
  const ver = pickLatest(meta, constraint);
  const files = await fetchTarball(name, ver);
  resolved.set(name, { ver, files });
  // Find the package's deps via the pubspec at the chosen version.
  const verEntry = meta.versions.find(v => v.version === ver) ?? meta.latest;
  const deps = verEntry.pubspec.dependencies ?? {};
  for (const [dep, depConstraint] of Object.entries(deps)) {
    // Skip SDK pseudo-packages.
    if (typeof depConstraint === 'object' && depConstraint?.sdk) continue;
    // Skip packages we know we already cover via dart: SDK.
    if (dep === 'dart' || dep === 'meta' && false) continue; // keep meta; uncomment to skip
    await resolveAndFetch(dep, parseConstraint(depConstraint));
  }
}

for (const seed of seeds) {
  await resolveAndFetch(seed, { any: true });
}

console.error('\nresolved closure:');
for (const [n, v] of resolved) console.error(`  ${n}: ${v.ver} (${v.files.length} files)`);

// Pack DPKG bundle.
const enc = new TextEncoder();
function appendU32LE(arr, n) {
  arr.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
}
function appendBytes(arr, b) { for (const x of b) arr.push(x); }
function appendString(arr, s) {
  const b = enc.encode(s);
  appendU32LE(arr, b.length);
  appendBytes(arr, b);
}

const buf = [];
appendBytes(buf, [0x44, 0x50, 0x4B, 0x47]); // "DPKG"
appendU32LE(buf, resolved.size);
for (const [name, { files }] of resolved) {
  appendString(buf, name);
  appendU32LE(buf, files.length);
  for (const f of files) {
    appendString(buf, f.path);
    appendU32LE(buf, f.content.length);
    appendBytes(buf, f.content);
  }
}

writeFileSync(outPath, new Uint8Array(buf));
console.error(`\nwrote ${outPath}: ${buf.length} bytes (${resolved.size} packages)`);
