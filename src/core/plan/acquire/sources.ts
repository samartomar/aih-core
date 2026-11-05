// Where an acquired file's bytes come from (decision C78). Prepare fixes one source per download and the review shows
// it; Apply tries only that source and checks the bytes against the qualified sha256 (and length when recorded). A
// mismatch fails closed (`artifact-mismatch`) and never falls through to another source; nothing obtainable is
// `artifact-unavailable`. The plan and qualification are never changed: a resolved URL is recorded only as where the
// bytes came from.
//   1. a caller-supplied folder (`controls.artifacts`) holding the exact file by name: read only, Core copies it;
//   2. the https `url` the step records;
//   3. resolution by exact identity: PyPI's JSON API for wheels and sdists (`/pypi/<name>/<version>/json`, the `urls[]`
//      entry whose `filename` and `digests.sha256` are the planned ones), and python-build-standalone's release download
//      for an interpreter (release tag = the `+YYYYMMDD` part of its file name).
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { readRegularFile } from '../../internal/fsxn.js';
import { limitValue } from '../limits.js';
import { AcquireError, checkBytes, downloadBytes, fetchJson } from './download.js';
import type { AcquireSpec, Download, DownloadRole, Source } from './types.js';

/**
 * The index bases resolution uses. Internal: not part of any public entry or option; Core's own tests point them at a
 * local fixture server.
 */
export const indexBases = {
  pypi: 'https://pypi.org',
  pythonBuildStandalone: 'https://github.com/astral-sh/python-build-standalone/releases/download'
};
const PBS = /^cpython-[0-9][0-9.]*\+([0-9]{8})-[A-Za-z0-9._+-]+\.tar\.(gz|zst)$/;
const SDIST = /^(.+)-([^-]+)\.(tar\.gz|zip)$/;

/** The PyPI identity a file names: a wheel's first two segments, an sdist's name and version, or the caller's. */
function pypiIdentity(file: string, given: { name?: string; version?: string }): { name: string; version: string } | undefined {
  if (given.name && given.version) return { name: given.name, version: given.version };
  if (file.endsWith('.whl')) { const [name, version] = file.split('-'); return name && version ? { name, version: given.version ?? version } : undefined; }
  const sdist = SDIST.exec(file);
  return sdist ? { name: given.name ?? sdist[1]!, version: given.version ?? sdist[2]! } : undefined;
}
const supplied = (folder: string, file: string): boolean => {
  try { return lstatSync(join(folder, file)).isFile(); } catch { return false; }
};

/** The one source Apply will try for this download. `python` says whether a PyPI identity applies to this role. */
export function sourceOf(item: Download, role: DownloadRole, identity: { name?: string; version?: string }, artifacts: string | null, python: boolean): Source {
  if (artifacts && supplied(artifacts, item.file)) return { kind: 'supplied', folder: artifacts };
  if (item.url) return { kind: 'url', url: item.url };
  if (role === 'interpreter') {
    const release = PBS.exec(item.file)?.[1];
    return release ? { kind: 'index', index: 'python-build-standalone', release } : { kind: 'none' };
  }
  if (!python) return { kind: 'none' };
  const found = pypiIdentity(item.file, identity);
  return found ? { kind: 'index', index: 'pypi', ...found } : { kind: 'none' };
}
const pypiRelease = (source: Extract<Source, { index: 'pypi' }>): string =>
  `${indexBases.pypi}/pypi/${encodeURIComponent(source.name)}/${encodeURIComponent(source.version)}/json`;
const pbsDownload = (source: Extract<Source, { index: 'python-build-standalone' }>, file: string): string =>
  `${indexBases.pythonBuildStandalone}/${encodeURIComponent(source.release)}/${encodeURIComponent(file)}`;

/** Where Prepare's trust probe (C36) looks for this source, or `null` when it reads nothing remote. */
export function probeUrl(item: { file: string }, source: Source): string | null {
  if (source.kind === 'url') return source.url;
  if (source.kind !== 'index') return null;
  return source.index === 'pypi' ? pypiRelease(source) : pbsDownload(source, item.file);
}

export interface Obtained { bytes: Buffer; origin: 'supplied' | 'downloaded'; url?: string }
/** Apply: the bytes from the reviewed source, checked, or an `AcquireError`. */
export async function obtain(item: Download, source: Source, options: { signal?: AbortSignal; deadlineMs: number; onBytes?: (bytes: number) => void }): Promise<Obtained> {
  switch (source.kind) {
    case 'supplied': {
      let bytes: Buffer | undefined;
      try { bytes = readRegularFile(join(source.folder, item.file), { maxBytes: limitValue('artifact-bytes') }); } catch { bytes = undefined; }
      if (!bytes) throw new AcquireError('artifact-unavailable');
      return { bytes: checkBytes(item, bytes), origin: 'supplied' };
    }
    case 'url': return { bytes: await downloadBytes({ ...item, url: source.url }, options), origin: 'downloaded', url: source.url };
    case 'none': throw new AcquireError('artifact-unavailable');
    case 'index': {
      let url: string;
      if (source.index === 'python-build-standalone') url = pbsDownload(source, item.file);
      else {
        const answer = await fetchJson(pypiRelease(source), options) as { urls?: unknown } | null;
        const listed = Array.isArray(answer?.urls) ? (answer.urls as { filename?: unknown; url?: unknown; digests?: { sha256?: unknown } }[])
          .filter(candidate => candidate && candidate.filename === item.file) : [];
        const entry = listed.find(candidate => candidate.digests?.sha256 === item.sha256 && typeof candidate.url === 'string' && candidate.url.startsWith('https://'));
        // The index lists this file with other bytes: that is a mismatch, never a missing file (so never a reason to build).
        if (!entry && listed.some(candidate => typeof candidate.digests?.sha256 === 'string' && candidate.digests.sha256 !== item.sha256))
          throw new AcquireError('artifact-mismatch');
        if (!entry) throw new AcquireError('artifact-unavailable');
        url = new URL(entry.url as string).href;
      }
      return { bytes: await downloadBytes({ ...item, url }, options), origin: 'downloaded', url };
    }
  }
}

/** Each download's reviewed source, by role, file and sha256. */
export type Sources = Map<string, Source>;
export const sourceKey = (role: DownloadRole, item: { file: string; sha256: string }): string => `${role}\0${item.file}\0${item.sha256}`;
/** Every download a step may need, in review order, with the source Apply will try for it. */
export function planSources(spec: AcquireSpec, artifacts: string | null): { sources: Sources; review: ReviewDownload[] } {
  const python = spec.kind === 'pypi-wheel';
  const sources: Sources = new Map();
  const fix = (role: DownloadRole, item: Download, identity: { name?: string; version?: string } = {}): Source => {
    const key = sourceKey(role, item);
    if (!sources.has(key)) sources.set(key, sourceOf(item, role, identity, artifacts, python));
    return sources.get(key)!;
  };
  const shown = (role: DownloadRole, item: Download, identity: { name?: string; version?: string } = {}) =>
    ({ role, file: item.file, sha256: item.sha256, source: fix(role, item, identity) });
  const review: ReviewDownload[] = [shown('artifact', spec.artifact, python ? { version: spec.version } : {})];
  for (const wheel of spec.closure) review.push({ ...shown('closure', wheel, wheel), ...(wheel.build ? { build: {
    source: shown('build-source', wheel.build.source),
    dependencies: wheel.build.dependencies.map(dependency => ({ name: dependency.name, version: dependency.version, ...shown('build-dependency', dependency, dependency) })),
    tools: wheel.build.tools.map(tool => ({ ...tool })) } } : {}) });
  if (spec.interpreter) review.push(shown('interpreter', spec.interpreter.fallback));
  return { sources, review };
}
type Shown = { role: DownloadRole; file: string; sha256: string; source: Source };
/** One download as the review shows it (C78); a wheel with a recorded build shows the possible build too. */
export interface ReviewDownload extends Shown {
  build?: { source: Shown; dependencies: (Shown & { name: string; version: string })[]; tools: { name: string; version: string; sha256: string }[] };
}
