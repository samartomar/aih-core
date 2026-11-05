// A real source build (decision C78) with this host's own Python, through the built public entries in a disposable home
// and project. The tool, its closure, the sdist and its pinned build backend are tiny Core-side FIXTURE packages made
// here (acquire-fixture.mjs `pureWheel`, `tarGz`); they are no published project and prove no real AI setup or
// qualification. The backend exists only as the supplied pinned wheel, so the build can only have used it; pip runs
// offline (`--no-index`, no build isolation) with the caller's pip index variables set to an unreachable index.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, list, prepare } from '../dist/core/index.js';
import { validateFormat } from '../dist/core/contracts.js';
import { indexBases } from '../dist/core/plan/acquire/sources.js';
import { artifactServer, documentSha, hostCell, pureWheel, QUALIFICATION, setupRequest, suppliedFolder, tarGz } from './fixtures/acquire-fixture.mjs';
import { sha256 } from './fixtures/plan-fixture.mjs';

/** This host's Python 3.9+ with venv and pip, or a reason to skip. */
function hostPython() {
  for (const name of process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']) {
    try {
      const version = execFileSync(name, ['-c', 'import sys, venv, ensurepip; print("%d.%d.%d" % sys.version_info[:3])'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 }).trim();
      if (/^3\.(9|[1-9][0-9])\./.test(version)) return { version };
    } catch { /* next */ }
  }
  return undefined;
}
const python = hostPython();
const scratch = mkdtempSync(join(tmpdir(), 'aih-acquire-real-'));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PIP_INDEX_URL: process.env.PIP_INDEX_URL, PIP_FIND_LINKS: process.env.PIP_FIND_LINKS };
const defaults = { ...indexBases };
let home; let server;
before(async () => {
  home = join(scratch, 'home'); mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home;
  process.env.PIP_INDEX_URL = 'https://127.0.0.1:1/simple'; process.env.PIP_FIND_LINKS = 'https://127.0.0.1:1/links';
  server = await artifactServer();
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), server.caPem]);
  indexBases.pypi = `${server.base}/pypi-index`; indexBases.pypiFiles = server.base; indexBases.pythonBuildStandalone = `${server.base}/pbs`;
});
after(async () => {
  Object.assign(indexBases, defaults);
  await server?.close();
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
});

// The pinned build backend: builds `tinytool` 0.1.0 into a real wheel. It ships only inside the supplied wheel.
const BACKEND = `import base64, hashlib, os, zipfile
def _digest(data):
    return 'sha256=' + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b'=').decode()
def build_wheel(wheel_directory, config_settings=None, metadata_directory=None):
    dist = 'tinytool-0.1.0.dist-info'
    files = {'tinytool.py': open('tinytool.py', 'rb').read(),
             dist + '/METADATA': b'Metadata-Version: 2.1\\nName: tinytool\\nVersion: 0.1.0\\n',
             dist + '/WHEEL': b'Wheel-Version: 1.0\\nGenerator: tinyback\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n'}
    record = ''.join('%s,%s,%d\\n' % (path, _digest(data), len(data)) for path, data in files.items()) + dist + '/RECORD,,\\n'
    files[dist + '/RECORD'] = record.encode()
    name = 'tinytool-0.1.0-py3-none-any.whl'
    with zipfile.ZipFile(os.path.join(wheel_directory, name), 'w') as archive:
        for path in sorted(files):
            archive.writestr(zipfile.ZipInfo(path, (2020, 1, 1, 0, 0, 0)), files[path])
    return name
`;

test('a closure wheel is built for real from its pinned sdist with a supplied pinned backend, offline, and recorded as built', { skip: python ? false : 'no host Python 3.9+ with venv and pip' }, async () => {
  const backend = pureWheel('tinyback', '1.0', { 'tinyback/__init__.py': BACKEND });
  const tool = pureWheel('realtool', '1.0.0', { 'realtool.py': 'VERSION = "1.0.0"\n' });
  const sdist = { file: 'tinytool-0.1.0.tar.gz', bytes: tarGz([{ path: 'tinytool-0.1.0' },
    { path: 'tinytool-0.1.0/pyproject.toml', bytes: Buffer.from('[build-system]\nrequires = ["tinyback==1.0"]\nbuild-backend = "tinyback"\n') },
    { path: 'tinytool-0.1.0/PKG-INFO', bytes: Buffer.from('Metadata-Version: 2.1\nName: tinytool\nVersion: 0.1.0\n') },
    { path: 'tinytool-0.1.0/tinytool.py', bytes: Buffer.from('BUILT = True\n') }]) };
  // The qualified wheel is a platform build no index or folder has: Core must build it.
  const qualifiedWheel = { file: 'tinytool-0.1.0-cp399-cp399-fixture_platform.whl', bytes: Buffer.from('qualified elsewhere\n') };
  const fallback = { version: '3.14.5', file: 'cpython-3.14.5+20261026-fixture-install_only.tar.gz', bytes: Buffer.from('never used\n') };
  const cell = hostCell(); const id = 'fixture.ai-setup.realtool';
  const build = { dependencies: [{ file: backend.file, name: 'tinyback', sha256: sha256(backend.bytes), version: '1.0' }],
    interpreter: { bytes: fallback.bytes.length, file: fallback.file, sha256: sha256(fallback.bytes), version: fallback.version }, isolated: true,
    source: { bytes: sdist.bytes.length, file: sdist.file, sha256: sha256(sdist.bytes), url: server.url(`/sources/${sdist.file}`) }, tools: [] };
  const closure = [{ build, file: qualifiedWheel.file, name: 'tinytool', sha256: sha256(qualifiedWheel.bytes), version: '0.1.0' }];
  const interpreter = { bytes: fallback.bytes.length, file: fallback.file, sha256: sha256(fallback.bytes), version: fallback.version };
  const qualification = { schema: QUALIFICATION, subject: { aiSetup: id, version: '1.0.0', cell },
    observed: { artifact: { bytes: tool.bytes.length, file: tool.file, sha256: sha256(tool.bytes) }, closure, interpreter },
    result: { status: 'qualified', run: sha256('fixture run'), date: '2026-11-05' } };
  const step = { op: 'acquire', aiSetup: id, version: '1.0.0', cell, root: 'user', into: `.aihq/ai-setup/realtool/1.0.0/${cell}/`,
    distribution: { kind: 'pypi-wheel', file: tool.file, sha256: sha256(tool.bytes), bytes: tool.bytes.length }, executable: 'realtool',
    qualification: documentSha(qualification), closure: structuredClone(closure), interpreter: { prefer: 'installed', range: '>=3.9', fallback: structuredClone(interpreter) },
    scanned: false };
  const item = { id, kind: 'ai-setup', name: 'realtool', files: [], aiSetup: { version: '1.0.0', runtime: { python: '>=3.9' } } };
  server.serve(`/sources/${sdist.file}`, sdist.bytes);
  const supplied = suppliedFolder(join(scratch, 'supplied'), {});
  mkdirSync(supplied, { recursive: true });
  suppliedFolder(supplied, { [tool.file]: tool.bytes, [backend.file]: backend.bytes });

  const target = join(scratch, 'project'); mkdirSync(target);
  const request = setupRequest(target, [{ step, qualification, item }]);
  const before = JSON.stringify(request.plan);
  const prepared = await prepare(request, { artifacts: supplied });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.equal(validateFormat(prepared.review).status, 'ok');
  assert.equal(prepared.review.steps[0].interpreter.installed.version, python.version);
  const run = await apply(prepared.handle, { approved: true, origin: 'automation', reviewDigest: prepared.review.reviewDigest });
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.equal(run.steps[0].interpreter.branch, 'installed');
  assert.equal(JSON.stringify(request.plan), before, 'the plan is never changed');

  const folder = join(home, '.aihq', 'ai-setup', 'realtool', '1.0.0', cell);
  const envPython = process.platform === 'win32' ? join(folder, 'env', 'Scripts', 'python.exe') : join(folder, 'env', 'bin', 'python');
  const installed = JSON.parse(execFileSync(envPython, ['-c',
    'import json, importlib.metadata as m, tinytool; print(json.dumps({"tool": m.version("realtool"), "built": m.version("tinytool"), "flag": tinytool.BUILT, "backend": [d.metadata["Name"] for d in m.distributions() if d.metadata["Name"] == "tinyback"]}))'],
  { encoding: 'utf8', windowsHide: true }).trim());
  assert.deepEqual(installed, { tool: '1.0.0', built: '0.1.0', flag: true, backend: [] }, 'the backend stays in the build environment');
  assert.equal(existsSync(join(folder, 'build')), false, 'the build environment is removed');

  const entry = (await list({ target: { project: target }, scope: 'user' })).entries.find(row => row.managementId === id);
  assert.equal(validateFormat(await list({ target: { project: target }, scope: 'user' })).status, 'ok');
  const built = entry.aiSetup.downloads.find(record => record.role === 'closure');
  assert.deepEqual([built.origin, built.built.file, built.built.byteQualified, built.built.source, built.built.dependencies],
    ['built', 'tinytool-0.1.0-py3-none-any.whl', false, sha256(sdist.bytes), [sha256(backend.bytes)]]);
  assert.match(built.built.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(entry.aiSetup.downloads.filter(record => record.origin === 'supplied').map(record => record.file).sort(), [backend.file, tool.file].sort());
  assert.deepEqual(entry.aiSetup.downloads.find(record => record.role === 'build-source'), { role: 'build-source', file: sdist.file, sha256: sha256(sdist.bytes),
    origin: 'downloaded', url: server.url(`/sources/${sdist.file}`) });
  assert.ok(!readFileSync(join(folder, '.aih-acquired'), 'utf8').includes('tinytool'), 'the marker names only the qualified artifact');
});
