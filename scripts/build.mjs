import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

execFileSync(process.execPath, ['scripts/generate-report-template.mjs','--check'], {windowsHide:true,stdio:'inherit'});
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const compilerManifest = require.resolve('typescript/package.json');
const compiler = JSON.parse(readFileSync(compilerManifest, 'utf8')).bin.tsc;
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (manifest.name !== '@aihq/core' || typeof manifest.version !== 'string' || !manifest.version)
  throw new Error('Expected the Core distribution identity');
// Always remove previous layouts before producing the only publishable tree.
const dist = new URL('../dist/', import.meta.url);
rmSync(dist, { recursive: true, force: true });
execFileSync(process.execPath, [resolve(dirname(compilerManifest), compiler), '-p', 'tsconfig.json'],
  { cwd: root, stdio: 'inherit' });
mkdirSync(new URL('harness/', dist), { recursive: true });
cpSync(new URL('../src/harness/schemas/', import.meta.url), new URL('harness/schemas/', dist), { recursive: true });
for (const name of ['contracts.mjs', 'contracts.d.mts', 'runtime.mjs', 'runtime.d.mts', 'ca.mjs', 'candidate.mjs', 'github-policy.mjs', 'user-trust.mjs', 'user-trust-definitions.mjs', 'jvm-trust.mjs', 'jvm-trust-definitions.mjs', 'scan-trust.mjs', 'verification-publishers.mjs', 'trust-data.mjs', 'guidance.mjs', 'guidance.d.mts'])
  copyFileSync(new URL(`../src/harness/${name}`, import.meta.url), new URL(`harness/${name}`, dist));
writeFileSync(new URL('distribution.mjs', dist),
  `// Generated from package.json.\nexport const distribution = Object.freeze(${JSON.stringify({ name: manifest.name, version: manifest.version })});\n`);
copyFileSync(new URL('../src/distribution.d.mts', import.meta.url), new URL('distribution.d.mts', dist));

cpSync(new URL('../src/harness/report/', import.meta.url),new URL('harness/report/', dist),{recursive:true});
for (const name of ['report-command.mjs','report-command.d.mts']) copyFileSync(new URL('../src/harness/'+name, import.meta.url),new URL('harness/'+name,dist));
