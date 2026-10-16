import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { build, stop } from 'esbuild';
import { runInNewContext } from 'node:vm';
const npmPath = process.env.npm_execpath;
if (!npmPath) throw new Error('Run through npm run verify:report-consumer');
const root = resolve('.');
// Optional `-- --tarball <file>` verifies an already packed artifact (for example
// from `npm run pack:distribution`) instead of packing the working tree here.
const cli = process.argv.slice(2);
if (!(cli.length === 0 || (cli.length === 2 && cli[0] === '--tarball'))) throw new Error('Use npm run verify:report-consumer -- [--tarball <packed .tgz>]');
const tarball = cli.length ? resolve(cli[1]) : null;
const temporary = await mkdtemp(join(tmpdir(),'aih-report-packed-'));
// npm forwards this project-scoped setting into lifecycle scripts. It cannot be
// combined with --ignore-scripts in the independent consumer installation.
const npmEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_allow_scripts$/i.test(key)));
const runNpm = (args,cwd=root) => execFileSync(process.execPath,[npmPath,...args],{cwd,env:npmEnvironment,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
try {
 let pack;
 if (tarball) {
  pack = { filename: basename(tarball) };
  await copyFile(tarball, join(temporary,pack.filename));
 } else pack = JSON.parse(runNpm(['pack','--ignore-scripts','--json','--pack-destination',temporary]))[0];
 console.log(JSON.stringify({tarball: tarball ? pack.filename : 'packed-here'}));
 const consumer = join(temporary,'consumer'); await mkdir(consumer);
 await writeFile(join(consumer,'package.json'),JSON.stringify({private:true,type:'module'}));
 runNpm(['install','--ignore-scripts','--no-audit','--no-fund','--package-lock=false',join(temporary,pack.filename)],consumer);
 if (tarball) Object.assign(pack, (({name,version}) => ({name,version}))(JSON.parse(await readFile(join(consumer,'node_modules/@aihq/core/package.json'),'utf8'))));
 const diagnostic={requestId:'packed-consumer-fixture',helper:{name:'@aihq/core',version:'1.0.0-dev.3'},status:'completed',tools:[{id:'node',label:'Node',state:'runnable',selection:'requested'}],observations:[],checks:[{id:'version',target:'node',outcome:'passed',reason:'version',detail:'bounded local observation'}],diagnostics:[],repairChoices:[],limits:{budgetMs:30000,elapsedMs:0,maxActiveProbes:2}};
 await writeFile(join(consumer,'input.json'),JSON.stringify({diagnostic,producer:{name:'@aihq/core',version:'1.0.0-dev.3',revision:'5b70f8e698a4ec1e346b9718ef0067b2c856a1c6'},observedAt:'2026-10-03T00:00:00.000Z',acquisition:'supplied'}));
 const script = [
  "import assert from 'node:assert/strict';",
  "import { readFile } from 'node:fs/promises';",
  "import { createReport,importSnapshot,exportSnapshot } from '@aihq/core/report';",
  "import { renderReport } from '@aihq/core/report/render';",
  "const input=JSON.parse(await readFile('input.json','utf8'));",
  "const report=createReport(input); const json=exportSnapshot(report);",
  "assert.deepEqual(importSnapshot(json),report); assert.equal(report.metrics.counts.passed,1);",
  "assert.equal(report.metrics.elapsedMs,0); assert.equal(report.evidence.authentication,'not-authenticated');",
  "const html=renderReport(report); assert.ok(html.includes('sec-ready')); assert.ok(html.includes('node'));",
  "await assert.rejects(import('@aihq/core/src/harness/report/data.mjs'),{code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});",
  "console.log(JSON.stringify({packed:true,status:report.status,passed:report.metrics.counts.passed,htmlBytes:html.length}));"
 ].join('\n');
 await writeFile(join(consumer,'check.mjs'),script);
 const result=execFileSync(process.execPath,['check.mjs'],{cwd:consumer,encoding:'utf8',windowsHide:true});
 console.log(result.trim());
 const browser=await build({stdin:{contents:"export * from '@aihq/core/report'; export {renderReport} from '@aihq/core/report/render';",resolveDir:consumer},bundle:true,platform:'browser',format:'iife',globalName:'ReportAPI',write:false,metafile:true,logLevel:'silent'});
 assert.ok(Object.keys(browser.metafile.inputs).every(path=>!path.startsWith('node:')&&!/harness\/(?:runtime|report-command)\.mjs$/.test(path)));
 const browserContext={TextEncoder,TextDecoder,reportInputJSON:await readFile(join(consumer,'input.json'),'utf8')}; runInNewContext(browser.outputFiles[0].text,browserContext);
 const browserReport=runInNewContext('ReportAPI.createReport(JSON.parse(reportInputJSON))',browserContext);
 assert.equal(browserReport.metrics.counts.passed,1);
 assert.equal(runInNewContext('ReportAPI.importSnapshot(ReportAPI.exportSnapshot(ReportAPI.createReport(JSON.parse(reportInputJSON)))).metrics.counts.passed',browserContext),1);
 assert.throws(()=>runInNewContext('ReportAPI.importSnapshot(ReportAPI.exportSnapshot(ReportAPI.createReport(JSON.parse(reportInputJSON))).replace("\\\"status\\\":\\\"completed\\\"", "\\\"status\\\":\\\"invalid\\\",\\\"status\\\":\\\"completed\\\""))',browserContext),{code:'INPUT_INVALID'});
 assert.ok(browserContext.ReportAPI.renderReport(browserReport).includes('sec-ready'));
 const claimsExamples = join(consumer,'node_modules/@aihq/core/examples/reporting/claims');
 const claimsInput = await readFile(join(claimsExamples,'checks.input.json'),'utf8');
 const claimsProjection = await readFile(join(claimsExamples,'checks.projection.json'),'utf8');
 const claimsUnsupported = await readFile(join(claimsExamples,'unsupported.input.json'),'utf8');
 Object.assign(browserContext,{claimsInputJSON:claimsInput,claimsUnsupportedJSON:claimsUnsupported});
 assert.equal(runInNewContext("typeof process+typeof require+typeof Buffer",browserContext),'undefinedundefinedundefined');
 assert.equal(runInNewContext("JSON.stringify(ReportAPI.projectClaims(JSON.parse(claimsInputJSON)),null,2)+'\\n'",browserContext),claimsProjection);
 assert.equal(runInNewContext("ReportAPI.readClaimSet(claimsInputJSON).status",browserContext),'supported');
 assert.equal(runInNewContext("ReportAPI.readClaimSet(claimsUnsupportedJSON).code",browserContext),'SCHEMA_UNSUPPORTED');
 assert.equal(runInNewContext("ReportAPI.readClaimSet(claimsUnsupportedJSON).original===claimsUnsupportedJSON",browserContext),true);
 await stop();
 console.log('Packed reporting browser bundle runs without Node globals or producer runtime.');
 const loader="export async function resolve(specifier,context,next){const result=await next(specifier,context); if(/\\/(render|template|fonts)\\.mjs$/.test(result.url)) throw new Error('Renderer loaded by data-only consumer'); return result;}";
 await writeFile(join(consumer,'no-render-loader.mjs'),loader);
 const dataScript="import {readFile,writeFile} from 'node:fs/promises'; import {createReport,exportSnapshot} from '@aihq/core/report'; await writeFile('report.json',exportSnapshot(createReport(JSON.parse(await readFile('input.json','utf8')))));";
 await writeFile(join(consumer,'data.mjs'),dataScript);
 execFileSync(process.execPath,['--experimental-loader','./no-render-loader.mjs','data.mjs'],{cwd:consumer,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
 const dataOnly=execFileSync(process.execPath,['--experimental-loader','./no-render-loader.mjs','node_modules/@aihq/core/examples/reporting/data-only.mjs','report.json'],{cwd:consumer,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
 assert.equal(JSON.parse(dataOnly).counts.passed,1);
 console.log('Packed data-only consumer passed with renderer imports forbidden; package uses only installed public exports.');

 // Normalized claims 1.0.0 and 1.1.0: the installed package's filled examples, its public schema export and declarations.
 const claimsScript = [
  "import assert from 'node:assert/strict';",
  "import { readFile } from 'node:fs/promises';",
  "import { CLAIMS_SCHEMA,CLAIMS_SCHEMA_1_1_0,CLAIMS_ACCEPTED_VERSIONS,readClaimSet,projectClaims } from '@aihq/core/report';",
  "import { contractSupport } from '@aihq/core/harness';",
  "const examples='node_modules/@aihq/core/examples/reporting/claims/';",
  "const load=name=>readFile(examples+name,'utf8');",
  "assert.deepEqual(CLAIMS_ACCEPTED_VERSIONS,[CLAIMS_SCHEMA,CLAIMS_SCHEMA_1_1_0]);",
  "const declared=contractSupport.contracts.find(item=>item.id===CLAIMS_SCHEMA); assert.equal(declared.role,'accepts');",
  "assert.equal((await import(declared.schemaExport,{with:{type:'json'}})).default.$id,CLAIMS_SCHEMA);",
  "const declaredNext=contractSupport.contracts.find(item=>item.id===CLAIMS_SCHEMA_1_1_0); assert.equal(declaredNext.role,'accepts');",
  "assert.equal((await import(declaredNext.schemaExport,{with:{type:'json'}})).default.$id,CLAIMS_SCHEMA_1_1_0);",
  "const project=async name=>{const read=readClaimSet(await load(name+'.input.json')); assert.equal(read.status,'supported'); const result=projectClaims(read.claimSet); assert.deepEqual(result,JSON.parse(await load(name+'.projection.json'))); assert.equal(JSON.stringify(projectClaims(read.claimSet)),JSON.stringify(result)); return result;};",
  "const byId=result=>Object.fromEntries(result.calculations.map(item=>[item.id,item]));",
  "const checks=byId(await project('checks'));",
  "assert.equal(checks['score-unknown-in-denominator'].score,50); assert.deepEqual(checks['score-unknown-in-denominator'].counts,{passed:2,failed:1,unknown:1,inapplicable:1});",
  "assert.equal(checks['score-zero-applicable'].status,'unavailable'); assert.equal(checks['score-zero-applicable'].score,null);",
  "assert.equal(checks['score-high-with-failure'].score,95); assert.deepEqual(checks['score-high-with-failure'].failed,[{id:'check-high-20',revision:'1'}]);",
  "const repairs=byId(await project('repairs'))['verified-repairs']; assert.equal(repairs.count,1);",
  "assert.deepEqual(repairs.attempts.map(item=>item.reason),['verified','verified','already-healthy','unknown-cause','external-repair','applied-unverified']);",
  "const context=byId(await project('context'));",
  "assert.equal(context['bytes-reduction'].absoluteDifference,250); assert.equal(context['bytes-reduction'].percentage,25);",
  "assert.equal(context['zero-baseline'].absoluteDifference,1200); assert.equal(context['zero-baseline'].percentage,null);",
  "assert.equal(context['estimate-vs-observed'].status,'unavailable');",
  "const recurrence=byId(await project('recurrence'));",
  "assert.deepEqual(Object.values(recurrence).map(item=>[item.id,item.status,item.reason,item.count]),[['recurring','available',null,1],['recovered-without-recurrence','available',null,0],['unrelated-condition','available',null,0],['duplicate-import','available',null,1],['missing-history','unavailable','no-history',null],['still-failing','unavailable','no-recovery',null]]);",
  "assert.deepEqual([recurrence.recurring.subject,recurrence.recurring.condition],[{kind:'client',id:'example-client-environment'},'condition:native-use']);",
  "const original=await load('unsupported.input.json'); const rejected=readClaimSet(original);",
  "assert.equal(rejected.status,'rejected'); assert.equal(rejected.code,'SCHEMA_UNSUPPORTED'); assert.equal(rejected.original,original);",
  "console.log(JSON.stringify({claims:true,score:checks['score-unknown-in-denominator'].score,verifiedRepairs:repairs.count,recurrences:recurrence.recurring.count,rejected:rejected.code}));"
 ].join('\n');
 await writeFile(join(consumer,'claims.mjs'),claimsScript);
 console.log(execFileSync(process.execPath,['claims.mjs'],{cwd:consumer,encoding:'utf8',windowsHide:true}).trim());
 console.log('Packed normalized-claims consumer projected the installed filled examples and rejected an unsupported format with its bytes preserved.');

  const declaration=[
  "import {createReport,exportSnapshot,importSnapshot,readClaimSet,projectClaims,validateClaimSet,CLAIMS_SCHEMA,CLAIMS_SCHEMA_1_1_0,type ReportSnapshot,type ClaimSet,type ClaimSetRead,type ClaimsProjection,type CalculationResult,type OrderedAction,type RecurrenceRequest,type RecurrenceResult} from '@aihq/core/report';",
  "import {renderReport} from '@aihq/core/report/render';",
  "const snapshot:ReportSnapshot=importSnapshot('{}'); const revision:string|null=snapshot.producer.revision; void [createReport,exportSnapshot,renderReport,revision];",
  "const schemaId:'urn:aihq:report:claims:1.0.0'=CLAIMS_SCHEMA;",
  "const read:ClaimSetRead=readClaimSet('{}');",
  "if(read.status==='supported'){const set:ClaimSet=read.claimSet; const projection:ClaimsProjection=projectClaims(set); const first:CalculationResult|undefined=projection.calculations[0]; const actions:OrderedAction[]=projection.actions; void [first,actions];}",
  "else{const code:'SCHEMA_UNSUPPORTED'|'INPUT_INVALID'=read.code; const original:string=read.original; void [code,original];}",
  "const score=(result:CalculationResult):number|null=>'score' in result?result.score:null;",
  "const valid:boolean=validateClaimSet({}).valid;",
  "// @ts-expect-error a claim kind outside the closed set is a type error",
  "const badKind:ClaimSet['claims'][number]['kind']='guess';",
  "void [schemaId,score,valid,badKind];",
  "const nextId:'urn:aihq:report:claims:1.1.0'=CLAIMS_SCHEMA_1_1_0;",
  "const request:RecurrenceRequest={id:'r',method:'recurrence',version:'1.0.0',subject:{kind:'machine',id:'host'},condition:'file-state',observations:[]};",
  "const next:ClaimSet={schema:CLAIMS_SCHEMA_1_1_0,claims:[],calculations:[request]};",
  "// @ts-expect-error a claims 1.0.0 set cannot carry a recurrence request",
  "const legacy:ClaimSet={schema:CLAIMS_SCHEMA,claims:[],calculations:[request]};",
  "const recurrenceCount=(result:CalculationResult):number|null=>{if(result.method.id!=='recurrence')return null; const recurrence=result as RecurrenceResult; if(recurrence.status==='available'){const n:number=recurrence.count; return n;} const why:'no-history'|'ambiguous-order'|'no-failure'|'no-recovery'=recurrence.reason; void why; return recurrence.count;};",
  "void [nextId,next,legacy,recurrenceCount];"
 ].join('\n');
 await writeFile(join(consumer,'report-contracts.mts'),declaration);
 execFileSync(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'--noEmit','--strict','--module','NodeNext','--moduleResolution','NodeNext','--target','ES2023','--types','node','--typeRoots',join(root,'node_modules/@types'),'report-contracts.mts'],{cwd:consumer,encoding:'utf8',windowsHide:true});
 const home=join(consumer,'home'); await mkdir(home);
 const commandEnv={...process.env,HOME:home,USERPROFILE:home};
 const cli=join(consumer,'node_modules/@aihq/core/dist/core/cli.js');
 const fresh=JSON.parse(execFileSync(process.execPath,[cli,'report','--output',join(consumer,'fresh'),'--json'],{cwd:consumer,env:commandEnv,encoding:'utf8',windowsHide:true,timeout:45000}));
 assert.equal(fresh.source,'fresh'); assert.deepEqual(fresh.package,{name:pack.name,version:pack.version}); assert.equal(fresh.counts.passed,2);
 const actual=await readFile(fresh.output.json,'utf8');
 const saved=JSON.parse(execFileSync(process.execPath,[cli,'report','--snapshot',fresh.output.json,'--output',join(consumer,'saved'),'--json'],{cwd:consumer,env:commandEnv,encoding:'utf8',windowsHide:true,timeout:10000}));
 assert.equal(saved.source,'snapshot'); assert.equal(await readFile(saved.output.json,'utf8'),actual);
 assert.equal(await readFile(saved.output.html,'utf8'),await readFile(fresh.output.html,'utf8'));
 console.log('Packed reporting declarations, real offline command and snapshot replay passed; saved mode reproduces identical JSON/HTML.');
} finally { await stop(); await rm(temporary,{recursive:true,force:true}); }
