// Portable fixed definitions: no host observation or Node imports.
const targetIds = ['python', 'pip', 'git', 'cargo', 'conda'];
const subsets = Array.from({ length: 31 }, (_, i) => targetIds.filter((_, bit) => (i + 1) & (1 << bit)));
const literal = value => ({ literal: value });
const file = (operationId, segments) => Object.freeze({ operationId,
  target: Object.freeze({ root: 'userHome', segments: Object.freeze(segments.map(value => Object.freeze(literal(value)))) }),
  maxBytes: 1048576 });
export const userToolsRepair = Object.freeze({
  id: 'user-tools-ca', description: 'Add supplied CA certificates to selected existing Python, pip, Git, Cargo and conda user trust',
  schema: 'urn:aihq:harness:repair:1.0.0', scope: 'user', managementId: 'user-tools-trust', materialName: 'trust.pem',
  targets: Object.freeze(targetIds),
  inputs: Object.freeze({ caFile: Object.freeze({ type: 'file', required: true, description: 'Certificate-only PEM file' }) }),
  limits: Object.freeze({ sourceBytes: 1048576, certificateBlocks: 256, blockBytes: 65536 }),
  variants: Object.freeze(['win32', 'darwin', 'linux'].flatMap(os => subsets.flatMap(targets =>
    ['declared', 'off'].map(network => Object.freeze({ os, architectures: Object.freeze(['x64', 'arm64']),
      targets: Object.freeze([...targets]), network, recipeRef: `user-tools-ca/${os}/${targets.join('+')}/${network}`,
      executableBindings: Object.freeze(network === 'off' ? [] : [
        ...(targets.includes('pip') ? [Object.freeze({ name: 'pip', pathInput: 'pipExecutable' })] : []),
        ...(targets.includes('git') ? [Object.freeze({ name: 'git', pathInput: 'gitExecutable' })] : [])]),
      transformId: 'user-tools-ca-bindings', configFiles: Object.freeze([
        ...(targets.includes('pip') ? [file('pip-config', os === 'win32' ? ['AppData', 'Roaming', 'pip', 'pip.ini'] : ['.config', 'pip', 'pip.conf'])] : []),
        ...(targets.includes('git') ? [file('git-config', ['.gitconfig'])] : []),
        ...(targets.includes('cargo') ? [file('cargo-config', ['.cargo', 'config.toml'])] : []),
        ...(targets.includes('conda') ? [file('conda-config', ['.condarc'])] : [])
      ]) }))))),
  offlineVerification: Object.freeze(targetIds.map(target => Object.freeze({ target,
    operationId: `${target}-config`, checkId: `${target}-behavior` })))
});
