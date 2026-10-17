import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { contractSupport as core } from '@aihq/core/contracts';
import { contractSupport as harness } from '@aihq/core/harness';
import { contractSupport as catalog } from '@aihq/catalog/contracts';
import { contractSupport as scan } from '@aihq/scan/contracts';

export async function auditInstalledPackages(root) {
  const declarations = { core, harness, catalog, scan };
  const schemas = new Map();
  let materialCount = 0;
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
    // Roles are recorded, not asserted here: the gate validates each whole
    // declaration against Core's installed package-support schema.
    for (const contract of declaration.contracts) {
      const schema = (await import(contract.schemaExport, { with: { type: 'json' } })).default;
      assert.equal(schema.$id, contract.id, contract.schemaExport);
      assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
      schemas.set(contract.schemaExport, schema.$id);
    }
    // Pinned third-party content a shipped release declares (path and digest) is
    // release material, not the package's own engineering files.
    const materials = declaredMaterials(packageRoot, manifest);
    for (const file of files(packageRoot)) {
      const material = materials.has(file) && materials.get(file) === sha256(readFileSync(join(packageRoot, file)));
      if (material) materialCount++;
      else assert.equal(/(?:^|\/)(?:AGENTS\.md|GLOSSARY-MAP\.md|\.scratch|docs\/agents|docs\/plans|docs\/specs)(?:\/|$)/.test(file), false, file);
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
    schemas: Object.fromEntries(schemas), nodeRange: '>=24.15.0 <25', noSeparateHarness: true, privateFilesExcluded: true, declaredMaterialFiles: materialCount,
    roles: Object.fromEntries(Object.entries(declarations).map(([name, value]) =>
      [name, [...new Set(value.contracts.map(contract => contract.role))].sort()])),
    declarations: JSON.parse(JSON.stringify(declarations)) };
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function declaredMaterials(packageRoot, manifest) {
  const declared = new Map();
  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    if (!/^\.\/release[\w-]*\.json$/.test(subpath) || typeof target !== 'string') continue;
    const document = JSON.parse(readFileSync(join(packageRoot, target), 'utf8'));
    for (const item of document.items ?? []) for (const member of item.materials ?? []) declared.set(member.path, member.sha256);
  }
  return declared;
}

function files(root, prefix = '') {
  return readdirSync(join(root, prefix)).flatMap(name => {
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(join(root, relative));
    assert.equal(stat.isSymbolicLink(), false, relative);
    return stat.isDirectory() ? files(root, relative) : [relative];
  });
}
