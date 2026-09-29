// This entry is data only. Importing it performs no host observation.
export const contractSupport = Object.freeze({
  schema: 'urn:aihq:harness:support:1.0.0',
  package: Object.freeze({ name: '@aihq/harness', version: '2.0.0-dev.0' }),
  contracts: Object.freeze(['urn:aihq:harness:diagnostic:1.0.0', 'urn:aihq:harness:repair:1.0.0']),
  entries: Object.freeze([
    { export: '@aihq/harness/contracts', runtime: 'portable' },
    { export: '@aihq/harness/runtime', runtime: 'node', nodeRange: '>=24.6.0 <25' }
  ])
});

// Presence signals and fixed origins are extracted from the prior CLI registry
// and heal inventory. A config trace never proves a runnable binary.
export const repairIndex = Object.freeze([Object.freeze({
  id: 'node-npm-ca', description: 'Add supplied CA certificates to user-scope Node and npm trust',
  schema: 'urn:aihq:harness:repair:1.0.0', scope: 'user',
  managementId: 'node-npm-trust', materialName: 'trust.pem',
  variants: Object.freeze([
    { os: 'win32', architectures: ['x64', 'arm64'], recipeRef: 'node-npm-ca/windows' },
    { os: 'darwin', architectures: ['arm64', 'x64'], recipeRef: 'node-npm-ca/macos' },
    { os: 'linux', architectures: ['x64', 'arm64'], recipeRef: 'node-npm-ca/linux' }
  ]),
  targets: Object.freeze(['node', 'npm']),
  inputs: Object.freeze({ caFile: Object.freeze({ type: 'file', required: true, description: 'Certificate-only PEM file' }) }),
  limits: Object.freeze({ sourceBytes: 1048576, certificateBlocks: 256, blockBytes: 65536 }),
  offlineVerification: Object.freeze([
    { target: 'node', operationId: 'node-config', checkId: 'node-tls' },
    { target: 'npm', operationId: 'npm-config', checkId: 'npm-behavior' }
  ])
})]);
export const verificationKeys = Object.freeze([]);
export const helperMetadata = Object.freeze({
  repairs: Object.freeze([{ id: 'node-npm-ca', helper: 'renderRepair', targets: ['node', 'npm'] }]),
  diagnostics: Object.freeze([
    { id: 'existing-tools', kind: 'diagnostic', purpose: 'Inspect installed tools and their declared TLS origins',
      targets: ['node', 'npm', 'git', 'claude', 'codex', 'cursor', 'gemini', 'copilot', 'windsurf', 'opencode', 'kimi', 'kiro'],
      profile: { phaseMs: 180000, maxActiveProbes: 2, localProcessMs: 30000, networkProcessMs: 25000,
        networkSocketMs: 20000, outputBytes: 65536, checkDetailBytes: 4096, phaseDetailBytes: 65536,
        configuredMcpOrigins: 3, configuredMcpMs: 60000 } }
  ])
});

export const targets = Object.freeze([
  { id: 'node', label: 'Node.js', binaries: ['node'], configDirs: [], origins: [] },
  { id: 'npm', label: 'npm', binaries: ['npm'], configDirs: [], origins: ['https://registry.npmjs.org'] },
  { id: 'git', label: 'Git', binaries: ['git'], configDirs: [], origins: [] },
  { id: 'claude', label: 'Claude Code', binaries: ['claude'], configDirs: ['.claude'], origins: [] },
  { id: 'codex', label: 'Codex CLI', binaries: ['codex'], configDirs: ['.codex'], origins: [] },
  { id: 'cursor', label: 'Cursor', binaries: ['cursor', 'cursor-agent', 'agent'], configDirs: ['.cursor'], origins: [] },
  { id: 'gemini', label: 'Gemini CLI', binaries: ['gemini'], configDirs: ['.gemini'], origins: [] },
  { id: 'copilot', label: 'GitHub Copilot', binaries: ['copilot'], configDirs: ['.config/github-copilot', '.copilot'], origins: [] },
  { id: 'windsurf', label: 'Windsurf', binaries: ['windsurf'], configDirs: ['.codeium/windsurf', '.windsurf'], origins: [] },
  { id: 'opencode', label: 'OpenCode', binaries: ['opencode'], configDirs: ['.config/opencode', '.opencode'], origins: [] },
  { id: 'kimi', label: 'Kimi Code', binaries: ['kimi'], configDirs: ['.kimi-code'], origins: [] },
  { id: 'kiro', label: 'Kiro', binaries: ['kiro-cli'], configDirs: ['.kiro'], origins: ['https://kiro.dev'] }
]);
