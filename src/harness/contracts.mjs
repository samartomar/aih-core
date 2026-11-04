import { describeContract } from '../contract-fixtures.mjs';
// This entry is data only. Importing it performs no host observation.
import { distribution } from '../distribution.mjs';
import { userToolsRepair } from './user-trust-definitions.mjs';
import { jvmRepair } from './jvm-trust-definitions.mjs';
import { buildTrustCapabilities, selectRepairDefinition as selectDefinition } from './trust-definitions.mjs';
import { trustCellRecords } from './trust-capabilities.mjs';
import { selectMacosRepairDefinition } from './macos-session-definitions.mjs';
export { macosRepairIndex, repairDefinitionSchema12 } from './macos-session-definitions.mjs';
export { validateRepairDefinition11, validateRepairDefinition12, validateTrustCapabilities } from './trust-validation.mjs';
export { macosSessionProfiles, macosSessionProfilesSchema } from './macos-session-profiles.mjs';
// Trust definition assembly (definition factories, adapter/profile tables and recipe resolution) stays internal.
export { trustRepairIndex, trustLimits, trustPlatformMatrix, consumerProfiles,
  selectTrustCell, exportDefaultNames } from './trust-definitions.mjs';
// Admission cells are static raw data (trust-capabilities.mjs): only exact tested export format/profile cells are admitted;
// native and file repair cells stay absent until their own published evidence exists.
export const trustCapabilities = buildTrustCapabilities(distribution, trustCellRecords);
export { toolRegistry, listTools, selectTool, validateToolRegistry } from './tool-registry.mjs';
export { signerRecords } from './signer-records.mjs';
export { nativeClientIds, nativeVerificationDefinitions } from './native/contracts.mjs';
export { nativeClientDefinitions, validateNativeVerificationDefinition, validateNativeTestIdentity } from './native/tool-names.mjs';
export const contractSupport = Object.freeze({
  schema: 'urn:aihq:package-support:1.1.0',
  package: distribution,
  contracts: Object.freeze([
    Object.freeze({ id: 'urn:aihq:harness:diagnostic:1.0.0', role: 'produces',
      schemaExport: '@aihq/core/harness/schemas/diagnostic/1.0.0.json' }),
    Object.freeze({ id: 'urn:aihq:harness:repair:1.0.0', role: 'produces',
      schemaExport: '@aihq/core/harness/schemas/repair/1.0.0.json' }),
    Object.freeze({ id: 'urn:aihq:harness:repair:1.1.0', role: 'produces',
      schemaExport: '@aihq/core/harness/schemas/repair/1.1.0.json' }),
    Object.freeze({ id: 'urn:aihq:harness:repair:1.2.0', role: 'produces',
      schemaExport: '@aihq/core/harness/schemas/repair/1.2.0.json' }),
    Object.freeze({ id: 'urn:aihq:harness:macos-session-profiles:1.0.0', role: 'produces',
      schemaExport: '@aihq/core/harness/schemas/macos-session-profiles/1.0.0.json' }),
    Object.freeze({ id: 'urn:aihq:harness:trust-capabilities:1.0.0', role: 'produces',
      schemaExport: '@aihq/core/harness/schemas/trust-capabilities/1.0.0.json' }),
    Object.freeze({ id: 'urn:aihq:harness:tool-binding:1.0.0', role: 'produces',
      schemaExport: '@aihq/core/harness/schemas/tool-binding/1.0.0.json' }),
    Object.freeze({ id: 'urn:aihq:report:snapshot:1.0.0', role: 'both',
      schemaExport: '@aihq/core/report/schema' }),
    Object.freeze({ id: 'urn:aihq:report:claims:1.0.0', role: 'accepts',
      schemaExport: '@aihq/core/report/schemas/claims/1.0.0.json' }),
    Object.freeze({ id: 'urn:aihq:report:claims:1.1.0', role: 'accepts',
      schemaExport: '@aihq/core/report/schemas/claims/1.1.0.json' }),
    Object.freeze({ id: 'urn:aihq:core:recipe:1.0.0', role: 'produces',
      schemaExport: '@aihq/core/schemas/recipe/1.0.0.json' }),
    Object.freeze({ id: 'urn:aihq:harness:native-verification-definition:1.0.0', role: 'both',
      schemaExport: '@aihq/core/harness/schemas/native-verification-definition/1.0.0.json' }),
    Object.freeze({ id: 'urn:aihq:harness:native-verification-definition:1.1.0', role: 'both',
      schemaExport: '@aihq/core/harness/schemas/native-verification-definition/1.1.0.json' }),
    Object.freeze({ id: 'urn:aihq:harness:native-test-identity:1.0.0', role: 'accepts',
      schemaExport: '@aihq/core/harness/schemas/native-test-identity/1.0.0.json' })
  ].map(describeContract)),
  entries: Object.freeze([
    { export: '@aihq/core/harness', runtime: 'portable' },
    { export: '@aihq/core/report', runtime: 'portable' },
    { export: '@aihq/core/harness/runtime', runtime: 'node', nodeRange: '>=26.12.1 <27' }
  ])
});

// Presence signals and fixed origins are extracted from the prior CLI registry
// and heal inventory. A config trace never proves a runnable binary.
export const repairIndex = Object.freeze([Object.freeze({
  id: 'node-npm-ca', description: 'Add supplied CA certificates to user-scope Node and npm trust',
  schema: 'urn:aihq:harness:repair:1.0.0', scope: 'user',
  managementId: 'node-npm-trust', materialName: 'trust.pem',
  variants: Object.freeze(['win32', 'darwin', 'linux'].flatMap(os =>
    [['node'], ['npm'], ['node', 'npm']].flatMap(targets =>
      ['declared', 'off'].map(network => Object.freeze({ os,
        architectures: Object.freeze(os === 'darwin' ? ['arm64', 'x64'] : ['x64', 'arm64']),
        targets: Object.freeze(targets), network,
        recipeRef: `node-npm-ca/${os}/${targets.join('+')}/${network}`, transformId: 'node-npm-ca-bindings' }))))),
  targets: Object.freeze(['node', 'npm']),
  inputs: Object.freeze({ caFile: Object.freeze({ type: 'file', required: true, description: 'Certificate-only PEM file' }) }),
  limits: Object.freeze({ sourceBytes: 1048576, certificateBlocks: 256, blockBytes: 65536 }),
  offlineVerification: Object.freeze([
    { target: 'node', operationId: 'node-config', checkId: 'node-tls' },
    { target: 'npm', operationId: 'npm-config', checkId: 'npm-behavior' }
  ])
}), Object.freeze({
  id: 'node-os-trust', description: 'Use a bounded OS-trusted candidate for user-scope Node TLS',
  schema: 'urn:aihq:harness:repair:1.0.0', scope: 'user',
  candidateDiagnostic: 'node-os-trust',
  managementId: 'node-os-trust', materialName: 'trust.pem',
  variants: Object.freeze(['win32', 'darwin', 'linux'].flatMap(os =>
    ['system-ca', 'extra-ca'].map(candidate => Object.freeze({ os,
      architectures: Object.freeze(['x64', 'arm64']), targets: Object.freeze(['node']),
      network: 'declared', candidate,
      recipeRef: `node-os-trust/${os}/${candidate}`, transformId: 'node-os-trust-bindings' })))),
  targets: Object.freeze(['node']),
  inputs: Object.freeze({ originId: Object.freeze({ type: 'string', required: true, maxLength: 64,
    description: 'Installed selector for the effective HTTPS npm registry: npm-registry' }) }),
  limits: Object.freeze({ sourceBytes: 1048576, certificateBlocks: 256, blockBytes: 65536 }),
  offlineVerification: Object.freeze([])
}), userToolsRepair, jvmRepair]);
/** Select by (request schema, repair ID, definition schema); the 1.0 index stays reachable for legacy requests. */
export const selectRepairDefinition = query => query?.definitionSchema === 'urn:aihq:harness:repair:1.2.0'
  ? selectMacosRepairDefinition(query) : selectDefinition(query, repairIndex);
export const helperMetadata = Object.freeze({
  repairs: Object.freeze([
    { id: 'node-npm-ca', helper: 'renderRepair', targets: ['node', 'npm'] },
    { id: 'node-os-trust', helper: 'renderRepair', targets: ['node'] },
    { id: 'user-tools-ca', helper: 'renderRepair', targets: ['python', 'pip', 'git', 'cargo', 'conda'] },
    { id: 'jvm-ca', helper: 'renderRepair', targets: ['gradle', 'maven'] }
  ]),
  diagnostics: Object.freeze([
    { id: 'existing-tools', kind: 'diagnostic', purpose: 'Inspect installed tools and their declared TLS origins',
      targets: ['node', 'npm', 'git', 'python', 'pip', 'cargo', 'conda', 'claude', 'codex', 'cursor', 'gemini', 'copilot', 'windsurf', 'opencode', 'kimi', 'kiro',
        'rg', 'fd', 'jq', 'curl', 'keytool', 'bash', 'antigravity', 'zed'],
      profile: { phaseMs: 180000, maxActiveProbes: 2, localProcessMs: 30000, networkProcessMs: 25000,
        networkSocketMs: 20000, outputBytes: 65536, checkDetailBytes: 4096, phaseDetailBytes: 65536,
        configuredMcpOrigins: 3, configuredMcpMs: 60000 } }
  ])
});

// `binaries` are the detection names inspection resolves, in preference order. `executables` are every
// command name the target covers: its binaries, then any command that ships with the tool and runs under
// its configuration without being a detection signal (npm's own `npx` reads npm's configuration).
export const targets = Object.freeze([
  { id: 'node', label: 'Node.js', binaries: ['node'], configDirs: [], origins: [] },
  { id: 'npm', label: 'npm', binaries: ['npm'], alsoCovers: ['npx'], configDirs: [], origins: ['https://registry.npmjs.org'] },
  { id: 'git', label: 'Git', binaries: ['git'], configDirs: [], origins: [] },
  { id: 'python', label: 'Python', binaries: ['python3', 'python'], configDirs: [], origins: ['https://pypi.org'] },
  { id: 'pip', label: 'pip', binaries: ['pip', 'pip3'], configDirs: [], origins: ['https://pypi.org'] },
  { id: 'cargo', label: 'Cargo', binaries: ['cargo'], configDirs: ['.cargo'], origins: ['https://crates.io'] },
  { id: 'conda', label: 'conda', binaries: ['conda'], configDirs: [], origins: ['https://repo.anaconda.com'] },
  { id: 'claude', label: 'Claude Code', binaries: ['claude'], configDirs: ['.claude'], origins: [] },
  { id: 'codex', label: 'Codex CLI', binaries: ['codex'], configDirs: ['.codex'], origins: [] },
  { id: 'cursor', label: 'Cursor', binaries: ['cursor', 'cursor-agent', 'agent'], configDirs: ['.cursor'], origins: [] },
  { id: 'gemini', label: 'Gemini CLI', binaries: ['gemini'], configDirs: ['.gemini/tmp', '.gemini/extensions', '.gemini/commands', '.gemini/history'], origins: [] },
  { id: 'copilot', label: 'GitHub Copilot', binaries: ['copilot'], configDirs: ['.config/github-copilot', '.copilot'], origins: [] },
  { id: 'windsurf', label: 'Windsurf', binaries: ['windsurf'], configDirs: ['.codeium/windsurf', '.windsurf'], origins: [] },
  { id: 'opencode', label: 'OpenCode', binaries: ['opencode'], configDirs: ['.config/opencode', '.opencode'], origins: [] },
  { id: 'kimi', label: 'Kimi Code', binaries: ['kimi'], configDirs: ['.kimi-code'], origins: [] },
  { id: 'kiro', label: 'Kiro', binaries: ['kiro-cli'], configDirs: ['.kiro'], origins: ['https://kiro.dev'] },
  // Helpers: presence and a version probe only; no general tool inventory.
  { id: 'rg', label: 'ripgrep', binaries: ['rg'], configDirs: [], origins: [] },
  { id: 'fd', label: 'fd', binaries: ['fd', 'fdfind'], configDirs: [], origins: [] },
  { id: 'jq', label: 'jq', binaries: ['jq'], configDirs: [], origins: [] },
  { id: 'curl', label: 'curl', binaries: ['curl'], configDirs: [], origins: [] },
  { id: 'keytool', label: 'Java keytool', binaries: ['keytool'], configDirs: [], origins: [] },
  { id: 'bash', label: 'Bash', binaries: ['bash'], configDirs: [], origins: [] },
  // Clients: signals from vendor docs (antigravity.google, zed.dev). Presence never proves native loading.
  { id: 'antigravity', label: 'Google Antigravity', binaries: ['agy', 'antigravity'],
    configDirs: ['.gemini/antigravity-cli', '.gemini/antigravity', '.gemini/config'], origins: [] },
  { id: 'zed', label: 'Zed', binaries: ['zed', 'zeditor', 'zedit'],
    configDirs: ['.config/zed', 'AppData/Roaming/Zed'], origins: [] }
].map(({ id, label, binaries, alsoCovers = [], ...rest }) => ({ id, label, binaries, executables: [...binaries, ...alsoCovers], ...rest })));
for (const target of targets) {
  Object.freeze(target.binaries);
  Object.freeze(target.executables);
  Object.freeze(target.configDirs);
  Object.freeze(target.origins);
  Object.freeze(target);
}
