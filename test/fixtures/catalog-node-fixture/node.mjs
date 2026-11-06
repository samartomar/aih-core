// Core-side test FIXTURE for `@aihq/catalog/node` `readLocalSource(path)`, in the result shape the accepted Catalog
// interface defines: `{ status, source: { kind: 'local', path }, files: [{ path, mode, sha256, bytes }] }`. It walks
// regular files only. It is not Catalog and establishes no producer compatibility.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function readLocalSource(path) {
  const files = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) {
        const bytes = readFileSync(full);
        files.push({ path: rel, mode: lstatSync(full).mode & 0o111 ? '100755' : '100644',
          sha256: createHash('sha256').update(bytes).digest('hex'), bytes: new Uint8Array(bytes) });
      }
    }
  };
  try { walk(path, ''); } catch { return { status: 'refused', code: 'source-unreadable', reason: 'The folder could not be read.' }; }
  return { status: 'ok', source: { kind: 'local', path }, files };
}
