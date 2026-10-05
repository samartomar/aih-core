import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, release, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const allTargets = ['python', 'pip', 'git', 'cargo', 'conda'];
const shared = process.env.AIHQ_TRUST_CONTRACT === 'shared';

async function exerciseConsumer() {
  const { prepare, apply } = await import('@aihq/core');
  const { repairIndex, contractSupport } = await import('@aihq/core/harness');
  const { Ajv2020 } = await import('ajv/dist/2020.js');
  const ajv = new Ajv2020({ strict: true });
  for (const name of ['prepared-work', 'run-result']) for (const version of ['1.0.0', '1.2.0'])
    ajv.addSchema((await import(`@aihq/core/schemas/${name}/${version}.json`, { with: { type: 'json' } })).default);
  const targets = process.argv[4].split(',');
  const definition = repairIndex.find(item => item.id === 'user-tools-ca');
  const variant = definition.variants.find(item => item.os === process.platform && item.network === 'declared' &&
    item.targets.length === targets.length && targets.every(id => item.targets.includes(id)));
  assert.ok(variant);
  const files = variant.configFiles.map(item => ({ id: item.operationId,
    path: join(homedir(), ...item.target.segments.map(segment => segment.literal)) }));
  if (targets.includes('python')) files.push({ id: 'python-config', path: join(homedir(), ...(process.platform === 'win32' ?
    ['Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'] : [process.platform === 'darwin' ? '.zprofile' : '.profile'])) });
  const sentinels = { 'pip-config': '[global]\ntimeout=15\n', 'git-config': '[user]\n\tname = Native Acceptance\n',
    'cargo-config': '[net]\nretry = 0\n', 'conda-config': 'channels:\n  - defaults\n', 'python-config': '# Retained user profile\n' };
  for (const file of files) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, sentinels[file.id]);
  }
  const before = new Map(files.map(file => [file.path, readFileSync(file.path)]));
  const request = shared ? { schema: 'urn:aihq:core:repair-request:1.0.0', useCase: 'repair', route: 'file',
    repairs: [{ id: 'user-tools-ca', targets, inputs: {} }],
    sources: { os: false, supplied: [{ id: 'fixture', file: process.argv[3] }] } } :
    { useCase: 'repair', repairs: [{ id: 'user-tools-ca', targets, inputs: { caFile: process.argv[3] } }] };
  const preview = await prepare(request, { logging: 'off' });
  assert.ok(preview.review, JSON.stringify(preview.diagnostics));
  assert.equal(ajv.validate(preview.review.schema, preview.review), true, JSON.stringify(ajv.errors));
  for (const file of files) assert.deepEqual(readFileSync(file.path), before.get(file.path), 'Prepare has no configuration effects');
  const resolutions = preview.review.operations.filter(operation => operation.effects === 'conflict').map(operation => {
    const file = files.find(item => `trust/${item.id}` === operation.id);
    assert.ok(file, `Unexpected conflict ${operation.id}`);
    return { selectionId: 'trust', operationId: file.id, choice: 'replace', observedSha256: sha256(before.get(file.path)) };
  });
  const prepared = await prepare({ ...request, ...(resolutions.length ? { resolutions } : {}) }, { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.deepEqual(shared ? prepared.review.inputs.trust.package : prepared.review.inputs.package, contractSupport.package);
  const result = await apply(prepared.prepared, { approved: true, origin: 'automation',
    reviewDigest: prepared.review.reviewDigest }, { logging: 'off' });
  assert.equal(ajv.validate(result.schema, result), true, JSON.stringify(ajv.errors));
  const privilege = process.platform === 'win32' ? {
    elevated: execFileSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-Command', '([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 1024, windowsHide: true }).trim() === 'True'
  } : { uid: process.getuid(), effectiveUid: process.geteuid(), elevated: process.geteuid() === 0 };
  const osVersion = process.platform === 'darwin' ? execFileSync('/usr/bin/sw_vers', ['-productVersion'],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 }).trim() : undefined;
  writeFileSync('native-result.json', JSON.stringify({ platform: process.platform, architecture: process.arch,
    osRelease: release(), ...(osVersion ? { osVersion } : {}), privilege, node: process.version, package: contractSupport.package,
    targets, contract: shared ? 'shared' : 'legacy', review: prepared.review, result }, null, 2));
  if (result.completion !== 'complete') {
    // These supplied vendor checks are read-only; bounded fixture diagnostics
    // remain separate from the product's redacted run history.
    const failures = result.checks.filter(item => item.status === 'failed' &&
      ['trust/cargo-behavior', 'trust/conda-behavior'].includes(item.id));
    const diagnostics = failures.map(item => {
      const check = prepared.review.operations.flatMap(operation => operation.checks).find(check => check.id === item.id);
      const details = check.details;
      const command = spawnSync(details.executable, details.args.map(value => JSON.parse(value)), {
        cwd: details.cwd, env: { ...process.env, ...Object.fromEntries(Object.entries(details.env).map(([key, value]) => [key, JSON.parse(value)])) },
        shell: false, windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 8192
      });
      // The product wrapper suppresses vendor output. In this isolated fixture,
      // retain a bounded direct Cargo probe with the same inherited trust so a
      // native failure can be distinguished from an external query failure.
      const cargo = item.id === 'trust/cargo-behavior' ? spawnSync(JSON.parse(details.args.at(-1)),
        ['search', 'serde', '--limit', '1'], { cwd: details.cwd, env: { ...process.env },
          shell: false, windowsHide: true, encoding: 'utf8', timeout: 18000, maxBuffer: 8192 }) : undefined;
      return { checkId: item.id, status: command.status, error: command.error?.code,
        stderr: (command.stderr ?? '').slice(0, 8192), ...(cargo ? { cargo: {
          status: cargo.status, error: cargo.error?.code, stderr: (cargo.stderr ?? '').slice(0, 8192) } } : {}) };
    });
    writeFileSync('native-diagnostics.json', JSON.stringify(diagnostics, null, 2));
  }
  assert.equal(result.completion, 'complete', JSON.stringify(result));
  for (const id of targets) assert.equal(result.operations.find(operation => operation.id === `trust/${id}-config`).verification.status, 'passed');
  for (const file of files) {
    const text = readFileSync(file.path, 'utf8');
    const retained = file.id === 'pip-config' ? 'timeout=15' : file.id === 'git-config' ? 'name = Native Acceptance' :
      file.id === 'cargo-config' ? 'retry = 0' : file.id === 'conda-config' ? '  - defaults' : '# Retained user profile';
    assert.ok(text.includes(retained), `${file.id} preserves neighboring configuration`);
  }
  const after = new Map(files.map(file => [file.path, readFileSync(file.path)]));
  const repeated = await prepare(shared ? { ...request, sources: { os: false, supplied: [] } } : request, { logging: 'off' });
  assert.equal(repeated.status, 'ready', JSON.stringify(repeated));
  const reapplied = await apply(repeated.prepared, { approved: true, origin: 'automation',
    reviewDigest: repeated.review.reviewDigest }, { logging: 'off' });
  assert.equal(reapplied.completion, 'complete', JSON.stringify(reapplied));
  for (const file of files) assert.deepEqual(readFileSync(file.path), after.get(file.path), `${file.id} is idempotent`);
  writeFileSync('native-repeat.json', JSON.stringify(reapplied, null, 2));
  console.log(JSON.stringify({ package: contractSupport.package, targets, completion: result.completion,
    runId: result.runId, repeatRunId: reapplied.runId, platform: process.platform, arch: process.arch }));
}

if (process.argv[2] === '--consumer') {
  await exerciseConsumer();
} else {
  assert.ok(process.env.npm_execpath, 'Run with npm exec --offline --call "node scripts/ci/user-trust-native.mjs"');
  const targets = process.argv.find(value => value.startsWith('--targets='))?.slice(10).split(',') ?? allTargets;
  assert.ok(targets.length && new Set(targets).size === targets.length && targets.every(id => allTargets.includes(id)));
  if (process.platform === 'win32' && targets.includes('python'))
    assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Windows Python persistence acceptance requires a disposable hosted runner');
  const scratchParent = realpathSync(tmpdir());
  const root = mkdtempSync(join(scratchParent, 'aih-native-trust-'));
  const source = fileURLToPath(new URL('../../', import.meta.url));
  const home = join(root, 'home'), consumer = join(root, 'consumer');
  mkdirSync(home); mkdirSync(consumer);
  const originalHome = homedir();
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'), XDG_CONFIG_HOME: join(home, '.config'),
    CARGO_HOME: join(home, '.cargo'), RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(originalHome, '.rustup'),
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', CONDARC: join(home, '.condarc') };
  // Windows platformdirs reads Known Folders independently of HOME/APPDATA.
  // Its supported fixture overrides keep pip away from the real user profile.
  if (process.platform === 'win32') {
    env.WIN_PD_OVERRIDE_APPDATA = env.APPDATA;
    env.WIN_PD_OVERRIDE_LOCAL_APPDATA = env.LOCALAPPDATA;
  }
  if (process.env.CONDA) env.PATH = [join(process.env.CONDA, process.platform === 'win32' ? 'Scripts' : 'bin'), env.PATH].join(delimiter);
  // The fixture uses normal verified TLS rather than inherited host overrides.
  for (const key of Object.keys(env)) if (/^(?:npm_config_allow_scripts|node_test_context|pip_config_file|pip_cert|pip_trusted_host|requests_ca_bundle|curl_ca_bundle|ssl_cert_file|git_ssl_cainfo|git_ssl_no_verify|cargo_http_cainfo|cargo_http_ssl_verify|conda_ssl_verify)$/i.test(key)) delete env[key];
  const reportDirectory = join(source, 'native-trust-results');
  mkdirSync(reportDirectory, { recursive: true });
  for (const name of ['native-failure.json', 'native-result.json', 'native-repeat.json', 'native-package.json', 'native-diagnostics.json'])
    if (existsSync(join(reportDirectory, name))) unlinkSync(join(reportDirectory, name));
  const npm = (args, cwd) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd, env, encoding: 'utf8', timeout: 120000 });
  let succeeded = false;
  try {
    const packed = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', root], source))[0];
    writeFileSync(join(reportDirectory, 'native-package.json'), JSON.stringify({ name: packed.name,
      version: packed.version, filename: packed.filename, sha256: sha256(readFileSync(join(root, packed.filename))),
      integrity: packed.integrity, workflowRevision: process.env.GITHUB_SHA ?? null }, null, 2));
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module',
      dependencies: { '@aihq/core': `file:${join(root, packed.filename)}` } }));
    // npm exec --offline selects this local script; its inherited offline flag
    // must not prevent the new consumer from obtaining published dependencies.
    npm(['install', '--offline=false', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], consumer);
    const caPath = join(consumer, 'supplied-ca.pem');
    copyFileSync(join(source, 'test/fixtures/root-a.pem'), caPath);
    copyFileSync(fileURLToPath(import.meta.url), join(consumer, 'native.mjs'));
    console.log(execFileSync(process.execPath, [join(consumer, 'native.mjs'), '--consumer', caPath, targets.join(',')],
      { cwd: consumer, env, encoding: 'utf8', timeout: 300000, maxBuffer: 2 * 1024 * 1024 }));
    succeeded = true;
  } catch (error) {
    writeFileSync(join(reportDirectory, 'native-failure.json'), JSON.stringify({ platform: process.platform,
      architecture: process.arch, node: process.version, targets,
      message: error instanceof Error ? error.message : 'Native acceptance failed' }, null, 2));
    throw error;
  } finally {
    for (const name of ['native-result.json', 'native-repeat.json', 'native-diagnostics.json'])
      if (existsSync(join(consumer, name))) copyFileSync(join(consumer, name), join(reportDirectory, name));
    if (succeeded) {
      assert.ok(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink());
      assert.equal(dirname(realpathSync(root)), scratchParent, 'Cleanup stays inside the dedicated temporary parent');
      rmSync(root, { recursive: true });
    }
    else console.error(`Native acceptance failed; isolated evidence retained at ${root}`);
  }
}
