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
      // Browse.php escapes double quotes but leaves '&' in data="" raw.
      '<i id="row_'+index+'" data="'+full.replace(/"/g,'&#34;')+'" type="'+(folder?'d':'f')+'"></i>',
      '-', esc(name),'nobody','drwxrwxrwx','0','0',
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
  const context = await browser.newContext({viewport: {width: options.width || 1440, height: options.height || 900}});
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
          emitFileManager(data) {
            subscribers.filter(s=>s.url==='/sub/filemanager' && s.active)
              .forEach(s=>s.handlers.forEach(fn=>fn(JSON.stringify(data))));
          },
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
  const createdAnywhere = [];
  const renamed = [];
  const copied = [];
  const browseRequests = [];
  let copyActiveReads = 0;
  let latestCopy = null;
  let copyStopped = false;
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
    const originalRows=[...(contents[sourcePath] || []),
      ...(options.extraEntries?.[sourcePath] || [])];
    const mappedRows=originalRows.map(([name,folder])=>{
      const oldEntry=oldPath+'/'+name;
      const changed=renamed.find(item=>item.source===oldEntry);
      return [changed ? changed.target.split('/').pop() : name,folder];
    });
    const copyRows=copied.filter(item=>item.destinationDir===path)
      .map(item=>[item.name,item.folder]);
    const conflictRows=options.copyConflictDest===path ? [['notes.txt',false]] : [];
    const createdOtherRows=createdAnywhere.filter(item=>item.parent===path).map(item=>[item.name,true]);
    const response=options.bulkCount && path==='/mnt/user/TimeMachine' ?
      bulkRows(path,options.bulkCount) : responseFor(path,
        [...(path==='/mnt/user/TimeMachine' ? created.map(name=>[name,true]) : []),
         ...copyRows,...conflictRows,...createdOtherRows], mappedRows);
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
        latestCopy && (options.longCopy ? !copyStopped : ++copyActiveReads===1) ? JSON.stringify({
          action:latestCopy.folder?'3':'8',source:latestCopy.source,
          target:latestCopy.destinationDir+'/'}) : '';
      await route.fulfill({status:200,body:busy});
      return;
    }
    if (mode==='file' && body.get('action')==='0') {
      const parent=decodeURIComponent(body.get('source') || '');
      const name=decodeURIComponent(body.get('target') || '');
      if (!options.dropCreate) {
        if(parent==='/mnt/user/TimeMachine') created.push(name);
        else createdAnywhere.push({parent,name});
      }
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
      copyStopped=false;
      copyActiveReads=0;
      if(!options.dropCopy) copied.push(latestCopy);
      await route.fulfill({status:200,body:''});
      return;
    }
    if(mode==='file' && body.get('action')==='99') {
      copyStopped=true;
      latestCopy=null;
      copied.length=0;
      await route.fulfill({status:200,body:''});
      return;
    }
    await route.fulfill({status:400,body:'Unexpected native operation'});
  });
  await page.goto(base + '/Shares/Browse?dir=%2Fmnt%2Fuser');
  return {page,errors,nativePosts,created,createdAnywhere,renamed,copied,browseRequests};
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
  await page.locator('.ufs-copy-progress-panel[data-phase="success"]').waitFor();
  assert.equal(await page.locator('.ufs-copy-dialog').count(),1);
  await page.locator('.ufs-copy-submit',{hasText:'完成'}).click();
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
  await page.locator('.ufs-copy-progress-panel[data-phase="success"]').waitFor();
  assert.equal(await page.locator('.ufs-copy-dialog').count(),1);
  await page.locator('.ufs-copy-submit',{hasText:'完成'}).click();
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
  assert.equal(await page.locator('.ufs-copy-picker').isVisible(),true);
  assert.equal(await page.locator('.ufs-copy-progress-panel').count(),0);
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,0);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.3 已提交但复制结果无法确认时不误报成功也不重复提交',async t=>{
  const {page,errors,nativePosts}=await pageFor(t,{dropCopy:true});
  await openCopyDialog(page,'notes.txt');
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-copy-progress-panel[data-phase="uncertain"] .ufs-copy-progress-note',{hasText:'结果不确定'}).waitFor();
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


test('v0.2.3.2 复制时从目录选择器切到流动进度与真实任务阶段，无虚构百分比',async t=>{
  const {page,errors,nativePosts}=await pageFor(t);
  await openCopyDialog(page,'notes.txt');
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit').click();
  const panel=page.locator('.ufs-copy-progress-panel');
  await panel.waitFor();
  assert.equal(await page.locator('.ufs-copy-picker').count(),0);
  assert.equal(await page.locator('.ufs-copy-progress-target-text').innerText(),'/mnt/user/downloads');
  assert.equal(await page.locator('.ufs-copy-cancel').isEnabled(),true);
  assert.equal(await page.locator('.ufs-copy-submit').isDisabled(),true);
  const progressBar=panel.getByRole('progressbar');
  assert.equal(await progressBar.getAttribute('aria-valuenow'),null);
  assert.match(await progressBar.getAttribute('aria-label'),/进度未知/);
  assert.equal(await page.locator('.ufs-copy-progress-stages .ufs-copy-progress-stage').count(),3);
  await page.locator('.ufs-copy-progress-panel[data-phase="copying"]').waitFor();
  assert.equal(await page.locator('.ufs-copy-progress-indicator').innerText(),'进行中');
  assert.equal(await panel.evaluate(el=>getComputedStyle(el.querySelector('.ufs-copy-progress-fill')).animationName),'ufs-copy-flow');
  await page.locator('.ufs-copy-progress-panel[data-phase="success"]').waitFor();
  assert.equal(await page.locator('.ufs-copy-progress-indicator').innerText(),'已完成');
  assert.equal(await panel.locator('.ufs-copy-progress-stage[data-status="done"]').count(),3);
  const fill=panel.locator('.ufs-copy-progress-fill');
  assert.equal(await fill.evaluate(el=>getComputedStyle(el).animationName),'none');
  assert.equal(await fill.evaluate(el=>getComputedStyle(el).width),await fill.evaluate(el=>getComputedStyle(el.parentElement).width));
  await page.locator('.ufs-copy-progress-panel[data-phase="success"]').waitFor();
  assert.equal(await page.locator('.ufs-copy-dialog').count(),1);
  await page.locator('.ufs-copy-submit',{hasText:'完成'}).click();
  await page.locator('.ufs-copy-dialog').waitFor({state:'detached'});
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,1);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.3.2 原生复制结果不确定时停止动画，保持关闭入口且禁止重试',async t=>{
  const {page,errors,nativePosts}=await pageFor(t,{dropCopy:true});
  await openCopyDialog(page,'notes.txt');
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit').click();
  const panel=page.locator('.ufs-copy-progress-panel[data-phase="uncertain"]');
  await panel.waitFor();
  assert.match(await page.locator('.ufs-copy-progress-note').innerText(),/结果不确定/);
  assert.equal(await page.locator('.ufs-copy-submit').isDisabled(),true);
  assert.equal(await panel.locator('.ufs-copy-progress-fill').evaluate(el=>getComputedStyle(el).animationName),'none');
  assert.equal(await page.locator('.ufs-copy-cancel').isEnabled(),true);
  await page.locator('.ufs-copy-cancel').click();
  assert.equal(await page.locator('.ufs-copy-dialog').count(),0);
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,1);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.3.2 减少动态效果时停止旋转与流动，但仍显示复制进行中',async t=>{
  const {page,errors}=await pageFor(t);
  await page.emulateMedia({reducedMotion:'reduce'});
  await openCopyDialog(page,'notes.txt');
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit').click();
  const panel=page.locator('.ufs-copy-progress-panel');
  await panel.waitFor();
  const animations=await panel.evaluate(el=>[
    getComputedStyle(el.querySelector('.ufs-copy-progress-spinner')).animationName,
    getComputedStyle(el.querySelector('.ufs-copy-progress-fill')).animationName
  ]);
  assert.deepEqual(animations,['none','none']);
  assert.match(await panel.getByRole('progressbar').getAttribute('aria-label'),/进度未知/);
  assert.equal(errors.length,0,errors.join('\n'));
});


test('v0.2.3.3 真实进度显示 UTF-8 文件名、传输百分比、速度和 ETA',async t=>{
  const {page,errors}=await pageFor(t,{simulateNativeMonitor:true,longCopy:true});
  await openCopyDialog(page,'Photos');
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-copy-progress-panel[data-phase="copying"]').waitFor();
  await page.evaluate(()=>{
    window.__ufsMonitorTest.emitFileManager({
      status:'<i class="fa fa-spin"></i>Copying... mnt/user/downloads/\\#344\\#270\\#255\\#346\\#226\\#207.jpg\n  10,485,760  42%   5.10MB/s   0:00:06 (xfr#1, to-chk=3/5)'
    });
  });
  await page.locator('.ufs-copy-progress-indicator',{hasText:'42%'}).waitFor();
  assert.equal(await page.locator('.ufs-copy-progress-panel [role="progressbar"]').getAttribute('aria-valuenow'),'42');
  assert.match(await page.locator('.ufs-copy-current-file').innerText(),/中文\.jpg/);
  assert.match(await page.locator('.ufs-copy-progress-metrics').innerText(),/5\.10MB\/s/);
  assert.match(await page.locator('.ufs-copy-progress-metrics').innerText(),/0:00:06/);
  assert.doesNotMatch(await page.locator('.ufs-copy-current-file').innerText(),/\\#\d{3}/);
  await page.locator('.ufs-copy-background').click();
  assert.equal(await page.locator('.ufs-copy-dialog').count(),0);
  assert.equal(await page.locator('.ufs-copy-task-trigger').isVisible(),true);
  await page.locator('.ufs-copy-task-trigger').click();
  assert.equal(await page.locator('.ufs-copy-progress-indicator').innerText(),'42%');
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.3.3 完成后保留窗口，用户自行关闭且后台任务入口可重新打开',async t=>{
  const {page,errors,nativePosts}=await pageFor(t);
  await openCopyDialog(page,'notes.txt');
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-copy-progress-panel[data-phase="success"]').waitFor();
  await page.waitForTimeout(1100);
  assert.equal(await page.locator('.ufs-copy-dialog').count(),1);
  assert.equal(await page.locator('.ufs-copy-submit').innerText(),'完成');
  await page.locator('.ufs-create-dismiss').last().click();
  assert.equal(await page.locator('.ufs-copy-dialog').count(),0);
  assert.equal(await page.locator('.ufs-copy-task-trigger').isVisible(),false);
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,1);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.3.3 取消复制需二次确认，确认后仅发送一次 action 99 并提示残留文件',async t=>{
  const {page,errors,nativePosts}=await pageFor(t,{longCopy:true});
  await openCopyDialog(page,'notes.txt');
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-copy-progress-panel[data-phase="copying"]').waitFor();
  await page.waitForTimeout(1000);
  page.once('dialog',dialog=>dialog.accept());
  await page.locator('.ufs-copy-cancel').click();
  await page.locator('.ufs-copy-progress-panel[data-phase="uncertain"]').waitFor();
  await page.locator('.ufs-copy-progress-note',{hasText:/可能留有不完整文件|不完整文件/}).waitFor();
  assert.equal(nativePosts.filter(x=>x.action==='99').length,1);
  assert.equal(await page.locator('.ufs-copy-submit').isDisabled(),true);
  await page.locator('.ufs-copy-cancel').click();
  assert.equal(await page.locator('.ufs-copy-dialog').count(),0);
  assert.equal(errors.length,0,errors.join('\n'));
});


test('v0.2.3.4 rsync -h 单文件复制时真实百分比从 17% 更新到 34%',async t=>{
  const {page,errors,nativePosts}=await pageFor(t,{simulateNativeMonitor:true,longCopy:true});
  await openCopyDialog(page,'notes.txt');
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-copy-progress-panel[data-phase="copying"]').waitFor();
  await page.evaluate(()=>{
    window.__ufsMonitorTest.emitFileManager({
      status:'<i class="fa fa-circle-o-notch fa-spin dfm"></i>Copying... /mnt/user/TimeMachine/notes.txt\n'+
        '        557.06K  17%  500.49kB/s    0:00:05  '
    });
  });
  await page.locator('.ufs-copy-progress-indicator',{hasText:'17%'}).waitFor();
  assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'),'17');
  assert.match(await page.locator('.ufs-copy-progress-metrics').innerText(),/已传输 557\.06K/);
  await page.evaluate(()=>{
    window.__ufsMonitorTest.emitFileManager({
      status:'<i class="fa fa-circle-o-notch fa-spin dfm"></i>Copying... /mnt/user/TimeMachine/notes.txt\n'+
        '          1.08M  34%  500.24kB/s    0:00:04  '
    });
  });
  await page.locator('.ufs-copy-progress-indicator',{hasText:'34%'}).waitFor();
  assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'),'34');
  assert.match(await page.locator('.ufs-copy-progress-metrics').innerText(),/已传输 1\.08M/);
  assert.match(await page.locator('.ufs-copy-progress-metrics').innerText(),/500\.24kB\/s/);
  assert.match(await page.locator('.ufs-copy-progress-metrics').innerText(),/剩余 0:00:04/);
  const width=await page.locator('.ufs-copy-progress-fill').evaluate(el=>parseFloat(el.style.width));
  assert.equal(width,34);
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,1);
  assert.equal(errors.length,0,errors.join('\n'));
});


test('v0.2.3.5 真实百分比进度条为实心橙色，宽度平滑跟随数值',async t=>{
  const {page,errors,nativePosts}=await pageFor(t,{simulateNativeMonitor:true,longCopy:true});
  await openCopyDialog(page,'notes.txt');
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit').click();
  const panel=page.locator('.ufs-copy-progress-panel[data-phase="copying"]');
  await panel.waitFor();
  const fill=panel.locator('.ufs-copy-progress-fill');
  const geometry=async()=>panel.evaluate(el=>{
    const bar=el.querySelector('.ufs-copy-progress-track');
    const inner=el.querySelector('.ufs-copy-progress-fill');
    const style=getComputedStyle(inner);
    return {mode:el.dataset.progressMode,trackHeight:bar.getBoundingClientRect().height,
      percent:inner.getBoundingClientRect().width/bar.getBoundingClientRect().width*100,
      backgroundImage:style.backgroundImage,backgroundColor:style.backgroundColor,
      animation:style.animationName,transition:style.transitionDuration};
  });
  const before=await geometry();
  assert.equal(before.mode,'indeterminate');
  assert.match(before.backgroundImage,/linear-gradient/);
  assert.equal(before.animation,'ufs-copy-flow');
  assert.equal(before.trackHeight,8);

  await page.evaluate(()=>window.__ufsMonitorTest.emitFileManager({status:
    'Copying... /mnt/user/TimeMachine/notes.txt\n557.06K 17% 500.49kB/s 0:00:05'}));
  await page.locator('.ufs-copy-progress-indicator',{hasText:'17%'}).waitFor();
  await page.waitForTimeout(260);
  const first=await geometry();
  assert.equal(first.mode,'determinate');
  assert.equal(first.backgroundImage,'none');
  assert.equal(first.animation,'none');
  assert.equal(first.transition,'0.2s');
  assert.ok(Math.abs(first.percent-17)<1,JSON.stringify(first));

  await page.evaluate(()=>window.__ufsMonitorTest.emitFileManager({status:
    'Copying... /mnt/user/TimeMachine/notes.txt\n2.50G 73% 31.61MB/s 0:00:57'}));
  await page.locator('.ufs-copy-progress-indicator',{hasText:'73%'}).waitFor();
  await page.waitForTimeout(260);
  const second=await geometry();
  assert.ok(Math.abs(second.percent-73)<1,JSON.stringify(second));
  assert.equal(second.backgroundColor,first.backgroundColor);
  assert.equal(second.backgroundImage,'none');
  assert.equal(await panel.getByRole('progressbar').getAttribute('aria-valuenow'),'73');
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,1);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.3.5 核验完成后为纯绿色满格，减少动画时禁用宽度过渡',async t=>{
  const {page,errors}=await pageFor(t);
  await openCopyDialog(page,'notes.txt');
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit').click();
  const panel=page.locator('.ufs-copy-progress-panel[data-phase="success"]');
  await panel.waitFor();
  const done=await panel.evaluate(el=>{
    const outer=el.querySelector('.ufs-copy-progress-track');
    const inner=el.querySelector('.ufs-copy-progress-fill');
    const style=getComputedStyle(inner);
    return {phase:el.dataset.phase,image:style.backgroundImage,color:style.backgroundColor,
      ratio:inner.getBoundingClientRect().width/outer.getBoundingClientRect().width,
      animation:style.animationName};
  });
  assert.equal(done.phase,'success');
  assert.equal(done.image,'none');
  assert.equal(done.color,'rgb(52, 137, 94)');
  assert.equal(done.animation,'none');
  assert.ok(Math.abs(done.ratio-1)<0.01,JSON.stringify(done));
  await page.locator('.ufs-copy-submit',{hasText:'完成'}).click();
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.3.5 减少动态效果仍保留实心真实进度，但没有宽度过渡',async t=>{
  const {page,errors}=await pageFor(t,{simulateNativeMonitor:true,longCopy:true});
  await page.emulateMedia({reducedMotion:'reduce'});
  await openCopyDialog(page,'notes.txt');
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-copy-progress-panel[data-phase="copying"]').waitFor();
  await page.evaluate(()=>window.__ufsMonitorTest.emitFileManager({status:
    'Copying... /mnt/user/TimeMachine/notes.txt\n1.08M 34% 500.24kB/s 0:00:04'}));
  await page.locator('.ufs-copy-progress-indicator',{hasText:'34%'}).waitFor();
  const style=await page.locator('.ufs-copy-progress-fill').evaluate(el=>{
    const css=getComputedStyle(el);
    return {image:css.backgroundImage,animation:css.animationName,
      transition:css.transitionDuration,width:el.style.width};
  });
  assert.equal(style.image,'none');
  assert.equal(style.animation,'none');
  assert.equal(style.transition,'0s');
  assert.equal(style.width,'34%');
  assert.equal(errors.length,0,errors.join('\n'));
});


test('v0.2.3.6 点击目标文件夹同时选中并展开，重复选择不折叠，箭头仍可单独折叠',async t=>{
  const {page,errors,nativePosts,browseRequests}=await pageFor(t);
  await openCopyDialog(page,'notes.txt');
  const before=browseRequests.filter(path=>path==='/mnt/user/downloads').length;
  const selected=page.getByRole('button',{name:'选择 downloads'});
  await selected.click();
  assert.equal(await page.locator('.ufs-copy-destination').innerText(),'目标：/mnt/user/downloads');
  assert.equal(await page.locator('.ufs-copy-submit').isEnabled(),true);
  await page.getByRole('button',{name:'选择 completed'}).waitFor();
  await page.getByRole('button',{name:'折叠 downloads'}).waitFor();
  assert.equal(await selected.locator('..').getAttribute('aria-selected'),'true');
  const fetched=browseRequests.filter(path=>path==='/mnt/user/downloads').length;
  assert.equal(fetched-before,1,'首次选中仅按需读取一次目标子目录');

  await selected.click();
  assert.equal(await page.getByRole('button',{name:'选择 completed'}).count(),1);
  assert.equal(await page.getByRole('button',{name:'折叠 downloads'}).count(),1);
  assert.equal(browseRequests.filter(path=>path==='/mnt/user/downloads').length,fetched);

  await page.getByRole('button',{name:'折叠 downloads'}).click();
  assert.equal(await page.getByRole('button',{name:'选择 completed'}).count(),0);
  assert.equal(await page.locator('.ufs-copy-destination').innerText(),'目标：/mnt/user/downloads');
  assert.equal(await page.locator('.ufs-copy-submit').isEnabled(),true);

  await page.getByRole('button',{name:'展开 downloads'}).click();
  await page.getByRole('button',{name:'选择 completed'}).click();
  assert.equal(await page.locator('.ufs-copy-destination').innerText(), '目标：/mnt/user/downloads/completed');
  await page.getByRole('button',{name:'折叠 completed'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'选择 completed'}).locator('..').getAttribute('aria-selected'),'true');
  assert.equal(nativePosts.filter(entry=>entry.mode==='file').length,0,'展开/选中目录不得提交复制');
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.3.6 箭头展开不自动选中，无效目标仍不可选但可展开查看',async t=>{
  const {page,errors,nativePosts}=await pageFor(t);
  await openCopyDialog(page,'Photos');
  await page.getByRole('button',{name:'展开 downloads'}).click();
  await page.getByRole('button',{name:'选择 completed'}).waitFor();
  assert.equal(await page.locator('.ufs-copy-destination').innerText(),'请选择目标文件夹');
  assert.equal(await page.locator('.ufs-copy-submit').isDisabled(),true);
  await page.getByRole('button',{name:'展开 TimeMachine'}).click();
  assert.equal(await page.getByRole('button',{name:'选择 TimeMachine'}).isDisabled(),true);
  await page.getByRole('button',{name:'展开 Photos'}).click();
  assert.equal(await page.getByRole('button',{name:'选择 Photos'}).isDisabled(),true);
  assert.equal(await page.locator('.ufs-copy-submit').isDisabled(),true);
  assert.equal(nativePosts.filter(entry=>entry.mode==='file').length,0);
  assert.equal(errors.length,0,errors.join('\n'));
});


test('v0.2.3.7 行内创建子目录自动选中，不会开始复制，按钮紧邻文件夹名称',async t=>{
  const {page,errors,nativePosts,createdAnywhere}=await pageFor(t);
  await openCopyDialog(page,'notes.txt');
  const row=page.getByRole('button',{name:'选择 downloads'}).locator('..');
  await row.hover();
  const add=page.getByRole('button',{name:'在 downloads 下新建文件夹'});
  await add.waitFor({state:'visible'});
  const layout=await row.evaluate(el=>{
    const name=el.querySelector('.ufs-copy-choose').getBoundingClientRect();
    const plus=el.querySelector('.ufs-copy-mkdir-trigger').getBoundingClientRect();
    return {gap:plus.left-name.right,width:plus.width};
  });
  assert.ok(layout.gap>=0 && layout.gap<=4,JSON.stringify(layout));
  assert.ok(layout.width<=27,JSON.stringify(layout));
  await add.click();
  const input=page.getByRole('textbox',{name:'新文件夹名称'});
  await input.waitFor();
  assert.equal(await input.inputValue(),'新建文件夹');
  assert.deepEqual(await input.evaluate(el=>[el.selectionStart,el.selectionEnd]),[0,5]);
  assert.equal(await page.locator('.ufs-copy-submit').isDisabled(),true);
  await input.fill('电影备份');
  await input.press('Enter');
  await page.getByRole('button',{name:'选择 电影备份'}).waitFor();
  assert.equal(await page.locator('.ufs-copy-destination').innerText(),
    '目标：/mnt/user/downloads/电影备份');
  assert.equal(await page.locator('.ufs-copy-submit').isEnabled(),true);
  assert.equal(await page.getByRole('button',{name:'折叠 电影备份'}).count(),1);
  assert.deepEqual(createdAnywhere,[{parent:'/mnt/user/downloads',name:'电影备份'}]);
  const writes=nativePosts.filter(x=>x.mode==='file');
  assert.equal(writes.length,1);
  assert.equal(writes[0].action,'0');
  assert.equal(decodeURIComponent(writes[0].source),'/mnt/user/downloads');
  assert.equal(decodeURIComponent(writes[0].target),'电影备份');
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.3.7 源文件所在父目录虽然禁止直接复制，但可以在其下行内新建',async t=>{
  const {page,errors,nativePosts,created}=await pageFor(t);
  await openCopyDialog(page,'notes.txt');
  const parent=page.getByRole('button',{name:'选择 TimeMachine'});
  assert.equal(await parent.isDisabled(),true);
  await parent.locator('..').hover();
  await page.getByRole('button',{name:'在 TimeMachine 下新建文件夹'}).click();
  await page.getByRole('textbox',{name:'新文件夹名称'}).fill('备份用');
  await page.getByRole('button',{name:'确认新建文件夹'}).click();
  await page.getByRole('button',{name:'选择 备份用'}).waitFor();
  assert.equal(await page.locator('.ufs-copy-destination').innerText(),'目标：/mnt/user/TimeMachine/备份用');
  assert.deepEqual(created,['备份用']);
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,1);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.3.7 行内编辑可取消、同名失败保留输入，修正后再创建',async t=>{
  const {page,errors,nativePosts,createdAnywhere}=await pageFor(t);
  await openCopyDialog(page,'notes.txt');
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.getByRole('button',{name:'在 downloads 下新建文件夹'}).click();
  let input=page.getByRole('textbox',{name:'新文件夹名称'});
  await input.fill('临时');
  await input.press('Escape');
  assert.equal(await page.locator('.ufs-copy-inline-row').count(),0);
  assert.equal(await page.locator('.ufs-copy-submit').isEnabled(),true);
  await page.getByRole('button',{name:'在 downloads 下新建文件夹'}).click();
  input=page.getByRole('textbox',{name:'新文件夹名称'});
  await input.fill('completed');
  await page.getByRole('button',{name:'确认新建文件夹'}).click();
  await page.locator('.ufs-copy-inline-error',{hasText:'同名'}).waitFor();
  assert.equal(await input.inputValue(),'completed');
  assert.equal(await page.locator('.ufs-copy-submit').isDisabled(),true);
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,0);
  await input.fill('完成-新');
  await page.getByRole('button',{name:'确认新建文件夹'}).click();
  await page.getByRole('button',{name:'选择 完成-新'}).waitFor();
  assert.deepEqual(createdAnywhere,[{parent:'/mnt/user/downloads',name:'完成-新'}]);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.3.7 目录懒加载不会清空行内输入或抢走焦点',async t=>{
  const {page,errors}=await pageFor(t,{delayDownloads:300});
  await openCopyDialog(page,'notes.txt');
  await page.getByRole('button',{name:'选择 downloads'}).locator('..').hover();
  await page.getByRole('button',{name:'在 downloads 下新建文件夹'}).click();
  const input=page.getByRole('textbox',{name:'新文件夹名称'});
  await input.fill('中文目录输入中');
  await input.evaluate(el=>el.setSelectionRange(3,3));
  await page.waitForTimeout(450);
  assert.equal(await input.inputValue(),'中文目录输入中');
  assert.equal(await input.evaluate(el=>document.activeElement===el),true);
  assert.deepEqual(await input.evaluate(el=>[el.selectionStart,el.selectionEnd]),[3,3]);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.3.7 创建结果不确定时禁用重复创建和复制',async t=>{
  const {page,errors,nativePosts}=await pageFor(t,{dropCreate:true});
  await openCopyDialog(page,'notes.txt');
  await page.getByRole('button',{name:'选择 downloads'}).locator('..').hover();
  await page.getByRole('button',{name:'在 downloads 下新建文件夹'}).click();
  await page.getByRole('textbox',{name:'新文件夹名称'}).fill('不会出现');
  await page.getByRole('button',{name:'确认新建文件夹'}).click();
  await page.locator('.ufs-copy-inline-error',{hasText:'结果不确定'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'确认新建文件夹'}).isDisabled(),true);
  assert.equal(await page.locator('.ufs-copy-submit').isDisabled(),true);
  await page.getByRole('button',{name:'取消新建文件夹'}).click();
  await page.getByRole('button',{name:'选择 downloads'}).locator('..').hover();
  assert.equal(await page.getByRole('button',{name:'在 downloads 下新建文件夹'}).isDisabled(),true);
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,1);
  assert.equal(errors.length,0,errors.join('\n'));
});


test('v0.2.3.8 选中及悬停整行仅一层背景，文件夹加号为标准 Lucide SVG',async t=>{
  const {page,errors,nativePosts}=await pageFor(t);
  await openCopyDialog(page,'notes.txt');
  const choose=page.getByRole('button',{name:'选择 downloads'});
  await choose.click();
  await choose.hover();
  const row=choose.locator('..');
  const plus=page.getByRole('button',{name:'在 downloads 下新建文件夹'});
  await plus.waitFor({state:'visible'});
  const selected=await row.evaluate(el=>{
    const inner=el.querySelector('.ufs-copy-choose');
    const action=el.querySelector('.ufs-copy-mkdir-trigger');
    const svg=action.querySelector('svg');
    return {
      rowBackground:getComputedStyle(el).backgroundColor,
      innerBackground:getComputedStyle(inner).backgroundColor,
      paths:[...svg.querySelectorAll('path')].map(p=>p.getAttribute('d')),
      gap:action.getBoundingClientRect().left-inner.getBoundingClientRect().right,
      rowHeight:el.getBoundingClientRect().height
    };
  });
  assert.match(selected.rowBackground,/rgba\(235,\s*120,\s*37,\s*0\.11\)/);
  assert.equal(selected.innerBackground,'rgba(0, 0, 0, 0)');
  assert.equal(selected.rowHeight,32);
  assert.ok(selected.gap>=0 && selected.gap<=4,JSON.stringify(selected));
  assert.deepEqual(selected.paths,[
    'M12 10v6',
    'M9 13h6',
    'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'
  ]);
  await plus.hover();
  assert.equal(await plus.evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)');
  assert.equal(await row.evaluate(el=>getComputedStyle(el).backgroundColor),selected.rowBackground);
  await page.getByRole('button',{name:'选择 TimeMachine'}).locator('..').hover();
  const unselected=await page.getByRole('button',{name:'选择 TimeMachine'}).locator('..')
    .evaluate(el=>({row:getComputedStyle(el).backgroundColor,
      inner:getComputedStyle(el.querySelector('.ufs-copy-choose')).backgroundColor}));
  assert.equal(unselected.inner,'rgba(0, 0, 0, 0)');
  assert.notEqual(unselected.row,selected.rowBackground);
  assert.equal(nativePosts.filter(p=>p.mode==='file').length,0);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.3.9 主文件列表与复制目标子目录排序一致，行内创建刷新不回退乱序',async t=>{
  const {page,errors,nativePosts,createdAnywhere}=await pageFor(t);
  for(const name of ['folder10','新建文件夹33','folder2','aria2','folder1'])
    createdAnywhere.push({parent:'/mnt/user/downloads',name});
  await currentLabel(page).filter({hasText:'TimeMachine'}).waitFor();
  await page.locator('.ufs-tree-row')
    .filter({has:page.locator('.ufs-tree-name',{hasText:'downloads'})}).first().click();
  await currentLabel(page).filter({hasText:'downloads'}).waitFor();
  await page.locator('.ufs-filename',{hasText:'新建文件夹33'}).waitFor();
  const mainOrder=(await page.locator('.ufs-entry .ufs-filename').allInnerTexts())
    .filter(name=>name!=='large.zip'); // Copy picker lists folders, never files.
  assert.deepEqual(mainOrder,[...mainOrder].sort(new Intl.Collator('zh-CN',{numeric:true}).compare));

  await page.locator('.ufs-tree-row')
    .filter({has:page.locator('.ufs-tree-name',{hasText:'TimeMachine'})}).first().click();
  await openCopyDialog(page,'notes.txt');
  const choices=page.locator('.ufs-copy-tree-row .ufs-copy-choose > span');
  assert.deepEqual(await choices.allInnerTexts(),['TimeMachine','appdata','docker','downloads'],
    '复制目标的顶层 Share 保持接口原始顺序');
  await page.getByRole('button',{name:'展开 downloads'}).click();
  await page.getByRole('button',{name:'选择 新建文件夹33'}).waitFor();
  assert.deepEqual((await choices.allInnerTexts()).slice(4),mainOrder,
    '首次懒加载后与主文件列表顺序一致');

  await page.getByRole('button',{name:'选择 downloads'}).locator('..').hover();
  await page.getByRole('button',{name:'在 downloads 下新建文件夹'}).click();
  const input=page.getByRole('textbox',{name:'新文件夹名称'});
  await input.fill('folder3');
  // mkdir: one preflight Browse read, one verification read, one final picker refresh.
  const finalRefresh=new Promise(resolve=>{
    let reads=0;
    const onResponse=response=>{
      if(!response.url().includes('/webGui/include/Browse.php')) return;
      const dir=decodeURIComponent(new URL(response.url()).searchParams.get('dir')||'');
      if(dir==='/mnt/user/downloads' && ++reads===3) {
        page.off('response',onResponse);
        resolve();
      }
    };
    page.on('response',onResponse);
  });
  await input.press('Enter');
  await finalRefresh;
  const expected=[...mainOrder,'folder3'].sort(new Intl.Collator('zh-CN',{numeric:true}).compare);
  await page.waitForFunction(expectedNames=>{
    const all=Array.from(document.querySelectorAll(
      '.ufs-copy-tree-row .ufs-copy-choose > span'),el=>el.textContent);
    return JSON.stringify(all.slice(4))===JSON.stringify(expectedNames);
  },expected);
  assert.deepEqual((await choices.allInnerTexts()).slice(4),expected,
    '新建后的二次 Browse 刷新不可恢复原始服务器顺序');
  assert.equal(nativePosts.filter(post=>post.mode==='file').length,1,
    '排序不增加任何写入；仅允许用户主动执行的一次 mkdir');
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.3.10 普通 & 文件和含 & 的复制目标保留原路径', async t=>{
  const filename='[DHR&MakariHoshiyume&VCB-Studio] Episode 01.mkv';
  const {page,errors,nativePosts,copied}=await pageFor(t,{extraEntries:{
    '/mnt/user/TimeMachine':[[filename,false]],
    '/mnt/user/downloads':[['Media&Archive',true]]
  }});
  await openCopyDialog(page,filename);
  await page.getByRole('button',{name:'展开 downloads'}).click();
  const dest=page.getByRole('button',{name:'选择 Media&Archive'});
  await dest.waitFor();
  await dest.click();
  assert.equal(await page.locator('.ufs-copy-destination').innerText(),
    '目标：/mnt/user/downloads/Media&Archive');
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-copy-progress-panel[data-phase="success"]').waitFor();
  assert.equal(copied.length,1);
  assert.equal(copied[0].source,'/mnt/user/TimeMachine/'+filename);
  assert.equal(copied[0].destinationDir,'/mnt/user/downloads/Media&Archive');
  const writes=nativePosts.filter(post=>post.mode==='file');
  assert.equal(writes.length,1);
  assert.equal(decodeURIComponent(writes[0].source),'/mnt/user/TimeMachine/'+filename);
  assert.equal(decodeURIComponent(writes[0].target),'/mnt/user/downloads/Media&Archive/');
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.3.10 普通 & 文件夹能够执行文件夹复制',async t=>{
  const folder='Archive&Sources';
  const {page,errors,nativePosts,copied}=await pageFor(t,{extraEntries:{
    '/mnt/user/TimeMachine':[[folder,true]]
  }});
  await openCopyDialog(page,folder);
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-copy-progress-panel[data-phase="success"]').waitFor();
  assert.equal(copied.length,1);
  assert.equal(copied[0].source,'/mnt/user/TimeMachine/'+folder);
  assert.equal(copied[0].target,'/mnt/user/downloads/'+folder);
  assert.equal(nativePosts.filter(p=>p.mode==='file').length,1);
  assert.equal(nativePosts.filter(p=>p.action==='3').length,1);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.3.10 上级目录包含 & 时仍能复制其中的文件',async t=>{
  const parent='Parent&Directory', filename='Episode&Bonus.mkv';
  const {page,errors,nativePosts,copied}=await pageFor(t,{extraEntries:{
    '/mnt/user/TimeMachine':[[parent,true]],
    ['/mnt/user/TimeMachine/'+parent]:[[filename,false]]
  }});
  await page.locator('.ufs-entry').filter({hasText:parent}).first().dblclick();
  await page.locator('.ufs-entry').filter({hasText:filename}).first().waitFor();
  await openCopyDialog(page,filename);
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-copy-progress-panel[data-phase="success"]').waitFor();
  assert.equal(copied[0].source,'/mnt/user/TimeMachine/'+parent+'/'+filename);
  assert.equal(copied[0].target,'/mnt/user/downloads/'+filename);
  assert.equal(nativePosts.filter(p=>p.mode==='file').length,1);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.3.10 HTML 实体歧义及原有特殊字符显示禁用复制与原因',async t=>{
  const {page,errors,nativePosts}=await pageFor(t,{extraEntries:{
    '/mnt/user/TimeMachine':[['A&amp;B.mkv',false],['A&#38;B.zip',false],
      ['Unsafe%name.mkv',false]]
  }});
  for(const name of ['A&B.mkv','A&B.zip','Unsafe%name.mkv']) {
    await page.locator('.ufs-entry').filter({hasText:name}).first().click({button:'right'});
    const menu=page.getByRole('menuitem',{name:'复制到…'});
    await menu.waitFor({state:'visible'});
    assert.equal(await menu.isDisabled(),true,name);
    assert.match(await menu.getAttribute('title'),/无法安全处理|路径与文件名不一致/);
    assert.equal(await page.getByRole('menuitem',{name:'重命名'}).count(),0,
      '路径失真的项目不能允许重命名');
    // Dismiss the menu before the next right-click; it otherwise overlays rows.
    await page.locator('.ufs-section-label').click();
  }
  assert.equal(nativePosts.filter(p=>p.mode==='file').length,0);
  assert.equal(errors.length,0,errors.join('\n'));
});


test('v0.2.3.11 小窗口与超长文件名时，复制底部按钮始终可见，中间内容独立滚动',async t=>{
  const filename='[DHR&MakariHoshiyume&VCB-Studio] '+
    'Gekijouban DanMachi Orion no Ya '.repeat(4)+'[Ma10p_1080p].ass';
  const {page,errors,nativePosts}=await pageFor(t,{width:960,height:480,extraEntries:{
    '/mnt/user/TimeMachine':[[filename,false]]
  }});
  await openCopyDialog(page,filename);
  const readLayout=()=>page.locator('.ufs-copy-dialog').evaluate(dialog=>{
    const box=selector=> {
      const rect=dialog.querySelector(selector).getBoundingClientRect();
      return {top:rect.top,bottom:rect.bottom,height:rect.height};
    };
    const middle=dialog.querySelector('.ufs-create-fields');
    return {windowHeight:innerHeight,dialog:dialog.getBoundingClientRect().toJSON(),
      header:box('.ufs-create-head'),body:box('.ufs-create-fields'),
      footer:box('.ufs-create-buttons'),
      cancel:box('.ufs-copy-cancel'),submit:box('.ufs-copy-submit'),
      overflow:getComputedStyle(dialog).overflowY,
      middleOverflow:getComputedStyle(middle).overflowY,
      middleScrollHeight:middle.scrollHeight,middleClientHeight:middle.clientHeight,
      middleScrollTop:middle.scrollTop};
  });
  const initial=await readLayout();
  assert.ok(initial.dialog.top>=0 && initial.dialog.bottom<=initial.windowHeight,
    '复制弹窗应完整落在视口内：'+JSON.stringify(initial));
  assert.ok(initial.footer.top>=initial.header.bottom,
    '标题和底部按钮不能重叠：'+JSON.stringify(initial));
  assert.ok(initial.cancel.bottom<=initial.dialog.bottom &&
    initial.submit.bottom<=initial.dialog.bottom &&
    initial.submit.bottom<=initial.windowHeight,
    '两个按钮应在视口内完全显示：'+JSON.stringify(initial));
  assert.equal(initial.overflow,'hidden','外层复制弹窗不应整体滚动');
  assert.equal(initial.middleOverflow,'auto','只有复制内容区承担外层滚动');
  assert.ok(initial.middleScrollHeight>initial.middleClientHeight,
    '长内容必须在中间区域滚动：'+JSON.stringify(initial));
  await page.locator('.ufs-copy-dialog .ufs-create-fields')
    .evaluate(el=>{el.scrollTop=el.scrollHeight;});
  const after=await readLayout();
  assert.ok(after.middleScrollTop>0,'中间区域应可滚动');
  assert.ok(Math.abs(after.header.top-initial.header.top)<1);
  assert.ok(Math.abs(after.footer.top-initial.footer.top)<1,
    '滚动正文时底部按钮位置不能改变');
  await page.getByRole('button',{name:'选择 downloads'}).click();
  assert.equal(await page.locator('.ufs-copy-submit').isEnabled(),true);
  const selected=await readLayout();
  assert.ok(Math.abs(selected.footer.top-initial.footer.top)<1,
    '选择目录并展开后底部按钮仍保持位置');
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,0,
    '只选择目标不能自动复制');
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.3.11 复制进度与完成界面仍沿用固定底部，常规窗口不引入外层滚动',async t=>{
  const {page,errors}=await pageFor(t,{width:1100,height:520});
  await openCopyDialog(page,'notes.txt');
  await page.getByRole('button',{name:'选择 downloads'}).click();
  const inspect=()=>page.locator('.ufs-copy-dialog').evaluate(dialog=>{
    const footer=dialog.querySelector('.ufs-create-buttons').getBoundingClientRect();
    const body=dialog.querySelector('.ufs-create-fields');
    const root=dialog.getBoundingClientRect();
    return {footerTop:footer.top,footerBottom:footer.bottom,rootBottom:root.bottom,
      windowHeight:innerHeight,dialogOverflow:getComputedStyle(dialog).overflowY,
      bodyOverflow:getComputedStyle(body).overflowY};
  });
  const picker=await inspect();
  assert.equal(picker.dialogOverflow,'hidden');
  assert.equal(picker.bodyOverflow,'auto');
  assert.ok(picker.footerBottom<=picker.rootBottom && picker.footerBottom<=picker.windowHeight);
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-copy-progress-panel[data-phase="success"]').waitFor();
  const result=await inspect();
  assert.ok(result.footerBottom<=result.rootBottom && result.footerBottom<=result.windowHeight,
    '进度阶段切换后底部操作栏仍然完整可见');
  assert.equal(await page.locator('.ufs-copy-submit').innerText(),'完成');
  assert.equal(await page.locator('.ufs-copy-submit').isVisible(),true);
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-copy-dialog').waitFor({state:'detached'});
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.3.12 三种弹窗使用统一标题、底栏与滚动内容，长路径不遮挡按钮',async t=>{
  const {page,errors,nativePosts}=await pageFor(t,{width:960,height:480});
  const inspect=()=>page.locator('.ufs-create-dialog').evaluate(dialog=>{
    const rect=el=>{const r=el.getBoundingClientRect();
      return {top:r.top,bottom:r.bottom,height:r.height};};
    const header=dialog.querySelector('.ufs-create-head');
    const fields=dialog.querySelector('.ufs-create-fields');
    const footer=dialog.querySelector('.ufs-create-buttons');
    return {dialog:rect(dialog),header:rect(header),fields:rect(fields),
      footer:rect(footer),scrollHeight:fields.scrollHeight,
      clientHeight:fields.clientHeight,scrollTop:fields.scrollTop,
      outerOverflow:getComputedStyle(dialog).overflowY,
      bodyOverflow:getComputedStyle(fields).overflowY};
  });
  const verify=async(label)=>{
    const before=await inspect();
    assert.ok(Math.abs(before.header.height-52)<1,label+JSON.stringify(before));
    assert.ok(Math.abs(before.footer.height-64)<1,label+JSON.stringify(before));
    assert.ok(before.header.bottom<=before.fields.top+1,label+JSON.stringify(before));
    assert.ok(before.fields.bottom<=before.footer.top+1,label+JSON.stringify(before));
    assert.ok(before.footer.bottom<=before.dialog.bottom+1,label+JSON.stringify(before));
    assert.equal(before.outerOverflow,'hidden',label);
    assert.equal(before.bodyOverflow,'auto',label);
    assert.ok(before.scrollHeight>before.clientHeight,label+' 应让过长路径在正文滚动');
    await page.locator('.ufs-create-fields').evaluate(el=>{el.scrollTop=el.scrollHeight;});
    const after=await inspect();
    assert.ok(after.scrollTop>0,label);
    assert.ok(Math.abs(after.header.top-before.header.top)<1,label);
    assert.ok(Math.abs(after.footer.top-before.footer.top)<1,label);
  };
  await newFolderDialog(page);
  await page.locator('.ufs-create-location').evaluate(el=>{
    el.textContent='/mnt/user/'+('very-long-parent-folder-name-').repeat(32);
  });
  await verify('新建文件夹');
  await page.locator('.ufs-create-cancel').click();

  await page.locator('.ufs-entry').filter({hasText:'notes.txt'}).first().click();
  await page.keyboard.press('F2');
  await page.locator('.ufs-rename-dialog').waitFor();
  await page.locator('.ufs-rename-original').evaluate(el=>{
    el.textContent='[VeryLongName]'.repeat(64)+'.txt';
  });
  await verify('重命名');
  await page.locator('.ufs-rename-cancel').click();

  await openCopyDialog(page,'notes.txt');
  await page.locator('.ufs-copy-summary-info strong').evaluate(el=>{
    el.textContent='Long Filename '.repeat(36);
  });
  await verify('复制到');
  assert.equal(await page.locator('.ufs-copy-dialog .ufs-copy-submit').isVisible(),true);
  await page.locator('.ufs-copy-cancel').click();
  assert.equal(nativePosts.filter(post=>post.mode==='file').length,0);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.3.12 复制目录树与正文滚动条空闲隐藏，操作时仅显示当前区域',async t=>{
  const folders=Array.from({length:22},(_,i)=>['folder'+i,true]);
  const {page,errors}=await pageFor(t,{width:960,height:520,
    extraEntries:{'/mnt/user/downloads':folders}});
  await openCopyDialog(page,'notes.txt');
  await page.getByRole('button',{name:'展开 downloads'}).click();
  await page.getByRole('button',{name:'选择 folder21'}).waitFor();
  const body=page.locator('.ufs-copy-dialog .ufs-create-fields');
  const picker=page.locator('.ufs-copy-picker');
  const scrollColor=async el=>el.evaluate(e=>getComputedStyle(e).scrollbarColor);
  const transparent=color=>color==='transparent transparent' ||
    color==='rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)';
  await page.mouse.move(2,2);
  // Expanding the folder tree can itself scroll the parent body, temporarily
  // revealing its scrollbar. Wait for the intentional 1.1s idle period.
  await page.locator('.ufs-copy-dialog .ufs-create-fields.ufs-scroll-active')
    .waitFor({state:'detached'});
  await page.locator('.ufs-copy-picker.ufs-scroll-active').waitFor({state:'detached'});
  assert.ok(transparent(await scrollColor(body)),'外层空闲应透明: '+await scrollColor(body));
  assert.ok(transparent(await scrollColor(picker)),'目录树空闲应透明: '+await scrollColor(picker));
  await picker.hover();
  assert.ok(!transparent(await scrollColor(picker)),'目录树悬停显示滚动条');
  assert.ok(transparent(await scrollColor(body)),'目录树悬停不应同时显示外层滚动条');
  await picker.evaluate(el=>{el.scrollTop=el.scrollHeight;});
  await page.locator('.ufs-copy-picker.ufs-scroll-active').waitFor();
  assert.ok(!transparent(await scrollColor(picker)),'目录树滚动应显示滚动条');
  await page.mouse.move(2,2);
  await page.locator('.ufs-copy-picker.ufs-scroll-active').waitFor({state:'detached'});
  assert.ok(transparent(await scrollColor(picker)),'滚动结束且未悬停应自动隐藏');
  await page.locator('.ufs-copy-dialog .ufs-create-fields').evaluate(el=>{el.scrollTop=el.scrollHeight;});
  await page.locator('.ufs-copy-dialog .ufs-create-fields.ufs-scroll-active').waitFor();
  assert.ok(!transparent(await scrollColor(body)),'外层正文滚动时显示滚动条');
  await page.mouse.move(2,2);
  await page.locator('.ufs-copy-dialog .ufs-create-fields.ufs-scroll-active').waitFor({state:'detached'});
  assert.ok(transparent(await scrollColor(body)),'外层正文空闲再次隐藏');
  assert.equal(errors.length,0,errors.join('\n'));
});
