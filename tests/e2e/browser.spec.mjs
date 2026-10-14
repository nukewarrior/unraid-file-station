import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';

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
      '<td>'+name+'</td><td>'+name+'</td><td>nobody</td><td>-rw-rw-rw-</td>'+
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
  '<table class="indexer"><thead><tr><th>NAME</th></tr></thead>'+
  '<tbody><tr><td>原生文件管理器</td></tr></tbody></table></div>'+
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
  const moved = [];
  const deleted = [];
  let latestMutation = null;
  let mutationReads = 0;
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
    const mappedRows=originalRows.filter(([name])=>
      !deleted.some(item=>item.source===sourcePath+'/'+name) &&
      !moved.some(item=>item.source===sourcePath+'/'+name)).map(([name,folder])=>{
      const oldEntry=oldPath+'/'+name;
      const changed=renamed.find(item=>item.source===oldEntry);
      return [changed ? changed.target.split('/').pop() : name,folder];
    });
    const copyRows=copied.filter(item=>item.destinationDir===path)
      .map(item=>[item.name,item.folder]);
    const moveRows=moved.filter(item=>item.destinationDir===path)
      .map(item=>[item.name,item.folder]);
    const conflictRows=options.copyConflictDest===path ?
      (options.copyConflictNames||['notes.txt']).map(item=>Array.isArray(item)?item:[item,false]) : [];
    const createdOtherRows=createdAnywhere.filter(item=>item.parent===path).map(item=>[item.name,true]);
    const response=options.bulkCount && path==='/mnt/user/TimeMachine' ?
      bulkRows(path,options.bulkCount) : responseFor(path,
        [...(path==='/mnt/user/TimeMachine' ? created.map(name=>[name,true]) : []),
         ...copyRows,...moveRows,...conflictRows,...createdOtherRows], mappedRows);
    await route.fulfill({status:200,contentType:'text/html',body:response}).catch(()=>{});
  });
  await page.route('**/webGui/include/Control.php',async route=>{
    const body=new URLSearchParams(route.request().postData() || '');
    const mode=body.get('mode');
    nativePosts.push({mode,action:body.get('action'),source:body.get('source'),target:body.get('target'),csrf:body.get('csrf_token'),exist:body.get('exist')});
    if (body.get('csrf_token') !== 'test-csrf') {
      await route.fulfill({status:403,body:'CSRF rejected'});
      return;
    }
    if (mode==='read') {
      const busy=options.nativeBusy ?
        JSON.stringify({action:'6',source:'/mnt/user/TimeMachine/backup',target:''}) :
        latestMutation && ++mutationReads<=(options.nativeMutationHoldReads??1) ? JSON.stringify(latestMutation):
        latestCopy && (options.longCopy ? !copyStopped :
          ++copyActiveReads <= (options.firstCopyHoldReads && copied.length===1 ? options.firstCopyHoldReads : 1)) ? JSON.stringify({
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
    if(mode==='file' && ['4','9','1','6'].includes(body.get('action'))) {
      const action=body.get('action');
      const source=decodeURIComponent(body.get('source')||'');
      const destinationDir=decodeURIComponent(body.get('target')||'').replace(/\/$/,'');
      const folder=action==='4'||action==='1';
      if(action==='4'||action==='9') {
        // Browse.page separates multi-selection with a literal CR. These are
        // still ONE native action and ONE mode=read task ownership signature.
        for(const path of source.split('\r')) {
          if(options.partialNativeMove && path.split('/').pop()==='another.mkv')continue;
          const parent=path.slice(0,path.lastIndexOf('/'));
          const name=path.split('/').pop();
          const sourceFolder=([...(contents[parent]||[]),...(options.extraEntries?.[parent]||[])])
            .find(item=>item[0]===name)?.[1]??folder;
          moved.push({source:path,destinationDir,folder:sourceFolder,name});
        }
      } else deleted.push({source,folder});
      latestMutation={action,source,target:action==='4'||action==='9'?destinationDir+'/':''};
      mutationReads=0;
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
  return {page,errors,nativePosts,created,createdAnywhere,renamed,copied,moved,deleted,browseRequests};
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


test('v0.2.12.1 地址栏有空间时完整显示，窄屏动态折叠并保留省略号跳转', async t => {
  const {page,errors}=await pageFor(t,{width:1440});
  const path='/mnt/user/downloads/新建文件夹/新建文件夹/新建文件夹2';
  await page.goto(base+'/Shares/Browse?dir='+encodeURIComponent(path));
  await page.locator('.ufs-crumb:last-child',{hasText:'新建文件夹2'}).waitFor();
  await page.waitForFunction(()=>document.querySelectorAll('.ufs-address .ufs-crumb').length===5);
  assert.deepEqual(await page.locator('.ufs-address .ufs-crumb-label').allTextContents(),[
    '共享文件夹','downloads','新建文件夹','新建文件夹','新建文件夹2'
  ],'宽屏完整显示所有五层路径，不应因为超过四层提前折叠');
  assert.equal(await page.locator('.ufs-crumb-more').count(),0);
  await page.setViewportSize({width:760,height:900});
  await page.locator('.ufs-crumb-more').waitFor();
  assert.equal(await page.locator('.ufs-crumb-label').last().innerText(),'新建文件夹2');
  assert.equal(await page.locator('.ufs-crumb-label').first().innerText(),'共享文件夹');
  await page.locator('.ufs-crumb-more').click();
  const hidden=page.locator('.ufs-menu button');
  assert.ok(await hidden.count()>0,'折叠菜单包含隐藏目录');
  const target=await hidden.first().getAttribute('title');
  assert.ok(target?.startsWith('/mnt/user/downloads'),'隐藏目录保存真实路径');
  await hidden.first().click();
  await page.waitForFunction(target=>new URL(location.href).searchParams.get('dir')===target,target);
  await page.goto(base+'/Shares/Browse?dir='+encodeURIComponent(path));
  await page.locator('.ufs-crumb-more').waitFor();
  await page.setViewportSize({width:1440,height:900});
  await page.locator('.ufs-crumb-more').waitFor({state:'detached'});
  assert.equal(await page.locator('.ufs-address .ufs-crumb-label').count(),5,
    '扩大窗口后自动还原完整路径，不依赖再次导航');
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.12.1 侧边栏宽度变化重新测量地址栏，不改变布局和高度',async t=>{
  const {page,errors}=await pageFor(t,{width:980});
  const path='/mnt/user/downloads/新建文件夹/新建文件夹/新建文件夹2';
  await page.goto(base+'/Shares/Browse?dir='+encodeURIComponent(path));
  const app=page.locator('#ufs-app');
  await page.locator('.ufs-address').waitFor();
  await app.evaluate(el=>el.style.setProperty('--ufs-sidebar-width','170px'));
  await page.waitForFunction(()=>document.querySelector('.ufs-sidebar')?.getBoundingClientRect().width<180);
  await page.locator('.ufs-crumb-more').waitFor({state:'detached'});
  const initial=await page.locator('.ufs-address').evaluate(el=>el.getBoundingClientRect().width);
  await app.evaluate(el=>el.style.setProperty('--ufs-sidebar-width','420px'));
  await page.waitForFunction(initial=>
    document.querySelector('.ufs-address')?.getBoundingClientRect().width<initial-180,initial);
  await page.locator('.ufs-crumb-more').waitFor();
  assert.equal(await page.locator('.ufs-address').evaluate(el=>Math.round(el.getBoundingClientRect().height)),30);
  await app.evaluate(el=>el.style.setProperty('--ufs-sidebar-width','170px'));
  await page.locator('.ufs-crumb-more').waitFor({state:'detached'});
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
  await page.getByRole('button',{name:'新建文件夹',exact:true}).click();
  await page.locator('.ufs-create-dialog').waitFor();
}

test('v0.2.3.14 工具栏「新建文件夹」一次点击直接打开弹窗，不产生下拉菜单',async t=>{
  const {page,errors,nativePosts,created}=await pageFor(t);
  const trigger=page.locator('.ufs-create-trigger');
  await trigger.waitFor();
  assert.equal(await trigger.innerText(),'新建文件夹');
  assert.equal(await trigger.getAttribute('title'),'新建文件夹');
  assert.equal(await trigger.getAttribute('aria-label'),'新建文件夹');
  assert.equal(await trigger.getAttribute('aria-haspopup'),null,
    '单一动作按钮不再声明弹出菜单');
  assert.equal(await trigger.getAttribute('aria-expanded'),null);
  assert.equal(await trigger.locator('.ufs-svg').count(),0,
    '直接按钮没有原来的加号或下拉箭头');

  // An open action menu should be dismissed by the direct create action.
  await page.locator('.ufs-operations').click();
  await page.getByRole('menuitem',{name:'刷新当前目录'}).waitFor();
  await trigger.click();
  await page.locator('.ufs-create-dialog').waitFor();
  assert.equal(await page.getByRole('menuitem',{name:'新建文件夹'}).count(),0);
  assert.equal(await page.locator('.ufs-menu').count(),0);
  assert.equal(await page.locator('.ufs-create-dialog').count(),1);
  assert.equal(nativePosts.filter(post=>post.mode==='file').length,0,
    '仅打开新建弹窗不能写入 NAS');
  await page.locator('.ufs-create-cancel').click();

  // The button remains keyboard accessible, also without an intermediate menu.
  await trigger.focus();
  await page.keyboard.press('Enter');
  await page.locator('.ufs-create-dialog').waitFor();
  assert.equal(await page.locator('.ufs-menu').count(),0);
  await page.locator('.ufs-create-input').fill('直接创建测试');
  await page.locator('.ufs-create-submit').click();
  await page.locator('.ufs-entry').filter({hasText:'直接创建测试'}).first().waitFor();
  assert.deepEqual(created,['直接创建测试']);
  assert.equal(nativePosts.filter(post=>post.mode==='file').length,1);
  assert.equal(errors.length,0,errors.join('\n'));
});

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
  await page.getByRole('button',{name:'新建文件夹',exact:true}).click();
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


test('v0.2.6.4 初始原生模式保持增强实例并接管自动刷新，点击返回无需重新加载',async t=>{
  const {page,errors}=await pageFor(t,{simulateNativeMonitor:true,nativeMode:true});
  const initialOrigin=await page.evaluate(()=>performance.timeOrigin);
  let navigations=0;
  page.on('request',req=>{
    if(req.isNavigationRequest() && req.frame()===page.mainFrame()) navigations++;
  });
  await page.locator('#ufs-native-enable').waitFor();
  assert.equal(await page.locator('#ufs-app').count(),1);
  assert.equal(await page.locator('#ufs-app').isVisible(),false);
  assert.equal(await page.locator('table.indexer').isVisible(),true);
  await page.waitForTimeout(3250);
  const status=await page.evaluate(()=>{
    const {filemonitor,__ufsMonitorTest}=window;
    return {startCalls:filemonitor.startCalls,stopCalls:filemonitor.stopCalls,
      nativeActive:filemonitor.active,
      ownActive:__ufsMonitorTest.subscribers.filter(s=>s!==filemonitor &&
        s.url==='/sub/filemonitor' && s.active).length};
  });
  assert.equal(status.startCalls,0,JSON.stringify(status));
  assert.ok(status.stopCalls>=1,JSON.stringify(status));
  assert.equal(status.nativeActive,false);
  assert.equal(status.ownActive,1);
  await page.evaluate(()=>window.__ufsMonitorTest.emit('1'));
  await page.locator('#ufs-native-enable').click();
  await page.locator('#ufs-app').waitFor({state:'visible'});
  assert.equal(await page.locator('table.indexer').isVisible(),false);
  assert.equal(await page.evaluate(()=>performance.timeOrigin),initialOrigin);
  assert.equal(navigations,0);
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

test('v0.2.4 源父目录与源子目录不可作为目标，多选复制入口已开放',async t=>{
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
  const multiCopy=page.getByRole('menuitem',{name:'复制到…'});
  assert.equal(await multiCopy.count(),1);
  assert.equal(await multiCopy.isEnabled(),true);
  await multiCopy.click();
  await page.locator('.ufs-copy-dialog').waitFor();
  assert.match(await page.locator('.ufs-batch-summary-heading').innerText(),/已选择 2 项/);
  await page.locator('.ufs-copy-cancel').click();
  assert.equal(nativePosts.filter(p=>p.mode==='file').length,0);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.6 同名顶层文件默认忽略，无原生写入且显示已忽略',async t=>{
  const {page,errors,nativePosts}=await pageFor(t,{copyConflictDest:'/mnt/user/downloads'});
  await openCopyDialog(page,'notes.txt');
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-copy-submit',{hasText:'完成'}).waitFor({timeout:30000});
  assert.match(await page.locator('.ufs-copy-progress-state-text').innerText(),/已忽略同名文件/);
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
  assert.equal(await panel.locator('.ufs-unified-current-name').innerText(),'notes.txt');
  assert.match(await panel.locator('.ufs-unified-current-top').innerText(),/第 1 \/ 1 项/);
  assert.equal(await panel.locator('.ufs-unified-metrics .ufs-unified-metric').count(),2);
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
  await page.locator('.ufs-unified-file-percent',{hasText:'当前文件进度 42%'}).waitFor();
  assert.equal(await page.locator('.ufs-copy-progress-panel [role="progressbar"]').getAttribute('aria-valuenow'),null,
    '文件夹内部单文件百分比不能冒充文件夹总体进度');
  assert.match(await page.locator('.ufs-copy-current-file').innerText(),/中文\.jpg/);
  assert.match(await page.locator('.ufs-copy-progress-metrics').innerText(),/5\.10MB\/s/);
  assert.match(await page.locator('.ufs-copy-progress-metrics').innerText(),/0:00:06/);
  assert.doesNotMatch(await page.locator('.ufs-copy-current-file').innerText(),/\\#\d{3}/);
  await page.locator('.ufs-copy-background').click();
  assert.equal(await page.locator('.ufs-copy-dialog').count(),0);
  assert.equal(await page.locator('.ufs-copy-task-trigger').isVisible(),true);
  await page.locator('.ufs-copy-task-trigger').click();
  await page.locator('.ufs-task-center-open').first().click();
  assert.equal(await page.locator('.ufs-copy-progress-indicator').innerText(),'进行中');
  assert.equal(await page.locator('.ufs-unified-file-percent').innerText(),'当前文件进度 42%');
  assert.equal(errors.length,0,errors.join('\n'));
});


test('嵌套 JSON 进度只显示实际文件名，Done 和异常消息不覆盖当前文件',async t=>{
  const {page,errors}=await pageFor(t,{simulateNativeMonitor:true,longCopy:true});
  await openCopyDialog(page,'Photos');
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit').click();
  const panel=page.locator('.ufs-copy-progress-panel[data-phase="copying"]');
  await panel.waitFor();
  await page.evaluate(()=>{
    window.__ufsMonitorTest.emitFileManager({status:JSON.stringify({
      action:8,text:[
        '<i class="fa fa-spin"></i>Copying... /mnt/user/downloads/\\#344\\#270\\#255\\#346\\#226\\#207.jpg',
        '10,485,760  42%  5.10MB/s  0:00:06 (xfr#1, to-chk=3/5)'
      ]
    })});
  });
  await panel.locator('.ufs-unified-file-percent',{hasText:'当前文件进度 42%'}).waitFor();
  const file=panel.locator('.ufs-copy-current-file');
  assert.equal(await file.innerText(),'当前文件：中文.jpg');
  assert.equal(await file.getAttribute('title'),'/mnt/user/downloads/中文.jpg');
  assert.match(await panel.locator('.ufs-copy-progress-metrics').innerText(),/5\.10MB\/s/);
  for(const status of [
    JSON.stringify({action:8,text:['Done']}),
    'Done',
    JSON.stringify({action:8,text:['Starting...']}),
    '{"invalid":',
    JSON.stringify({action:8,source:'/mnt/user/downloads'})
  ]) {
    await page.evaluate(s=>window.__ufsMonitorTest.emitFileManager({status:s}),status);
    assert.equal(await file.innerText(),'当前文件：中文.jpg');
  }
  assert.equal(await panel.locator('.ufs-copy-progress-indicator').innerText(),'进行中');
  assert.equal(await panel.locator('.ufs-unified-file-percent').innerText(),'当前文件进度 42%');
  assert.equal(await panel.count(),1);
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
  assert.match(await page.locator('.ufs-copy-progress-metrics').innerText(),/当前文件预计剩余\s*0:00:04/);
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
    await page.locator('.ufs-file-actions').click({position:{x:4,y:16}});
    assert.equal(await page.locator('.ufs-menu').count(),0,
      '点击工具栏留白应该关闭右键菜单');
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

test('v0.2.3.13 复制窗口打开后无需点击就能 Esc 关闭，回到文件列表',async t=>{
  const {page,errors,nativePosts}=await pageFor(t);
  await openCopyDialog(page,'notes.txt');
  assert.equal(await page.evaluate(()=>document.activeElement?.classList.contains('ufs-copy-dialog')),true,
    '复制弹窗打开应主动获得键盘焦点');
  await page.keyboard.press('Escape');
  await page.locator('.ufs-copy-dialog').waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>document.activeElement?.classList.contains('ufs-list')),true,
    '关闭后键盘焦点回到文件列表');
  assert.equal(await page.locator('.ufs-entry.ufs-selected').count(),1,
    'Esc 不应触发全局取消文件选择');
  assert.equal(nativePosts.filter(post=>post.mode==='file').length,0);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.3.13 行内新建优先响应 Esc，第二次 Esc 关闭复制窗口',async t=>{
  const {page,errors,nativePosts}=await pageFor(t);
  await openCopyDialog(page,'notes.txt');
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.getByRole('button',{name:'在 downloads 下新建文件夹'}).click();
  const input=page.getByRole('textbox',{name:'新文件夹名称'});
  await input.waitFor();
  await input.fill('临时目录');
  await input.press('Escape');
  assert.equal(await page.locator('.ufs-copy-dialog').count(),1);
  assert.equal(await page.locator('.ufs-copy-inline-row').count(),0);
  assert.equal(await page.evaluate(()=>document.activeElement?.classList.contains('ufs-copy-dialog')),true,
    '退出内联编辑后将焦点返回复制窗口');
  await page.keyboard.press('Escape');
  await page.locator('.ufs-copy-dialog').waitFor({state:'detached'});
  assert.equal(nativePosts.filter(post=>post.mode==='file').length,0,
    '取消行内编辑和退出复制弹窗不能产生写入');
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.3.13 复制任务执行中 Esc 只转后台，重新打开后 Esc 再次生效',async t=>{
  const {page,errors,nativePosts}=await pageFor(t,{longCopy:true});
  await openCopyDialog(page,'notes.txt');
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-copy-progress-panel[data-phase="copying"]').waitFor();
  assert.equal(await page.evaluate(()=>document.activeElement?.classList.contains('ufs-copy-dialog')),true,
    '切换到进度面板后应恢复窗口焦点');
  await page.keyboard.press('Escape');
  await page.locator('.ufs-copy-dialog').waitFor({state:'detached'});
  assert.equal(await page.locator('.ufs-copy-task-trigger').isVisible(),true);
  assert.equal(nativePosts.filter(post=>post.action==='99').length,0,
    'Esc 不得调用 Unraid 全局停止接口');
  await page.locator('.ufs-copy-task-trigger').click();
  await page.locator('.ufs-task-center-open').first().click();
  await page.locator('.ufs-copy-dialog').waitFor();
  assert.equal(await page.evaluate(()=>document.activeElement?.classList.contains('ufs-copy-dialog')),true,
    '后台恢复时应重新获得焦点');
  await page.keyboard.press('Escape');
  await page.locator('.ufs-copy-dialog').waitFor({state:'detached'});
  assert.equal(nativePosts.filter(post=>post.action==='99').length,0);
  assert.equal(nativePosts.filter(post=>post.mode==='file').length,1,
    '用户只提交过一次复制任务');
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.3.13 复制成功后 Esc 关闭结果，新建和重命名 Esc 行为不回归',async t=>{
  const {page,errors,nativePosts}=await pageFor(t);
  await newFolderDialog(page);
  assert.equal(await page.evaluate(()=>document.activeElement?.classList.contains('ufs-create-input')),true);
  await page.keyboard.press('Escape');
  await page.locator('.ufs-create-dialog').waitFor({state:'detached'});
  await page.locator('.ufs-entry').filter({hasText:'notes.txt'}).first().click();
  await page.keyboard.press('F2');
  await page.locator('.ufs-rename-dialog').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('.ufs-rename-dialog').waitFor({state:'detached'});
  await openCopyDialog(page,'notes.txt');
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-copy-progress-panel[data-phase="success"]').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('.ufs-copy-dialog').waitFor({state:'detached'});
  assert.equal(nativePosts.filter(post=>post.mode==='file').length,1,
    '新建/重命名 Esc 不能写入；仅保留明确执行的复制请求');
  assert.equal(nativePosts.filter(post=>post.action==='99').length,0);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.3.13 结果不确定时 Esc 关闭但不重试也不发送取消指令',async t=>{
  const {page,errors,nativePosts}=await pageFor(t,{dropCopy:true});
  await openCopyDialog(page,'notes.txt');
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-copy-progress-panel[data-phase="uncertain"]').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('.ufs-copy-dialog').waitFor({state:'detached'});
  assert.equal(nativePosts.filter(post=>post.mode==='file').length,1);
  assert.equal(nativePosts.filter(post=>post.action==='99').length,0);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.3.15 浅灰实体操作按钮的高度、边界、文字和箭头对齐，悬停风格一致',async t=>{
  const {page,errors,nativePosts}=await pageFor(t);
  const create=page.locator('.ufs-create-trigger');
  const ops=page.locator('.ufs-operations');
  const inspect=()=>page.locator('.ufs-file-actions').evaluate(toolbar=>{
    const newBtn=toolbar.querySelector('.ufs-create-trigger');
    const opsBtn=toolbar.querySelector('.ufs-operations');
    const box=el=>{const r=el.getBoundingClientRect();return {
      left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,width:r.width,
      centerY:(r.top+r.bottom)/2};};
    const details=el=>{
      const css=getComputedStyle(el);
      const textNode=Array.from(el.childNodes).find(n=>n.nodeType===Node.TEXT_NODE && n.textContent.trim());
      const range=document.createRange();
      range.selectNodeContents(textNode);
      return {rect:box(el),background:css.backgroundColor,color:css.color,
        fontSize:css.fontSize,fontWeight:css.fontWeight,
        boxSizing:css.boxSizing,radius:css.borderRadius,
        paddingLeft:css.paddingLeft,paddingRight:css.paddingRight,
        minHeight:css.minHeight,maxHeight:css.maxHeight,
        textCenterY:(range.getBoundingClientRect().top+range.getBoundingClientRect().bottom)/2};
    };
    return {toolbar:box(toolbar),gap:getComputedStyle(toolbar).gap,
      create:details(newBtn),ops:details(opsBtn),
      arrow:box(opsBtn.querySelector('.ufs-svg')),
      rightViewBg:getComputedStyle(toolbar.querySelector('.ufs-list-button')).backgroundColor};
  });
  const run=async(width)=>{
    await page.setViewportSize({width,height:900});
    await page.mouse.move(1,1);
    const normal=await inspect();
    assert.equal(normal.toolbar.height,34,'工具栏整体高度不变');
    assert.equal(normal.gap,'5px','不更改整个工具栏的通用间距');
    for(const [name,button] of [['新建',normal.create],['操作',normal.ops]]){
      assert.equal(button.rect.height,28,name+' 按钮高度');
      assert.equal(button.background,'rgb(232, 237, 241)',name+' 默认浅灰实体背景');
      assert.equal(button.fontSize,'13px');
      assert.equal(button.fontWeight,'500');
      assert.equal(button.boxSizing,'border-box');
      assert.equal(button.radius,'5px');
      assert.equal(button.paddingLeft,'10px');
      assert.equal(button.paddingRight,'10px');
      assert.equal(button.minHeight,'28px');
      assert.equal(button.maxHeight,'28px');
      assert.ok(Math.abs(button.rect.centerY-button.textCenterY)<1.1,name+' 文本居中');
    }
    assert.ok(Math.abs(normal.create.rect.top-normal.ops.rect.top)<0.5,
      '顶部边界必须完全对齐：'+JSON.stringify(normal));
    assert.ok(Math.abs(normal.create.rect.bottom-normal.ops.rect.bottom)<0.5,
      '底部边界必须完全对齐：'+JSON.stringify(normal));
    assert.ok(Math.abs(normal.ops.rect.left-normal.create.rect.right-6)<0.5,
      '按钮视觉间距精确为 6px：'+JSON.stringify(normal));
    assert.ok(Math.abs(normal.arrow.centerY-normal.ops.rect.centerY)<0.5,
      '下拉箭头与文字按钮垂直居中：'+JSON.stringify(normal));
    assert.equal(normal.rightViewBg,'rgb(255, 241, 228)',
      '右侧选中的列表视图按钮应保持原有浅橙色选中背景');
    await create.hover();
    assert.equal((await inspect()).create.background,'rgb(213, 220, 226)',
      '新建按钮悬停加深底色');
    assert.equal((await inspect()).ops.background,'rgb(232, 237, 241)',
      '另一个按钮不跟随高亮');
    await ops.hover();
    assert.equal((await inspect()).ops.background,'rgb(213, 220, 226)',
      '操作按钮悬停和新建按钮一致');
    assert.equal((await inspect()).create.background,'rgb(232, 237, 241)');
  };
  await run(1440);
  await run(720);
  await ops.click();
  await page.getByRole('menuitem',{name:'刷新当前目录'}).waitFor();
  await create.click();
  await page.locator('.ufs-create-dialog').waitFor();
  assert.equal(await page.locator('.ufs-menu').count(),0);
  assert.equal(nativePosts.filter(p=>p.mode==='file').length,0);
  await page.locator('.ufs-create-cancel').click();
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.3.16 文件操作栏不显示冗余「文件」标签，两个按钮保持左侧对齐和原有功能',async t=>{
  const {page,errors,nativePosts}=await pageFor(t);
  const toolbar=page.locator('.ufs-file-actions');
  await toolbar.waitFor();
  for(const width of [1440,720]){
    await page.setViewportSize({width,height:900});
    const info=await toolbar.evaluate(el=>{
      const create=el.querySelector('.ufs-create-trigger');
      const operations=el.querySelector('.ufs-operations');
      const toolbarBox=el.getBoundingClientRect();
      const a=create.getBoundingClientRect();
      const b=operations.getBoundingClientRect();
      return {labelCount:el.querySelectorAll('.ufs-section-label').length,
        firstChild:el.firstElementChild?.className,
        leftInset:a.left-toolbarBox.left,toolbarHeight:toolbarBox.height,
        heightA:a.height,heightB:b.height,gap:b.left-a.right};
    });
    assert.equal(info.labelCount,0,'不保留「文件」标签 DOM');
    assert.match(info.firstChild,/ufs-create-trigger/,
      '左侧第一个元素应直接为新建文件夹按钮');
    assert.ok(Math.abs(info.leftInset-10)<0.6,
      '新建按钮应贴近工具栏左侧内边距：'+JSON.stringify(info));
    assert.equal(info.toolbarHeight,34);
    assert.equal(info.heightA,28);
    assert.equal(info.heightB,28);
    assert.ok(Math.abs(info.gap-6)<0.6,
      '按钮间距依旧为 6px：'+JSON.stringify(info));
  }
  await page.locator('.ufs-operations').click();
  await page.getByRole('menuitem',{name:'刷新当前目录'}).waitFor();
  await toolbar.click({position:{x:4,y:16}});
  assert.equal(await page.locator('.ufs-menu').count(),0,
    '点击左侧空白区域能正常关闭菜单');
  await page.locator('.ufs-create-trigger').click();
  await page.locator('.ufs-create-dialog').waitFor();
  assert.equal(nativePosts.filter(post=>post.mode==='file').length,0,
    '打开新建文件夹弹窗不应执行写入');
  await page.locator('.ufs-create-cancel').click();
  assert.equal(errors.length,0,errors.join('\n'));
});


async function openBatchCopyDialog(page,names) {
  for(const [i,name] of names.entries()){
    await page.locator('.ufs-entry').filter({hasText:name}).first()
      .click(i?{modifiers:['ControlOrMeta']}:{});
  }
  assert.equal(await page.locator('.ufs-entry.ufs-selected').count(),names.length);
  await page.locator('.ufs-operations').click();
  await page.getByRole('menuitem',{name:'复制到…'}).click();
  await page.locator('.ufs-copy-dialog').waitFor();
}

test('v0.2.4 百项文件使用独立清单视图，搜索后返回不丢目标位置',async t=>{
  const {page,errors,nativePosts}=await pageFor(t,{bulkCount:120});
  await page.locator('.ufs-entry').first().waitFor();
  await page.locator('.ufs-list').focus();
  await page.keyboard.press('ControlOrMeta+a');
  assert.equal(await page.locator('.ufs-entry.ufs-selected').count(),120);
  await page.locator('.ufs-operations').click();
  await page.getByRole('menuitem',{name:'复制到…'}).click();
  await page.locator('.ufs-copy-dialog').waitFor();
  assert.equal(await page.locator('.ufs-batch-preview-row').count(),3);
  await page.getByRole('button',{name:'查看全部 120 项'}).click();
  await page.locator('.ufs-batch-list-panel').waitFor();
  assert.equal(await page.locator('.ufs-batch-list-row').count(),120);
  await page.locator('.ufs-batch-list-search').fill('file-00119');
  assert.equal(await page.locator('.ufs-batch-list-row').count(),1);
  assert.match(await page.locator('.ufs-batch-list-name').innerText(),/file-00119/);
  await page.locator('.ufs-batch-list-back').click();
  await page.locator('.ufs-copy-picker').waitFor();
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.getByRole('button',{name:'查看全部 120 项'}).click();
  await page.locator('.ufs-batch-list-back').click();
  assert.equal(await page.locator('.ufs-copy-destination').innerText(),
    '目标：/mnt/user/downloads');
  assert.equal(await page.locator('.ufs-copy-submit').isEnabled(),true);
  assert.equal(nativePosts.filter(p=>p.mode==='file').length,0);
  await page.locator('.ufs-copy-cancel').click();
  assert.equal(errors.length,0,errors.join('\n'));
});


test('v0.2.7.3 小窗口固定忽略覆盖，清单和进度时隐藏策略',async t=>{
  const {page,errors}=await pageFor(t);
  await page.evaluate(()=>document.querySelector('#ufs-app').style.setProperty('--ufs-available-height','400px'));
  await openBatchCopyDialog(page,['Photos','notes.txt']);
  const fixed=page.locator('.ufs-copy-fixed-options');
  await fixed.waitFor({state:'visible'});
  const rect=await page.locator('.ufs-copy-dialog').evaluate(el=>{
    const a=el.querySelector('.ufs-copy-fixed-options').getBoundingClientRect();
    const b=el.querySelector('.ufs-create-buttons').getBoundingClientRect();
    return {height:a.height,overlap:a.bottom>b.top};
  });
  assert.ok(rect.height>0 && !rect.overlap,JSON.stringify(rect));
  await page.locator('.ufs-create-fields').evaluate(el=>el.scrollTop=el.scrollHeight);
  assert.equal(await fixed.isVisible(),true);
  await page.locator('.ufs-copy-policy-radio[value="overwrite"]').check();
  await page.getByRole('button',{name:'查看全部 2 项'}).click();
  await fixed.waitFor({state:'hidden'});
  await page.locator('.ufs-batch-list-back').click();
  await fixed.waitFor({state:'visible'});
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-batch-panel').waitFor();
  await fixed.waitFor({state:'hidden'});
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.7.3 批量复制顶层 text 事件同步弹窗与状态栏速度',async t=>{
  const {page,errors}=await pageFor(t,{simulateNativeMonitor:true,longCopy:true});
  await openBatchCopyDialog(page,['Photos','notes.txt']);
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-batch-panel').waitFor();
  await page.locator('.ufs-batch-speed-value',{hasText:'正在获取复制速度'}).first().waitFor();
  await page.evaluate(()=>window.__ufsMonitorTest.emitFileManager({
    text:['Copying... /mnt/user/TimeMachine/Photos/video.mkv','5.10M 42% 62.8MB/s 0:00:06']
  }));
  await page.locator('.ufs-batch-speed-value',{hasText:'62.8MB/s'}).first().waitFor();
  await page.locator('.ufs-status .ufs-copy-task-trigger',{hasText:'62.8MB/s'}).waitFor();
  assert.match(await page.locator('.ufs-batch-speed-row').last().innerText(),/0:00:06/);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.4 混合文件及文件夹可依次复制，显示总体进度和逐项成功结果',async t=>{
  const {page,errors,nativePosts,copied}=await pageFor(t);
  await openBatchCopyDialog(page,['Photos','notes.txt']);
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit').click();
  const unified=page.locator('.ufs-batch-panel.ufs-unified-progress');
  await unified.waitFor();
  assert.equal(await unified.locator('.ufs-copy-progress-stages .ufs-copy-progress-stage').count(),3);
  assert.equal(await unified.locator('.ufs-unified-metrics .ufs-batch-speed-row').count(),2);
  assert.equal(await unified.locator('.ufs-copy-progress-target-text').innerText(),'/mnt/user/downloads');
  const track=page.locator('.ufs-batch-track');
  assert.equal(await track.getAttribute('aria-label'),'批量复制总体进度');
  await page.locator('.ufs-copy-submit',{hasText:'完成'}).waitFor({timeout:30000});
  assert.equal(await page.locator('.ufs-batch-percent').innerText(),'100%');
  assert.equal(await track.getAttribute('aria-valuenow'),'100');
  assert.match(await page.locator('.ufs-batch-current-name').innerText(),/已处理 2 项（忽略 0 项）/);
  assert.equal(copied.length,2);
  assert.deepEqual(nativePosts.filter(p=>p.mode==='file').map(p=>p.action).sort(),['3','8']);
  await page.locator('.ufs-batch-open-list').last().click();
  await page.locator('.ufs-batch-list-panel').waitFor();
  assert.equal(await page.locator('.ufs-batch-list-row[data-status="success"]').count(),2);
  await page.locator('.ufs-batch-list-back').click();
  await page.locator('.ufs-copy-submit',{hasText:'完成'}).click();
  await page.locator('.ufs-copy-dialog').waitFor({state:'detached'});
  assert.equal(await page.locator('.ufs-copy-task-trigger').isVisible(),false);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.5.1 整批预检立即可见，多个同名一次列出、零写入且允许更换目标',async t=>{
  const {page,errors,nativePosts,copied}=await pageFor(t,{
    copyConflictDest:'/mnt/user/downloads',
    copyConflictNames:['Photos','notes.txt'],
    delayDownloads:650
  });
  await openBatchCopyDialog(page,['Photos','notes.txt']);
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-preflight-checking',{hasText:'正在检查复制任务'}).waitFor();
  const notice=page.locator('.ufs-preflight-notice');
  await notice.getByText('发现 1 项同名冲突').waitFor();
  assert.equal(await notice.isVisible(),true);
  assert.equal(await notice.locator('.ufs-preflight-conflict-row').count(),1);
  assert.match(await notice.innerText(),/Photos/);
  assert.doesNotMatch(await notice.innerText(),/notes.txt/);
  assert.match(await notice.innerText(),/均未开始复制/);
  assert.equal(await page.locator('.ufs-copy-picker').isVisible(),true);
  assert.equal(await page.locator('.ufs-copy-submit').isEnabled(),true);
  const geom=await page.locator('.ufs-create-fields').evaluate(el=>{
    const warn=el.querySelector('.ufs-preflight-notice').getBoundingClientRect();
    const picker=el.querySelector('.ufs-copy-picker').getBoundingClientRect();
    return {top:warn.top,body:el.getBoundingClientRect().top,pickerTop:picker.top,warnBottom:warn.bottom};
  });
  assert.ok(geom.top>=geom.body && geom.top<geom.pickerTop,JSON.stringify(geom));
  assert.equal(nativePosts.filter(p=>p.mode==='file').length,0,
    '整批预检失败，任何原生写入都不能发生');
  assert.match(await page.locator('.ufs-status .ufs-copy-task-trigger').innerText(),/预检未通过/);
  await page.locator('.ufs-copy-policy-radio[value="overwrite"]').check();
  await page.getByRole('button',{name:'选择 appdata'}).click();
  assert.equal(await notice.isVisible(),false,'更换目标位置后清除旧冲突提示');
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-copy-submit',{hasText:'完成'}).waitFor({timeout:30000});
  assert.equal(copied.length,2);
  assert.equal(nativePosts.filter(p=>p.mode==='file').length,2);
  assert.equal(nativePosts.filter(p=>p.mode==='file').every(p=>p.exist==='1'),true,
    '纠正预检错误后切换到覆盖，后续写入必须沿用新策略');
  await page.locator('.ufs-copy-submit',{hasText:'完成'}).click();
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.4 批量后台按钮收纳到底部状态栏，可恢复窗口和安全停止后续队列',async t=>{
  const {page,errors,nativePosts}=await pageFor(t,{
    extraEntries:{'/mnt/user/TimeMachine':[['another.mkv',false]]},longCopy:true});
  await openBatchCopyDialog(page,['notes.txt','another.mkv']);
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-batch-panel').waitFor();
  await page.waitForFunction(()=>document.querySelectorAll(
    '.ufs-copy-dialog .ufs-batch-current-name').length &&
    document.querySelector('.ufs-status .ufs-copy-task-trigger')?.textContent.includes('复制中'));
  await page.locator('.ufs-copy-background').click();
  await page.locator('.ufs-copy-dialog').waitFor({state:'detached'});
  const task=page.locator('.ufs-status .ufs-copy-task-trigger');
  await task.waitFor({state:'visible'});
  assert.equal(await page.locator('.ufs-file-actions .ufs-copy-task-trigger').count(),0);
  const bounds=await page.locator('.ufs-status').evaluate(el=>{
    const parent=el.getBoundingClientRect();
    const child=el.querySelector('.ufs-copy-task-trigger').getBoundingClientRect();
    return {right:parent.right-child.right,top:child.top-parent.top,within:child.bottom<=parent.bottom};
  });
  assert.ok(bounds.right<=15 && bounds.right>=0 && bounds.within,JSON.stringify(bounds));
  await task.click();
  await page.locator('.ufs-task-center-open').first().click();
  await page.locator('.ufs-batch-panel').waitFor();
  assert.equal(await page.locator('.ufs-copy-dialog').count(),1);
  await page.locator('.ufs-copy-cancel').click();
  await page.locator('.ufs-batch-stop-choices').waitFor({state:'visible'});
  await page.getByRole('button',{name:/当前项目完成后停止/}).click();
  assert.equal(await page.locator('.ufs-copy-cancel').isDisabled(),true);
  assert.equal(nativePosts.filter(p=>p.action==='99').length,0,
    '正常停止队列不允许发送 Unraid 全局停止 action=99');
  await page.keyboard.press('Escape');
  await page.locator('.ufs-copy-dialog').waitFor({state:'detached'});
  assert.equal(await task.isVisible(),true);
  assert.equal(errors.length,0,errors.join('\n'));
});


test('v0.2.5 方案 A：第一项执行时第二项排队，右下角显示等待数并可进入任务中心',async t=>{
  const {page,errors,nativePosts}=await pageFor(t,{firstCopyHoldReads:8});
  await openCopyDialog(page,'notes.txt');
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-copy-progress-panel[data-phase="copying"]').waitFor();
  await page.locator('.ufs-copy-background').click();
  await openCopyDialog(page,'Photos');
  await page.getByRole('button',{name:'选择 appdata'}).click();
  await page.locator('.ufs-copy-submit').click();
  const footer=page.locator('.ufs-status .ufs-copy-task-trigger');
  await footer.getByText('1',{exact:true}).waitFor();
  assert.match(await footer.innerText(),/复制中/);
  assert.equal(await footer.locator('.ufs-task-badge-wait').innerText(),'1');
  // Assert SVG path content instead of trusting icon names: unknown icons fall back to a file.
  assert.equal(await footer.locator('.ufs-task-badge-wait svg path').nth(1).getAttribute('d'),
    'M12 6v6h4','等待数量左侧应为时钟');
  assert.equal(await footer.locator('.ufs-task-badge-chevron path').first().getAttribute('d'),
    'm18 15-6-6-6 6','胶囊右侧应为向上箭头');
  assert.equal(nativePosts.filter(p=>p.mode==='file').length,1,
    '第二项排队期间原生接口只能提交第一项');
  await page.locator('.ufs-copy-background').click();
  await footer.click();
  await page.locator('.ufs-copy-task-center').waitFor();
  assert.equal(await page.locator('.ufs-task-center-row').count(),2);
  assert.equal(await page.locator('.ufs-task-center-row[data-status="queued"]').count(),1);
  assert.equal(await page.locator('.ufs-task-center-row[data-status="queued"] .ufs-task-center-state svg path')
    .nth(1).getAttribute('d'),'M12 6v6h4','任务中心等待状态也必须显示时钟');
  await page.locator('.ufs-task-center-row[data-status="queued"] .ufs-task-center-remove').click();
  assert.equal(await footer.locator('.ufs-task-badge-wait').count(),0);
  assert.equal(nativePosts.filter(p=>p.action==='99').length,0);
  assert.equal(nativePosts.filter(p=>p.mode==='file').length,1);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.5 队列顺序执行两项、后台完成保留结果、均确认后入口消失',async t=>{
  const {page,errors,nativePosts,copied}=await pageFor(t,{firstCopyHoldReads:7});
  await openCopyDialog(page,'notes.txt');
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-copy-background').click();
  await openCopyDialog(page,'Photos');
  await page.getByRole('button',{name:'选择 appdata'}).click();
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-copy-background').click();
  await page.waitForFunction(()=>
    document.querySelector('.ufs-status .ufs-task-badge-wait')?.textContent.trim()==='1');
  await page.locator('.ufs-copy-task-trigger').click();
  await page.locator('.ufs-task-center-row[data-status="queued"]').waitFor();
  // Keep the task center open while waiting -> copying -> success changes.
  await page.waitForFunction(()=>document.querySelector('.ufs-copy-task-trigger')?.textContent.includes('复制完成 2 项'),
    null,{timeout:30000});
  await page.waitForFunction(()=>
    document.querySelectorAll('.ufs-task-center-row[data-status="success"]').length===2,
    null,{timeout:5000});
  assert.deepEqual(nativePosts.filter(p=>p.mode==='file').map(p=>p.action),['8','3']);
  assert.equal(copied.length,2);
  assert.equal(await page.locator('.ufs-task-center-row[data-status="success"]').count(),2);
  assert.equal(await page.locator('.ufs-task-center-row[data-status="success"] .ufs-task-center-state svg path')
    .nth(1).getAttribute('d'),'m8 12 3 3 5-6','任务完成时应为圆圈对勾');
  await page.locator('.ufs-task-center-open').first().click();
  await page.locator('.ufs-copy-dialog').waitFor();
  await page.locator('.ufs-copy-submit',{hasText:'完成'}).click();
  await page.locator('.ufs-copy-task-trigger').click();
  await page.locator('.ufs-task-center-open').first().click();
  await page.locator('.ufs-copy-submit',{hasText:'完成'}).click();
  assert.equal(await page.locator('.ufs-copy-task-trigger').isVisible(),false);
  assert.equal(errors.length,0,errors.join('\n'));
});


test('v0.2.6 忽略同名文件，仅复制未冲突项目，进度与结果正确',async t=>{
  const {page,errors,nativePosts,copied}=await pageFor(t,{
    copyConflictDest:'/mnt/user/downloads',copyConflictNames:['notes.txt']
  });
  await openBatchCopyDialog(page,['Photos','notes.txt']);
  assert.equal(await page.locator('.ufs-copy-policy-radio:checked').inputValue(),'skip');
  assert.equal(await page.locator('.ufs-copy-policy-choice').count(),2);
  assert.equal(await page.locator('.ufs-copy-policy .ufs-copy-policy-warning').count(),0);
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-copy-submit',{hasText:'完成'}).waitFor({timeout:30000});
  assert.equal(await page.locator('.ufs-batch-percent').innerText(),'100%');
  assert.equal(copied.length,1);
  const posts=nativePosts.filter(p=>p.mode==='file');
  assert.deepEqual(posts.map(p=>p.action),['3']);
  assert.equal(posts[0].exist,'');
  assert.match(await page.locator('.ufs-batch-current .ufs-batch-meta').first().innerText(),/忽略 1/);
  await page.locator('.ufs-batch-open-list').last().click();
  assert.equal(await page.locator('.ufs-batch-list-row[data-status="skipped"]').count(),1);
  assert.equal(await page.locator('.ufs-batch-list-row[data-status="success"]').count(),1);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.6 覆盖选项仅显示 Tooltip，无常驻提醒，原生 exist=1',async t=>{
  const {page,errors,nativePosts,copied}=await pageFor(t,{
    copyConflictDest:'/mnt/user/downloads',copyConflictNames:['notes.txt']
  });
  await openCopyDialog(page,'notes.txt');
  const options=page.locator('.ufs-copy-policy-choice');
  await options.last().hover();
  const tooltip=await options.last().evaluate(el=>getComputedStyle(el,'::after').content);
  assert.match(tooltip,/源文件替换同名文件/);
  await page.locator('.ufs-copy-policy-radio[value="overwrite"]').check();
  assert.equal(await page.locator('.ufs-copy-policy-radio:checked').inputValue(),'overwrite');
  assert.equal(await page.locator('.ufs-copy-policy .ufs-copy-policy-warning').count(),0);
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-copy-submit',{hasText:'完成'}).waitFor({timeout:30000});
  assert.equal(copied.length,1);
  const posts=nativePosts.filter(p=>p.mode==='file');
  assert.equal(posts.length,1);
  assert.equal(posts[0].action,'8');
  assert.equal(posts[0].exist,'1');
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.6.1 圆点样式不填满外圈，切换选项时 Tooltip 不重叠、不留下方框',async t=>{
  const {page,errors}=await pageFor(t);
  await openCopyDialog(page,'notes.txt');
  const options=page.locator('.ufs-copy-policy-choice');
  const radios=page.locator('.ufs-copy-policy-radio');
  assert.equal(await radios.first().isChecked(),true);
  assert.equal(await page.locator('.ufs-copy-policy-ring').count(),2);
  const rings=await options.evaluateAll(list=>list.map(el=>{
    const mark=el.querySelector('.ufs-copy-policy-ring');
    const before=getComputedStyle(mark);
    const dot=getComputedStyle(mark,'::after');
    return {width:Math.round(mark.getBoundingClientRect().width),
      radius:before.borderRadius,border:before.borderTopWidth,
      dotContent:dot.content,dotWidth:dot.width,focusOutline:getComputedStyle(el.querySelector('input')).outlineStyle};
  }));
  assert.equal(rings[0].width,18);
  assert.equal(rings[0].radius,'50%');
  assert.equal(rings[0].border,'2px');
  assert.equal(rings[0].dotWidth,'8px','选中内点小于外圈，不能整圈填满');
  assert.equal(rings[1].dotContent,'none','未选中为空心');
  assert.equal(rings[0].focusOutline,'none','不能保留原生输入框方形焦点框');

  await radios.last().check();
  assert.equal(await radios.last().isChecked(),true);
  await options.first().hover();
  const afterSwitch=await options.evaluateAll(list=>list.map(el=>{
    const tip=getComputedStyle(el,'::after');
    return {visible:tip.visibility,content:tip.content};
  }));
  assert.equal(afterSwitch.filter(x=>x.visible==='visible').length,1,
    JSON.stringify(afterSwitch));
  assert.match(afterSwitch[0].content,/跳过目标/);
  assert.equal(afterSwitch[1].visible,'hidden');
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.6 同名文件夹按忽略策略合并，不将目录本身整体跳过',async t=>{
  const {page,errors,nativePosts,copied}=await pageFor(t,{
    copyConflictDest:'/mnt/user/downloads',copyConflictNames:[['Photos',true]]
  });
  await openCopyDialog(page,'Photos');
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-copy-submit',{hasText:'完成'}).waitFor({timeout:30000});
  assert.equal(copied.length,1);
  const posts=nativePosts.filter(p=>p.mode==='file');
  assert.equal(posts.length,1);
  assert.equal(posts[0].action,'3');
  assert.equal(posts[0].exist,'');
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.6.2 真实 rsync 速度同步任务中心和底部胶囊，动画稳定且超时消失',async t=>{
  const {page,errors,nativePosts}=await pageFor(t,{
    simulateNativeMonitor:true,longCopy:true
  });
  await openCopyDialog(page,'notes.txt');
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-copy-progress-panel[data-phase="copying"]').waitFor();
  await page.locator('.ufs-copy-background').click();
  const badge=page.locator('.ufs-status .ufs-copy-task-trigger');
  await badge.waitFor({state:'visible'});
  await badge.click();
  const row=page.locator('.ufs-task-center-row[data-status="running"]');
  await row.waitFor();
  const spin=badge.locator('.ufs-task-live-spinner');
  assert.equal(await spin.count(),1);
  const token=await spin.evaluate(el=>{
    el.dataset.identity='spinner-stable';
    return getComputedStyle(el).animationName;
  });
  assert.equal(token,'ufs-copy-spin');
  assert.match(await row.locator('.ufs-task-center-meta').innerText(),/速度获取中/);
  await page.evaluate(()=>window.__ufsMonitorTest.emitFileManager({
    status:'Copying ... notes.txt\n  4,194,304  42%  85.6MB/s  0:00:05'
  }));
  await badge.getByText('85.6MB/s').waitFor();
  assert.match(await row.locator('.ufs-task-center-meta').innerText(),/速度 85.6MB\/s/);
  assert.match(await badge.innerText(),/42%/);
  const unchanged=await spin.evaluate(el=>el.dataset.identity);
  assert.equal(unchanged,'spinner-stable','速度变化不能重建旋转节点');
  await page.evaluate(()=>window.__ufsMonitorTest.emitFileManager({
    status:'Copying ... notes.txt\n  5,194,304  48%  91.2MB/s  0:00:04'
  }));
  await badge.getByText('91.2MB/s').waitFor();
  assert.equal(await spin.evaluate(el=>el.dataset.identity),'spinner-stable');
  await page.waitForFunction(()=>
    !document.querySelector('.ufs-task-badge-speed')?.textContent.includes('91.2MB/s'),
    null,{timeout:9000});
  assert.equal(await badge.locator('.ufs-task-badge-speed').innerText(),'');
  assert.match(await row.locator('.ufs-task-center-meta').innerText(),/速度暂无数据/);
  assert.match(await badge.innerText(),/复制中/);
  assert.equal(nativePosts.filter(p=>p.mode==='file').length,1,
    '速度展示不得额外提交原生任务');
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.6.2 多任务排队保留等待数量，仅活动任务展示速度和 Spinner',async t=>{
  const {page,errors,nativePosts}=await pageFor(t,{
    simulateNativeMonitor:true,firstCopyHoldReads:12
  });
  await openCopyDialog(page,'notes.txt');
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-copy-progress-panel[data-phase="copying"]').waitFor();
  await page.locator('.ufs-copy-background').click();
  await openCopyDialog(page,'Photos');
  await page.getByRole('button',{name:'选择 appdata'}).click();
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-copy-background').click();
  const badge=page.locator('.ufs-status .ufs-copy-task-trigger');
  await badge.locator('.ufs-task-badge-wait').getByText('1',{exact:true}).waitFor();
  await badge.click();
  await page.locator('.ufs-task-center-row[data-status="queued"]').waitFor();
  assert.equal(await page.locator('.ufs-task-center-row[data-status="queued"] .ufs-task-live-spinner').count(),0);
  assert.equal(await page.locator('.ufs-task-center-row[data-status="running"] .ufs-task-live-spinner').count(),1);
  await page.evaluate(()=>window.__ufsMonitorTest.emitFileManager({
    status:'Copying ... notes.txt\n  4,194,304  42%  66.3MB/s  0:00:09'
  }));
  await badge.getByText('66.3MB/s').waitFor();
  await page.locator('.ufs-task-center-row[data-status="running"][data-phase="copying"] .ufs-task-center-name',
    {hasText:'Photos'}).waitFor({timeout:25000});
  assert.equal(await badge.locator('.ufs-task-badge-speed').innerText(),'',
    '启动下一项时不得沿用上一项速度');
  assert.equal(await page.locator('.ufs-task-center-row[data-status="success"]').count(),1);
  assert.equal(await page.locator('.ufs-task-center-row[data-status="running"]').count(),1);
  assert.equal(nativePosts.filter(p=>p.mode==='file').length,2);
  await page.evaluate(()=>window.__ufsMonitorTest.emitFileManager({
    status:'Copying ... Photos\n  1,024  6%  42.3MB/s  0:00:09'
  }));
  await badge.getByText('42.3MB/s').waitFor();
  assert.equal(await badge.locator('.ufs-task-badge-percent').innerText(),'',
    '文件夹不得使用单个内部文件的百分比冒充整体进度');
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.6.4 无任务时两种模式来回切换，保留目录标签和当前选择',async t=>{
  const {page,errors}=await pageFor(t,{simulateNativeMonitor:true});
  await page.locator('.ufs-entry').filter({hasText:'notes.txt'}).first().click();
  const origin=await page.evaluate(()=>performance.timeOrigin);
  let nav=0;
  page.on('request',req=>{
    if(req.isNavigationRequest() && req.frame()===page.mainFrame()) nav++;
  });
  await page.locator('.ufs-more').click();
  await page.getByRole('menuitem',{name:/返回原生文件管理器/}).click();
  await page.locator('#ufs-native-enable').waitFor({state:'visible'});
  assert.equal(await page.locator('#ufs-app').isVisible(),false);
  assert.equal(await page.locator('table.indexer').isVisible(),true);
  assert.equal(await page.locator('#ufs-native-readonly-note').isVisible(),false);
  await page.locator('#ufs-native-enable').click();
  await page.locator('#ufs-app').waitFor({state:'visible'});
  assert.equal(await page.locator('.ufs-entry.ufs-selected').count(),1);
  assert.equal(await page.locator('table.indexer').isVisible(),false);
  assert.equal(await page.evaluate(()=>performance.timeOrigin),origin);
  assert.equal(nav,0,'模式切换不能发起页面导航');
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.6.4 复制中切换到原生仅允许只读查看，返回后保留运行和排队任务',async t=>{
  const {page,errors,nativePosts}=await pageFor(t,{
    firstCopyHoldReads:28,simulateNativeMonitor:true
  });
  const origin=await page.evaluate(()=>performance.timeOrigin);
  let nav=0;
  page.on('request',req=>{
    if(req.isNavigationRequest() && req.frame()===page.mainFrame()) nav++;
  });
  await openCopyDialog(page,'notes.txt');
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-copy-progress-panel[data-phase="copying"]').waitFor();
  await page.locator('.ufs-copy-background').click();
  await openCopyDialog(page,'Photos');
  await page.getByRole('button',{name:'选择 appdata'}).click();
  await page.locator('.ufs-copy-submit').click();
  await page.locator('.ufs-copy-background').click();
  const badge=page.locator('.ufs-status .ufs-copy-task-trigger');
  await badge.locator('.ufs-task-badge-wait').getByText('1',{exact:true}).waitFor();
  await page.locator('.ufs-more').click();
  await page.getByRole('menuitem',{name:/返回原生文件管理器/}).click();
  await page.locator('#ufs-native-enable').waitFor({state:'visible'});
  await page.locator('#ufs-native-readonly-note').waitFor({state:'visible'});
  assert.equal(await page.locator('table.indexer').isVisible(),true);
  await page.evaluate(()=>{
    window.__ufsNativeClicks=0;
    document.querySelector('table.indexer').addEventListener('click',()=>
      window.__ufsNativeClicks++);
    window.__ufsMonitorTest.emit('1');
    window.__ufsMonitorTest.emit('0');
  });
  await page.locator('table.indexer').click({force:true});
  assert.equal(await page.evaluate(()=>window.__ufsNativeClicks),0,
    '排队期间原生表格必须由捕获阶段屏蔽点击');
  await page.waitForTimeout(1750);
  assert.equal(nav,0,'文件监控不得触发原生整页刷新');
  await page.locator('#ufs-native-enable').click();
  await page.locator('#ufs-app').waitFor({state:'visible'});
  assert.equal(await badge.isVisible(),true);
  await badge.click();
  await page.locator('.ufs-task-center-row[data-status="running"]').waitFor();
  await page.locator('.ufs-task-center-row[data-status="queued"]').waitFor();
  assert.equal(await page.locator('.ufs-task-center-row').count(),2);
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,1,
    '模式切换不能重复提交当前任务或提前启动排队任务');
  assert.equal(await page.evaluate(()=>performance.timeOrigin),origin);
  assert.equal(nav,0);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.6.5 未发生文件变更时反复切换原生界面，不触发额外 Browse.php 请求',async t=>{
  const {page,errors,browseRequests}=await pageFor(t,{simulateNativeMonitor:true});
  await page.locator('.ufs-entry').first().waitFor();
  await page.waitForLoadState('networkidle');
  const count=browseRequests.length;
  const origin=await page.evaluate(()=>performance.timeOrigin);
  for(let i=0;i<3;i++){
    await page.locator('.ufs-more').click();
    await page.getByRole('menuitem',{name:/返回原生文件管理器/}).click();
    await page.locator('#ufs-native-enable').waitFor({state:'visible'});
    assert.equal(await page.locator('#ufs-native-refresh-note').isVisible(),false);
    await page.locator('#ufs-native-enable').click();
    await page.locator('#ufs-app').waitFor({state:'visible'});
  }
  assert.equal(browseRequests.length,count,'清洁原生列表不应该重新请求');
  assert.equal(await page.evaluate(()=>performance.timeOrigin),origin);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.6.5 脏原生列表请求失败保留旧内容并允许手动重试',async t=>{
  const {page,errors}=await pageFor(t,{simulateNativeMonitor:true});
  await page.locator('.ufs-entry').first().waitFor();
  await page.evaluate(()=>{window.dir='/mnt/user/appdata';});
  let attempts=0;
  const failNative=async route=>{
    const dir=decodeURIComponent(new URL(route.request().url()).searchParams.get('dir')||'');
    if(dir==='/mnt/user/appdata') {
      attempts++;
      await route.fulfill({status:503,body:'temporary outage'});
    } else await route.fallback();
  };
  await page.route('**/webGui/include/Browse.php?*',failNative);
  await page.evaluate(()=>{
    window.__ufsMonitorTest.emit('1');
    window.__ufsMonitorTest.emit('0');
  });
  await page.locator('.ufs-more').click();
  await page.getByRole('menuitem',{name:/返回原生文件管理器/}).click();
  await page.locator('#ufs-native-refresh-note').waitFor({state:'visible'});
  assert.match(await page.locator('#ufs-native-refresh-note').innerText(),/HTTP 503/);
  assert.match(await page.locator('table.indexer tbody').innerText(),/原生文件管理器/,
    '请求失败保留旧的原生目录内容');
  assert.equal(attempts,1);
  await page.unroute('**/webGui/include/Browse.php?*',failNative);
  await page.locator('#ufs-native-refresh-retry').click();
  await page.locator('#ufs-native-refresh-note').waitFor({state:'hidden'});
  assert.match(await page.locator('table.indexer tbody').innerText(),/bitwarden/,
    '重试成功后替换旧列表');
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.6.5 所有内建 SVG 图标的 path d 都能由 Chromium 正常解析',async t=>{
  const {page,errors}=await pageFor(t);
  await page.locator('.ufs-entry').first().waitFor();
  const response=await page.request.get(
    new URL('/src/unraid-file-station.user.js',page.url()).href);
  assert.equal(response.status(),200);
  const source=await response.text();
  const begin=source.indexOf('  const ICONS = {');
  const end=source.indexOf('  function icon(',begin);
  assert.ok(begin>0 && end>begin);
  const icons=runInNewContext(source.slice(begin,end)+'\nICONS');
  const entries=Object.entries(icons).map(([name,paths])=>[name,Array.from(paths)]);
  const svgErrors=[];
  const watch=msg=>{
    if(msg.type()==='error' && /(?:<path> attribute d|Expected number|SVG path)/i.test(msg.text()))
      svgErrors.push(msg.text());
  };
  page.on('console',watch);
  const lengths=await page.evaluate(entries=>{
    return entries.flatMap(([name,paths])=>paths.map(d=>{
      const ns='http://www.w3.org/2000/svg';
      const svg=document.createElementNS(ns,'svg');
      const path=document.createElementNS(ns,'path');
      path.setAttribute('d',d);
      svg.append(path);
      document.body.append(svg);
      let length=NaN;
      try {length=path.getTotalLength();} catch (_) {}
      svg.remove();
      return {name,d,length};
    }));
  },entries);
  page.off('console',watch);
  assert.deepEqual(svgErrors,[],svgErrors.join('\n'));
  assert.deepEqual(lengths.filter(x=>!Number.isFinite(x.length)),[]);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.7 F5 后只恢复保存的任务，用户手动确认前不发送原生复制',async t=>{
  const {page,errors,nativePosts}=await pageFor(t,{simulateNativeMonitor:true});
  await page.locator('.ufs-entry').first().waitFor();
  await page.evaluate(async()=>{
    const snapshot={schema:1,savedAt:Date.now(),tasks:[{
      taskId:'copy_saved_queued01',name:'notes.txt',destination:'/mnt/user/downloads',
      conflictPolicy:'skip',status:'queued',createdAt:Date.now(),updatedAt:Date.now(),
      items:[{source:'/mnt/user/TimeMachine/notes.txt',folder:false,size:1024,
        status:'queued',submission:'not-submitted',updatedAt:Date.now()}]
    }]};
    const db=await new Promise((resolve,reject)=>{
      const r=indexedDB.open('ufs-copy-queue-v1',1);
      r.onsuccess=()=>resolve(r.result);
      r.onerror=()=>reject(r.error);
    });
    await new Promise((resolve,reject)=>{
      const tx=db.transaction('snapshots','readwrite');
      tx.objectStore('snapshots').put({key:'active',snapshot});
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
    });
    db.close();
  });
  await page.reload({waitUntil:'domcontentloaded'});
  const trigger=page.locator('.ufs-status .ufs-copy-task-trigger');
  await trigger.getByText('有 1 项任务待恢复').waitFor();
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,0,
    '页面初始化绝不能自动执行恢复任务');
  await trigger.click();
  const center=page.locator('.ufs-copy-task-center');
  await center.getByRole('button',{name:'确认恢复队列'}).waitFor();
  assert.equal(await center.locator('.ufs-task-center-row').count(),1);
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,0);
  page.once('dialog',dialog=>dialog.accept());
  await center.getByRole('button',{name:'确认恢复队列'}).click();
  await page.waitForFunction(()=>!document.querySelector('.ufs-task-recovery'),null,
    {timeout:10000});
  await trigger.getByText('复制完成 1 项').waitFor({timeout:25000});
  await trigger.click();
  await page.locator('.ufs-task-center-row[data-status="success"]').waitFor({timeout:5000});
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,1);
  const posts=nativePosts.filter(x=>x.mode==='file');
  assert.equal(posts[0].exist,'');
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.7 恢复前原生已提交项目必须先人工核实并跳过，不能直接重发',async t=>{
  const {page,errors,nativePosts}=await pageFor(t,{simulateNativeMonitor:true});
  await page.locator('.ufs-entry').first().waitFor();
  await page.evaluate(async()=>{
    const snapshot={schema:1,savedAt:Date.now(),tasks:[{
      taskId:'copy_saved_mixed001',name:'2 个文件',destination:'/mnt/user/downloads',
      conflictPolicy:'overwrite',status:'running',createdAt:Date.now(),updatedAt:Date.now(),
      items:[
        {source:'/mnt/user/TimeMachine/notes.txt',folder:false,size:1024,
          status:'submission-intent',submission:'intent-saved'},
        {source:'/mnt/user/TimeMachine/Photos',folder:true,size:null,
          status:'queued',submission:'not-submitted'}
      ]
    }]};
    const db=await new Promise((resolve,reject)=>{
      const r=indexedDB.open('ufs-copy-queue-v1',1);
      r.onsuccess=()=>resolve(r.result);
      r.onerror=()=>reject(r.error);
    });
    await new Promise((resolve,reject)=>{
      const tx=db.transaction('snapshots','readwrite');
      tx.objectStore('snapshots').put({key:'active',snapshot});
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
    });
    db.close();
  });
  await page.reload({waitUntil:'domcontentloaded'});
  const badge=page.locator('.ufs-status .ufs-copy-task-trigger');
  await badge.getByText('有 1 项任务待核实').waitFor();
  await badge.click();
  const center=page.locator('.ufs-copy-task-center');
  assert.equal(await center.getByRole('button',{name:'请先核实任务'}).isDisabled(),true);
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,0);
  await center.locator('.ufs-task-center-open').first().click();
  const details=page.getByRole('dialog',{name:'恢复复制任务详情'});
  await details.waitFor();
  assert.match(await details.innerText(),/notes.txt · 待核实/);
  page.once('dialog',dialog=>dialog.accept());
  await details.getByRole('button',{name:'已人工核实，跳过此项'}).click();
  await details.getByRole('button',{name:'关闭'}).click();
  await badge.click();
  const refreshed=page.locator('.ufs-copy-task-center');
  await refreshed.getByRole('button',{name:'确认恢复队列'}).waitFor();
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,0);
  page.once('dialog',dialog=>dialog.accept());
  await refreshed.getByRole('button',{name:'确认恢复队列'}).click();
  await badge.getByText('复制完成 1 项').waitFor({timeout:25000});
  await badge.click();
  await page.locator('.ufs-task-center-row[data-status="success"]').waitFor({timeout:5000});
  const posts=nativePosts.filter(x=>x.mode==='file');
  assert.equal(posts.length,1,'核实并跳过的第一项不得重复提交');
  assert.match(decodeURIComponent(posts[0].source),/Photos/);
  assert.equal(posts[0].exist,'1','恢复任务保留创建时的覆盖策略');
  assert.equal(errors.length,0,errors.join('\n'));
});


test('v0.2.7 关闭标签页后同源重新打开仍提示手动恢复且不自动提交',async t=>{
  const {page,errors}=await pageFor(t,{simulateNativeMonitor:true});
  await page.locator('.ufs-entry').first().waitFor();
  await page.evaluate(async()=>{
    const db=await new Promise((resolve,reject)=>{
      const req=indexedDB.open('ufs-copy-queue-v1',1);
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>reject(req.error);
    });
    await new Promise((resolve,reject)=>{
      const tx=db.transaction('snapshots','readwrite');
      tx.objectStore('snapshots').put({key:'active',snapshot:{
        schema:1,savedAt:Date.now(),tasks:[{
          taskId:'copy_closed_tab001',name:'backup.zip',
          destination:'/mnt/user/downloads',conflictPolicy:'skip',
          status:'queued',createdAt:Date.now(),updatedAt:Date.now(),
          items:[{source:'/mnt/user/TimeMachine/backup/snapshot.zip',
            folder:false,status:'queued',submission:'not-submitted',size:2048}]
        }]
      }});
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
    });
    db.close();
  });
  const context=page.context();
  const address=page.url();
  await page.close();
  const reopened=await context.newPage();
  await reopened.route('**/Shares/Browse?*',route=>route.fulfill({
    status:200,contentType:'text/html',body:html
  }));
  let nativeWrites=0;
  await reopened.route('**/webGui/include/Control.php*',async route=>{
    const req=route.request();
    if(req.method()==='POST'){
      const body=req.postData()||'';
      if(/mode=file|mode%3Dfile/.test(body))nativeWrites++;
    }
    await route.fulfill({status:200,body:'',contentType:'text/plain'});
  });
  await reopened.goto(address,{waitUntil:'domcontentloaded'});
  const trigger=reopened.locator('.ufs-status .ufs-copy-task-trigger');
  await trigger.getByText('有 1 项任务待恢复').waitFor({timeout:15000});
  await trigger.click();
  const panel=reopened.locator('.ufs-task-recovery');
  await panel.getByRole('button',{name:'确认恢复队列'}).waitFor();
  assert.equal(await reopened.locator('.ufs-task-center-row[data-status="queued"]').count(),1);
  assert.equal(nativeWrites,0,'重新开标签页不得自行执行已保存的队列');
  await reopened.waitForTimeout(1200);
  assert.equal(nativeWrites,0,'等待一段时间后仍应保持暂停');
  assert.equal(errors.length,0,errors.join('\n'));
});


// v0.2.7.1: a recovered task belongs to an old JS lifetime. Its native
// process is simulated independently of File Station's new page.
async function seedInterruptedNativeCopy(page, includeWaiting=true) {
  await page.evaluate(async includeWaiting=>{
    const now=Date.now();
    const tasks=[{
      taskId:'copy_native_resume01',name:'notes.txt',destination:'/mnt/user/downloads',
      conflictPolicy:'skip',status:'running',createdAt:now,updatedAt:now,
      items:[{source:'/mnt/user/TimeMachine/notes.txt',folder:false,size:2048,
        status:'submission-intent',submission:'intent-saved',updatedAt:now}]
    }];
    if(includeWaiting)tasks.push({
      taskId:'copy_native_wait002',name:'Photos',destination:'/mnt/user/downloads',
      conflictPolicy:'overwrite',status:'queued',createdAt:now,updatedAt:now,
      items:[{source:'/mnt/user/TimeMachine/Photos',folder:true,size:null,
        status:'queued',submission:'not-submitted',updatedAt:now}]
    });
    const db=await new Promise((resolve,reject)=>{
      const r=indexedDB.open('ufs-copy-queue-v1',1);
      r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
    });
    await new Promise((resolve,reject)=>{
      const tx=db.transaction('snapshots','readwrite');
      tx.objectStore('snapshots').put({key:'active',snapshot:{
        schema:1,savedAt:now,tasks
      }});
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
    });
    db.close();
  },includeWaiting);
}

async function mockRecoveredNativeRead(page, options={}) {
  let active=true;
  let wrong=Boolean(options.wrong);
  let releaseToNormal=false;
  const read=async route=>{
    const body=new URLSearchParams(route.request().postData()||'');
    if(body.get('mode')!=='read'||releaseToNormal) {
      await route.fallback();return;
    }
    const current=active?{
      action:wrong?'6':'8',
      source:wrong?'/mnt/user/TimeMachine/backup':'/mnt/user/TimeMachine/notes.txt',
      target:wrong?'':'/mnt/user/downloads/'
    }:null;
    await route.fulfill({status:200,
      contentType:'application/json',body:current?JSON.stringify(current):''});
  };
  await page.route('**/webGui/include/Control.php',read);
  return {
    setActive:next=>{active=next;},
    release:()=>{releaseToNormal=true;},
    dispose:()=>page.unroute('**/webGui/include/Control.php',read)
  };
}

test('v0.2.7.1 F5 重连已提交的原生复制，显示实时进度且后续排队不执行',async t=>{
  const {page,nativePosts,errors}=await pageFor(t,{simulateNativeMonitor:true});
  await page.locator('.ufs-entry').first().waitFor();
  await seedInterruptedNativeCopy(page);
  const native=await mockRecoveredNativeRead(page);
  await page.reload({waitUntil:'domcontentloaded'});
  const badge=page.locator('.ufs-status .ufs-copy-task-trigger');
  await badge.getByText('原生文件操作中 · 队列暂停').waitFor({timeout:15000});
  await page.evaluate(()=>window.__ufsMonitorTest.emitFileManager({
    status:'Copying ... notes.txt\n  4,194,304  29%  91.24MB/s  0:01:38'
  }));
  await badge.getByText('91.24MB/s').waitFor({timeout:8000});
  assert.match(await badge.innerText(),/29%/);
  await badge.click();
  const center=page.locator('.ufs-copy-task-center');
  const running=center.locator('.ufs-task-center-row[data-status="running"]');
  await running.waitFor();
  assert.match(await running.innerText(),/原生复制中|复制中/);
  assert.match(await running.locator('.ufs-task-center-meta').innerText(),/91.24MB\/s/);
  assert.equal(await center.getByRole('button',{name:'等待当前复制完成'}).isDisabled(),true);
  assert.equal(await center.locator('.ufs-task-center-row[data-status="queued"]').count(),1);
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,0,
    'reconnect must never resend the native copy or start the waiting job');
  await running.locator('.ufs-task-center-open').click();
  const details=page.getByRole('dialog',{name:'恢复复制任务详情'});
  await details.waitFor();
  assert.match(await details.innerText(),/notes.txt · 原生复制中/);
  assert.equal(await details.getByRole('button',{name:'已人工核实，跳过此项'}).count(),0);
  assert.equal(errors.length,0,errors.join('\n'));
  await native.dispose();
});

test('v0.2.7.1 不匹配的 Unraid 原生任务绝不能冒充旧复制任务',async t=>{
  const {page,nativePosts,errors}=await pageFor(t,{simulateNativeMonitor:true});
  await page.locator('.ufs-entry').first().waitFor();
  await seedInterruptedNativeCopy(page);
  const native=await mockRecoveredNativeRead(page,{wrong:true});
  await page.reload({waitUntil:'domcontentloaded'});
  const badge=page.locator('.ufs-status .ufs-copy-task-trigger');
  await badge.getByText('有 1 项任务待核实').waitFor();
  await page.evaluate(()=>window.__ufsMonitorTest.emitFileManager({
    status:'Copying unrelated\n  4,194,304  29%  91.24MB/s  0:01:38',done:1
  }));
  await page.waitForTimeout(400);
  assert.doesNotMatch(await badge.innerText(),/91.24MB\/s|原生文件操作中/);
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,0);
  assert.equal(errors.length,0,errors.join('\n'));
  await native.dispose();
});

test('v0.2.7.1 原生完成事件且路径大小核验成功，仅结束该项，等待人工恢复后续队列',async t=>{
  const {page,nativePosts,errors}=await pageFor(t,{
    simulateNativeMonitor:true,extraEntries:{'/mnt/user/downloads':[['notes.txt',false]]}
  });
  await page.locator('.ufs-entry').first().waitFor();
  await seedInterruptedNativeCopy(page);
  const native=await mockRecoveredNativeRead(page);
  await page.reload({waitUntil:'domcontentloaded'});
  const badge=page.locator('.ufs-status .ufs-copy-task-trigger');
  await badge.getByText('原生文件操作中 · 队列暂停').waitFor({timeout:15000});
  await page.evaluate(()=>window.__ufsMonitorTest.emitFileManager({
    status:'Copying ... notes.txt\n  4,194,304 100%  91.24MB/s  0:00:00',done:1
  }));
  native.setActive(false);
  await badge.getByText('有 1 项任务待恢复').waitFor({timeout:15000});
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,0,
    'even a verified native completion must not resume the remaining queue');
  await badge.click();
  const center=page.locator('.ufs-copy-task-center');
  assert.equal(await center.locator('.ufs-task-center-row[data-status="success"]').count(),1);
  assert.equal(await center.locator('.ufs-task-center-row[data-status="queued"]').count(),1);
  assert.equal(await center.getByRole('button',{name:'确认恢复队列'}).isDisabled(),false);
  const snapshot=await page.evaluate(async()=>{
    const db=await new Promise((resolve,reject)=>{
      const r=indexedDB.open('ufs-copy-queue-v1',1);
      r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
    });
    const result=await new Promise((resolve,reject)=>{
      const tx=db.transaction('snapshots','readonly');
      const req=tx.objectStore('snapshots').get('active');
      req.onsuccess=()=>resolve(req.result?.snapshot);req.onerror=()=>reject(req.error);
    });
    db.close();return result;
  });
  assert.equal(snapshot.tasks[0].items[0].status,'success');
  assert.equal(snapshot.tasks[0].items[0].submission,'confirmed');
  assert.equal(snapshot.tasks[1].items[0].status,'queued');
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,0);
  assert.equal(errors.length,0,errors.join('\n'));
  await native.dispose();
});

test('v0.2.7.1 原生任务消失但未收到 done 完成事件，必须恢复待核实',async t=>{
  const {page,nativePosts,errors}=await pageFor(t,{simulateNativeMonitor:true});
  await page.locator('.ufs-entry').first().waitFor();
  await seedInterruptedNativeCopy(page,false);
  const native=await mockRecoveredNativeRead(page);
  await page.reload({waitUntil:'domcontentloaded'});
  const badge=page.locator('.ufs-status .ufs-copy-task-trigger');
  await badge.getByText('原生文件操作中 · 队列暂停').waitFor({timeout:15000});
  native.setActive(false);
  await badge.getByText('有 1 项任务待核实').waitFor({timeout:15000});
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,0);
  await badge.click();
  assert.equal(await page.locator('.ufs-task-center-row[data-status="uncertain"]').count(),1);
  assert.equal(errors.length,0,errors.join('\n'));
  await native.dispose();
});


test('v0.2.8 诊断日志支持标记问题、脱敏导出和跨页面刷新',async t=>{
  const {page,errors}=await pageFor(t);
  await page.locator('.ufs-entry').first().waitFor();
  await page.locator('.ufs-diagnostic-button').click();
  const panel=page.getByRole('dialog',{name:'File Station 诊断中心'});
  await panel.getByRole('button',{name:'开启增强诊断（15分钟）'}).click();
  await panel.getByRole('button',{name:'标记问题'}).click();
  await panel.getByRole('button',{name:'刷新日志'}).click();
  await panel.locator('.ufs-diagnostic-events').getByText(/user\.issue_marker/).waitFor();
  const pending=page.waitForEvent('download');
  await panel.getByRole('button',{name:'导出 JSON'}).click();
  const download=await pending;
  assert.match(download.suggestedFilename(),/^unraid-file-station-diagnostic-/);
  const report=JSON.parse(readFileSync(await download.path(),'utf8'));
  const currentVersion=readFileSync(new URL('../../src/unraid-file-station.user.js',import.meta.url),'utf8')
    .match(/^\/\/ @version\s+(\S+)/m)?.[1];
  assert.ok(currentVersion,'必须具有 UserScript @version');
  assert.equal(report.version,currentVersion);
  assert.equal(report.schemaVersion,1);
  assert.equal(report.events.some(event=>event.code==='user.issue_marker'),true);
  assert.equal(report.events.some(event=>event.code==='diagnostic.mode'),true);
  assert.equal(JSON.stringify(report).includes('test-csrf'),false);
  assert.equal(JSON.stringify(report).includes('/mnt/user/TimeMachine'),false);
  await page.reload({waitUntil:'domcontentloaded'});
  await page.locator('.ufs-diagnostic-button').waitFor();
  await page.locator('.ufs-diagnostic-button').click();
  const restored=page.getByRole('dialog',{name:'File Station 诊断中心'});
  await restored.getByRole('button',{name:'刷新日志'}).click();
  assert.match(await restored.locator('.ufs-diagnostic-events').innerText(),/user\.issue_marker/);
  assert.equal(errors.length,0,errors.join('\n'));
});

async function seedCopyTaskCenter(page,statuses=['success','success']) {
  await page.locator('.ufs-entry').first().waitFor();
  await page.evaluate(async statuses=>{
    const db=await new Promise((resolve,reject)=>{
      const request=indexedDB.open('ufs-copy-queue-v1',1);
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
    });
    const tasks=statuses.map((status,index)=>({
      taskId:'copy_cleanup_saved_'+index,name:'4415616 ('+(index+1)+').mp4 等 3 项',
      destination:'/mnt/user/downloads',conflictPolicy:'skip',status,
      createdAt:Date.now(),updatedAt:Date.now(),
      items:[{source:'/mnt/user/TimeMachine/notes.txt',folder:false,size:2048,
        status:status==='running'?'copying':status,
        submission:status==='success'?'confirmed':status==='queued'?'not-submitted':status==='running'?'intent-saved':'unknown'}]
    }));
    await new Promise((resolve,reject)=>{
      const tx=db.transaction('snapshots','readwrite');
      tx.objectStore('snapshots').put({key:'active',snapshot:{schema:1,savedAt:Date.now(),tasks}});
      tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
    });
    db.close();
  },statuses);
  const allowReload=dialog=>dialog.accept();
  page.once('dialog',allowReload);
  await page.reload({waitUntil:'domcontentloaded'});
  page.off('dialog',allowReload);
  await page.locator('.ufs-copy-task-trigger').waitFor();
}

async function readCopyTaskCenterSnapshot(page) {
  return page.evaluate(async()=>{
    const db=await new Promise((resolve,reject)=>{
      const request=indexedDB.open('ufs-copy-queue-v1',1);
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
    });
    const snapshot=await new Promise((resolve,reject)=>{
      const request=db.transaction('snapshots','readonly').objectStore('snapshots').get('active');
      request.onsuccess=()=>resolve(request.result?.snapshot);request.onerror=()=>reject(request.error);
    });
    db.close();return snapshot;
  });
}

test('任务中心图标在两主题、窄屏和 Unraid 按钮样式下保持对齐，清空后不再恢复',async t=>{
  const {page,errors,nativePosts}=await pageFor(t);
  await seedCopyTaskCenter(page);
  const trigger=page.locator('.ufs-copy-task-trigger');
  await page.locator('.ufs-entry').first().click();
  await trigger.click();
  const center=page.getByRole('dialog',{name:'复制任务中心'});
  const close=center.getByRole('button',{name:'关闭任务中心',exact:true});
  assert.equal(await close.evaluate(node=>document.activeElement===node),true);
  await page.addStyleTag({content:
    'button,button[type="button"]{min-width:86px;margin:10px 12px 10px 0;padding:8px;letter-spacing:1.8px;text-transform:uppercase}'
  });
  for(const dsm of [false,true]) {
    await page.locator('#ufs-app').evaluate((app,dsm)=>app.classList.toggle('ufs-dsm',dsm),dsm);
    for(const width of [1440,320]) {
      await page.setViewportSize({width,height:760});
      const layout=await center.evaluate(panel=>{
        const box=node=>node.getBoundingClientRect();
        const head=box(panel.querySelector('.ufs-task-center-head'));
        const close=panel.querySelector('.ufs-task-center-close');
        const dismiss=box(close);
        const main=box(panel.querySelector('.ufs-task-center-open'));
        const remove=box(panel.querySelector('.ufs-task-center-dismiss-record'));
        const app=box(document.querySelector('#ufs-app'));
        const bounds=box(panel);
        return {width:dismiss.width,height:dismiss.height,margin:getComputedStyle(close).margin,
          right:head.right-dismiss.right,vertical:(head.top+head.bottom-dismiss.top-dismiss.bottom)/2,
          rowVertical:(main.top+main.bottom-remove.top-remove.bottom)/2,
          inside:bounds.left>=app.left && bounds.right<=app.right,
          closeIcon:close.querySelector('svg path').getAttribute('d')};
      });
      assert.equal(layout.width,28,JSON.stringify(layout));
      assert.equal(layout.height,28,JSON.stringify(layout));
      assert.equal(layout.margin,'0px');
      assert.ok(Math.abs(layout.right-12)<=1,JSON.stringify(layout));
      assert.ok(Math.abs(layout.vertical)<=1,JSON.stringify(layout));
      assert.ok(Math.abs(layout.rowVertical)<=1,JSON.stringify(layout));
      assert.equal(layout.inside,true);
      assert.equal(layout.closeIcon,'M6 6l12 12');
    }
  }
  await page.setViewportSize({width:1440,height:900});
  await center.locator('.ufs-task-center-dismiss-record').first().focus();
  const tooltip=center.getByRole('tooltip');
  await tooltip.waitFor();
  assert.match(await tooltip.innerText(),/移除记录，保留复制文件/);
  assert.equal(await tooltip.evaluate(tip=>{
    const bounds=tip.closest('.ufs-copy-task-center').getBoundingClientRect();
    const box=tip.getBoundingClientRect();
    return box.left>=bounds.left && box.right<=bounds.right && box.top>=bounds.top && box.bottom<=bounds.bottom;
  }),true,'行内提示不会被滚动区裁切');
  await page.keyboard.press('Escape');
  assert.equal(await center.count(),0);
  assert.equal(await page.locator('.ufs-entry.ufs-selected').count(),1,'Esc 只关闭当前任务面板');
  assert.equal(await trigger.getAttribute('aria-expanded'),'false');
  assert.equal(await trigger.evaluate(node=>document.activeElement===node),true);
  await trigger.click();
  await page.locator('.ufs-navigation').click();
  assert.equal(await center.count(),0,'外部点击关闭面板');
  await trigger.click();
  await center.locator('.ufs-task-center-dismiss-record').first().click();
  await page.waitForFunction(()=>document.querySelectorAll('.ufs-task-center-row').length===1);
  assert.equal((await readCopyTaskCenterSnapshot(page)).tasks.length,1);
  assert.match(await trigger.innerText(),/复制完成 1 项/);
  await center.locator('.ufs-task-center-clear').click();
  await trigger.waitFor({state:'hidden'});
  assert.equal((await readCopyTaskCenterSnapshot(page)).tasks.length,0);
  assert.equal(await center.count(),0);
  assert.equal(await page.locator('.ufs-list').evaluate(node=>document.activeElement===node),true);
  await page.reload({waitUntil:'domcontentloaded'});
  await page.locator('.ufs-entry').first().waitFor();
  assert.equal(await trigger.isVisible(),false);
  assert.equal(nativePosts.filter(post=>post.mode==='file').length,0);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('任务中心批量清理保留排队和待核实记录，保存失败保留成功记录',async t=>{
  const {page,errors,nativePosts}=await pageFor(t);
  await seedCopyTaskCenter(page,['success','queued','uncertain','success']);
  const trigger=page.locator('.ufs-copy-task-trigger');
  await trigger.click();
  const center=page.getByRole('dialog',{name:'复制任务中心'});
  await center.locator('.ufs-task-center-clear').click();
  await page.waitForFunction(()=>document.querySelectorAll('.ufs-task-center-row').length===2);
  assert.equal(await center.locator('[data-status="queued"]').count(),1);
  assert.equal(await center.locator('[data-status="uncertain"]').count(),1);
  assert.equal(await center.locator('.ufs-task-center-clear').isDisabled(),true);
  assert.deepEqual((await readCopyTaskCenterSnapshot(page)).tasks.map(task=>task.status),['queued','uncertain']);
  assert.equal(await center.getByRole('button',{name:'请先核实任务'}).isDisabled(),true);
  const allowReload=dialog=>dialog.accept();
  page.once('dialog',allowReload);
  await page.reload({waitUntil:'domcontentloaded'});
  page.off('dialog',allowReload);
  await trigger.waitFor();
  await trigger.click();
  assert.equal(await center.locator('.ufs-task-center-row').count(),2);
  await seedCopyTaskCenter(page);
  await trigger.click();
  await page.evaluate(()=>{
    const original=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(...args) {
      if(this.name==='snapshots') throw new Error('模拟保存失败');
      return original.apply(this,args);
    };
  });
  await center.locator('.ufs-task-center-clear').click();
  await center.getByRole('alert').waitFor();
  assert.match(await center.getByRole('alert').innerText(),/未清理任务记录/);
  assert.equal(await center.locator('.ufs-task-center-row[data-status="success"]').count(),2);
  assert.equal((await readCopyTaskCenterSnapshot(page)).tasks.length,2);
  assert.equal(await trigger.isVisible(),true);
  assert.equal(nativePosts.filter(post=>post.mode==='file').length,0);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('任务清理保留原生监控和暂停队列，状态重绘保留焦点与滚动',async t=>{
  const {page,errors,nativePosts}=await pageFor(t,{
    simulateNativeMonitor:true,extraEntries:{'/mnt/user/downloads':[['notes.txt',false]]}
  });
  const native=await mockRecoveredNativeRead(page);
  await seedCopyTaskCenter(page,['success','running',...Array(8).fill('queued')]);
  const trigger=page.locator('.ufs-copy-task-trigger');
  await trigger.getByText('原生文件操作中 · 队列暂停').waitFor();
  await trigger.click();
  const center=page.getByRole('dialog',{name:'复制任务中心'});
  await center.locator('.ufs-task-center-clear').click();
  await page.waitForFunction(()=>document.querySelectorAll('.ufs-task-center-row').length===9);
  assert.equal(await center.locator('[data-status="running"]').count(),1);
  assert.equal(await center.locator('[data-status="queued"]').count(),8);
  assert.equal(await center.getByRole('button',{name:'等待当前复制完成'}).isDisabled(),true);
  const focused=center.locator('.ufs-task-center-open').last();
  await focused.evaluate(node=>node.focus({preventScroll:true}));
  const scroll=await center.locator('.ufs-task-center-body').evaluate(body=>{
    body.scrollTop=40;return body.scrollTop;
  });
  await page.evaluate(()=>window.__ufsMonitorTest.emitFileManager({
    status:'Copying ... notes.txt\n  4,194,304 100%  91.24MB/s  0:00:00',done:1
  }));
  native.setActive(false);
  await center.locator('.ufs-task-center-row[data-status="success"]').waitFor({timeout:15000});
  assert.equal(await focused.evaluate(node=>document.activeElement===node),true);
  assert.equal(await center.locator('.ufs-task-center-body').evaluate(body=>body.scrollTop),scroll);
  assert.equal(await center.locator('.ufs-task-center-clear').isDisabled(),false);
  const snapshot=await readCopyTaskCenterSnapshot(page);
  assert.equal(snapshot.tasks.length,9);
  assert.equal(snapshot.tasks[0].items[0].status,'success');
  assert.equal(snapshot.tasks.slice(1).every(task=>task.status==='queued'),true);
  assert.equal(nativePosts.filter(post=>post.mode==='file').length,0);
  assert.equal(errors.length,0,errors.join('\n'));
  await native.dispose();
});

test('任务中心清理拒绝覆盖其他标签页的所有权和新快照',async t=>{
  for(const conflict of ['lease','snapshot']) {
    await t.test(conflict,async t=>{
      const {page,errors}=await pageFor(t);
      await seedCopyTaskCenter(page);
      await page.evaluate(async conflict=>{
        const db=await new Promise((resolve,reject)=>{
          const request=indexedDB.open('ufs-copy-queue-v1',1);
          request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
        });
        await new Promise((resolve,reject)=>{
          const tx=db.transaction(conflict==='lease'?'leases':'snapshots','readwrite');
          const store=tx.objectStore(conflict==='lease'?'leases':'snapshots');
          if(conflict==='lease') store.put({key:'dispatcher',owner:'ufs_other_page_owner',expiresAt:Date.now()+60000});
          else {
            const request=store.get('active');
            request.onsuccess=()=>{
              request.result.snapshot.tasks[0].taskId='copy_other_page_updated';
              store.put(request.result);
            };
          }
          tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
        });
        db.close();
      },conflict);
      await page.locator('.ufs-copy-task-trigger').click();
      const center=page.getByRole('dialog',{name:'复制任务中心'});
      await center.locator('.ufs-task-center-clear').click();
      await center.getByRole('alert').waitFor();
      assert.match(await center.getByRole('alert').innerText(),/未清理任务记录/);
      assert.equal(await center.locator('.ufs-task-center-row').count(),2);
      const snapshot=await readCopyTaskCenterSnapshot(page);
      assert.equal(snapshot.tasks.length,2);
      if(conflict==='snapshot') assert.equal(snapshot.tasks[0].taskId,'copy_other_page_updated');
      assert.equal(errors.length,0,errors.join('\n'));
    });
  }
});


test('v0.2.9 移动普通文件复用复制选择树，原生任务 action 9 不覆盖',async t=>{
  const {page,moved,nativePosts,errors}=await pageFor(t);
  await page.locator('.ufs-entry').filter({hasText:'notes.txt'}).first().click();
  await page.locator('.ufs-operations').click();
  await page.getByRole('menuitem',{name:'移动到…'}).click();
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit',{hasText:'开始移动'}).click();
  await page.locator('.ufs-copy-progress-panel[data-phase="success"]').waitFor({timeout:20000});
  assert.equal(moved.length,1);
  assert.equal(moved[0].source,'/mnt/user/TimeMachine/notes.txt');
  assert.equal(moved[0].destinationDir,'/mnt/user/downloads');
  assert.equal(nativePosts.filter(x=>x.mode==='file'&&x.action==='9').length,1);
  assert.equal(await page.locator('.ufs-entry').filter({hasText:'notes.txt'}).count(),0);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.10 删除单文件通过二次确认窗口执行原生 action 6',async t=>{
  const {page,deleted,nativePosts,errors}=await pageFor(t);
  await page.locator('.ufs-entry').filter({hasText:'notes.txt'}).first().click();
  await page.locator('.ufs-operations').click();
  await page.getByRole('menuitem',{name:'删除'}).click();
  await page.getByText('原生永久删除不会进入回收站。',{exact:false}).waitFor();
  await page.locator('.ufs-delete-submit').click();
  await page.locator('.ufs-create-feedback',{hasText:'永久删除完成'}).waitFor({timeout:20000});
  assert.equal(deleted.length,1);
  assert.equal(deleted[0].source,'/mnt/user/TimeMachine/notes.txt');
  assert.equal(nativePosts.filter(x=>x.mode==='file'&&x.action==='6').length,1);
  assert.equal(await page.locator('.ufs-entry').filter({hasText:'notes.txt'}).count(),0);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.10 删除文件夹必须勾选明确的不可恢复确认后方可提交',async t=>{
  const {page,deleted,errors}=await pageFor(t);
  await page.locator('.ufs-entry').filter({hasText:'Photos'}).first().click();
  await page.locator('.ufs-operations').click();
  await page.getByRole('menuitem',{name:'删除'}).click();
  assert.equal(await page.locator('.ufs-delete-submit').isDisabled(),true);
  assert.equal(deleted.length,0);
  await page.locator('.ufs-delete-acknowledge input').check();
  assert.equal(await page.locator('.ufs-delete-submit').isEnabled(),true);
  await page.locator('.ufs-delete-submit').click();
  await page.locator('.ufs-create-feedback',{hasText:'永久删除完成'}).waitFor({timeout:20000});
  assert.equal(deleted.length,1);
  assert.equal(deleted[0].folder,true);
  assert.equal(errors.length,0,errors.join('\n'));
});


async function dragRowsTo(page, source, target, hover=0){
  const from=await source.boundingBox(),to=await target.boundingBox();
  assert.ok(from && to,'拖放源与目标应当可见');
  await page.mouse.move(from.x+Math.min(45,from.width/2),from.y+from.height/2);
  await page.mouse.down();
  await page.mouse.move(from.x+75,from.y+from.height/2,{steps:4});
  await page.mouse.move(to.x+Math.min(55,to.width/2),to.y+to.height/2,{steps:12});
  if(hover)await page.waitForTimeout(hover);
  await page.mouse.up();
}

// The duplicated folder names intentionally ensure drop targets use full paths,
 // not the displayed Chinese breadcrumb labels.
const dragBreadcrumbDeep='/mnt/user/downloads/新建文件夹/新建文件夹/新建文件夹2';
const dragBreadcrumbFixture={
  '/mnt/user/downloads':[['新建文件夹',true]],
  '/mnt/user/downloads/新建文件夹':[['新建文件夹',true]],
  '/mnt/user/downloads/新建文件夹/新建文件夹':[['新建文件夹2',true]],
  [dragBreadcrumbDeep]:[['clip-a.mp4',false],['clip-b.mp4',false],['素材集',true]],
};
async function breadcrumbDragPage(t,width=1440){
  const session=await pageFor(t,{width,extraEntries:dragBreadcrumbFixture});
  await session.page.goto(base+'/Shares/Browse?dir='+encodeURIComponent(dragBreadcrumbDeep));
  await session.page.locator('.ufs-entry[data-ufs-file="'+dragBreadcrumbDeep+'/clip-a.mp4"]').waitFor();
  return session;
}

test('v0.2.12.2 多文件拖拽到地址栏上级目录，只打开移动确认且正确填入目标路径',async t=>{
  const {page,errors,nativePosts}=await breadcrumbDragPage(t);
  const first=page.locator('.ufs-entry[data-ufs-file="'+dragBreadcrumbDeep+'/clip-a.mp4"]');
  const second=page.locator('.ufs-entry[data-ufs-file="'+dragBreadcrumbDeep+'/clip-b.mp4"]');
  await first.click();
  await second.click({modifiers:['Control']});
  assert.equal(await page.locator('.ufs-entry.ufs-selected').count(),2);
  const dest='/mnt/user/downloads';
  const crumb=page.locator('.ufs-address .ufs-crumb[data-ufs-drop-path="'+dest+'"]');
  await crumb.waitFor();
  await dragRowsTo(page,first,crumb);
  const dialog=page.getByRole('dialog',{name:'移动到'});
  await dialog.waitFor();
  await page.locator('.ufs-copy-destination',{hasText:'目标：'+dest}).waitFor();
  assert.match(await dialog.innerText(),/已选择 2 项/);
  assert.equal(await page.locator('.ufs-crumb-more').count(),0,'宽屏不应强制折叠路径');
  assert.equal(nativePosts.filter(post=>post.mode==='file').length,0,'松开鼠标不执行原生 Move');
  await dialog.getByRole('button',{name:'取消'}).click();
  assert.equal(nativePosts.filter(post=>post.mode==='file').length,0);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.12.2 地址栏根分组和当前目录均显示禁止拖入，不弹窗不写入',async t=>{
  const {page,errors,nativePosts}=await breadcrumbDragPage(t);
  const from=page.locator('.ufs-entry[data-ufs-file="'+dragBreadcrumbDeep+'/素材集"]');
  const root=page.locator('.ufs-address .ufs-crumb[data-ufs-drop-path="/mnt/user"]');
  await dragRowsTo(page,from,root);
  assert.equal(await page.locator('.ufs-copy-dialog').count(),0);
  const current=page.locator('.ufs-address .ufs-crumb[data-ufs-drop-path="'+dragBreadcrumbDeep+'"]');
  await dragRowsTo(page,from,current);
  assert.equal(await page.locator('.ufs-copy-dialog').count(),0);
  assert.equal(nativePosts.filter(post=>post.mode==='file').length,0);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.12.2 拖动到省略号等待展开，在菜单项释放后预选被隐藏的真实路径',async t=>{
  const {page,errors,nativePosts}=await breadcrumbDragPage(t,760);
  const more=page.locator('.ufs-address .ufs-crumb-more');
  await more.waitFor();
  const from=page.locator('.ufs-entry[data-ufs-file="'+dragBreadcrumbDeep+'/clip-a.mp4"]');
  const a=await from.boundingBox(),b=await more.boundingBox();
  assert.ok(a&&b);
  await page.mouse.move(a.x+40,a.y+a.height/2);await page.mouse.down();
  await page.mouse.move(a.x+85,a.y+a.height/2,{steps:4});
  await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:12});
  await page.locator('.ufs-crumb-more.ufs-drop-expand').waitFor();
  const popup=page.locator('.ufs-menu[data-ufs-breadcrumb-menu]');
  await popup.waitFor({timeout:5000});
  const hidden=popup.locator('button[data-ufs-drop-path="/mnt/user/downloads"]');
  await hidden.waitFor();
  const destBox=await hidden.boundingBox();
  assert.ok(destBox,'隐藏目录菜单中的实际目标可见');
  await page.mouse.move(destBox.x+Math.min(35,destBox.width/2),
    destBox.y+destBox.height/2,{steps:10});
  await page.locator('.ufs-menu[data-ufs-breadcrumb-menu] button.ufs-drop-valid[data-ufs-drop-path="/mnt/user/downloads"]').waitFor();
  await page.mouse.up();
  const dialog=page.getByRole('dialog',{name:'移动到'});
  await dialog.waitFor();
  await page.locator('.ufs-copy-destination',{hasText:'目标：/mnt/user/downloads'}).waitFor();
  assert.equal(await popup.count(),0,'完成拖放后收起省略号菜单');
  assert.equal(nativePosts.filter(post=>post.mode==='file').length,0);
  await dialog.getByRole('button',{name:'取消'}).click();
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.12.2 在省略号或地址栏分隔箭头直接松开不触发移动',async t=>{
  const {page,errors,nativePosts}=await breadcrumbDragPage(t,760);
  const more=page.locator('.ufs-address .ufs-crumb-more');
  await more.waitFor();
  const from=page.locator('.ufs-entry[data-ufs-file="'+dragBreadcrumbDeep+'/clip-a.mp4"]');
  await dragRowsTo(page,from,more);
  assert.equal(await page.locator('.ufs-copy-dialog').count(),0);
  const arrow=page.locator('.ufs-address > .ufs-svg').first();
  await dragRowsTo(page,from,arrow);
  assert.equal(await page.locator('.ufs-copy-dialog').count(),0);
  assert.equal(nativePosts.filter(post=>post.mode==='file').length,0);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.11 拖动多个选中项目到左侧 Share：仅预选目标，不直接提交写入',async t=>{
  const {page,errors,nativePosts,moved}=await pageFor(t);
  await page.locator('.ufs-entry[data-ufs-file="/mnt/user/TimeMachine/notes.txt"]').waitFor();
  await page.locator('.ufs-entry[data-ufs-file="/mnt/user/TimeMachine/notes.txt"]').click();
  await page.locator('.ufs-entry[data-ufs-file="/mnt/user/TimeMachine/Photos"]').click({modifiers:['Control']});
  assert.equal(await page.locator('.ufs-entry.ufs-selected').count(),2);
  const from=page.locator('.ufs-entry[data-ufs-file="/mnt/user/TimeMachine/notes.txt"]');
  const target=page.locator('.ufs-tree-row[data-ufs-drop-path="/mnt/user/downloads"]');
  await dragRowsTo(page,from,target);
  const dialog=page.getByRole('dialog',{name:'移动到'});
  await dialog.waitFor();
  await page.getByRole('button',{name:'选择 downloads'}).waitFor();
  await page.locator('.ufs-copy-tree-row.ufs-copy-selected').filter({hasText:'downloads'}).waitFor();
  assert.equal(await page.locator('.ufs-copy-destination').innerText(),'目标：/mnt/user/downloads');
  assert.match(await dialog.innerText(),/已选择 2 项/);
  assert.equal(nativePosts.filter(item=>item.mode==='file').length,0);
  await dialog.locator('.ufs-copy-submit',{hasText:'开始移动'}).click();
  const timeout=Date.now()+30000;
  while(moved.length<2 && Date.now()<timeout)
    await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(moved.length,2);
  const nativeMovePosts=nativePosts.filter(item=>item.mode==='file'&&['4','9'].includes(item.action));
  assert.equal(nativeMovePosts.length,1,'一个文件夹加一个文件应合并为一次原生 Move');
  assert.equal(nativeMovePosts[0].action,'9');
  assert.equal(decodeURIComponent(nativeMovePosts[0].source).split('\r').length,2);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.11 拖到右侧文件夹后预选目标；取消不产生移动请求',async t=>{
  const {page,errors,nativePosts}=await pageFor(t);
  const from=page.locator('.ufs-entry[data-ufs-file="/mnt/user/TimeMachine/notes.txt"]');
  const target=page.locator('.ufs-entry[data-ufs-drop-path="/mnt/user/TimeMachine/Photos"]');
  await from.waitFor();await target.waitFor();
  await dragRowsTo(page,from,target);
  const dialog=page.getByRole('dialog',{name:'移动到'});
  await dialog.waitFor();
  await page.locator('.ufs-copy-destination',{hasText:'/mnt/user/TimeMachine/Photos'}).waitFor();
  assert.equal(nativePosts.filter(item=>item.mode==='file').length,0);
  await dialog.getByRole('button',{name:'取消'}).click();
  assert.equal(await dialog.count(),0);
  assert.equal(nativePosts.filter(item=>item.mode==='file').length,0);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.11 文件夹拖到自身或共享根目录时禁止移动，普通点击和多选仍正常',async t=>{
  const {page,errors,nativePosts}=await pageFor(t);
  const photo=page.locator('.ufs-entry[data-ufs-file="/mnt/user/TimeMachine/Photos"]');
  await photo.waitFor();
  await dragRowsTo(page,photo,page.locator('.ufs-tree-row[data-ufs-drop-path="/mnt/user"]'));
  assert.equal(await page.locator('.ufs-copy-dialog').count(),0);
  await dragRowsTo(page,photo,photo);
  assert.equal(await page.locator('.ufs-copy-dialog').count(),0);
  await page.locator('.ufs-entry[data-ufs-file="/mnt/user/TimeMachine/notes.txt"]').click();
  await photo.click({modifiers:['Control']});
  assert.equal(await page.locator('.ufs-entry.ufs-selected').count(),2);
  assert.equal(nativePosts.filter(item=>item.mode==='file').length,0);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.11 拖动悬停 700ms 自动展开左侧目录树',async t=>{
  const {page,errors,nativePosts}=await pageFor(t);
  const from=page.locator('.ufs-entry[data-ufs-file="/mnt/user/TimeMachine/notes.txt"]');
  const dest=page.locator('.ufs-tree-row[data-ufs-drop-path="/mnt/user/downloads"]');
  await from.waitFor();await dest.waitFor();
  const a=await from.boundingBox(),b=await dest.boundingBox();
  await page.mouse.move(a.x+45,a.y+a.height/2);await page.mouse.down();
  await page.mouse.move(a.x+85,a.y+a.height/2,{steps:4});
  await page.mouse.move(b.x+50,b.y+b.height/2,{steps:10});
  await page.locator('.ufs-tree-row.ufs-drop-valid[data-ufs-drop-path="/mnt/user/downloads"]').waitFor();
  await page.locator('.ufs-tree-row[data-ufs-drop-path="/mnt/user/downloads/completed"]').waitFor({timeout:5000});
  await page.mouse.up();
  await page.getByRole('dialog',{name:'移动到'}).waitFor();
  assert.equal(nativePosts.filter(item=>item.mode==='file').length,0);
  assert.equal(errors.length,0,errors.join('\n'));
});


test('v0.2.11.4 连续拖放到目录树不会产生闪退或自动写入',async t=>{
  const {page,errors,nativePosts}=await pageFor(t);
  const source=page.locator('.ufs-entry[data-ufs-file="/mnt/user/TimeMachine/notes.txt"]');
  const target=page.locator('.ufs-tree-row[data-ufs-drop-path="/mnt/user/downloads"]');
  await source.waitFor();await target.waitFor();
  for(let i=0;i<3;i++){
    await dragRowsTo(page,source,target);
    const modal=page.getByRole('dialog',{name:'移动到'});
    await modal.waitFor();
    await page.waitForTimeout(200);
    assert.equal(await modal.isVisible(),true,'拖拽后弹窗不得闪退');
    await page.locator('.ufs-copy-destination',{hasText:'/mnt/user/downloads'}).waitFor();
    assert.equal(nativePosts.filter(post=>post.mode==='file').length,0);
    await modal.getByRole('button',{name:'取消'}).click();
    await modal.waitFor({state:'detached'});
  }
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.11.4 拖放后合成 click 无法关闭弹窗，仅真实遮罩指针操作可以关闭',async t=>{
  const {page,errors,nativePosts}=await pageFor(t);
  const source=page.locator('.ufs-entry[data-ufs-file="/mnt/user/TimeMachine/notes.txt"]');
  const target=page.locator('.ufs-tree-row[data-ufs-drop-path="/mnt/user/downloads"]');
  await source.waitFor();await target.waitFor();
  await dragRowsTo(page,source,target);
  const modal=page.getByRole('dialog',{name:'移动到'});
  await modal.waitFor();
  await page.locator('.ufs-dialog-overlay').evaluate(el=>el.dispatchEvent(
    new MouseEvent('click',{bubbles:true,cancelable:true})));
  assert.equal(await modal.isVisible(),true,'点击事件不应被当作完整遮罩指针动作');
  const backdrop=await page.locator('.ufs-dialog-overlay').boundingBox();
  assert.ok(backdrop);
  await page.mouse.click(backdrop.x+5,backdrop.y+5);
  await modal.waitFor({state:'detached'});
  assert.equal(nativePosts.filter(post=>post.mode==='file').length,0);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.11.4 目标读取较慢时显示确认中并拦截过早提交',async t=>{
  const {page,errors,nativePosts}=await pageFor(t,{delayDownloads:1000});
  const source=page.locator('.ufs-entry[data-ufs-file="/mnt/user/TimeMachine/notes.txt"]');
  const target=page.locator('.ufs-tree-row[data-ufs-drop-path="/mnt/user/downloads"]');
  await source.waitFor();await target.waitFor();
  await dragRowsTo(page,source,target);
  const modal=page.getByRole('dialog',{name:'移动到'});
  await modal.waitFor();
  const submit=modal.locator('.ufs-copy-submit');
  assert.equal(await submit.isDisabled(),true);
  assert.match(await submit.innerText(),/正在确认目标/);
  assert.match(await modal.innerText(),/正在确认拖放目标/);
  // Simulate a keyboard-originated submit while the button is unavailable.
  await modal.locator('form').evaluate(form=>form.dispatchEvent(
    new Event('submit',{bubbles:true,cancelable:true})));
  assert.equal(nativePosts.filter(post=>post.mode==='file').length,0);
  await page.locator('.ufs-copy-destination',{hasText:'/mnt/user/downloads'}).waitFor();
  await page.waitForFunction(()=>{
    const button=document.querySelector('.ufs-copy-dialog .ufs-copy-submit');
    return button && !button.disabled && button.textContent.includes('开始移动');
  },{timeout:10000});
  assert.equal(await modal.isVisible(),true);
  assert.equal(nativePosts.filter(post=>post.mode==='file').length,0);
  await modal.getByRole('button',{name:'取消'}).click();
  assert.equal(errors.length,0,errors.join('\n'));
});


test('v0.2.11.5 租约冲突时移动弹窗稳定，导出 AI 诊断证据，解锁后可提交',async t=>{
  const {page,errors,nativePosts,moved}=await pageFor(t);
  await page.locator('.ufs-entry').filter({hasText:'notes.txt'}).first().waitFor();
  await page.evaluate(async()=>{
    const db=await new Promise((resolve,reject)=>{
      const r=indexedDB.open('ufs-copy-queue-v1',1);
      r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
    });
    await new Promise((resolve,reject)=>{
      const tx=db.transaction('leases','readwrite');
      tx.objectStore('leases').put({
        key:'dispatcher',owner:'ufs_expired_tab_simulation',expiresAt:Date.now()+25000
      });
      tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
    });
    db.close();
  });
  await page.locator('.ufs-entry').filter({hasText:'notes.txt'}).first().click();
  await page.locator('.ufs-operations').click();
  await page.getByRole('menuitem',{name:'移动到…'}).click();
  let dialog=page.getByRole('dialog',{name:'移动到'});
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await dialog.locator('.ufs-copy-submit',{hasText:'开始移动'}).click();
  await dialog.locator('.ufs-create-feedback',{hasText:'租约占用'}).waitFor({timeout:8000});
  assert.equal(await dialog.isVisible(),true);
  assert.equal(await dialog.locator('.ufs-copy-submit').isVisible(),true);
  assert.equal(await dialog.locator('.ufs-batch-panel').count(),0);
  assert.equal(nativePosts.filter(post=>post.mode==='file').length,0);
  // Modal intentionally blocks underlying toolbar buttons. Dismiss first,
  // then export diagnostics without confusing a valid backdrop interception.
  await dialog.getByRole('button',{name:'取消'}).click();
  await dialog.waitFor({state:'detached'});
  await page.locator('.ufs-diagnostic-button').click();
  const diag=page.getByRole('dialog',{name:'File Station 诊断中心'});
  const pending=page.waitForEvent('download');
  await diag.getByRole('button',{name:'导出 JSON'}).click();
  const file=await pending;
  const report=JSON.parse(readFileSync(await file.path(),'utf8'));
  assert.equal(report.triage.schemaVersion,1);
  assert.equal(report.triage.issues.some(i=>i.code==='QUEUE_LEASE_DENIED'),true);
  assert.equal(report.triage.timeline.some(i=>i.code==='queue.lease_denied'),true);
  assert.equal(JSON.stringify(report).includes('ufs_expired_tab_simulation'),false);
  await diag.locator('.ufs-diagnostic-head button').click();
  await page.evaluate(async()=>{
    const db=await new Promise((resolve,reject)=>{
      const r=indexedDB.open('ufs-copy-queue-v1',1);
      r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
    });
    await new Promise((resolve,reject)=>{
      const tx=db.transaction('leases','readwrite');
      tx.objectStore('leases').delete('dispatcher');
      tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
    });
    db.close();
  });
  await page.locator('.ufs-operations').click();
  await page.getByRole('menuitem',{name:'移动到…'}).click();
  dialog=page.getByRole('dialog',{name:'移动到'});
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await dialog.locator('.ufs-copy-submit',{hasText:'开始移动'}).click();
  await dialog.locator('.ufs-copy-progress-panel[data-phase="success"]').waitFor({timeout:25000});
  assert.equal(moved.length,1);
  // Completed writes must relinquish their lease, rather than renewing forever.
  await page.waitForFunction(async()=>{
    const db=await new Promise((resolve,reject)=>{
      const r=indexedDB.open('ufs-copy-queue-v1',1);
      r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
    });
    const lease=await new Promise((resolve,reject)=>{
      const r=db.transaction('leases','readonly').objectStore('leases').get('dispatcher');
      r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
    });
    db.close();return !lease;
  },null,{timeout:12000});
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.11.5 快照变化时拒绝覆盖，保留原记录且不向 NAS 发请求',async t=>{
  const {page,errors,nativePosts}=await pageFor(t);
  await page.locator('.ufs-entry').filter({hasText:'notes.txt'}).first().waitFor();
  await page.evaluate(async()=>{
    const db=await new Promise((resolve,reject)=>{
      const r=indexedDB.open('ufs-copy-queue-v1',1);
      r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
    });
    await new Promise((resolve,reject)=>{
      const tx=db.transaction('snapshots','readwrite');
      const now=Date.now();
      tx.objectStore('snapshots').put({key:'active',snapshot:{
        schema:1,savedAt:now,tasks:[{
          taskId:'copy_external_terminal',name:'外部历史任务',
          destination:'/mnt/user/downloads',conflictPolicy:'skip',status:'success',
          createdAt:now,updatedAt:now,
          items:[{source:'/mnt/user/TimeMachine/notes.txt',folder:false,size:2048,
            status:'success',submission:'confirmed',updatedAt:now}]
        }]
      }});
      tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
    });
    db.close();
  });
  await page.locator('.ufs-entry').filter({hasText:'notes.txt'}).first().click();
  await page.locator('.ufs-operations').click();
  await page.getByRole('menuitem',{name:'移动到…'}).click();
  const dialog=page.getByRole('dialog',{name:'移动到'});
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await dialog.locator('.ufs-copy-submit',{hasText:'开始移动'}).click();
  await dialog.locator('.ufs-create-feedback',{hasText:'队列记录已变更'}).waitFor({timeout:8000});
  const snapshot=await readCopyTaskCenterSnapshot(page);
  assert.equal(snapshot.tasks.length,1);
  assert.equal(snapshot.tasks[0].taskId,'copy_external_terminal');
  assert.equal(nativePosts.filter(post=>post.mode==='file').length,0);
  assert.equal(await dialog.isVisible(),true);
  assert.equal(errors.length,0,errors.join('\n'));
});


test('v0.2.11.5 删除被旧租约拦截时保留确认状态、无原生写入，解除后才能执行',async t=>{
  const {page,deleted,nativePosts,errors}=await pageFor(t);
  await page.locator('.ufs-entry').filter({hasText:'notes.txt'}).first().waitFor();
  await page.evaluate(async()=>{
    const db=await new Promise((resolve,reject)=>{
      const req=indexedDB.open('ufs-copy-queue-v1',1);
      req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
    });
    await new Promise((resolve,reject)=>{
      const tx=db.transaction('leases','readwrite');
      tx.objectStore('leases').put({
        key:'dispatcher',owner:'ufs_foreign_delete_lock',expiresAt:Date.now()+20000
      });
      tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
    });
    db.close();
  });
  await page.locator('.ufs-entry').filter({hasText:'notes.txt'}).first().click();
  await page.locator('.ufs-operations').click();
  await page.getByRole('menuitem',{name:'删除'}).click();
  const overlay=page.locator('.ufs-dialog-overlay');
  await overlay.locator('.ufs-delete-submit').click();
  await overlay.locator('.ufs-create-feedback',{hasText:'未提交删除'}).waitFor({timeout:8000});
  assert.equal(await overlay.locator('.ufs-delete-submit').isVisible(),true);
  assert.equal(await overlay.locator('.ufs-delete-submit').isEnabled(),true);
  assert.equal(deleted.length,0);
  assert.equal(nativePosts.filter(post=>post.mode==='file').length,0);
  await page.evaluate(async()=>{
    const db=await new Promise((resolve,reject)=>{
      const req=indexedDB.open('ufs-copy-queue-v1',1);
      req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
    });
    await new Promise((resolve,reject)=>{
      const tx=db.transaction('leases','readwrite');
      tx.objectStore('leases').delete('dispatcher');
      tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
    });
    db.close();
  });
  await overlay.locator('.ufs-delete-submit').click();
  await overlay.locator('.ufs-create-feedback',{hasText:'永久删除完成'}).waitFor({timeout:20000});
  assert.equal(deleted.length,1);
  assert.equal(errors.length,0,errors.join('\n'));
});


test('v0.2.11.6 移动完成诊断提供可归因的分段耗时，不重复提交',async t=>{
  const {page,moved,nativePosts,errors}=await pageFor(t);
  await page.locator('.ufs-entry').filter({hasText:'notes.txt'}).first().waitFor();
  await page.locator('.ufs-entry').filter({hasText:'notes.txt'}).first().click();
  await page.locator('.ufs-operations').click();
  await page.getByRole('menuitem',{name:'移动到…'}).click();
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit',{hasText:'开始移动'}).click();
  await page.locator('.ufs-copy-progress-panel[data-phase="success"]').waitFor({timeout:20000});
  await page.locator('.ufs-copy-submit',{hasText:'完成'}).click();
  await page.locator('.ufs-diagnostic-button').click();
  const center=page.getByRole('dialog',{name:'File Station 诊断中心'});
  const pending=page.waitForEvent('download');
  await center.getByRole('button',{name:'导出 JSON'}).click();
  const file=await pending;
  const report=JSON.parse(readFileSync(await file.path(),'utf8'));
  const installedVersion=readFileSync(new URL('../../src/unraid-file-station.user.js',import.meta.url),'utf8')
    .match(/^\/\/ @version\s+(\S+)/m)?.[1];
  assert.ok(installedVersion,'用户脚本必须声明 @version');
  assert.equal(report.version,installedVersion);
  const moves=report.events.filter(e=>e.code==='move.verified');
  assert.equal(moves.length,1);
  const details=moves[0].details;
  for(const key of ['requestMs','monitorMs','verifyMs','totalMs','polls'])
    assert.ok(Number.isFinite(details[key]) && details[key]>=0,key);
  assert.ok(details.polls>=2);
  assert.equal(typeof details.observedOwnTask,'boolean');
  assert.equal(typeof details.observedDone,'boolean');
  assert.equal(moved.length,1);
  assert.equal(nativePosts.filter(x=>x.mode==='file'&&x.action==='9').length,1);
  assert.equal(errors.length,0,errors.join('\n'));
});


test('v0.2.11.7 同目录两普通文件一次原生批量 Move，所有项目成功且导出诊断',async t=>{
  const {page,errors,nativePosts,moved}=await pageFor(t,{
    extraEntries:{'/mnt/user/TimeMachine':[['another.mkv',false]]}
  });
  await page.locator('.ufs-entry').filter({hasText:'notes.txt'}).first().waitFor();
  await page.locator('.ufs-entry[data-ufs-file="/mnt/user/TimeMachine/notes.txt"]').click();
  await page.locator('.ufs-entry[data-ufs-file="/mnt/user/TimeMachine/another.mkv"]')
    .click({modifiers:['Control']});
  await page.locator('.ufs-operations').click();
  await page.getByRole('menuitem',{name:'移动到…'}).click();
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit',{hasText:'开始移动'}).click();
  await page.locator('.ufs-copy-submit',{hasText:'完成'}).waitFor({timeout:25000});
  const writes=nativePosts.filter(x=>x.mode==='file');
  assert.equal(writes.length,1,'多个文件应只有一次 POST');
  assert.equal(writes[0].action,'9');
  assert.equal(writes[0].exist,'');
  assert.equal(decodeURIComponent(writes[0].source).split('\r').length,2);
  assert.equal(moved.length,2);
  assert.equal(await page.locator('.ufs-batch-percent').innerText(),'100%');
  await page.locator('.ufs-batch-open-list').last().click();
  assert.equal(await page.locator('.ufs-batch-list-row[data-status="success"]').count(),2);
  await page.locator('.ufs-batch-list-back').click();
  await page.locator('.ufs-copy-submit',{hasText:'完成'}).click();
  await page.locator('.ufs-diagnostic-button').click();
  const pending=page.waitForEvent('download');
  await page.getByRole('dialog',{name:'File Station 诊断中心'})
    .getByRole('button',{name:'导出 JSON'}).click();
  const dl=await pending,diagnostic=JSON.parse(readFileSync(await dl.path(),'utf8'));
  const audit=diagnostic.events.filter(e=>e.code==='move.batch_verified');
  assert.equal(audit.length,1);
  assert.equal(audit[0].details.count,2);
  assert.equal(audit[0].details.strategy,'native-cr-source');
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.11.8 单文件夹+普通文件混合选择仅一次原生移动',async t=>{
  const {page,nativePosts,moved,errors}=await pageFor(t);
  await page.locator('.ufs-entry').filter({hasText:'notes.txt'}).first().waitFor();
  await page.locator('.ufs-entry[data-ufs-file="/mnt/user/TimeMachine/notes.txt"]').click();
  await page.locator('.ufs-entry[data-ufs-file="/mnt/user/TimeMachine/Photos"]')
    .click({modifiers:['Control']});
  await page.locator('.ufs-operations').click();
  await page.getByRole('menuitem',{name:'移动到…'}).click();
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit',{hasText:'开始移动'}).click();
  await page.locator('.ufs-copy-submit',{hasText:'完成'}).waitFor({timeout:25000});
  const native=nativePosts.filter(x=>x.mode==='file');
  assert.equal(native.length,1,'同父目录一个文件夹和一个文件只需一次请求');
  assert.equal(native[0].action,'9');
  assert.equal(decodeURIComponent(native[0].source).split('\r').length,2);
  assert.equal(moved.length,2);
  assert.equal(moved.find(x=>x.name==='Photos')?.folder,true);
  assert.equal(moved.find(x=>x.name==='notes.txt')?.folder,false);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.11.7 原生批量移动目标少文件，整批待核实且不能串行重发',async t=>{
  const {page,nativePosts,errors}=await pageFor(t,{
    extraEntries:{'/mnt/user/TimeMachine':[['another.mkv',false]]},
    partialNativeMove:true
  });
  await page.locator('.ufs-entry').filter({hasText:'notes.txt'}).first().click();
  await page.locator('.ufs-entry[data-ufs-file="/mnt/user/TimeMachine/another.mkv"]')
    .click({modifiers:['Control']});
  await page.locator('.ufs-operations').click();
  await page.getByRole('menuitem',{name:'移动到…'}).click();
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit',{hasText:'开始移动'}).click();
  await page.locator('.ufs-copy-submit',{hasText:'完成'}).waitFor({timeout:25000});
  const native=nativePosts.filter(x=>x.mode==='file');
  assert.equal(native.length,1);
  assert.equal(native[0].action,'9');
  await page.locator('.ufs-batch-open-list').last().click();
  assert.equal(await page.locator('.ufs-batch-list-row[data-status="uncertain"]').count(),2);
  assert.equal(errors.length,0,errors.join('\n'));
});


test('v0.2.11.7 F5 恢复不重发原生批量：整批意图持久化且必须手动核实',async t=>{
  const {page,nativePosts,errors}=await pageFor(t,{
    extraEntries:{'/mnt/user/TimeMachine':[['another.mkv',false]]},
    nativeMutationHoldReads:12
  });
  await page.locator('.ufs-entry').filter({hasText:'notes.txt'}).first().waitFor();
  await page.locator('.ufs-entry[data-ufs-file="/mnt/user/TimeMachine/notes.txt"]').click();
  await page.locator('.ufs-entry[data-ufs-file="/mnt/user/TimeMachine/another.mkv"]')
    .click({modifiers:['Control']});
  await page.locator('.ufs-operations').click();
  await page.getByRole('menuitem',{name:'移动到…'}).click();
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit',{hasText:'开始移动'}).click();
  await page.waitForFunction(()=>document.querySelector('.ufs-batch-panel')?.dataset.phase==='copying',
    null,{timeout:10000});
  await page.waitForFunction(async()=>{
    const db=await new Promise((resolve,reject)=>{
      const req=indexedDB.open('ufs-copy-queue-v1',1);
      req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
    });
    const tx=db.transaction('snapshots','readonly');
    const saved=await new Promise((resolve,reject)=>{
      const req=tx.objectStore('snapshots').get('active');
      req.onsuccess=()=>resolve(req.result?.snapshot);req.onerror=()=>reject(req.error);
    });
    db.close();
    return saved?.tasks?.[0]?.batchMode==='native-move-files' &&
      saved.tasks[0].items.length===2 &&
      saved.tasks[0].items.every(item=>item.submission==='intent-saved');
  },null,{timeout:10000});
  // Intent is durably committed BEFORE the native POST. Do not assert the
  // write synchronously at that checkpoint; wait until the request exists.
  for(let i=0;i<100 && !nativePosts.some(x=>x.mode==='file'&&x.action==='9');i++)
    await page.waitForTimeout(30);
  assert.equal(nativePosts.filter(x=>x.mode==='file'&&x.action==='9').length,1);
  await page.reload();
  await page.locator('.ufs-copy-task-trigger').first().waitFor({timeout:10000});
  await page.waitForTimeout(2400);
  assert.equal(nativePosts.filter(x=>x.mode==='file'&&x.action==='9').length,1,
    'F5 必须只连接观察，不能重新提交批量 Move');
  await page.locator('.ufs-copy-task-trigger').first().click();
  assert.ok(await page.locator('.ufs-task-recovery').count()>=1,
    '不确定的原生批次必须保留手动恢复入口');
  assert.equal(errors.length,0,errors.join('\n'));
});


test('v0.2.11.8 多文件夹混合选择保持串行，日志明确标注回退原因',async t=>{
  const {page,errors,nativePosts,moved}=await pageFor(t,{
    extraEntries:{'/mnt/user/TimeMachine':[['Archive',true]]}
  });
  await page.locator('.ufs-entry[data-ufs-file="/mnt/user/TimeMachine/Photos"]').waitFor();
  for(const [i,name] of ['Photos','Archive','notes.txt'].entries()) {
    await page.locator('.ufs-entry[data-ufs-file="/mnt/user/TimeMachine/'+name+'"]')
      .click(i?{modifiers:['ControlOrMeta']}:{});
  }
  await page.locator('.ufs-operations').click();
  await page.getByRole('menuitem',{name:'移动到…'}).click();
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit',{hasText:'开始移动'}).click();
  await page.locator('.ufs-copy-submit',{hasText:'完成'}).waitFor({timeout:30000});
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,3);
  assert.deepEqual(nativePosts.filter(x=>x.mode==='file').map(x=>x.action).sort(),['4','4','9']);
  assert.equal(moved.length,3);
  await page.locator('.ufs-copy-submit',{hasText:'完成'}).click();
  await page.locator('.ufs-diagnostic-button').click();
  const download=page.waitForEvent('download');
  await page.getByRole('dialog',{name:'File Station 诊断中心'})
    .getByRole('button',{name:'导出 JSON'}).click();
  const file=await download;
  const report=JSON.parse(readFileSync(await file.path(),'utf8'));
  const strategies=report.events.filter(e=>e.code==='move.batch_strategy');
  assert.equal(strategies.at(-1)?.details.reason,'multiple-directories');
  assert.equal(strategies.at(-1)?.details.strategy,'serial');
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.11.8 混合原生移动完成事件与逐项校验不重复提交',async t=>{
  const {page,errors,nativePosts,moved}=await pageFor(t,{
    extraEntries:{'/mnt/user/TimeMachine':[['another.mkv',false]]}
  });
  await page.locator('.ufs-entry[data-ufs-file="/mnt/user/TimeMachine/Photos"]').waitFor();
  for(const [i,name] of ['Photos','notes.txt','another.mkv'].entries()) {
    await page.locator('.ufs-entry[data-ufs-file="/mnt/user/TimeMachine/'+name+'"]')
      .click(i?{modifiers:['ControlOrMeta']}:{});
  }
  await page.locator('.ufs-operations').click();
  await page.getByRole('menuitem',{name:'移动到…'}).click();
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit',{hasText:'开始移动'}).click();
  await page.locator('.ufs-copy-submit',{hasText:'完成'}).waitFor({timeout:30000});
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,1);
  assert.equal(moved.length,3);
  assert.equal(moved.filter(x=>x.folder).length,1);
  assert.equal(await page.locator('.ufs-batch-percent').innerText(),'100%');
  await page.locator('.ufs-copy-submit',{hasText:'完成'}).click();
  await page.locator('.ufs-diagnostic-button').click();
  const dl=page.waitForEvent('download');
  await page.getByRole('dialog',{name:'File Station 诊断中心'})
    .getByRole('button',{name:'导出 JSON'}).click();
  const file=await dl,report=JSON.parse(readFileSync(await file.path(),'utf8'));
  const event=report.events.find(e=>e.code==='move.batch_verified');
  assert.equal(event?.details.batchMode,'native-move-mixed');
  assert.equal(event?.details.folderCount,1);
  assert.equal(event?.details.folderVerification,'top-level-only');
  assert.equal(errors.length,0,errors.join('\n'));
});


test('v0.2.11.8 F5 处理中断的混合批量只读恢复，不自动重复 POST',async t=>{
  const {page,nativePosts,errors}=await pageFor(t,{
    nativeMutationHoldReads:14
  });
  await page.locator('.ufs-entry[data-ufs-file="/mnt/user/TimeMachine/Photos"]').waitFor();
  for(const [i,name] of ['Photos','notes.txt'].entries()) {
    await page.locator('.ufs-entry[data-ufs-file="/mnt/user/TimeMachine/'+name+'"]')
      .click(i?{modifiers:['ControlOrMeta']}:{});
  }
  await page.locator('.ufs-operations').click();
  await page.getByRole('menuitem',{name:'移动到…'}).click();
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit',{hasText:'开始移动'}).click();
  await page.waitForFunction(async()=>{
    const db=await new Promise((resolve,reject)=>{
      const r=indexedDB.open('ufs-copy-queue-v1',1);
      r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
    });
    const tx=db.transaction('snapshots','readonly');
    const snap=await new Promise((resolve,reject)=>{
      const r=tx.objectStore('snapshots').get('active');
      r.onsuccess=()=>resolve(r.result?.snapshot);r.onerror=()=>reject(r.error);
    });
    db.close();
    return snap?.tasks?.[0]?.batchMode==='native-move-mixed' &&
      snap.tasks[0].items.length===2 &&
      snap.tasks[0].items.some(item=>item.folder) &&
      snap.tasks[0].items.every(item=>item.submission==='intent-saved');
  },null,{timeout:10000});
  for(let i=0;i<110 && !nativePosts.some(x=>x.mode==='file'&&x.action==='9');i++)
    await page.waitForTimeout(30);
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,1);
  await page.reload();
  await page.locator('.ufs-copy-task-trigger').first().waitFor({timeout:10000});
  await page.waitForTimeout(2300);
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,1,
    'F5 后只能监控原生混合任务，不得再次 POST');
  await page.locator('.ufs-copy-task-trigger').first().click();
  assert.ok(await page.locator('.ufs-task-recovery').count()>=1);
  assert.equal(errors.length,0,errors.join('\n'));
});

test('v0.2.11.8 空文件夹与普通文件混合完成时仅声明顶层核验',async t=>{
  const {page,nativePosts,moved,errors}=await pageFor(t,{
    extraEntries:{'/mnt/user/TimeMachine':[['EmptyFolder',true]]}
  });
  await page.locator('.ufs-entry[data-ufs-file="/mnt/user/TimeMachine/EmptyFolder"]').waitFor();
  for(const [i,name] of ['EmptyFolder','notes.txt'].entries()){
    await page.locator('.ufs-entry[data-ufs-file="/mnt/user/TimeMachine/'+name+'"]')
      .click(i?{modifiers:['ControlOrMeta']}:{});
  }
  await page.locator('.ufs-operations').click();
  await page.getByRole('menuitem',{name:'移动到…'}).click();
  await page.getByRole('button',{name:'选择 downloads'}).click();
  await page.locator('.ufs-copy-submit',{hasText:'开始移动'}).click();
  await page.locator('.ufs-copy-submit',{hasText:'完成'}).waitFor({timeout:30000});
  assert.equal(nativePosts.filter(x=>x.mode==='file').length,1);
  assert.equal(moved.length,2);
  assert.equal(moved.find(x=>x.name==='EmptyFolder')?.folder,true);
  assert.match(await page.locator('.ufs-batch-panel > .ufs-batch-warning').innerText(),
    /文件夹内部内容并未递归校验/);
  assert.equal(errors.length,0,errors.join('\n'));
});
