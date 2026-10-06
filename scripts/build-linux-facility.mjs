// Development/CI only: compile the fixed helper twice; installed packages never compile native code.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux' || process.arch !== 'x64') throw Error('Linux x64 build host required');
const mode = process.argv[2];
if (!['--check', '--write', '--artifact'].includes(mode)) throw Error('Use --check, --write or --artifact');
const root = fileURLToPath(new URL('../', import.meta.url));
const resources = join(root, 'src/harness/native/linux');
const output = join(root, '.scratch/native-linux-build');
const source = join(resources, 'facility.c');
const cc = realpathSync('/usr/bin/cc'), ld = realpathSync('/usr/bin/ld'), assembler = realpathSync('/usr/bin/as');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const flags = ['-std=c11', '-O2', '-D_FORTIFY_SOURCE=3', '-fstack-protector-strong', '-fPIE', '-static-pie',
  '-Wl,-z,relro,-z,now,-z,noexecstack', '-Wall', '-Wextra', '-Werror'];
const run = (file, argv) => execFileSync(file, argv, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', SOURCE_DATE_EPOCH: '0' } }).trim();
const info = file => ({ identity: run(file, ['--version']).split('\n')[0], sha256: sha(readFileSync(file)) });
const scratch = mkdtempSync(join(tmpdir(), 'aih-native-build-'));
try {
  const builds = ['one', 'two'].map(name => { const dir = join(scratch, name); mkdirSync(dir); return join(dir, 'facility'); });
  for (const target of builds) run(cc, [...flags, source, '-o', target]);
  const first = readFileSync(builds[0]), second = readFileSync(builds[1]);
  if (!first.equals(second)) throw Error('Independent helper builds differ');
  const elf = run('/usr/bin/readelf', ['-lW', builds[0]]);
  if (/\bINTERP\b/.test(elf) || !/\bGNU_RELRO\b/.test(elf) || !/GNU_STACK[^\n]*\bRW\s/.test(elf) || /GNU_STACK[^\n]*\bRWE\b/.test(elf))
    throw Error('Expected static PIE with RELRO and a non-executable stack');
  const record = { protocol: 1, platform: 'linux-x64', resources: [
    { name: 'facility.c', sha256: sha(readFileSync(source)), byteLength: readFileSync(source).length },
    { name: 'facility', sha256: sha(first), byteLength: first.length }], compiler: { ...info(cc), flags },
    build: { status: process.env.GITHUB_ACTIONS === 'true' ? 'ci-reproduced' : 'local-reproduced', independentBuildVerified: true,
      elf: 'ELF64 x86-64 static PIE; no PT_INTERP; GNU_RELRO; non-executable GNU_STACK',
      libcHeaders: run('/usr/bin/getconf', ['GNU_LIBC_VERSION']), linker: info(ld), assembler: info(assembler) } };
  mkdirSync(output, { recursive: true });
  copyFileSync(builds[0], join(output, 'facility'));
  writeFileSync(join(output, 'build-record.json'), JSON.stringify(record, null, 2) + '\n');
  if (mode === '--write') for (const name of ['facility', 'build-record.json']) copyFileSync(join(output, name), join(resources, name));
  if (mode === '--check') {
    const installed = JSON.parse(readFileSync(join(resources, 'build-record.json'), 'utf8'));
    if (!installed.build.independentBuildVerified || installed.build.status !== 'ci-reproduced' ||
        installed.resources.some(row => sha(readFileSync(join(resources, row.name))) !== row.sha256) ||
        installed.resources.find(row => row.name === 'facility').sha256 !== sha(first)) throw Error('Bundled helper differs from CI reproduction');
  }
  process.stdout.write(JSON.stringify({ output: resolve(output), sourceSha256: record.resources[0].sha256,
    binarySha256: record.resources[1].sha256, independentBuildVerified: true }) + '\n');
} finally { rmSync(scratch, { recursive: true, force: true }); }
