import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { contractSupport as core } from '@aihq/core/contracts';
import { contractSupport as harness } from '@aihq/core/harness';
import { contractSupport as catalog } from '@aihq/catalog/contracts';
import { contractSupport as scan } from '@aihq/scan/contracts';

export async function auditInstalledPackages(root) {
  const declarations = { core, harness, catalog, scan };
  const schemas = new Map();
  for (const [name, declaration] of Object.entries(declarations)) {
    assert.equal(declaration.schema, 'urn:aihq:package-support:1.0.0', name);
    const packageRoot = join(root, 'node_modules', declaration.package.name);
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    assert.deepEqual(declaration.package, { name: manifest.name, version: manifest.version });
    assert.equal(manifest.engines.node, '>=24.15.0 <25');
    for (const entry of declaration.entries) {
      assert.equal(entry.runtime === 'portable' || entry.runtime === 'node', true);
      if (entry.runtime === 'node') assert.equal(entry.nodeRange, manifest.engines.node);
      else assert.equal(entry.nodeRange, undefined);
      await import(entry.export);
    }
    for (const contract of declaration.contracts) {
      assert.ok(['accepts', 'produces', 'both'].includes(contract.role));
      const schema = (await import(contract.schemaExport, { with: { type: 'json' } })).default;
      assert.equal(schema.$id, contract.id, contract.schemaExport);
      assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
      schemas.set(contract.schemaExport, schema.$id);
    }
    for (const file of files(packageRoot)) {
      assert.equal(/(?:^|\/)(?:AGENTS\.md|GLOSSARY-MAP\.md|\.scratch|docs\/agents|docs\/plans|docs\/specs)(?:\/|$)/.test(file), false, file);
      if (/\.(?:m?js|cjs|ts|mts|json|md|map)$/.test(file)) {
        const text = readFileSync(join(packageRoot, file), 'utf8');
        assert.equal(/[A-Za-z]:[\\/](?:Users|dev)[\\/]/.test(text), false, `${name}/${file}`);
      }
    }
  }
  assert.deepEqual(harness.package, core.package);
  assert.equal(existsSync(join(root, 'node_modules/@aihq/harness')), false);
  const coreManifest = JSON.parse(readFileSync(join(root, 'node_modules/@aihq/core/package.json'), 'utf8'));
  for (const name of ['@aihq/harness', '@aihq/catalog', '@aihq/scan']) assert.equal(coreManifest.dependencies[name], undefined);
  return { packages: Object.fromEntries(Object.entries(declarations).map(([name, value]) => [name, value.package])),
    schemas: Object.fromEntries(schemas), nodeRange: '>=24.15.0 <25', noSeparateHarness: true, privateFilesExcluded: true };
}

function files(root, prefix = '') {
  return readdirSync(join(root, prefix)).flatMap(name => {
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(join(root, relative));
    assert.equal(stat.isSymbolicLink(), false, relative);
    return stat.isDirectory() ? files(root, relative) : [relative];
  });
}
