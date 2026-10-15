import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script=readFileSync(new URL('../src/unraid-file-station.user.js',import.meta.url),'utf8');
const begin=script.indexOf('  function nativeProbeOwned(');
const end=script.indexOf('  async function nativeProbeIdle(',begin);
assert.ok(begin>0 && end>begin,'应存在可独立测试的探针路径和队列读取封装');
const context={
  safePath:p=>typeof p==='string' && (p==='/mnt/user'||p.startsWith('/mnt/user/')) &&
    !p.split('/').some(x=>x==='.'||x==='..'||x.includes('\0'))
};
vm.runInNewContext(
  "const NATIVE_PROBE_ROOT='/mnt/user/downloads/新建文件夹';\n"+
  script.slice(begin,end)+"\nglobalThis.probe={nativeProbeOwned,nativeProbeSourcesOwned};",
  context
);
const base='/mnt/user/downloads/新建文件夹';
const own=base+'/__ufs_probe_abc123';
const {nativeProbeOwned,nativeProbeSourcesOwned}=context.probe;

test('探针只允许新建的独立专属目录和后代路径',()=>{
  assert.equal(nativeProbeOwned(own,own),true);
  assert.equal(nativeProbeOwned(own+'/source/a.txt',own),true);
  for(const path of [
    base,base+'/新建文件夹/4415616 (1).mp4',base+'/__ufs_probe_abc123X',
    '/mnt/user/downloads/other',
    own+'/source/../other',own+'/source/./a.txt'
  ])assert.equal(nativeProbeOwned(path,own),false,path);
  assert.equal(nativeProbeOwned(own,base+'/test'),false);
});

test('批量源路径每一项都必须位于授权的临时目录内',()=>{
  assert.equal(nativeProbeSourcesOwned(own+'/source/a.txt\r'+own+'/source/b.txt',own),true);
  assert.equal(nativeProbeSourcesOwned(own+'/source/a.txt\r'+base+'/existing.mp4',own),false);
  assert.equal(nativeProbeSourcesOwned(own+'/source/a.txt\r/boot/config',own),false);
  assert.equal(nativeProbeSourcesOwned('',own),false);
  assert.equal(nativeProbeSourcesOwned(own+'/source/a.txt\r',own),false);
});

test('实机测试不调用原生全局取消或任意行号撤销',()=>{
  const part=script.slice(script.indexOf('  const NATIVE_PROBE_ROOT='),script.indexOf('  function showDiagnosticCenter()'));
  assert.doesNotMatch(part,/action\s*:\s*['"]99['"]/);
  assert.doesNotMatch(part,/mode\s*:\s*['"]undo['"]/);
  assert.match(part,/report\.uncertain/);
  assert.match(part,/nativeProbeShapeSafe\(workspace,report\)/);
  assert.match(part,/nativeProbeDownload\(report\)/);
});
