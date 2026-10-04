import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { importSnapshot } from '@aihq/core/report';
export function summarizeReport(snapshot) {
  const report = importSnapshot(snapshot);
  return {
    schema: report.schema,
    producer: report.producer,
    observedAt: report.capture.observedAt,
    servedFrom: 'snapshot',
    authentication: report.evidence.authentication,
    status: report.status,
    counts: report.metrics.counts,
    tools: report.tools.map(({id,state,selection}) => ({id,state,selection}))
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node data-only.mjs <report.json>');
  const bytes = await readFile(process.argv[2]);
  if (bytes.length > 1_000_000) throw new Error('Snapshot exceeds example limit');
  console.log(JSON.stringify(summarizeReport(bytes.toString('utf8')), null, 2));
}
