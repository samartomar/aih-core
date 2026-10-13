import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const suite = args[0] === '--suite' ? args[1] : 'full';
let files;
if (args[0] === '--files') files = args.slice(1);
else if (args.length === 0 || (args.length === 2 && ['full', 'report'].includes(suite))) {
  files = ['test', 'test/harness'].flatMap(directory => readdirSync(directory)
    .filter(name => name.endsWith('.test.mjs')).map(name => `${directory}/${name}`));
  if (suite === 'report') files = files.filter(path => /^test\/harness\/report-/.test(path) ||
    ['test/support-report.test.mjs', 'test/harness-contracts.test.mjs', 'test/package.test.mjs', 'test/ci-routing.test.mjs'].includes(path));
} else throw new Error('Use npm test -- [--suite full|report] or --files <test paths>');
if (!files.length) throw new Error('No selected tests');
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=4', ...files],
  { stdio: 'inherit', env, windowsHide: true, timeout: 35 * 60_000 });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
