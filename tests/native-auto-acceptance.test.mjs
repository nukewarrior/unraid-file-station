import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const script=readFileSync(new URL('../src/unraid-file-station.user.js',import.meta.url),'utf8');
const root='/mnt/user/downloads/新建文件夹';
const a=script.indexOf('  let nativeAcceptanceRunning=false;');
const b=script.indexOf('  function showNativeAcceptanceDialog()',a);
assert.ok(a>0 && b>a,'验收执行器应可独立测试');
const source=script.slice(a,b);

function harness({copyFailure=false,foreignQueue=false}={}){
  const items=new Map([[root,{folder:true}]]);
  let queued=[],startCount=0,accepted=0,moved=0,blocked=0,removed=false,report=null;
  const notes=[];
  const path=(p,name)=>p+'/'+name;
  const entries=async dir=>[...items.entries()].filter(([p])=>
    p!==dir && p.startsWith(dir+'/') && !p.slice(dir.length+1).includes('/'))
    .map(([p,item])=>({path:p,name:p.split('/').at(-1),folder:item.folder,
      size:item.content?.length||null,copyPathVerified:true}));
  const fakePlan=({type,source,destinationDir,folder,conflictPolicy})=>({
    type,source,destinationDir,folder,conflictPolicy,
    target:path(destinationDir,source.split('/').at(-1)),previewOnly:true
  });
  const context={
    NATIVE_PROBE_ROOT:root,DIAGNOSTIC_VERSION:'0.2.15.1',
    nativeAcceptanceRunning:false,nativeProbeRunning:false,nativeLifecycleBusy:false,
    isDemo:false,nativeCsrfToken(){},nativeProbeQueueFormat:'html-legacy',
    location:{pathname:'/Shares/Browse'},navigator:{userAgent:'test'},
    window:{NchanSubscriber(){}},performance:{now:()=>0},
    Date,Math,JSON,encodeURIComponent,
    diagnosticLog:(...args)=>notes.push(args),nativeProbeDownload:r=>{report=r;},
    nativeProbeOwned:(p,w)=>w.startsWith(root+'/__ufs_probe_') &&
      (p===w||p.startsWith(w+'/'))&&!p.includes('/../'),
    fileName:p=>p.split('/').at(-1),
    parentPath:p=>p.slice(0,p.lastIndexOf('/')),
    planFileOperation:fakePlan,
    nativeProbeEntries:entries,
    nativeProbeIdle:async()=>{if(queued.length)throw Error('队列未空闲');return [];},
    nativeProbeRun:async(r,name,_fields,expected,check,workspace)=>{
      if(expected.action===0){
        const dest=path(expected.source,expected.target);
        assert.ok(dest.startsWith(workspace));
        items.set(dest,{folder:true});
      }else if(expected.action===1){
        assert.equal(expected.source,workspace);
        for(const p of [...items.keys()])if(p===workspace||p.startsWith(workspace+'/'))
          items.delete(p);
        removed=true;
      }else throw Error('不支持的测试操作');
      assert.equal(await check(),true,name);
      r.steps.push({name,status:'passed'});
    },
    postNativeControl:async req=>{
      const mode=req.mode;
      if(mode==='save'){
        const filename=decodeURIComponent(req.file);
        assert.ok(filename.startsWith(root+'/__ufs_probe_v215_'));
        items.set(filename,{folder:false,content:decodeURIComponent(req.data)});
        return '';
      }
      if(mode==='file' && req.task){
        const source=decodeURIComponent(req.source);
        const target=decodeURIComponent(req.target);
        queued.push({id:1,source,target,task:decodeURIComponent(req.task)});
        if(foreignQueue)queued.push({id:2,source:'/mnt/user/outside',
          target:'/mnt/user/outside/',task:'other'});
        return '';
      }
      if(mode==='start'){
        assert.equal(queued.length,1,'不可启动外部队列');
        const job=queued.shift();
        const content=items.get(job.source)?.content;
        items.set(path(job.target.slice(0,-1),job.source.split('/').at(-1)),
          {folder:false,content});
        startCount++;return '1';
      }
      throw Error('unexpected mode '+mode);
    },
    nativeProbeWaitFile:async(p,content)=>items.get(p)?.content===content,
    readNativeActive:async()=>null,
    nativeProbeQueue:async()=>queued.slice(),
    nativeProbeOwnQueuedJob:(j,source,target,task)=>
      j.source===source&&j.target===target&&j.task===task,
    assertNativeDispatchIdle:async()=>{
      if(queued.length)throw Error('Unraid 原生队列尚有 '+queued.length+' 项待执行任务');
      return {allowed:true};
    },
    copyNativeEntry:async(plan)=>{
      if(queued.length){blocked++;throw Error('原生队列还有排队任务');}
      if(copyFailure)throw Error('请求可能已被 Unraid 接收；结果不确定');
      const data=items.get(plan.source);
      if(!data)throw Error('source not found');
      assert.equal(items.has(plan.target),false);
      items.set(plan.target,{folder:false,content:data.content});
      accepted++;return {path:plan.target};
    },
    moveNativeEntry:async(plan)=>{
      assert.equal(queued.length,0);
      const data=items.get(plan.source);
      if(!data)throw Error('source not found');
      items.set(plan.target,data);items.delete(plan.source);
      moved++;return {path:plan.target};
    },
    nativeProbeShapeSafe:async(workspace,r)=>{
      assert.equal(items.get(workspace+'/probe-owner.txt')?.content,r.ownerToken);
      for(const p of items.keys()) {
        if(!p.startsWith(workspace+'/'))continue;
        const rel=p.slice(workspace.length+1).split('/');
        assert.ok(rel[0]==='probe-owner.txt'||rel[0]==='source'||rel[0]==='target');
      }
    },
    waitNative:async()=>{},
  };
  vm.runInNewContext(source+'\nglobalThis.execute=nativeAcceptanceExecute;'+
    '\nglobalThis.own=nativeAcceptanceOwn;',context);
  return {context,notes,get report(){return report;},get startCount(){return startCount;},
    get accepted(){return accepted;},get moved(){return moved;},
    get blocked(){return blocked;},get removed(){return removed;},items};
}

test('自动验收调用正式复制/移动函数，拦截原生越队，并且只清理独立测试目录',async()=>{
  const h=harness();
  const result=await h.context.execute(()=>{});
  assert.equal(result.result,'passed');
  assert.equal(result.cleanup,'completed');
  assert.equal(result.uncertain,false);
  assert.equal(h.accepted,2);
  assert.equal(h.moved,1);
  assert.equal(h.blocked,1);
  assert.equal(h.startCount,1);
  assert.equal(h.removed,true);
  assert.equal(h.items.size,1,'不能移除授权根目录或其他真实文件');
  assert.equal(h.report.result,'passed');
  assert.equal(result.checks.productionSingleCopy,'verified');
  assert.equal(result.checks.productionMultiFileSerialCopy,
    'verified_two_production_copy_calls');
  assert.equal(result.checks.productionMove,'verified');
  assert.equal(result.checks.nativeDispatchGuard,'verified');
  assert.equal(result.checks.productionCopyBlockedByNativeQueue,'verified');
  assert.equal(result.checks.ownedNativeQueueStart,'verified');
  assert.equal(result.checks.localIndexedDBScheduler,'not_tested');
});
test('原生复制结果不确定时保留现场且不启动测试队列',async()=>{
  const h=harness({copyFailure:true});
  const result=await h.context.execute(()=>{});
  assert.equal(result.result,'failed');
  assert.equal(result.uncertain,true);
  assert.equal(result.cleanup,'skipped_or_failed');
  assert.equal(h.startCount,0);
  assert.equal(h.removed,false);
  assert.equal(h.report.result,'failed');
  assert.match(result.error,/结果不确定/);
});
test('如果原生队列混入外部任务，拒绝启动 mode=start 和清理',async()=>{
  const h=harness({foreignQueue:true});
  const result=await h.context.execute(()=>{});
  assert.equal(result.result,'failed');
  assert.equal(result.uncertain,true);
  assert.equal(h.startCount,0);
  assert.equal(h.removed,false);
  assert.match(result.error,/唯一归属/);
});
test('源和目标必须严格属于随机授权测试目录',()=>{
  const h=harness();
  const w=root+'/__ufs_probe_v215_abcdef_ghi';
  assert.equal(h.context.own(w,w+'/source/batch-a.txt'),true);
  for(const p of [
    root+'/other.mp4',root+'/__ufs_probe_other/file.txt',
    w+'/../escape',w+'2/source/batch-a.txt','/boot/test.txt'
  ])assert.equal(h.context.own(w,p),false,p);
});
test('生产自动验收不调用全局停止或按编号移除队列',()=>{
  assert.doesNotMatch(source,/action\s*:\s*['"]99['"]/);
  assert.doesNotMatch(source,/mode\s*:\s*['"]undo['"]/);
  assert.match(source,/copyNativeEntry/);
  assert.match(source,/moveNativeEntry/);
  assert.match(source,/assertNativeDispatchIdle\('automated-acceptance'\)/);
  assert.match(source,/nativeProbeOwnQueuedJob/);
  assert.match(source,/nativeProbeShapeSafe/);
});
