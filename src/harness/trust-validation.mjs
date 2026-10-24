// Public refusal detail stays outside the byte-bound, previously admitted trust helpers.
import { Ajv2020 } from 'ajv/dist/2020.js';
import repair11 from './schemas/repair/1.1.0.json' with { type: 'json' };
import repair12 from './schemas/repair/1.2.0.json' with { type: 'json' };
import capabilities from './schemas/trust-capabilities/1.0.0.json' with { type: 'json' };
import { validateRepairDefinition11 as validateRepair11, validateTrustCapabilities as validateCapabilities } from './trust-definitions.mjs';
import { validateRepairDefinition12 as validateRepair12 } from './macos-session-definitions.mjs';
import { pointerMember, unsupportedFormat } from './native/canonical.mjs';
import { snapshotTrustData } from './trust-data.mjs';

let registry;
function schemaCheck(schema) {
  if (!registry) registry = new Ajv2020({ allErrors: true, strict: true });
  return registry.getSchema(schema.$id) ?? registry.compile(schema);
}

function validatePublic(value, options, schema, validate) {
  const unsupported = unsupportedFormat(value, [schema.$id]);
  if (unsupported) return { valid: false, diagnostics: [unsupported] };
  // The admitted validator remains authoritative for validity and semantic reasons.
  const result = validate(value, options);
  if (result.valid) return result;
  let safe;
  try { safe = snapshotTrustData(value); } catch { return result; }
  const check = schemaCheck(schema);
  check(safe);
  const unknownFields = (check.errors ?? []).filter(error => error.keyword === 'additionalProperties');
  return { ...result, diagnostics: result.diagnostics.map(diagnostic => {
    const base = diagnostic.path ?? '';
    const field = unknownFields.find(error => error.instancePath === base || error.instancePath.startsWith(base + '/'));
    return field ? { ...diagnostic, path: field.instancePath + '/' + pointerMember(field.params.additionalProperty) } : diagnostic;
  }) };
}

export const validateRepairDefinition11 = (value, options = {}) => validatePublic(value, options, repair11, validateRepair11);
export const validateRepairDefinition12 = (value, options = {}) => validatePublic(value, options, repair12, validateRepair12);
export const validateTrustCapabilities = (value, options = {}) => validatePublic(value, options, capabilities, validateCapabilities);
