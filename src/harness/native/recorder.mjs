// Node-side helpers for the bundled stdio recorder. Importing this module has no host effects.
// The recorder itself is standalone program text in recorder-data.mjs; nothing here launches it.
import { createHash } from 'node:crypto';
import { recorderAttestTool, recorderId, recorderMemberPath, recorderRelativePath, recorderSource } from './recorder-data.mjs';

export { recorderId };
export const recorderPin = Object.freeze({ sha256: '9f23dc2293b7b1c12b4bd227b44c11bd81e2f6a8051ae42bab8d70b422f62dc5', byteLength: 18146 });

// Exact bytes the verifier stages (or the production configuration references), with recomputed digest.
export function recorderMaterial() {
  const bytes = Buffer.from(recorderSource, 'utf8');
  if (bytes.length !== recorderPin.byteLength || createHash('sha256').update(bytes).digest('hex') !== recorderPin.sha256)
    throw new Error('recorder-bytes-mismatch');
  return { root: 'project', path: recorderRelativePath, memberPath: recorderMemberPath, bytes,
    sha256: recorderPin.sha256, byteLength: recorderPin.byteLength };
}

// Runtime instrumentation sent over the authenticated channel after the handshake; never configuration.
// Returns null when the declared server cannot be observed by the recorder (caller reports unavailable).
export function recorderPlan({ server, instructions }) {
  const markers = instructions.filter(entry => entry.evidence === 'marker').map(entry => entry.markerSha256);
  if (new Set(markers).size !== markers.length || markers.some(marker => typeof marker !== 'string')) return null;
  if (!server.toolNames.includes(server.queryTool)) return null;
  if (markers.length > 0 && !server.toolNames.includes(recorderAttestTool)) return null;
  return {
    attestTool: markers.length > 0 ? recorderAttestTool : null, markers,
    queryTool: server.queryTool, queryArguments: structuredClone(server.queryArguments),
    challengeField: server.challenge.mode === 'argument' ? server.challenge.field : null,
    toolNames: [...server.toolNames]
  };
}

// Command a configuration uses to run an upstream stdio server behind the recorder, relative to cwd.
export const recorderCommand = ({ command, args }) => ({ command: 'node', args: [recorderRelativePath, '--', command, ...args] });
