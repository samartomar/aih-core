import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRepairDefinition, getRepairRecipe, repairObservationRequests, assessRepairObservations } from '../../dist/harness/runtime.mjs';
import { repairIndex } from '../../dist/harness/contracts.mjs';

const environmentKeys = ['APPDATA', 'XDG_CONFIG_HOME', 'CARGO_HOME', 'CONDARC', 'GIT_CONFIG_GLOBAL',
  'PIP_CERT', 'PIP_CONFIG_FILE', 'WIN_PD_OVERRIDE_APPDATA', 'WIN_PD_OVERRIDE_LOCAL_APPDATA',
  'PIP_USER', 'PIP_SITE', 'PIP_GLOBAL',
  'GIT_SSL_CAINFO', 'CARGO_HTTP_CAINFO', 'CARGO_HTTP_SSL_VERIFY', 'PIP_TRUSTED_HOST', 'GIT_SSL_NO_VERIFY', 'CONDA_SSL_VERIFY'];
const savedEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
before(() => { for (const key of environmentKeys) delete process.env[key]; });
after(() => { for (const [key, value] of Object.entries(savedEnvironment)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
} });

const ca = readFileSync(new URL('./fixtures/root-a.pem', import.meta.url));
const variantRef = targets => `user-tools-ca/${process.platform}/${targets.join('+')}/off`;
const prepare = (targets, configSnapshots = {}, extra = {}) => prepareRepairDefinition({
  id: 'user-tools-ca', variantRef: variantRef(targets), targets, files: { caFile: ca },
  configSnapshots, managedPath: '/x/ca.pem', offline: true, ...extra
});

test('selected pip repair retains neighboring settings and donor truststore guidance', () => {
  const result = prepare(['pip'], { 'pip-config': Buffer.from('[global]\nindex-url=https://r.example/simple\n[install]\nupgrade=true\n') });
  assert.equal(result.status, 'completed', JSON.stringify(result.diagnostics));
  assert.equal(result.privateBindings.pipConfig, '[global]\ncert=/x/ca.pem\nindex-url=https://r.example/simple\n[install]\nupgrade=true\n# pip >= 24.2 on Python 3.10+ can instead verify via the OS store:\n#   use-feature = truststore\n');
});

test('full transformed user configuration stays in sensitive bindings', () => {
  const result = prepare(['pip'], { 'pip-config': Buffer.from('[global]\nindex-url=https://user:private-secret@r.example/simple\n') });
  assert.equal(result.status, 'completed');
  assert.ok(result.privateBindings.pipConfig.includes('private-secret'));
  assert.equal(JSON.stringify(result.bindings).includes('private-secret'), false);
  const recipe = getRepairRecipe(variantRef(['pip']));
  assert.equal(recipe.inputs.pipConfig.sensitive, true);
});

test('Cargo retains both donor keys, Windows path safety, neighboring TOML and idempotence', () => {
  const path = process.platform === 'win32' ? 'C:\\Users\\samar\\ca.pem' : '/x/ca.pem';
  const serialized = process.platform === 'win32' ? '"C:/Users/samar/ca.pem"' : '"/x/ca.pem"';
  const original = '# keep\r\n[http]\r\nproxy = "https://proxy.example"\r\n[net]\r\nretry = 2\r\n';
  const first = prepare(['cargo'], { 'cargo-config': Buffer.from(original) }, { managedPath: path });
  assert.equal(first.status, 'completed', JSON.stringify(first.diagnostics));
  assert.equal(first.privateBindings.cargoConfig, `# keep\r\n[http]\r\ncainfo = ${serialized}\r\nproxy = "https://proxy.example"\r\n[net]\r\ngit-fetch-with-cli = true\r\nretry = 2\r\n`);
  const twice = prepare(['cargo'], { 'cargo-config': Buffer.from(first.privateBindings.cargoConfig) }, { managedPath: path });
  assert.equal(twice.privateBindings.cargoConfig, first.privateBindings.cargoConfig);
});

test('Cargo refuses inherited TLS bypass before any repair definition is produced', () => {
  try {
    for (const value of ['false', '0', 'TRUE']) {
      process.env.CARGO_HTTP_SSL_VERIFY = value;
      const result = prepare(['cargo']);
      assert.equal(result.status, 'blocked', value);
      assert.equal(result.diagnostics[0].reason, 'trust-bypass-environment');
      assert.equal(result.bindings, undefined);
    }
    process.env.CARGO_HTTP_SSL_VERIFY = 'true';
    assert.equal(prepare(['cargo']).status, 'completed');
  } finally { delete process.env.CARGO_HTTP_SSL_VERIFY; }
});

test('selected Cargo definitions bind its executable and declare extensionless config absence', () => {
  const definition = repairIndex.find(item => item.id === 'user-tools-ca');
  for (const variant of definition.variants.filter(item => item.targets.includes('cargo'))) {
    assert.equal(variant.requiredAbsences.length, 1);
    assert.deepEqual(variant.requiredAbsences[0].target,
      { root: 'userHome', segments: [{ literal: '.cargo' }, { literal: 'config' }] });
    assert.equal(variant.requiredAbsences[0].reason, 'cargo-legacy-config');
    if (variant.network !== 'off') assert.ok(variant.executableBindings.some(item => item.name === 'cargo' && item.pathInput === 'cargoExecutable'));
  }
});

test('Cargo behavioral verification uses inherited trust and the captured executable path', () => {
  const probe = getRepairRecipe(`user-tools-ca/${process.platform}/cargo/declared`).checks.find(item => item.id === 'cargo-behavior');
  assert.equal(probe.env.CARGO_HTTP_SSL_VERIFY, undefined);
  assert.ok(probe.args.some(slot => slot.input === 'cargoExecutable'));
});

test('Cargo verification refuses legacy config and filesystem errors before invoking its bound executable', () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-cargo-effective-trust-'));
  try {
    const boundary = join(root, 'process-boundary.cjs');
    writeFileSync(boundary, `
      const fs=require('node:fs'),original=fs.lstatSync;
      fs.lstatSync=(path,...args)=>{
        if(path===process.env.FIXTURE_LEGACY_CONFIG){
          if(process.env.FIXTURE_LSTAT==='dangling')return {isSymbolicLink:()=>true};
          if(process.env.FIXTURE_LSTAT==='denied'){const error=new Error('private path');error.code='EACCES';throw error}
        }
        return original(path,...args);
      };
      require('node:child_process').spawnSync=(file,args,options)=>{
        if(file!==process.env.FIXTURE_BOUND_EXE||options.shell!==false||options.env.CARGO_HTTP_SSL_VERIFY!==process.env.CARGO_HTTP_SSL_VERIFY||options.timeout>18000||options.maxBuffer!==16384)return {status:2,stdout:'',stderr:''};
        if(JSON.stringify(args)!==JSON.stringify(['search','serde','--limit','1']))return {status:2,stdout:'',stderr:''};
        fs.writeFileSync(process.env.FIXTURE_NETWORK_MARKER,'queried');
        return {status:0,stdout:'private tool output',stderr:''};
      };
    `);
    const probe = getRepairRecipe(`user-tools-ca/${process.platform}/cargo/declared`).checks.find(item => item.id === 'cargo-behavior');
    const legacy = join(root, 'config');
    const bindings = { bundlePath: join(root, 'ca.pem'), cargoConfigPath: join(root, 'config.toml'), cargoExecutable: join(root, 'bound-cargo.exe') };
    const cases = [
      { verify: undefined, accepted: true },
      { verify: 'true', accepted: true },
      { verify: 'false', accepted: false },
      { verify: 'TRUE', accepted: false },
      { legacy: 'file', accepted: false },
      { legacy: 'dangling', accepted: false },
      { legacy: 'denied', accepted: false }
    ];
    for (const [index, fixture] of cases.entries()) {
      if (fixture.legacy === 'file') writeFileSync(legacy, '[http]\nssl-verify=false\n');
      else rmSync(legacy, { force: true });
      const marker = join(root, `network-${index}`);
      const env = { ...process.env, FIXTURE_BOUND_EXE: bindings.cargoExecutable, FIXTURE_NETWORK_MARKER: marker,
        FIXTURE_LEGACY_CONFIG: legacy, FIXTURE_LSTAT: fixture.legacy ?? 'absent' };
      for (const name of Object.keys(env)) if (/^CARGO_(HOME|HTTP_SSL_VERIFY|HTTP_CAINFO)$/i.test(name)) delete env[name];
      if (fixture.verify !== undefined) env.CARGO_HTTP_SSL_VERIFY = fixture.verify;
      const result = spawnSync(probe.executable.name, ['--require', boundary,
        ...probe.args.map(slot => slot.literal ?? bindings[slot.input])],
      { cwd: root, env, shell: false, encoding: 'utf8', timeout: probe.timeoutMs, maxBuffer: probe.maxOutputBytes, windowsHide: true });
      assert.equal(result.status, fixture.accepted ? 0 : 1, `Cargo fixture ${index}`);
      assert.equal(existsSync(marker), fixture.accepted, `Cargo network scheduling ${index}`);
      assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('duplicate or disabled pip trust refuses a misleading verified repair', () => {
  assert.equal(prepare(['pip'], { 'pip-config': Buffer.from('[global]\ncert=/one\ncert=/two\n') }).diagnostics[0].reason, 'config-ambiguous');
  assert.equal(prepare(['pip'], { 'pip-config': Buffer.from('[global]\ntrusted-host = pypi.org\n') }).diagnostics[0].reason, 'trust-bypass-config');
});

test('pip colon and mixed-case trusted-host settings never become verified CA repairs', () => {
  for (const line of ['trusted-host: pypi.org', 'TrUsTeD-HoSt = pypi.org', 'trusted-host:\n    pypi.org']) {
    const result = prepare(['pip'], { 'pip-config': Buffer.from(`[global]\n${line}\n`) });
    assert.equal(result.status, 'blocked', line);
    assert.equal(result.diagnostics[0].reason, 'trust-bypass-config');
    assert.equal(result.bindings, undefined);
  }
});

test('pip colon cert syntax is rejected before duplicate trust keys can be generated', () => {
  const result = prepare(['pip'], { 'pip-config': Buffer.from('[global]\ncert: /old/ca.pem\n') });
  assert.equal(result.status, 'invalid');
  assert.equal(result.diagnostics[0].reason, 'config-ambiguous');
  assert.equal(result.privateBindings, undefined);
});

test('pip verification refuses effective trusted hosts before an index query without exposing output', () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-pip-effective-trust-'));
  try {
    // The external process fixture speaks the real pip config-list protocol.
    // Node is a real shell-free executable on every supported test host.
    writeFileSync(join(root, 'config'), `
      const fs=require('node:fs');
      fs.writeFileSync(process.env.FIXTURE_QUERY_MARKER,process.argv[2]);
      if(process.argv[2]==='list'){
        process.stdout.write('global.cert='+JSON.stringify(process.env.FIXTURE_CA)+'\\n'+process.env.FIXTURE_TRUST_KEY+"='private-bypass-host.example'\\n");process.exit(0)
      }
      process.exit(1);
    `);
    const recipe = getRepairRecipe(`user-tools-ca/${process.platform}/pip/declared`);
    const probe = recipe.checks.find(item => item.id === 'pip-behavior');
    for (const key of ['global.trusted-host', 'index.trusted-host', 'install.trusted-host', 'download.trusted-host', ':env:.trusted-host']) {
      const marker = join(root, key.replaceAll(':', '-'));
      const bindings = { bundlePath: join(root, 'ca.pem'), pipConfigPath: join(root, 'pip.conf'), pipExecutable: process.execPath };
      const env = { ...process.env, FIXTURE_CA: bindings.bundlePath, FIXTURE_TRUST_KEY: key, FIXTURE_QUERY_MARKER: marker };
      for (const name of Object.keys(env)) if (/^PIP_(TRUSTED_HOST|CERT|CONFIG_FILE|INDEX_URL|EXTRA_INDEX_URL)$/i.test(name)) delete env[name];
      const result = spawnSync(probe.executable.name, probe.args.map(slot => slot.literal ?? bindings[slot.input]),
        { cwd: root, env, shell: false, encoding: 'utf8', timeout: probe.timeoutMs, maxBuffer: probe.maxOutputBytes, windowsHide: true });
      assert.equal(result.status, 1, key);
      assert.equal(readFileSync(marker, 'utf8'), 'list', `${key} must be observed through active config list`);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pip active config lists validate repr values and all trust overrides without assuming file precedence', () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-pip-list-'));
  try {
    const boundary = join(root, 'process-boundary.cjs');
    writeFileSync(boundary, `
      const fs=require('node:fs');require('node:child_process').spawnSync=(file,args,options)=>{
        if(options.shell!==false||file!==process.env.FIXTURE_BOUND_EXE||options.env.PIP_CONFIG_FILE!==process.env.PIP_CONFIG_FILE)return {status:2,stdout:'',stderr:''};
        if(args[0]==='config'&&args[1]==='list')return {status:0,stdout:process.env.FIXTURE_CONFIG_LIST,stderr:''};
        if(args[0]==='--disable-pip-version-check'){fs.writeFileSync(process.env.FIXTURE_NETWORK_MARKER,'queried');return {status:0,stdout:'pip versions',stderr:''}}
        return {status:2,stdout:'',stderr:''};
      };
    `);
    const probe = getRepairRecipe(`user-tools-ca/${process.platform}/pip/declared`).checks.find(item => item.id === 'pip-behavior');
    const bindings = { bundlePath: join(root, 'ca.pem'), pipConfigPath: join(root, 'pip.conf'), pipExecutable: process.execPath };
    const selected = `global.cert=${JSON.stringify(bindings.bundlePath)}\n`;
    const safe = selected + "global.index-url='https://pypi.org/simple'\nindex.extra-index-url='https://one.example/simple\\t https://two.example/simple'\n";
    const cases = [
      { list: safe, accepted: true },
      { list: safe + selected, accepted: true },
      { list: safe + selected.replace('ca.pem', 'ca\\x2epem'), accepted: true },
      { list: safe + "index.cert='/conflicting.pem'\n", accepted: false },
      { list: safe + "global.cert='/conflicting.pem'\n", accepted: false },
      { list: safe + ":env:.trusted-host='private-bypass.example'\n", accepted: false },
      { list: safe + "index.extra-index-url='https://safe.example/simple http://unsafe.example/simple'\n", accepted: false },
      { list: safe + "global.index-url='http://unsafe.example/simple'\n", accepted: false },
      { list: "global.cert=__import__('os').system('arbitrary')\n", accepted: false },
      { list: selected.replace('ca.pem', 'ca\\q.pem'), accepted: false }
    ];
    for (const [index, fixture] of cases.entries()) {
      const marker = join(root, `network-${index}`);
      const env = { ...process.env, FIXTURE_BOUND_EXE: process.execPath, FIXTURE_CONFIG_LIST: fixture.list, FIXTURE_NETWORK_MARKER: marker };
      for (const name of Object.keys(env)) if (/^PIP_(TRUSTED_HOST|CERT|CONFIG_FILE|INDEX_URL|EXTRA_INDEX_URL)$/i.test(name)) delete env[name];
      const result = spawnSync(probe.executable.name, ['--require', boundary,
        ...probe.args.map(slot => slot.literal ?? bindings[slot.input])],
      { cwd: root, env, shell: false, encoding: 'utf8', timeout: probe.timeoutMs, maxBuffer: probe.maxOutputBytes, windowsHide: true });
      assert.equal(result.status, fixture.accepted ? 0 : 1, `config-list fixture ${index}`);
      assert.equal(existsSync(marker), fixture.accepted, `network scheduling for config-list fixture ${index}`);
      assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pip refuses redirected config files and Windows known-folder overrides', () => {
  const canonical = join(homedir(), ...(process.platform === 'win32' ? ['AppData', 'Roaming', 'pip', 'pip.ini'] : ['.config', 'pip', 'pip.conf']));
  try {
    process.env.PIP_CONFIG_FILE = join(homedir(), 'other-pip.conf');
    assert.equal(prepare(['pip']).diagnostics[0].reason, 'user-config-location-unsupported');
    process.env.PIP_CONFIG_FILE = canonical;
    assert.equal(prepare(['pip']).status, 'completed');
    if (process.platform === 'win32') {
      process.env.WIN_PD_OVERRIDE_APPDATA = join(homedir(), 'other-appdata');
      assert.equal(prepare(['pip']).diagnostics[0].reason, 'user-config-location-unsupported');
      process.env.WIN_PD_OVERRIDE_APPDATA = join(homedir(), 'AppData', 'Roaming');
      assert.equal(prepare(['pip']).status, 'completed');
    }
  } finally { delete process.env.PIP_CONFIG_FILE; delete process.env.WIN_PD_OVERRIDE_APPDATA; }
});

test('Git and conda retain neighboring user configuration and are byte-idempotent', () => {
  const targets = ['git', 'conda'];
  const result = prepare(targets, { 'git-config': Buffer.from('[user]\nname = Developer\n'),
    'conda-config': Buffer.from('channels:\n  - defaults\nssl_verify: /old/ca.pem\n') });
  assert.equal(result.status, 'completed', JSON.stringify(result.diagnostics));
  assert.equal(result.privateBindings.gitConfig, '[user]\nname = Developer\n[http]\nsslCAInfo = "/x/ca.pem"\n');
  assert.equal(result.privateBindings.condaConfig, 'channels:\n  - defaults\nssl_verify: "/x/ca.pem"\n');
  const twice = prepare(targets, { 'git-config': Buffer.from(result.privateBindings.gitConfig),
    'conda-config': Buffer.from(result.privateBindings.condaConfig) }, { existing: Buffer.from(result.bundle) });
  assert.deepEqual(twice.bindings, result.bindings);
  assert.equal(twice.bundle, result.bundle);
});

test('a narrower repair preserves existing trust and rejects a complete-input bad suffix', () => {
  const previous = readFileSync(new URL('./fixtures/root-b.pem', import.meta.url));
  const result = prepare(['pip'], {}, { existing: previous });
  assert.equal(result.status, 'completed');
  assert.ok(result.bundle.startsWith(previous.toString()), 'existing certificate bytes are retained');
  const rejected = prepare(['git'], {}, { files: { caFile: Buffer.concat([ca, Buffer.from('garbage suffix')]) }, existing: previous });
  assert.equal(rejected.status, 'invalid');
  assert.equal(rejected.bundle, undefined);
  assert.equal(rejected.bindings, undefined);
});

test('fixed native graphs gate mutations behind tool readiness and Cargo Git, retaining offline gaps', () => {
  const definition = repairIndex.find(item => item.id === 'user-tools-ca');
  assert.equal(definition.variants.length, 186);
  const recipe = getRepairRecipe('user-tools-ca/win32/python+pip+git+cargo+conda/off');
  for (const id of ['python', 'pip', 'git', 'cargo', 'conda']) {
    const ready = recipe.operations.find(item => item.id === `${id}-ready`);
    const config = recipe.operations.find(item => item.id === `${id}-config`);
    assert.equal(ready.kind, 'process.run');
    assert.ok(config.requires.includes(`${id}-ready`));
    assert.ok(config.requires.includes('material'));
    assert.ok(!recipe.checks.some(item => item.id === `${id}-behavior`));
  }
  assert.ok(recipe.operations.find(item => item.id === 'cargo-ready').checks.includes('cargo-git-installed'));
  assert.equal(recipe.checks.find(item => item.id === 'cargo-git-installed').executable.name, 'git');
  for (const suffix of ['ssl', 'requests']) {
    const persist = recipe.operations.find(item => item.id === `python-persist-${suffix}`);
    assert.ok(persist.requires.includes('python-ready'));
    assert.ok(recipe.operations.find(item => item.id === 'python-config').requires.includes(persist.id));
  }
  assert.deepEqual(definition.offlineVerification.map(item => item.checkId),
    ['python-behavior', 'pip-behavior', 'git-behavior', 'cargo-behavior', 'conda-behavior']);
});

test('Windows Python observations require exact replacement and reject malformed environment output', () => {
  const observations = assessRepairObservations({ id: 'user-tools-ca', managedPath: '/x/ca.pem', observations: [
    { id: 'python-user-env-ssl', output: 'ABSENT' },
    { id: 'python-user-env-requests', output: 'VALUE:' + Buffer.from('/old/ca.pem').toString('base64') }
  ] });
  assert.equal(observations[0].conflict, false);
  assert.equal(observations[1].conflict, true);
  assert.equal(observations[1].operationId, 'python-persist-requests');
  assert.equal(observations[1].observedValue, '/old/ca.pem');
  assert.throws(() => assessRepairObservations({ id: 'user-tools-ca', managedPath: '/x/ca.pem', observations: [
    { id: 'python-user-env-ssl', output: 'VALUE:!bad' }
  ] }), /user-environment-invalid/);
  assert.equal(repairObservationRequests({ id: 'user-tools-ca', targets: ['python'] }).length,
    process.platform === 'win32' ? 2 : 0);
});
