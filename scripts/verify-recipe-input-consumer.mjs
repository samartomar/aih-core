import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output' || !process.env.npm_execpath)
  throw new Error('Use npm run verify:recipe-input-consumer -- --output <new directory>');
const output = resolve(args[1]);
mkdirSync(output);
const consumer = join(output, 'consumer'), home = join(output, 'home');
mkdirSync(consumer); mkdirSync(home);
const env = { ...process.env, HOME: home, USERPROFILE: home,
  PATH: dirname(process.execPath) + delimiter + process.env.PATH };
delete env.NODE_TEST_CONTEXT;
for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key];
const run = (argv, cwd, timeout = 120_000) => execFileSync(process.execPath, argv,
  { cwd, env, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 });
const packed = JSON.parse(run([join(root, 'scripts/pack-distribution.mjs'), '--pack-destination', output], root))[0];
writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'independent-recipe-consumer', private: true, type: 'module',
  dependencies: { '@aihq/core': `file:${join(output, packed.filename)}` } }));
writeFileSync(join(output, 'install.log'), run([process.env.npm_execpath, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], consumer, 300_000));
copyFileSync(join(root, 'examples/recipe-input-consumer.mjs'), join(consumer, 'verify.mjs'));
const proof = JSON.parse(run(['verify.mjs'], consumer));
const installed = JSON.parse(readFileSync(join(consumer, 'node_modules/@aihq/core/package.json')));
const cli = JSON.parse(run([join(consumer, 'node_modules/@aihq/core', installed.bin.aih), '--version', '--json'], consumer));
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
const archiveSha256 = createHash('sha256').update(readFileSync(join(output, packed.filename))).digest('hex');
const receipt = { sourceCommit, archiveSha256, archive: packed.filename, installed: { name: installed.name, version: installed.version }, cli, proof };
writeFileSync(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
