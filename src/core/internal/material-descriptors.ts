export const MATERIAL_LIMITS = Object.freeze({
  compressedBytes: 64 * 1024 * 1024,
  expandedBytes: 256 * 1024 * 1024,
  regularMembers: 4096,
  memberBytes: 16 * 1024 * 1024,
  recipeBytes: 1_000_000,
  capturedBytes: 512 * 1024 * 1024,
  acquisitionMs: 60_000,
  pathBytes: 4096,
  pathSegments: 64,
});

export interface MaterialMemberDescriptor { id: string; path: string; sha256: string; byteLength: number }
export type ArchiveSourceDescriptor = { kind: 'archive'; url: string; sha256: string; byteLength: number };
export type MaterialSourceDescriptor = ArchiveSourceDescriptor | { kind: 'local'; input: string };
/**
 * One exact GitHub commit in Catalog's exact git source identity form, acquired only through the pinned archive of that
 * commit. Core resolves nothing: a branch, tag, short or symbolic name, or an unproven commit is refused.
 */
export interface GitSourceDescriptor {
  kind: 'git'; repository: string; commit: string; reachable: true;
  archive: { url: string; sha256: string; byteLength: number };
}
/** The exact provenance a git source carries into review and custody. */
export interface GitProvenance { kind: 'git'; repository: string; commit: string; identity: string }
export interface InlineMaterialDescriptor extends MaterialMemberDescriptor {
  source: MaterialSourceDescriptor;
}
export interface MaterialRecipeReference {
  source: MaterialSourceDescriptor | GitSourceDescriptor;
  path: string;
  sha256: string;
  byteLength: number;
  materials: MaterialMemberDescriptor[];
}
export class MaterialCaptureError extends Error {
  constructor(readonly reason: string) {
    super(`Material capture failed: ${reason}`);
    this.name = 'MaterialCaptureError';
  }
}
function fail(reason: string): never { throw new MaterialCaptureError(reason); }
const hex = /^[a-f0-9]{64}$/u;
const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
export function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
    Reflect.ownKeys(value).every(key => typeof key === 'string' &&
      Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
      'value' in (Object.getOwnPropertyDescriptor(value, key) ?? {}));
}
export function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function byteLength(value: unknown, limit: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= limit;
}
function digest(value: unknown): value is string { return typeof value === 'string' && hex.test(value); }
export function memberPath(value: unknown): string {
  if (typeof value !== 'string' || !value || new TextEncoder().encode(value).length > MATERIAL_LIMITS.pathBytes ||
      value.startsWith('/') || value.startsWith('\\')) fail('unsafe-member-path');
  const segments = value.split('/');
  if (segments.length > MATERIAL_LIMITS.pathSegments || segments.some(segment => !segment || segment === '.' ||
      segment === '..' || segment.includes('\\') || segment.includes(':') || /[. ]$/u.test(segment) ||
      /[\u0000-\u001f\u007f]/u.test(segment) || /\p{C}/u.test(segment) ||
      segment.normalize('NFC') !== segment || reserved.test(segment))) fail('unsafe-member-path');
  return value;
}
export function memberDescriptor(value: unknown): MaterialMemberDescriptor {
  if (!exact(value, ['id', 'path', 'sha256', 'byteLength']) ||
      typeof value.id !== 'string' || !value.id || value.id.length > 256 ||
      !digest(value.sha256) || !byteLength(value.byteLength, MATERIAL_LIMITS.memberBytes)) fail('invalid-member-descriptor');
  return { id: value.id, path: memberPath(value.path), sha256: value.sha256, byteLength: value.byteLength };
}
export type CheckedReference = Omit<MaterialRecipeReference, 'materials'> & { materials: MaterialMemberDescriptor[] };
const githubRepository = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/u;
/** The owner and repository of one canonical https://github.com/<owner>/<repo> URL; the single admission rule. */
export function githubName(repository: unknown): { owner: string; repo: string } | undefined {
  const match = typeof repository === 'string' ? githubRepository.exec(repository) : null;
  if (!match || match[2] === '.' || match[2] === '..' || match[2]!.toLowerCase().endsWith('.git')) return undefined;
  return { owner: match[1]!, repo: match[2]! };
}
/**
 * The named refusal for a git source, or undefined when it is one exact, reachable GitHub commit whose archive URL is
 * that commit's own archive. Only exact identity is accepted; Catalog owns resolving any moving reference.
 */
export function gitSourceProblem(source: unknown): string | undefined {
  if (!exact(source, ['kind', 'repository', 'commit', 'reachable', 'archive']) || source.kind !== 'git') return 'invalid-git-source';
  if (typeof source.commit !== 'string' || !/^[a-f0-9]{40}$/u.test(source.commit)) return 'git-commit-not-exact';
  if (source.reachable !== true) return 'git-commit-not-reachable';
  const name = githubName(source.repository);
  if (!name) return 'git-repository-unsupported';
  const archive = source.archive;
  if (!exact(archive, ['url', 'sha256', 'byteLength']) || !digest(archive.sha256) ||
      !byteLength(archive.byteLength, MATERIAL_LIMITS.compressedBytes) || archive.byteLength < 1) return 'invalid-archive-source';
  if (archive.url !== `https://codeload.github.com/${name.owner}/${name.repo}/tar.gz/${source.commit}`) return 'git-archive-not-exact';
  return undefined;
}
/** `owner/repo@<commit>` with the repository URL and commit, for a source `gitSourceProblem` accepted. */
export function gitProvenance(source: GitSourceDescriptor): GitProvenance {
  const name = githubName(source.repository)!;
  return { kind: 'git', repository: source.repository, commit: source.commit, identity: `${name.owner}/${name.repo}@${source.commit}` };
}
export function checkedSource(source: unknown, admitGit = false): MaterialRecipeReference['source'] {
  if (admitGit && plain(source) && source.kind === 'git') {
    const problem = gitSourceProblem(source);
    if (problem) fail(problem);
    return source as unknown as GitSourceDescriptor;
  }
  if (!plain(source) || (source.kind !== 'local' && source.kind !== 'archive')) fail('invalid-source');
  if (source.kind === 'local') {
    if (!exact(source, ['kind', 'input']) || typeof source.input !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(source.input)) fail('invalid-local-source');
  } else {
    if (!exact(source, ['kind', 'url', 'sha256', 'byteLength']) || typeof source.url !== 'string' ||
        !digest(source.sha256) || !byteLength(source.byteLength, MATERIAL_LIMITS.compressedBytes)) fail('invalid-archive-source');
    let url: URL;
    try { url = new URL(source.url); } catch { fail('invalid-archive-url'); }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash ||
        (url.port && url.port !== '443')) fail('invalid-archive-url');
  }
  return source as MaterialRecipeReference['source'];
}
export function checkedReference(value: unknown): CheckedReference {
  if (!exact(value, ['source', 'path', 'sha256', 'byteLength', 'materials']) ||
      !digest(value.sha256) || !byteLength(value.byteLength, MATERIAL_LIMITS.recipeBytes) ||
      !Array.isArray(value.materials) || value.materials.length > MATERIAL_LIMITS.regularMembers) fail('invalid-reference');
  const path = memberPath(value.path);
  const source = checkedSource(value.source, true);
  const materials = value.materials.map(memberDescriptor);
  const ids = new Set<string>();
  const paths = new Map<string, string>();
  let total = value.byteLength;
  for (const material of materials) {
    if (ids.has(material.id)) fail('duplicate-material-id');
    ids.add(material.id);
    const samePath = paths.get(material.path);
    const identity = `${material.sha256}:${material.byteLength}`;
    if (samePath !== undefined && samePath !== identity) fail('inconsistent-material-path');
    paths.set(material.path, identity);
    if (samePath === undefined && material.path !== path) total += material.byteLength;
  }
  if (materials.some((item, index) => index > 0 && materials[index - 1]!.id >= item.id)) fail('unsorted-materials');
  const recipePathIdentity = paths.get(path);
  if (recipePathIdentity !== undefined && recipePathIdentity !== `${value.sha256}:${value.byteLength}`)
    fail('inconsistent-material-path');
  if (total > MATERIAL_LIMITS.capturedBytes) fail('captured-byte-limit');
  return { source, path, sha256: value.sha256,
    byteLength: value.byteLength, materials };
}
export type CheckedInline = InlineMaterialDescriptor[];
export function checkedInlineMaterials(value: unknown): { materials: CheckedInline; bytes: number } {
  if (!Array.isArray(value) || value.length > MATERIAL_LIMITS.regularMembers) fail('invalid-inline-materials');
  const materials: CheckedInline = value.map(item => {
    if (!exact(item, ['id', 'path', 'sha256', 'byteLength', 'source'])) fail('invalid-inline-material');
    const member = memberDescriptor({ id: item.id, path: item.path, sha256: item.sha256,
      byteLength: item.byteLength });
    return { ...member, source: checkedSource(item.source) as MaterialSourceDescriptor };
  });
  const ids = new Set<string>();
  const paths = new Map<string, string>();
  const archives = new Map<string, string>();
  let bytes = 0;
  for (const [index, item] of materials.entries()) {
    if (ids.has(item.id)) fail('duplicate-material-id');
    if (index > 0 && materials[index - 1]!.id >= item.id) fail('unsorted-materials');
    ids.add(item.id);
    const sourceKey = item.source.kind === 'archive' ? `archive:${item.source.url}` : `local:${item.source.input}`;
    const key = `${sourceKey}\0${item.path}`;
    const identity = `${item.sha256}:${item.byteLength}`;
    const previous = paths.get(key);
    if (previous !== undefined && previous !== identity) fail('inconsistent-material-path');
    paths.set(key, identity);
    if (previous === undefined) bytes += item.byteLength;
    if (item.source.kind === 'archive') {
      const archiveIdentity = `${item.source.sha256}:${item.source.byteLength}`;
      const prior = archives.get(item.source.url);
      if (prior !== undefined && prior !== archiveIdentity) fail('inconsistent-archive-source');
      archives.set(item.source.url, archiveIdentity);
    }
  }
  if (bytes > MATERIAL_LIMITS.capturedBytes) fail('captured-byte-limit');
  return { materials, bytes };
}
