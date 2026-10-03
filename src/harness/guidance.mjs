// Portable shipped rules. No fact's freeform text is copied into presentation.
import { repairIndex, targets } from './contracts.mjs';

export const guidanceSubjects = Object.freeze([...new Set([
  ...targets.map(target => target.id), ...repairIndex.flatMap(repair => repair.targets),
  'mcp', 'docker', 'homebrew', 'policy', 'unknown'
])]);
const labels = Object.freeze(Object.fromEntries([
  ...targets.map(target => [target.id, target.label]), ['gradle', 'Gradle'], ['maven', 'Maven'],
  ['mcp', 'Configured MCP'], ['docker', 'Docker'], ['homebrew', 'Homebrew'], ['policy', 'Policy'], ['unknown', 'Unrecognized diagnostic']
]));
const reasons = Object.freeze({
  'executable-missing': 'Executable unavailable', 'version-exit': 'Version command failed',
  'version-ok': 'Version command passed', 'tls-ok': 'TLS probe passed',
  'node-certificate-chain': 'OS and Node trust differ', 'certificate-chain': 'Certificate chain rejected',
  'connection-failed': 'Connection failed', 'authentication-required-or-denied': 'Authentication required or denied',
  'organization-permission-incomplete': 'Managed permission incomplete', 'state-protection': 'State protection refused access',
  'state-unwritable': 'State is not writable', 'permission-denied': 'Access denied', 'EACCES': 'Access denied', 'EPERM': 'Access denied',
  'authority-denied': 'Organization authority denied', 'authority-unavailable': 'Organization authority unavailable',
  'loading-unverified': 'Native loading unverified', 'path-resolution': 'Selected PATH executable', 'wsl-launcher': 'Ambiguous WSL launcher',
  'network-off': 'Network checks disabled', 'offline': 'Live verification skipped', 'skipped-offline': 'Live verification skipped',
  'not-applicable': 'Check not applicable', 'no-supplied-check': 'No verification check supplied', 'not-attempted': 'Action not attempted',
  'deadline': 'Diagnostic deadline reached', 'output-bytes': 'Diagnostic output limit reached',
  'termination-unresolved': 'Process termination unconfirmed', 'probe-invocation': 'Probe unavailable',
  'config-invalid': 'Configuration invalid', 'config-unavailable': 'Configuration unavailable',
  'candidate-count': 'Diagnostic candidate limit reached', 'review-stale': 'Review is stale',
  'input-invalid': 'Input invalid', 'schema-unsupported': 'Format unsupported', 'prerequisite-unavailable': 'Prerequisite unavailable',
  'execution-failed': 'Execution failed', 'verification-failed': 'Verification failed', 'conflict': 'Review conflict',
  'ready': 'Ready for review', 'complete': 'Complete', 'incomplete': 'Incomplete', 'partial': 'Partial',
  'blocked': 'Blocked', 'invalid': 'Invalid', 'cancelled': 'Cancelled', 'rejected': 'Rejected',
  'unrecognized-diagnostic': 'Unrecognized diagnostic', 'guidance-omitted': 'Additional guidance omitted'
});
export function subjectLabel(id) { return Object.hasOwn(labels, id) ? labels[id] : undefined; }
export function reasonLabel(reason) { return Object.hasOwn(reasons, reason) ? reasons[reason] : undefined; }

const clientSteps = Object.freeze({
  antigravity: 'In Antigravity, open its own settings or MCP, rules and skills views and confirm the expected items are listed and enabled; inspection does not start Antigravity sessions.',
  zed: 'In Zed, open the Agent panel settings and the settings file, and confirm the expected servers or extensions are listed and active; inspection does not start Zed sessions.'
});
const codeReasons = Object.freeze({
  AUTHORITY_DENIED: 'authority-denied', AUTHORITY_UNAVAILABLE: 'authority-unavailable',
  INPUT_INVALID: 'input-invalid', SCHEMA_UNSUPPORTED: 'schema-unsupported', REVIEW_STALE: 'review-stale',
  CANCELLED: 'cancelled', PREREQUISITE_UNAVAILABLE: 'prerequisite-unavailable',
  EXECUTION_FAILED: 'execution-failed', VERIFICATION_FAILED: 'verification-failed', CONFLICT: 'conflict'
});
export const clientGuidanceTargets = Object.freeze(Object.keys(clientSteps));
const permissions = new Set(['authority-denied', 'state-protection', 'state-unwritable',
  'organization-permission-incomplete', 'authentication-required-or-denied', 'permission-denied', 'EACCES', 'EPERM']);
const pointer = /^(?:\/(?:checks|observations|diagnostics|operations|tools)\/\d+|\/review\/(?:conflicts|omissions|observations|operations)\/\d+|\/(?:status|completion))$/;

function suggestion(request, id, selected) {
  if (request.platform === 'unknown' || (request.repair && request.repair.id !== id)) return [];
  const repair = repairIndex.find(entry => entry.id === id);
  if (!repair) return [];
  const wanted = repair.targets.filter(target => selected.includes(target) &&
    (!request.repair || request.repair.targets.includes(target)));
  if (!wanted.length || !repair.variants.some(variant => variant.os === request.platform &&
      ['declared', 'off'].includes(variant.network) && variant.targets.length === wanted.length &&
      wanted.every(target => variant.targets.includes(target)))) return [];
  return [{ id: repair.id, targets: wanted, requiredInputs: Object.entries(repair.inputs)
    .filter(([, input]) => input.required).map(([name, input]) => ({ name, type: input.type, description: input.description })) }];
}

/** Stable ordering: developer actions, then administrator actions, in evidence order. */
export function deriveGuidance(request) {
  const items = [];
  const unselected = new Set(request.facts.filter(fact => fact.kind === 'tool' && fact.selection === 'unselected').map(fact => fact.target));
  const runnableNode = request.facts.some(fact => fact.kind === 'tool' && fact.target === 'node' && fact.state === 'runnable');
  function add(fact, id, target, reason, summary, steps, repairs = [], audience = 'developer') {
    items.push({ id, target, reason, audience, summary, steps,
      evidenceIds: pointer.test(fact.evidenceId) ? [fact.evidenceId] : [], repairs });
  }
  for (const fact of request.facts) {
    let target = guidanceSubjects.includes(fact.target) ? fact.target : request.useCase === 'policy' ? 'policy' : 'unknown';
    let reason = fact.reason;
    if (fact.kind === 'status') {
      if (['complete', 'ready'].includes(fact.value)) continue;
      reason = reasonLabel(fact.value) ? fact.value : 'unrecognized-diagnostic';
      add(fact, 'result-status', target, reason, `The result is ${reasonLabel(reason).toLowerCase()}.`,
        ['Resolve the reported bounded failure, then inspect and prepare a fresh review.',
          'Review any completed effects separately; do not reuse a stale prepared handle or replay recovery records.']);
      continue;
    }
    if (fact.kind === 'tool') continue;
    if (fact.kind === 'diagnostic') {
      // Policy classification uses diagnostic codes only, never authored IDs or reason text.
      reason = request.useCase === 'policy' ? codeReasons[fact.code] :
        fact.code === 'AUTHORITY_DENIED' ? 'authority-denied' : reason;
    }
    if (fact.kind === 'operation') {
      if (fact.application !== 'failed' && !['failed', 'unavailable', 'unverified', 'skipped'].includes(fact.verification)) continue;
      reason = request.useCase === 'policy' ? 'verification-failed' : reason;
    }
    if (request.useCase === 'repair' && ['operation', 'check'].includes(fact.kind)) {
      const definitions = request.repair ? repairIndex.filter(entry => entry.id === request.repair.id) : repairIndex;
      target = definitions.flatMap(entry => entry.offlineVerification).find(entry =>
        `trust/${fact.kind === 'check' ? entry.checkId : entry.operationId}` === fact.id &&
        (!request.repair || request.repair.targets.includes(entry.target)))?.target ?? target;
    }
    if (fact.kind === 'observation') {
      if (fact.id === `${target}/loading`) reason = 'loading-unverified';
      else if (fact.id === `${target}/resolution`) reason = 'path-resolution';
      else continue;
    }
    if (fact.kind === 'check') {
      if (fact.outcome === 'passed' && (request.useCase === 'policy' || reasonLabel(reason))) continue;
      if (request.useCase === 'policy') reason = fact.outcome === 'failed' ? 'verification-failed' : 'prerequisite-unavailable';
      if (reason === 'executable-missing' && !['unknown', 'policy'].includes(target) && typeof fact.id === 'string' && fact.id.startsWith(`${target}/tls/os/`)) {
        add(fact, 'missing-curl', 'curl', reason, 'The OS TLS check needs curl.',
          ['Use an approved curl installation and ensure it is available on PATH.', 'Open a fresh shell and inspect again.']);
        continue;
      }
      if (unselected.has(target) && reason === 'executable-missing') continue;
    }
    reason = reasonLabel(reason) && !(target === 'unknown' && fact.kind === 'check' && request.kind === 'inspect') ? reason : 'unrecognized-diagnostic';
    const label = subjectLabel(target);
    if (reason === 'unrecognized-diagnostic') {
      add(fact, 'diagnostic-review', target, reason, 'Review the diagnostic and inspect again.',
        ['Review the local diagnostic and resolve the bounded failure or missing verification.', 'Inspect again and prepare a fresh review before any further application.']);
      continue;
    }
    if (permissions.has(reason)) {
      add(fact, 'access-review', target, reason, `${label}: ${reasonLabel(reason)}.`,
        [`Record the failed ${fact.scope === 'user' ? 'user' : fact.scope === 'project' ? 'project' : 'reviewed'} scope and action using the local diagnostic.`,
          ...(reason === 'authentication-required-or-denied' ? ['Check approved network reachability, proxy settings and endpoint authorization before retrying.'] : []),
          'Ask for approved access or managed configuration, then inspect and prepare again. Elevation alone may not resolve this restriction.']);
      add(fact, 'managed-access', target, reason, 'An administrator must review the enforced access or managed configuration.',
        ['Confirm the approved scope and access policy for the failed action.', 'Provide approved access or configuration without bypassing organizational controls.'], [], 'administrator');
    } else if (target === 'docker') {
      const step = request.platform === 'win32' || request.platform === 'darwin' ?
        'Check the approved Docker Desktop installation and supported host, and confirm its daemon is available.' : request.platform === 'linux' ?
        'Check the approved Docker installation and daemon/service availability; review approved group membership for user access.' :
        'Check the approved Docker installation, supported host and daemon availability using the host organization’s setup.';
      add(fact, 'docker-readiness', target, reason, 'Review Docker installation, host support and user access.',
        [step, 'Ask an administrator to resolve enforced restrictions through approved access; inspect again.']);
      add(fact, 'docker-access', target, reason, 'An administrator must review Docker restrictions.',
        ['Confirm the supported host and approved daemon access policy.', 'Resolve managed restrictions without relaxing socket permissions or blanket elevation.'], [], 'administrator');
    } else if (target === 'homebrew') {
      add(fact, 'homebrew-readiness', target, reason, request.platform === 'win32' ? 'Homebrew is not applicable to this Windows host.' : 'Review the selected Homebrew prefix and shell initialization.',
        request.platform === 'win32' ? ['Use the organization’s approved Windows tool setup; Homebrew has no applicable installation recipe here.'] :
          [request.platform === 'darwin' ? 'Check the selected prefix: /opt/homebrew on Apple silicon or /usr/local on Intel macOS.' :
            request.platform === 'linux' ? 'Check the selected Linux prefix: /home/linuxbrew/.linuxbrew.' : 'Check the selected prefix using the approved setup for the actual host platform.',
          'Review shell initialization according to the organization’s approved setup, open a fresh shell and inspect again.']);
    } else if (reason === 'executable-missing' || reason === 'version-exit') {
      add(fact, reason === 'executable-missing' ? 'missing-executable' : 'broken-installation', target, reason,
        reason === 'executable-missing' ? `${label} was not found on PATH.` : `${label} was found but its version command failed.`,
        ['Review the existing installation using the vendor’s instructions and use only an approved installation or PATH correction.',
          ...(target === 'npm' && runnableNode ? ['Node.js is runnable; npm’s selected executable and PATH need a separate review.'] : []),
          'Open a fresh shell and inspect again.']);
    } else if (reason === 'path-resolution' || reason === 'wsl-launcher') {
      add(fact, 'executable-resolution', target, reason, `${label}: review the executable selected by inspection’s PATH evidence.`,
        [...(reason === 'wsl-launcher' ? ['The selected Bash is an ambiguous Windows WSL launcher; confirm the approved intended shell before running it.'] : []),
          'Review the selected executable and alternatives in the local inspection; observation text is not a command to execute.',
          'After an approved installation or PATH correction, reopen the shell and inspect again.']);
    } else if (target === 'mcp' && reason === 'certificate-chain') {
      add(fact, 'mcp-node-trust', target, reason, 'The diagnostic Node TLS probe rejected the certificate chain.',
        ['Confirm which runtime needs trust before choosing a repair; this probe does not prove configured client or server runtime loading.',
          'If Node needs the approved CA, prepare the published Node trust repair with a CA-only PEM, then review it before applying.'],
        suggestion(request, 'node-npm-ca', ['node']));
      add(fact, 'mcp-ca-policy', target, reason, 'An administrator must confirm approved CA material and MCP trust policy.',
        ['Confirm the endpoint’s intended certificate chain and the approved CA/policy for the actual runtime.',
          'Provide CA-only material through the approved process; diagnostic probe success is not native runtime verification.'], [], 'administrator');
    } else if (reason === 'node-certificate-chain') {
      add(fact, 'node-trust-stores', target, reason, 'The OS TLS check passed while Node rejected the certificate chain; their trust stores differ.',
        ['Review the current Node trust settings and obtain approved CA-only PEM material.', 'Prepare an applicable published repair, review its required inputs and effects, then explicitly authorize it.'],
        [...suggestion(request, 'node-npm-ca', [target]),
          ...(fact.id === `${target}/tls/node/registry.npmjs.org` && ['node', 'npm'].includes(target) ? suggestion(request, 'node-os-trust', ['node']) : [])]);
    } else if (reason === 'certificate-chain') {
      const jvm = repairIndex.find(entry => entry.id === 'jvm-ca')?.targets.includes(target);
      add(fact, 'tool-ca-review', target, reason, `${label}: review the rejected certificate chain and approved trust material.`,
        ['Confirm which tool runtime needs the approved CA before choosing a repair.',
          jvm ? 'Review the published JVM repair inputs and user-scope effects before applying; supply both CA material and an explicitly selected JDK baseline truststore.' :
            'Review the published repair inputs and user-scope effects before applying; supply approved CA-only PEM material.'],
        [...suggestion(request, 'user-tools-ca', [target]), ...suggestion(request, 'jvm-ca', [target])]);
    } else if (reason === 'connection-failed' || reason === 'authority-unavailable') {
      add(fact, 'connection-review', target, reason, 'Review network reachability, proxy settings and authorization.',
        ['Check the approved network route, proxy configuration and endpoint authorization.', 'Inspect again after resolving connectivity; this evidence alone does not identify a CA defect.']);
    } else if (reason === 'loading-unverified') {
      add(fact, 'client-loading', target, reason, `${label} presence or configuration does not verify native loading.`,
        [clientSteps[target] ?? 'Use the client’s own settings to confirm the expected items are listed and enabled.',
          'Keep native loading unverified until an appropriate runtime check supplies evidence; application or presence alone is not verification.']);
    } else {
      add(fact, 'diagnostic-review', target, reason, reason === 'unrecognized-diagnostic' ? 'Review the diagnostic and inspect again.' : `${label}: ${reasonLabel(reason)}.`,
        ['Review the local diagnostic and resolve the bounded failure or missing verification.', 'Inspect again and prepare a fresh review before any further application.']);
    }
  }
  const ordered = [...items.filter(item => item.audience === 'developer'), ...items.filter(item => item.audience === 'administrator')];
  if (ordered.length <= 256) return ordered;
  return [...ordered.slice(0, 255), { id: 'guidance-omitted', target: 'unknown', reason: 'guidance-omitted', audience: 'administrator',
    summary: `${ordered.length - 255} additional guidance items were omitted.`,
    steps: ['Review all remaining diagnostics locally before proceeding.'], evidenceIds: [], repairs: [] }];
}
