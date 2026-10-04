import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {importSnapshot,exportSnapshot} from '@aihq/core/report';
import {renderReport} from '@aihq/core/report/render';
if(process.argv.length!==4)throw new Error('Usage: node scripts/verify-report-visual.mjs <snapshot.json> <new-evidence-directory>');
const snapshot=importSnapshot(await readFile(process.argv[2],'utf8'));
const output=resolve(process.argv[3]); await mkdir(output);
const browser=await chromium.launch({headless:true,channel:process.env.REPORT_BROWSER_CHANNEL || (process.platform==='win32'?'msedge':undefined)});
const errors=[], sections={}; const record={snapshotSha256:createHash('sha256').update(exportSnapshot(snapshot)).digest('hex'),modes:{},errors};
try {
 for(const mode of ['report','demo']) {
  const html=renderReport(snapshot,{mode});
  for(const javaScriptEnabled of [false,true]) {
   const label=mode+'-'+(javaScriptEnabled?'hydrated':'static');
   const context=await browser.newContext({javaScriptEnabled,viewport:{width:1280,height:900}});
   const page=await context.newPage();
   page.on('pageerror',error=>errors.push(label+': '+error.message));
   page.on('console',message=>{if(message.type()==='error')errors.push(label+': '+message.text());});
   page.on('request',request=>{if(/^https?:/.test(request.url()))errors.push(label+': network request');});
   await page.setContent(html,{waitUntil:'load'});
   const content=await page.locator('main section').evaluateAll(nodes=>nodes.map(node=>({id:node.id,state:node.getAttribute('data-state'),html:node.innerHTML})));
   assert.equal(content.length,14);
   if(mode==='report'){assert.equal(content.filter(section=>section.state==='empty').length,9);assert.equal(content.filter(section=>section.state==='live').length,5);}
   if(javaScriptEnabled) {
    if(mode==='report') assert.deepEqual(content,sections[mode]);
    await page.keyboard.press('Control+k');
    assert.equal(await page.locator('#palette.open').count(),1);
    assert.equal(await page.locator('.palette-item').count(),14);
    await page.keyboard.press('Escape');
   } else sections[mode]=content;
   await page.screenshot({path:join(output,label+'.png'),fullPage:true});
   await page.screenshot({path:join(output,label+'-hero.png')});
   record.modes[label]={sections:content.length,staticHydratedMatch:javaScriptEnabled&&mode==='report'?true:undefined};
   await context.close();
  }
 }
 assert.deepEqual(errors,[]);
 await writeFile(join(output,'visual-check.json'),JSON.stringify(record,null,2)+'\n');
 console.log(JSON.stringify(record));
}finally{await browser.close();}
