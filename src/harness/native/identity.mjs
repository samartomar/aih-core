// Dedicated test-identity binding for the Claude OAuth adapter. The credential is captured once into
// memory, never logged or hashed into results, and staged read-only from the provisioner-owned source.
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { hasExactKeys, isRecord, isSafeRelativePath, parseStrictJson } from './canonical.mjs';
import { nativeBounds, validateNativeTestIdentity } from './contracts.mjs';
import { isOwnerOnly } from './cell.mjs';
import { sha256 } from './digest.mjs';

const unavailable = reason => ({ status: 'unavailable', reason });
const MISSING = unavailable('authentication-unavailable');
const INVALID = unavailable('identity-binding-invalid');

// Claude's file login channel (documentation-derived, unverified on a native run).
export function validateClaudeOAuthFile(bytes) {
  try {
    const value = parseStrictJson(Buffer.from(bytes).toString('utf8'));
    const oauth = isRecord(value) && Object.keys(value).length === 1 ? value.claudeAiOauth : undefined;
    const ok = isRecord(oauth) && ['accessToken', 'refreshToken'].every(key => typeof oauth[key] === 'string' && oauth[key].length >= 1 && oauth[key].length <= 4096) &&
      Number.isFinite(oauth.expiresAt) && Object.keys(oauth).every(key => ['accessToken', 'refreshToken', 'expiresAt', 'scopes', 'subscriptionType'].includes(key));
    return { valid: ok };
  } catch { return { valid: false }; }
}

function readFileOnce(path, maxBytes) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > maxBytes) return null;
  if (isOwnerOnly(path) !== true) return null;
  const fd = openSync(path, 'r');
  try {
    const opened = fstatSync(fd);
    if (opened.size !== stat.size) return null;
    const bytes = Buffer.alloc(opened.size);
    readSync(fd, bytes, 0, opened.size, 0);
    return { bytes, identity: { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, dev: stat.dev } };
  } finally { closeSync(fd); }
}

const sameIdentity = (a, b) => a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.dev === b.dev;

export async function captureTestIdentity({ provisionedRoot, manifestSha256, expected }) {
  if (typeof provisionedRoot !== 'string' || provisionedRoot.length > 4096 || provisionedRoot.includes('\0') || !isAbsolute(provisionedRoot))
    return MISSING;
  let names;
  try {
    const root = lstatSync(provisionedRoot);
    if (!root.isDirectory() || root.isSymbolicLink()) return MISSING;
    names = readdirSync(provisionedRoot).sort();
  } catch { return MISSING; }
  if (!names.includes('identity.json') || !names.includes('oauth.json')) return MISSING;
  if (names.length !== 2) return INVALID;
  const ownerState = isOwnerOnly(provisionedRoot);
  if (ownerState === null) return MISSING;
  if (ownerState === false) return INVALID;
  let manifestFile, credentialFile;
  try {
    manifestFile = readFileOnce(join(provisionedRoot, 'identity.json'), nativeBounds.identityManifestBytes);
    if (!manifestFile) return INVALID;
    if (sha256(manifestFile.bytes) !== manifestSha256) return INVALID;
    let manifest;
    try { manifest = parseStrictJson(manifestFile.bytes.toString('utf8')); } catch { return INVALID; }
    if (!validateNativeTestIdentity(manifest).valid) return INVALID;
    if (!hasExactKeys(expected, ['accountUuid', 'organizationId']) || manifest.expected.accountUuid !== expected.accountUuid ||
        manifest.expected.organizationId !== expected.organizationId) return INVALID;
    credentialFile = readFileOnce(join(provisionedRoot, 'oauth.json'), nativeBounds.credentialBytes);
    if (!credentialFile) return INVALID;
    if (credentialFile.bytes.length !== manifest.credential.byteLength || sha256(credentialFile.bytes) !== manifest.credential.sha256) return INVALID;
    if (!validateClaudeOAuthFile(credentialFile.bytes).valid) return INVALID;
    const manifestHash = manifestFile.identity, credentialHash = credentialFile.identity;
    const credentialSha = manifest.credential.sha256;
    return {
      status: 'captured', manifestId: manifest.id, credential: credentialFile.bytes,
      // Re-read both source files immediately before staging; any change invalidates the binding.
      async recheck() {
        try {
          const again = readFileOnce(join(provisionedRoot, 'identity.json'), nativeBounds.identityManifestBytes);
          const credential = readFileOnce(join(provisionedRoot, 'oauth.json'), nativeBounds.credentialBytes);
          return Boolean(again && credential && sameIdentity(again.identity, manifestHash) && sameIdentity(credential.identity, credentialHash) &&
            sha256(again.bytes) === manifestSha256 && sha256(credential.bytes) === credentialSha);
        } catch { return false; }
      }
    };
  } catch { return INVALID; }
}

// Write the dedicated snapshot to the definition's cell-local destination. Staged once, never again.
// Only the exact selected destination is accepted, and the staged file must read back as the captured
// bytes: the client then owns it as disposable state and nothing is ever copied back to the source.
export const CREDENTIAL_DESTINATION = Object.freeze({ root: 'home', path: '.claude/.credentials.json' });

export function stageCredential(cell, definition, captured) {
  const destination = definition.credentialDestination;
  if (destination.root !== CREDENTIAL_DESTINATION.root || destination.path !== CREDENTIAL_DESTINATION.path ||
      !isSafeRelativePath(destination.path) || !Buffer.isBuffer(captured?.credential)) return unavailable('authentication-channel-unsupported');
  try {
    const target = join(cell.home, ...destination.path.split('/'));
    mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(target, captured.credential, { flag: 'wx', mode: 0o600 });
    const staged = readFileOnce(target, nativeBounds.credentialBytes);
    if (!staged || !staged.bytes.equals(captured.credential)) return unavailable('staging-unavailable');
    return { status: 'staged' };
  } catch { return unavailable('staging-unavailable'); }
}
