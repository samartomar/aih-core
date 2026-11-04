// Change and change-request builders (urn:aihq:core:change:0.1.0, urn:aihq:core:change-request:0.1.0) for Core tests.
// Hand-written authoring examples, not Catalog content.
const CHANGE = 'urn:aihq:core:change:0.1.0';
export const CHANGE_REQUEST = 'urn:aihq:core:change-request:0.1.0';
const user = (...parts) => ({ root: 'userHome', segments: parts.map(literal => ({ literal })) });
const inProject = (...parts) => ({ root: 'project', segments: parts.map(literal => ({ literal })) });
const base = (id, scope, operations, extra = {}) => ({ schema: CHANGE, id, description: `Change ${id}`, inputs: {}, materials: [],
  targets: [scope], prerequisites: [], operations, checks: [], ...extra });

/** Ask before Codex runs commands: one root key and one key in a table Core creates. */
export const codexApproval = () => base('codex-approval-on-request', 'user', [{ id: 'set', purpose: 'Ask before Codex runs commands',
  kind: 'config.entries', scope: 'user', format: 'toml', target: user('.codex', 'config.toml'),
  entries: [{ path: ['approval_policy'], action: 'set', value: { literal: 'on-request' } },
    { path: ['sandbox_workspace_write', 'network_access'], action: 'set', value: { literal: false } }], requires: [], checks: [] }]);

/** One project file whose text is an input. */
export const teamFile = (id, name) => base(id, 'project', [{ id: 'write', purpose: `Write ${name}`, kind: 'file.write', scope: 'project',
  target: inProject(name), content: { input: 'text' }, requires: [], checks: [] }],
{ inputs: { text: { type: 'string', required: true, maxLength: 65536 } } });

/** One JSON settings key in the project. */
export const projectSetting = (id, key, value) => base(id, 'project', [{ id: 'set', purpose: `Set ${key}`, kind: 'config.entries', scope: 'project',
  format: 'json', target: inProject('.team', 'settings.json'), entries: [{ path: [key], action: 'set', value: { literal: value } }], requires: [], checks: [] }]);

/** One MCP server and the person's OK for exactly that server (one-server approval). */
export const approvalChange = () => base('docs-server', 'project', [
  { id: 'server', purpose: 'Register the docs server', kind: 'config.entries', scope: 'project', format: 'json', target: inProject('.mcp.json'),
    entries: [{ path: ['mcpServers', 'docs', 'command'], action: 'set', value: { literal: 'docs-mcp' } }], requires: [], checks: [] },
  { id: 'allow', purpose: 'Allow the docs server', kind: 'config.member', scope: 'project', format: 'json', target: inProject('.claude', 'settings.local.json'),
    container: ['enabledMcpjsonServers'], action: 'add', value: { literal: 'docs' }, exclusiveWith: [['disabledMcpjsonServers']],
    approval: { tool: 'claude-code' }, requires: ['server'], checks: [] }]);

/** One exact approved command: the running Node with exact argv, a project working folder and one environment value. */
export const commandChange = (id, args, extra = {}) => base(id, 'project', [{ id: 'run', purpose: 'Run the approved command', kind: 'process.run',
  scope: 'project', executable: { name: 'node' }, args: args.map(literal => ({ literal })), cwd: inProject(),
  env: { AIH_EXAMPLE: { literal: 'set' } }, acceptedExitCodes: [0], effects: ['Writes command-output.txt'], requires: [], checks: [], ...extra }]);

export const changeRequest = (changes, { scope = 'project', project = null, groups, resolutions } = {}) => ({
  schema: CHANGE_REQUEST, mode: 'vibe', scope, target: { project },
  changes: changes.map(({ managementId, change, reference, inputs = {}, requires = [] }) =>
    ({ managementId, ...(reference ? { reference } : { change }), inputs, requires })),
  ...(groups ? { groups } : {}), ...(resolutions ? { resolutions } : {}) });

/**
 * A team change acquired by reference from a local folder: a material file, a marked text block, an INI option, an owned
 * hook group, one secret input and a file check. Writes the change and its material into `folder` and returns the
 * change request entry's `reference`.
 */
export function teamFolder(folder, { createHash, writeFileSync, join }) {
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const rules = Buffer.from('Use the team rules.\n');
  const change = base('team-folder', 'project', [
    { id: 'rules', purpose: 'Write the team rules', kind: 'file.write', scope: 'project', target: inProject('RULES.md'), material: 'rules',
      requires: [], checks: ['rules-match'] },
    { id: 'block', purpose: 'Point the guide at the rules', kind: 'text.block', scope: 'project', target: inProject('AGENTS.md'), blockId: 'team-rules',
      startMarker: '<!-- aih:begin team-rules -->', endMarker: '<!-- aih:end team-rules -->', action: 'set', content: { literal: 'See RULES.md.\n' },
      requires: [], checks: [] },
    { id: 'ini', purpose: 'Use the team index', kind: 'config.entries', scope: 'project', format: 'ini', target: inProject('pip.ini'),
      entries: [{ path: ['global', 'index-url'], action: 'set', value: { input: 'index' } }], requires: [], checks: [] },
    { id: 'hook', purpose: 'Check commands', kind: 'hook.group', scope: 'project', format: 'json', target: inProject('.tool', 'settings.json'),
      container: ['hooks', 'PreToolUse'], groupId: 'team-check', selector: { path: ['hooks', 0, 'command'], value: 'hooks/team-check.sh' }, action: 'set',
      group: { literal: { matcher: 'Bash', hooks: [{ type: 'command', command: 'hooks/team-check.sh' }] } }, requires: [], checks: [] }],
  { inputs: { index: { type: 'string', required: true, sensitive: true } },
    materials: [{ id: 'rules', sha256: digest(rules), byteLength: rules.length }],
    checks: [{ id: 'rules-match', purpose: 'The rules are as written', kind: 'file.sha256', target: inProject('RULES.md'), sha256: digest(rules) }] });
  const bytes = Buffer.from(JSON.stringify(change));
  writeFileSync(join(folder, 'change.json'), bytes); writeFileSync(join(folder, 'rules.md'), rules);
  return { change, reference: { source: { kind: 'local', input: 'team' }, path: 'change.json', sha256: digest(bytes), byteLength: bytes.length,
    materials: [{ id: 'rules', path: 'rules.md', sha256: digest(rules), byteLength: rules.length }] }, bytes };
}
