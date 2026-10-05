// Pure helpers shared by the portable contracts and the Node runtime. No host effects.
export const SHA256_RE = /^[0-9a-f]{64}$/;
export const ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export const isRecord = value => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

export const hasExactKeys = (value, required, optional = []) => {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return required.every(key => Object.hasOwn(value, key)) &&
    keys.every(key => required.includes(key) || optional.includes(key));
};

// Snapshot data properties without invoking accessors; reject cycles and bound work before validation.
export function snapshotNativeData(value, maxBytes = 262144, maxDepth = 16) {
  const active = new WeakSet();
  let bytes = 0;
  const text = value => {
    if (!value.isWellFormed() || value.normalize('NFC') !== value) throw new TypeError('strict-json');
    bytes += new TextEncoder().encode(value).length + 2;
    if (bytes > maxBytes) throw new TypeError('strict-json');
    return value;
  };
  const visit = (input, depth) => {
    bytes += 4;
    if (bytes > maxBytes || depth > maxDepth) throw new TypeError('strict-json');
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'string') return text(input);
    if (typeof input === 'number') {
      if (!Number.isFinite(input) || Object.is(input, -0) || Number.isInteger(input) && !Number.isSafeInteger(input))
        throw new TypeError('strict-json');
      return input;
    }
    if (typeof input !== 'object' || active.has(input)) throw new TypeError('strict-json');
    const array = Array.isArray(input);
    const prototype = Object.getPrototypeOf(input);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      throw new TypeError('strict-json');
    active.add(input);
    const output = array ? [] : Object.create(null);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') throw new TypeError('strict-json');
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('strict-json');
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= input.length)) throw new TypeError('strict-json');
      text(key);
      Object.defineProperty(output, key, { value: visit(descriptor.value, depth + 1), enumerable: true });
    }
    if (array && Object.keys(output).length !== input.length) throw new TypeError('strict-json');
    active.delete(input);
    return output;
  };
  const captured = visit(value, 1);
  if (new TextEncoder().encode(canonicalJson(captured)).length > maxBytes) throw new TypeError('strict-json');
  return captured;
}

// Core canonical JSON profile: UTF-16 key order, no whitespace, no coercion.
export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError('Non-canonical number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new TypeError('Non-JSON value');
}

// Strict JSON: rejects duplicate keys, BOM, trailing data and excess depth. Throws SyntaxError.
export function parseStrictJson(text, maxDepth = 16) {
  if (typeof text !== 'string' || text.charCodeAt(0) === 0xfeff) throw new SyntaxError('strict-json');
  let index = 0;
  const fail = () => { throw new SyntaxError('strict-json'); };
  const space = () => { while (' \t\r\n'.includes(text[index] ?? 'x')) index++; };
  const string = () => {
    const start = index++;
    while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1;
    if (text[index] !== '"') fail();
    index++;
    try { return JSON.parse(text.slice(start, index)); } catch { return fail(); }
  };
  const value = depth => {
    if (depth > maxDepth) throw new SyntaxError('strict-json-depth');
    space();
    const c = text[index];
    if (c === '{') {
      index++;
      const out = Object.create(null);
      space();
      if (text[index] === '}') { index++; return { ...out }; }
      for (;;) {
        space();
        if (text[index] !== '"') fail();
        const key = string();
        if (Object.hasOwn(out, key)) fail();
        space();
        if (text[index++] !== ':') fail();
        out[key] = value(depth + 1);
        space();
        if (text[index] === ',') { index++; continue; }
        if (text[index++] === '}') return { ...out };
        fail();
      }
    }
    if (c === '[') {
      index++;
      const out = [];
      space();
      if (text[index] === ']') { index++; return out; }
      for (;;) {
        out.push(value(depth + 1));
        space();
        if (text[index] === ',') { index++; continue; }
        if (text[index++] === ']') return out;
        fail();
      }
    }
    if (c === '"') return string();
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(index, index + 64));
    if (!match) fail();
    index += match[0].length;
    return JSON.parse(match[0]);
  };
  const result = value(1);
  space();
  if (index !== text.length) fail();
  return result;
}

// Relative tree path: normalized POSIX, no empty/dot/dot-dot parts, no drive or stream.
export function isSafeRelativePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > 512) return false;
  if (/[\\\0:]/.test(path) || path.startsWith('/')) return false;
  return path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

export const isMemberPath = path => typeof path === 'string' && path.startsWith('package/') &&
  isSafeRelativePath(path.slice('package/'.length));

export const isSafeInteger = (value, min, max) =>
  Number.isSafeInteger(value) && value >= min && value <= max;

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);

// Portable SHA-256 so contract validation needs no Node crypto. Accepts a string (UTF-8) or bytes.
export function sha256Hex(input) {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const length = data.length;
  const padded = new Uint8Array(((length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000));
  view.setUint32(padded.length - 4, (length << 3) >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      w[i] = (w[i - 16] + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + w[i - 7] + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return [...h].map(x => x.toString(16).padStart(8, '0')).join('');
}

export const compareCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Entries {root,path,sha256,byteLength} sorted by root then path in code-unit order.
export function treeEntries(files) {
  return files.map(file => ({ root: file.root, path: file.path,
    sha256: file.member.sha256, byteLength: file.member.byteLength }))
    .sort((a, b) => compareCodeUnits(a.root, b.root) || compareCodeUnits(a.path, b.path));
}
