// Installed public entries only. These are preparation/refusal checks, never native loading proof.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { checkCompatibility, deriveCellSupport, listTools, renderDelivery, selectBindingCell,
  selectTool, toolRegistry, toolBindingKinds, toolBindings, validateToolBinding } from '@aihq/core/harness';
import candidates from '@aihq/core/fixtures/harness/tool-binding/1.0.0/editor-candidates.json' with { type: 'json' };
const checks = [];
const check = (name, body) => { body(); checks.push(name); };
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
check('exact editor and extension candidates have independent identities', () => {
  assert.deepEqual(candidates.map(({ tool, installedVersion }) => [tool, installedVersion]), [
    ['cursor', '3.27.14'], ['copilot-vscode', '1.143.1'], ['kiro-ide', '1.4.26'], ['zed', '1.25.3']]);
  const extension = candidates[1].extension;
  assert.equal(extension.id, 'GitHub.copilot-chat');
  assert.equal(extension.version, '0.48.1');
  assert.equal(extension.manifestSha256, 'b70ad0b117bc4b202df5eb39a079575e6493b21676310a0c8d071d239c12f585');
  assert.equal(extension.engines.vscode, '^1.120.0');
  assert.equal(extension.pairObserved, false);
  for (const entry of candidates) {
    assert.equal(toolRegistry.tools.find(tool => tool.id === entry.tool).surface, 'ide');
    assert.equal(selectTool(entry.tool).reason, 'tool-not-observed');
    assert.ok(!listTools().some(tool => tool.id === entry.tool));
    assert.ok(!toolBindings.some(binding => binding.tool === entry.tool));
  }
});
check('documented layouts use the current binding schema without manufactured observations', () => {
  for (const entry of candidates) {
    assert.deepEqual(validateToolBinding(entry.binding), { valid: true, diagnostics: [] });
    const { digest, ...binding } = entry.binding;
    assert.equal(digest, createHash('sha256').update(canonical(binding)).digest('hex'));
    assert.equal(binding.tool, entry.tool);
    for (const kind of toolBindingKinds) {
      assert.deepEqual(binding.layouts[kind].observations, []);
      assert.equal(binding.layouts[kind].support, 'unconfirmed');
      assert.equal(binding.layouts[kind].convert, undefined);
    }
  }
});
check('every exact version and all six platform cells remain unconfirmed', () => {
  for (const entry of candidates) for (const os of ['windows', 'macos', 'linux']) for (const arch of ['x64', 'arm64']) {
    assert.equal(entry.nativeCells.find(cell => cell.os === os && cell.arch === arch).status, 'unconfirmed');
    for (const kind of toolBindingKinds) {
      assert.deepEqual(deriveCellSupport({ kind, observations: entry.binding.layouts[kind].observations,
        platform: { os, arch }, installedVersion: entry.installedVersion }), { support: 'unconfirmed', observed: 'none', stale: false });
      assert.equal(selectBindingCell({ tool: entry.tool, kind, platform: { os, arch }, installedVersion: entry.installedVersion }).reason,
        'tool-not-observed');
    }
  }
});
check('exact rendering, mismatched versions, absent approval and unsupported kinds stay behind the editor gate', () => {
  for (const entry of candidates) for (const installedVersion of [entry.installedVersion, '0.0.0', '999.0.0']) {
    for (const kind of toolBindingKinds) {
      const request = { tool: entry.tool, binding: entry.binding, scope: 'project', installedVersion,
        platform: { os: 'linux', arch: 'x64' }, item: { kind } };
      // Tool admission precedes item parsing: neither fabricated material nor approval can enable an editor.
      const result = renderDelivery(request);
      assert.deepEqual(result, { status: 'refused', code: 'PREREQUISITE_UNAVAILABLE', reason: 'tool-not-observed',
        tool: toolRegistry.tools.find(tool => tool.id === entry.tool), path: '/tool' });
      assert.equal(renderDelivery({ ...request, grantApproval: { framework: 'example', itemId: 'server' } }).reason, 'tool-not-observed');
      assert.equal(checkCompatibility({ tool: entry.tool, binding: entry.binding, platform: request.platform,
        installedVersion, items: [] }).reason, 'tool-not-observed');
    }
  }
});
check('native layouts and precedence do not duplicate shared skill copies', () => {
  const [cursor, copilot, kiro, zed] = candidates.map(entry => entry.binding);
  assert.equal(cursor.layouts.skill.roots.project, '.agents/skills');
  assert.equal(cursor.layouts.rule.roots.project, '.cursor/rules');
  assert.equal(cursor.layouts.hook.register.file, 'hooks.json');
  assert.equal(copilot.layouts.skill.roots.project, '.github/skills');
  assert.equal(kiro.layouts.rule.roots.project, '.kiro/steering');
  assert.equal(kiro.layouts.hook.roots.project, '.kiro/hooks');
  assert.equal(kiro.layouts['mcp-server'].register.file, 'settings/mcp.json');
  assert.equal(zed.layouts.skill.roots.project, '.agents/skills');
  assert.deepEqual(zed.entryFiles, ['.rules', '.cursorrules', '.windsurfrules', '.clinerules', '.github/copilot-instructions.md',
    'AGENT.md', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md']);
  assert.ok(candidates[3].gates.some(gate => gate.includes('precedence')));
  for (const binding of [cursor, copilot, kiro, zed]) for (const kind of ['agent', 'command'])
    assert.deepEqual(binding.layouts[kind].roots, {});
});
check('metadata does not claim registration, loading, policy approval or native admission', () => {
  for (const entry of candidates) {
    assert.equal(entry.status, 'source-preparation-only');
    assert.ok(entry.gates.includes('Exact editor artifact and dependency closure are not qualified.'));
    assert.ok(entry.gates.includes('Native registration/listing/loading/use and cleanup require separate authorization.'));
    assert.ok(entry.sources.every(source => source.url.startsWith('https://') && /^[a-f0-9]{64}$/.test(source.sha256)));
    for (const kind of toolBindingKinds) {
      const promoted = structuredClone(entry.binding);
      promoted.layouts[kind].support = 'native';
      assert.ok(validateToolBinding(promoted).diagnostics.some(diagnostic => diagnostic.reason === 'support-not-derived'));
    }
  }
});
console.log(JSON.stringify({ status: 'passed', checks }));
