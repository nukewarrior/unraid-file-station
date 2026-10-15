import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code=readFileSync(new URL('../src/unraid-file-station.user.js',import.meta.url),'utf8');
const begin=code.indexOf('  function nativeDispatchDecision(');
const end=code.indexOf('  async function nativeProbeIdle(',begin);
assert.ok(begin>0&&end>begin,'原生执行协调层必须可独立审查');

function harness({active=null,jobs=[],readFailure=null}={}){
  const requests=[];
  const diagnostics=[];
  const state={active,jobs};
  const context={
    readNativeActive:async()=>{requests.push('read');if(readFailure==='read')throw Error('read failed');return state.active;},
    nativeProbeQueue:async()=>{requests.push('jobs');if(readFailure==='jobs')throw Error('jobs failed');return state.jobs;},
    nativeProbeQueueFormat:'html-legacy',
    diagnosticLog:(level,code,details)=>diagnostics.push({level,code,details})
  };
  vm.runInNewContext(code.slice(begin,end)+
    '\nglobalThis.probe={decision:nativeDispatchDecision,guard:assertNativeDispatchIdle};',context);
  return {...context.probe,requests,diagnostics,state};
}

test('Unraid 无活动任务、无排队任务时允许本地任务开始',async()=>{
  const h=harness();
  const result=await h.guard('local-scheduler');
  assert.equal(result.allowed,true);
  assert.equal(result.queued,0);
  assert.deepEqual([...h.requests].sort(),['jobs','read']);
  assert.equal(h.diagnostics[0].code,'queue.native_dispatch_idle');
});
test('原生活动槽有任务时拒绝本地调度',async()=>{
  const h=harness({active:{action:8,source:'/mnt/user/other'}});
  await assert.rejects(h.guard('local-scheduler'),/Unraid 正有原生文件任务/);
  assert.equal(h.diagnostics[0].code,'queue.native_dispatch_blocked');
  assert.equal(h.diagnostics[0].details.reason,'native-active');
});
test('Unraid 排队任务存在时不允许 File Station 越队',async()=>{
  const h=harness({jobs:[{id:1,legacyText:'Job 1'},{id:2,legacyText:'Job 2'}]});
  await assert.rejects(h.guard('local-scheduler'),/2 项待执行任务/);
  assert.equal(h.diagnostics[0].details.reason,'native-queued');
  assert.equal(h.diagnostics[0].details.queued,2);
});
test('无法读取原生状态时阻止继续，不假设为空闲',async()=>{
  for(const readFailure of ['read','jobs']){
    const h=harness({readFailure});
    await assert.rejects(h.guard('local-scheduler'),new RegExp(readFailure+' failed'));
    assert.equal(h.diagnostics.some(x=>x.code==='queue.native_dispatch_idle'),false);
  }
  const h=harness({jobs:null});
  assert.equal(h.decision(null,null).allowed,false);
  assert.equal(h.decision(null,null).reason,'unknown-native-queue');
});
test('本地调度在设置 running / 写入数据库之前进行两项原生检查',()=>{
  const start=code.indexOf('  async function runCopyQueue(');
  const end=code.indexOf('  function resumeCopyQueue(',start);
  const queue=code.slice(start,end);
  const check=queue.indexOf("await assertNativeDispatchIdle('local-scheduler')");
  const starting=queue.indexOf("job.status='running'");
  const persist=queue.indexOf('await persistCopyQueue()');
  assert.ok(check>0 && check<starting && check<persist);
  assert.match(queue,/copyQueuePaused=true;/);
  assert.match(queue,/taskKeptQueued:true/);
  assert.doesNotMatch(queue,/mode\s*:\s*['"]start['"]/);
  assert.match(queue,/if\(destroyed \|\| copyQueuePaused \|\| !copyOwnerHeld/);
});
test('持久化意图后检查原生活动槽和队列；失败时不提交原生请求',()=>{
  const start=code.indexOf('  async function ensureNativeSlotFreeAfterIntent(');
  const end=code.indexOf('  function matchesCreateTask(',start);
  const check=code.slice(start,end);
  assert.match(check,/await readNativeActive\(\)/);
  assert.match(check,/await nativeProbeQueue\(\)/);
  assert.match(check,/jobs\.length/);
  assert.match(check,/本次请求未发送/);
  const moveStart=code.indexOf('  async function moveNativeBatch(');
  const moveEnd=code.indexOf('  async function moveNativeEntry(',moveStart);
  const batch=code.slice(moveStart,moveEnd);
  assert.ok(batch.indexOf("await assertNativeDispatchIdle('move-batch-pre-submit')")>
    batch.indexOf('if(beforeSubmit)await beforeSubmit()'));
  assert.ok(batch.indexOf("await assertNativeDispatchIdle('move-batch-pre-submit')")<
    batch.indexOf("const reply=await postNativeControl({mode:'file'"));
});
test('继续与刷新后的用户确认恢复也核查原生队列',()=>{
  const a=code.slice(code.indexOf('  async function confirmRecoveredCopyQueue()'),
    code.indexOf('  function showRecoveredCopyDetails('));
  const b=code.slice(code.indexOf('  function resumeCopyQueue()'),
    code.indexOf('  function isRemovableFailedCopyJob('));
  assert.match(a,/assertNativeDispatchIdle\('restore-confirmation'\)/);
  assert.match(b,/assertNativeDispatchIdle\('resume-local-queue'\)/);
});
