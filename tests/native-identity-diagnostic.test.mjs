import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src=readFileSync(new URL('../src/unraid-file-station.user.js',import.meta.url),'utf8');
const a=src.indexOf('  // v0.2.16: read-only native identity inspection.');
const b=src.indexOf('  // v0.2.15: this is the first shared read-only native execution boundary.',a);
assert.ok(a>0 && b>a,'Read-only association module missing');
const source=src.slice(a,b);

const makeJob=(taskId,operation='copy',items=null,extra={})=>({
  taskId,record:{operation,destination:'/mnt/user/target',
    items:items||[{source:'/mnt/user/origin/a.txt',folder:false,
      status:'copying',submission:'intent-saved'}],...extra}
});
const match=(active,signature,op)=>{
  return active && Number(active.action)===(op==='copy'?8:op==='move'?9:6) &&
    active.source===signature.source &&
    active.target===signature.destinationDir+'/';
};
const context={
  matchesCopyTask:(active,signature)=>match(active,signature,'copy'),
  matchesMoveTask:(active,signature)=>match(active,signature,'move'),
  matchesDeleteTask:(active,signature)=>match(active,signature,'delete'),
  savedMoveBatchPlans:record=>record.batchMode==='native-move-files'?
    record.items.map(item=>({source:item.source,destinationDir:record.destination})):null,
  matchesMoveBatchTask:(active,plans)=>!!active &&
    Number(active.action)===9 &&
    active.source===plans.map(p=>p.source).join('\r') &&
    active.target===plans[0].destinationDir+'/',
  copyJobs:[],Date,Promise,Object,Array,
  nativeProbeDownload(){},diagnosticLog(){},
  readNativeActive:async()=>null,nativeProbeQueue:async()=>[],
  nativeProbeQueueFormat:'html-legacy',
  DIAGNOSTIC_VERSION:'0.2.16.0',
};
vm.runInNewContext(source+
  '\nglobalThis.api={candidates:nativeSavedTaskCandidates,describe:nativeDescribeTaskRelation,export:nativeExportIdentityDiagnostic};',
  context);

test('活动槽仅以原生动作+完整源路径+完整目标路径匹配已提交意图',()=>{
  const active={action:8,source:'/mnt/user/origin/a.txt',target:'/mnt/user/target/'};
  const jobs=[makeJob('task-unique')];
  const good=context.api.describe(active,[],jobs);
  assert.equal(good.activeRelation,'unique-signature-candidate');
  assert.equal(good.candidates.length,1);
  assert.equal(good.candidates[0].taskId,'task-unique');
  assert.equal(good.noWriteActions,true);
  for(const different of [
    {...active,action:9},
    {...active,source:'/mnt/user/origin/a.txt-evil'},
    {...active,target:'/mnt/user/targetX/'},
  ]){
    const fail=context.api.describe(different,[],jobs);
    assert.equal(fail.activeRelation,'unmatched');
    assert.equal(fail.candidates.length,0);
  }
});
test('两个保存记录具有同一原生签名时，必须标成歧义而不是认领',()=>{
  const active={action:8,source:'/mnt/user/origin/a.txt',target:'/mnt/user/target/'};
  const report=context.api.describe(active,[],[
    makeJob('task-one'),makeJob('task-two')]);
  assert.equal(report.activeRelation,'ambiguous');
  assert.equal(report.candidates.length,2);
});
test('未曾提交、已完成或记录字段不全的本地任务不能匹配活动槽',()=>{
  const active={action:8,source:'/mnt/user/origin/a.txt',target:'/mnt/user/target/'};
  const jobs=[
    makeJob('never-sent','copy',[{source:active.source,folder:false,
      status:'queued',submission:'not-submitted'}]),
    makeJob('completed','copy',[{source:active.source,folder:false,
      status:'success',submission:'confirmed'}]),
    {taskId:'missing-record'},
    {record:{items:[]}},
  ];
  const result=context.api.describe(active,[],jobs);
  assert.equal(result.activeRelation,'unmatched');
  assert.equal(result.candidates.length,0);
});
test('原生 CR 多源批量移动只能整批精确匹配，不能把单项认作批次',()=>{
  const sources=['a.txt','b.txt','c.txt'].map(x=>'/mnt/user/origin/'+x);
  const job=makeJob('batch-move','move',sources.map(source=>({
    source,folder:false,status:'copying',submission:'intent-saved'
  })),{batchMode:'native-move-files'});
  const active={action:9,source:sources.join('\r'),target:'/mnt/user/target/'};
  const result=context.api.describe(active,[],[job]);
  assert.equal(result.activeRelation,'unique-signature-candidate');
  assert.equal(result.candidates[0].batch,true);
  assert.equal(result.candidates[0].count,3);
  assert.equal(result.candidates[0].itemIndex,-1);
  const missing=context.api.describe({...active,source:sources[0]},[],[job]);
  assert.equal(missing.activeRelation,'unmatched');
});
test('原生排队项只有展示文本或无可靠提交 ID 时只记录无法归属，不改变队列',()=>{
  const report=context.api.describe(null,[{id:1,legacyText:'Job 001 - whatever'}],[]);
  assert.equal(report.activeRelation,'idle');
  assert.equal(report.queuedRelation,'unattributed');
  assert.equal(report.queuedCount,1);
  assert.equal(report.noWriteActions,true);
  assert.throws(()=>context.api.describe(null,{},[]),/不可信/);
});
test('一键只读诊断从 read 和 jobs 获取状态，不调用 mode=start 或 file',async()=>{
  const calls=[];
  context.copyJobs=[makeJob('test')];
  context.readNativeActive=async()=>{calls.push('read');return {
    action:8,source:'/mnt/user/origin/a.txt',target:'/mnt/user/target/'};};
  context.nativeProbeQueue=async()=>{calls.push('jobs');return [];};
  context.nativeProbeDownload=report=>{context.exported=report;};
  const result=await context.api.export(()=>{});
  assert.equal(result.result,'observed');
  assert.equal(result.activeRelation,'unique-signature-candidate');
  assert.deepEqual(calls.sort(),['jobs','read']);
  assert.equal(result.localTaskCount,1);
  assert.equal(context.exported,result);
  assert.doesNotMatch(source,/postNativeControl\(\{\s*mode:\s*['"](?:start|file|undo)['"]/);
});
test('成功安全清理后的历史错误字段应明确归档，不误报当前清理失败',()=>{
  const begin=src.indexOf("        imported.originalCleanup=imported.cleanup;");
  const end=src.indexOf("        imported.lateCleanupAt=",begin);
  const block=src.slice(begin,end);
  assert.match(block,/imported\.originalCleanupReason=imported\.cleanupReason\|\|null;/);
  assert.match(block,/delete imported\.cleanupReason;/);
  assert.match(block,/imported\.cleanup='completed';/);
});
