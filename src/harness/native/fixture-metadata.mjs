export const fixtureId = 'aihq.native-fixture.v1';
export const fixtureServerName = 'aihq-native-fixture';
export const fixtureAttestTool = 'aihq_attest_instruction';
export const fixtureQueryTool = 'aihq_graph_query';
export const fixtureAnswer = 'leaf';
export const fixtureMarker = 'fde7a9484275524dde971458a9cd347fddf42ee7af0d37a292d23958df62e2b1';
export const fixtureMarkerSha256 = 'b72afeee5e166888b49f9144f12d6ed80e11a6f835064874527c23b35da2c233';
export const fixtureResultText = JSON.stringify({ content: [{ type: 'text', text: fixtureAnswer }], isError: false });

// Paths and independently fixed pins only; runtime program text belongs to the Node helper.
export const fixtureFiles = Object.freeze({
  instruction: Object.freeze({ root: 'project', path: 'CLAUDE.md', memberPath: 'package/harness/native/fixture/CLAUDE.md' }),
  mcpConfig: Object.freeze({ root: 'project', path: '.mcp.json', memberPath: 'package/harness/native/fixture/mcp.json' }),
  server: Object.freeze({ root: 'project', path: '.aihq-native/server.mjs', memberPath: 'package/harness/native/fixture/server.mjs' }),
  guardrails: Object.freeze({ root: 'home', path: '.claude/settings.json', memberPath: 'package/harness/native/fixture/claude-settings.json' })
});
// SHA-256 and byte length of each file's UTF-8 bytes.
export const fixturePins = Object.freeze({
  instruction: Object.freeze({ sha256: '1ab14794f8b120e2de192904c1be613bd0b63bc88e0b2bc7daf0f81f724c95de', byteLength: 568 }),
  mcpConfig: Object.freeze({ sha256: 'b368043ba4c7a890d573468d54054f8e19e38a9cbbc6c419efe0100a85e1c8bd', byteLength: 167 }),
  server: Object.freeze({ sha256: 'c767100031550ecda1ce7e689dcbd360c19038466c69378092cb6c128786c60d', byteLength: 6201 }),
  guardrails: Object.freeze({ sha256: '99b9edf183055d58b80b0ff4215a4bcc481e5fc27bf652f90cd3147d38ef39b4', byteLength: 523 })
});
