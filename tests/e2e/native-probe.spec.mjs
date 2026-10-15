import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const script=readFileSync(new URL('../../src/unraid-file-station.user.js',import.meta.url),'utf8');
const start=script.indexOf('  function nativeProbeParseQueue(');
const end=script.indexOf('  async function nativeProbeQueue()',start);
assert.ok(start>=0&&end>start,'应提供 Unraid 原生队列兼容解析器');
const parserSource=script.slice(start,end);
const root='/mnt/user/downloads/新建文件夹/__ufs_probe_example';
const source=root+'/source/queue.txt';
const destination=root+'/target/';
const task='ufs-probe-copy';
let browser;
before(async()=>{browser=await chromium.launch({headless:true});});
after(async()=>{await browser?.close();});
async function runProbeFragment(samples){
  const page=await browser.newPage();
  try{
    await page.goto('about:blank');
    return await page.evaluate(({sourceCode,samples})=>{
      const probe=new Function(sourceCode+
        '\nreturn {parse:nativeProbeParseQueue, own:nativeProbeOwnQueuedJob};')();
      return samples.map(sample=>{
        try{
          const result=probe.parse(sample.raw);
          return {format:result.format,jobs:result.jobs.map(job=>({
            id:job.id,ours:probe.own(job,sample.source,sample.target,sample.task),
            legacyText:job.legacyText||null
          }))};
        }catch(error){return {error:String(error.message||error)};}
      });
    },{sourceCode:parserSource,samples});
  }finally{await page.close();}
}

test('新版 JSON 与旧版 HTML 均可识别空队列',async()=>{
  const results=await runProbeFragment([
    {raw:'[]'},
    {raw:'<div id="dfm_joblist"></div>'},
    {raw:'<html><body>Login</body></html>'}
  ]);
  assert.deepEqual(results[0],{format:'json',jobs:[]});
  assert.deepEqual(results[1],{format:'html-legacy',jobs:[]});
  assert.match(results[2].error,/未知 HTML 结构/);
});

test('旧版 HTML 精确匹配本次任务并发现其他排队任务',async()=>{
  const our='<i id="queue_1" class="fa fa-fw fa-square-o blue-text job"></i>'+
    'Job [0001] - '+task+' '+source+' --> '+destination;
  const other='<i id="queue_2" class="fa fa-fw fa-square-o blue-text job"></i>'+
    'Job [0002] - copy /mnt/user/downloads/other.txt --> /mnt/user/downloads/';
  const results=await runProbeFragment([
    {raw:'<div id="dfm_joblist">'+our+'</div>',source,target:destination,task},
    {raw:'<div id="dfm_joblist">'+our+'<br>'+other+'</div>',source,target:destination,task}
  ]);
  assert.equal(results[0].format,'html-legacy');
  assert.equal(results[0].jobs.length,1);
  assert.equal(results[0].jobs[0].ours,true);
  assert.equal(results[1].jobs.length,2);
  assert.equal(results[1].jobs[1].ours,false);
});

test('旧版内容被篡改或混杂异常元素时不会作为空队列接受',async()=>{
  const results=await runProbeFragment([
    {raw:'<div id="dfm_joblist">未知队列内容</div>'},
    {raw:'<div id="dfm_joblist"><span>伪造队列</span></div>'},
    {raw:'<div id="dfm_joblist"><i id="queue_1"></i></div>'},
    {raw:'not JSON and not HTML'}
  ]);
  for(const result of results) assert.ok(result.error,result.error);
});

test('新版 JSON 正确匹配任务且不忽略未知格式',async()=>{
  const results=await runProbeFragment([
    {raw:JSON.stringify([{id:1,source,target:destination,task}]),source,target:destination,task},
    {raw:JSON.stringify([{id:1,source:'/mnt/user/other',target:destination,task}]),source,target:destination,task},
    {raw:'{"hello":"world"}'}
  ]);
  assert.equal(results[0].jobs[0].ours,true);
  assert.equal(results[1].jobs[0].ours,false);
  assert.ok(results[2].error);
});
