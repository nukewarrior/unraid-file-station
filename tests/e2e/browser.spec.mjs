import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.UFS_TEST_ORIGIN || 'http://127.0.0.1:8765';
let browser;

const contents = {
  '/mnt/user': [
    ['TimeMachine',true], ['appdata',true], ['docker',true], ['downloads',true]
  ],
  '/mnt/user/TimeMachine': [
    ['backup',true], ['Photos',true], ['notes.txt',false]
  ],
  '/mnt/user/TimeMachine/backup': [
    ['snapshot.zip',false]
  ],
  '/mnt/user/TimeMachine/Photos': [
    ['sunset.jpg',false]
  ],
  '/mnt/user/downloads': [
    ['completed',true], ['large.zip',false]
  ],
  '/mnt/user/appdata': [
    ['bitwarden',true], ['new.ini',false]
  ],
  '/mnt/user/appdata/bitwarden': [
    ['data.json',false]
  ],
  '/mnt/user/docker': [['containers',true]]
};
function bulkRows(path,count) {
  let html='<tbody>';
  for (let i=0; i<count; i++) {
    const name='file-'+String(i).padStart(5,'0')+'.txt';
    const full=path+'/'+name;
    html+='<tr>'+
      '<td><i type="f" id="row_'+i+'" data="'+full+'"></i></td>'+
      '<td>'+name+'</td><td></td><td>nobody</td><td>-rw-rw-rw-</td>'+
      '<td data="2048">2048</td><td data="1791435600">date</td>'+
      '<td><span id="device_'+i+'">disk2</span></td></tr>';
  }
  return html+'</tbody>';
}

const esc = text => String(text).replace(/[&<>"']/g, ch =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

function responseFor(path, extra = [], list = contents[path] || []) {
  const children = [...list, ...extra];
  return '<tbody>' + children.map(([name,folder], index) => {
    const full = path + '/' + name;
    const locations = name === 'backup'
      ? Array.from({length:24},(_,i)=>'disk'+(i+1))
      : ['disk2','disk3'];
    const fields = [
      '<i id="row_'+index+'" data="'+esc(full)+'" type="'+(folder?'d':'f')+'"></i>',
      esc(name), '-','nobody','drwxrwxrwx','0','0',
      locations.map((device,i)=>'<span id="device_'+index+'_'+i+'">'+device+'</span>').join('')
    ];
    return '<tr>'+fields.map((field,i) =>
      '<td '+(i===5?'data="2048"':i===6?'data="1791435600"':'')+'>'+field+'</td>'
    ).join('')+'</tr>';
  }).join('')+'</tbody>';
}

const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'+
  '<style>body{margin:0;font-family:Arial,sans-serif}#header{height:75px;background:#1e1e1e;color:white;padding:8px}'+
  '#footer{position:fixed;bottom:0;height:24px;background:#ddd;width:100%}</style>'+
  '</head><body><div id="header">UNRAID SHARES</div><div class="autoheight">'+
  '<table class="indexer"><tbody><tr><td>原生文件管理器</td></tr></tbody></table></div>'+
  '<div id="footer">Array Started</div>'+
  '<script src="/src/unraid-file-station.user.js"></script></body></html>';

async function pageFor(t, options = {}) {
  const context = await browser.newContext({viewport: {width: options.width || 1440, height: 900}});
  t.after(()=>context.close());
  await context.addInitScript({content:options.noCsrf ? 'delete window.csrf_token;' : "window.csrf_token = 'test-csrf';"});
  if(options.nativeMode) {
    await context.addInitScript({content: "localStorage.setItem('unraid-file-station:v1:native','1');"});
  }
  if(options.simulateNativeMonitor) {
    await context.addInitScript({content: String.raw`
      (() => {
        const subscribers = [];
        class MockNchanSubscriber {
          constructor(url) {
            this.url = url;
            this.active = false;
            this.startCalls = 0;
            this.stopCalls = 0;
            this.handlers = [];
            subscribers.push(this);
          }
          on(type, callback) {
            if (type === 'message') this.handlers.push(callback);
          }
          start() { this.startCalls++; this.active = true; }
          stop() { this.stopCalls++; this.active = false; }
        }
        window.NchanSubscriber = MockNchanSubscriber;
        window.timers = {filemonitor: null};
        window.dfm = {running: false};
        window.filemonitor = new MockNchanSubscriber('/sub/filemonitor');
        window.filemonitor.on('message', state => {
          if (state == 1 && !window.dfm.running && !window.timers.filemonitor) {
            window.timers.filemonitor = setTimeout(() => {
              if (window.dfm.running) clearTimeout(window.timers.filemonitor);
              else location.replace(location.href);
            }, 1500);
          }
        });
        setTimeout(() => window.filemonitor.start(), 3000);
        window.__ufsMonitorTest = {
          subscribers,
          emit(value) {
            subscribers.filter(s => s.url === '/sub/filemonitor' && s.active)
              .forEach(s => s.handlers.forEach(fn => fn(value)));
          }
        };
      })();
    `});
  }

  const page = await context.newPage();
  const errors = [];
  const nativePosts = [];
  const created = [];
  const renamed = [];
  const copied = [];
  const browseRequests = [];
  let copyActiveReads = 0;
  let latestCopy = null;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/Shares/Browse?*',route=>route.fulfill({status:200,contentType:'text/html',body:html}));
  let rootFailures = options.rootFailures || 0;
  await page.route('**/webGui/include/Browse.php?*', async route => {
    const query = new URL(route.request().url()).searchParams;
    const path = decodeURIComponent(query.get('dir') || '');
    browseRequests.push(path);
    if (path === '/mnt/user' && rootFailures-- > 0) {
      await route.fulfill({status:500,body:'temporary root error'}).catch(()=>{});
      return;
    }
    if (path === '/mnt/user/downloads' && options.delayDownloads) {
      await new Promise(resolve=>setTimeout(resolve,options.delayDownloads));
    }
    const oldPath=renamed.reduceRight((result,rename)=>
      result===rename.target || result.startsWith(rename.target+'/')
        ? rename.source+result.slice(rename.target.length) : result,path);
    const sourceForCopied=copied.find(item=>oldPath===item.target || oldPath.startsWith(item.target+'/'));
    const sourcePath=sourceForCopied?
      sourceForCopied.source + oldPath.slice(sourceForCopied.target.length) : oldPath;
    const originalRows=contents[sourcePath] || [];
    const mappedRows=originalRows.map(([name,folder])=>{
      const oldEntry=oldPath+'/'+name;
      const changed=renamed.find(item=>item.source===oldEntry);
      return [changed ? changed.target.split('/').pop() : name,folder];
    });
    const copyRows=copied.filter(item=>item.destinationDir===path)
      .map(item=>[item.name,item.folder]);
    const conflictRows=options.copyConflictDest===path ? [['notes.txt',false]] : [];
    const response=options.bulkCount && path==='/mnt/user/TimeMachine' ?
      bulkRows(path,options.bulkCount) : responseFor(path,
        [...(path==='/mnt/user/TimeMachine' ? created.map(name=>[name,true]) : []),
         ...copyRows,...conflictRows], mappedRows);
    await route.fulfill({status:200,contentType:'text/html',body:response}).catch(()=>{});
  });
  await page.route('**/webGui/include/Control.php',async route=>{
    const body=new URLSearchParams(route.request().postData() || '');
    const mode=body.get('mode');
    nativePosts.push({mode,action:body.get('action'),source:body.get('source'),target:body.get('target'),csrf:body.get('csrf_token')});
    if (body.get('csrf_token') !== 'test-csrf') {
      await route.fulfill({status:403,body:'CSRF rejected'});
      return;
    }
    if (mode==='read') {
      const busy=options.nativeBusy ?
        JSON.stringify({action:'6',source:'/mnt/user/TimeMachine/backup',target:''}) :
        latestCopy && ++copyActiveReads===1 ? JSON.stringify({
          action:latestCopy.folder?'3':'8',source:latestCopy.source,
          target:latestCopy.destinationDir+'/'}) : '';
      await route.fulfill({status:200,body:busy});
      return;
    }
    if (mode==='file' && body.get('action')==='0') {
      const parent=decodeURIComponent(body.get('source') || '');
      const name=decodeURIComponent(body.get('target') || '');
      if (!options.dropCreate && parent==='/mnt/user/TimeMachine') created.push(name);
      await route.fulfill({status:200,body:''});
      return;
    }
    if(mode==='file' && ['2','7'].includes(body.get('action'))) {
      const source=decodeURIComponent(body.get('source') || '');
      const name=decodeURIComponent(body.get('target') || '');
      if(!options.dropRename) renamed.push({source,target:source.slice(0,source.lastIndexOf('/'))+'/'+name});
      await route.fulfill({status:200,body:''});
      return;
    }
    if(mode==='file' && ['3','8'].includes(body.get('action'))) {
      const source=decodeURIComponent(body.get('source')||'');
      const destinationDir=decodeURIComponent(body.get('target')||'').replace(/\/$/,'');
      const name=source.slice(source.lastIndexOf('/')+1);
      const folder=body.get('action')==='3';
      latestCopy={source,destinationDir,name,folder,target:destinationDir+'/'+name};
      copyActiveReads=0;
      if(!options.dropCopy) copied.push(latestCopy);
      await route.fulfill({status:200,body:''});
      return;
    }
    await route.fulfill({status:400,body:'Unexpected native operation'});
  });
  await page.goto(base + '/Shares/Browse?dir=%2Fmnt%2Fuser');
  return {page,errors,nativePosts,created,renamed,copied,browseRequests};
}

const currentLabel = page => page.locator('.ufs-tab.ufs-active .ufs-tab-name');
const rows = page => page.locator('.ufs-entry');

before(async()=> { browser = await chromium.launch({headless:true}); });
after(async()=> { await browser?.close(); });

test('首次根路径进入首个共享目录；根分组不可选；展开箭头不会导航', async t => {
  const {page,errors} = await pageFor(t);
  await page.locator('.ufs-tab.ufs-active .ufs-tab-name', {hasText:'TimeMachine'}).waitFor();
  await page.locator('.ufs-entry').first().waitFor();
  assert.equal(new URL(page.url()).searchParams.get('dir'),'/mnt/user/TimeMachine');
  const root = page.locator('.ufs-tree-row.ufs-tree-group');
  assert.equal(await root.count(),1);
  assert.equal(await root.evaluate(el=>el.classList.contains('ufs-current')),false);
  await root.locator('.ufs-tree-name').click();
  assert.equal(await currentLabel(page).innerText(),'TimeMachine');
  const appdata = page.locator('.ufs-tree-row').filter({has:page.locator('.ufs-tree-name', {hasText:'appdata'})}).first();
  await appdata.locator('.ufs-tree-toggle').click();
  assert.equal(await currentLabel(page).innerText(),'TimeMachine');
  assert.equal(errors.length,0,errors.join('\n'));
});

test('切换目录、浏览器后退和标签内部后退保持一致', async t => {
  const {page,errors} = await pageFor(t);
  await page.locator('.ufs-tab.ufs-active .ufs-tab-name', {hasText:'TimeMachine'}).waitFor();
  await page.locator('.ufs-tree-row').filter({has:page.locator('.ufs-tree-name', {hasText:'downloads'})}).first().click();
  await page.locator('.ufs-tab.ufs-active .ufs-tab-name', {hasText:'downloads'}).waitFor();
  await page.locator('.ufs-tree-row').filter({has:page.locator('.ufs-tree-name', {hasText:'appdata'})}).first().click();
  await page.locator('.ufs-tab.ufs-active .ufs-tab-name', {hasText:'appdata'}).waitFor();
  await page.goBack();
  await page.locator('.ufs-tab.ufs-active .ufs-tab-name', {hasText:'downloads'}).waitFor();
  await page.locator('.ufs-back').click();
  await page.locator('.ufs-tab.ufs-active .ufs-tab-name', {hasText:'TimeMachine'}).waitFor();
  await page.locator('.ufs-next').click();
  await page.locator('.ufs-tab.ufs-active .ufs-tab-name', {hasText:'downloads'}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('dir'),'/mnt/user/downloads');
  assert.equal(errors.length,0,errors.join('\n'));
});

test('快速切换目录时旧请求不能覆盖当前目录；多选和 LOCATION 仍可用', async t => {
  const {page,errors} = await pageFor(t,{delayDownloads:700});
  await page.locator('.ufs-tab.ufs-active .ufs-tab-name', {hasText:'TimeMachine'}).waitFor();
  await page.locator('.ufs-tree-row').filter({has:page.locator('.ufs-tree-name', {hasText:'downloads'})}).first().click();
  await page.locator('.ufs-tree-row').filter({has:page.locator('.ufs-tree-name', {hasText:'appdata'})}).first().click();
  await page.locator('.ufs-entry').filter({hasText:'bitwarden'}).first().waitFor();
  await page.waitForTimeout(800);
  assert.equal(await rows(page).count(),2);
  assert.equal(await currentLabel(page).innerText(),'appdata');
  await rows(page).nth(0).click();
  await rows(page).nth(1).click({modifiers:['Shift']});
  assert.equal(await page.locator('.ufs-entry.ufs-selected').count(),2);
  await page.locator('.ufs-tree-row').filter({has:page.locator('.ufs-tree-name', {hasText:'TimeMachine'})}).first().click();
  await page.locator('.ufs-entry').filter({hasText:'backup'}).first().waitFor();
  await page.locator('.ufs-entry').filter({hasText:'backup'}).locator('.ufs-location-trigger').click();
  assert.equal(await page.locator('.ufs-location-device').count(),24);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('可调整列宽并保持记忆；根目录读取失败时可以重试', async t => {
  const {page,errors} = await pageFor(t,{rootFailures:1});
  await page.locator('.ufs-error').waitFor();
  await page.locator('.ufs-refresh').click();
  await page.locator('.ufs-tab.ufs-active .ufs-tab-name', {hasText:'TimeMachine'}).waitFor();
  const grip = page.locator('.ufs-head > span').nth(1).locator('.ufs-column-grip');
  const rect = await grip.boundingBox();
  assert.ok(rect,'column grip must have bounding box');
  await page.mouse.move(rect.x + rect.width/2,rect.y + rect.height/2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width/2 + 45,rect.y + rect.height/2,{steps:5});
  await page.mouse.up();
  const saved = await page.evaluate(()=>JSON.parse(localStorage.getItem('unraid-file-station:v1:columns')));
  assert.ok(saved.size > 95,saved.size);
  await page.reload();
  await page.locator('.ufs-tab.ufs-active .ufs-tab-name', {hasText:'TimeMachine'}).waitFor();
  const retained = await page.evaluate(()=>JSON.parse(localStorage.getItem('unraid-file-station:v1:columns')));
  assert.equal(retained.size,saved.size);
  assert.equal(errors.length,0,errors.join('\n'));
});


test('浏览器历史恢复到另一已有标签的相同路径时仍正确刷新列表', async t => {
  const {page,errors} = await pageFor(t);
  await page.locator('.ufs-tab.ufs-active .ufs-tab-name', {hasText:'TimeMachine'}).waitFor();
  await page.locator('.ufs-entry').filter({hasText:'notes.txt'}).first().waitFor();
  // Create a second tab; switch its content to appdata.
  await page.locator('.ufs-tabs > .ufs-ico[aria-label="新建标签页"]').click();
  await page.locator('.ufs-tab').nth(1).waitFor();
  await page.locator('.ufs-tree-row').filter({has:page.locator('.ufs-tree-name', {hasText:'appdata'})}).first().click();
  await page.locator('.ufs-entry').filter({hasText:'new.ini'}).first().waitFor();
  // Reproduce Chrome restoring an older history entry for the first tab:
  // that tab already points to TimeMachine, but the visible rows are appdata.
  await page.evaluate(() => {
    const path='/mnt/user/TimeMachine';
    const state={ufs:true,tabId:1,path};
    const url=new URL(location.href);
    url.searchParams.set('dir',path);
    history.replaceState(state,'',url);
    window.dispatchEvent(new PopStateEvent('popstate',{state}));
  });
  await page.locator('.ufs-tab.ufs-active .ufs-tab-name', {hasText:'TimeMachine'}).waitFor();
  await page.locator('.ufs-entry').filter({hasText:'notes.txt'}).first().waitFor();
  assert.equal(await page.locator('.ufs-entry').filter({hasText:'new.ini'}).count(),0);
  assert.equal(errors.length,0,errors.join('\n'));
});


test('1200 文件列表只挂载可视行；滚动与 Shift 连选跨窗口保持绝对索引', async t => {
  const {page,errors}=await pageFor(t,{bulkCount:1200});
  await page.locator('.ufs-count', {hasText:'1200 个项目'}).waitFor();
  const list=page.locator('.ufs-list');
  assert.equal(await list.evaluate(el=>el.classList.contains('ufs-virtualized')),true);
  assert.ok(await rows(page).count()<100);
  await page.locator('.ufs-entry[data-ufs-index="0"]').click();
  await list.evaluate(el=>{el.scrollTop=el.scrollHeight;});
  await page.locator('.ufs-entry[data-ufs-index="1199"]').waitFor();
  assert.ok(await rows(page).count()<100);
  await page.locator('.ufs-entry[data-ufs-index="1199"]').click({modifiers:['Shift']});
  await page.locator('.ufs-count', {hasText:'已选择 1200 个项目'}).waitFor();
  const selectedMounted=await page.locator('.ufs-entry.ufs-selected').count();
  assert.ok(selectedMounted>0 && selectedMounted<100);
  await list.evaluate(el=>{el.scrollTop=0;});
  await page.locator('.ufs-entry[data-ufs-index="0"].ufs-selected').waitFor();
  assert.equal(errors.length,0,errors.join('\n'));
});

test('1200 文件网格视图也虚拟化，调整窗口后仍能滚动到底部', async t => {
  const {page,errors}=await pageFor(t,{bulkCount:1200});
  await page.locator('.ufs-count',{hasText:'1200 个项目'}).waitFor();
  await page.locator('.ufs-grid-button').click();
  const list=page.locator('.ufs-list.ufs-grid.ufs-virtualized');
  await list.waitFor();
  assert.ok(await rows(page).count()<160);
  await page.setViewportSize({width:960,height:760});
  await list.evaluate(el=>{el.scrollTop=el.scrollHeight;});
  await page.locator('.ufs-entry[data-ufs-index="1199"]').waitFor();
  assert.ok(await rows(page).count()<160);
  await page.locator('.ufs-list-button').click();
  await page.locator('.ufs-entry[data-ufs-index="0"]').waitFor();
  assert.equal(errors.length,0,errors.join('\n'));
});


test('网格已经滚至最底部时改变列数，应保留最后的文件与底部锚点', async t => {
  const {page,errors}=await pageFor(t,{bulkCount:1200,width:1600});
  await page.locator('.ufs-count',{hasText:'1200 个项目'}).waitFor();
  await page.locator('.ufs-grid-button').click();
  const list=page.locator('.ufs-list.ufs-grid.ufs-virtualized');
  await list.evaluate(el=>{el.scrollTop=el.scrollHeight;});
  await page.locator('.ufs-entry[data-ufs-index="1199"]').waitFor();
  await page.setViewportSize({width:950,height:760});
  await page.locator('.ufs-entry[data-ufs-index="1199"]').waitFor();
  await page.waitForTimeout(100); // Allow queued ResizeObserver / RAF updates to settle.
  const metrics=await list.evaluate(el=>({
    scrollTop:el.scrollTop,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,
    gap:el.scrollHeight-el.clientHeight-el.scrollTop,
    gridColumns:getComputedStyle(el.querySelector('.ufs-virtual-grid')).gridTemplateColumns
  }));
  assert.ok(metrics.gap<8,'grid bottom anchor '+JSON.stringify(metrics));
  assert.equal(errors.length,0,errors.join('\n'));
});


test('v0.1.16 一次真实鼠标滚轮不会被虚拟行更新持续放大', async t => {
  const {page,errors}=await pageFor(t,{bulkCount:1200});
  await page.locator('.ufs-count',{hasText:'1200 个项目'}).waitFor();
  const list=page.locator('.ufs-list.ufs-virtualized');
  await list.waitFor();
  const before=await list.evaluate(el=>({
    top:el.scrollTop,height:el.scrollHeight,anchor:getComputedStyle(el).overflowAnchor
  }));
  assert.equal(before.top,0);
  assert.equal(before.anchor,'none','虚拟列表必须禁用 Chromium 自动滚动锚定');
  const rect=await list.boundingBox();
  assert.ok(rect && rect.height>100);
  await page.mouse.move(rect.x+Math.min(130,rect.width/2),rect.y+Math.min(180,rect.height/2));
  await page.mouse.wheel(0,380); // One wheel input, no more events afterwards.
  await page.waitForFunction(()=>document.querySelector('.ufs-list').scrollTop>=370);
  const early=await list.evaluate(el=>el.scrollTop);
  await page.waitForTimeout(900); // The original bug kept increasing after this delay.
  const settled=await list.evaluate(el=>({
    top:el.scrollTop,height:el.scrollHeight,mounted:el.querySelectorAll('.ufs-entry').length
  }));
  assert.ok(Math.abs(early-380)<=8,'一次 wheel 应约滚动 380px，实际 '+early);
  assert.ok(Math.abs(settled.top-early)<=3,
    '没有额外 wheel 时 scrollTop 不应继续增加: '+JSON.stringify({early,settled}));
  assert.ok(Math.abs(settled.height-before.height)<=1,
    '虚拟窗口滚动前后总高度应稳定: '+JSON.stringify({before,settled}));
  assert.ok(settled.mounted<100);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.1.16 网格虚拟滚动同样不放大单次 wheel 输入', async t => {
  const {page,errors}=await pageFor(t,{bulkCount:1200});
  await page.locator('.ufs-count',{hasText:'1200 个项目'}).waitFor();
  await page.locator('.ufs-grid-button').click();
  const list=page.locator('.ufs-list.ufs-grid.ufs-virtualized');
  await list.waitFor();
  assert.equal(await list.evaluate(el=>getComputedStyle(el).overflowAnchor),'none');
  const rect=await list.boundingBox();
  assert.ok(rect && rect.height>100);
  await page.mouse.move(rect.x+Math.min(130,rect.width/2),rect.y+Math.min(180,rect.height/2));
  await page.mouse.wheel(0,380);
  await page.waitForFunction(()=>document.querySelector('.ufs-list').scrollTop>=370);
  const early=await list.evaluate(el=>el.scrollTop);
  await page.waitForTimeout(900);
  const settled=await list.evaluate(el=>el.scrollTop);
  assert.ok(Math.abs(early-380)<=8,'网格单次滚轮应约滚动 380px，实际 '+early);
  assert.ok(Math.abs(settled-early)<=3,
    '网格滚动不能自行增加: '+JSON.stringify({early,settled}));
  assert.equal(errors.length,0,errors.join('\n'));
});


async function newFolderDialog(page) {
  await page.locator('.ufs-tab.ufs-active .ufs-tab-name',{hasText:'TimeMachine'}).waitFor();
  await page.locator('.ufs-create-trigger').click();
  await page.getByRole('menuitem',{name:'新建文件夹'}).click();
  await page.locator('.ufs-create-dialog').waitFor();
}

test('v0.2.1 新建文件夹经模拟原生接口提交一次并验证出现后刷新', async t=>{
  const {page,errors,nativePosts,created}=await pageFor(t);
  await newFolderDialog(page);
  assert.equal(await page.locator('.ufs-create-location').innerText(),'/mnt/user/TimeMachine');
  await page.locator('.ufs-create-input').fill('E2E 新目录');
  await page.locator('.ufs-create-submit').click();
  await page.locator('.ufs-entry').filter({hasText:'E2E 新目录'}).first().waitFor();
  assert.deepEqual(created,['E2E 新目录']);
  const writes=nativePosts.filter(x=>x.mode==='file');
  assert.equal(writes.length,1);
  assert.equal(writes[0].action,'0');
  assert.equal(writes[0].csrf,'test-csrf');
  assert.equal(decodeURIComponent(writes[0].source),'/mnt/user/TimeMachine');
  assert.equal(decodeURIComponent(writes[0].target),'E2E 新目录');
  assert.equal(await page.locator('.ufs-create-dialog').count(),0);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.1 拒绝重复目录及危险名称，不会发出文件写入请求', async t=>{
  const {page,errors,nativePosts}=await pageFor(t);
  await newFolderDialog(page);
  await page.locator('.ufs-create-input').fill('backup');
  await page.locator('.ufs-create-submit').click();
  await page.locator('.ufs-create-feedback',{hasText:'同名文件或文件夹已存在'}).waitFor();
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,0);
  await page.locator('.ufs-create-input').fill('bad"name');
  await page.locator('.ufs-create-submit').click();
  await page.locator('.ufs-create-feedback',{hasText:'新建文件夹名称或父目录不安全'}).waitFor();
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,0);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.1 全局任务占用时拒绝创建', async t=>{
  const {page,errors,nativePosts}=await pageFor(t,{nativeBusy:true});
  await newFolderDialog(page);
  await page.locator('.ufs-create-input').fill('blocked');
  await page.locator('.ufs-create-submit').click();
  await page.locator('.ufs-create-feedback',{hasText:'正在执行其他原生文件任务'}).waitFor();
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,0);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.1 请求接受但文件夹未出现时不误报成功或重复提交', async t=>{
  const {page,errors,nativePosts}=await pageFor(t,{dropCreate:true});
  await newFolderDialog(page);
  await page.locator('.ufs-create-input').fill('not-created');
  await page.locator('.ufs-create-submit').click();
  await page.locator('.ufs-create-feedback',{hasText:'结果不确定'}).waitFor();
  assert.equal(await page.locator('.ufs-create-submit').isDisabled(),true);
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,1);
  assert.equal(errors.length,0,errors.join('\n'));
});


test('v0.2.1.1 弹窗布局有独立标题、只读路径、表单与底部按钮区', async t=>{
  const {page,errors,nativePosts}=await pageFor(t);
  await newFolderDialog(page);
  const ui=await page.locator('.ufs-create-dialog').evaluate(dialog=>{
    const box=el=>{const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height};};
    const header=dialog.querySelector('.ufs-create-head');
    const fields=dialog.querySelector('.ufs-create-fields');
    const footer=dialog.querySelector('.ufs-create-buttons');
    const location=dialog.querySelector('.ufs-create-location');
    const input=dialog.querySelector('.ufs-create-input');
    const cancel=dialog.querySelector('.ufs-create-cancel');
    const create=dialog.querySelector('.ufs-create-submit');
    return {
      dialog:box(dialog),header:box(header),fields:box(fields),footer:box(footer),
      locationBackground:getComputedStyle(location).backgroundColor,
      dialogBackground:getComputedStyle(dialog).backgroundColor,
      inputHeight:box(input).height,selected:[input.selectionStart,input.selectionEnd,input.value.length],
      cancel:box(cancel),create:box(create),
      headerBorder:getComputedStyle(header).borderBottomWidth,
      footerBorder:getComputedStyle(footer).borderTopWidth
    };
  });
  assert.ok(ui.dialog.width>=390 && ui.dialog.width<=445,JSON.stringify(ui));
  assert.ok(ui.dialog.height<390,JSON.stringify(ui));
  assert.ok(ui.header.bottom<=ui.fields.top+1 && ui.fields.bottom<=ui.footer.top+1,JSON.stringify(ui));
  assert.notEqual(ui.locationBackground,ui.dialogBackground);
  assert.equal(ui.headerBorder,'1px');
  assert.equal(ui.footerBorder,'1px');
  assert.equal(ui.inputHeight,36);
  assert.deepEqual(ui.selected,[0,5,5]);
  assert.ok(ui.cancel.left<ui.create.left);
  assert.equal(ui.cancel.height,ui.create.height);
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,0);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.1.1 弹窗在窄窗口不横向溢出，取消不会执行写入', async t=>{
  const {page,errors,nativePosts}=await pageFor(t);
  await newFolderDialog(page);
  await page.setViewportSize({width:420,height:620});
  const ui=await page.locator('.ufs-create-dialog').evaluate(dialog=>{
    const box=dialog.getBoundingClientRect();
    const footer=dialog.querySelector('.ufs-create-buttons').getBoundingClientRect();
    return {left:box.left,right:box.right,width:box.width,scrollWidth:dialog.scrollWidth,
      clientWidth:dialog.clientWidth,footerRight:footer.right};
  });
  assert.ok(ui.left>=0 && ui.right<=420,JSON.stringify(ui));
  assert.ok(ui.scrollWidth<=ui.clientWidth+1,JSON.stringify(ui));
  assert.ok(ui.footerRight<=ui.right+1);
  await page.locator('.ufs-create-cancel').click();
  assert.equal(await page.locator('.ufs-create-dialog').count(),0);
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,0);
  assert.equal(errors.length,0,errors.join('\n'));
});


test('v0.2.2 F2 重命名文件只选主文件名，成功后刷新且仅调用 action=7',async t=>{
  const {page,errors,nativePosts,renamed}=await pageFor(t);
  await page.locator('.ufs-entry').filter({hasText:'notes.txt'}).first().click();
  await page.keyboard.press('F2');
  await page.locator('.ufs-rename-dialog').waitFor();
  assert.deepEqual(await page.locator('.ufs-rename-input').evaluate(el=>
    [el.selectionStart,el.selectionEnd,el.value]),[0,5,'notes.txt']);
  await page.locator('.ufs-rename-input').fill('memo.txt');
  await page.locator('.ufs-rename-submit').click();
  await page.locator('.ufs-entry').filter({hasText:'memo.txt'}).first().waitFor();
  assert.equal(await page.locator('.ufs-entry').filter({hasText:'notes.txt'}).count(),0);
  assert.equal(renamed.length,1);
  const writes=nativePosts.filter(x=>x.mode==='file');
  assert.equal(writes.length,1);
  assert.equal(writes[0].action,'7');
  assert.equal(decodeURIComponent(writes[0].source),'/mnt/user/TimeMachine/notes.txt');
  assert.equal(decodeURIComponent(writes[0].target),'memo.txt');
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.2 文件夹重命名保持嵌套标签路径和子目录可用，旧浏览器历史自动重定向',async t=>{
  const {page,errors,nativePosts}=await pageFor(t);
  await page.locator('.ufs-entry').filter({hasText:'backup'}).first().dblclick();
  await page.locator('.ufs-entry').filter({hasText:'snapshot.zip'}).first().waitFor();
  await page.locator('.ufs-tabs > .ufs-ico[aria-label="新建标签页"]').click();
  await page.locator('.ufs-entry').filter({hasText:'backup'}).first().click({button:'right'});
  await page.getByRole('menuitem',{name:'重命名'}).click();
  await page.locator('.ufs-rename-input').fill('Archived');
  await page.locator('.ufs-rename-submit').click();
  await page.locator('.ufs-entry').filter({hasText:'Archived'}).first().waitFor();
  assert.equal(await page.locator('.ufs-entry').filter({hasText:'backup'}).count(),0);
  const tabs=await page.locator('.ufs-tab').evaluateAll(nodes=>nodes.map(n=>n.title));
  assert.ok(tabs.includes('/mnt/user/TimeMachine/Archived'),JSON.stringify(tabs));
  await page.locator('.ufs-tab').filter({hasText:'Archived'}).first().click();
  await page.locator('.ufs-entry').filter({hasText:'snapshot.zip'}).first().waitFor();
  assert.equal(new URL(page.url()).searchParams.get('dir'),'/mnt/user/TimeMachine/Archived');
  await page.evaluate(()=>{
    const path='/mnt/user/TimeMachine/backup';
    const state={ufs:true,tabId:1,path};
    const url=new URL(location.href); url.searchParams.set('dir',path);
    history.replaceState(state,'',url);
    window.dispatchEvent(new PopStateEvent('popstate',{state}));
  });
  await page.waitForFunction(()=>new URL(location.href).searchParams.get('dir')==='/mnt/user/TimeMachine/Archived');
  assert.equal(nativePosts.filter(x=>x.mode==='file'&&x.action==='2').length,1);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.2 重名预检查阻止文件夹覆盖且多选不提供重命名',async t=>{
  const {page,errors,nativePosts}=await pageFor(t);
  await page.locator('.ufs-entry').filter({hasText:'backup'}).first().click();
  await page.keyboard.press('F2');
  await page.locator('.ufs-rename-input').fill('Photos');
  await page.locator('.ufs-rename-submit').click();
  await page.locator('.ufs-rename-feedback',{hasText:'目标名称已存在'}).waitFor();
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,0);
  await page.locator('.ufs-rename-cancel').click();
  await page.locator('.ufs-entry').filter({hasText:'backup'}).first().click();
  await page.locator('.ufs-entry').filter({hasText:'notes.txt'}).first().click({modifiers:['Control']});
  await page.locator('.ufs-operations').click();
  assert.equal(await page.getByRole('menuitem',{name:'重命名'}).count(),0);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.2 请求已接受但目标没出现时不误报成功、不自动重试',async t=>{
  const {page,errors,nativePosts}=await pageFor(t,{dropRename:true});
  await page.locator('.ufs-entry').filter({hasText:'notes.txt'}).first().click();
  await page.keyboard.press('F2');
  await page.locator('.ufs-rename-input').fill('unverified.txt');
  await page.locator('.ufs-rename-submit').click();
  await page.locator('.ufs-rename-feedback',{hasText:'结果不确定'}).waitFor();
  assert.equal(await page.locator('.ufs-rename-submit').isDisabled(),true);
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,1);
  assert.equal(errors.length,0,errors.join('\n'));
});


test('v0.2.2.1 增强模式暂停原生 filemonitor 延迟启动，外部变更只局部刷新',async t=>{
  const {page,errors,browseRequests}=await pageFor(t,{simulateNativeMonitor:true});
  await page.locator('.ufs-entry').first().waitFor();
  let loads=0;
  const initialTimeOrigin=await page.evaluate(()=>performance.timeOrigin);
  page.on('request',request=>{
    if(request.isNavigationRequest() && request.frame()===page.mainFrame()) loads++;
  });
  // Browse.page starts its native filemonitor three seconds after load.
  await page.waitForTimeout(3350);
  const states=await page.evaluate(()=>{
    const {subscribers}=window.__ufsMonitorTest;
    const native=window.filemonitor;
    return {
      nativeStartCalls:native.startCalls,
      nativeStopCalls:native.stopCalls,
      nativeActive:native.active,
      ownedActive:subscribers.filter(s=>s!==native && s.url==='/sub/filemonitor' && s.active).length
    };
  });
  assert.equal(states.nativeStartCalls,0,JSON.stringify(states));
  assert.ok(states.nativeStopCalls>=1,JSON.stringify(states));
  assert.equal(states.nativeActive,false);
  assert.equal(states.ownedActive,1);
  const before=browseRequests.length;
  await page.evaluate(()=>{
    window.__ufsMonitorTest.emit('1');
    window.__ufsMonitorTest.emit('0');
  });
  await page.waitForFunction(()=>document.querySelector('.ufs-count')?.textContent?.includes('个项目'));
  await page.waitForTimeout(1900);
  assert.ok(browseRequests.length>before,'外部操作后应局部刷新目录');
  assert.equal(loads,0,'增强模式禁止原生 filemonitor 触发整页导航');
  assert.equal(await page.evaluate(()=>performance.timeOrigin),initialTimeOrigin);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.2.1 自身重命名与新建操作的 filemonitor 通知不会整页刷新',async t=>{
  const {page,errors,nativePosts,browseRequests}=await pageFor(t,{simulateNativeMonitor:true});
  let loads=0;
  const initialTimeOrigin=await page.evaluate(()=>performance.timeOrigin);
  page.on('request',request=>{
    if(request.isNavigationRequest() && request.frame()===page.mainFrame()) loads++;
  });
  await page.locator('.ufs-entry').filter({hasText:'notes.txt'}).first().click();
  await page.keyboard.press('F2');
  await page.locator('.ufs-rename-input').fill('rename-no-reload.txt');
  await page.locator('.ufs-rename-submit').click();
  await page.evaluate(()=>window.__ufsMonitorTest.emit('1'));
  await page.locator('.ufs-entry').filter({hasText:'rename-no-reload.txt'}).first().waitFor();
  await page.evaluate(()=>window.__ufsMonitorTest.emit('0'));
  await page.locator('.ufs-create-trigger').click();
  await page.getByRole('menuitem',{name:'新建文件夹'}).click();
  await page.locator('.ufs-create-input').fill('create-no-reload');
  await page.locator('.ufs-create-submit').click();
  await page.evaluate(()=>window.__ufsMonitorTest.emit('1'));
  await page.locator('.ufs-entry').filter({hasText:'create-no-reload'}).first().waitFor();
  await page.evaluate(()=>window.__ufsMonitorTest.emit('0'));
  await page.waitForTimeout(2000);
  assert.equal(loads,0,'操作过程中不应整页重载');
  assert.equal(await page.evaluate(()=>performance.timeOrigin),initialTimeOrigin);
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,2);
  assert.ok(browseRequests.length>=5);
  assert.equal(errors.length,0,errors.join('\n'));
});


test('v0.2.2.1 返回原生模式后不接管 filemonitor，原生延迟监听正常启动',async t=>{
  const {page,errors}=await pageFor(t,{simulateNativeMonitor:true,nativeMode:true});
  await page.locator('#ufs-native-enable').waitFor();
  assert.equal(await page.locator('#ufs-app').count(),0);
  await page.waitForTimeout(3250);
  const native=await page.evaluate(()=>{
    const obj=window.filemonitor;
    return {startCalls:obj.startCalls,stopCalls:obj.stopCalls,active:obj.active,
      extra:window.__ufsMonitorTest.subscribers.length};
  });
  assert.ok(native.startCalls>=1,JSON.stringify(native));
  assert.equal(native.stopCalls,0);
  assert.equal(native.active,true);
  assert.equal(native.extra,1);
  assert.equal(errors.length,0,errors.join('\n'));
});


async function openCopyDialog(page, name) {
  await page.locator('.ufs-entry').filter({hasText:name}).first().click({button:'right'});
  await page.getByRole('menuitem',{name:'复制到…'}).click();
  await page.locator('.ufs-copy-dialog').waitFor();
  await page.getByRole('button',{name:'选择 downloads'}).waitFor();
}

test('v0.2.3 单文件复制到另一个 Share，不覆盖且不删除原文件',async t=>{
  const {page,errors,nativePosts,copied}=await pageFor(t);
  await openCopyDialog(page,'notes.txt');
  assert.equal(await page.locator('.ufs-copy-submit').isDisabled(),true);
  await page.getByRole('button',{name:'选择 downloads'}).click();
  assert.equal(await page.locator('.ufs-copy-destination').innerText(),'目标：/mnt/user/downloads');
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-copy-dialog').waitFor({state:'detached'});
  assert.equal(copied.length,1);
  assert.equal(copied[0].source,'/mnt/user/TimeMachine/notes.txt');
  assert.equal(copied[0].target,'/mnt/user/downloads/notes.txt');
  const writes=nativePosts.filter(x=>x.mode==='file');
  assert.equal(writes.length,1);
  assert.equal(writes[0].action,'8');
  assert.equal(writes[0].csrf,'test-csrf');
  assert.equal(decodeURIComponent(writes[0].source),'/mnt/user/TimeMachine/notes.txt');
  assert.equal(decodeURIComponent(writes[0].target),'/mnt/user/downloads/');
  assert.equal(await page.locator('.ufs-entry').filter({hasText:'notes.txt'}).count(),1);
  await page.locator('.ufs-tree-row').filter({hasText:'downloads'}).first().click();
  await page.locator('.ufs-entry').filter({hasText:'notes.txt'}).first().waitFor();
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.3 复制文件夹到子目录，保留文件夹名和源文件',async t=>{
  const {page,errors,nativePosts}=await pageFor(t);
  await openCopyDialog(page,'Photos');
  await page.getByRole('button',{name:'展开 downloads'}).click();
  await page.getByRole('button',{name:'选择 completed'}).waitFor();
  await page.getByRole('button',{name:'选择 completed'}).click();
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-copy-dialog').waitFor({state:'detached'});
  assert.equal(nativePosts.filter(x=>x.action==='3').length,1);
  await page.locator('.ufs-tree-row').filter({hasText:'downloads'}).first().click();
  await page.locator('.ufs-entry').filter({hasText:'completed'}).first().dblclick();
  await page.locator('.ufs-entry').filter({hasText:'Photos'}).first().dblclick();
  await page.locator('.ufs-entry').filter({hasText:'sunset.jpg'}).first().waitFor();
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.3 源父目录与源子目录不可作为目标，多选不出现复制入口',async t=>{
  const {page,errors,nativePosts}=await pageFor(t);
  await openCopyDialog(page,'Photos');
  await page.getByRole('button',{name:'展开 TimeMachine'}).click();
  const parent=page.getByRole('button',{name:'选择 TimeMachine'});
  await parent.waitFor();
  assert.equal(await parent.isDisabled(),true);
  await page.getByRole('button',{name:'展开 Photos'}).waitFor();
  const self=page.getByRole('button',{name:'选择 Photos'});
  assert.equal(await self.isDisabled(),true);
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,0);
  await page.locator('.ufs-copy-cancel').click();
  await page.locator('.ufs-entry').filter({hasText:'backup'}).first().click();
  await page.locator('.ufs-entry').filter({hasText:'notes.txt'}).first().click({modifiers:['Control']});
  await page.locator('.ufs-operations').click();
  assert.equal(await page.getByRole('menuitem',{name:'复制到…'}).count(),0);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.3 同名目标阻止原生写入，结果不确定时锁住提交',async t=>{
  const {page,errors,nativePosts}=await pageFor(t,{copyConflictDest:'/mnt/user/downloads'});
  await openCopyDialog(page,'notes.txt');
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-copy-feedback',{hasText:'已有同名项目'}).waitFor();
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,0);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.3 已提交但复制结果无法确认时不误报成功也不重复提交',async t=>{
  const {page,errors,nativePosts}=await pageFor(t,{dropCopy:true});
  await openCopyDialog(page,'notes.txt');
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-copy-feedback',{hasText:'结果不确定'}).waitFor();
  assert.equal(await page.locator('.ufs-copy-submit').isDisabled(),true);
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,1);
  assert.equal(errors.length,0,errors.join('\n'));
});


test('v0.2.3.1 复制目录树在 Unraid 原生按钮规则下仍保持 32px 行高和紧凑箭头间距',async t=>{
  const {page,errors,nativePosts}=await pageFor(t);
  await openCopyDialog(page,'Photos');
  // Simulate Unraid 7.2.2 default-base.css as a late-loaded stylesheet.
  // Native button min-width/margins must not stretch picker rows.
  await page.addStyleTag({content:
    'button,button[type="button"]{min-width:86px;margin:10px 12px 10px 0;padding:8px;letter-spacing:1.8px;text-transform:uppercase}'
  });
  const measure=async(name)=>page.getByRole('button',{name:'选择 '+name})
    .evaluate(choose=>{
      const row=choose.closest('.ufs-copy-tree-row');
      const expand=row.querySelector('.ufs-copy-expand');
      const icon=choose.querySelector('.ufs-folder-icon');
      const label=choose.querySelector('span');
      const b=node=>{const r=node.getBoundingClientRect();return {
        left:r.left,right:r.right,top:r.top,height:r.height,width:r.width
      }};
      return {row:b(row),expand:b(expand),choose:b(choose),icon:b(icon),label:b(label),
        expandMargin:getComputedStyle(expand).margin,
        chooseMargin:getComputedStyle(choose).margin,
        expandMinWidth:getComputedStyle(expand).minWidth,
        chooseMinWidth:getComputedStyle(choose).minWidth};
    });
  for(const name of ['TimeMachine','appdata','docker','downloads']){
    const m=await measure(name);
    assert.ok(Math.abs(m.row.height-32)<=1,JSON.stringify({name,...m}));
    assert.ok(Math.abs(m.expand.width-24)<=1,JSON.stringify({name,...m}));
    assert.equal(m.expandMinWidth,'24px');
    assert.equal(m.chooseMinWidth,'0px');
    assert.equal(m.expandMargin,'0px');
    assert.equal(m.chooseMargin,'0px');
    assert.ok(m.choose.left-m.expand.right<=1,JSON.stringify({name,...m}));
    assert.ok(m.icon.left-m.expand.right>=4 && m.icon.left-m.expand.right<=12,
      JSON.stringify({name,...m}));
    assert.ok(m.label.left-m.icon.right<=9,JSON.stringify({name,...m}));
  }
  await page.getByRole('button',{name:'展开 downloads'}).click();
  await page.getByRole('button',{name:'选择 completed'}).waitFor();
  const nested=await measure('completed');
  assert.ok(Math.abs(nested.row.height-32)<=1,JSON.stringify(nested));
  assert.ok(nested.icon.left-nested.expand.right>=4 &&
    nested.icon.left-nested.expand.right<=12,JSON.stringify(nested));
  // Selection still works after resetting native button dimensions.
  await page.getByRole('button',{name:'选择 completed'}).click();
  assert.equal(await page.locator('.ufs-copy-destination').innerText(),
    '目标：/mnt/user/downloads/completed');
  assert.equal(await page.locator('.ufs-copy-submit').isEnabled(),true);
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,0);
  assert.equal(errors.length,0,errors.join('\n'));
});
