import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReport, exportSnapshot } from '@aihq/core/report';
import { startSnapshotServer } from '../../examples/reporting/http.mjs';
import { summarizeReport } from '../../examples/reporting/data-only.mjs';
const diagnostic={requestId:'consumer-fixture',helper:{name:'@aihq/core',version:'1.0.0-dev.3'},status:'completed',tools:[{id:'node',label:'Node.js',state:'runnable',selection:'requested'}],observations:[],checks:[{id:'node-version',target:'node',outcome:'passed',reason:'version',detail:'Version observed'}],diagnostics:[],repairChoices:[],limits:{budgetMs:30000,elapsedMs:0,maxActiveProbes:2}};
const input={diagnostic,producer:{name:'@aihq/core',version:'1.0.0-dev.3',revision:'5b70f8e698a4ec1e346b9718ef0067b2c856a1c6'},observedAt:'2026-10-03T00:00:00.000Z',acquisition:'supplied'};
test('independent data-only consumer reads meaningful structured measured outcomes',()=>{
 const result=summarizeReport(exportSnapshot(createReport(input)));
 assert.equal(result.counts.passed,1); assert.equal(result.tools[0].state,'runnable'); assert.equal(result.servedFrom,'snapshot'); assert.equal(result.authentication,'not-authenticated');
});
test('HTTP consumer binds loopback, serves one snapshot, rejects arbitrary requests and mutation',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'report-http-'));
 const snapshot=exportSnapshot(createReport(input));
 const file=join(directory,'report.json'); await writeFile(file,snapshot);
 const server=await startSnapshotServer({snapshotPath:file});
 try {
  assert.equal(server.address().address,'127.0.0.1');
  const base='http://127.0.0.1:'+server.address().port;
  const response=await fetch(base+'/report.json');
  assert.equal(response.status,200); assert.equal(response.headers.get('x-report-source'),'snapshot'); assert.equal(await response.text(),snapshot);
  for (const route of ['/report.json?path=C:/Windows','/report.json?collect=true','/report.json/../anything','/anything'])
    assert.equal((await fetch(base+route)).status,404);
  assert.equal((await fetch(base+'/report.json',{method:'POST',body:'anything'})).status,405);
  assert.equal((await fetch(base+'/report.json',{method:'HEAD'})).status,200);
 } finally { await new Promise(resolve=>server.close(resolve)); await rm(directory,{recursive:true,force:true}); }
});
test('HTTP consumer refuses oversized explicit startup input',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'report-http-limit-'));
 const file=join(directory,'report.json'); await writeFile(file,' '.repeat(1_000_001));
 try { await assert.rejects(startSnapshotServer({snapshotPath:file}),/limit/); }
 finally { await rm(directory,{recursive:true,force:true}); }
});
