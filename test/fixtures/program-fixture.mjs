// Core-side producer and host FIXTURES for program steps (`tool-command`, `upstream-installer`, `upstream-setup`;
// contract 8.1, 12). Step shapes follow Catalog's planner (`ToolCommandStep`, `UpstreamInstallerStep`, `SetupStep`); the
// `tool-command` keys, `restore: { argv }` with `<prior>` included, are those of Catalog 32db997's real cbm plan
// (test/plan-program.test.mjs compares them with test/fixtures/catalog-767cd4e). The programs are `fake-tool.cjs` fakes; the upstream repository is a local git repository reached through a disposable home's
// `url.<local>.insteadOf` rule. Nothing here proves a real tool, installer, setup or repository.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, linkSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { documentSha, FAKE_PYTHON, hostCell, QUALIFICATION, tarGz } from './acquire-fixture.mjs';
import { CONTENT, PLAN_REQUEST, inputProfile, profile, sha256 } from './plan-fixture.mjs';

export const FAKE_TOOL = fileURLToPath(new URL('./fake-tool.cjs', import.meta.url));
const windows = process.platform === 'win32';
const exe = name => windows ? `${name}.exe` : name;

/** The bytes of one fake program: a Node copy on Windows (behaviour from the preload), a shell script elsewhere. */
export function fakeProgramBytes(name) {
  return windows ? readFileSync(process.execPath) :
    Buffer.from(`#!/bin/sh\nFAKE_TOOL_NAME=${name} exec "${process.execPath}" "${FAKE_TOOL}" "$@"\n`);
}
/** Fake programs on PATH in `bin` (`fake-setup`, `fake-installer`). */
export function installFakePrograms(bin, names = ['fake-setup', 'fake-installer']) {
  mkdirSync(bin, { recursive: true });
  for (const name of names) {
    const target = join(bin, exe(name));
    if (existsSync(target)) continue;
    if (windows) { try { linkSync(process.execPath, target); } catch { copyFileSync(process.execPath, target); } }
    else { writeFileSync(target, fakeProgramBytes(name)); chmodSync(target, 0o755); }
  }
}
/** The environment that runs the fakes: `bin` first on PATH, git and Node findable, the preloads, and the state folder. */
export function programEnvironment(bin, state, mode = '') {
  mkdirSync(state, { recursive: true });
  const git = gitFolder();
  const keep = windows ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')] : ['/usr/bin', '/bin'];
  const preload = [FAKE_PYTHON, FAKE_TOOL].map(file => `--require "${file.replaceAll('\\', '/')}"`).join(' ');
  return { PATH: [bin, dirname(process.execPath), ...(git ? [git] : []), ...keep].join(delimiter), FAKE_TOOL_STATE: state, FAKE_TOOL_MODE: mode,
    NODE_OPTIONS: preload };
}
let gitDir;
/** The folder of the git found on the test's own PATH. */
export function gitFolder() {
  if (gitDir !== undefined) return gitDir;
  try {
    const lines = execFileSync(windows ? 'where' : 'which', ['git'], { encoding: 'utf8' }).split(/\r?\n/).map(line => line.trim())
      .filter(line => line && (!windows || /\.exe$/i.test(line)));
    // Git for Windows' `cmd` launcher sets up its own runtime; its inner `mingw64` binary needs Git's whole PATH.
    const found = lines.find(line => /[\\/]cmd[\\/]git\.exe$/i.test(line)) ?? lines[0];
    gitDir = found ? dirname(found) : null;
  } catch { gitDir = null; }
  return gitDir;
}
/** Settings the fake tool already holds before a test installs anything (its `config get` prints them). */
export function seedToolSettings(state, settings) {
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'fake-tool.json'), JSON.stringify({ calls: [], settings }, null, 2));
}
/** What one fake recorded. */
export function fakeState(state, name) {
  const file = join(state, `${name}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { calls: [], settings: {} };
}

/**
 * A native-archive AI setup whose qualified executable member is the fake tool (`bin/fake-tool`), with its MCP item and
 * a `tool-command` per settings command (`config set <key> <value>`, read back with `config get <key>`). `restore`
 * adds Catalog's `restore: { argv: ['config', 'set', <key>, '<prior>'] }`. `token` binds the item's secret `TOOL_TOKEN`
 * to the command's environment.
 */
export function toolSetup(server, { name = 'code-graph', version = '1.4.0', settings = [['auto_index', 'false']], restore = true, token = false,
    archive, shim = false } = {}) {
  const id = `fixture.ai-setup.${name}`;
  const cell = hostCell();
  // `shim` (Windows only): the executable member is a `.cmd` command shim that runs the fake with this Node.
  const program = shim ? 'bin/fake-tool.cmd' : `bin/${exe('fake-tool')}`;
  const bytes = shim ? Buffer.from(`@echo off\r\nset FAKE_TOOL_NAME=fake-tool\r\nset NODE_OPTIONS=\r\n"${process.execPath}" "${FAKE_TOOL}" %*\r\n`) :
    fakeProgramBytes('fake-tool');
  const tar = archive ?? tarGz([{ path: 'bin' }, { path: program, bytes, mode: 0o755 }, { path: 'LICENSE', bytes: Buffer.from('MIT\n') }], 1);
  const file = `${name}-${cell}.tar.gz`;
  server.serve(`/${file}`, tar);
  const members = [{ path: program, sha256: sha256(bytes), executable: true }, { path: 'LICENSE', sha256: sha256(Buffer.from('MIT\n')), executable: false }];
  const qualification = { schema: QUALIFICATION, subject: { aiSetup: id, version, cell },
    observed: { artifact: { file, sha256: sha256(tar), bytes: tar.length }, members, closure: null, interpreter: null },
    result: { status: 'qualified', run: `sha256:${sha256('fixture run')}`, date: '2026-11-03' } };
  const qualificationSha = `sha256:${documentSha(qualification)}`;
  const into = `.aihq/ai-setup/${name}/${version}/${cell}/`;
  const acquire = { op: 'acquire', aiSetup: id, version, cell, root: 'user', into,
    distribution: { kind: 'native-archive', file, url: server.url(`/${file}`), sha256: sha256(tar), bytes: tar.length },
    executable: `${into}${program}`, qualification: qualificationSha, scanned: false };
  const commands = settings.map(([key, value]) => ({ argv: ['config', 'set', key, value], readback: { argv: ['config', 'get', key], expected: value },
    ...(restore ? { restore: { argv: ['config', 'set', key, '<prior>'] } } : {}) }));
  const toolCommands = commands.map(command => ({ op: 'tool-command', aiSetup: id, qualification: qualificationSha,
    executable: { root: 'user', path: `${into}${program}` }, argv: command.argv, readback: command.readback,
    ...(command.restore ? { restore: command.restore } : {}), approval: 'required',
    ...(token ? { inputs: [{ item: id, input: 'TOOL_TOKEN', at: { env: 'TOOL_TOKEN' } }] } : {}) }));
  const mcpItem = `fixture.mcp.${name}`;
  const item = { id, kind: 'ai-setup', name, files: [], aiSetup: { version, mcpItem, settings: { commands, files: [] } },
    ...(token ? { requirements: { inputs: { TOOL_TOKEN: { isRequired: true, isSecret: true } } } } : {}) };
  const mcp = { id: mcpItem, kind: 'mcp', name: `${name}-mcp`, description: 'Fixture MCP item', files: [] };
  const merge = { op: 'merge', item: mcpItem, root: 'project', file: '.mcp.json', format: 'json', key: `/mcpServers/${name}`,
    entry: { command: join(process.env.HOME ?? '', ...`${into}${program}`.split('/')), args: ['serve'] }, clis: ['claude-code'] };
  return { id, mcpItem, acquire, toolCommands, item, mcp, merge, qualification, folder: into.slice(0, -1), program: `${into}${program}` };
}

/** A plan request in Catalog phase order: acquires, writes, merges, upstream setups and installers, then tool commands. */
export function programRequest(project, { setups = [], skills = [], installers = [], upstream = [], scope = 'project', inputs } = {}) {
  const sourceId = 'local-my-skills';
  const files = []; const items = [...setups.flatMap(setup => [setup.item, setup.mcp])];
  const writes = skills.map(skill => {
    const bytes = Buffer.from(skill.text); const sourcePath = `${skill.name}/SKILL.md`;
    files.push({ sourceId, sourcePath, sha256: sha256(bytes), bytes });
    const id = `local-my-skills.skill.${skill.name}`;
    items.push({ id, kind: 'skill', name: skill.name, description: skill.name, ...(skill.dependencies ? { dependencies: skill.dependencies } : {}),
      files: [{ sourceId, sourcePath, sha256: sha256(bytes), bytes: bytes.length, executable: false, role: 'content' }] });
    return { op: 'write', item: id, root: 'project', path: `.claude/skills/${skill.name}/SKILL.md`, from: { item: id, sourcePath }, clis: ['claude-code'] };
  });
  for (const installer of installers) items.push(installer.item);
  const plan = [...setups.map(setup => setup.acquire), ...writes, ...setups.map(setup => setup.merge),
    ...upstream.map(setup => setup.step), ...installers.map(installer => installer.step), ...setups.flatMap(setup => setup.toolCommands)];
  const contents = [{ schema: CONTENT, framework: { id: 'local-my-skills', name: 'Fixture' }, sources: [{ id: sourceId, kind: 'local', notices: [] }], items },
    ...upstream.map(setup => setup.content)];
  return { schema: PLAN_REQUEST, scope, target: { project },
    plan: { status: 'ok', data: null, plan, missing: [], unavailable: [], clashes: [], duplicates: [], references: [], warnings: [] },
    contents, profiles: [inputProfile('claude-code')], files, qualifications: setups.map(setup => setup.qualification), ...(inputs ? { inputs } : {}) };
}

/** An upstream installer the person chose instead of a managed setup (`managed: false`). */
export function installerStep(name = 'other-tool') {
  const id = `fixture.ai-setup.${name}`;
  return { id, item: { id, kind: 'ai-setup', name, files: [], aiSetup: { version: '1.0.0', settings: { commands: [], files: [] } } },
    step: { op: 'upstream-installer', aiSetup: id, argv: ['fake-installer', 'install', name, '--yes'], managed: false, scanned: false, approval: 'required' } };
}

/**
 * A local git repository standing in for an upstream setup's repository, and the home's git rule that sends
 * `repository` there. Returns the commit and an `upstream-setup` step (framework `gstack`) for Claude.
 */
export function upstreamRepository(scratch, home, { repository = 'https://example.test/upstream/gstack', files = { 'README.md': 'upstream setup fixture\n' },
    command = ['fake-setup', 'setup', '--host', 'claude'], into = '.claude/skills/gstack', root = 'user' } = {}) {
  const dir = join(scratch, `upstream-${sha256(repository + home).slice(0, 8)}`);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
    git('init', '--quiet');
    for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); }
    git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'fixture');
  }
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  writeFileSync(join(home, '.gitconfig'), `[url "${pathToFileURL(dir).href}"]\n\tinsteadOf = ${repository}\n[safe]\n\tdirectory = *\n`);
  const framework = 'gstack';
  return { dir, commit, framework,
    content: { schema: CONTENT, framework: { id: framework, name: 'gstack' }, sources: [{ id: framework, kind: 'git', repository, commit, notices: [] }], items: [] },
    step: { op: 'upstream-setup', cli: 'claude-code', framework, root, repository, commit, into, command, needs: ['bun>=1.4.2'], scanned: false, approval: 'required' } };
}
