// The bounded archive reader for acquired artifacts (contract 8.1): links stay inside the archive, also when one link
// leads through another. The archives are Core-side FIXTURES built here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { readArchive } from '../dist/core/plan/acquire/archive.js';

/** A ustar `.tar.gz` of `[name, type, link?, bytes?]` rows (`5` folder, `2` symlink, `0` file). */
function tar(rows) {
  const parts = [];
  for (const [name, type, link = '', bytes = Buffer.alloc(0)] of rows) {
    const header = Buffer.alloc(512);
    header.write(name, 0); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136);
    header.write('        ', 148); header.write(type, 156); header.write(link, 157); header.write('ustar\0', 257); header.write('00', 263);
    let sum = 0; for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    parts.push(header);
    if (bytes.length) parts.push(bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}
const refused = archive => assert.throws(() => readArchive(archive, 'x.tar.gz'), error => error.reason === 'archive-invalid');

test('a link that leads through another link out of the archive is refused', () => {
  refused(tar([['d/', '5'], ['d/l', '2', '..'], ['d/l/m', '2', '..'], ['d/l/m/ESCAPED.txt', '0', '', Buffer.from('x\n')]]));
  // A link to a link that leaves through its own `..`.
  refused(tar([['a', '2', 'b/c'], ['b/', '5'], ['b/c', '2', '..']]));
});

test('a member inside a linked folder is refused; a contained link alone is kept', () => {
  refused(tar([['lib/', '5'], ['alias', '2', 'lib'], ['alias/file.txt', '0', '', Buffer.from('x\n')]]));
  const entries = readArchive(tar([['lib/', '5'], ['lib/real.txt', '0', '', Buffer.from('x\n')], ['bin/', '5'], ['bin/link', '2', '../lib/real.txt']]), 'x.tar.gz');
  assert.deepEqual(entries.filter(entry => entry.type === 'symlink').map(entry => [entry.path, entry.target]), [['bin/link', '../lib/real.txt']]);
});
