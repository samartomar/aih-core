// Developer-only lock maintenance; never invoked by build, install, or native verification.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../src/harness/native/canonical.mjs';

if (!['--check', '--write'].includes(process.argv[2]) || process.argv.length !== 3) throw Error('Expected --check or --write');
const root = fileURLToPath(new URL('../', import.meta.url));
const file = join(root, 'src/harness/native/linux/runtime-lock.json');
const names = ['@anthropic-ai/sandbox-runtime', '@pondwader/socks5-server', 'commander', 'node-forge', 'zod'];
const npmLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const packages = names.map(name => {
  const directory = join(root, 'node_modules', name), files = [];
  const visit = path => {
    for (const entry of readdirSync(path).sort()) {
      const child = join(path, entry), stat = lstatSync(child);
      if (stat.isSymbolicLink()) throw Error('Dependency links are not lockable');
      if (stat.isDirectory()) { if (entry === 'node_modules') throw Error('Unexpected nested dependency'); visit(child); }
      else {
        if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw Error('Dependency file bounds');
        const bytes = readFileSync(child);
        files.push({ path: relative(directory, child).split(sep).join('/'), byteLength: bytes.length, sha256: sha(bytes) });
      }
    }
  };
  visit(directory);
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const record = npmLock.packages[`node_modules/${name}`];
  if (record.version !== manifest.version || manifest.name !== name || typeof record.integrity !== 'string') throw Error('Lock identity mismatch');
  return { name, version: manifest.version, integrity: record.integrity, files };
});
const record = { format: 1, vendor: { name: names[0], version: '0.0.78',
  releaseCommit: '6f0ce155ccb136bda33a8a72201fe7f54fe47d9b',
  archiveIntegrity: 'sha512-YAIcybXTp7MZkBjasnkR1E3yxnf7u6kUkyW0vZrtsAZ9tyJGMaugWETmquPZs0YvW0sR0VnZeMfS0gsN/wQiVQ==' },
  packages, treeSha256: sha(canonicalJson(packages)) };
const bytes = JSON.stringify(record, null, 2) + '\n';
if (process.argv[2] === '--write') writeFileSync(file, bytes);
else if (readFileSync(file, 'utf8') !== bytes) throw Error('Pinned Linux vendor closure differs');
console.log(JSON.stringify({ packages: packages.length, files: packages.reduce((sum, value) => sum + value.files.length, 0),
  byteLength: Buffer.byteLength(bytes), treeSha256: record.treeSha256 }));
