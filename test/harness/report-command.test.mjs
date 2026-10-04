import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const cli = fileURLToPath(new URL('../../dist/core/cli.js', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

// Every run uses a temporary home and a temporary working directory; the checkout is never a target.
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'aih-report-cli-'));
  const home = join(root, 'home'), cwd = join(root, 'work');
  mkdirSync(home); mkdirSync(cwd);
  const run = (args, env = {}) => spawnSync(process.execPath, [cli, ...args], {
    cwd, encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOME: home, USERPROFILE: home, ...env }
  });
  return { root, home, cwd, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const summary = result => JSON.parse(result.stdout);
const rejected = (result, reason) => {
  assert.equal(result.status, 2, result.stdout + result.stderr);
  const body = summary(result);
  assert.equal(body.status, 'invalid');
  if (reason) assert.equal(body.diagnostics[0].reason, reason);
};

// A fresh, bounded diagnostic that later tests reuse as supplied snapshot input.
function acquire(w, name = 'fresh') {
  const out = join(w.cwd, name);
  const result = w.run(['report', '--output', out, '--target', 'node', '--offline', '--json']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return { out, result, snapshot: JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')) };
}
function writeSnapshot(w, edit) {
  const { snapshot } = acquire(w, 'seed');
  edit(snapshot);
  const file = join(w.cwd, 'supplied.json');
  writeFileSync(file, JSON.stringify(snapshot));
  return file;
}

test('aih report acquires a bounded offline Node/Git diagnostic into a new directory', () => {
  const w = workspace();
  try {
    const result = w.run(['report', '--output', 'out', '--json']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const body = summary(result);
    assert.equal(body.status, 'complete');
    assert.equal(body.mode, 'report');
    assert.equal(body.source, 'fresh');
    assert.deepEqual(body.package, { name: manifest.name, version: manifest.version });
    // macOS may expose the temporary cwd through /var while the child reports /private/var.
    const requestedOutput = join(w.cwd, 'out');
    assert.equal(realpathSync(body.output.directory), realpathSync(requestedOutput));
    assert.equal(body.output.json, join(body.output.directory, 'report.json'));
    assert.equal(body.output.html, join(body.output.directory, 'report.html'));
    assert.equal(realpathSync(body.output.json), realpathSync(join(requestedOutput, 'report.json')));
    assert.equal(realpathSync(body.output.html), realpathSync(join(requestedOutput, 'report.html')));
    assert.deepEqual(readdirSync(join(w.cwd, 'out')).sort(), ['report.html', 'report.json']);

    const snapshot = JSON.parse(readFileSync(join(w.cwd, 'out', 'report.json'), 'utf8'));
    assert.equal(snapshot.producer.name, manifest.name);
    assert.equal(snapshot.producer.version, manifest.version);
    assert.equal(snapshot.producer.revision, null);
    assert.equal(snapshot.capture.acquisition, 'newly-acquired');
    assert.equal(snapshot.evidence.originalSha256, null);
    assert.equal(snapshot.evidence.authentication, 'not-authenticated');
    assert.equal(snapshot.status, 'completed');
    assert.deepEqual(snapshot.tools.filter(tool => tool.selection === 'requested').map(tool => tool.id).sort(), ['git', 'node']);
    assert.equal(body.diagnosticStatus, 'completed');
    assert.deepEqual(body.counts, snapshot.metrics.counts);
    assert.deepEqual(body.totals, { tools: snapshot.tools.length, observations: snapshot.observations.length,
      checks: snapshot.checks.length, diagnostics: snapshot.diagnostics.length });
    // Offline acquisition performs no network check: no TLS check can have passed or failed.
    assert.equal(snapshot.checks.some(check => check.id.includes('/tls/') && check.outcome !== 'skipped'), false);

    const html = readFileSync(join(w.cwd, 'out', 'report.html'), 'utf8');
    assert.match(html, /^<!doctype html>/i);
    assert.equal(html.includes('class="demo-banner"'), false);
    // Summary is machine-readable metadata, never raw evidence or local roots.
    for (const text of [result.stdout.replace(w.cwd, ''), readFileSync(join(w.cwd, 'out', 'report.json'), 'utf8'), html])
      assert.equal(text.toLowerCase().includes(w.home.toLowerCase()), false);
    assert.equal(readFileSync(join(w.cwd, 'out', 'report.json'), 'utf8').includes(w.cwd), false);
    assert.deepEqual(readdirSync(w.home), []);
  } finally { w.cleanup(); }
});

test('aih report accepts repeated explicit targets and always runs with the network off', () => {
  const w = workspace();
  try {
    const result = w.run(['report', '--output', join(w.cwd, 'out'), '--target', 'node', '--target', 'npm', '--offline', '--json']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const snapshot = JSON.parse(readFileSync(join(w.cwd, 'out', 'report.json'), 'utf8'));
    assert.deepEqual(snapshot.tools.filter(tool => tool.selection === 'requested').map(tool => tool.id).sort(), ['node', 'npm']);
    assert.equal(snapshot.checks.filter(check => check.id.includes('/tls/')).every(check => check.outcome === 'skipped'), true);
    assert.equal(snapshot.checks.some(check => check.id.includes('/tls/')), true);
    // Without --offline the network is still off.
    const implicit = w.run(['report', '--output', join(w.cwd, 'implicit'), '--target', 'npm', '--json']);
    assert.equal(implicit.status, 0, implicit.stdout + implicit.stderr);
    const second = JSON.parse(readFileSync(join(w.cwd, 'implicit', 'report.json'), 'utf8'));
    assert.equal(second.checks.filter(check => check.id.includes('/tls/')).every(check => check.outcome === 'skipped'), true);
  } finally { w.cleanup(); }
});

test('aih report renders a supplied snapshot without reacquiring or relabelling it', () => {
  const w = workspace();
  try {
    const file = writeSnapshot(w, snapshot => {
      snapshot.capture = { observedAt: '2020-01-02T03:04:05.000Z', acquisition: 'supplied' };
      snapshot.tools = [{ id: 'kiro', label: 'Kiro', state: 'absent', selection: 'unselected' }];
      snapshot.observations = []; snapshot.diagnostics = [];
      snapshot.checks = [{ id: 'kiro/version', target: 'kiro', outcome: 'skipped', reason: 'offline', detail: '' }];
      snapshot.metrics.counts = { passed: 0, failed: 0, unavailable: 0, skipped: 1 };
    });
    const result = w.run(['report', '--output', 'imported', '--snapshot', file, '--json']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const body = summary(result);
    assert.equal(body.status, 'complete');
    assert.equal(body.source, 'snapshot');
    assert.deepEqual(body.counts, { passed: 0, failed: 0, unavailable: 0, skipped: 1 });
    const imported = JSON.parse(readFileSync(join(w.cwd, 'imported', 'report.json'), 'utf8'));
    assert.equal(imported.capture.observedAt, '2020-01-02T03:04:05.000Z');
    assert.equal(imported.capture.acquisition, 'supplied');
    assert.deepEqual(imported.tools.map(tool => tool.id), ['kiro']);
    assert.equal(imported.evidence.authentication, 'not-authenticated');
    assert.equal(imported.evidence.originalSha256, null);
    assert.match(readFileSync(join(w.cwd, 'imported', 'report.html'), 'utf8'), /Kiro/);
  } finally { w.cleanup(); }
});

test('aih report round-trips a generated snapshot byte-for-byte and renders deterministically', () => {
  const w = workspace();
  try {
    const first = acquire(w, 'first');
    const again = w.run(['report', '--output', join(w.cwd, 'second'), '--snapshot', join(first.out, 'report.json'), '--json']);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    for (const name of ['report.json', 'report.html'])
      assert.deepEqual(readFileSync(join(w.cwd, 'second', name)), readFileSync(join(first.out, name)));
  } finally { w.cleanup(); }
});

test('aih report --demo labels the render as a design sample and never shows snapshot values', () => {
  const w = workspace();
  try {
    const file = writeSnapshot(w, snapshot => {
      snapshot.tools = [{ id: 'kiro', label: 'DistinctiveSupplied', state: 'absent', selection: 'unselected' }];
      snapshot.observations = []; snapshot.diagnostics = [];
      snapshot.checks = [{ id: 'kiro/version', target: 'kiro', outcome: 'skipped', reason: 'offline', detail: '' }];
      snapshot.metrics.counts = { passed: 0, failed: 0, unavailable: 0, skipped: 1 };
    });
    const result = w.run(['report', '--output', 'demo', '--snapshot', file, '--demo', '--json']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(summary(result).mode, 'demo');
    const html = readFileSync(join(w.cwd, 'demo', 'report.html'), 'utf8');
    assert.match(html, /class="demo-banner"><strong>DEMO<\/strong>/);
    assert.equal(html.includes('DistinctiveSupplied'), false);
    // The data file remains the true supplied snapshot.
    assert.equal(JSON.parse(readFileSync(join(w.cwd, 'demo', 'report.json'), 'utf8')).tools[0].label, 'DistinctiveSupplied');
    const fresh = w.run(['report', '--output', 'demo-fresh', '--target', 'node', '--demo', '--json']);
    assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
    assert.equal(summary(fresh).mode, 'demo'); assert.equal(summary(fresh).source, 'fresh');
  } finally { w.cleanup(); }
});

test('aih report prints a readable summary without --json and still writes both files', () => {
  const w = workspace();
  try {
    const result = w.run(['report', '--output', 'plain', '--target', 'node']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(summary(result).status, 'complete');
    assert.equal(existsSync(join(w.cwd, 'plain', 'report.html')), true);
  } finally { w.cleanup(); }
});

test('aih report never overwrites or merges into an existing path and needs an existing parent', () => {
  const w = workspace();
  try {
    mkdirSync(join(w.cwd, 'taken')); writeFileSync(join(w.cwd, 'taken', 'report.json'), 'precious');
    rejected(w.run(['report', '--output', 'taken', '--target', 'node', '--json']), 'output-exists');
    assert.equal(readFileSync(join(w.cwd, 'taken', 'report.json'), 'utf8'), 'precious');
    assert.deepEqual(readdirSync(join(w.cwd, 'taken')), ['report.json']);
    writeFileSync(join(w.cwd, 'file'), 'x');
    rejected(w.run(['report', '--output', 'file', '--target', 'node', '--json']), 'output-exists');
    rejected(w.run(['report', '--output', join('missing', 'parent', 'out'), '--target', 'node', '--json']), 'output-unavailable');
    assert.equal(existsSync(join(w.cwd, 'missing')), false);
    try {
      symlinkSync(join(w.cwd, 'nowhere'), join(w.cwd, 'dangling'), 'dir');
      rejected(w.run(['report', '--output', 'dangling', '--target', 'node', '--json']), 'output-exists');
      assert.equal(existsSync(join(w.cwd, 'nowhere')), false);
    } catch (error) { if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error; }
  } finally { w.cleanup(); }
});

test('aih report rejects option misuse before acquiring or writing anything', () => {
  const w = workspace();
  try {
    const out = join(w.cwd, 'out');
    const file = writeSnapshot(w, () => {});
    const cases = [
      [['report', '--json'], 'cli-options'],
      [['report', '--output', out, '--snapshot', file, '--target', 'node', '--json'], 'cli-options'],
      [['report', '--output', out, '--snapshot', file, '--offline', '--json'], 'cli-options'],
      [['report', 'extra', '--output', out, '--json'], 'cli-options'],
      [['report', '--output', out, '--target', 'unknown-tool', '--json'], 'request-invalid'],
      [['report', '--output', out, '--target', 'node', '--target', 'node', '--json'], 'request-invalid'],
      [['report', '--output', out, '--project', w.cwd, '--json'], 'cli-options'],
      [['report', '--output', out, '--apply', '--json'], 'cli-options'],
      [['report', '--output', out, '--yes', '--json'], 'cli-options'],
      [['report', '--output', out, '--allow-partial', '--json'], 'cli-options'],
      [['report', '--output', out, '--evidence', '--json'], 'cli-options'],
      [['report', '--output', out, '--probe-configured-mcp', '--json'], 'cli-options'],
      [['report', '--output', out, '--inputs-file', file, '--json'], 'cli-options'],
      [['report', '--output', out, '--resolutions', file, '--json'], 'cli-options'],
      [['report', '--output', out, '--private-input', 'a.b=X', '--json'], 'cli-options'],
      [['report', '--output', out, '--material-root', `a=${w.cwd}`, '--json'], 'cli-options'],
      [['report', '--output', out, '--org-repository', 'a/b', '--json'], 'cli-options'],
      [['report', '--output', out, '--no-such-flag', '--json'], 'cli-input'],
      [['report', '--output', '--json'], 'cli-input']
    ];
    for (const [args, reason] of cases) {
      const result = w.run(args);
      assert.equal(result.status, 2, `${args.join(' ')}\n${result.stdout}${result.stderr}`);
      assert.equal(summary(result).diagnostics[0].reason, reason, args.join(' '));
      assert.equal(existsSync(out), false, args.join(' '));
    }
  } finally { w.cleanup(); }
});

test('aih report bounds, types and validates a supplied snapshot before any output exists', () => {
  const w = workspace();
  try {
    const out = join(w.cwd, 'out');
    const seed = writeSnapshot(w, () => {});
    const good = readFileSync(seed, 'utf8');
    const attempt = (name, bytes, reason = 'snapshot-invalid') => {
      const file = join(w.cwd, name); writeFileSync(file, bytes);
      rejected(w.run(['report', '--output', out, '--snapshot', file, '--json']), reason);
      assert.equal(existsSync(out), false, name);
    };
    attempt('oversize.json', Buffer.alloc(1_000_001, 0x20), 'snapshot-unreadable');
    attempt('bad-utf8.json', Buffer.concat([Buffer.from(good.slice(0, 20)), Buffer.from([0xff, 0xfe]), Buffer.from(good.slice(20))]));
    attempt('malformed.json', '{bad');
    attempt('array.json', '[]');
    attempt('empty.json', '');
    const unsupported = JSON.parse(good); unsupported.schema = 'urn:aihq:report:snapshot:9.0.0';
    attempt('unsupported.json', JSON.stringify(unsupported), 'snapshot-unsupported');
    const unknown = JSON.parse(good); unknown.extra = true;
    attempt('unknown-field.json', JSON.stringify(unknown));
    const inconsistent = JSON.parse(good); inconsistent.metrics.counts.passed += 5;
    attempt('inconsistent.json', JSON.stringify(inconsistent));
  } finally { w.cleanup(); }
});

test('aih report refuses a snapshot path that is missing, a directory or a link', () => {
  const w = workspace();
  try {
    const out = join(w.cwd, 'out');
    rejected(w.run(['report', '--output', out, '--snapshot', join(w.cwd, 'absent.json'), '--json']), 'snapshot-unreadable');
    mkdirSync(join(w.cwd, 'directory.json'));
    rejected(w.run(['report', '--output', out, '--snapshot', join(w.cwd, 'directory.json'), '--json']), 'snapshot-unreadable');
    const seed = writeSnapshot(w, () => {});
    try {
      symlinkSync(seed, join(w.cwd, 'link.json'), 'file');
      rejected(w.run(['report', '--output', out, '--snapshot', join(w.cwd, 'link.json'), '--json']), 'snapshot-unreadable');
    } catch (error) { if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error; }
    assert.equal(existsSync(out), false);
  } finally { w.cleanup(); }
});

test('aih report accepts an exact 1 MB supplied snapshot', () => {
  const w = workspace();
  try {
    const seed = writeSnapshot(w, () => {});
    const good = readFileSync(seed, 'utf8');
    writeFileSync(seed, good + ' '.repeat(1_000_000 - Buffer.byteLength(good)));
    const result = w.run(['report', '--output', 'boundary', '--snapshot', seed, '--json']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { w.cleanup(); }
});

test('existing commands reject report-only options', () => {
  const w = workspace();
  try {
    const file = join(w.cwd, 'x.json'); writeFileSync(file, '{}');
    for (const flags of [['--output', 'out'], ['--snapshot', file], ['--demo']]) {
      for (const args of [['inspect', ...flags], ['repair', 'node-npm-ca', '--target', 'node', '--inputs-file', file, ...flags],
        ['policy', file, ...flags], ['managed', 'list', ...flags],
        ['managed', 'remove', 'team-guidance', '--scope', 'project', '--mode', 'vibe', ...flags],
        ['managed', 'help', ...flags]]) {
        const result = w.run([...args, '--json']);
        assert.equal(result.status, 2, `${args.join(' ')}\n${result.stdout}${result.stderr}`);
        assert.equal(summary(result).status, 'invalid');
        assert.equal(existsSync(join(w.cwd, 'out')), false);
      }
    }
    // The ordinary inspect command is intact.
    const ok = w.run(['inspect', '--target', 'node', '--offline', '--json']);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.equal(summary(ok).status, 'complete');
  } finally { w.cleanup(); }
});

test('help documents the report command and its modes', () => {
  const w = workspace();
  try {
    const help = w.run(['--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /aih report --output <new-directory>/);
    assert.match(help.stdout, /--snapshot <report\.json>/);
    assert.match(help.stdout, /--demo/);
    assert.match(help.stdout, /aih inspect/);
    assert.match(help.stdout, /aih managed <list\|remove>/);
    for (const args of [['help', 'report'], ['report', '--help'], ['help', 'managed', 'list'], ['managed', 'remove', '--help']]) {
      const topic = w.run(args);
      assert.equal(topic.status, 0, topic.stdout + topic.stderr);
      assert.match(topic.stdout, /Examples:/);
    }
  } finally { w.cleanup(); }
});

test('report diagnostics leave no output directory when cancelled', async () => {
  const w = workspace();
  try {
    const { runReportCommand } = await import(pathToFileURL(fileURLToPath(new URL('../../dist/harness/report-command.mjs', import.meta.url))).href);
    const controller = new AbortController(); controller.abort();
    const out = join(w.cwd, 'cancelled');
    await assert.rejects(runReportCommand({ output: out, targets: ['node'] }, { signal: controller.signal }),
      error => error.code === 'CANCELLED' && error.reason === 'cancelled');
    assert.equal(existsSync(out), false);
  } finally { w.cleanup(); }
});
