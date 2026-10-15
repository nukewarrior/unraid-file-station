import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const code=readFileSync(new URL('../src/unraid-file-station.user.js',import.meta.url),'utf8');
const begin=code.indexOf('  function nativeLifecycleOwn(');
const end=code.indexOf('  async function nativeLifecycleSafeCleanup(',begin);
assert.ok(begin>0&&end>begin,'生命周期探针函数应连续出现');
const root='/mnt/user/downloads/新建文件夹';
const workspace=root+'/__ufs_lifecycle_abcdef_12345';
const makeContext=(entries={})=>{
  const context={
    NATIVE_PROBE_ROOT:root,
    NATIVE_LIFECYCLE_KEY:'unraid-file-station:v1:native-lifecycle-v1',
    sessionStorage:{setItem(){},getItem(){return null;}},
    safePath:p=>typeof p==='string'&&(p==='/mnt/user'||p.startsWith('/mnt/user/'))&&
      !p.split('/').some(x=>x==='.'||x==='..'||x.includes('\0')),
    nativeProbeEntries:async p=>entries[p]||[],
    nativeProbeOwnQueuedJob:(job,source,target,task)=>
      job.source===source&&job.target===target&&job.task===task
  };
  vm.runInNewContext(code.slice(begin,end)+
    '\nglobalThis.probe={own:nativeLifecycleOwn,path:nativeLifecycleFilePath,'+
    'jobs:nativeLifecycleJobsOwned,active:nativeLifecycleActiveOwned,'+
    'findVideo:nativeLifecycleFindVideo};',context);
  return context.probe;
};
const makeRun=()=>({
  workspace,
  tasks:['ufs-lifecycle-unique-1','ufs-lifecycle-unique-2'],
  video:{path:root+'/新建文件夹/4415616 (1).mp4',name:'4415616 (1).mp4',size:400*1024*1024}
});
test('生命周期写入必须限定在专属随机工作目录中',()=>{
  const p=makeContext(),run=makeRun();
  assert.equal(p.own(workspace,run),true);
  assert.equal(p.own(workspace+'/large/video.mp4',run),true);
  for(const unsafe of [root,root+'/新建文件夹/4415616 (1).mp4',workspace+'evil',
    workspace+'/../outside',workspace+'/source/./x','/boot'])assert.equal(p.own(unsafe,run),false,unsafe);
  assert.equal(p.path(run,'source','queue1.txt'),workspace+'/source/queue1.txt');
  assert.throws(()=>p.path(run,'other','queue1.txt'),/超出授权/);
  assert.throws(()=>p.path(run,'source','../x'),/超出授权/);
  assert.equal(p.own(workspace,{workspace:root+'/not-owned'}),false);
});
test('只把大文件复制及自身两个队列复制视为合法活动任务',()=>{
  const p=makeContext(),r=makeRun();
  assert.equal(p.active(r,null),null);
  assert.equal(p.active(r,{action:8,source:r.video.path,target:workspace+'/large/'}),'large');
  for(const index of [1,2]){
    assert.equal(p.active(r,{action:8,source:workspace+'/source/queue'+index+'.txt',
      target:workspace+'/queue'+index+'/'}),'queue'+index);
  }
  assert.throws(()=>p.active(r,{action:8,source:root+'/existing-video.mp4',
    target:workspace+'/large/'}),/不属于测试/);
  assert.throws(()=>p.active(r,{action:9,source:r.video.path,
    target:workspace+'/large/'}),/不属于测试/);
});
test('原生队列只能包含归属于自身的任务，支持部分出队',()=>{
  const p=makeContext(),r=makeRun();
  const q1={id:1,source:workspace+'/source/queue1.txt',
    target:workspace+'/queue1/',task:r.tasks[0]};
  const q2={id:2,source:workspace+'/source/queue2.txt',
    target:workspace+'/queue2/',task:r.tasks[1]};
  assert.deepEqual(Array.from(p.jobs(r,[q1,q2])),[0,1]);
  assert.deepEqual(Array.from(p.jobs(r,[q2])),[1]);
  assert.deepEqual(Array.from(p.jobs(r,[])),[]);
  assert.throws(()=>p.jobs(r,[q1,{id:3,source:root+'/else',target:workspace,task:'copy'}]),
    /其他任务或未知任务/);
  assert.throws(()=>p.jobs(r,[q1,q1]),/其他任务或未知任务/);
});
test('视频选择只选授权目录中的有效 64MB–2GB MP4 并排除探针文件夹',async()=>{
  const large=root+'/新建文件夹',nested=large+'/新建文件夹2';
  const mp4={name:'4415616 (1).mp4',folder:false,path:large+'/4415616 (1).mp4',
    copyPathVerified:true,size:400*1024*1024};
  const hidden={...mp4,path:workspace+'/evil.mp4',size:600*1024*1024};
  const p=makeContext({
    [root]:[{folder:true,name:'新建文件夹',path:large},
      {folder:true,name:'__ufs_lifecycle_other',path:root+'/__ufs_lifecycle_other'}],
    [large]:[mp4,{folder:true,name:'新建文件夹2',path:nested}],
    [nested]:[{name:'too-small.mp4',folder:false,path:nested+'/too-small.mp4',size:30*1024*1024}],
    [root+'/__ufs_lifecycle_other']:[hidden]
  });
  const selected=await p.findVideo();
  assert.equal(selected.path,mp4.path);
  assert.equal(selected.size,mp4.size);
});
test('生命周期探针不包含全局停止或按行撤销',()=>{
  const probe=code.slice(code.indexOf('  const NATIVE_LIFECYCLE_KEY='),
    code.indexOf('  function showDiagnosticCenter()'));
  assert.doesNotMatch(probe,/action\s*:\s*['"]99['"]/);
  assert.doesNotMatch(probe,/mode\s*:\s*['"]undo['"]/);
  assert.match(probe,/run\.phase='before-reload'/);
  assert.match(probe,/window\.location\.reload\(\)/);
  assert.match(probe,/nativeLifecycleJobsOwned\(run,queued\)/);
  assert.match(probe,/nativeLifecycleSafeCleanup\(run\)/);
  assert.match(probe,/nativeProbeDownload\(/);
});
