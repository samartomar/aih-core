// Portable trust definitions and admission metadata: no host observation or Node imports.
import { userToolsRepair } from './user-trust-definitions.mjs';
import { jvmRepair } from './jvm-trust-definitions.mjs';
// Static raw admission data, excluded from every evidence subject; it is imported only to associate variants.
import { trustCellRecords } from './trust-capabilities.mjs';

export const repairDefinitionSchema11 = 'urn:aihq:harness:repair:1.1.0';
export const trustCapabilitiesSchema = 'urn:aihq:harness:trust-capabilities:1.0.0';
export const repairRequestSchema = 'urn:aihq:core:repair-request:1.0.0';
export const certificateExportRequestSchema = 'urn:aihq:core:certificate-export-request:1.0.0';

export const trustLimits = Object.freeze({
  candidateIncidences: 4096, combinedIncidences: 4096, derBytes: 8388608, certificateBytes: 65536,
  suppliedSources: 32, outputBytes: 12582912, custodyBytes: 1048576
});
const sourceLimits = Object.freeze({ sourceBytes: 1048576, certificateBlocks: 256, blockBytes: 65536 });

// Fixed installed implementations that a definition may name. The identifier alone is not
// code integrity: the helper manifest binds the referenced module bytes.
export const trustAdapters = Object.freeze([
  Object.freeze({ id: 'repair-native-v1', modules: Object.freeze(['trust.mjs', 'trust-source.mjs', 'trust-encoding.mjs', 'trust-os.mjs']) }),
  Object.freeze({ id: 'repair-file-v1', modules: Object.freeze(['trust.mjs', 'trust-source.mjs', 'trust-encoding.mjs', 'trust-os.mjs']) }),
  Object.freeze({ id: 'certificate-export-v1', modules: Object.freeze(['trust.mjs', 'trust-source.mjs', 'trust-encoding.mjs', 'trust-os.mjs']) })
]);

export const consumerProfiles = Object.freeze({ pem: 'pem-server-ca-v1', 'pkcs7-der': 'pkcs7-certificate-import-v1' });
export const trustPlatformMatrix = Object.freeze([
  Object.freeze({ os: 'win32', release: 'Windows 11 25H2', architecture: 'x64', projection: 'windows-effective-server-auth-v1' }),
  Object.freeze({ os: 'darwin', release: 'macOS 26', architecture: 'arm64', projection: 'macos-effective-server-auth-v1' }),
  Object.freeze({ os: 'linux', release: 'Ubuntu 24.04 LTS', architecture: 'x64', projection: 'ubuntu-24.04-system-openssl-v1' })
]);

const FAMILIES = Object.freeze({
  'node-npm-ca': { targets: ['node', 'npm'], managementId: 'node-npm-trust', materialName: 'trust.pem' },
  'user-tools-ca': { targets: ['python', 'pip', 'git', 'cargo', 'conda'], managementId: 'user-tools-trust', materialName: 'trust.pem' },
  'jvm-ca': { targets: ['gradle', 'maven'], managementId: 'jvm-trust', materialName: 'trust.pem' },
  'certificate-export': { targets: [], managementId: null, materialName: null }
});
const OSES = ['win32', 'darwin', 'linux'];
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Definitions contain JSON data and must initialize in portable runtimes
// without requiring the optional structuredClone host API.
const cloneDefinition = value => JSON.parse(JSON.stringify(value));

const freezeDeep = value => {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freezeDeep(item); Object.freeze(value); }
  return value;
};

// Existing 1.0 node-npm-ca variant shape, reproduced from the published repair index.
function nodeNpmVariants() {
  return OSES.flatMap(os => [['node'], ['npm'], ['node', 'npm']].flatMap(targets =>
    ['declared', 'off'].map(network => ({ os,
      architectures: os === 'darwin' ? ['arm64', 'x64'] : ['x64', 'arm64'], targets: [...targets], network,
      recipeRef: `node-npm-ca/${os}/${targets.join('+')}/${network}`, transformId: 'node-npm-ca-bindings' }))));
}

const fileVariant = (variant, inputIds) => {
  const { candidate: _candidate, ...kept } = variant;
  return { ...cloneDefinition(kept), route: 'file', adapterId: 'repair-file-v1', inputIds: [...inputIds], capabilityIds: [] };
};
// A native variant carries no admitted capability: it makes "native unavailable" a real 1.1 selection result.
const nativeVariant = variant => ({ ...cloneDefinition(variant), route: 'native', adapterId: 'repair-native-v1',
  recipeRef: `${variant.recipeRef}/native`, inputIds: [], capabilityIds: [] });
const withNative = variants => [...variants, ...variants.map(nativeVariant)];

/** A cell belongs to a variant by definition, route, OS, architecture, target membership and network. */
export const cellMatchesVariant = (definitionId, variant, cell) => cell.definitionId === definitionId && cell.route === variant.route &&
  cell.platform?.os === variant.os && variant.architectures.includes(cell.platform?.architecture) && cell.network === variant.network &&
  (variant.route === 'export' ? cell.target === null : variant.targets.includes(cell.target));

function buildDefinitions(cells) {
  const node = { id: 'node-npm-ca', description: 'Add supplied CA certificates to user-scope Node and npm trust',
    inputs: {}, variants: withNative(nodeNpmVariants().map(variant => fileVariant(variant, []))),
    offlineVerification: [{ target: 'node', operationId: 'node-config', checkId: 'node-tls' },
      { target: 'npm', operationId: 'npm-config', checkId: 'npm-behavior' }] };
  const user = { id: userToolsRepair.id, description: userToolsRepair.description, inputs: {},
    variants: withNative(userToolsRepair.variants.map(variant => fileVariant(variant, []))),
    offlineVerification: userToolsRepair.offlineVerification.map(item => ({ ...item })) };
  const { caFile: _jvmCaFile, ...jvmInputs } = jvmRepair.inputs;
  const jvm = { id: jvmRepair.id, description: jvmRepair.description, inputs: cloneDefinition(jvmInputs),
    variants: withNative(jvmRepair.variants.map(variant => fileVariant(variant, ['baselineStore']))),
    offlineVerification: jvmRepair.offlineVerification.map(item => ({ ...item })) };
  const exported = { id: 'certificate-export', description: 'Export the complete suitable OS trust set as a certificate bundle',
    inputs: {}, offlineVerification: [], variants: OSES.flatMap(os => ['declared', 'off'].map(network => ({ os,
      architectures: ['x64', 'arm64'], targets: [], network, recipeRef: `certificate-export/${os}/${network}`,
      transformId: 'certificate-export-bindings', route: 'export', adapterId: 'certificate-export-v1',
      inputIds: [], capabilityIds: [] }))) };
  // Empty capabilityIds means no admitted cell; otherwise exactly the matching cells, in cell order.
  for (const base of [node, user, jvm, exported]) for (const variant of base.variants)
    variant.capabilityIds = cells.filter(cell => cellMatchesVariant(base.id, variant, cell)).map(cell => cell.id);
  return [node, user, jvm, exported].map(base => freezeDeep({
    id: base.id, description: base.description, schema: repairDefinitionSchema11, scope: 'user',
    managementId: FAMILIES[base.id].managementId, materialName: FAMILIES[base.id].materialName,
    targets: [...FAMILIES[base.id].targets], inputs: base.inputs, limits: { ...sourceLimits },
    trustLimits: { ...trustLimits }, offlineVerification: base.offlineVerification, variants: base.variants }));
}

/** Definitions whose variants name the given admitted cells. Native and file variants keep empty capabilityIds
 * unless a matching cell is admitted, so an unproven route selects a real definition and reports unavailable. */
export const buildTrustDefinitions = (cells = []) => Object.freeze(buildDefinitions(cells));
export const trustRepairIndex = buildTrustDefinitions(trustCellRecords);

/** Cell records live in trust-capabilities.mjs, outside every evidence subject file; none is admitted without published evidence. */
export function buildTrustCapabilities(packageIdentity, cells = []) {
  return freezeDeep({ schema: trustCapabilitiesSchema,
    package: { name: packageIdentity.name, version: packageIdentity.version }, cells: cloneDefinition(cells) });
}

// Fixed profile implementations. Each entry names the installed files whose bytes it depends on and
// the proof cases an acceptance record must report as passed before a cell may claim it.
const exportLimitations = Object.freeze(['no-os-fullset-claim', 'no-native-client-claim']);
const cases = (prefix, windowsImport) => Object.freeze([
  ['positive', 'deterministic-bytes'], ['positive', 'independent-parse-set'], ['positive', 'public-api-write'],
  ...(windowsImport ? [['positive', 'custom-store-import', 'win32']] : []),
  ['negative', 'reject-key-material'], ['negative', 'reject-output-extension-mismatch'], ['negative', 'reject-unsafe-path'],
  ...(windowsImport ? [['negative', 'serializer-failure-unavailable']] : []),
  ['persistence', 'custody-recorded'], ['persistence', 'refresh-replace-reviewed'], ['persistence', 'removal-reconciled']
].map(([kind, id, os]) => Object.freeze({ id: `${prefix}-${id}`, kind, ...(os ? { os } : {}) })));
export const trustProfiles = Object.freeze({
  'pem-server-ca-v1': Object.freeze({ kind: 'configuration', definitionId: 'certificate-export', route: 'export', format: 'pem',
    files: Object.freeze(['dist/harness/trust-encoding.mjs']), libraries: false }),
  'pkcs7-certificate-import-v1': Object.freeze({ kind: 'configuration', definitionId: 'certificate-export', route: 'export', format: 'pkcs7-der',
    files: Object.freeze(['dist/harness/trust-encoding.mjs']), libraries: true }),
  'export-pem-parse-v1': Object.freeze({ kind: 'probe', definitionId: 'certificate-export', route: 'export', configuration: 'pem-server-ca-v1',
    files: Object.freeze(['dist/harness/trust-encoding.mjs', 'dist/harness/trust-source.mjs']), libraries: false,
    requiredCases: cases('pem', false), requiredLimitations: exportLimitations }),
  'export-p7b-parse-v1': Object.freeze({ kind: 'probe', definitionId: 'certificate-export', route: 'export', configuration: 'pkcs7-certificate-import-v1',
    files: Object.freeze(['dist/harness/trust-encoding.mjs', 'dist/harness/trust-source.mjs']), libraries: true,
    requiredCases: cases('p7b', true), requiredLimitations: exportLimitations })
});

const TRANSFORMS = Object.freeze({ 'node-npm-ca': 'node-npm-ca-bindings', 'user-tools-ca': 'user-tools-ca-bindings',
  'jvm-ca': 'jvm-ca-bindings', 'certificate-export': 'certificate-export-bindings' });
export const trustTransformIds = Object.freeze(Object.values(TRANSFORMS));
const ROUTE_ADAPTER = Object.freeze({ file: 'repair-file-v1', native: 'repair-native-v1', export: 'certificate-export-v1' });
const ROUTE_KIND = Object.freeze({ file: 'shipped', native: 'native-unavailable', export: 'export-generator' });

let recipeRefs;
/** Every recipe reference resolves to exactly one fixed implementation kind; nothing else resolves. */
export function resolveTrustRecipeRef(recipeRef) {
  recipeRefs ??= new Map(trustRepairIndex.flatMap(definition => definition.variants.map(variant =>
    [variant.recipeRef, Object.freeze({ kind: ROUTE_KIND[variant.route], definitionId: definition.id, route: variant.route })])));
  return recipeRefs.get(recipeRef);
}

const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [null, Object.prototype].includes(Object.getPrototypeOf(value));
const diag = (reason, path, message) => ({ code: 'INPUT_INVALID', reason, message, path });
const exactKeys = (value, required, optional = []) => isPlain(value) &&
  required.every(key => Object.hasOwn(value, key)) &&
  Reflect.ownKeys(value).every(key => typeof key === 'string' && (required.includes(key) || optional.includes(key)));
const unique = values => new Set(values).size === values.length;
const plainText = (value, max) => typeof value === 'string' && value.length >= 1 && value.length <= max &&
  value.isWellFormed() && !/[\p{Cc}\p{Cf}]/u.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

const variantKey = variant => JSON.stringify([variant.route, variant.os, [...variant.architectures].sort(),
  variant.targets, variant.network]);

/** Strict structural validation of one repair definition 1.1 document. */
export function validateRepairDefinition11(value, options = {}) {
  const diagnostics = [];
  const bad = (reason, path, message) => diagnostics.push(diag(reason, path, message));
  const adapters = options.adapters ?? trustAdapters;
  const capabilities = options.capabilities;
  if (!exactKeys(value, ['id', 'description', 'schema', 'scope', 'managementId', 'materialName', 'variants',
    'targets', 'inputs', 'limits', 'trustLimits', 'offlineVerification'])) {
    bad('unknown-field', '', 'A 1.1 definition has exactly its published members.');
    return { valid: false, diagnostics };
  }
  if (value.schema !== repairDefinitionSchema11) bad('schema-unsupported', '/schema', 'Unsupported definition schema.');
  const family = Object.hasOwn(FAMILIES, value.id) ? FAMILIES[value.id] : undefined;
  if (!family) { bad('definition-id', '/id', 'Unknown definition ID.'); return { valid: false, diagnostics }; }
  const exported = value.id === 'certificate-export';
  if (value.scope !== 'user') bad('scope', '/scope', 'Scope is user.');
  if (!plainText(value.description, 512)) bad('description', '/description', 'Description is required text.');
  if (value.managementId !== family.managementId) bad('management-id', '/managementId', 'Management identity is fixed.');
  if (value.materialName !== family.materialName) bad('material-name', '/materialName', 'Material name is fixed.');
  const targetsOk = Array.isArray(value.targets) && unique(value.targets) &&
    value.targets.every(target => family.targets.includes(target)) &&
    (exported ? value.targets.length === 0 : value.targets.length === family.targets.length &&
      family.targets.every(target => value.targets.includes(target)));
  if (!targetsOk) bad('targets', '/targets', 'Targets follow the fixed family roster.');
  if (!isPlain(value.limits) || !exactKeys(value.limits, Object.keys(sourceLimits)) ||
      Object.entries(sourceLimits).some(([key, limit]) => value.limits[key] !== limit))
    bad('limits', '/limits', 'Source-file limits are fixed.');
  if (!exactKeys(value.trustLimits, Object.keys(trustLimits)) ||
      Object.entries(trustLimits).some(([key, limit]) => value.trustLimits[key] !== limit))
    bad('trust-limits', '/trustLimits', 'Trust limits are fixed.');
  const inputs = isPlain(value.inputs) ? value.inputs : undefined;
  if (!inputs || Object.hasOwn(inputs, 'caFile') || Object.keys(inputs).some(key => !identifier.test(key) ||
      !exactKeys(inputs[key], ['type', 'required', 'description'], ['maxLength']) ||
      !['file', 'string', 'boolean', 'number'].includes(inputs[key].type) || typeof inputs[key].required !== 'boolean' ||
      !plainText(inputs[key].description, 1024) ||
      Object.hasOwn(inputs[key], 'maxLength') && !(Number.isSafeInteger(inputs[key].maxLength) && inputs[key].maxLength >= 1)))
    bad('inputs', '/inputs', 'Inputs are declared scalar/file inputs without caFile.');
  if (exported && inputs && Object.keys(inputs).length) bad('inputs', '/inputs', 'Export declares no inputs.');
  if (!Array.isArray(value.offlineVerification) || value.offlineVerification.some(item =>
      !exactKeys(item, ['target', 'operationId', 'checkId']) || !plainText(item.target, 128) ||
      !plainText(item.operationId, 128) || !plainText(item.checkId, 128)))
    bad('offline-verification', '/offlineVerification', 'Offline verification entries are exact.');
  const variants = value.variants;
  if (!Array.isArray(variants) || variants.length < 1 || variants.length > 512) {
    bad('variants', '/variants', 'A definition has 1 to 512 variants.');
    return { valid: false, diagnostics };
  }
  const keys = new Set();
  variants.forEach((variant, index) => {
    const at = `/variants/${index}`;
    if (!exactKeys(variant, ['os', 'architectures', 'targets', 'network', 'recipeRef', 'transformId', 'route',
      'adapterId', 'inputIds', 'capabilityIds'], ['configFiles', 'executableBindings', 'requiredAbsences'])) {
      bad('unknown-field', at, 'A variant has exactly its published members.'); return;
    }
    if (!OSES.includes(variant.os)) bad('os', `${at}/os`, 'Unsupported OS.');
    if (!Array.isArray(variant.architectures) || !variant.architectures.length || !unique(variant.architectures) ||
        variant.architectures.some(item => !['x64', 'arm64'].includes(item))) bad('architectures', `${at}/architectures`, 'Architectures are unique x64/arm64.');
    if (!['declared', 'off'].includes(variant.network)) bad('network', `${at}/network`, 'Network is declared or off.');
    if (!['native', 'file', 'export'].includes(variant.route)) bad('route', `${at}/route`, 'Route is native, file or export.');
    if (variant.route === 'export' !== exported) bad('route', `${at}/route`, 'Export variants belong only to the export definition.');
    if (!Array.isArray(variant.targets) || !unique(variant.targets) ||
        (exported ? variant.targets.length !== 0 : !variant.targets.length || variant.targets.some(item => !family.targets.includes(item))))
      bad('targets', `${at}/targets`, 'Variant targets are a nonempty subset of the family, or empty for export.');
    if (!plainText(variant.recipeRef, 256)) bad('recipe-ref', `${at}/recipeRef`, 'recipeRef is required text.');
    if (typeof variant.transformId !== 'string' || !identifier.test(variant.transformId)) bad('transform-id', `${at}/transformId`, 'transformId uses the identifier grammar.');
    if (!adapters.some(adapter => adapter.id === variant.adapterId)) bad('adapter-id', `${at}/adapterId`, 'adapterId does not resolve to a fixed adapter.');
    const resolved = resolveTrustRecipeRef(variant.recipeRef);
    if (!resolved || resolved.definitionId !== value.id || resolved.route !== variant.route || resolved.kind !== ROUTE_KIND[variant.route] ||
        options.resolveRecipeRef && !options.resolveRecipeRef(variant.recipeRef)) bad('recipe-ref', `${at}/recipeRef`, 'recipeRef does not resolve to this definition and route.');
    if (variant.transformId !== TRANSFORMS[value.id]) bad('transform-id', `${at}/transformId`, 'transformId does not resolve for this definition.');
    if (variant.adapterId !== ROUTE_ADAPTER[variant.route]) bad('adapter-id', `${at}/adapterId`, 'adapterId does not match the route.');
    const inputIds = variant.inputIds;
    if (!Array.isArray(inputIds) || !unique(inputIds) || inputIds.some(id => typeof id !== 'string' || !identifier.test(id) ||
        !inputs || !Object.hasOwn(inputs, id))) bad('input-ids', `${at}/inputIds`, 'inputIds name declared inputs.');
    else {
      if (variant.route === 'native' && inputIds.includes('baselineStore')) bad('input-ids', `${at}/inputIds`, 'Native variants exclude baselineStore.');
      if (value.id === 'jvm-ca' && variant.route === 'file' && !inputIds.includes('baselineStore'))
        bad('input-ids', `${at}/inputIds`, 'JVM file variants require baselineStore.');
      if (exported && inputIds.length) bad('input-ids', `${at}/inputIds`, 'Export variants have no inputs.');
    }
    const ids = variant.capabilityIds;
    if (!Array.isArray(ids) || !unique(ids) || ids.some(id => typeof id !== 'string' || !identifier.test(id))) bad('capability-ids', `${at}/capabilityIds`, 'capabilityIds use the identifier grammar.');
    else if (capabilities) for (const id of ids) {
      const cell = capabilities.cells?.find(item => item.id === id);
      const platformOk = cell && cell.platform.os === variant.os && variant.architectures.includes(cell.platform.architecture) &&
        cell.network === variant.network;
      if (!cell || cell.definitionId !== value.id || cell.route !== variant.route || !platformOk ||
          (variant.route === 'export' ? cell.target !== null : !variant.targets.includes(cell.target)))
        bad('capability-ids', `${at}/capabilityIds`, 'A capability does not match its definition, route, target or platform.');
    }
    const key = variantKey(variant);
    if (keys.has(key)) bad('variant-duplicate', at, 'Variants are unique by route, OS, architectures, targets and network.');
    keys.add(key);
  });
  return { valid: diagnostics.length === 0, diagnostics };
}

/** Select by (request schema, repair ID, definition schema); never by first matching ID. */
export function selectRepairDefinition({ requestSchema, repairId, definitionSchema }, legacy = []) {
  if (definitionSchema === repairDefinitionSchema11) {
    if (requestSchema === repairRequestSchema && repairId !== 'certificate-export')
      return trustRepairIndex.find(item => item.id === repairId);
    if (requestSchema === certificateExportRequestSchema && repairId === 'certificate-export')
      return trustRepairIndex.find(item => item.id === 'certificate-export');
    return undefined;
  }
  if (requestSchema === undefined && definitionSchema === 'urn:aihq:harness:repair:1.0.0')
    return legacy.find(item => item.id === repairId);
  return undefined;
}

const cellStrings = ['release', 'version', 'build', 'backend', 'backendVersion'];
const relativeReference = value => typeof value === 'string' && plainText(value, 512) && !value.startsWith('/') &&
  !/^[A-Za-z]:|\\|(^|\/)\.\.?(\/|$)/.test(value);

/** Validate the admission document against the published shape. Evidence bytes are checked by the Node helper. */
export function validateTrustCapabilities(value, options = {}) {
  const diagnostics = [];
  const bad = (reason, path, message) => diagnostics.push(diag(reason, path, message));
  if (!exactKeys(value, ['schema', 'package', 'cells'])) return { valid: false, diagnostics: [diag('unknown-field', '', 'Admission metadata has exactly its published members.')] };
  if (value.schema !== trustCapabilitiesSchema) bad('schema-unsupported', '/schema', 'Unsupported admission schema.');
  if (!exactKeys(value.package, ['name', 'version']) || value.package.name !== '@aihq/core' || !plainText(value.package.version, 512) ||
      options.package && (value.package.name !== options.package.name || value.package.version !== options.package.version))
    bad('package-identity', '/package', 'Package identity must equal the installed distribution.');
  if (!Array.isArray(value.cells) || value.cells.length > 256) { bad('cells', '/cells', 'At most 256 cells.'); return { valid: false, diagnostics }; }
  try { if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 1048576) bad('size', '', 'Metadata is capped at 1 MiB.'); }
  catch { bad('size', '', 'Metadata is not serializable data.'); }
  const definitions = options.definitions ?? trustRepairIndex;
  const ids = new Set(); const tuples = new Set();
  value.cells.forEach((cell, index) => {
    const at = `/cells/${index}`;
    if (!exactKeys(cell, ['id', 'definitionId', 'route', 'target', 'platform', 'network', 'projection', 'client',
      'configurationProfile', 'probeProfile', 'launchContext', 'evidence'])) { bad('unknown-field', at, 'A cell has exactly its published members.'); return; }
    if (typeof cell.id !== 'string' || !identifier.test(cell.id) || ids.has(cell.id)) bad('cell-id', `${at}/id`, 'Cell IDs use the identifier grammar and are unique.');
    ids.add(cell.id);
    const definition = definitions.find(item => item.id === cell.definitionId);
    if (!definition) { bad('definition-id', `${at}/definitionId`, 'Unknown definition.'); return; }
    const exported = cell.definitionId === 'certificate-export';
    if (!['native', 'file', 'export'].includes(cell.route) || cell.route === 'export' !== exported) bad('route', `${at}/route`, 'Route does not match the definition.');
    if (exported ? cell.target !== null : !definition.targets.includes(cell.target)) bad('target', `${at}/target`, 'Target does not belong to the definition.');
    const platform = exactKeys(cell.platform, ['os', 'release', 'architecture']) ?
      trustPlatformMatrix.find(item => item.os === cell.platform.os && item.release === cell.platform.release &&
        item.architecture === cell.platform.architecture) : undefined;
    if (!platform) bad('platform', `${at}/platform`, 'The platform must be an initial tested matrix entry.');
    else if (cell.projection !== platform.projection) bad('projection', `${at}/projection`, 'The projection must match the platform.');
    if (!['declared', 'off'].includes(cell.network)) bad('network', `${at}/network`, 'Network is declared or off.');
    const configuration = Object.hasOwn(trustProfiles, cell.configurationProfile) ? trustProfiles[cell.configurationProfile] : undefined;
    const probe = Object.hasOwn(trustProfiles, cell.probeProfile) ? trustProfiles[cell.probeProfile] : undefined;
    if (configuration?.kind !== 'configuration' || configuration.definitionId !== cell.definitionId || configuration.route !== cell.route)
      bad('profile-unknown', `${at}/configurationProfile`, 'The configuration profile is not a fixed installed implementation for this definition and route.');
    if (probe?.kind !== 'probe' || probe.definitionId !== cell.definitionId || probe.route !== cell.route || probe.configuration !== cell.configurationProfile)
      bad('profile-unknown', `${at}/probeProfile`, 'The probe profile is not a fixed installed implementation for this configuration.');
    if (exported) {
      if (cell.client !== null || cell.launchContext !== 'no-client')
        bad('export-cell', at, 'Export cells have no client and a no-client context.');
    } else {
      const client = cell.client;
      if (!exactKeys(client, ['version', 'build', 'backend', 'backendVersion', 'applicationId']) ||
          cellStrings.slice(1).some(key => !plainText(client[key], 512)) ||
          client.applicationId !== null && !plainText(client.applicationId, 512)) bad('client', `${at}/client`, 'A client record is required for non-export cells.');
      if (cell.launchContext !== 'fresh-cli-user-home') bad('launch-context', `${at}/launchContext`, 'Only fresh-cli-user-home cells are admitted here.');
    }
    const evidence = cell.evidence;
    if (!exactKeys(evidence, ['reference', 'sha256', 'subjectSha256']) || !relativeReference(evidence.reference) ||
        !sha(evidence.sha256) || !sha(evidence.subjectSha256)) bad('evidence', `${at}/evidence`, 'Evidence requires a package-relative reference and digests.');
    const tuple = JSON.stringify([cell.definitionId, cell.route, cell.target, cell.platform, cell.network,
      cell.launchContext, exported ? cell.configurationProfile : null, cell.client?.version, cell.client?.build]);
    if (tuples.has(tuple)) bad('cell-ambiguous', at, 'Matching tuples are unique.');
    tuples.add(tuple);
    const variants = definition.variants.filter(variant => cellMatchesVariant(definition.id, variant, cell));
    if (!variants.length || !variants.every(variant => variant.capabilityIds.includes(cell.id)))
      bad('cell-unassociated', at, 'Every admitted cell must be named by each matching definition variant.');
  });
  // The reverse direction: a variant may name only admitted cells (validateRepairDefinition11 checks tuple agreement).
  for (const definition of definitions) definition.variants.forEach((variant, index) => {
    for (const id of variant.capabilityIds) if (!ids.has(id))
      bad('cell-unassociated', `/definitions/${definition.id}/variants/${index}`, 'A variant names a cell that is not admitted.');
  });
  return { valid: diagnostics.length === 0, diagnostics };
}

/** Select the admitted cell for one target. Absence is unavailable capability, never a support claim. */
export function selectTrustCell(query, capabilities, definitions = trustRepairIndex) {
  const unavailable = reason => ({ status: 'unavailable', code: 'PREREQUISITE_UNAVAILABLE', reason });
  const cells = capabilities?.cells ?? [];
  const wantRoute = query.route;
  const profile = query.format === undefined ? undefined : consumerProfiles[query.format];
  if (query.format !== undefined && !profile) return unavailable('trust-format-unavailable');
  const matches = cells.filter(cell => cell.definitionId === query.definitionId && cell.route === wantRoute &&
    cell.target === (query.target ?? null) && cell.platform.os === query.platform?.os &&
    cell.platform.release === query.platform?.release && cell.platform.architecture === query.platform?.architecture &&
    cell.network === query.network && (profile === undefined || cell.configurationProfile === profile));
  if (matches.length > 1) return unavailable('trust-configuration-unavailable');
  if (matches.length === 1) {
    // The chosen variant must name the cell: a matching but unassociated cell is not an admission.
    const [cell] = matches;
    const variants = definitions.find(item => item.id === query.definitionId)?.variants.filter(variant => cellMatchesVariant(query.definitionId, variant, cell)) ?? [];
    if (variants.length && variants.every(variant => variant.capabilityIds.includes(cell.id))) return { status: 'admitted', cell };
    return unavailable('trust-configuration-unavailable');
  }
  if (wantRoute === 'native') return unavailable('native-route-unsupported');
  if (wantRoute === 'file') return unavailable('file-route-unsupported');
  return unavailable('trust-platform-unsupported');
}

const literal = value => ({ literal: value });
export const exportDefaultNames = Object.freeze({ pem: 'os-ca.pem', 'pkcs7-der': 'os-ca.p7b' });

/** Fixed recipe 1.0 for one export output. Core supplies the generated material descriptor. */
export function buildCertificateExportRecipe({ materialId, materialPath, outputSegments, sha256, byteLength }) {
  const target = { root: 'userHome', segments: outputSegments.map(literal) };
  return {
    schema: 'urn:aihq:core:recipe:1.0.0', id: 'certificate-export',
    description: 'Write the complete reviewed OS trust export to a user-home file',
    inputs: {},
    materials: [{ id: materialId, source: { kind: 'local', input: 'generated-export' }, path: materialPath, sha256, byteLength }],
    targets: ['user'], prerequisites: [],
    operations: [{ id: 'write-ca', purpose: 'Write the reviewed certificate export', kind: 'file.write', scope: 'user',
      target, material: materialId, mode: 0o600, requires: [], checks: ['export-digest'] }],
    checks: [{ id: 'export-digest', purpose: 'Check the exported file bytes', kind: 'file.sha256', target, sha256 }]
  };
}

/** Candidate (not admitted) export cell skeleton and the proof a record must contain; evidence digests stay unset. */
export function exportAdmissionTemplate(format, platform = trustPlatformMatrix[0]) {
  const configurationProfile = consumerProfiles[format];
  const probe = Object.entries(trustProfiles).find(([, item]) => item.kind === 'probe' && item.configuration === configurationProfile);
  if (!configurationProfile || !probe) return undefined;
  return { cell: { id: `export-${format === 'pem' ? 'pem' : 'p7b'}-${platform.os}`, definitionId: 'certificate-export', route: 'export', target: null,
      platform: { os: platform.os, release: platform.release, architecture: platform.architecture }, network: 'declared',
      projection: platform.projection, client: null, configurationProfile, probeProfile: probe[0], launchContext: 'no-client' },
    requiredCases: probe[1].requiredCases.filter(item => !item.os || item.os === platform.os).map(item => ({ ...item })),
    requiredLimitations: [...probe[1].requiredLimitations] };
}

/** Fixed file-route integration for supplied-file repairs; only Node/npm is integrated today. */
export function getTrustFileIntegration(definitionId, targets) {
  const unavailable = { status: 'unavailable', code: 'PREREQUISITE_UNAVAILABLE', reason: 'file-route-unsupported' };
  if (definitionId !== 'node-npm-ca' || !Array.isArray(targets) || !targets.length || new Set(targets).size !== targets.length ||
      targets.some(target => !FAMILIES['node-npm-ca'].targets.includes(target))) return unavailable;
  // npm's cafile replaces its bundled defaults, so the Node-bundled partition rides with npm.
  return { status: 'supported', format: 'pem', includeNodeBundled: targets.includes('npm') };
}
