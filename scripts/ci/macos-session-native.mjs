// Copy beside an installed @aihq/core package before running. Development evidence only.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tls from 'node:tls';
import { prepare, apply, verifyMacosSession, prepareManagedRemoval, listManagedSelections } from '@aihq/core';
import { contractSupport, validatePreparedWork13, validateRunResult13, validateMacosSessionCustody,
  validateMacosSessionVerificationResult } from '@aihq/core/contracts';
import { macosSessionProfiles, selectRepairDefinition } from '@aihq/core/harness';

assert.equal(process.platform, 'darwin');
assert.notEqual(process.geteuid(), 0, 'Use an ordinary account, not root.');
assert.equal(process.getuid(), process.geteuid(), 'Use the account directly, without an elevated effective identity.');
const options = process.argv.slice(2);
assert.ok(options.length === 0 || options.length === 1 && options[0] === '--require-standard-user', 'Unknown rehearsal option.');
const groups = execFileSync('/usr/bin/id', ['-Gn'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 65_536 }).trim().split(/\s+/);
const adminGroup = groups.includes('admin');
if (options.includes('--require-standard-user')) assert.equal(adminGroup, false, 'VM acceptance needs the nonadmin test account.');
const os = execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 10_000 }).trim();
assert.match(os, /^26\./);
const root = mkdtempSync(join(realpathSync(tmpdir()), 'aih-macos-session-native-'));
const home = join(root, 'home'), project = join(root, 'project'), fixtures = join(root, 'fixtures');
for (const directory of [home, project, fixtures]) mkdirSync(directory);
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
let server;
const cases = [];
const passed = name => cases.push({ id: name, outcome: 'passed' });
const approve = p => ({ approved: true, origin: 'automation', reviewDigest: p.review.reviewDigest });
const openssl = args => execFileSync('/usr/bin/openssl', args, { cwd: fixtures, timeout: 30_000, stdio: 'ignore' });
try {
  writeFileSync(join(fixtures, 'ca.cnf'), '[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=AIHQ Development Session Fixture\n[ca]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\n');
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-config', 'ca.cnf']);
  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost']);
  writeFileSync(join(fixtures, 'server.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
  openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.pem', '-days', '1', '-extfile', 'server.ext']);
  server = tls.createServer({ key: readFileSync(join(fixtures, 'server.key')), cert: readFileSync(join(fixtures, 'server.pem')) }, socket => socket.end());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const probe = join(root, 'probe.mjs');
  writeFileSync(probe, "import tls from 'node:tls';const s=tls.connect({host:'127.0.0.1',port:Number(process.argv[2]),servername:'localhost',rejectUnauthorized:true},()=>{process.stdout.write(s.authorized?'trusted\\n':'untrusted\\n');s.end();});s.setTimeout(5000,()=>{s.destroy();process.exitCode=1;});s.on('error',()=>{process.exitCode=1;});");
  // Async child: the local TLS server must remain able to accept connections.
  const { spawn } = await import('node:child_process');
  const loginProbe = async () => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, ZDOTDIR: home, NODE_USE_SYSTEM_CA: '0' };
    delete env.NODE_EXTRA_CA_CERTS; delete env.NODE_TLS_REJECT_UNAUTHORIZED; delete env.NODE_OPTIONS;
    const child = spawn('/bin/zsh', ['-l', '-c', 'exec "$1" "$2" "$3"', 'aih-session-probe', process.execPath, probe, String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = ''; child.stdout.on('data', bytes => { text += bytes; });
    child.stderr.resume();
    const timer = setTimeout(() => child.kill('SIGTERM'), 10_000);
    try { return await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, text })); }); }
    finally { clearTimeout(timer); }
  };
  writeFileSync(join(home, '.zprofile'), 'export AIHQ_UNRELATED=preserve\n');
  process.env.HOME = home; process.env.USERPROFILE = home;
  const file = join(fixtures, 'ca.pem');
  const request = { schema: 'urn:aihq:core:repair-request:1.1.0', useCase: 'repair', route: 'file', network: 'off',
    repairs: [{ id: 'node-npm-ca', targets: ['node'], inputs: {} }], sources: { os: false, supplied: [{ id: 'team', file }] },
    macosSession: { context: 'terminal', applications: [] } };
  assert.equal(macosSessionProfiles.profiles.length, 0, 'This candidate admits no desktop app.');
  assert.ok(selectRepairDefinition({ requestSchema: request.schema, definitionSchema: 'urn:aihq:harness:repair:1.2.0', repairId: 'node-npm-ca' }));
  assert.notEqual((await loginProbe()).code, 0); passed('fresh-login-private-ca-negative-before');
  const preparation = await prepare(request, { logging: 'off' });
  assert.equal(preparation.status, 'ready', JSON.stringify(preparation));
  assert.equal(validatePreparedWork13(preparation.review).valid, true, JSON.stringify(validatePreparedWork13(preparation.review)));
  assert.doesNotMatch(readFileSync(join(home, '.zprofile'), 'utf8'), /NODE_EXTRA_CA_CERTS/); passed('preview-has-no-config-effect');
  const wrong = await apply(preparation.prepared, { ...approve(preparation), reviewDigest: '0'.repeat(64) }, { logging: 'off' });
  assert.equal(wrong.completion, 'rejected'); passed('exact-review-approval');
  const applied = await apply(preparation.prepared, approve(preparation), { logging: 'off' });
  assert.equal(applied.completion, 'complete', JSON.stringify(applied));
  assert.equal(validateRunResult13(applied).valid, true, JSON.stringify(validateRunResult13(applied)));
  assert.equal(applied.macosSession.verification, 'skipped');
  assert.equal((await loginProbe()).code, 0); passed('fresh-login-private-ca-positive-after');
  const custody = JSON.parse(readFileSync(join(home, '.aih/core/macos-session-custody.json'), 'utf8'));
  assert.equal(validateMacosSessionCustody(custody).valid, true, JSON.stringify(validateMacosSessionCustody(custody)));
  assert.equal(existsSync(join(home, '.aih/core/history')), false); passed('protected-custody-survives-no-log');
  const changedSelection = await prepare({ ...request, repairs: [{ id: 'node-npm-ca', targets: ['npm'], inputs: {} }] }, { logging: 'off' });
  assert.equal(changedSelection.status, 'blocked');
  assert.ok(changedSelection.diagnostics.some(row => row.reason === 'session-selection-change-unsupported'));
  passed('target-transition-requires-reviewed-removal');
  const legacyRequest = { ...request, schema: 'urn:aihq:core:repair-request:1.0.0' };
  delete legacyRequest.macosSession;
  const ownedProfile = readFileSync(join(home, '.zprofile'), 'utf8');
  const legacy = await prepare(legacyRequest, { logging: 'off' });
  assert.notEqual(legacy.status, 'ready', JSON.stringify(legacy));
  assert.equal(readFileSync(join(home, '.zprofile'), 'utf8'), ownedProfile); passed('current-runtime-blocks-old-request-on-session-member');
  const verificationRequest = { schema: 'urn:aihq:core:macos-session-verification-request:1.0.0', managementId: 'node-npm-trust' };
  const verified = await verifyMacosSession(verificationRequest, { logging: 'off' });
  assert.equal(verified.configuration, 'already-satisfied', JSON.stringify(verified));
  assert.equal(verified.status, 'incomplete'); assert.equal(verified.verification, 'skipped');
  assert.equal(validateMacosSessionVerificationResult(verified).valid, true, JSON.stringify(validateMacosSessionVerificationResult(verified))); passed('offline-observation-is-not-a-pass');
  const trustPath = join(home, '.aih/core/trust-custody.json'), trustBytes = readFileSync(trustPath);
  writeFileSync(trustPath, JSON.stringify({ schema: 'urn:aihq:core:trust-custody:1.0.0', entries: [] }));
  const absentTrust = await verifyMacosSession(verificationRequest, { logging: 'off' });
  assert.equal(absentTrust.configuration, 'not-applied'); assert.equal(absentTrust.bindingSha256, null);
  writeFileSync(trustPath, trustBytes);
  const trustPending = join(home, '.aih/core/trust-custody-pending.json');
  writeFileSync(trustPending, '{}', { mode: 0o600 });
  assert.equal((await verifyMacosSession(verificationRequest, { logging: 'off' })).reason, 'session-recovery-required');
  rmSync(trustPending); passed('verification-joins-trust-custody-and-pending-intent');
  const repeat = await prepare(request, { logging: 'off' });
  assert.equal(repeat.status, 'ready', JSON.stringify(repeat));
  assert.equal((await apply(repeat.prepared, approve(repeat), { logging: 'off' })).macosSession.configuration, 'already-satisfied'); passed('unchanged-rerun');
  const inventory = await listManagedSelections({ target: { project }, scope: 'user' });
  assert.equal(inventory.status, 'complete', JSON.stringify(inventory));
  assert.ok(inventory.selections.some(row => row.managementId === 'node-npm-trust')); passed('managed-inventory');
  const profile = readFileSync(join(home, '.zprofile'), 'utf8');
  writeFileSync(join(home, '.zprofile'), profile + 'export AIHQ_FOREIGN=preserve\n');
  assert.equal((await verifyMacosSession(verificationRequest, { logging: 'off' })).reason, 'session-config-drift');
  const removalRequest = { target: { project }, managementId: 'node-npm-trust', scope: 'user', mode: 'vibe' };
  assert.equal((await prepareManagedRemoval(removalRequest, { logging: 'off' })).disposition, 'reconcile-required'); passed('foreign-drift-is-preserved');
  writeFileSync(join(home, '.zprofile'), profile);
  const desktop = await prepare({ ...request, macosSession: { context: 'desktop', applications: [{ clientId: 'kiro', appPath: '/Applications/Kiro.app', targets: ['node'], launch: 'finder' }] } }, { logging: 'off' });
  assert.equal(desktop.status, 'blocked'); assert.ok(desktop.diagnostics.some(row => row.reason === 'app-session-unsupported')); passed('desktop-unadmitted-is-blocked');
  const removal = await prepareManagedRemoval(removalRequest, { logging: 'off' });
  assert.equal(removal.disposition, 'prepared', JSON.stringify(removal));
  const removed = await apply(removal.preparation.prepared, approve(removal.preparation), { logging: 'off' });
  assert.equal(removed.completion, 'complete', JSON.stringify(removed));
  assert.equal(validateRunResult13(removed).valid, true, JSON.stringify(validateRunResult13(removed)));
  assert.doesNotMatch(readFileSync(join(home, '.zprofile'), 'utf8'), /NODE_EXTRA_CA_CERTS/);
  assert.match(readFileSync(join(home, '.zprofile'), 'utf8'), /AIHQ_UNRELATED=preserve/);
  assert.notEqual((await loginProbe()).code, 0); passed('owned-removal-and-private-ca-negative-after');
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.aih/core/macos-session-custody.json'), 'utf8')).entries, []);
  const afterWriteAbort = new AbortController();
  const online = await prepare({ ...request, network: 'declared' }, { logging: 'off' });
  assert.equal(online.status, 'ready', JSON.stringify(online));
  const watcher = watch(home, (_event, name) => {
    if (String(name) === '.zprofile') {
      try { if (/NODE_EXTRA_CA_CERTS/.test(readFileSync(join(home, '.zprofile'), 'utf8'))) afterWriteAbort.abort(); } catch {}
    }
  });
  let interrupted;
  try { interrupted = await apply(online.prepared, approve(online), { logging: 'off', signal: afterWriteAbort.signal }); }
  finally { watcher.close(); }
  assert.ok(interrupted.operations.some(row => row.application === 'applied'));
  assert.ok(['incomplete', 'cancelled'].includes(interrupted.completion), JSON.stringify(interrupted));
  assert.equal(interrupted.macosSession.configuration, 'uncertain');
  assert.ok(interrupted.followUp.some(text => text.includes('new login shell')));
  assert.equal(existsSync(join(home, '.aih/core/macos-session-pending.json')), true); passed('abort-after-writes-retains-effects-and-recovery');
  let freshRequest = structuredClone(request);
  let recovered = await prepare(freshRequest, { logging: 'off' });
  if (recovered.status === 'blocked' && recovered.resolutionInputs?.length) {
    freshRequest.resolutions = recovered.resolutionInputs.map(row => {
      assert.ok(row.availableChoices.includes('replace'));
      return { selectionId: row.selectionId, operationId: row.operationId, choice: 'replace', observedSha256: row.observedSha256 };
    });
    recovered = await prepare(freshRequest, { logging: 'off' });
  }
  assert.equal(recovered.status, 'ready', JSON.stringify(recovered));
  assert.equal((await apply(recovered.prepared, approve(recovered), { logging: 'off' })).completion, 'complete');
  assert.equal(existsSync(join(home, '.aih/core/macos-session-pending.json')), false); passed('fresh-review-reconciles-same-session');
  const finalRemoval = await prepareManagedRemoval(removalRequest, { logging: 'off' });
  assert.equal(finalRemoval.disposition, 'prepared', JSON.stringify(finalRemoval));
  assert.equal((await apply(finalRemoval.preparation.prepared, approve(finalRemoval.preparation), { logging: 'off' })).completion, 'complete');
  const cancelled = new AbortController(); cancelled.abort();
  assert.equal((await prepare(request, { logging: 'off', signal: cancelled.signal })).status, 'cancelled'); passed('abort-before-effects');
  const cli = new URL('./node_modules/@aihq/core/dist/core/cli.js', import.meta.url);
  const cliResult = spawnSync(process.execPath, [fileURLToPath(cli), 'verify-macos-session', '--management-id', 'node-npm-trust', '--no-log', '--json'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(cliResult.status, 1, cliResult.stderr); assert.equal(JSON.parse(cliResult.stdout).status, 'incomplete'); passed('packed-observation-cli');
  process.stdout.write(JSON.stringify({ kind: 'development-rehearsal', package: contractSupport.package,
    host: { os, architecture: process.arch, uid: process.geteuid(), adminGroup }, cases,
    fixtureCaSha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    desktopAdmission: 'none', fullAcceptance: 'pending-real-mac-and-named-app-evidence' }, null, 2) + '\n');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  assert.ok(root.startsWith(join(realpathSync(tmpdir()), 'aih-macos-session-native-')));
  rmSync(root, { recursive: true, force: true });
}
