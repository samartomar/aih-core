// Developer-only logic for the Linux runtime platform re-capture tool; never imported by build, install, or native verification.
// Everything here is pure or works through an injected `host`, so tests run without a Linux machine.
// The host never executes the client or any role binary; it only reads and hashes them.
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { validateLinuxPlatformRecord } from '../src/harness/native/linux-platform.mjs';

export const RECORD_PIN_SUFFIX = '/harness/native/linux/runtime-platform.json';
const ROLE_ORDER = ['bash', 'env', 'bwrap', 'socat', 'rg', 'which', 'node', 'client', 'wslinfo'];
const WSLINFO_PATH = '/usr/bin/wslinfo';
const TABLE_ORDER = { host: 0, roles: 1, libraries: 2, readFiles: 3, fixture: 4 };

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const serialize = (value, indent = 2, newline = true) => JSON.stringify(value, null, indent) + (newline ? '\n' : '');
const md5 = bytes => createHash('md5').update(bytes).digest('hex'); // Matches dpkg md5sums; not a security hash here.
const pinOf = bytes => ({ sha256: sha256(bytes), byteLength: bytes.length });
const same = (a, b) => a.sha256 === b.sha256 && a.byteLength === b.byteLength;
const compare = (a, b) => (TABLE_ORDER[a.table] - TABLE_ORDER[b.table]) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

class Refusal extends Error { constructor(reason) { super(reason); this.reason = reason; } }

// Parses `dpkg -S <path>` output. Exactly one owning package (returned with its arch qualifier, e.g. zlib1g:amd64), no diversions.
export function parseDpkgOwner(output, queriedPath) {
  const lines = String(output).split('\n').map(line => line.trim()).filter(Boolean);
  if (!lines.length) throw new Refusal('no owning package');
  const owners = new Set();
  for (const line of lines) {
    if (/^(?:local )?diversion by /i.test(line) || /\bdiverted by\b/i.test(line)) throw new Refusal('path is diverted');
    const split = line.lastIndexOf(': ');
    if (split < 0 || line.slice(split + 2) !== queriedPath) throw new Refusal('unparseable dpkg owner output');
    for (const name of line.slice(0, split).split(', ')) {
      if (!/^[a-z0-9][a-z0-9+.-]*(?::[A-Za-z0-9-]+)?$/.test(name)) throw new Refusal('unparseable dpkg owner output');
      owners.add(name); // Keep the architecture qualifier for every later query.
    }
  }
  if (owners.size !== 1) throw new Refusal('path has multiple owning packages');
  return [...owners][0];
}

// Binds the exact bytes that were hashed to the owning package: the package md5sums must list the path exactly once
// with the md5 of those same bytes. dpkg --verify alone checks the disk now and skips files without md5sums entries.
function checkMd5sums(host, owner, realPath, observedMd5) {
  let text;
  try { text = host.dpkgMd5sums(owner); } catch { throw new Refusal('package md5sums unavailable'); }
  const wanted = realPath.slice(1), entries = [];
  for (const line of String(text).split('\n')) {
    const match = /^([0-9a-f]{32})  (.+)$/.exec(line.trimEnd());
    if (match && match[2] === wanted) entries.push(match[1]);
  }
  if (entries.length !== 1) throw new Refusal('file not covered by package md5sums');
  if (entries[0] !== observedMd5) throw new Refusal('bytes differ from package md5sums');
}

function verifyOwned(host, observed) {
  const realPath = observed.real;
  let output;
  try { output = host.dpkgOwner(realPath); } catch { throw new Refusal('no owning package'); }
  const owner = parseDpkgOwner(output, realPath);
  checkMd5sums(host, owner, realPath, observed.md5);
  let verify;
  try { verify = host.dpkgVerify(owner); } catch { throw new Refusal('package verification failed to run'); }
  if (String(verify).trim() !== '') throw new Refusal(`package ${owner} does not verify clean`);
  let version;
  try { version = String(host.dpkgVersion(owner)).trim(); } catch { throw new Refusal('package version unavailable'); }
  if (!version) throw new Refusal('package version unavailable');
  return { package: owner, packageVersion: version };
}

function observe(host, path) {
  const real = host.realpath(path);
  const bytes = host.readFile(real);
  return { real, md5: md5(bytes), ...pinOf(bytes) };
}

// Walks any JSON value and calls visit(object) for every plain object.
function walk(value, visit) {
  if (Array.isArray(value)) for (const item of value) walk(item, visit);
  else if (value && typeof value === 'object') { visit(value); for (const item of Object.values(value)) walk(item, visit); }
}

function detectFormat(text, parsed) {
  if (serialize(parsed) === text) return { indent: 2, newline: true };
  const match = /^([ \t]+)\S/m.exec(text);
  const indent = match ? (match[1].includes('\t') ? '\t' : match[1].length) : 2;
  const format = { indent, newline: text.endsWith('\n') };
  if (serialize(parsed, format.indent, format.newline) !== text) throw new Refusal('fixture formatting is not reproducible');
  return format;
}

/**
 * Analyse drift. Returns { exitCode, report, writes } where writes is a list of { target: 'record'|'fixture', text }
 * that the caller applies only for --write and exitCode 2 (all-or-nothing: any refusal yields no writes).
 * input: { host, recordText, client, roles: {name: path}, fixtureText? }
 */
export function analyseRecapture({ host, recordText, client, roles = {}, fixtureText }) {
  const refused = [], changed = [];
  const finish = (record, extra = {}) => {
    refused.sort(compare); changed.sort(compare);
    const report = { record, changed, refused, ...extra };
    return { exitCode: refused.length ? 1 : changed.length ? 2 : 0, report, writes: [] };
  };
  const refuseRow = (table, key, reason) => refused.push({ table, key, reason });

  if (host.platform !== 'linux' || host.arch !== 'x64') {
    refuseRow('host', 'platform', 'requires a linux x64 host');
    return finish(null);
  }
  if (typeof client !== 'string' || !client) { refuseRow('roles', 'client', '--client is required'); return finish(null); }

  let record;
  try { record = JSON.parse(recordText); } catch { refuseRow('host', 'record', 'record is not valid JSON'); return finish(null); }
  if (!validateLinuxPlatformRecord(record)) { refuseRow('host', 'record', 'record failed validateLinuxPlatformRecord'); return finish(null); }
  const recordBytes = Buffer.from(recordText, 'utf8');
  const recordPin = pinOf(recordBytes);

  const next = structuredClone(record);
  const applied = []; // { row, nextRow, old, new, keys: Set of observed/logical paths }

  const consider = (table, key, row, nextRow, observed, extraKeys, verify, extraEntry = {}) => {
    const old = { sha256: row.sha256, byteLength: row.byteLength };
    const now = { sha256: observed.sha256, byteLength: observed.byteLength };
    if (same(old, now)) return;
    const entry = { table, key, old, new: now, ...extraEntry };
    try {
      Object.assign(entry, verify());
      nextRow.sha256 = now.sha256; nextRow.byteLength = now.byteLength;
      applied.push({ old, new: now, keys: new Set([observed.real, ...extraKeys]) });
      changed.push(entry);
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      refuseRow(table, key, error.reason);
      changed.push(entry);
    }
  };

  // Roles
  const rolePaths = {};
  for (const name of ROLE_ORDER) {
    const row = record.roles[name];
    if (row === null) continue;
    let candidates = [];
    const explicit = roles[name];
    if (explicit) candidates = [explicit];
    else if (name === 'node') candidates = [host.execPath];
    else if (name === 'client') candidates = [client];
    else if (name === 'wslinfo') candidates = [WSLINFO_PATH];
    else candidates = [...new Set(host.whichAll(name, host.pathEnv) ?? [])];
    const seen = [];
    for (const path of candidates) { try { seen.push({ path, ...observe(host, path) }); } catch { /* unreadable candidate */ } }
    if (!candidates.length) { refuseRow('roles', name, 'role binary not found'); continue; }
    if (!seen.length) { refuseRow('roles', name, 'role binary could not be read'); continue; }
    // The runtime accepts the first PATH candidate that matches the pin, so any matching candidate means no drift.
    const match = seen.find(item => same(item, row));
    const observed = match ?? seen[0];
    rolePaths[name] = observed.real;
    const extraEntry = !match && !explicit && candidates.length > 1 ? { candidates } : {};
    consider('roles', name, row, next.roles[name], observed, [observed.path], () => {
      if (name === 'client') throw new Refusal('upstream artifact changed; requires a reviewed code change');
      if (name === 'node') {
        throw new Refusal(explicit ? 'upstream artifact changed; requires a reviewed code change'
          : 'the running node differs from the recorded node (pass --role node=<path> if another binary was intended); a node change requires a reviewed code change');
      }
      const owner = verifyOwned(host, observed);
      if (owner.packageVersion !== row.version) {
        throw new Refusal(`installed ${owner.package} version ${owner.packageVersion} differs from recorded ${row.version}; requires a reviewed code change`);
      }
      return owner;
    }, extraEntry);
  }

  // Libraries and read files
  for (const [table, rows, nextRows] of [['libraries', record.libraries, next.libraries], ['readFiles', record.readFiles, next.readFiles]]) {
    rows.forEach((row, index) => {
      const isRole = typeof row.role === 'string';
      const key = isRole ? `${row.role}:${row.relative}` : row.path;
      let base = null;
      if (isRole) {
        if (!rolePaths[row.role]) { refuseRow(table, key, `role ${row.role} unavailable`); return; }
        base = posix.dirname(rolePaths[row.role]);
      }
      const logical = isRole ? posix.resolve(base, row.relative) : row.path;
      let observed;
      try { observed = observe(host, logical); } catch { refuseRow(table, key, 'file could not be read'); return; }
      let aliasOk = true;
      for (const alias of row.aliases ?? []) {
        const aliasPath = isRole ? posix.resolve(base, alias) : alias;
        let real;
        try { real = host.realpath(aliasPath); } catch { real = null; }
        if (real !== observed.real) { refuseRow(table, key, `alias ${alias} does not resolve to the row target`); aliasOk = false; }
      }
      if (!aliasOk) return;
      consider(table, key, row, nextRows[index], observed, [logical], () => verifyOwned(host, observed));
    });
  }

  if (refused.length) return finish(recordPin);

  const result = { exitCode: changed.length ? 2 : 0, report: null, writes: [] };
  let newRecordText = recordText, newPin = recordPin;
  if (changed.length) {
    if (serialize(record) !== recordText) {
      refuseRow('host', 'record', 'record is not in canonical formatting; refusing to reformat it');
      return finish(recordPin);
    }
    if (!validateLinuxPlatformRecord(next)) {
      refuseRow('host', 'record', 'rewritten record failed validateLinuxPlatformRecord');
      return finish(recordPin);
    }
    newRecordText = serialize(next);
    newPin = pinOf(Buffer.from(newRecordText, 'utf8'));
    result.writes.push({ target: 'record', text: newRecordText });
  }

  // Fixture synchronisation
  const extra = {};
  if (fixtureText !== undefined) {
    const fixtureChanges = [], unmatchedRecordPins = [];
    try {
      let fixture;
      try { fixture = JSON.parse(fixtureText); } catch { throw new Refusal('fixture is not valid JSON'); }
      const format = detectFormat(fixtureText, fixture);
      walk(fixture, object => {
        const location = typeof object.path === 'string' ? object.path : typeof object.source === 'string' ? object.source : null;
        if (location === null || typeof object.sha256 !== 'string') return;
        const isRecordPin = location.endsWith(RECORD_PIN_SUFFIX);
        if (isRecordPin) {
          // Old hash: re-pin. New hash: already current. Anything else (for example a fixture captured from another checkout)
          // is left unchanged and reported for manual review.
          if (changed.length && object.sha256 === recordPin.sha256) {
            fixtureChanges.push({ key: location, kind: 'record-pin', old: { sha256: object.sha256, byteLength: object.byteLength }, new: newPin });
            object.sha256 = newPin.sha256;
            object.byteLength = newPin.byteLength;
          }
          else if (object.sha256 !== recordPin.sha256 && object.sha256 !== newPin.sha256) unmatchedRecordPins.push({ key: location, sha256: object.sha256 });
          return;
        }
        const hit = applied.find(row => row.keys.has(location));
        if (!hit) return;
        if (object.sha256 === hit.old.sha256) {
          fixtureChanges.push({ key: location, kind: 'row', old: { sha256: object.sha256, byteLength: object.byteLength }, new: hit.new });
          object.sha256 = hit.new.sha256; object.byteLength = hit.new.byteLength;
        } else if (object.sha256 !== hit.new.sha256) {
          throw new Refusal(`fixture row ${location} matches neither the old nor the new hash`);
        }
      });
      fixtureChanges.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.kind < b.kind ? -1 : 1));
      if (fixtureChanges.length) result.writes.push({ target: 'fixture', text: serialize(fixture, format.indent, format.newline) });
      unmatchedRecordPins.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
      extra.fixture = { changed: fixtureChanges, unmatchedRecordPins };
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      refuseRow('fixture', 'fixture', error.reason);
      return finish(recordPin);
    }
  }

  result.report = { record: recordPin, changed, refused, ...extra };
  if (changed.length) result.report.newRecord = newPin;
  return result;
}

/** CLI argument parsing. Returns { client, roles, fixture, write } or throws Error with a usage message. */
export function parseArguments(argv) {
  const out = { client: undefined, roles: {}, fixture: undefined, write: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--write') out.write = true;
    else if (arg === '--client' || arg === '--fixture' || arg === '--role') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--client') { if (out.client !== undefined) throw new Error('--client may be given once'); out.client = value; }
      else if (arg === '--fixture') { if (out.fixture !== undefined) throw new Error('--fixture may be given once'); out.fixture = value; }
      else {
        const eq = value.indexOf('=');
        const name = value.slice(0, eq);
        if (eq < 1 || eq === value.length - 1 || !ROLE_ORDER.includes(name)) throw new Error('--role expects <name>=<path> with a known role name');
        out.roles[name] = value.slice(eq + 1);
      }
    } else throw new Error(`Unknown argument ${arg}`);
  }
  if (!out.client) throw new Error('--client <path> is required');
  return out;
}

/**
 * Applies record/fixture writes as a pair: every temp file is written first, then each is renamed into place.
 * fsOps: { writeTemp(target, text) -> tempPath, rename(tempPath, target), remove(tempPath) }.
 * Returns { written: [targetNames], error?: string }. On any failure the remaining temp files are removed.
 */
export function applyPairedWrites(writes, fsOps) {
  const staged = [], written = [];
  const cleanup = () => { for (const item of staged) if (!item.done) { try { fsOps.remove(item.temp); } catch { /* best effort */ } } };
  try { for (const write of writes) staged.push({ write, temp: fsOps.writeTemp(write.path, write.text), done: false }); }
  catch (error) { cleanup(); return { written, error: error.message }; }
  for (const item of staged) {
    try { fsOps.rename(item.temp, item.write.path); item.done = true; written.push(item.write.target); }
    catch (error) { cleanup(); return { written, error: error.message }; }
  }
  return { written };
}
