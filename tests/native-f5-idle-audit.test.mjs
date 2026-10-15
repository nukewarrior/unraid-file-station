import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const src=readFileSync(new URL('../src/unraid-file-station.user.js',import.meta.url),'utf8');
const start=src.indexOf('  async function auditRecoveredIdleTasks()');
const end=src.indexOf('  async function monitorRecoveredNativeTask()',start);
assert.ok(start>0&&end>start,'F5 只读审计函数必须存在');
const body=src.slice(start,end);
const root='/mnt/user/downloads/新建文件夹';
const source=root+'/source/film.mp4',target=root+'/target';

function harness({queued=[],fileSize=100,destSize=100,move=false}={}){
  const calls=[],events=[];
  const job={taskId:'t1',status:'uncertain',recovered:true,destination:target,
    record:{operation:move?'move':'copy',items:[{source,folder:false,size:fileSize,submission:'intent-saved'}]}};
  const ctx={copyJobs:[job],destroyed:false,Number,Date,Promise,
    safePath:p=>p.startsWith(root+'/'),fileName:p=>p.split('/').at(-1),
    parentPath:p=>p.slice(0,p.lastIndexOf('/')),
    nativeProbeQueue:async()=>{calls.push('jobs');return queued;},
    listDirectory:async p=>{calls.push(p);return p===root+'/source'?
      (move?[]:[{path:source,folder:false,size:fileSize,copyPathVerified:true}]):
      [{path:target+'/film.mp4',folder:false,size:destSize,copyPathVerified:true}];},
    diagnosticLog:(level,code,details)=>events.push({level,code,details}),
    updateCopyTaskButton:()=>calls.push('render'),
    postNativeControl:()=>{throw Error('must never submit native work');},
    persistCopyQueue:()=>{throw Error('must never write IndexedDB');}};
  vm.runInNewContext(body+'\nglobalThis.run=auditRecoveredIdleTasks;',ctx);
  return {ctx,job,calls,events};
}
test('F5 空闲后匹配元信息但不改成功状态或提交记录',async()=>{
  const h=harness();await h.ctx.run();
  assert.equal(h.job.recoveryAudit.result,'metadata-consistent');
  assert.equal(h.job.status,'uncertain');
  assert.equal(h.job.record.items[0].submission,'intent-saved');
  assert.equal(h.calls.includes('render'),true);
});
test('目标大小不一致仍然待核实',async()=>{
  const h=harness({destSize:90});await h.ctx.run();
  assert.equal(h.job.recoveryAudit.result,'metadata-inconclusive');
  assert.equal(h.job.status,'uncertain');
});
test('移动时源已消失且目标匹配才给出元信息一致提示',async()=>{
  const h=harness({move:true});await h.ctx.run();
  assert.equal(h.job.recoveryAudit.result,'metadata-consistent');
});
test('原生等待队列非空禁止文件只读审计，不启动接力',async()=>{
  const h=harness({queued:[{id:1}]});await h.ctx.run();
  assert.deepEqual(h.calls,['jobs']);
  assert.equal(h.job.recoveryAudit,undefined);
  assert.equal(h.job.status,'uncertain');
});
test('一键审计不包含原生写入或完成状态确认',()=>{
  assert.doesNotMatch(body,/postNativeControl|persistCopyQueue|mode\s*:\s*['"]start/);
  assert.doesNotMatch(body,/\.status\s*=\s*['"]success/);
  assert.match(src,/await auditRecoveredIdleTasks\(\)/);
  assert.match(src,/@version\s+0\.2\.16\.2/);
});
