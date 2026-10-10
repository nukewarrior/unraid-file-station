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
const esc = text => String(text).replace(/[&<>"']/g, ch =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

function responseFor(path) {
  const children = contents[path] || [];
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
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/Shares/Browse?*',route=>route.fulfill({status:200,contentType:'text/html',body:html}));
  let rootFailures = options.rootFailures || 0;
  await page.route('**/webGui/include/Browse.php?*', async route => {
    const query = new URL(route.request().url()).searchParams;
    const path = decodeURIComponent(query.get('dir') || '');
    if (path === '/mnt/user' && rootFailures-- > 0) {
      await route.fulfill({status:500,body:'temporary root error'}).catch(()=>{});
      return;
    }
    if (path === '/mnt/user/downloads' && options.delayDownloads) {
      await new Promise(resolve=>setTimeout(resolve,options.delayDownloads));
    }
    await route.fulfill({status:200,contentType:'text/html',body:responseFor(path)}).catch(()=>{});
  });
  await page.goto(base + '/Shares/Browse?dir=%2Fmnt%2Fuser');
  return {page,errors};
}

const currentLabel = page => page.locator('.ufs-tab.ufs-active .ufs-tab-name');
const rows = page => page.locator('.ufs-entry');

before(async()=> { browser = await chromium.launch({headless:true}); });
after(async()=> { await browser?.close(); });

test('首次根路径进入首个共享目录；根分组不可选；展开箭头不会导航', async t => {
  const {page,errors} = await pageFor(t);
  await currentLabel(page).getByText('TimeMachine').waitFor();
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
  await currentLabel(page).getByText('TimeMachine').waitFor();
  await page.locator('.ufs-tree-row').filter({has:page.locator('.ufs-tree-name', {hasText:'downloads'})}).first().click();
  await currentLabel(page).getByText('downloads').waitFor();
  await page.locator('.ufs-tree-row').filter({has:page.locator('.ufs-tree-name', {hasText:'appdata'})}).first().click();
  await currentLabel(page).getByText('appdata').waitFor();
  await page.goBack();
  await currentLabel(page).getByText('downloads').waitFor();
  await page.locator('.ufs-back').click();
  await currentLabel(page).getByText('TimeMachine').waitFor();
  await page.locator('.ufs-next').click();
  await currentLabel(page).getByText('downloads').waitFor();
  assert.equal(new URL(page.url()).searchParams.get('dir'),'/mnt/user/downloads');
  assert.equal(errors.length,0,errors.join('\n'));
});

test('快速切换目录时旧请求不能覆盖当前目录；多选和 LOCATION 仍可用', async t => {
  const {page,errors} = await pageFor(t,{delayDownloads:700});
  await currentLabel(page).getByText('TimeMachine').waitFor();
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
  await currentLabel(page).getByText('TimeMachine').waitFor();
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
  await currentLabel(page).getByText('TimeMachine').waitFor();
  const retained = await page.evaluate(()=>JSON.parse(localStorage.getItem('unraid-file-station:v1:columns')));
  assert.equal(retained.size,saved.size);
  assert.equal(errors.length,0,errors.join('\n'));
});
