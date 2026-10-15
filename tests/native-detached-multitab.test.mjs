import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const script=readFileSync(new URL('../src/unraid-file-station.user.js',import.meta.url),'utf8');
const root='/mnt/user/downloads/新建文件夹';
const workspace=root+'/__ufs_lifecycle_abcdef_12345';
const sample={
  schemaVersion:1,kind:'unraid-native-lifecycle-probe',mode:'detached',version:'0.2.14.0',
  phase:'awaiting-closure',workspace,ownerToken:'UFS_LIFECYCLE_abcdef',
  steps:[],samples:[],tasks:['ufs-lifecycle-testone-1','ufs-lifecycle-testtwo-2'],
  video:{path:root+'/新建文件夹/4415616 (2).mp4',
    name:'4415616 (2).mp4',size:331995662,mtime:1774502226}
};
function slice(a,b){
  const start=script.indexOf(a),end=script.indexOf(b,start);
  assert.ok(start>0&&end>start,'Missing source block '+a);
  return script.slice(start,end);
}
test('关闭页面测试使用 localStorage，普通 F5 测试仍用 sessionStorage',()=>{
  const saved=new Map();
  const lc={setItem:(k,v)=>saved.set('local:'+k,v),
    getItem:k=>saved.get('local:'+k)||null};
  const ss={setItem:(k,v)=>saved.set('session:'+k,v),
    getItem:k=>saved.get('session:'+k)||null};
  const ctx={NATIVE_LIFECYCLE_KEY:'f5',NATIVE_DETACHED_KEY:'detached',
    NATIVE_PROBE_ROOT:root,localStorage:lc,sessionStorage:ss,
    diagnosticLog(){},safePath:p=>typeof p==='string'&&p.startsWith('/mnt/user')&&
      !p.split('/').some(x=>x==='.'||x==='..')};
  const owner=slice('  function nativeLifecycleOwn(','  function nativeLifecycleSnapshot(');
  const block=slice('  function nativeLifecycleSnapshot(','  function nativeLifecycleNote(');
  vm.runInNewContext(owner+block+
    '\nglobalThis.lib={save:nativeLifecycleSnapshot,read:nativeDetachedRead};',ctx);
  ctx.lib.save(sample);
  assert.ok(saved.has('local:detached'));
  assert.equal(saved.has('session:f5'),false);
  assert.equal(ctx.lib.read().workspace,workspace);
  ctx.lib.save({...sample,mode:'f5'});
  assert.ok(saved.has('session:f5'));
  for(const corrupt of [
    {...sample,workspace:root+'/existing-dir'},
    {...sample,workspace:root+'/__ufs_lifecycle_test/../unsafe'},
    {...sample,ownerToken:'BAD'},
    {...sample,tasks:['bogus','bogus']}
  ]){
    lc.setItem('detached',JSON.stringify(corrupt));
    assert.equal(ctx.lib.read(),null,'corrupted detached state cannot rehydrate');
  }
});
test('关闭页面探针不会在重开页面时自动 mode=start 或再次提交复制',()=>{
  const source=slice('  async function nativeDetachedObserve(', '  async function nativeDetachedCompleteOwnedQueue(');
  assert.doesNotMatch(source,/mode\s*:\s*['"]start['"]/);
  assert.doesNotMatch(source,/mode\s*:\s*['"]file['"]/);
  assert.match(source,/nativeLifecycleJobsOwned\(run,jobs\)/);
  assert.match(source,/nativeLifecycleActiveOwned\(run,active\)/);
  assert.match(source,/userConfirmedClosedAllTabs/);
  assert.match(source,/completed_before_first_observation_cause_unknown/);
});
class FakeXHR{
  constructor(){this.listeners={};this.status=200;this.responseText='2';}
  open(method,url){this.method=method;this.url=url;return 'open-sentinel';}
  send(body){this.body=body;return 'send-sentinel';}
  addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}
  fire(type){for(const fn of this.listeners[type]||[])fn();}
}
test('多标签观察器只旁路记录 mode=start，透传 XHR 而不采集 CSRF',()=>{
  const events=[];
  const ctx={window:{XMLHttpRequest:FakeXHR},URL,URLSearchParams,WeakMap,
    location:{origin:'http://localhost',pathname:'/Shares/Browse'},
    isDemo:false,nativeMultitabStop:null,
    sessionStorage:{setItem(){}},NATIVE_MULTITAB_OPTIN:'opt',
    diagnosticTabId:'tabA',diagnosticLog(){},
    nativeMultitabRecord:(_id,e)=>events.push(e)};
  vm.runInNewContext(slice('  function nativeMultitabInstall(', '  function nativeMultitabReadReport(')+
    '\nglobalThis.observer={install:nativeMultitabInstall,stop:()=>nativeMultitabStop?.()};',ctx);
  const session={id:'watch_abc123'};
  assert.equal(ctx.observer.install(session),true);
  const x1=new FakeXHR();
  assert.equal(x1.open('POST','/webGui/include/Control.php'),'open-sentinel');
  assert.equal(x1.send('mode=start&csrf_token=CONFIDENTIAL'),'send-sentinel');
  x1.fire('loadend');
  const x2=new FakeXHR();
  x2.open('POST','/webGui/include/Control.php');
  x2.send('mode=file&action=8&csrf_token=CONFIDENTIAL');
  x2.fire('loadend');
  const x3=new FakeXHR();
  x3.open('POST','/elsewhere');
  x3.send('mode=start&password=HIDDEN');
  assert.equal(events.filter(e=>e.type==='native-start-request').length,1);
  assert.equal(events.filter(e=>e.type==='native-start-response').length,1);
  assert.equal(events.find(e=>e.type==='native-start-response').code,'2');
  assert.doesNotMatch(JSON.stringify(events),/CONFIDENTIAL|HIDDEN|csrf_token|password/);
  ctx.observer.stop();
  assert.equal(FakeXHR.prototype.open.name,'open');
  assert.equal(FakeXHR.prototype.send.name,'send');
});
test('多标签报告只识别明确的跨标签同时请求',()=>{
  const events={
    'watch_alpha:tabA':[{at:1000,tabId:'tabA',type:'native-start-request'},
      {at:2000,tabId:'tabA',type:'native-start-request'}],
    'watch_alpha:tabB':[{at:1200,tabId:'tabB',type:'native-start-request'}]
  };
  const store=new Map([['native-multitab-session-v1',
    JSON.stringify({id:'watch_alpha',startedAt:100,expiresAt:9999999999999})]]);
  for(const [name,data] of Object.entries(events))
    store.set('native-multitab-events:'+name,JSON.stringify(data));
  const storage={get length(){return store.size;},key:i=>[...store.keys()][i],
    getItem:key=>store.get(key)||null};
  const ctx={localStorage:storage,Date,
    NATIVE_MULTITAB_KEY:'native-multitab-session-v1',
    NATIVE_MULTITAB_EVENT_PREFIX:'native-multitab-events:',
    DIAGNOSTIC_VERSION:'0.2.14.0'};
  const sessionSource=slice('  function nativeMultitabSession(', '  function nativeMultitabEventKey(');
  const reportSource=slice('  function nativeMultitabReadReport(', '  function nativeMultitabDownload(');
  vm.runInNewContext(sessionSource+reportSource+
    '\nglobalThis.read=nativeMultitabReadReport;',ctx);
  const report=ctx.read();
  assert.equal(report.tabsObserved,2);
  assert.equal(report.requestCount,3);
  assert.equal(report.possibleCrossTabOverlaps.length,1);
  assert.deepEqual(report.events.map(x=>x.at).join(','),'1000,1200,2000');
});


test('遗留队列安全恢复只能针对原生认证的两项测试任务',()=>{
  const code=slice('  async function nativeDetachedCompleteOwnedQueue(',
    '  function nativeDetachedShowPanel(');
  assert.match(code,/nativeLifecycleJobsOwned\(run,initial\)/);
  assert.match(code,/initialIds\.length!==2/);
  assert.match(code,/nativeProbeWaitFile\(run\.workspace\+'\/owner\.txt'/);
  assert.match(code,/nativeLifecycleFilePath\(run,'source'/);
  assert.match(code,/nativeLifecycleJobsOwned\(run,nowJobs\)/);
  assert.match(code,/readNativeActive\(\)/);
  assert.match(code,/manualAdvances>=2/);
  assert.match(code,/recoveryAttempted/);
  assert.match(code,/nativeLifecycleFinalize\(run,'passed'/);
  assert.doesNotMatch(code,/action\s*:\s*['"]99['"]/);
  assert.doesNotMatch(code,/mode\s*:\s*['"]undo['"]/);
  assert.doesNotMatch(code,/mode\s*:\s*['"]file['"]/);
  assert.match(code,/run\.conclusion\.recoveryByExplicitAction=/);
  assert.match(code,/originalUnattendedFinding/);
});

test('遗留队列任务签名拒绝外部任务、重复项和错误顺序',()=>{
  const path=(part,name)=>workspace+'/'+part+'/'+name;
  const run={workspace,tasks:['ufs-lifecycle-one-1','ufs-lifecycle-two-2']};
  const job1={id:1,source:path('source','queue1.txt'),target:workspace+'/queue1/',
    task:run.tasks[0]};
  const job2={id:2,source:path('source','queue2.txt'),target:workspace+'/queue2/',
    task:run.tasks[1]};
  const src=slice('  function nativeLifecycleJobsOwned(', '  function nativeLifecycleActiveOwned(');
  const ctx={
    nativeLifecycleFilePath:(r,part,name)=>path(part,name),
    nativeProbeOwnQueuedJob:(j,src,dst,task)=>j.source===src&&j.target===dst&&
      j.task===task && Number.isSafeInteger(j.id)
  };
  vm.runInNewContext(src+'\nglobalThis.check=nativeLifecycleJobsOwned;',ctx);
  assert.equal(ctx.check(run,[job1,job2]).join(','),'0,1');
  assert.equal(ctx.check(run,[job2]).join(','),'1');
  assert.throws(()=>ctx.check(run,[job1,{...job2,source:'/mnt/user/outside'}]),
    /其他任务/);
  assert.throws(()=>ctx.check(run,[job1,job1]),/其他任务/);
  assert.throws(()=>ctx.check(run,[{...job1,task:'external'}]),/其他任务/);
});


test('两项唯一遗留任务可经用户显式确认依次接力且保留无人值守原始结论',async()=>{
  const workspace=root+'/__ufs_lifecycle_verified_test';
  const run={
    ...structuredClone(sample),workspace,phase:'awaiting-closure',
    userConfirmedClosedAllTabs:true,uncertain:true,
    conclusion:{unattendedAdvance:'queue_remained_after_reported_browser_closure'}
  };
  const makeJob=i=>({id:i+1,source:workspace+'/source/queue'+(i+1)+'.txt',
    target:workspace+'/queue'+(i+1)+'/',task:run.tasks[i]});
  let pending=[makeJob(0),makeJob(1)];
  let starts=0,cleaned=false,downloaded=false;
  class FakeDate extends Date{
    static now(){return Date._fakeTick=(Date._fakeTick||Date.now())+1000;}
  }
  const checkOwner=(r,jobs)=>{
    const matched=jobs.map(job=>[0,1].findIndex(i=>
      job.source===workspace+'/source/queue'+(i+1)+'.txt' &&
      job.target===workspace+'/queue'+(i+1)+'/' &&
      job.task===r.tasks[i]));
    if(matched.includes(-1) || matched.length!==new Set(matched).size)
      throw Error('原生队列包含其他任务或未知任务');
    return matched;
  };
  const context={
    nativeLifecycleBusy:false,nativeDetachedRead:()=>run,
    nativeWriteBusy:false,copyJobs:[],readNativeActive:async()=>null,
    nativeProbeQueue:async()=>pending.slice(),
    nativeLifecycleJobsOwned:checkOwner,
    nativeProbeWaitFile:async(path,text)=>{
      if(path===workspace+'/owner.txt')return text===run.ownerToken;
      if(path.includes('/source/queue'))return true;
      if(path.includes('/queue1/queue1.txt'))return !pending.some(j=>j.task===run.tasks[0]);
      if(path.includes('/queue2/queue2.txt'))return !pending.some(j=>j.task===run.tasks[1]);
      return false;
    },
    nativeLifecycleFilePath:(r,part,name)=>workspace+'/'+part+'/'+name,
    nativeLifecycleFileSize:async()=>run.video.size,
    nativeLifecycleActiveOwned:(_r,active)=>active? 'unknown':null,
    postNativeControl:async(body)=>{
      assert.equal(body.mode,'start');
      assert.ok(pending.length>0);
      starts++;
      const count=pending.length;
      pending.shift();
      return String(count);
    },
    nativeLifecycleNote:(r,name,other={})=>r.steps.push({name,...other}),
    nativeLifecycleFinalize:async(r,result)=>{
      cleaned=true;
      r.phase='complete';r.result=result;
    },
    nativeProbeDownload:()=>{downloaded=true;},
    waitNative:async()=>{},
    Date:FakeDate,
  };
  vm.runInNewContext(slice('  async function nativeDetachedCompleteOwnedQueue(',
    '  function nativeDetachedShowPanel(')+
    '\nglobalThis.finish=nativeDetachedCompleteOwnedQueue;',context);
  const messages=[];
  await context.finish(m=>messages.push(m));
  assert.equal(starts,2);
  assert.equal(cleaned,true);
  assert.equal(downloaded,false);
  assert.equal(run.result,'passed');
  assert.equal(run.conclusion.unattendedAdvance,'queue_remained_after_reported_browser_closure');
  assert.equal(run.conclusion.recoveryByExplicitAction.manualAdvances,2);
});

test('有陌生排队任务时，遗留队列恢复不会发出 mode=start',async()=>{
  const workspace=root+'/__ufs_lifecycle_verified_test2';
  const run={...structuredClone(sample),workspace,phase:'awaiting-closure',
    userConfirmedClosedAllTabs:true,
    conclusion:{unattendedAdvance:'queue_remained_after_reported_browser_closure'}};
  let starts=0,downloaded=false;
  const context={
    nativeLifecycleBusy:false,nativeDetachedRead:()=>run,
    nativeWriteBusy:false,copyJobs:[],readNativeActive:async()=>null,
    nativeProbeQueue:async()=>[{id:1,source:'/mnt/user/other',target:'/mnt/user/other',task:'foreign'}],
    nativeLifecycleJobsOwned:()=>{throw Error('原生队列包含其他任务或未知任务');},
    postNativeControl:async()=>{starts++;return '1';},
    nativeLifecycleNote:(r,name,x={})=>r.steps.push({name,...x}),
    nativeProbeDownload:()=>{downloaded=true;},
    Date
  };
  vm.runInNewContext(slice('  async function nativeDetachedCompleteOwnedQueue(',
    '  function nativeDetachedShowPanel(')+
    '\nglobalThis.finish=nativeDetachedCompleteOwnedQueue;',context);
  await context.finish(()=>{});
  assert.equal(starts,0);
  assert.equal(downloaded,true);
  assert.equal(run.recoveryAttempted,undefined);
  assert.equal(run.uncertain,true);
});
