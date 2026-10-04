import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { prepare, apply } from '../dist/core/index.js';
import { trustCapabilities } from '../dist/harness/contracts.mjs';
import { detectTrustPlatform } from '../dist/harness/runtime.mjs';
import { policy as unrelatedPolicy } from './fixture.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const historical = [
  ['pre-hook', '225888273cb9b6e6222068277fbb4947b62ee313'],
  ['hook-capable', 'cf16fe3fdf1cebc2b68b687ccbff56f978fe72c7']
];
const platform = detectTrustPlatform();
const admitted = trustCapabilities.cells.some(cell => cell.route === 'export' && cell.configurationProfile === 'pem-server-ca-v1' &&
  cell.platform.os === platform.os && cell.platform.release === platform.release && cell.platform.architecture === platform.architecture && cell.network === 'off');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('packed pre-hook and hook-capable Core retain unrelated work and later overwrites remain visible', {
  skip: !admitted && 'This exact platform has no admitted export profile; no downgrade export proof is claimed.'
}, async () => {
  assert.ok(process.env.npm_execpath, 'Use npm test for packed acceptance.');
  const scratch = mkdtempSync(join(tmpdir(), 'aih-trust-downgrade-'));
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key];
  const npm = (args, cwd) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
    cwd, env, encoding: 'utf8', timeout: 120_000, windowsHide: true
  });
  try {
    for (const [label, commit] of historical) {
      assert.equal(spawnSync('git', ['-C', source, 'cat-file', '-e', `${commit}^{commit}`]).status, 0, `Missing ${label} history.`);
      const archiveRoot = join(scratch, label), consumer = join(scratch, `${label}-consumer`);
      const home = join(scratch, `${label}-home`), project = join(scratch, `${label}-project`);
      for (const path of [archiveRoot, consumer, home, project]) mkdirSync(path);
      const archive = execFileSync('git', ['-C', source, 'archive', '--format=tar', commit], { maxBuffer: 256 * 1024 * 1024 });
      const extract = spawnSync('tar', ['-xf', '-'], { cwd: archiveRoot, input: archive });
      assert.equal(extract.status, 0, String(extract.stderr));
      // Build each historical binary with its own locked dependency closure.
      // A junction to today's installation can omit transitive bundled members
      // when npm packs an older package graph.
      npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], archiveRoot);
      execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: archiveRoot, env, timeout: 120_000, windowsHide: true });
      const packed = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], archiveRoot))[0];
      writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: {
        '@aihq/core': `file:${join(scratch, packed.filename)}`
      } }));
      npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], consumer);
      assert.ok(existsSync(join(consumer, 'node_modules/@aihq/core/dist/core/index.js')));
      process.env.HOME = home; process.env.USERPROFILE = home;
      const file = join(scratch, `${label}.pem`);
      writeFileSync(file, readFileSync(new URL('./fixtures/root-a.pem', import.meta.url)));
      const request = { schema: 'urn:aihq:core:certificate-export-request:1.0.0', useCase: 'certificate-export', network: 'off',
        sources: { os: false, supplied: [{ id: 'team', file }] } };
      const prepared = await prepare(request, { logging: 'off' });
      assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
      assert.equal((await apply(prepared.prepared, { approved: true, origin: 'automation', reviewDigest: prepared.review.reviewDigest }, { logging: 'off' })).completion, 'complete');
      const output = prepared.review.inputs.trust.outputs[0];
      writeFileSync(join(consumer, 'old-api.mjs'), `
        import {readFileSync} from 'node:fs';
        import {prepare,apply} from '@aihq/core';
        const p=await prepare({useCase:'policy',policy:JSON.parse(readFileSync(process.argv[2],'utf8')),target:{project:process.argv[3]}},{logging:'off'});
        const r=p.prepared?await apply(p.prepared,{approved:true,origin:'automation',reviewDigest:p.review.reviewDigest},{logging:'off'}):p;
        console.log(JSON.stringify(r));
      `);
      const runOld = value => {
        const input = join(consumer, 'policy.json'); writeFileSync(input, JSON.stringify(value));
        const result = spawnSync(process.execPath, ['old-api.mjs', input, project], { cwd: consumer,
          env: { ...env, HOME: home, USERPROFILE: home }, encoding: 'utf8', timeout: 30_000, windowsHide: true });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        return JSON.parse(result.stdout);
      };
      assert.equal(runOld(unrelatedPolicy()).completion, 'complete', `${label} unrelated policy remains usable.`);
      const before = readFileSync(output.path);
      const replacement = readFileSync(new URL('./harness/fixtures/root-b.pem', import.meta.url), 'utf8');
      const overwrite = { schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe', selections: [{ id: 'export',
        managementId: output.managementId, scope: 'user', configuration: {}, requires: [], recipe: { inline: {
          schema: 'urn:aihq:core:recipe:1.0.0', id: 'old-export-write', description: 'Historical binary overwrite fixture',
          inputs: {}, materials: [], targets: ['user'], prerequisites: [], operations: [{ id: 'write-ca', purpose: 'Write fixture',
            kind: 'file.write', scope: 'user', target: { root: 'userHome', segments: ['.aih', 'exports', 'os-ca.pem'].map(literal => ({ literal })) },
            content: { literal: replacement }, requires: [], checks: ['digest'] }], checks: [{ id: 'digest', purpose: 'Check fixture', kind: 'file.sha256',
              target: { root: 'userHome', segments: ['.aih', 'exports', 'os-ca.pem'].map(literal => ({ literal })) }, sha256: sha(replacement) }]
        } } }] };
      assert.equal(runOld(overwrite).completion, 'complete', `${label} can write its ordinary receipt format.`);
      assert.notDeepEqual(readFileSync(output.path), before);
      const returned = await prepare(request, { logging: 'off' });
      assert.equal(returned.status, 'blocked', JSON.stringify(returned));
      assert.ok(returned.diagnostics.some(item => ['trust-output-conflict', 'trust-custody-conflict'].includes(item.reason)));
      assert.ok(returned.review.observations.some(item => item.id === 'recorded-trust-custody'));
      assert.equal(readFileSync(output.path, 'utf8'), replacement, 'Returning to new Core preserves the changed bytes for review.');
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    // This test owns exactly its resolved scratch directory and all fixture artifacts.
    rmSync(scratch, { recursive: true, force: true });
  }
});
