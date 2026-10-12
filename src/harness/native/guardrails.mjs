// Fixed Claude settings derived only from Core's independently verified supplied material.
// These are verifier-owned guardrails; selected configuration bytes are never rewritten.
import { canonicalJson, isRecord, parseStrictJson } from './canonical.mjs';
import { sha256 } from './digest.mjs';
import { fixtureAttestTool, fixtureFiles } from './fixture-data.mjs';

const permissionId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(value) && !value.includes('__') && !value.endsWith('_');
const compare = (a,b) => a < b ? -1 : a > b ? 1 : 0;
const treeDigest = files => sha256(canonicalJson(files.map(({root,path,member}) => ({root,path,sha256:member.sha256,byteLength:member.byteLength}))
  .sort((a,b) => compare(a.root,b.root) || compare(a.path,b.path))));

export function deriveClaudeGuardrails(definition, material, baseline, Stop) {
  // The bundled definition's exact guardrail bytes and admission identity stay unchanged.
  if (material.scope === 'bundled-mechanism') return baseline;
  const refuse = () => new Stop('configuration-channel-unsupported','unsupported');
  const server=material.server;
  if (definition.client !== 'claude' || definition.parserId !== 'claude-stream-json.v1' ||
      !permissionId(server.name) || !permissionId(server.queryTool) || server.queryTool === fixtureAttestTool ||
      !Array.isArray(server.toolNames) || server.toolNames.length !== 2 || new Set(server.toolNames).size !== 2 ||
      !server.toolNames.includes(fixtureAttestTool) || !server.toolNames.includes(server.queryTool)) throw refuse();
  // A second .mcp.json server could start in headless mode even without a tool grant.
  // Require the one declared stdio server rather than relying on an approval prompt.
  const configuration=material.outputTree.find(file => file.root === 'project' && file.path === '.mcp.json');
  const configurationBytes=configuration && material.bytes.get(configuration.member.path);
  if (!configurationBytes || configurationBytes.length !== configuration.member.byteLength || sha256(configurationBytes) !== configuration.member.sha256) throw refuse();
  try {
    const config=parseStrictJson(new TextDecoder('utf-8',{fatal:true}).decode(configurationBytes));
    if (!isRecord(config) || Object.keys(config).length !== 1 || !isRecord(config.mcpServers) ||
        Object.keys(config.mcpServers).length !== 1 || !Object.hasOwn(config.mcpServers,server.name) ||
        !isRecord(config.mcpServers[server.name]) || ![undefined,'stdio'].includes(config.mcpServers[server.name].type)) throw refuse();
  } catch { throw refuse(); }
  const fixed=fixtureFiles.guardrails;
  const original=baseline.files.find(file => file.root === fixed.root && file.path === fixed.path);
  if (baseline.files.length !== 1 || !original || !baseline.bytes.get(original.member.path)?.equals(Buffer.from(fixed.text))) throw refuse();
  const settings=JSON.parse(fixed.text), prefix='mcp__'+server.name+'__';
  settings.permissions.allow=[prefix+fixtureAttestTool,prefix+server.queryTool];
  settings.enabledMcpjsonServers=[server.name];
  // The fixed deny list and enableAllProjectMcpServers=false are retained verbatim.
  const bytes=Buffer.from(JSON.stringify(settings,null,2)+'\n');
  const files=[{...original,member:{...original.member,sha256:sha256(bytes),byteLength:bytes.length}}];
  const captured=new Map(baseline.bytes); captured.set(original.member.path,bytes);
  return {files,bytes:captured,sha256:treeDigest(files)};
}
