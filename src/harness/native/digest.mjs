// Node-side digest helpers and bundled fixture resolution. Bytes come from embedded data, never from
// files on disk, so line-ending conversion in a checkout cannot change a pinned digest.
import { createHash } from 'node:crypto';
import { canonicalJson, treeEntries } from './canonical.mjs';
import { bundledNativeFixtures } from './contracts.mjs';
import { fixtureFiles, fixturePins } from './fixture-data.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const treeDigest = files => sha256(canonicalJson(treeEntries(files)));

// Persistence digest: output tree plus guardrails, compared after staging and each session.
export const configurationDigest = ({ outputTreeSha256, guardrailsSha256 }) =>
  sha256(canonicalJson({ outputTreeSha256, guardrailsSha256 }));

export const definitionIdentity = definition => ({ id: definition.id, sha256: sha256(canonicalJson(definition)) });

const KEYS = { 'CLAUDE.md': 'instruction', '.mcp.json': 'mcpConfig', '.aihq-native/server.mjs': 'server', '.claude/settings.json': 'guardrails' };

// Resolve the bundled mechanism fixture for a client. Only Claude has bytes; every other
// roster member stays client-unsupported rather than inheriting Claude's proof.
export function resolveBundledFixture(client) {
  const fixture = bundledNativeFixtures.find(entry => entry.client === client);
  if (!fixture) return { outcome: 'unsupported', reason: 'client-unsupported' };
  const toFile = tree => {
    const key = KEYS[tree.path];
    return { root: tree.root, path: tree.path, key, sha256: tree.member.sha256, byteLength: tree.member.byteLength,
      bytes: Buffer.from(fixtureFiles[key].text, 'utf8') };
  };
  return {
    outcome: 'selected', id: fixture.id, client, proofScope: 'bundled-mechanism', archiveSha256: null,
    manifestSha256: fixture.manifestSha256, outputTreeSha256: fixture.outputTreeSha256,
    guardrailsSha256: fixture.guardrailsSha256, adapterId: fixture.adapterId,
    instructions: fixture.instructions, server: fixture.server,
    files: [...fixture.outputTree, ...fixture.guardrails].map(toFile),
    outputPaths: fixture.outputTree.map(file => ({ root: file.root, path: file.path })),
    guardrailPaths: fixture.guardrails.map(file => ({ root: file.root, path: file.path }))
  };
}

// Recompute every digest from the actual bytes about to be staged.
export function verifyFixtureMaterials(resolved) {
  const mismatch = { ok: false, reason: 'fixture-bytes-mismatch' };
  const pins = new Map(Object.entries(fixturePins).map(([key, pin]) => [fixtureFiles[key].path, pin]));
  if (resolved.files.length !== pins.size) return mismatch;
  for (const file of resolved.files) {
    const pin = pins.get(file.path);
    if (!pin || file.bytes.length !== pin.byteLength || sha256(file.bytes) !== pin.sha256 ||
        file.sha256 !== pin.sha256) return mismatch;
  }
  const entries = files => files.map(file => ({ root: file.root, path: file.path, member: { sha256: sha256(file.bytes), byteLength: file.bytes.length } }));
  const guardrailPaths = new Set(resolved.guardrailPaths.map(p => `${p.root}/${p.path}`));
  const output = entries(resolved.files.filter(f => !guardrailPaths.has(`${f.root}/${f.path}`)));
  const guardrails = entries(resolved.files.filter(f => guardrailPaths.has(`${f.root}/${f.path}`)));
  if (treeDigest(output) !== resolved.outputTreeSha256 || treeDigest(guardrails) !== resolved.guardrailsSha256) return mismatch;
  return { ok: true };
}
