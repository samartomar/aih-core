// Developer-only re-capture of exact Linux runtime pins; never invoked by build, install, test globbing, or native verification.
// Usage: node scripts/recapture-linux-runtime-platform.mjs --client <path> [--role <name>=<path>]... [--fixture <file>] [--write]
// Exit 0: no drift. Exit 2: drift found and every changed row verified rewritable (report only; with --write the rows are rewritten and exit is 0).
// Exit 1: refusal (verification failure, unsupported change, wrong host). The client and role binaries are only read and hashed, never executed.
// With --write the record and fixture are staged as temp files first and renamed only afterwards; a failure removes temp files, reports `written`/`writeError`, and exits 1.
// With --fixture, a fixture record-file pin matching neither the old nor new record hash is left unchanged and listed in fixture.unmatchedRecordPins for manual review.
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyseRecapture, applyPairedWrites, parseArguments } from './linux-runtime-recapture.mjs';

const recordPath = fileURLToPath(new URL('../src/harness/native/linux/runtime-platform.json', import.meta.url));
const MAX_FILE = 268435456;

// Any non-zero exit, spawn error, or stderr output is a failure; the logic module turns it into a refusal.
const dpkg = (command, args) => {
  const run = spawnSync(command, args, { shell: false, encoding: 'utf8', env: { LANG: 'C', PATH: '/usr/bin:/bin' },
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 4194304 });
  if (run.error || run.status !== 0 || run.stderr !== '') throw new Error(`${command} failed`);
  return run.stdout;
};
// Same PATH admission as the runtime's role search: bounded, normalized absolute entries; candidates must be executable.
const safeDirectory = value => value.length <= 4096 && /^\/[A-Za-z0-9._/+-]+$/.test(value) && value !== '/' &&
  posix.normalize(value) === value && !value.endsWith('/');

const host = {
  platform: process.platform, arch: process.arch, execPath: process.execPath, pathEnv: process.env.PATH ?? '',
  readFile(path) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_FILE) throw new Error('not a bounded regular file');
    return readFileSync(path);
  },
  realpath: path => realpathSync(path),
  whichAll(name, pathEnv) {
    const found = [], value = String(pathEnv), entries = value.split(delimiter);
    if (value.length > 32768 || entries.length > 64) return found;
    for (const directory of new Set(entries.filter(safeDirectory))) {
      const candidate = posix.join(directory, name);
      try { const stat = statSync(candidate); if (stat.isFile() && stat.mode & 0o111) found.push(candidate); } catch { /* try the next PATH entry */ }
    }
    return found;
  },
  dpkgOwner: path => dpkg('dpkg', ['-S', path]),
  dpkgVerify: owner => dpkg('dpkg', ['--verify', owner]),
  dpkgMd5sums: owner => dpkg('dpkg-query', ['--control-show', owner, 'md5sums']),
  dpkgVersion: owner => dpkg('dpkg-query', ['-W', '-f=${Version}', owner]),
};

// Temp files are written next to their targets first; renames happen only after every temp file exists.
const fsOps = {
  writeTemp(target, text) {
    const temporary = join(dirname(target), `.${process.pid}.${basename(target)}.recapture.tmp`);
    try { writeFileSync(temporary, text, { flag: 'wx' }); }
    catch (error) {
      // A partial temp file we created is removed; an existing one (EEXIST) is not ours to delete.
      if (error.code !== 'EEXIST') try { unlinkSync(temporary); } catch { /* never created */ }
      throw error;
    }
    return temporary;
  },
  rename: (temporary, target) => renameSync(temporary, target),
  remove: temporary => unlinkSync(temporary),
};

let options;
try { options = parseArguments(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exit(1); }

const result = analyseRecapture({ host, recordText: readFileSync(recordPath, 'utf8'), client: options.client, roles: options.roles,
  fixtureText: options.fixture ? readFileSync(options.fixture, 'utf8') : undefined });
let exitCode = result.exitCode;
if (options.write && result.exitCode === 2) {
  const writes = result.writes.map(write => ({ ...write, path: write.target === 'record' ? recordPath : options.fixture }));
  const outcome = applyPairedWrites(writes, fsOps);
  result.report.written = outcome.written;
  if (outcome.error) { result.report.writeError = outcome.error; exitCode = 1; } else exitCode = 0;
}
console.log(JSON.stringify(result.report, null, 2));
process.exit(exitCode);
