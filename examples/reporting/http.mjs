import { createServer } from 'node:http';
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { importSnapshot, exportSnapshot } from '@aihq/core/report';

export async function startSnapshotServer({snapshotPath, port = 0}) {
  if (typeof snapshotPath !== 'string' || !snapshotPath || !Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('Use an explicit snapshot filename and a valid port');
  const handle = await open(snapshotPath, 'r');
  let bytes;
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Snapshot must be a regular file');
    const buffer = Buffer.alloc(1_000_001);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > 1_000_000) throw new Error('Snapshot exceeds example limit');
    bytes = buffer.subarray(0,length);
  } finally { await handle.close(); }
  const report = importSnapshot(bytes.toString('utf8'));
  const json = exportSnapshot(report);
  const server = createServer((request,response) => {
    response.setHeader('Cache-Control','no-store');
    response.setHeader('X-Content-Type-Options','nosniff');
    response.setHeader('X-Report-Source','snapshot');
    response.setHeader('Content-Type','application/json; charset=utf-8');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405,{Allow:'GET, HEAD'}); response.end('{"error":"method-not-allowed"}'); return;
    }
    if (request.url !== '/report.json') {
      response.writeHead(404); response.end('{"error":"not-found"}'); return;
    }
    response.setHeader('Content-Length',Buffer.byteLength(json));
    response.writeHead(200); response.end(request.method === 'HEAD' ? undefined : json);
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.timeout = 5000;
  await new Promise((resolve,reject) => {
    server.once('error',reject); server.listen(port,'127.0.0.1',resolve);
  });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length < 3 || process.argv.length > 4) throw new Error('Usage: node http.mjs <report.json> [port]');
  const server = await startSnapshotServer({snapshotPath:process.argv[2],port:process.argv[3] === undefined ? 0 : Number(process.argv[3])});
  console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port+'/report.json',source:'snapshot'}));
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>server.close());
}
