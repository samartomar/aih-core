// Developer-only re-capture of exact Linux runtime pins; never invoked by build, install, test globbing, or native verification.
// Usage: node scripts/recapture-linux-runtime-platform.mjs --client <path> [--role <name>=<path>]... [--fixture <file>] [--write]
// Exit 0: no drift. Exit 2: drift found and every changed row verified rewritable (report only; with --write the rows are rewritten and exit is 0).
// Exit 1: refusal (verification failure, unsupported change, wrong host). The client and role binaries are only read and hashed, never executed.
// With --fixture, a fixture record-file pin matching neither the old nor new record hash is left unchanged and listed in fixture.unmatchedRecordPins for manual review.
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, statSync } from 'node:fs';
import { delimiter, dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyseRecapture, parseArguments } from './linux-runtime-recapture.mjs';

const recordPath = fileURLToPath(new URL('../src/harness/native/linux/runtime-platform.json', import.meta.url));
const MAX_FILE = 268435456;

const dpkg = (command, args) => execFileSync(command, args, { shell: false, encoding: 'utf8', env: { LANG: 'C', PATH: '/usr/bin:/bin' },
  stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 1048576 });
const safeDirectory = value => /^\/[A-Za-z0-9._/+-]+$/.test(value) && value !== '/' && !value.endsWith('/');

const host = {
  platform: process.platform, arch: process.arch, execPath: process.execPath, pathEnv: process.env.PATH ?? '',
  readFile(path) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_FILE) throw new Error('not a bounded regular file');
    return readFileSync(path);
  },
  realpath: path => realpathSync(path),
  which(name, pathEnv) {
    for (const directory of new Set(String(pathEnv).split(delimiter).filter(safeDirectory))) {
      const candidate = posix.join(directory, name);
      try { if (statSync(candidate).isFile()) return candidate; } catch { /* try the next PATH entry */ }
    }
    return null;
  },
  dpkgOwner: path => dpkg('dpkg', ['-S', path]),
  dpkgVerify: pkg => dpkg('dpkg', ['--verify', pkg]),
  dpkgVersion: pkg => dpkg('dpkg-query', ['-W', '-f=${Version}', pkg]),
};

// Temp file plus rename in the same directory; the target is never left half-written.
function writeAtomic(path, text) {
  const temporary = join(dirname(path), `.${process.pid}.recapture.tmp`);
  try { writeFileSync(temporary, text, { flag: 'wx' }); renameSync(temporary, path); }
  catch (error) { try { unlinkSync(temporary); } catch { /* nothing to clean */ } throw error; }
}

let options;
try { options = parseArguments(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exit(1); }

const result = analyseRecapture({ host, recordText: readFileSync(recordPath, 'utf8'), client: options.client, roles: options.roles,
  fixtureText: options.fixture ? readFileSync(options.fixture, 'utf8') : undefined });
let exitCode = result.exitCode;
if (options.write && result.exitCode === 2) {
  for (const write of result.writes) writeAtomic(write.target === 'record' ? recordPath : options.fixture, write.text);
  result.report.written = result.writes.map(write => write.target);
  exitCode = 0;
}
console.log(JSON.stringify(result.report, null, 2));
process.exit(exitCode);
