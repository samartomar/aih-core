// Browser entry for the public consumer example. Imports only portable public
// package modules and the example's portable modules; every value reaches the
// DOM through textContent.
import {
  authorPolicy, catalogItems, exportPolicy, openRelease, policyOrigins, reopenPolicy, requiredItems
} from '../src/authoring.js';
import { presentReport, readScanBytes } from '../src/report-view.js';
import { limitCeilings } from '@aihq/scan/contracts';

const $ = id => document.getElementById(id);
const el = (tag, text) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
};

let release = null;
let materialSource = null;
let session = null;
let policyRevision = 0;
let prepareAttempt = 0;
let reportAttempt = 0;

function invalidateReview() {
  policyRevision++;
  session = null;
  $('approve-button').disabled = true;
  $('review-view').replaceChildren();
  $('apply-view').replaceChildren();
  $('session-line').textContent = 'Policy changed. Prepare and review it before approval.';
}

function renderDiagnostics(parent, diagnostics) {
  for (const diagnostic of diagnostics) {
    const line = el('p');
    line.className = diagnostic.blocking === false ? 'hint' : 'error';
    line.textContent = `${diagnostic.code ?? 'DIAGNOSTIC'} (${diagnostic.reason ?? ''}): ${diagnostic.message ?? diagnostic.detail ?? ''}`;
    if (diagnostic.encountered !== undefined) line.textContent += ` Encountered: ${diagnostic.encountered}.`;
    if (diagnostic.supported) line.textContent += ` Supported: ${diagnostic.supported.join(', ')}.`;
    parent.appendChild(line);
  }
}

function renderNode(parent, node) {
  const div = el('div');
  div.className = 'node';
  const label = el('span', node.children ? node.label : `${node.label}: `);
  label.className = 'label';
  div.appendChild(label);
  if (node.children) {
    const children = el('div');
    children.className = 'children';
    for (const child of node.children) renderNode(children, child);
    div.appendChild(children);
  } else {
    div.appendChild(el('span', node.value));
  }
  parent.appendChild(div);
}

function renderJson(parent, value) {
  const walk = (container, entry, key) => {
    if (entry === null || typeof entry !== 'object') {
      const row = el('div');
      const label = el('span', `${key}: `);
      label.className = 'label';
      row.appendChild(label);
      row.appendChild(el('span', String(entry)));
      container.appendChild(row);
      return;
    }
    const row = el('div');
    const label = el('span', key);
    label.className = 'label';
    row.appendChild(label);
    const children = el('div');
    children.className = 'children';
    for (const [childKey, child] of Object.entries(entry)) walk(children, child, childKey);
    row.appendChild(children);
    container.appendChild(row);
  };
  walk(parent, value, 'result');
}

async function loadCatalog() {
  const response = await fetch('/api/catalog');
  const body = await response.json();
  const bytes = Uint8Array.from(atob(body.bytesBase64), character => character.charCodeAt(0));
  const opened = openRelease(bytes, body.sha256);
  const identity = $('release-identity');
  if (!opened.valid) {
    identity.textContent = 'invalid release';
    renderDiagnostics(identity.parentElement, opened.diagnostics);
    return;
  }
  release = opened.release;
  materialSource = body.source;
  identity.textContent = `${release.package.name}@${release.package.version} sha256:${release.sha256}`;
  const select = $('item-select');
  for (const item of catalogItems(release)) {
    const option = el('option', `${item.label} (${item.id})`);
    option.value = item.id;
    select.appendChild(option);
  }
  select.disabled = false;
  $('author-button').disabled = false;
  renderItem(select.value);
}

function selectedItem() {
  return catalogItems(release).find(item => item.id === $('item-select').value);
}

function renderItem() {
  const item = selectedItem();
  if (!item) return;
  $('item-description').textContent = item.description ?? '';
  const requiredDiv = $('item-required');
  requiredDiv.replaceChildren();
  const closure = requiredItems(release, item.id);
  if (!closure.valid) {
    renderDiagnostics(requiredDiv, closure.diagnostics);
    return;
  }
  const required = closure.itemIds.filter(id => id !== item.id);
  const line = el('p', required.length
    ? 'Select each required item before authoring the policy:'
    : 'No required items.');
  requiredDiv.appendChild(line);
  for (const id of required) {
    const label = el('label');
    const checkbox = el('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.requiredItem = id;
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(` Include required item ${id}`));
    requiredDiv.appendChild(label);
  }

  const inputsDiv = $('item-inputs');
  inputsDiv.replaceChildren();
  for (const memberId of [item.id, ...required]) {
    const member = catalogItems(release).find(candidate => candidate.id === memberId);
    if (!member || Object.keys(member.inputs).length === 0) continue;
    const fieldset = el('fieldset');
    fieldset.appendChild(el('legend', `Inputs for ${member.id}`));
    for (const [name, spec] of Object.entries(member.inputs)) {
      if (spec.sensitive) {
        fieldset.appendChild(el('p', `${name} is supplied privately by the Node host.`));
        continue;
      }
      const label = el('label');
      label.textContent = `${name} (${spec.type}${spec.required ? ', required' : ''}`
        + `${spec.default !== undefined ? `, default ${JSON.stringify(spec.default)}` : ''}): `;
      const input = el('input');
      input.dataset.itemId = memberId;
      input.dataset.inputName = name;
      input.dataset.inputType = spec.type;
      input.size = 32;
      label.appendChild(input);
      fieldset.appendChild(label);
      if (spec.description) fieldset.appendChild(el('p', spec.description)).className = 'hint';
    }
    inputsDiv.appendChild(fieldset);
  }
}

function collectSelections() {
  const item = selectedItem();
  const closure = requiredItems(release, item.id);
  if (!closure.valid) return { valid: false, diagnostics: closure.diagnostics };
  const memberIds = [item.id, ...closure.itemIds.filter(id => id !== item.id)];
  const diagnostics = [];
  for (const checkbox of document.querySelectorAll('input[data-required-item]')) {
    if (!checkbox.checked) diagnostics.push({ code: 'DEPENDENCY_REQUIRED', blocking: true,
      message: `Explicitly select required item ${checkbox.dataset.requiredItem}.` });
  }
  const selections = memberIds.map(memberId => {
    const member = catalogItems(release).find(candidate => candidate.id === memberId);
    const configuration = {};
    for (const input of document.querySelectorAll(`input[data-item-id="${CSS.escape(memberId)}"]`)) {
      const raw = input.value;
      if (raw === '') continue;
      if (input.dataset.inputType === 'string') {
        configuration[input.dataset.inputName] = raw;
      } else {
        try {
          configuration[input.dataset.inputName] = JSON.parse(raw);
        } catch {
          diagnostics.push({
            code: 'INPUT_INVALID', reason: 'scalar-syntax', blocking: true,
            message: `${memberId} input ${input.dataset.inputName} must be a JSON ${input.dataset.inputType}.`
          });
        }
      }
    }
    return {
      id: memberId, managementId: memberId, scope: member.scopes[0], itemId: memberId, configuration
    };
  });
  return diagnostics.length ? { valid: false, diagnostics } : { valid: true, selections };
}

function authorFromPage() {
  invalidateReview();
  const collected = collectSelections();
  const outcome = $('reopen-result');
  outcome.replaceChildren();
  if (!collected.valid) return renderDiagnostics(outcome, collected.diagnostics);
  const authored = authorPolicy({
    release, mode: 'vibe', materialSource, selections: collected.selections
  });
  if (!authored.valid) return renderDiagnostics(outcome, authored.diagnostics);
  $('policy-json').value = exportPolicy(authored.policy);
  const note = el('p', 'Policy authored. Input origins: '
    + Object.entries(authored.origins)
      .map(([id, inputs]) => `${id}: ${Object.entries(inputs).map(([k, v]) => `${k}=${v}`).join(', ') || '(no inputs)'}`)
      .join(' | '));
  note.className = 'ok';
  outcome.appendChild(note);
}

function reopenFromPage() {
  invalidateReview();
  const outcome = $('reopen-result');
  outcome.replaceChildren();
  const reopened = reopenPolicy($('policy-json').value);
  if (!reopened.valid) return renderDiagnostics(outcome, reopened.diagnostics);
  const summary = el('p', `Reopened valid policy: ${reopened.document.selections.length} selection(s), `
    + `mode ${reopened.document.mode}.`);
  summary.className = 'ok';
  outcome.appendChild(summary);
  if (release) {
    const origins = policyOrigins(release, reopened.document);
    for (const [id, inputs] of Object.entries(origins.bySelectionId)) {
      outcome.appendChild(el('p', `${id} input origins: `
        + (Object.entries(inputs).map(([k, v]) => `${k}=${v}`).join(', ') || '(no inputs)')));
    }
  }
}

async function prepareOnHost() {
  const revision = policyRevision;
  const attempt = ++prepareAttempt;
  const policyText = $('policy-json').value;
  session = null;
  const reviewView = $('review-view');
  const applyView = $('apply-view');
  reviewView.replaceChildren();
  applyView.replaceChildren();
  $('approve-button').disabled = true;
  const response = await fetch('/api/prepare', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ policyText })
  });
  const prepared = await response.json();
  if (revision !== policyRevision || attempt !== prepareAttempt || policyText !== $('policy-json').value) return;
  $('session-line').textContent = prepared.sessionId
    ? `session ${prepared.sessionId} — status ${prepared.status}`
    : `status ${prepared.status}`;
  if (prepared.review) {
    renderJson(reviewView, prepared.review);
    session = { sessionId: prepared.sessionId, reviewDigest: prepared.review.reviewDigest };
    $('approve-button').disabled = prepared.status !== 'ready';
  }
  if (prepared.diagnostics?.length) renderDiagnostics(reviewView, prepared.diagnostics);
}

async function approveOnHost() {
  if (!session) return;
  const approvedSession = session;
  session = null;
  $('approve-button').disabled = true;
  $('prepare-button').disabled = true;
  const applyView = $('apply-view');
  applyView.replaceChildren();
  try {
    const response = await fetch('/api/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(approvedSession)
    });
    const result = await response.json();
    renderJson(applyView, result);
    $('session-line').textContent = 'Session consumed. Prepare and approve again for another run.';
  } finally {
    $('prepare-button').disabled = false;
  }
}

function hostFailed(error) {
  session = null;
  $('approve-button').disabled = true;
  $('session-line').textContent = `Host request failed: ${error.message}. Prepare and approve again.`;
}

async function showReport(file) {
  const attempt = ++reportAttempt;
  const status = $('report-status');
  const view = $('report-view');
  view.replaceChildren();
  if (file.size > limitCeilings.maxArtifactBytes) {
    status.textContent = `File exceeds the supported ${limitCeilings.maxArtifactBytes}-byte artifact limit.`;
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await readScanBytes(bytes);
  if (attempt !== reportAttempt) return;
  const presentation = presentReport(result);
  if (presentation.kind === 'unsupported') {
    status.textContent = `Unsupported report generation. Encountered: ${presentation.encountered}; `
      + `supported: ${presentation.supported.join(', ')} (scan ${presentation.scanId}).`;
    return;
  }
  if (presentation.kind === 'invalid') {
    status.textContent = 'Malformed report bytes.';
    renderDiagnostics(view, presentation.diagnostics);
    return;
  }
  status.textContent = `Supported report ${presentation.scanId}. Reading authenticity: `
    + `${presentation.authenticity}; annex bytes: ${presentation.annexBytes}. `
    + 'Core authentication of the producer is a separate check and is not implied here.';
  renderNode(view, presentation.report);
}

$('item-select').addEventListener('change', renderItem);
$('policy-json').addEventListener('input', invalidateReview);
$('author-button').addEventListener('click', authorFromPage);
$('export-button').addEventListener('click', () => {
  const link = el('a');
  link.href = URL.createObjectURL(new Blob([$('policy-json').value], { type: 'application/json' }));
  link.download = 'policy.json';
  link.click();
  URL.revokeObjectURL(link.href);
});
$('reopen-button').addEventListener('click', reopenFromPage);
$('prepare-button').addEventListener('click', () => prepareOnHost().catch(hostFailed));
$('approve-button').addEventListener('click', () => approveOnHost().catch(hostFailed));
$('report-file').addEventListener('change', event => {
  if (event.target.files[0]) showReport(event.target.files[0]);
});

loadCatalog().catch(error => {
  $('release-identity').textContent = `failed to load catalog: ${error.message}`;
});
