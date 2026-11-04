// Core-side producer and host FIXTURES for `acquire` steps (contract 8.1). No compatible @aihq/catalog artifact or real
// qualification exists yet: these builders hand-make AI setup content, qualification documents
// (urn:aihq:catalog:qualification:0.1.0) and `planInstall`-shaped acquire steps in the accepted Catalog shapes, serve the
// artifacts from a local HTTPS server, and stand in for Python with `fake-python.cjs`. They establish Core behaviour only:
// they prove no real tool, interpreter, wheel closure or qualification.
import https from 'node:https';
import { copyFileSync, linkSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createRegistryCertificates } from './tls-registry.mjs';
import { CONTENT, PLAN_REQUEST, sha256 } from './plan-fixture.mjs';

export const QUALIFICATION = 'urn:aihq:catalog:qualification:0.1.0';
export const FAKE_PYTHON = fileURLToPath(new URL('./fake-python.cjs', import.meta.url));
export const hostCell = () => `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
/** Canonical JSON: sorted keys, no whitespace (Catalog 5.6 hashing). */
export const canonicalize = value => Array.isArray(value) ? `[${value.map(canonicalize).join(',')}]` :
  value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}` : JSON.stringify(value);
/** A qualification's sha256: over its canonical JSON (Catalog 5.7). */
export const documentSha = document => sha256(canonicalize(document));

/** A ustar `.tar.gz` of `[{ path, bytes, mode }]` (`bytes` absent for a folder). */
export function tarGz(entries, level = 6) {
  const blocks = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    const directory = entry.bytes === undefined;
    const name = directory && !entry.path.endsWith('/') ? `${entry.path}/` : entry.path;
    header.write(name, 0, 100);
    header.write(((entry.mode ?? (directory ? 0o755 : 0o644)) & 0o7777).toString(8).padStart(7, '0') + '\0', 100);
    header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write((directory ? 0 : entry.bytes.length).toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136); header.write('        ', 148);
    header.write(directory ? '5' : '0', 156); header.write('ustar\0', 257); header.write('00', 263);
    let sum = 0; for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header);
    if (!directory) { blocks.push(entry.bytes); const pad = (512 - entry.bytes.length % 512) % 512; if (pad) blocks.push(Buffer.alloc(pad)); }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level });
}

/** A local HTTPS server for `{ '/path': bytes }`; `serve(path, bytes)` changes what it returns. Its CA is `caPem`. */
export async function artifactServer(files = {}) {
  const certificates = await createRegistryCertificates(['localhost']);
  const routes = new Map(Object.entries(files));
  const requests = [];
  const server = https.createServer({ cert: certificates.leafPem, key: certificates.keyPem }, (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const bytes = routes.get(request.url);
    if (!bytes) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-length': bytes.length, 'content-type': 'application/octet-stream' });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `https://localhost:${server.address().port}`;
  return { base, caPem: certificates.caPem, requests, url: path => `${base}${path}`, serve: (path, bytes) => routes.set(path, bytes),
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}

/** One copy of this Node executable that fake interpreters hard-link to (never the running Node itself). */
export function fakeInterpreterBase(dir) {
  mkdirSync(dir, { recursive: true });
  const base = join(dir, process.platform === 'win32' ? 'node-copy.exe' : 'node-copy');
  copyFileSync(process.execPath, base);
  return base;
}
/** A fake installed interpreter on PATH in `bin`: `python(.exe)` (and `python3` on POSIX) reporting `version`. */
export function fakePython(base, bin, facts) {
  mkdirSync(bin, { recursive: true });
  const names = process.platform === 'win32' ? ['python.exe'] : ['python3'];
  for (const name of names) {
    const target = join(bin, name);
    try { linkSync(base, target); } catch { copyFileSync(base, target); }
    writeFileSync(`${target}.fake.json`, JSON.stringify(facts));
  }
  return join(bin, names[0]);
}
/** The environment that makes Core find only fixture interpreters and run them as fakes. */
export function fakeEnvironment(bin) {
  const keep = process.platform === 'win32' ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')] : ['/usr/bin', '/bin'];
  return { PATH: [bin, dirname(process.execPath), ...keep].join(delimiter), NODE_OPTIONS: `--require "${FAKE_PYTHON.replaceAll('\\', '/')}"` };
}
/** A python-build-standalone-shaped `install_only` archive whose interpreter is a fake reporting `version`. */
export function fallbackArchive(base, facts) {
  const python = process.platform === 'win32' ? 'python/python.exe' : 'python/bin/python3';
  return tarGz([{ path: 'python' }, ...(process.platform === 'win32' ? [] : [{ path: 'python/bin' }]),
    { path: python, bytes: readFileSync(base), mode: 0o755 },
    { path: `${python}.fake.json`, bytes: Buffer.from(JSON.stringify(facts)), mode: 0o644 }], 1);
}
/** A wheel file's bytes (the fake interpreter never opens it). */
export const wheelBytes = (name, version) => Buffer.from(`fixture wheel ${name} ${version}\n`);

/**
 * A Python AI setup in the Catalog shapes: its content item (with `mcpItem` when given), its qualification and the
 * acquire step. `server` serves the wheel, the closure and the fallback interpreter archive.
 */
export function pythonSetup(server, { name = 'review-graph', version = '2.3.9', range = '>=3.10', closure = [['networkx', '3.4.2']],
    fallbackVersion = '3.14.5', fallbackBytes, cell = hostCell(), id = `crg.ai-setup.${name}` } = {}) {
  const wheelFile = `${name.replaceAll('-', '_')}-${version}-py3-none-any.whl`;
  const wheel = wheelBytes(name.replaceAll('-', '_'), version);
  server.serve(`/${wheelFile}`, wheel);
  const wheels = closure.map(([dist, at]) => {
    const file = `${dist}-${at}-py3-none-any.whl`; const bytes = wheelBytes(dist, at); server.serve(`/${file}`, bytes);
    return { name: dist, version: at, file, sha256: sha256(bytes), bytes: bytes.length, url: server.url(`/${file}`) };
  });
  const fallbackFile = `cpython-${fallbackVersion}-install_only.tar.gz`;
  server.serve(`/${fallbackFile}`, fallbackBytes);
  const interpreter = { version: fallbackVersion, file: fallbackFile, sha256: sha256(fallbackBytes), bytes: fallbackBytes.length };
  const qualification = { schema: QUALIFICATION, subject: { aiSetup: id, version, cell },
    observed: { artifact: { file: wheelFile, sha256: sha256(wheel), bytes: wheel.length }, members: [],
      closure: wheels.map(({ url: _url, ...entry }) => entry), interpreter },
    result: { status: 'qualified', run: `sha256:${sha256('fixture run')}`, date: '2026-11-03' } };
  const step = { op: 'acquire', aiSetup: id, version, cell,
    distribution: { kind: 'pypi-wheel', file: wheelFile, url: server.url(`/${wheelFile}`), sha256: sha256(wheel), bytes: wheel.length },
    qualification: `sha256:${documentSha(qualification)}`, scanned: false, into: `.aihq/ai-setup/${name}/${version}/${cell}/`,
    closure: wheels, interpreter: { prefer: 'installed', range, fallback: { ...interpreter, url: server.url(`/${fallbackFile}`) } } };
  const item = { id, kind: 'ai-setup', name, files: [], aiSetup: { version, runtime: { python: range, closure: 'uv-lock' } } };
  return { id, step, qualification, item, folder: `.aihq/ai-setup/${name}/${version}/${cell}` };
}

/** A native-archive AI setup: a `.tar.gz` with `members` ({ path: text }), all qualified, the first executable. */
export function nativeSetup(server, { name = 'memory-mcp', version = '0.12.1', members = { 'memory-mcp': '#!/bin/sh\necho memory\n', 'LICENSE': 'MIT\n' },
    cell = hostCell(), id = `cbm.ai-setup.${name}` } = {}) {
  const listed = Object.entries(members).map(([path, text], index) => ({ path, sha256: sha256(Buffer.from(text)), executable: index === 0 }));
  const archive = tarGz([...Object.entries(members).map(([path, text], index) => ({ path, bytes: Buffer.from(text), mode: index === 0 ? 0o755 : 0o644 })),
    { path: 'unlisted.txt', bytes: Buffer.from('not qualified, never extracted\n') }]);
  const file = `${name}-linux-portable.tar.gz`;
  server.serve(`/${file}`, archive);
  const qualification = { schema: QUALIFICATION, subject: { aiSetup: id, version, cell },
    observed: { artifact: { file, sha256: sha256(archive), bytes: archive.length }, members: listed, closure: null, interpreter: null },
    result: { status: 'qualified', run: `sha256:${sha256('fixture run')}`, date: '2026-11-03' } };
  const step = { op: 'acquire', aiSetup: id, version, cell,
    distribution: { kind: 'native-archive', file, url: server.url(`/${file}`), sha256: sha256(archive), bytes: archive.length },
    qualification: `sha256:${documentSha(qualification)}`, scanned: false, into: `.aihq/ai-setup/${name}/${version}/${cell}/` };
  const item = { id, kind: 'ai-setup', name, files: [], aiSetup: { version } };
  return { id, step, qualification, item, archive, folder: `.aihq/ai-setup/${name}/${version}/${cell}`, members };
}

/**
 * A plan request with AI setups first (Catalog phase 1) and, optionally, own-content skills written into the project:
 * `skills` is `[{ name, text, dependencies? }]`.
 */
export function setupRequest(project, setups, skills = []) {
  const sourceId = 'local-my-skills';
  const files = []; const items = setups.map(setup => setup.item);
  const writes = skills.map(skill => {
    const bytes = Buffer.from(skill.text); const sourcePath = `${skill.name}/SKILL.md`;
    files.push({ sourceId, sourcePath, sha256: sha256(bytes), bytes });
    const id = `local-my-skills.skill.${skill.name}`;
    items.push({ id, kind: 'skill', name: skill.name, description: skill.name, ...(skill.dependencies ? { dependencies: skill.dependencies } : {}),
      files: [{ sourceId, sourcePath, sha256: sha256(bytes), bytes: bytes.length, executable: false, role: 'content' }] });
    return { op: 'write', item: id, root: 'project', path: `.claude/skills/${skill.name}/SKILL.md`, from: { item: id, sourcePath }, clis: ['claude-code'] };
  });
  return { schema: PLAN_REQUEST, scope: 'project', target: { project },
    plan: { status: 'ok', data: null, plan: [...setups.map(setup => setup.step), ...writes], missing: [], unavailable: [], clashes: [], duplicates: [],
      references: [], warnings: [] },
    contents: [{ schema: CONTENT, framework: { id: 'local-my-skills', name: 'Fixture' }, sources: [{ id: sourceId, kind: 'local', notices: [] }], items }],
    profiles: [{ schema: 'urn:aihq:catalog:tool-profile:0.1.0', id: 'claude-code', version: 1, checkedWith: 'fixture' }],
    files, qualifications: setups.map(setup => setup.qualification) };
}
