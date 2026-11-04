#!/usr/bin/env node
// Public-consumer gate (contract 3, 17, 18 journey 13): installs an explicitly selected Core artifact into an isolated
// consumer and checks what a consumer observes. It never chooses package versions and never builds Core.
//
//   npm run verify:public-consumer -- --core <core.tgz> [--catalog <catalog.tgz>] [--scan <scan.tgz>] --output <new-directory>
//
// Without --catalog or --scan, the producer checks run against Core-side FIXTURES only and are recorded in
// `notExercised`: a real Catalog plan (renderStep, planRecipe, planInstall) and a real Scan summary (verifySummary,
// matchScan) need the producers' own artifacts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const { values: options } = parseArgs({ options: { core: { type: 'string' }, catalog: { type: 'string' }, scan: { type: 'string' },
  output: { type: 'string' } } });
if (!options.core || !options.output) {
  console.error('Usage: npm run verify:public-consumer -- --core <tgz> [--catalog <tgz>] [--scan <tgz>] --output <new-directory>');
  process.exit(2);
}
const output = resolve(options.output);
assert.equal(existsSync(output), false, 'The output directory must not exist.');
const source = fileURLToPath(new URL('../', import.meta.url));
const consumer = join(output, 'consumer'), home = join(output, 'home'), project = join(output, 'project');
for (const path of [consumer, home, project]) mkdirSync(path, { recursive: true });
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const artifacts = Object.fromEntries(['core', 'catalog', 'scan'].filter(name => options[name])
  .map(name => { const path = resolve(options[name]); assert.ok(isAbsolute(path) && existsSync(path), `--${name}`); return [name, { path, sha256: sha256(path) }]; }));
const dependencies = { '@aihq/core': `file:${artifacts.core.path}` };
if (artifacts.catalog) dependencies['@aihq/catalog'] = `file:${artifacts.catalog.path}`;
if (artifacts.scan) dependencies['@aihq/scan'] = `file:${artifacts.scan.path}`;
writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'core-public-consumer', private: true, type: 'module', dependencies }));
writeFileSync(join(consumer, '.npmrc'), '@sigstore:registry=http://127.0.0.1:1/\nfetch-retries=0\n');
const env = { ...process.env, HOME: home, USERPROFILE: home };
delete env.NODE_TEST_CONTEXT;
for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key];
assert.ok(process.env.npm_execpath, 'Run through npm so the npm CLI is known.');
execFileSync(process.execPath, [process.env.npm_execpath, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'],
  { cwd: consumer, env, stdio: 'inherit', timeout: 300_000, windowsHide: true });
for (const name of ['plan-fixture.mjs', 'change-fixture.mjs']) {
  const fixture = join(source, 'test/fixtures', name);
  if (existsSync(fixture)) cpSync(fixture, join(consumer, name));
}
cpSync(join(source, 'scripts/public-consumer-check.mjs'), join(consumer, 'check.mjs'));
const receipt = JSON.parse(execFileSync(process.execPath, ['check.mjs'], { cwd: consumer, env: { ...env, TEST_PROJECT: project },
  encoding: 'utf8', timeout: 300_000, windowsHide: true }).trim().split('\n').at(-1));
assert.equal(receipt.status, 'passed', JSON.stringify(receipt));
const files = (root, prefix = '') => readdirSync(join(root, prefix)).flatMap(name => {
  const relative = prefix ? `${prefix}/${name}` : name;
  return lstatSync(join(root, relative)).isDirectory() ? files(root, relative) : [relative];
});
// No private engineering files or absolute developer paths ship in Core.
const installed = join(consumer, 'node_modules/@aihq/core');
for (const file of files(installed).filter(path => !path.startsWith('node_modules/'))) {
  assert.equal(/(?:^|\/)(?:AGENTS\.md|GLOSSARY-MAP\.md|\.scratch|docs\/agents|docs\/plans|docs\/specs)(?:\/|$)/.test(file), false, file);
  if (/\.(?:m?js|cjs|ts|mts|json|md)$/.test(file)) assert.equal(/[A-Za-z]:[\\/](?:Users|dev)[\\/]/.test(readFileSync(join(installed, file), 'utf8')), false, file);
}
const acceptance = { gate: 'core-public-consumer', artifacts, checks: receipt.checks, notExercised: receipt.notExercised,
  privateFilesExcluded: true };
writeFileSync(join(output, 'acceptance.json'), JSON.stringify(acceptance, null, 2) + '\n');
console.log(JSON.stringify({ status: 'passed', output, checks: receipt.checks.length, notExercised: receipt.notExercised }));
