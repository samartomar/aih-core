import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { createReport, exportSnapshot } from '@aihq/core/report';
import { renderReport } from '@aihq/core/report/render';

const root = fileURLToPath(new URL('../..', import.meta.url));

const SECTION_IDS = [
  'sec-hero', 'sec-ready', 'sec-actions', 'sec-wins', 'sec-context', 'sec-activity', 'sec-quality',
  'sec-drift', 'sec-mcp', 'sec-adoption', 'sec-support', 'sec-period', 'sec-skills', 'sec-skillgov'
];

// Local fixture shaped like the documented ReportSnapshot. It exercises presentation only; it is not
// evidence of the producer-to-report workflow.
function fixture(overrides = {}) {
  const checks = overrides.checks ?? [
    { id: 'node-present', target: 'node', outcome: 'passed', reason: 'binary-found', detail: 'node responded to a version probe' },
    { id: 'npm-registry', target: 'npm', outcome: 'failed', reason: 'tls-untrusted', detail: 'registry certificate chain was not trusted' },
    { id: 'pip-index', target: 'pip', outcome: 'unavailable', reason: 'deadline', detail: 'probe budget ended before pip answered' },
    { id: 'kiro-origin', target: 'kiro', outcome: 'skipped', reason: 'unselected', detail: 'tool was not selected' }
  ];
  const counts = { passed: 0, failed: 0, unavailable: 0, skipped: 0 };
  for (const check of checks) counts[check.outcome] += 1;
  return {
    schema: 'urn:aihq:report:snapshot:1.0.0',
    compatibility: 'experimental',
    producer: { name: '@aihq/core', version: '1.0.0-dev.3', revision: '5b70f8e698a4ec1e346b9718ef0067b2c856a1c6', contract: 'urn:aihq:harness:diagnostic:1.0.0' },
    capture: { observedAt: '2026-10-03T12:00:00.000Z', acquisition: 'supplied' },
    evidence: { originalSha256: null, authentication: 'not-authenticated', structuralValidation: 'passed', projection: 'redacted' },
    status: 'completed',
    tools: [
      { id: 'node', label: 'Node.js', state: 'runnable', selection: 'detected' },
      { id: 'npm', label: 'npm', state: 'binary', selection: 'requested' },
      { id: 'claude', label: 'Claude Code', state: 'config-only', selection: 'detected', config: '.claude' },
      { id: 'cargo', label: 'Cargo', state: 'broken', selection: 'requested' },
      { id: 'kiro', label: 'Kiro', state: 'absent', selection: 'unselected' }
    ],
    observations: [{ id: 'node-extra-ca', target: 'node', detail: 'NODE_EXTRA_CA_CERTS is configured' }],
    diagnostics: [],
    metrics: { budgetMs: 5000, elapsedMs: 120, maxActiveProbes: 2, counts },
    ...overrides,
    checks
  };
}

test('generated template module reproduces byte-for-byte from the authored HTML', () => {
  const run = spawnSync(process.execPath, ['scripts/generate-report-template.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

const UNSUPPORTED_SECTIONS = [
  'sec-wins', 'sec-context', 'sec-activity', 'sec-quality', 'sec-drift', 'sec-mcp', 'sec-period', 'sec-skills', 'sec-skillgov'
];

// Values and wording baked into the V9 design sample. None of them may reach a normal report.
const DEMO_RESIDUE = [
  '1,204', 'RULE_ROUTER', 'context7', 'gitleaks', 'Certificate trust chain', 'claude 62%', 'feat/x', 'v9 draft',
  'Enterprise AI Bootstrapping', 'aih bootstrap-ai', 'aih heal', 'aih workspace add', 'aih usage', 'aih scaffold',
  '[100,100,88,40,82]', '+4 vs last run', 'Wired and healthy', 'Showcases what aih unblocked', 'aih-skills.lock.json'
];

function sectionOf(html, id) {
  const open = html.indexOf(`id="${id}"`);
  assert.notEqual(open, -1, `${id} present`);
  return html.slice(html.lastIndexOf('<section', open), html.indexOf('</section>', open));
}

test('a normal report carries no V9 demo residue and marks unsupported panels EMPTY', () => {
  const html = renderReport(fixture());
  for (const token of DEMO_RESIDUE) assert.ok(!html.includes(token), `demo residue "${token}" leaked`);
  const markup = html.slice(html.indexOf('<body')).replace(/<script>[\s\S]*?<\/script>/g, '');
  assert.doesNotMatch(markup, /^<body[^>]*data-demo/);
  assert.doesNotMatch(markup, /class="[^"]*\bpreview\b/);
  for (const id of UNSUPPORTED_SECTIONS) {
    const section = sectionOf(html, id);
    assert.match(section, /data-state="empty"/, `${id} is explicitly EMPTY`);
    assert.match(section, />EMPTY</, `${id} shows an EMPTY label`);
    const text = section.replace(/<span class="sec-no">[^<]*<\/span>/, '').replace(/<[^>]*>/g, ' ');
    assert.doesNotMatch(text, /\d/, `${id} shows no invented measurement`);
  }
});

test('renderReport returns one self-contained offline document with all fourteen V9 sections', () => {
  const html = renderReport(fixture());
  assert.match(html, /^<!doctype html>/i);
  for (const id of SECTION_IDS) assert.equal(html.split(`id="${id}"`).length, 2, `${id} appears exactly once`);
  assert.doesNotMatch(html, /<link\b/i);
  assert.doesNotMatch(html, /\b(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i);
  assert.doesNotMatch(html, /url\(\s*["']?(?:https?:)?\/\//i);
  assert.doesNotMatch(html, /@import/i);
});

const textOf = (markup) => markup.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

test('readiness and actions are bound to supplied checks and tool states without any score', () => {
  const html = renderReport(fixture());
  const ready = sectionOf(html, 'sec-ready');
  assert.match(ready, /data-state="live"/);
  const readyText = textOf(ready);
  assert.match(readyText, /registry certificate chain was not trusted/);
  assert.match(readyText, /probe budget ended before pip answered/);
  assert.match(readyText, /FAILED CHECKS/);
  assert.doesNotMatch(readyText, /\/\s?100|\bREADY\b/);

  const actions = textOf(sectionOf(html, 'sec-actions'));
  assert.match(actions, /npm.*registry certificate chain was not trusted/);
  assert.match(actions, /Cargo.*broken/i);
  assert.match(actions, /pip.*could not be evaluated/i);
  assert.match(actions, /\bhigh\b/);
  assert.match(actions, /\bmed\b/);
  assert.doesNotMatch(actions, /\baih [a-z-]+/, 'no legacy command is offered');
});

// Static document: scripts do not run, so this is exactly what a no-JavaScript reader sees.
function parse(html) {
  const window = new Window({ settings: { disableJavaScriptEvaluation: true } });
  window.document.write(html);
  return window.document;
}

// Hydrated document: inline scripts run, as in a browser.
// Inline scripts run synchronously while the document is written. The page's clock timer would keep the
// process alive, so every window is closed when the suite ends.
const openWindows = [];
after(() => { for (const window of openWindows) window.happyDOM.close(); });
function load(html) {
  const window = new Window({ settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
  openWindows.push(window);
  window.document.write(html);
  return window;
}

const textIn = (document, selector) => [...document.querySelectorAll(selector)].map((el) => el.textContent.trim());

test('tool states keep their evidence scope and observations are shown as observed, not verified', () => {
  const document = parse(renderReport(fixture()));
  assert.deepEqual(textIn(document, '#sec-adoption [data-tool-state="runnable"]'), ['Node.js']);
  assert.deepEqual(textIn(document, '#sec-adoption [data-tool-state="binary"]'), ['npm']);
  assert.deepEqual(textIn(document, '#sec-adoption [data-tool-state="config-only"]'), ['Claude Code']);
  assert.deepEqual(textIn(document, '#sec-adoption [data-tool-state="broken"]'), ['Cargo']);
  assert.deepEqual(textIn(document, '#sec-adoption [data-tool-state="absent"]'), ['Kiro']);
  const adoption = textOf(document.getElementById('sec-adoption').innerHTML);
  assert.match(adoption, /config only — not verified/i);
  assert.match(adoption, /binary found — not run/i);
  assert.match(adoption, /NODE_EXTRA_CA_CERTS is configured/);
  assert.match(adoption, /observed, not verified/i);
  assert.deepEqual(textIn(document, '#sec-adoption [data-check-outcome="failed"]'), ['npm-registry']);
  assert.deepEqual(textIn(document, '#sec-adoption [data-check-outcome="passed"]'), ['node-present']);
});

test('the support summary is a copy-ready draft built only from supplied findings', () => {
  const document = parse(renderReport(fixture()));
  const ticket = document.querySelector('#sec-support pre.ticket').textContent;
  assert.match(ticket, /^Subject: Diagnostic findings — 1 failed, 1 unavailable, 1 skipped/);
  assert.match(ticket, /- \[failed\] npm \(npm-registry\): tls-untrusted — registry certificate chain was not trusted/);
  assert.match(ticket, /- \[unavailable\] pip \(pip-index\): deadline — probe budget ended before pip answered/);
  assert.match(ticket, /Source: @aihq\/core 1\.0\.0-dev\.3 \(5b70f8e698a4ec1e346b9718ef0067b2c856a1c6\)/);
  assert.match(ticket, /Captured: 2026-10-03T12:00:00\.000Z \(supplied snapshot\)/);
  assert.match(ticket, /not verification/i);
  assert.doesNotMatch(ticket, /\baih [a-z-]+/);
});

test('the hero reports supplied counts without a score and keeps not-evaluated distinct from zero', () => {
  const completed = parse(renderReport(fixture({ checks: [{ id: 'node-present', target: 'node', outcome: 'passed', reason: 'binary-found', detail: 'node responded' }] })));
  const vitals = Object.fromEntries([...completed.querySelectorAll('#sec-hero .vital')].map((el) => [el.querySelector('.l').textContent, el.querySelector('.v').textContent]));
  assert.deepEqual(vitals, { Passed: '1', Failed: '0', Unavailable: '0', Skipped: '0' });
  assert.doesNotMatch(completed.getElementById('sec-hero').innerHTML, /hero-score|\/\s?100/);
  assert.match(textOf(completed.getElementById('sec-hero').innerHTML), /1 check passed/);

  const unavailable = parse(renderReport(fixture({ status: 'unavailable', checks: [], tools: [], observations: [] })));
  const hero = unavailable.getElementById('sec-hero');
  assert.deepEqual([...hero.querySelectorAll('.vital .v')].map((el) => el.textContent), ['n/a', 'n/a', 'n/a', 'n/a']);
  assert.match(textOf(hero.innerHTML), /Diagnostic unavailable/);
  assert.match(textOf(unavailable.getElementById('sec-ready').innerHTML), /NOT EVALUATED/);
});

test('provenance keeps capture label, original evidence identity, structural validation and authentication separate', () => {
  const sha = 'a'.repeat(64);
  const supplied = parse(renderReport(fixture({ evidence: { originalSha256: sha, authentication: 'not-authenticated', structuralValidation: 'passed', projection: 'redacted' } })));
  const facts = Object.fromEntries([...supplied.querySelectorAll('#sec-ready dl.kv')].flatMap((dl) => [...dl.querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling.textContent])));
  assert.match(facts['Original evidence SHA-256'], new RegExp(`^${sha}`));
  assert.match(facts['Original evidence SHA-256'], /raw bytes.*not recomputed/i);
  assert.match(facts.Authentication, /^not authenticated/);
  assert.match(facts['Structural validation'], /^passed.*shape only/i);
  assert.match(facts.Projection, /^redacted/);
  assert.match(facts.Capture, /^supplied snapshot.*not re-collect/i);
  assert.match(facts['Probe limits'], /budget 5000 ms.*elapsed 120 ms.*max active probes 2/);
  assert.match(textIn(supplied, '.whatsnew')[0], /Supplied snapshot/);

  const acquired = parse(renderReport(fixture({ capture: { observedAt: '2026-10-03T12:00:00.000Z', acquisition: 'newly-acquired' } })));
  const banner = textIn(acquired, '.whatsnew')[0];
  assert.match(banner, /Newly acquired/);
  assert.match(banner, /as labelled by the caller/i);
  assert.doesNotMatch(banner, /\bfresh\b|\bverified\b|\battested\b/i);
  const noSha = Object.fromEntries([...acquired.querySelectorAll('#sec-ready dl.kv dt')].map((dt) => [dt.textContent, dt.nextElementSibling.textContent]));
  assert.match(noSha['Original evidence SHA-256'], /^not supplied/);
});

const HOSTILE = {
  image: '<img src=x onerror="window.pwned=1">',
  breakout: '"><script>window.pwned=2</script>',
  endScript: '</script><script>window.pwned=3</script>',
  separators: `line${String.fromCharCode(0x2028)}break${String.fromCharCode(0x2029)}end`
};

test('supplied text is escaped in markup and in the embedded script data', async () => {
  const hostile = fixture({
    checks: [{ id: 'c1', target: HOSTILE.image, outcome: 'failed', reason: HOSTILE.breakout, detail: HOSTILE.endScript }],
    tools: [{ id: 't1', label: HOSTILE.image, state: 'config-only', selection: 'detected', config: HOSTILE.breakout }],
    observations: [{ id: 'o1', target: HOSTILE.endScript, detail: HOSTILE.separators }]
  });
  const html = renderReport(hostile, { title: '<b>"report"</b> & more' });
  const baseline = renderReport(fixture());

  const scripts = (markup) => markup.match(/<script\b/gi).length;
  assert.equal(scripts(html), scripts(baseline), 'no script element is introduced by supplied text');
  assert.equal(html.match(/<img\b/gi), null);
  assert.match(html, /<title>&lt;b&gt;&quot;report&quot;&lt;\/b&gt; &amp; more<\/title>/);

  const data = html.match(/window\.AIH_DATA=(.*);\n/)[1];
  assert.doesNotMatch(data, /[<>&]/, 'script data has no raw markup characters');
  assert.ok(!data.includes(String.fromCharCode(0x2028)) && !data.includes(String.fromCharCode(0x2029)));
  const payload = JSON.parse(data);
  assert.match(payload.sections['sec-ready'].html, /&lt;img src=x onerror=&quot;window\.pwned=1&quot;&gt;/);

  const window = load(html);
  assert.equal(window.pwned, undefined, 'no supplied text executed');
  assert.ok(textIn(window.document, '#sec-ready .fn')[0].includes(HOSTILE.image), 'text is shown literally');
  assert.equal(window.document.querySelectorAll('main img').length, 0);
});

test('hydration reproduces the static sections from the same data and navigation reaches every section', () => {
  const html = renderReport(fixture());
  const staticDocument = parse(html);
  const hydrated = load(html);
  for (const id of SECTION_IDS) {
    assert.equal(hydrated.document.getElementById(id).innerHTML, staticDocument.getElementById(id).innerHTML, `${id} matches`);
    assert.equal(hydrated.document.getElementById(id).getAttribute('data-state'), staticDocument.getElementById(id).getAttribute('data-state'));
  }

  // Hydration applies the embedded values rather than trusting the static markup.
  const stale = html.replace(/(<section class="section" id="sec-ready"[^>]*>)[\s\S]*?<\/section>/, '$1<p>stale</p></section>');
  assert.match(parse(stale).getElementById('sec-ready').innerHTML, /stale/);
  assert.equal(load(stale).document.getElementById('sec-ready').innerHTML, staticDocument.getElementById('sec-ready').innerHTML);

  hydrated.document.dispatchEvent(new hydrated.KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
  const targets = [...hydrated.document.querySelectorAll('#palette-list .palette-item')].map((item) => /jumpP\('([^']+)'\)/.exec(item.getAttribute('onclick'))[1]);
  assert.deepEqual([...targets].sort(), [...SECTION_IDS].sort());
  for (const id of targets) assert.ok(hydrated.document.getElementById(id), `${id} exists`);
});

test('every diagnostic outcome is described without claiming readiness', () => {
  const passed = { id: 'node-present', target: 'node', outcome: 'passed', reason: 'binary-found', detail: 'node responded' };
  const allPassed = parse(renderReport(fixture({ checks: [passed], tools: [], observations: [] })));
  assert.match(textOf(allPassed.getElementById('sec-ready').innerHTML), /NO FAILED CHECKS.*not proof of readiness|covers only the probes that ran/i);
  assert.match(textOf(allPassed.getElementById('sec-actions').innerHTML), /Nothing to review/);
  assert.match(textOf(allPassed.getElementById('sec-support').innerHTML), /No findings to hand over/);

  const none = parse(renderReport(fixture({ checks: [], tools: [], observations: [] })));
  assert.match(textOf(none.getElementById('sec-ready').innerHTML), /NO CHECKS REPORTED/);
  assert.deepEqual([...none.querySelectorAll('#sec-hero .vital .v')].map((el) => el.textContent), ['0', '0', '0', '0'], 'a completed run with no checks is a measured zero');

  for (const status of ['cancelled', 'invalid', 'unavailable']) {
    const diagnostics = [{ code: 'STATE_CONFLICT', reason: 'probe-limit', message: 'the probe budget ended early' }];
    const document = parse(renderReport(fixture({ status, checks: [], tools: [], observations: [], diagnostics })));
    assert.match(textOf(document.getElementById('sec-ready').innerHTML), new RegExp(`NOT EVALUATED.*${status}`), status);
    assert.match(textOf(document.getElementById('sec-hero').innerHTML), new RegExp(`Diagnostic ${status}`), status);
    assert.match(textOf(document.getElementById('sec-actions').innerHTML), /STATE_CONFLICT.*the probe budget ended early/, status);
    assert.match(document.querySelector('#sec-support pre.ticket').textContent, /Status: /);
  }
});

test('identical explicit inputs give identical bytes and the input is never modified', () => {
  const input = structuredClone(fixture());
  const before = JSON.stringify(input);
  const first = renderReport(input, { title: 'Workstation check' });
  assert.equal(renderReport(structuredClone(input), { title: 'Workstation check' }), first);
  assert.equal(JSON.stringify(input), before);
  assert.notEqual(renderReport(input), first, 'the title is part of the output');
  assert.equal(renderReport(input, { mode: 'demo' }), renderReport(structuredClone(input), { mode: 'demo' }));
  const RealDate = globalThis.Date;
  globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [0])); } static now() { return 0; } };
  try { assert.equal(renderReport(input, { title: 'Workstation check' }), first, 'the render-time clock does not affect output'); } finally { globalThis.Date = RealDate; }
});

test('invalid snapshots and options are rejected rather than rendered', () => {
  const inputCode = (error) => ['INPUT_INVALID', 'SCHEMA_UNSUPPORTED'].includes(error.code);
  assert.throws(() => renderReport(null), inputCode);
  assert.throws(() => renderReport({ ...fixture(), status: 'exploded' }), inputCode);
  assert.throws(() => renderReport({ ...fixture(), schema: 'urn:aihq:report:snapshot:9.0.0' }), inputCode);
  assert.throws(() => renderReport(fixture(), { mode: 'live' }), TypeError);
  assert.throws(() => renderReport(fixture(), { title: 42 }), TypeError);
  assert.throws(() => renderReport(fixture(), { title: 'x'.repeat(201) }), TypeError);
  assert.throws(() => renderReport(fixture(), null), TypeError);
  assert.throws(() => renderReport({ ...fixture(), status: 'exploded' }, { mode: 'demo' }), inputCode, 'demo mode validates too');
});

test('sensitive values removed by the data module stay out of the rendered report', () => {
  const secret = 'hunter2-not-a-real-secret';
  const home = 'C:\\Users\\someone';
  const diagnostic = {
    requestId: 'req-1', helper: { name: 'harness-diagnose', version: '1.0.0' }, status: 'completed',
    tools: [{ id: 'node', label: 'Node.js', state: 'runnable', selection: 'detected' }],
    observations: [{ id: 'o1', target: 'node', detail: `config at ${home}\\.npmrc` }],
    checks: [{ id: 'c1', target: 'npm', outcome: 'failed', reason: 'auth', detail: `token ${secret} was rejected` }],
    diagnostics: [], repairChoices: [], limits: { budgetMs: 5000, elapsedMs: 10, maxActiveProbes: 1 }
  };
  const snapshot = createReport({
    diagnostic, producer: { name: '@aihq/core', version: '1.0.0-dev.3', revision: '5b70f8e698a4ec1e346b9718ef0067b2c856a1c6' },
    observedAt: '2026-10-03T12:00:00.000Z', acquisition: 'supplied', redaction: { homePaths: [home], secretValues: [secret] }
  });
  assert.ok(!exportSnapshot(snapshot).includes(secret));
  const html = renderReport(snapshot);
  assert.ok(!html.includes(secret), 'secret absent from HTML and embedded data');
  assert.ok(!html.toLowerCase().includes('someone'), 'home path absent from HTML and embedded data');
});

test('demo mode is prominently labelled, renders only design-sample values and never the snapshot', () => {
  const html = renderReport(fixture(), { mode: 'demo' });
  const document = parse(html);
  assert.equal(document.body.getAttribute('data-demo'), 'on');
  const banner = textIn(document, '.demo-banner')[0];
  assert.match(banner, /DEMO/);
  assert.match(banner, /invented for illustration/i);
  assert.match(banner, /not supported Core commands/i);
  for (const id of SECTION_IDS) assert.ok(document.getElementById(id), `${id} present`);
  assert.ok(document.querySelectorAll('main .card.preview').length > 0, 'PREVIEW panels stay marked');
  assert.match(document.getElementById('sec-actions').textContent, /Wire guardrails/, 'design sample content is present');
  assert.doesNotMatch(html, /registry certificate chain was not trusted|node-extra-ca|LIVE · /);
  assert.doesNotMatch(html, /"mode":"report"/);

  const report = renderReport(fixture());
  assert.doesNotMatch(report.slice(report.indexOf('<body')), /demo-banner"|DEMO —|data-demo="on"/);

  const hydrated = load(html);
  assert.ok(hydrated.document.getElementById('radar').childNodes.length > 0, 'the sample radar is drawn only in demo mode');
  assert.equal(load(report).document.getElementById('radar'), null, 'a normal report has no radar');
});
