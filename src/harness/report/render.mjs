import { exportSnapshot, importSnapshot } from './data.mjs';
import { TEMPLATE } from './template.mjs';

const DEFAULT_TITLE = 'AIH report';

const TITLE_ANCHOR = '<title>AIH report — developer console (V9)</title>';
const BRAND_ANCHOR = '<span id="brand-title">AIH report</span>';
const BANNER_ANCHOR = '<!--aih:banner-->';
const RADAR_ANCHOR = 'var RADAR={"labels":["Layering","Sharing","Wiring","Guardrails","Discover"],"values":[100,100,88,40,82]};';
const NO_RADAR = 'var RADAR={"labels":[],"values":[]};';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);

// Safe inside an inline <script>: no tag, entity or line-terminator can end the literal.
const SCRIPT_UNSAFE = new RegExp(`[<>&${String.fromCharCode(0x2028, 0x2029)}]`, 'g');
const scriptJson = (value) => JSON.stringify(value).replace(SCRIPT_UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

function replaceOnce(haystack, needle, replacement) {
  const at = haystack.indexOf(needle);
  if (at === -1) throw new Error(`report template anchor not found: ${needle.slice(0, 48)}`);
  return haystack.slice(0, at) + replacement + haystack.slice(at + needle.length);
}

// Replace the inner HTML of one <section id="..."> (sections never nest in the shell).
function replaceSection(html, id, state, inner) {
  const idAt = html.indexOf(`id="${id}"`);
  if (idAt === -1) throw new Error(`report template section not found: ${id}`);
  const tagEnd = html.indexOf('>', idAt) + 1;
  const end = html.indexOf('</section>', tagEnd);
  const tag = html.slice(html.lastIndexOf('<section', idAt), tagEnd - 1);
  return html.slice(0, html.lastIndexOf('<section', idAt)) + `${tag} data-state="${state}">${inner}` + html.slice(end);
}

const STATE_BADGE = {
  live: (label) => `<span class="badge ok">LIVE · ${esc(label)}</span>`,
  empty: () => '<span class="badge muted">EMPTY</span>'
};

function head(no, state, stateLabel, title, insight, count) {
  return `<div class="sec-head"><div class="sec-eyebrow"><span class="sec-no">${no}</span>${STATE_BADGE[state](stateLabel)}<span class="sec-rule"></span><span class="sec-count">${esc(count)}</span></div><h2 class="sec-title">${esc(title)}</h2><p class="sec-insight">${insight}</p></div>`;
}

function emptyPanel(no, title, insight, cardTitle, reason) {
  return head(no, 'empty', '', title, insight, 'unavailable')
    + `<div class="grid"><div class="card span-12 empty-card"><div class="card-head"><h3>${esc(cardTitle)}</h3>${STATE_BADGE.empty()}</div><div class="card-body"><div class="method">${reason}</div></div></div></div>`;
}

const EMPTY_PANELS = {
  'sec-hero': ['◆', 'Diagnostic summary — unavailable', 'No summary values are supplied.', 'Summary', 'No diagnostic outcome is available to summarize.'],
  'sec-ready': ['◆', 'Developer readiness — unavailable', 'No diagnostic outcome is supplied.', 'Readiness', 'No diagnostic outcome is available.'],
  'sec-actions': ['★', 'Items to review — unavailable', 'No diagnostic outcome is supplied.', 'Items to review', 'No diagnostic outcome is available.'],
  'sec-wins': ['✓', 'Remediation ledger — unavailable', 'A single diagnostic snapshot carries no remediation history, so no fixed blockers or run counts are shown.', 'Remediation ledger', 'No remediation history is supplied by the diagnostic.'],
  'sec-context': ['01', 'Per-turn context — unavailable', 'The diagnostic supplies no context or token measurement, so no budget or headroom is shown.', 'Per-turn context', 'No context-size or token measurement is supplied.'],
  'sec-activity': ['02', 'Activity — unavailable', 'No repository history or usage counters are supplied. A missing measurement is never shown as zero.', 'Activity and usage', 'No repository history or usage counters are supplied.'],
  'sec-quality': ['03', 'Guardrails and test ratio — unavailable', 'The diagnostic does not inspect guardrail enforcement or test files.', 'Guardrails and test ratio', 'No guardrail-enforcement or test-ratio observations are supplied.'],
  'sec-drift': ['04', 'Drift and coherence — unavailable', 'The diagnostic does not compare managed files or client configurations.', 'Drift and coherence', 'No drift or cross-client coherence observations are supplied.'],
  'sec-mcp': ['05', 'MCP plumbing — unavailable', 'MCP configuration, discovery and tool execution are not observed by this diagnostic.', 'MCP plumbing', 'No MCP observations are supplied. Client tool states in Setup + tooling are binary and configuration observations only.'],
  'sec-adoption': ['06', 'Setup and tooling — unavailable', 'No tool states or checks are supplied.', 'Setup and tooling', 'No tool states or checks are available.'],
  'sec-support': ['07', 'Support summary — unavailable', 'No diagnostic outcome is supplied.', 'Support summary', 'No diagnostic outcome is available.'],
  'sec-period': ['08', 'Trends — unavailable', 'A single snapshot has no history, so no trend or outcome delta is shown.', 'Trends and outcome deltas', 'No time series or outcome measurements are supplied.'],
  'sec-skills': ['09', 'Skill ledger — unavailable', 'No skill inventory or invocation counts are supplied.', 'Skill ledger', 'No skill inventory or invocation counts are supplied.'],
  'sec-skillgov': ['10', 'Skill governance — unavailable', 'No skill approvals, quarantine or scanner evidence are supplied.', 'Skill governance', 'No skill governance observations are supplied.']
};

const BANNER_LEAD = {
  supplied: 'Supplied snapshot — not re-collected',
  'newly-acquired': 'Newly acquired at original capture, as labelled by the caller'
};

// Capture metadata is the caller's supplied provenance. Importing or rendering never implies freshness.
function reportBanner(snapshot) {
  const { capture, producer } = snapshot;
  return `<div class="whatsnew"><span class="tag">SNAPSHOT</span><span><b>Saved snapshot display — ${esc(BANNER_LEAD[capture.acquisition] ?? BANNER_LEAD.supplied)}</b><span class="sep">·</span>original capture ${esc(capture.observedAt)}<span class="sep">·</span>${esc(producer.name)} ${esc(producer.version)}<span class="sep">·</span><span class="muted">rendering never collects data</span></span></div>`;
}

const ICON_ALERT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>';
const ICON_NOTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>';
const ICON_CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const ACQUISITION_LABEL = { supplied: 'supplied snapshot', 'newly-acquired': 'caller-labelled newly acquired' };

// Private view-model: the supplied observations grouped for presentation. No value is derived that the
// snapshot does not already state; in particular there is no score.
function model(snapshot) {
  const checksBy = (outcome) => snapshot.checks.filter((check) => check.outcome === outcome);
  return {
    snapshot,
    acquisition: ACQUISITION_LABEL[snapshot.capture.acquisition] ?? 'supplied snapshot',
    passed: checksBy('passed'),
    failed: checksBy('failed'),
    unavailable: checksBy('unavailable'),
    skipped: checksBy('skipped')
  };
}

function verdict(m) {
  const { status } = m.snapshot;
  if (status !== 'completed') return { cls: 'warn', label: 'NOT EVALUATED', sub: `the diagnostic status is ${status}`, title: `Diagnostic ${status} — nothing was evaluated` };
  if (m.failed.length) return { cls: 'bad', label: 'FAILED CHECKS', sub: `${plural(m.failed.length, 'check')} failed in the supplied diagnostic`, title: `${plural(m.failed.length, 'failed check')} need attention` };
  const gaps = m.unavailable.length + m.skipped.length;
  if (gaps) return { cls: 'warn', label: 'UNVERIFIED GAPS', sub: `no check failed; ${plural(gaps, 'check')} could not be evaluated or ${gaps === 1 ? 'was' : 'were'} skipped`, title: `No failed checks — ${plural(gaps, 'check')} not evaluated` };
  if (m.passed.length) return { cls: 'ok', label: 'NO FAILED CHECKS', sub: 'every reported check passed; that covers only the probes that ran', title: `No failed checks — ${plural(m.passed.length, 'check')} passed` };
  return { cls: 'warn', label: 'NO CHECKS REPORTED', sub: 'the diagnostic reported no checks', title: 'No checks were reported' };
}

const OUTCOME_CLASS = { failed: 'bad', unavailable: 'warn', skipped: 'muted', passed: 'ok' };

function checkRow(check) {
  const cls = OUTCOME_CLASS[check.outcome];
  return `<div class="drift-file wrap"><span class="fd" style="background:var(--${cls === 'muted' ? 'dim' : cls})"></span><span class="fn"><b>${esc(check.target)}</b> <small>${esc(check.id)} · ${esc(check.reason)}</small><br>${esc(check.detail)}</span><span class="ft ${cls === 'muted' ? '' : cls}">${esc(check.outcome)}</span></div>`;
}

function statusBox(cls, label, sub) {
  const icon = cls === 'ok' ? ICON_CHECK : ICON_ALERT;
  return `<div class="drift-status" style="background:var(--${cls}-soft);border-color:color-mix(in oklab,var(--${cls}) 22%,transparent)"><div class="dicon" style="background:var(--${cls})">${icon}</div><div class="dtext"><b style="color:var(--${cls})">${esc(label)}</b><span>${esc(sub)}</span></div></div>`;
}

function readyPanel(m) {
  const v = verdict(m);
  const { counts } = m.snapshot.metrics;
  const notEvaluated = m.unavailable.length + m.skipped.length;
  const statusCard = `<div class="card span-5"><div class="card-head"><h3>Diagnostic status</h3><span class="badge ${v.cls}">${esc(m.snapshot.status)}</span></div><div class="card-body">${statusBox(v.cls, v.label, v.sub)}<div class="donut-meta" style="margin-top:.6rem"><div class="row"><span class="k">Passed</span><span class="v">${counts.passed}</span></div><div class="row"><span class="k">Failed</span><span class="v">${counts.failed}</span></div><div class="row"><span class="k">Unavailable</span><span class="v">${counts.unavailable}</span></div><div class="row"><span class="k">Skipped</span><span class="v">${counts.skipped}</span></div></div><div class="method" style="margin-top:.6rem">Outcomes are reported by the diagnostic for the probes it ran. This panel computes no score.</div></div></div>`;
  const failedBody = m.failed.length
    ? `<div class="drift-files">${m.failed.map(checkRow).join('')}</div>`
    : statusBox('ok', 'No failed checks', 'no check reported a failure');
  const failedCard = `<div class="card span-7"><div class="card-head"><h3>Failed checks</h3><span class="badge ${m.failed.length ? 'bad' : 'ok'}">${m.failed.length ? plural(m.failed.length, 'failure') : 'none'}</span></div><div class="card-body">${failedBody}</div></div>`;
  const gapRows = [...m.unavailable, ...m.skipped].map(checkRow).join('');
  const gapCard = gapRows
    ? `<div class="card span-12"><div class="card-head"><h3>Not evaluated</h3><span class="badge warn">${notEvaluated}</span></div><div class="card-body"><div class="drift-files">${gapRows}</div><div class="method" style="margin-top:.6rem">An unavailable or skipped check is a missing observation, not a pass and not a failure.</div></div></div>`
    : '';
  return head('◆', 'live', m.acquisition, v.title, 'Outcomes reported by the diagnostic for the probes it ran. A passing check covers only that probe; configured or present is not verified, and a signature file is not authentication.', `${plural(m.snapshot.checks.length, 'check')} reported`)
    + `<div class="grid">${statusCard}${failedCard}${gapCard}${provenanceCard(m)}</div>`;
}

const CAPTURE_NOTE = {
  supplied: 'supplied snapshot — the report does not re-collect or refresh it',
  'newly-acquired': 'newly acquired — a label set by the caller, not attested by this report'
};

function provenanceCard(m) {
  const { producer, capture, evidence, metrics } = m.snapshot;
  const sha = evidence.originalSha256
    ? `${evidence.originalSha256} — digest of the raw bytes supplied to the data module; not recomputed or verified here`
    : 'not supplied — no original evidence identity is available';
  const rows = [
    ['Producer', `${producer.name} ${producer.version}`],
    ['Producer revision', producer.revision ?? 'unavailable'],
    ['Diagnostic contract', producer.contract],
    ['Observed at', capture.observedAt],
    ['Capture', CAPTURE_NOTE[capture.acquisition] ?? CAPTURE_NOTE.supplied],
    ['Original evidence SHA-256', sha],
    ['Authentication', `${evidence.authentication.replace(/-/g, ' ')} — no origin or signature check was made`],
    ['Structural validation', `${evidence.structuralValidation} — shape only; says nothing about authenticity or whether the diagnostic succeeded`],
    ['Projection', `${evidence.projection} — known secret/home/argument patterns masked; review before sharing`],
    ['Probe limits', `budget ${metrics.budgetMs} ms · elapsed ${metrics.elapsedMs} ms · max active probes ${metrics.maxActiveProbes}`]
  ];
  const list = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  return `<div class="card span-12"><div class="card-head"><h3>Evidence and provenance</h3><span class="badge muted">structure only</span></div><div class="card-body"><dl class="kv">${list}</dl><div class="method" style="margin-top:.6rem">Provenance fields are the caller's supplied metadata. Structural validity, an original-evidence digest and authentication are three different claims; only the first is made here.</div></div></div>`;
}

const COUNT_ROWS = [['passed', 'Passed', ''], ['failed', 'Failed', 'bad'], ['unavailable', 'Unavailable', 'warn'], ['skipped', 'Skipped', 'dim']];

function heroPanel(m) {
  const { snapshot } = m;
  const evaluated = snapshot.status === 'completed';
  const { counts } = snapshot.metrics;
  const total = COUNT_ROWS.reduce((sum, [key]) => sum + counts[key], 0);
  const bars = COUNT_ROWS.map(([key, label, cls]) => `<div class="mat-row"><div class="mat-bar-wrap"><span class="mat-label">${label}</span><span class="mat-track"><span class="mat-fill ${cls === 'dim' ? '' : cls}" style="width:${evaluated && total ? Math.round((counts[key] / total) * 100) : 0}%${cls === 'dim' ? ';background:var(--dim)' : ''}"></span></span></div><span class="mat-val">${evaluated ? counts[key] : 'n/a'}</span></div>`).join('');
  const left = `<div class="card hero-radar"><span class="hero-eyebrow">Check outcomes</span><div class="mat" style="width:100%">${bars}</div><div class="method">Counts as supplied by the diagnostic. ${evaluated ? 'A zero is a measured zero.' : 'Nothing was evaluated, so no count is shown.'}</div></div>`;
  const v = verdict(m);
  const gaps = m.unavailable.length + m.skipped.length;
  const headline = !evaluated
    ? `<span class="accent">Diagnostic ${esc(snapshot.status)}.</span><br><span class="muted">no completed observation.</span>`
    : `<span class="accent">Diagnostic completed,</span><br><span class="muted">${esc(m.failed.length ? `${plural(m.failed.length, 'check')} failed.` : gaps ? `${plural(gaps, 'check')} not evaluated.` : m.passed.length ? `${plural(m.passed.length, 'check')} passed.` : 'no checks reported.')}</span>`;
  const vitals = COUNT_ROWS.map(([key, label]) => `<div class="vital"><span class="v">${evaluated ? counts[key] : 'n/a'}</span><span class="l">${label}</span></div>`).join('');
  const right = `<div class="card hero-narrative"><span class="hero-eyebrow">Harness diagnostic · developer console</span><h2 class="hero-headline">${headline}</h2><p class="hero-sub">Supplied: <b>${plural(snapshot.tools.length, 'tool')}</b>, <b>${plural(snapshot.checks.length, 'check')}</b>, <b>${plural(snapshot.observations.length, 'observation')}</b>. This page computes no wiring or readiness score.</p><div class="deltarow"><span class="badge ok">LIVE · ${esc(m.acquisition)}</span><span class="badge ${v.cls}">${esc(v.label)}</span></div><div class="hero-vitals">${vitals}</div><p class="hero-sub" style="font-size:.74rem;color:var(--dim);margin-top:.3rem">Present or configured is not verified. See <b>Evidence and provenance</b> for what this snapshot does and does not establish.</p></div>`;
  return left + right;
}

const SEVERITY = { high: 'bad', med: 'warn', low: 'ok' };
const SEVERITY_ICON = { high: ICON_ALERT, med: ICON_NOTE, low: ICON_CHEVRON };

function reviewItems(m) {
  const items = [];
  const add = (sev, title, body, evidence) => items.push({ sev, title, body, evidence });
  for (const check of m.failed) add('high', `${check.target} — failed check`, `<b>${esc(check.reason)}</b>: ${esc(check.detail)}`, `check ${check.id}`);
  for (const tool of m.snapshot.tools) if (tool.state === 'broken' && tool.selection !== 'unselected') add('high', `${tool.label} — broken tool`, `The probe found <b>${esc(tool.label)}</b> in state <b>broken</b>; it is ${esc(tool.selection)} but not usable.`, `tool ${tool.id}`);
  for (const d of m.snapshot.diagnostics) add('med', `Diagnostic ${d.code}`, `<b>${esc(d.reason)}</b>: ${esc(d.message)}`, `diagnostic ${d.code}`);
  for (const check of m.unavailable) add('med', `${check.target} — check could not be evaluated`, `<b>${esc(check.reason)}</b>: ${esc(check.detail)}`, `check ${check.id}`);
  for (const tool of m.snapshot.tools) if (tool.state === 'absent' && tool.selection === 'requested') add('med', `${tool.label} — requested but absent`, `<b>${esc(tool.label)}</b> was requested and the probe did not find it.`, `tool ${tool.id}`);
  for (const check of m.skipped) add('low', `${check.target} — check skipped`, `<b>${esc(check.reason)}</b>: ${esc(check.detail)}`, `check ${check.id}`);
  for (const tool of m.snapshot.tools) if (tool.state === 'config-only' && tool.selection !== 'unselected') add('low', `${tool.label} — configuration only`, `Configuration for <b>${esc(tool.label)}</b> was observed; that is not verification that the tool runs.`, `tool ${tool.id}`);
  return items;
}

const CODE_STYLE = 'font-family:var(--mono);font-size:.7rem;background:var(--surface-3);border:1px solid var(--border-2);padding:.2rem .5rem;border-radius:5px;color:var(--fg-2);white-space:nowrap;overflow:auto;flex:1';

function actionsPanel(m) {
  const items = reviewItems(m);
  const tally = ['high', 'med', 'low'].map((sev) => `${items.filter((item) => item.sev === sev).length} ${sev}`).join(' · ');
  const cards = items.map((item) => `<div class="anom-card ${SEVERITY[item.sev]}"><div class="anom-head"><div class="anom-icon">${SEVERITY_ICON[item.sev]}</div><h4>${esc(item.title)}</h4><span class="sev">${item.sev}</span></div><p class="anom-body">${item.body}</p><div class="anom-evidence"><code style="${CODE_STYLE}">${esc(item.evidence)} · no command supplied</code></div></div>`).join('');
  const body = items.length
    ? `<div class="anom-strip">${cards}</div>`
    : `<div class="grid"><div class="card span-12"><div class="card-body">${statusBox('ok', 'Nothing to review', 'no failed, unavailable or skipped check and no unusable tool was reported')}</div></div></div>`;
  return head('★', 'live', m.acquisition, items.length ? `${plural(items.length, 'item')} to review` : 'Nothing to review in this diagnostic', 'Derived mechanically from supplied check outcomes, tool states and diagnostics, ranked by severity. The snapshot carries no repair commands, so none are shown.', items.length ? tally : '0 items')
    + body;
}

const CHIP = { passed: ['ok', '✓'], failed: ['bad', '✗'], unavailable: ['', '?'], skipped: ['', '–'] };

const TOOL_GROUPS = [
  ['runnable', 'Runnable', 'tool on'],
  ['binary', 'Binary found — not run', 'tool partial'],
  ['config-only', 'Config only — not verified', 'tool partial'],
  ['broken', 'Broken', 'tool bad'],
  ['absent', 'Absent', 'tool off']
];
const GROUP_LABEL = 'font-size:.66rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600;margin:.7rem 0 .35rem';

function observationRow(observation) {
  return `<div class="drift-file wrap"><span class="fd" style="background:var(--accent)"></span><span class="fn"><b>${esc(observation.target)}</b> <small>${esc(observation.id)}</small><br>${esc(observation.detail)}</span><span class="ft">observed</span></div>`;
}

function adoptionPanel(m) {
  const { checks, tools, observations } = m.snapshot;
  const chips = checks.map((check) => {
    const [cls, glyph] = CHIP[check.outcome];
    return `<span class="chip ${cls}" title="${esc(`${check.target}: ${check.outcome} · ${check.reason}`)}"><i>${glyph}</i><span data-check-outcome="${check.outcome}">${esc(check.id)}</span></span>`;
  }).join('');
  const checksCard = `<div class="card span-6"><div class="card-head"><h3>Diagnostic checks</h3><span class="badge muted">${m.passed.length} of ${checks.length} passed</span></div><div class="card-body">${chips ? `<div class="chips">${chips}</div>` : '<div class="method">No checks were reported.</div>'}</div></div>`;
  const groups = TOOL_GROUPS.map(([state, label, cls]) => {
    const members = tools.filter((tool) => tool.state === state);
    if (!members.length) return '';
    const pills = members.map((tool) => `<span class="${cls}" data-tool-state="${state}" title="${esc(`${state} · ${tool.selection}${tool.config ? ` · config ${tool.config}` : ''}`)}">${esc(tool.label)}</span>`).join('');
    return `<div style="${GROUP_LABEL}">${label}</div><div class="pills">${pills}</div>`;
  }).join('');
  const toolsCard = `<div class="card span-6"><div class="card-head"><h3>Tools</h3><span class="badge muted">${plural(tools.length, 'tool')}</span></div><div class="card-body">${groups || '<div class="method">No tool states were reported.</div>'}</div></div>`;
  const observationsCard = `<div class="card span-12"><div class="card-head"><h3>Observations</h3><span class="badge muted">${observations.length}</span></div><div class="card-body">${observations.length ? `<div class="drift-files">${observations.map(observationRow).join('')}</div>` : '<div class="method">No observations were reported.</div>'}<div class="method" style="margin-top:.6rem">Observed, not verified: an observation records what a probe saw. A configured or present item is not proof that it works, and native behavior is not inferred.</div></div></div>`;
  const runnable = tools.filter((tool) => tool.state === 'runnable').length;
  return head('06', 'live', m.acquisition, `${plural(tools.length, 'tool')} observed — ${runnable} runnable`, 'Tool states and check outcomes as supplied. Each state keeps its own scope: a binary that was found is not a tool that ran, and configuration alone is not a working setup.', `${plural(tools.length, 'tool')} · ${plural(checks.length, 'check')}`)
    + `<div class="grid">${checksCard}${toolsCard}${observationsCard}</div>`;
}

function supportTicket(m) {
  const { snapshot } = m;
  const findings = [...m.failed, ...m.unavailable, ...m.skipped].map((check) => `- [${check.outcome}] ${check.target} (${check.id}): ${check.reason} — ${check.detail}`);
  const tools = snapshot.tools
    .filter((tool) => tool.selection !== 'unselected' && (tool.state === 'broken' || (tool.state === 'absent' && tool.selection === 'requested')))
    .map((tool) => `- [${tool.state} tool] ${tool.label} (${tool.id})`);
  const diagnostics = snapshot.diagnostics.map((d) => `- ${d.code} (${d.reason}): ${d.message}`);
  return [
    `Subject: Diagnostic findings — ${m.failed.length} failed, ${m.unavailable.length} unavailable, ${m.skipped.length} skipped`,
    `Source: ${snapshot.producer.name} ${snapshot.producer.version} (${snapshot.producer.revision ?? 'unavailable'}) · contract ${snapshot.producer.contract}`,
    `Captured: ${snapshot.capture.observedAt} (${m.acquisition})`,
    `Status: ${snapshot.status}`,
    '',
    'Findings:', ...(findings.length ? findings : ['- none reported']),
    ...(tools.length ? ['', 'Tools needing attention:', ...tools] : []),
    ...(diagnostics.length ? ['', 'Diagnostics:', ...diagnostics] : []),
    '',
    'Scope: draft built only from supplied observations. Configured or present items are not verification, and a signature file is not authentication.'
  ].join('\n');
}

function supportPanel(m) {
  const rows = [['failed checks', m.failed.length, 'bad'], ['unavailable checks', m.unavailable.length, 'warn'], ['skipped checks', m.skipped.length, 'muted'], ['diagnostics', m.snapshot.diagnostics.length, 'warn']];
  const total = rows.reduce((sum, [, n]) => sum + n, 0);
  const bars = rows.map(([label, n, cls]) => `<div class="mat-row"><div class="mat-bar-wrap"><span class="mat-label">${label}</span><span class="mat-track"><span class="mat-fill ${cls === 'muted' ? '' : cls}" style="width:${total ? Math.round((n / total) * 100) : 0}%${cls === 'muted' ? ';background:var(--dim)' : ''}"></span></span></div><span class="mat-val">${n}</span></div>`).join('');
  const findingsCard = `<div class="card span-4"><div class="card-head"><h3>Findings</h3><span class="badge muted">from supplied checks</span></div><div class="card-body"><div class="mat">${bars}</div></div></div>`;
  const ticketCard = `<div class="card span-8"><div class="card-head"><h3>Support summary · copy-ready draft</h3><span class="badge ${total ? 'warn' : 'ok'}">${total ? plural(total, 'finding') : 'no findings'}</span></div><div class="card-body"><pre class="ticket">${esc(supportTicket(m))}</pre></div></div>`;
  return head('07', 'live', m.acquisition, total ? `${plural(total, 'finding')} to hand over` : 'No findings to hand over', 'A tool-neutral draft you can paste into a support request. It restates only supplied findings from the snapshot\'s redacted projection; review it before sharing.', `${total} ${total === 1 ? 'finding' : 'findings'}`)
    + `<div class="grid">${findingsCard}${ticketCard}</div>`;
}

function liveSections(snapshot) {
  const m = model(snapshot);
  return {
    'sec-hero': { state: 'live', html: heroPanel(m) },
    'sec-ready': { state: 'live', html: readyPanel(m) },
    'sec-actions': { state: 'live', html: actionsPanel(m) },
    'sec-adoption': { state: 'live', html: adoptionPanel(m) },
    'sec-support': { state: 'live', html: supportPanel(m) }
  };
}

const DEMO_BANNER = '<div class="demo-banner"><strong>DEMO</strong><span>Design sample. Every number, name and command on this page is invented for illustration; none of it comes from a diagnostic or from the supplied snapshot. Commands shown are old sample text, not supported Core commands. PREVIEW panels show capabilities that are not wired.</span></div>';

const MODES = ['report', 'demo'];
const MAX_TITLE = 200;

function readOptions(options) {
  if (options === null || typeof options !== 'object') throw new TypeError('renderReport options must be an object');
  const { title = DEFAULT_TITLE, mode = 'report' } = options;
  if (typeof title !== 'string' || title.length === 0 || title.length > MAX_TITLE) throw new TypeError(`title must be a string of 1 to ${MAX_TITLE} characters`);
  if (!MODES.includes(mode)) throw new TypeError(`mode must be one of: ${MODES.join(', ')}`);
  return { title, demo: mode === 'demo' };
}

export function renderReport(input, options = {}) {
  const { title, demo } = readOptions(options);
  // The data module validates, bounds and re-applies the privacy projection; the page draws only that copy.
  const snapshot = importSnapshot(exportSnapshot(input));
  const sections = {};
  let html = TEMPLATE;
  html = replaceOnce(html, TITLE_ANCHOR, `<title>${esc(title)}</title>`);
  html = replaceOnce(html, BRAND_ANCHOR, `<span id="brand-title">${esc(title)}</span>`);
  if (demo) {
    // The authored shell is the design sample: its baked values are shown, labelled, and nothing is bound.
    html = replaceOnce(html, '<body>', '<body data-demo="on">');
    html = replaceOnce(html, BANNER_ANCHOR, DEMO_BANNER);
    return replaceOnce(html, RADAR_ANCHOR, `window.AIH_DATA=${scriptJson({ mode: 'demo', sections })};\n${RADAR_ANCHOR}`);
  }
  for (const [id, [no, panelTitle, insight, cardTitle, reason]] of Object.entries(EMPTY_PANELS)) {
    sections[id] = { state: 'empty', html: emptyPanel(no, panelTitle, insight, cardTitle, reason) };
  }
  Object.assign(sections, liveSections(snapshot));
  html = replaceOnce(html, BANNER_ANCHOR, reportBanner(snapshot));
  html = replaceOnce(html, RADAR_ANCHOR, `window.AIH_DATA=${scriptJson({ mode: 'report', sections })};\n${NO_RADAR}`);
  for (const [id, section] of Object.entries(sections)) html = replaceSection(html, id, section.state, section.html);
  return html;
}
