// Development-only, explicit lock maintenance. Build and verification only check committed bytes.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { linuxObserverSources } from '../src/harness/native/linux-sandbox.mjs';

if (process.argv.length !== 3 || !['--write', '--check'].includes(process.argv[2])) throw Error('Use --write or --check');
const root = new URL('../src/harness/native/', import.meta.url);
const file = fileURLToPath(new URL('linux/observer-lock.json', root));
const files = linuxObserverSources.map(name => {
  const path = fileURLToPath(new URL(name, root)), stat = lstatSync(path), bytes = readFileSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || bytes.length > 8 * 1024 * 1024 ||
      (/\.(?:mjs|json|cs)$/.test(name) && bytes.includes(13))) throw Error('Expected bounded resources and canonical LF source');
  return { name, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
});
const bytes = JSON.stringify({ version: 1, files }, null, 2) + '\n';
if (process.argv[2] === '--write') writeFileSync(file, bytes);
else if (readFileSync(file, 'utf8') !== bytes) throw Error('Linux observer closure differs');
process.stdout.write(JSON.stringify({ files: files.length, sha256: createHash('sha256').update(bytes).digest('hex') }) + '\n');
