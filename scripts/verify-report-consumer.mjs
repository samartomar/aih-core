import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, stop } from 'esbuild';
import { runInNewContext } from 'node:vm';
const npmPath = process.env.npm_execpath;
if (!npmPath) throw new Error('Run through npm run verify:report-consumer');
const root = resolve('.');
const temporary = await mkdtemp(join(tmpdir(),'aih-report-packed-'));
// npm forwards this project-scoped setting into lifecycle scripts. It cannot be
// combined with --ignore-scripts in the independent consumer installation.
const npmEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_allow_scripts$/i.test(key)));
const runNpm = (args,cwd=root) => execFileSync(process.execPath,[npmPath,...args],{cwd,env:npmEnvironment,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
try {
 const pack = JSON.parse(runNpm(['pack','--ignore-scripts','--json','--pack-destination',temporary]))[0];
 const consumer = join(temporary,'consumer'); await mkdir(consumer);
 await writeFile(join(consumer,'package.json'),JSON.stringify({private:true,type:'module'}));
 runNpm(['install','--ignore-scripts','--no-audit','--no-fund','--package-lock=false',join(temporary,pack.filename)],consumer);
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
 assert.ok(browserContext.ReportAPI.renderReport(browserReport).includes('sec-ready'));
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

 const declaration="import {createReport,exportSnapshot,importSnapshot,type ReportSnapshot} from '@aihq/core/report'; import {renderReport} from '@aihq/core/report/render'; const snapshot:ReportSnapshot=importSnapshot('{}'); const revision:string|null=snapshot.producer.revision; void [createReport,exportSnapshot,renderReport,revision];";
 await writeFile(join(consumer,'report-contracts.mts'),declaration);
 execFileSync(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'--noEmit','--strict','--module','NodeNext','--moduleResolution','NodeNext','--target','ES2023','--types','node','--typeRoots',join(root,'node_modules/@types'),'report-contracts.mts'],{cwd:consumer,encoding:'utf8',windowsHide:true});
 const home=join(consumer,'home'); await mkdir(home);
 const commandEnv={...process.env,HOME:home,USERPROFILE:home};
 const cli=join(consumer,'node_modules/@aihq/core/dist/core/cli.js');
 const fresh=JSON.parse(execFileSync(process.execPath,[cli,'report','--output',join(consumer,'fresh'),'--json'],{cwd:consumer,env:commandEnv,encoding:'utf8',windowsHide:true,timeout:45000}));
 assert.equal(fresh.source,'fresh'); assert.equal(fresh.package.version,'1.0.0-dev.5'); assert.equal(fresh.counts.passed,2);
 const actual=await readFile(fresh.output.json,'utf8');
 const saved=JSON.parse(execFileSync(process.execPath,[cli,'report','--snapshot',fresh.output.json,'--output',join(consumer,'saved'),'--json'],{cwd:consumer,env:commandEnv,encoding:'utf8',windowsHide:true,timeout:10000}));
 assert.equal(saved.source,'snapshot'); assert.equal(await readFile(saved.output.json,'utf8'),actual);
 assert.equal(await readFile(saved.output.html,'utf8'),await readFile(fresh.output.html,'utf8'));
 console.log('Packed reporting declarations, real offline command and snapshot replay passed; saved mode reproduces identical JSON/HTML.');
} finally { await stop(); await rm(temporary,{recursive:true,force:true}); }
