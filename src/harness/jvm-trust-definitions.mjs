// Portable fixed definitions: no host observation or Node imports.
const targetIds = ['gradle', 'maven'];
const subsets = [['gradle'], ['maven'], ['gradle', 'maven']];
const literal = value => ({ literal: value });
const file = (operationId, segments) => Object.freeze({ operationId,
  target: Object.freeze({ root: 'userHome', segments: Object.freeze(segments.map(value => Object.freeze(literal(value)))) }),
  maxBytes: 1048576 });
export const jvmRepair = Object.freeze({
  id: 'jvm-ca', description: 'Add supplied CA certificates to selected existing Gradle and Maven user JVM trust',
  schema: 'urn:aihq:harness:repair:1.0.0', scope: 'user', managementId: 'jvm-trust', materialName: 'trust.pem',
  targets: Object.freeze(targetIds),
  inputs: Object.freeze({
    caFile: Object.freeze({ type: 'file', required: true, description: 'Certificate-only PEM file' }),
    baselineStore: Object.freeze({ type: 'file', required: true,
      description: 'Selected JDK baseline truststore (JKS with the conventional public container password)' })
  }),
  limits: Object.freeze({ sourceBytes: 1048576, certificateBlocks: 256, blockBytes: 65536 }),
  variants: Object.freeze(['win32', 'darwin', 'linux'].flatMap(os => subsets.flatMap(targets =>
    ['declared', 'off'].map(network => Object.freeze({ os, architectures: Object.freeze(['x64', 'arm64']),
      targets: Object.freeze([...targets]), network, recipeRef: `jvm-ca/${os}/${targets.join('+')}/${network}`,
      // Materialization always needs keytool; behavior checks need java and the selected managers.
      // Managers are launcher scripts (Gradle .bat/.cmd or shell, Maven mvn/mvn.cmd): Core captures
      // their bytes/pins read-only through kind 'launcher'; they are never direct executables.
      executableBindings: Object.freeze([
        Object.freeze({ name: 'keytool', pathInput: 'keytoolExecutable' }),
        ...(network === 'off' ? [] : [
          Object.freeze({ name: 'java', pathInput: 'javaExecutable' }),
          ...(targets.includes('gradle') ? [Object.freeze({ name: 'gradle', pathInput: 'gradleExecutable', kind: 'launcher' })] : []),
          ...(targets.includes('maven') ? [Object.freeze({ name: 'mvn', pathInput: 'mavenExecutable', kind: 'launcher' })] : [])])]),
      transformId: 'jvm-ca-bindings', configFiles: Object.freeze([
        ...(targets.includes('gradle') ? [file('gradle-config', ['.gradle', 'gradle.properties'])] : []),
        ...(targets.includes('maven') ? [file('maven-config', os === 'win32' ? ['mavenrc_pre.cmd'] : ['.mavenrc'])] : []),
        // Windows mvn.cmd sources mavenrc_pre.bat BEFORE our mavenrc_pre.cmd, then mavenrc_post.bat
        // and mavenrc_post.cmd afterwards; trust options there would silently override or be overridden
        // unpredictably. They are pinned and inspected, never written. (mavenrc.cmd/bat are never read.)
        ...(targets.includes('maven') && os === 'win32' ? [
          file('maven-rc-late-pre-bat', ['mavenrc_pre.bat']),
          file('maven-rc-late-post-cmd', ['mavenrc_post.cmd']),
          file('maven-rc-late-post-bat', ['mavenrc_post.bat'])] : [])
      ]) }))))),
  offlineVerification: Object.freeze(targetIds.map(target => Object.freeze({ target,
    operationId: `${target}-config`, checkId: `${target}-behavior` })))
});
