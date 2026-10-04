import { lstatSync, mkdirSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, parse, resolve } from 'node:path';
import { distribution } from '../distribution.mjs';
import { createReport, exportSnapshot, importSnapshot, ReportInputError } from './report/data.mjs';
import { renderReport } from './report/render.mjs';
import { diagnose, validDiagnosticTargets } from './runtime.mjs';

const DEFAULT_TARGETS = Object.freeze(['node', 'git']);

export class ReportCommandError extends Error {
  constructor(code, reason) { super(reason); this.name = 'ReportCommandError'; this.code = code; this.reason = reason; }
}
const refuse = reason => new ReportCommandError('INPUT_INVALID', reason);
const cancelled = signal => signal?.aborted === true;

// Local roots the fresh diagnostic may echo. Filesystem roots are skipped: replacing "/" would corrupt every path.
function localRoots() {
  const roots = new Set();
  for (const value of [process.env.USERPROFILE, process.env.HOME, homedir(), process.cwd()]) {
    if (typeof value !== 'string' || !isAbsolute(value) || parse(value).root === value) continue;
    roots.add(value); roots.add(value.replaceAll('\\', '/'));
  }
  return [...roots];
}

// The destination is only ever created, never reused, so a refusal leaves existing files untouched.
function checkDestination(path) {
  try { lstatSync(path); return 'output-exists'; } catch (error) {
    if (error?.code !== 'ENOENT') return 'output-unavailable';
  }
  try { return statSync(dirname(path)).isDirectory() ? undefined : 'output-unavailable'; } catch { return 'output-unavailable'; }
}

function write(path, files) {
  try { mkdirSync(path); } catch (error) { throw refuse(error?.code === 'EEXIST' ? 'output-exists' : 'output-unavailable'); }
  const written = [];
  try {
    for (const [name, text] of files) { writeFileSync(resolve(path, name), text, { flag: 'wx' }); written.push(name); }
  } catch {
    for (const name of written) rmSync(resolve(path, name), { force: true });
    try { rmdirSync(path); } catch { /* Leave a directory another process has since used. */ }
    throw refuse('output-unavailable');
  }
}

function importSupplied(json) {
  try { return importSnapshot(json); } catch (error) {
    throw refuse(error instanceof ReportInputError && error.code === 'SCHEMA_UNSUPPORTED' ? 'snapshot-unsupported' : 'snapshot-invalid');
  }
}

async function acquire(targets, signal) {
  if (!validDiagnosticTargets(targets)) throw refuse('request-invalid');
  const observedAt = new Date().toISOString();
  const diagnostic = await diagnose({ requestId: 'aih-report', targets: [...targets], network: 'off' }, { signal });
  if (cancelled(signal) || diagnostic.status === 'cancelled') throw new ReportCommandError('CANCELLED', 'cancelled');
  if (diagnostic.status !== 'completed') throw new ReportCommandError('INCOMPLETE', `diagnostic-${diagnostic.status}`);
  if (diagnostic.helper.name !== distribution.name || diagnostic.helper.version !== distribution.version)
    throw new ReportCommandError('INCOMPLETE', 'producer-identity');
  try {
    // The package git revision is not recorded in the installed distribution, so it is reported as unknown.
    return createReport({ diagnostic, producer: { name: distribution.name, version: distribution.version, revision: null },
      observedAt, acquisition: 'newly-acquired', redaction: { homePaths: localRoots() } });
  } catch { throw new ReportCommandError('INCOMPLETE', 'projection-failed'); }
}

export async function runReportCommand(request, controls = {}) {
  if (typeof request?.output !== 'string' || !request.output || request.output.includes('\0') ||
      request.snapshotJson !== undefined && (typeof request.snapshotJson !== 'string' || request.targets !== undefined))
    throw refuse('request-invalid');
  const directory = resolve(request.output);
  const unavailable = checkDestination(directory);
  if (unavailable) throw refuse(unavailable);
  const { signal } = controls;
  const snapshot = request.snapshotJson === undefined ?
    await acquire(request.targets ?? DEFAULT_TARGETS, signal) : importSupplied(request.snapshotJson);
  const mode = request.demo ? 'demo' : 'report';
  const json = exportSnapshot(snapshot);
  const html = renderReport(snapshot, { mode });
  // Everything is rendered before the directory exists, so cancellation or a render failure leaves nothing behind.
  if (cancelled(signal)) throw new ReportCommandError('CANCELLED', 'cancelled');
  write(directory, [['report.json', json], ['report.html', html]]);
  return {
    status: 'complete', mode, source: request.snapshotJson === undefined ? 'fresh' : 'snapshot',
    package: { name: distribution.name, version: distribution.version },
    producer: { name: snapshot.producer.name, version: snapshot.producer.version, revision: snapshot.producer.revision },
    evidence: { originalSha256: snapshot.evidence.originalSha256, authentication: snapshot.evidence.authentication },
    output: { directory, json: resolve(directory, 'report.json'), html: resolve(directory, 'report.html') },
    diagnosticStatus: snapshot.status, counts: { ...snapshot.metrics.counts },
    totals: { tools: snapshot.tools.length, observations: snapshot.observations.length,
      checks: snapshot.checks.length, diagnostics: snapshot.diagnostics.length }
  };
}
