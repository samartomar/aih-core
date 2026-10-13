import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
let changes;
try {
  if (args.includes('--changes')) changes = JSON.parse(option('--changes'));
  else {
    const fields = execFileSync('git', ['diff', '--name-status', '-z', '--find-renames',
      option('--base'), option('--head')], { encoding: 'utf8', windowsHide: true, timeout: 30_000 }).split('\0');
    changes = [];
    while (fields[0]) {
      const status = fields.shift();
      changes.push({ status, paths: fields.splice(0, /^[RC]/.test(status) ? 2 : 1) });
    }
  }
  if (!Array.isArray(changes) || changes.some(row => typeof row.status !== 'string' || !Array.isArray(row.paths) ||
    row.paths.length === 0 || row.paths.some(path => typeof path !== 'string' || !path))) throw new Error('Invalid changes');
} catch {
  // A missing base or malformed diff must widen coverage, never produce a green skip.
  changes = [{ status: '?', paths: ['unknown'] }];
}
const docs = path => /^(?:docs\/.*\.md|README\.md|CHANGELOG\.md|LICENSE|NOTICE|AGENTS\.md)$/.test(path);
let suite = changes.every(row => row.status === 'M' && row.paths.every(docs)) ? 'none' : 'full';
const report = path => /^(?:src\/harness\/report\/|test\/harness\/report-|examples\/reporting\/)/.test(path);
if (changes.length && changes.every(row => /^[AM]$/.test(row.status) && row.paths.every(path => docs(path) || report(path))))
  suite = changes.some(row => row.paths.some(report)) ? 'report' : suite;
const platform = path => path.startsWith('src/harness/native/linux/') ? 'ubuntu-latest' :
  path.startsWith('src/harness/native/windows/') ? 'windows-latest' :
  /^src\/harness\/macos-session-platform\.(?:mjs|d\.mts)$/.test(path) ? 'macos-latest' : undefined;
const platforms = new Set(changes.flatMap(row => row.paths.filter(path => !docs(path)).map(platform)));
const platformOnly = changes.length && changes.every(row => /^[AM]$/.test(row.status) && row.paths.every(path => docs(path) || platform(path)));
if (args.includes('--full')) suite = 'full';
const matrix = args.includes('--full') || !platformOnly ? suite === 'none' ? [] : suite === 'report' ? [{ os: 'ubuntu-latest', node: '24' }] : [
  { os: 'ubuntu-latest', node: '24' }, { os: 'windows-latest', node: '24' },
  { os: 'macos-latest', node: '24' }, { os: 'ubuntu-latest', node: '24.15.0' }
] : [...platforms].sort().map(os => ({ os, node: '24' }));
const result = { suite, matrix, nativeLinux: suite === 'full' && matrix.some(row => row.os === 'ubuntu-latest'),
  reason: args.includes('--full') ? 'explicit-full' : suite === 'none' ? 'documentation-only' : suite === 'report' ? 'portable-report' : platformOnly ? 'platform-facility' : 'full-fallback' };
process.stdout.write(JSON.stringify(result) + '\n');
if (process.env.GITHUB_OUTPUT) for (const [key, value] of Object.entries(result))
  appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}\n`);
