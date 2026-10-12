import test from 'node:test';
import assert from 'node:assert/strict';
import * as installed from '../../src/harness/native/runtime.mjs';

const canonical = installed.canonicalJson;
const hash = installed.sha256;
const treeHash = files => hash(canonical(files.map(({root,path,member}) => ({root,path,sha256:member.sha256,byteLength:member.byteLength})).sort((a,b) => a.root.localeCompare(b.root) || a.path.localeCompare(b.path))));
function fixture() {
  const runtime = installed.createNativeRuntime(installed, { readPinned() { throw Error('no process'); }, Stop: class extends Error { constructor(reason, outcome) { super(reason); this.reason=reason; this.outcome=outcome; } } });
  const definition = installed.nativeVerificationDefinitions.find(value => value.platform.os === 'win32');
  const bundled = runtime.nativeBundledFixture(definition, { check() {} });
  const material = { ...bundled, scope: 'test-configuration', server: { ...bundled.server, name: 'aihq-graph-fixture', queryTool: 'aihq_graph_callees', toolNames: ['aihq_attest_instruction','aihq_graph_callees'] }, bytes: new Map(bundled.bytes), outputTree: structuredClone(bundled.outputTree) };
  const configuration = material.outputTree.find(file => file.path === '.mcp.json');
  const bytes = Buffer.from(JSON.stringify({mcpServers:{'aihq-graph-fixture':{type:'stdio',command:'node',args:['.aihq-native/server.mjs']}}}));
  configuration.member.sha256=hash(bytes); configuration.member.byteLength=bytes.length; material.bytes.set(configuration.member.path,bytes); material.outputTreeSha256=treeHash(material.outputTree);
  const baseline = { files: definition.guardrails, bytes: bundled.bytes, sha256: definition.guardrailsSha256 };
  return {runtime,definition,bundled,material,baseline};
}

test('supplied Claude settings approve only the selected server and fixed attestation/query tools', () => {
  const {runtime,definition,material,baseline} = fixture();
  const original = canonical(definition), selected = [...material.bytes].map(([path,bytes]) => [path,hash(bytes)]);
  const plan = runtime.nativeGuardrails(definition,material,baseline);
  const file = plan.files.find(file => file.root === 'home' && file.path === '.claude/settings.json');
  const bytes=plan.bytes.get(file.member.path), settings=JSON.parse(bytes);
  assert.deepEqual(settings.permissions.allow,['mcp__aihq-graph-fixture__aihq_attest_instruction','mcp__aihq-graph-fixture__aihq_graph_callees']);
  assert.deepEqual(settings.enabledMcpjsonServers,['aihq-graph-fixture']); assert.equal(settings.enableAllProjectMcpServers,false);
  const fixed=JSON.parse(baseline.bytes.get(definition.guardrails[0].member.path));
  assert.deepEqual(settings.permissions.deny,fixed.permissions.deny);
  assert.equal(file.member.byteLength,bytes.length); assert.equal(file.member.sha256,hash(bytes)); assert.equal(plan.sha256,treeHash(plan.files));
  assert.notEqual(plan.sha256,baseline.sha256); assert.equal(canonical(definition),original);
  assert.deepEqual([...material.bytes].map(([path,bytes]) => [path,hash(bytes)]),selected);
});

test('bundled Claude guardrails retain exact bytes and digest', () => {
  const {runtime,definition,bundled,baseline}=fixture();
  assert.equal(runtime.nativeGuardrails(definition,bundled,baseline),baseline);
});

for (const change of [
  {name:'bad_'}, {name:'bad.dot'}, {name:'Bad'}, {queryTool:'bad.dot'}, {name:'bad*'}, {name:'bad__alias'}, {name:'bad(server)'}, {name:'bad:name'},
  {queryTool:'query*'}, {queryTool:'query__alias'}, {queryTool:'aihq_attest_instruction'},
  {toolNames:['aihq_graph_callees']}, {toolNames:['aihq_attest_instruction','aihq_graph_callees','write_file']},
  {toolNames:['aihq_attest_instruction','aihq_graph_callees','aihq_graph_callees']}
]) test('supplied permission identity/shape is refused: '+JSON.stringify(change), () => {
  const {runtime,definition,material,baseline}=fixture();
  material.server={...material.server,...change};
  assert.throws(() => runtime.nativeGuardrails(definition,material,baseline),error => error.reason==='configuration-channel-unsupported' && error.outcome==='unsupported');
});

test('a second supplied project server is never approved or launched', () => {
  const {runtime,definition,material,baseline}=fixture();
  const file=material.outputTree.find(file => file.path==='.mcp.json');
  const config=JSON.parse(material.bytes.get(file.member.path)); config.mcpServers.other={command:'node',args:['other.mjs']};
  const bytes=Buffer.from(JSON.stringify(config)); file.member.sha256=hash(bytes); file.member.byteLength=bytes.length; material.bytes.set(file.member.path,bytes);
  assert.throws(() => runtime.nativeGuardrails(definition,material,baseline),error => error.reason==='configuration-channel-unsupported');
});
