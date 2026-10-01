// Q95 GitHub organization-policy reader: reads one exact regular file from the
// fixed github.com API origin through refs/trees/blobs, with bounded requests,
// bytes and time. No logging, no file writes, no redirect following.
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { contractSupport } from './contracts.mjs';

const ORIGIN = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = `aihq-core/${contractSupport.package.version} github-policy-reader`;
const MAX_REQUESTS = 32;
const REQUEST_MS = 15_000;
const AGGREGATE_MS = 60_000;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 1_000_000;
const MAX_TAG_PEELS = 8;

const COMMIT_RE = /^[0-9a-f]{40}$/;
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const REF_REJECT = /[\x00-\x20\x7f~^:?*[\\]/;
const PATH_REJECT = /[\\\x00-\x1f\x7f]/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const helper = Object.freeze({ id: 'github-policy-reader', package: contractSupport.package });

const isPlainObject = value => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const exactKeys = (value, keys) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const deepFreeze = value => {
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
};

function validRefName(ref) {
  return typeof ref === 'string' && ref.length > 0 && !ref.startsWith('-') &&
    !REF_REJECT.test(ref) && !ref.includes('..') && !ref.includes('@{') && !ref.includes('//') &&
    !ref.startsWith('/') && !ref.endsWith('/') && !ref.endsWith('.') &&
    ref.split('/').every(part => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'));
}
function validPolicyPath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.normalize('NFC') !== path) return false;
  if (new TextEncoder().encode(path).length > 4096) return false;
  if (path.startsWith('/') || PATH_REJECT.test(path)) return false;
  const segments = path.split('/');
  return segments.length <= 16 && segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
}

function validateSource(source) {
  if (!isPlainObject(source) || !exactKeys(source, ['provider', 'repository', 'path', 'revision'])) return undefined;
  const { provider, repository, path, revision } = source;
  if (provider !== 'github') return undefined;
  if (!isPlainObject(repository) || !exactKeys(repository, ['owner', 'name'])) return undefined;
  const { owner, name } = repository;
  if (typeof owner !== 'string' || !OWNER_RE.test(owner)) return undefined;
  if (typeof name !== 'string' || !NAME_RE.test(name) || name === '.' || name === '..') return undefined;
  if (!isPlainObject(revision) || !exactKeys(revision, ['kind', 'value'])) return undefined;
  const { kind, value } = revision;
  if (kind === 'commit') {
    if (typeof value !== 'string' || !COMMIT_RE.test(value)) return undefined;
  } else if (kind === 'branch' || kind === 'tag') {
    if (!validRefName(value)) return undefined;
  } else return undefined;
  if (!validPolicyPath(path)) return undefined;
  return Object.freeze({
    provider: 'github',
    repository: Object.freeze({ owner: owner.toLowerCase(), name: name.toLowerCase() }),
    path,
    revision: Object.freeze({ kind, value })
  });
}

function validateControls(controls) {
  if (controls === undefined) return { token: undefined, signal: undefined };
  if (!isPlainObject(controls)) return undefined;
  if (!Object.keys(controls).every(key => key === 'authentication' || key === 'signal')) return undefined;
  const { authentication, signal } = controls;
  if (signal !== undefined && !(signal instanceof AbortSignal)) return undefined;
  if (authentication === undefined) return { token: undefined, signal };
  if (!isPlainObject(authentication)) return undefined;
  if (authentication.kind === 'none' && exactKeys(authentication, ['kind'])) return { token: undefined, signal };
  if (authentication.kind === 'bearer' && exactKeys(authentication, ['kind', 'token'])) {
    const { token } = authentication;
    if (typeof token !== 'string' || token.length === 0 || token.length > 4096 || /[\x00-\x1f\x7f]/.test(token))
      return undefined;
    return { token, signal };
  }
  return undefined;
}

class ReaderFailure {
  constructor(reason, message, retryAfterSeconds) {
    this.reason = reason;
    this.message = message;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
class ReaderCancelled {}

export async function readGitHubPolicyWith(deps, source, controls) {
  const fetchImpl = deps !== null && typeof deps === 'object' ? deps.fetch : undefined;
  const now = typeof deps?.now === 'function' ? deps.now : () => Date.now();
  const monotonic = typeof deps?.monotonic === 'function' ? deps.monotonic : () => performance.now();
  const accounting = { requests: 0, responseBytes: 0 };
  const account = () => ({ ...accounting });
  const normalized = validateSource(source);
  const parsed = validateControls(controls);
  if (normalized === undefined || parsed === undefined)
    return deepFreeze({
      status: 'invalid', code: 'INPUT_INVALID', reason: 'source-invalid',
      message: 'The organization-policy source or reader controls are structurally invalid.',
      helper, accounting: account()
    });
  const { token, signal } = parsed;
  const fail = (reason, message, retryAfterSeconds) => {
    throw new ReaderFailure(reason, message, retryAfterSeconds);
  };
  const started = monotonic();
  const encodeRef = ref => ref.split('/').map(encodeURIComponent).join('/');
  const repositoryPath =
    `/repos/${encodeURIComponent(normalized.repository.owner)}/${encodeURIComponent(normalized.repository.name)}`;

  async function request(path) {
    if (signal !== undefined && signal.aborted) throw new ReaderCancelled();
    if (typeof fetchImpl !== 'function')
      fail('network-failed', 'No fetch implementation is available for the GitHub API request.');
    if (accounting.requests >= MAX_REQUESTS)
      fail('request-count', `The reader stopped before exceeding ${MAX_REQUESTS} GitHub API requests.`);
    const left = AGGREGATE_MS - (monotonic() - started);
    if (left <= 0) fail('deadline', 'The aggregate reader deadline was exhausted.');
    accounting.requests += 1;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), Math.min(REQUEST_MS, left));
    const combined = signal === undefined ? timeout.signal : AbortSignal.any([signal, timeout.signal]);
    const headers = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': API_VERSION,
      'user-agent': USER_AGENT
    };
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    let response;
    try {
      response = await Promise.race([
        Promise.resolve(fetchImpl(`${ORIGIN}${path}`, { method: 'GET', headers, redirect: 'manual', signal: combined })),
        new Promise((resolve, reject) => combined.addEventListener('abort', () => reject(combined.reason), { once: true }))
      ]);
    } catch {
      clearTimeout(timer);
      if (signal !== undefined && signal.aborted) throw new ReaderCancelled();
      if (timeout.signal.aborted) fail('deadline', 'A GitHub API request exceeded its bounded deadline.');
      fail('network-failed', 'The GitHub API request failed before a response was received.');
    }
    if (response === null || typeof response !== 'object' || typeof response.status !== 'number') {
      clearTimeout(timer);
      fail('network-failed', 'The GitHub API request did not produce an HTTP response.');
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      clearTimeout(timer);
      fail('response-invalid', 'The GitHub API attempted a redirect; the reader never follows redirects.');
    }
    if (response.status < 200 || response.status > 299) {
      clearTimeout(timer);
      const retryAfterSeconds = readRetryAfter(response);
      if (response.status === 401)
        fail('authentication-required-or-denied', 'The GitHub API requires authentication or denied the supplied credential.');
      if (response.status === 403) {
        if (response.headers?.get?.('x-ratelimit-remaining') === '0')
          fail('rate-limited', 'The GitHub API rate limit is exhausted.', retryAfterSeconds);
        fail('authentication-required-or-denied', 'The GitHub API denied access to the selected source.');
      }
      if (response.status === 429)
        fail('rate-limited', 'The GitHub API rate-limited the read.', retryAfterSeconds);
      if (response.status === 404)
        fail('source-missing-or-inaccessible', 'The selected source is missing or inaccessible; a private-resource 404 does not prove nonexistence.');
      fail('response-invalid', `The GitHub API responded with unexpected status ${response.status}.`);
    }
    let body;
    try {
      body = await readBody(response);
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof ReaderFailure || error instanceof ReaderCancelled) throw error;
      if (signal !== undefined && signal.aborted) throw new ReaderCancelled();
      if (timeout.signal.aborted) fail('deadline', 'A GitHub API response exceeded its bounded deadline.');
      fail('network-failed', 'The GitHub API response stream failed.');
    }
    clearTimeout(timer);
    return body;
  }

  async function readBody(response) {
    if (response.body === null || response.body === undefined || typeof response.body.getReader !== 'function')
      fail('response-invalid', 'The GitHub API response did not carry a readable body.');
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        if (signal !== undefined && signal.aborted) throw new ReaderCancelled();
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        accounting.responseBytes += next.value.byteLength;
        if (bytes > MAX_METADATA_BYTES)
          fail('response-bytes', 'A GitHub API metadata response exceeded its byte bound.');
        if (accounting.responseBytes > MAX_TOTAL_BYTES)
          fail('response-bytes', 'The GitHub API responses exceeded the aggregate byte bound.');
        chunks.push(next.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  }

  function readRetryAfter(response) {
    const get = name => response.headers?.get?.(name);
    const retryAfter = get('retry-after');
    if (typeof retryAfter === 'string' && /^\d{1,5}$/.test(retryAfter.trim())) {
      const value = Number(retryAfter);
      if (value <= 86_400) return value;
    }
    const reset = get('x-ratelimit-reset');
    if (typeof reset === 'string' && /^\d{1,12}$/.test(reset.trim())) {
      const delta = Number(reset) - Math.floor(now() / 1000);
      if (delta >= 0 && delta <= 86_400) return Math.ceil(delta);
    }
    return undefined;
  }

  function parseJson(body, what) {
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      fail('response-invalid', `${what} was not valid UTF-8.`);
    }
    try {
      return JSON.parse(text);
    } catch {
      fail('response-invalid', `${what} was not valid JSON.`);
    }
  }
  const shaOf = value => (typeof value === 'string' && COMMIT_RE.test(value) ? value : undefined);
  const invalidShape = what => fail('response-invalid', `${what} had an unexpected shape.`);

  async function resolveCommit() {
    const { kind, value } = normalized.revision;
    if (kind === 'commit') return value;
    const ref = parseJson(
      await request(`${repositoryPath}/git/ref/${kind === 'branch' ? 'heads' : 'tags'}/${encodeRef(value)}`),
      'The GitHub ref response');
    if (!isPlainObject(ref) || !isPlainObject(ref.object)) invalidShape('The GitHub ref response');
    let objectSha = shaOf(ref.object.sha);
    if (objectSha === undefined || typeof ref.object.type !== 'string') invalidShape('The GitHub ref response');
    if (ref.object.type === 'commit') return objectSha;
    if (kind !== 'tag' || ref.object.type !== 'tag')
      fail('response-invalid', 'The GitHub ref did not resolve to a commit object.');
    const seen = new Set([objectSha]);
    for (let peel = 0; ; peel += 1) {
      if (peel >= MAX_TAG_PEELS)
        fail('response-invalid', 'Annotated tag peeling exceeded its bound without reaching a commit.');
      const tag = parseJson(await request(`${repositoryPath}/git/tags/${objectSha}`), 'The GitHub tag response');
      if (!isPlainObject(tag) || shaOf(tag.sha) !== objectSha || !isPlainObject(tag.object)) invalidShape('The GitHub tag response');
      const nextSha = shaOf(tag.object.sha);
      if (nextSha === undefined || typeof tag.object.type !== 'string') invalidShape('The GitHub tag response');
      if (tag.object.type === 'commit') return nextSha;
      if (tag.object.type !== 'tag' || seen.has(nextSha))
        fail('response-invalid', 'Annotated tag peeling did not reach a commit object.');
      seen.add(nextSha);
      objectSha = nextSha;
    }
  }

  function findEntry(entries, name) {
    let found;
    for (const entry of entries) {
      if (!isPlainObject(entry) || typeof entry.path !== 'string' ||
          typeof entry.mode !== 'string' || typeof entry.type !== 'string')
        invalidShape('A GitHub tree entry');
      if (entry.path !== name) continue;
      if (found !== undefined)
        fail('response-invalid', 'A GitHub tree contained duplicate names for the selected path segment.');
      found = entry;
    }
    return found;
  }

  async function readBlob(commitSha) {
    const commit = parseJson(await request(`${repositoryPath}/git/commits/${commitSha}`), 'The GitHub commit response');
    if (!isPlainObject(commit) || shaOf(commit.sha) !== commitSha ||
        !isPlainObject(commit.tree) || shaOf(commit.tree.sha) === undefined)
      invalidShape('The GitHub commit response');
    const segments = normalized.path.split('/');
    let treeSha = commit.tree.sha;
    for (const [index, segment] of segments.entries()) {
      const tree = parseJson(await request(`${repositoryPath}/git/trees/${treeSha}`), 'The GitHub tree response');
      if (!isPlainObject(tree) || tree.sha !== treeSha || tree.truncated !== false || !Array.isArray(tree.tree))
        invalidShape('The GitHub tree response');
      const entry = findEntry(tree.tree, segment);
      if (entry === undefined)
        fail('source-missing-or-inaccessible', 'The selected path is not present in the resolved commit view.');
      if (index < segments.length - 1) {
        const nextTree = shaOf(entry.sha);
        if (entry.type !== 'tree' || entry.mode !== '040000' || nextTree === undefined)
          fail('source-not-regular-file', 'A selected path segment does not resolve to a directory.');
        treeSha = nextTree;
        continue;
      }
      const blobSha = shaOf(entry.sha);
      if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755') || blobSha === undefined)
        fail('source-not-regular-file', 'The selected path does not resolve to a regular file.');
      if (entry.size !== undefined) {
        if (!Number.isSafeInteger(entry.size) || entry.size < 0) invalidShape('A GitHub blob entry');
        if (entry.size > MAX_FILE_BYTES)
          fail('response-bytes', 'The selected file exceeds the 1,000,000-byte bound.');
      }
      const blob = parseJson(await request(`${repositoryPath}/git/blobs/${blobSha}`), 'The GitHub blob response');
      if (!isPlainObject(blob) || shaOf(blob.sha) !== blobSha || blob.encoding !== 'base64' ||
          typeof blob.content !== 'string')
        invalidShape('The GitHub blob response');
      const base64 = blob.content.replace(/\n/g, '');
      if (!BASE64_RE.test(base64))
        fail('response-invalid', 'The GitHub blob content was not strict base64.');
      const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
      if (Buffer.from(bytes).toString('base64') !== base64)
        fail('response-invalid', 'The GitHub blob content was not canonical base64.');
      if (bytes.length > MAX_FILE_BYTES)
        fail('response-bytes', 'The selected file exceeds the 1,000,000-byte bound.');
      if (entry.size !== undefined && bytes.length !== entry.size)
        fail('response-invalid', 'The GitHub blob bytes did not match the declared tree size.');
      if (blob.size !== undefined && blob.size !== bytes.length)
        fail('response-invalid', 'The GitHub blob bytes did not match the declared blob size.');
      const identity = createHash('sha1')
        .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), Buffer.from(bytes)]))
        .digest('hex');
      if (identity !== blobSha)
        fail('response-invalid', 'The GitHub blob bytes did not match the claimed blob identity.');
      return { blobSha, bytes };
    }
  }

  try {
    const commitSha = await resolveCommit();
    const { blobSha, bytes } = await readBlob(commitSha);
    return deepFreeze({
      status: 'read', source: normalized, resolvedCommit: commitSha, blobId: blobSha,
      bytes, contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      retrievedAt: new Date(now()).toISOString(), helper, accounting: account()
    });
  } catch (error) {
    if (error instanceof ReaderCancelled)
      return deepFreeze({
        status: 'cancelled', code: 'CANCELLED', reason: 'cancelled',
        message: 'The read was cancelled by the caller.',
        source: normalized, helper, accounting: account()
      });
    if (error instanceof ReaderFailure) {
      const result = {
        status: 'unavailable', code: 'AUTHORITY_UNAVAILABLE', reason: error.reason,
        message: error.message, source: normalized, helper, accounting: account()
      };
      if (error.retryAfterSeconds !== undefined) result.retryAfterSeconds = error.retryAfterSeconds;
      return deepFreeze(result);
    }
    return deepFreeze({
      status: 'unavailable', code: 'AUTHORITY_UNAVAILABLE', reason: 'response-invalid',
      message: 'The reader encountered an unexpected internal failure.',
      source: normalized, helper, accounting: account()
    });
  }
}

export function readGitHubPolicy(source, controls) {
  return readGitHubPolicyWith({ fetch: globalThis.fetch }, source, controls);
}
