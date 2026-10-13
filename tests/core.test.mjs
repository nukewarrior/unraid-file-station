import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../src/unraid-file-station.user.js', import.meta.url), 'utf8');

function createCopyCleanupHarness(statuses, overrides = {}) {
  const jobs = statuses.map((status,id) => ({id,status,record:{taskId:'copy_cleanup_'+id}}));
  const writes = [];
  const messages = [];
  const context = {
    copyJobs:jobs,copyCleanupPending:false,copyCleanupError:'',destroyed:false,
    copyPersistTail:Promise.resolve(),lastPersistedTasks:'[]',
    initializeCopyPersistence:async()=>{},ensureCopyOwnership:async()=>{},
    persistentCopyStore:{read:async()=>({tasks:[]})},
    persistCopyQueue:async()=>{writes.push(jobs.map(job=>job.id));},
    updateCopyTaskButton:()=>{},notify:message=>messages.push(message),
    ...overrides
  };
  const begin = script.indexOf('  async function clearCompletedCopyJobs(');
  const end = script.indexOf('  function closeCopyTaskCenter(',begin);
  assert.ok(begin>=0 && end>begin);
  vm.runInNewContext(script.slice(begin,end),context);
  return {jobs,writes,messages,context,clear:context.clearCompletedCopyJobs};
}

test('任务记录清理只移除成功项，逐条和批量共用一次快照保存',async()=>{
  const {jobs,writes,clear}=createCopyCleanupHarness([
    'success','running','queued','failed','stopped','uncertain','success'
  ]);
  const last=jobs[6];
  await clear(jobs[2]);
  assert.equal(writes.length,0,'排队任务不能通过成功记录清理入口移除');
  await clear(last);
  assert.deepEqual(jobs.map(job=>job.status),[
    'success','running','queued','failed','stopped','uncertain'
  ]);
  assert.equal(writes.length,1);
  await clear();
  assert.deepEqual(jobs.map(job=>job.status),['running','queued','failed','stopped','uncertain']);
  assert.equal(writes.length,2,'每次批量操作只保存一次');
  await clear();
  assert.equal(writes.length,2,'没有成功记录时不写入');
});

test('任务清理保存失败恢复记录顺序，并保留其他任务实时变更',async()=>{
  const harness=createCopyCleanupHarness(['success','running','queued','success']);
  const before=harness.jobs.slice();
  const added={id:4,status:'queued'};
  harness.context.persistCopyQueue=async()=>{
    before[1].status='uncertain';
    harness.jobs.splice(harness.jobs.indexOf(before[2]),1);
    harness.jobs.push(added);
    throw new Error('模拟保存失败');
  };
  await harness.clear();
  assert.deepEqual(harness.jobs,[before[0],before[1],before[3],added]);
  assert.equal(harness.jobs[1].status,'uncertain');
  assert.match(harness.context.copyCleanupError,/未清理任务记录.*模拟保存失败/);
  assert.equal(harness.context.copyCleanupPending,false);
  assert.equal(harness.messages.length,1);
});

test('任务清理遇到所有权冲突或快照过期时保留全部记录',async()=>{
  for(const overrides of [
    {ensureCopyOwnership:async()=>{throw new Error('已有其他标签页管理复制队列');}},
    {persistentCopyStore:{read:async()=>({tasks:[{taskId:'copy_changed'}]})}}
  ]) {
    const {jobs,writes,context,clear}=createCopyCleanupHarness(['success','queued'],overrides);
    const before=jobs.slice();
    await clear();
    assert.deepEqual(jobs,before);
    assert.equal(writes.length,0);
    assert.match(context.copyCleanupError,/其他标签页/);
    assert.equal(context.copyCleanupPending,false);
  }
});

test('任务清理等待保存检查时拒绝重复操作',async()=>{
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const {jobs,writes,clear}=createCopyCleanupHarness(['success','success'],{
    initializeCopyPersistence:()=>pending
  });
  const first=clear(jobs[0]);
  await clear(jobs[1]);
  assert.equal(jobs.length,2);
  release();
  await first;
  assert.equal(jobs.length,1);
  assert.equal(jobs[0].id,1);
  assert.equal(writes.length,1);
});

function createAPI(options = {}) {
  const rows = [];
  const sandbox = {
    location: { pathname: '/demo/', search: '' },
    document: {
      // Minimal DOM for location-chip rendering tests, without browser dependencies.
      createElement: (tagName) => ({
        tagName, className: '', textContent: '', title: '', children: [],
        attributes: {},
        setAttribute(name,value) { this.attributes[name] = value; },
        addEventListener(name,callback) { (this.listeners ||= {})[name] = callback; },
        append(...children) { this.children.push(...children); },
      }),
      documentElement: { getAttribute: () => 'true' },
      readyState: 'loading',
      addEventListener() {},
    },
    window: {
      addEventListener() {},
      __UFS_TEST_MODE__: true,
      csrf_token: options.csrfToken === undefined ? 'test-csrf' : options.csrfToken,
      __UFS_DEMO__: {
        '/mnt/user': [
          { name: 'downloads', folder: true },
          { name: '演示文件.txt', folder: false, size: 1024 },
        ],
      },
    },
    localStorage: { getItem: () => null },
    DOMParser: class {
      parseFromString(html) {
        if (html.startsWith('<i data="')) {
          const value = html.slice('<i data="'.length, -'</i>'.length - 2);
          // Minimal data-attribute entity simulation; the real browser suite
          // checks HTML parsing directly in Chromium.
          const decoded = value.replace(/&(amp|copy)(;|(?=$))/gi, (_, name) =>
            name.toLowerCase() === 'amp' ? '&' : '©');
          return { querySelector: () => ({ getAttribute: () => decoded }) };
        }
        return {
          querySelector: () => (rows.length ? {} : null),
          querySelectorAll: () => rows,
        };
      }
    },
    URL, URLSearchParams, setTimeout, clearTimeout, AbortController, DOMException, console,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  };
  vm.runInNewContext(script, sandbox, { filename: 'unraid-file-station.user.js' });
  return { api: sandbox.window.__UFS_TEST_API__, rows, sandbox };
}

function makeIcon(path, type = 'f') {
  const cells = Array.from({ length: 9 }, () => ({
    getAttribute: () => null,
    textContent: '',
  }));
  cells[2].textContent = path.slice(path.lastIndexOf('/') + 1);
  cells[3].textContent = 'nobody';
  cells[4].textContent = '-rw-rw-rw-';
  cells[5].getAttribute = () => '1024';
  cells[6].getAttribute = () => '1791435600';
  return {
    getAttribute: (name) => ({ data: path, type }[name]),
    closest: () => ({ cells }),
  };
}

test('脚本可正常解析且具有明确的 Unraid 路由限定', () => {
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(script, /@match\s+\*:\/\/\*\/Shares\*/);
  assert.match(script, /@match\s+\*:\/\/\*\/Main\/Browse\*/);
  assert.match(script, /@grant\s+none/);
});

test('仅允许 /mnt/user 目录，禁止穿越或混用磁盘视图', () => {
  const { api } = createAPI();
  assert.equal(api.safePath('/mnt/user'), true);
  assert.equal(api.safePath('/mnt/user/downloads/测试'), true);
  for (const path of [
    '/mnt/user0', '/mnt/disk1', '/boot', '/mnt/user/../disk1',
    '/mnt/user/./downloads', '/mnt/user/file\0hidden',
  ]) assert.equal(api.safePath(path), false, path);
});

test('文件大小和路径编码适用于中文及 URL 特殊字符', () => {
  const { api } = createAPI();
  assert.equal(api.formatSize(null), '—');
  assert.equal(api.formatSize(0), '0 B');
  assert.equal(api.formatSize(1024), '1 KB');
  assert.equal(api.encodeFileUrl('/mnt/user/照片 #1?.png'), '/mnt/user/%E7%85%A7%E7%89%87%20%231%3F.png');
});

test('目录读取在演示模式下无需真实 NAS 且不会发起写入', async () => {
  const { api } = createAPI();
  const data = await api.listDirectory('/mnt/user');
  assert.equal(data.length, 2);
  assert.equal(data[0].path, '/mnt/user/downloads');
  assert.equal(data[1].size, 1024);
  await assert.rejects(api.listDirectory('/mnt/disk1'), /仅允许访问/);
});

test('7.2.2 Browse 表格解析映射目录元信息并过滤越界行', () => {
  const { api, rows } = createAPI();
  rows.push(
    makeIcon('/mnt/user/downloads/test.zip', 'f'),
    makeIcon('/mnt/user/downloads/照片', 'd'),
    makeIcon('/mnt/disk1/private.txt', 'f'),
  );
  const files = api.parseBrowse('<tbody>test</tbody>', '/mnt/user/downloads');
  assert.equal(files.length, 2);
  assert.equal(files[0].name, 'test.zip');
  assert.equal(files[0].size, 1024);
  assert.equal(files[0].owner, 'nobody');
  assert.equal(files[1].folder, true);
  assert.equal(files[1].size, null);
});

test('LOCATION 仅从 Unraid device_* 节点提取，不混入加密状态提示或重复设备', () => {
  const { api } = createAPI();
  const cell = {
    textContent: 'Not encrypted disk1 Locked: unknown error cache disk1',
    querySelectorAll: selector => {
      assert.equal(selector, 'span[id^="device_"]');
      return [
        { textContent: 'disk1' },
        { textContent: ' cache ' },
        { textContent: 'disk1' },
        { textContent: '---' },
        { textContent: ' ' }
      ];
    }
  };
  assert.deepEqual([...api.extractLocations(cell)], ['disk1', 'cache']);
  assert.deepEqual([...api.extractLocations(null)], []);
  assert.deepEqual([...api.extractLocations({ textContent: 'Not encrypted disk1' })], []);
  assert.deepEqual([...api.locationNames({})], []);
});

test('真实 Browse 行同时解析 owner 与 LOCATION：单磁盘、多设备、空位置与路径限制', () => {
  const { api, rows } = createAPI();
  const entries = [
    { path:'/mnt/user/media/movie.mkv', type:'f', owner:'nobody', devices:['disk1','disk2'] },
    { path:'/mnt/user/media/photos', type:'d', owner:'root', devices:['cache'] },
    { path:'/mnt/user/media/unknown.iso', type:'f', owner:'root', devices:[] },
    { path:'/mnt/disk1/secret.txt', type:'f', owner:'root', devices:['disk1'] }
  ];
  for (const e of entries) {
    const icon = makeIcon(e.path, e.type);
    const cells = icon.closest().cells;
    cells[3].textContent = e.owner;
    cells[7].querySelectorAll = () => e.devices.map(textContent => ({ textContent }));
    // makeIcon.closest() creates a fresh row each time: retain one row for the stub.
    icon.closest = () => ({ cells });
    rows.push(icon);
  }
  const parsed = api.parseBrowse('<tbody>test</tbody>', '/mnt/user/media');
  assert.equal(parsed.length, 3);
  assert.deepEqual([...parsed[0].locations], ['disk1','disk2']);
  assert.equal(parsed[0].owner, 'nobody');
  assert.deepEqual([...parsed[1].locations], ['cache']);
  assert.equal(parsed[1].owner, 'root');
  assert.deepEqual([...parsed[2].locations], []);
});

test('OWNER 和 LOCATION 列可分别升序降序排列，仍保持目录在文件之前', () => {
  const { api } = createAPI();
  api.state.entries = [
    { name:'z.zip', folder:false, owner:'root', locations:['disk2'] },
    { name:'a.zip', folder:false, owner:'nobody', locations:['cache','disk1'] },
    { name:'dir', folder:true, owner:'root', locations:['disk1'] },
    { name:'unknown.zip', folder:false, owner:'root', locations:[] }
  ];
  api.state.sortKey = 'owner';
  api.state.sortDirection = 1;
  assert.equal(api.visibleEntries().map(x=>x.name).join(','), 'dir,a.zip,unknown.zip,z.zip');
  api.state.sortDirection = -1;
  assert.equal(api.visibleEntries().map(x=>x.name).join(','), 'dir,unknown.zip,z.zip,a.zip');
  api.state.sortKey = 'locations';
  api.state.sortDirection = 1;
  assert.equal(api.visibleEntries().map(x=>x.name).join(','), 'dir,unknown.zip,a.zip,z.zip');
  api.state.sortDirection = -1;
  assert.equal(api.visibleEntries().map(x=>x.name).join(','), 'dir,z.zip,a.zip,unknown.zip');
});

test('列表新增 OWNER 与 LOCATION 两列、属性面板新增位置，网格视图继续隐藏详情', () => {
  assert.match(script, /'owner', 'OWNER'/);
  assert.match(script, /'locations', 'LOCATION'/);
  assert.match(script, /renderLocationTags\(entry\)/);
  assert.match(script, /'存储位置', locationNames\(entry\)\.join\(', '\) \|\| '—'/);
  assert.match(script, /#ufs-app \.ufs-grid \.ufs-extra\{display:none\}/);
  assert.match(script, /#ufs-app \.ufs-entry \.ufs-location-trigger/);
  assert.match(script, /@version\s+0\.2\.10\b/);
});


test('LOCATION 根据列宽显示完整磁盘名，超出时提供明确查看全部入口', () => {
  const { api } = createAPI();
  const names = ['disk1','disk2','disk3','cache'];
  const measure = text => text.length * 10;
  const full = api.fitLocationNames(names, 500, measure);
  assert.deepEqual([...full.visible], names);
  assert.equal(full.hidden, 0);
  const partial = api.fitLocationNames(names, 180, measure);
  assert.deepEqual([...partial.visible], ['disk1']);
  assert.equal(partial.hidden, 3);
  const tiny = api.fitLocationNames(names, 30, measure);
  assert.equal(tiny.visible.length, 0);
  assert.equal(tiny.hidden, 4);
  assert.equal(api.fitLocationNames([], 50, measure).hidden, 0);
  const many = Array.from({length:50}, (_,i) => 'disk'+(i+1));
  const limited = api.fitLocationNames(many, 260, measure);
  assert.equal(limited.visible.length + limited.hidden, 50);
  assert.ok(limited.hidden > 0);
  assert.doesNotMatch(script, /function summarizeLocations/);
});

test('LOCATION 保留原始独立磁盘名称，按钮点击可展开及复制完整位置', () => {
  const { api } = createAPI();
  const cell = api.renderLocationTags({locations:['disk1','disk2','disk3','cache']});
  assert.equal(cell.children.length, 1);
  const trigger = cell.children[0];
  assert.equal(trigger.tagName, 'button');
  assert.equal(trigger.textContent, 'disk1, disk2, disk3, cache');
  assert.deepEqual([...trigger._ufsNames], ['disk1','disk2','disk3','cache']);
  assert.equal(trigger.title, 'disk1, disk2, disk3, cache');
  assert.equal(trigger.attributes['aria-haspopup'], 'dialog');
  assert.equal(trigger.attributes['aria-expanded'], 'false');
  assert.equal(trigger.attributes['aria-label'], '查看全部 4 个存储位置');
  assert.equal(typeof trigger.listeners.click, 'function');
  assert.equal(typeof trigger.listeners.dblclick, 'function');
  const empty = api.renderLocationTags({locations:[]});
  assert.equal(empty.title, '存储位置未知');
  assert.deepEqual(empty.children.map(x=>x.textContent), ['—']);
  const raw = '<img src=x onerror=alert(1)>';
  const safe = api.renderLocationTags({locations:[raw]});
  assert.equal(safe.children[0].textContent, raw);
  assert.match(script, /names\.forEach\(\(name\) => items\.append\(element\('span', 'ufs-location-device', name\)\)\)/);
  assert.match(script, /copyText\(names\.join\(', '\)\)/);
  assert.match(script, /document\.execCommand\('copy'\)/);
  assert.match(script, /navigator\.clipboard\.writeText\(text\)/);
  assert.match(script, /max-height:min\(300px,50vh\);overflow-y:auto/);
  assert.match(script, /ufs-location-more-link/);
});

test('列表 6 列共用宽度变量，窄屏内部横向滚动，不再隐去 LOCATION', () => {
  const { api } = createAPI();
  const columns = [...api.COLUMNS].map(x => x.key);
  assert.deepEqual(columns, ['name','size','mtime','owner','permissions','locations']);
  assert.match(script, /grid-template-columns:var\(--ufs-columns\);width:100%;min-width:var\(--ufs-table-min-width\);box-sizing:border-box/);
  assert.match(script, /#ufs-app \.ufs-list\{[^']*overflow:auto/);
  assert.doesNotMatch(script, /@media\(max-width:1280px\) and \(min-width:981px\)/);
  assert.match(script, /#ufs-app \.ufs-grid \.ufs-entry\{[^']*width:auto/);
});

test('列宽边界、安全读取历史值、默认宽度与列布局统一', () => {
  const { api } = createAPI();
  assert.equal(api.clampColumnWidth('size', 1), 65);
  assert.equal(api.clampColumnWidth('size', 9999), 260);
  assert.equal(api.clampColumnWidth('name', 70), 180);
  assert.equal(api.clampColumnWidth('locations', 950), 900);
  assert.equal(api.clampColumnWidth('bad', 100), null);
  assert.equal(api.clampColumnWidth('size', 'xyz'), null);
  assert.equal(Object.keys(api.readColumnWidths('{bad json')).length, 0);
  assert.equal(Object.keys(api.readColumnWidths('[]')).length, 0);
  const widths = api.readColumnWidths('{"size":126,"owner":80,"danger":50,"locations":9999}');
  assert.equal(widths.size, 126);
  assert.equal(widths.owner, 80);
  assert.equal(widths.locations, 900);
  assert.equal(widths.danger, undefined);
  const defaults = api.columnLayout({});
  assert.match(defaults.columns, /^minmax\(280px, 1fr\) 95px 155px 95px 120px 250px$/);
  assert.equal(defaults.minWidth, 1069);
  const custom = api.columnLayout({size:126, owner:80, locations:300});
  assert.equal(custom.minWidth, 1069+31-15+50);
  assert.match(custom.columns, /126px 155px 80px 120px 300px$/);
  assert.match(script, /setPointerCapture\(event\.pointerId\)/);
  assert.match(script, /grip\.addEventListener\('dblclick'/);
  assert.match(script, /localStorage\.setItem\(STORE \+ 'columns'/);
  assert.match(script, /localStorage\.removeItem\(STORE \+ 'columns'\)/);
});

test('深路径折叠中间目录但保留每层导航能力', () => {
  const { api } = createAPI();
  const paths = ['/mnt/user','/mnt/user/a','/mnt/user/a/b','/mnt/user/a/b/c','/mnt/user/a/b/c/d'];
  const shortened = api.breadcrumbDisplayPaths(paths);
  assert.deepEqual([...shortened.visible], ['/mnt/user',null,'/mnt/user/a/b/c','/mnt/user/a/b/c/d']);
  assert.deepEqual([...shortened.hidden], ['/mnt/user/a','/mnt/user/a/b']);
  assert.equal(api.breadcrumbDisplayPaths(paths.slice(0,3)).hidden.length, 0);
  assert.match(script, /flex:1 1 auto;width:auto;min-width:0;max-width:none;height:30px/);
  assert.match(script, /ufs-crumb-more/);
});

test('非 Unraid 页面不执行目录读取或插入 UI', () => {
  const sandbox = {
    document: { documentElement: { getAttribute: () => null } },
    location: { pathname: '/Settings' },
  };
  assert.doesNotThrow(() => vm.runInNewContext(script, sandbox));
});


test('布局高度随头部位置和固定页脚动态变化', () => {
  const { api } = createAPI();
  assert.equal(api.availableHeight(340, 901, 960), 549);
  assert.equal(api.availableHeight(210, 901, 960), 679);
  assert.equal(api.availableHeight(210, Number.NaN, 960), 738);
  assert.equal(api.availableHeight(800, 850, 960), 260);
});

test('文件排序保持文件夹在前并能切换大小、时间和名称顺序', () => {
  const { api } = createAPI();
  api.state.entries = [
    { name: 'z.zip', folder: false, size: 100, mtime: 2 },
    { name: 'a.zip', folder: false, size: 300, mtime: 1 },
    { name: 'Movies', folder: true },
  ];
  assert.equal(api.visibleEntries().map(x => x.name).join(','), 'Movies,a.zip,z.zip');
  api.state.sortKey = 'size';
  api.state.sortDirection = -1;
  assert.equal(api.visibleEntries().map(x => x.name).join(','), 'Movies,a.zip,z.zip');
  api.state.sortKey = 'mtime';
  api.state.sortDirection = -1;
  assert.equal(api.visibleEntries().map(x => x.name).join(','), 'Movies,z.zip,a.zip');
  api.state.filter = 'ZIP';
  assert.equal(api.visibleEntries().length, 2);
});

test('只读版本采用固定操作菜单且不再创建选中操作栏', () => {
  const { api } = createAPI();
  const header = api.renderHeaderMarkup();
  const navigation = api.renderBrowserBarMarkup();
  const workspace = api.renderWorkspaceMarkup();
  assert.match(header, /class="ufs-top"/);
  assert.match(header, /class="ufs-tabs"/);
  assert.match(header, /ufs-more/);
  assert.match(navigation, /class="ufs-navigation"/);
  assert.match(navigation, /ufs-search-trigger/);
  const fileActions = api.renderFileActionsMarkup();
  assert.match(fileActions, /ufs-grid-button/);
  assert.match(fileActions, /class="ufs-file-actions"/);
  assert.doesNotMatch(navigation, /ufs-grid-button|ufs-file-actions/);
  assert.match(api.renderFileActionsMarkup(), /ufs-operations/);
  assert.doesNotMatch(workspace, /ufs-selection-bar/);
  assert.doesNotMatch(header + navigation + workspace, /ufs-toolbar|ufs-write/);
  assert.match(script, /const ICONS =/);
  assert.doesNotMatch(script, /'📁'|'📄'/);
  assert.match(script, /nativeBreadcrumb = \$\('\.title \.left'\)/);
  assert.match(script, /footer = isDemo \? null : document\.querySelector\('#footer'\)/);
});


test('v0.2.8.1 顶部刷新图标采用 rotate-cw，按钮统一尺寸且仅目录加载时旋转', () => {
  const { api } = createAPI();
  const header = api.renderHeaderMarkup();
  const start = script.indexOf('  const ICONS = {');
  const end = script.indexOf('  function icon(',start);
  const icons = vm.runInNewContext(script.slice(start,end)+'\nICONS');
  assert.deepEqual(Array.from(icons['rotate-cw']),[
    'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8',
    'M21 3v5h-5'
  ]);
  assert.match(header,/class="ufs-ico ufs-refresh" title="刷新" aria-label="刷新目录"><span data-ufs-icon="rotate-cw"><\/span>/);
  assert.match(script,/#ufs-app \.ufs-app-actions>\.ufs-ico\{[^']*width:32px[^']*height:32px/);
  assert.match(script,/#ufs-app \.ufs-app-actions>\.ufs-ico>\.ufs-svg\{width:20px;height:20px/);
  assert.match(script,/refreshButton\.classList\.toggle\('ufs-spinning', state\.busy && !state\.initializing\)/);
  assert.match(script,/@media\(prefers-reduced-motion:reduce\).*ufs-refresh\.ufs-spinning/);
  assert.match(script,/\$\('\.ufs-refresh', app\)\.addEventListener\('click', refreshDirectory\)/);
});


test('v0.2.8.2 诊断日志按钮使用 Lucide scroll-text 且保留原有行为与样式', () => {
  const { api } = createAPI();
  const header = api.renderHeaderMarkup();
  const start = script.indexOf('  const ICONS = {');
  const end = script.indexOf('  function icon(',start);
  const icons = vm.runInNewContext(script.slice(start,end)+'\nICONS');
  assert.deepEqual(Array.from(icons['scroll-text']),[
    'M15 12h-5',
    'M15 8h-5',
    'M19 17V5a2 2 0 0 0-2-2H4',
    'M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3'
  ]);
  assert.match(header,/class="ufs-ico ufs-diagnostic-button" title="诊断日志" aria-label="诊断日志"><span data-ufs-icon="scroll-text"><\/span>/);
  assert.doesNotMatch(header,/data-ufs-icon="bug"/);
  assert.match(script,/#ufs-app \.ufs-app-actions>\.ufs-ico\{[^']*width:32px[^']*height:32px/);
  assert.match(script,/\.ufs-diagnostic-button', app\)\.addEventListener\('click',/);
});

test('回归：滚动页面不能让 File Station 的高度不断增长', () => {
  const { api } = createAPI();
  // The app remains at document position 280, but its viewport top moves
  // upward as the browser scrolls. Height MUST stay unchanged.
  const base = api.availableHeight(280, 895, 960, 0);
  assert.equal(base, 603);
  for (const scrollY of [20, 120, 350, 700, 1800]) {
    assert.equal(api.availableHeight(280 - scrollY, 895, 960, scrollY), base);
  }
});

test('只锁定增强版 Browse 外层滚动，不再监听 body 尺寸变化', () => {
  assert.match(script, /html\.ufs-active-page,html\.ufs-active-page body\{overflow-y:hidden!important/);
  assert.match(script, /document\.documentElement\.classList\.add\('ufs-active-page'\)/);
  assert.match(script, /document\.documentElement\.classList\.remove\('ufs-active-page'\)/);
  assert.doesNotMatch(script, /const targets = \[document\.body,/);
  assert.doesNotMatch(script, /window\.addEventListener\('scroll', schedule/);
  assert.match(script, /overscroll-behavior:contain/);
});


test('统一导航栏保留内部滚动，工具栏不随选中出现新行', () => {
  const { api } = createAPI();
  assert.match(api.renderBrowserBarMarkup(), /ufs-search[^"]*"[^>]*hidden/);
  assert.doesNotMatch(api.renderWorkspaceMarkup(), /ufs-selection-bar/);
  assert.match(script, /#ufs-app \.ufs-navigation\{height:42px;min-height:42px;max-height:42px/);
  assert.match(script, /#ufs-app \[hidden\]\{display:none!important/);
  assert.match(script, /#ufs-app \.ufs-sidebar\{[^']*overflow:auto/);
  assert.match(script, /#ufs-app \.ufs-list\{[^']*overflow:auto/);
});

test('文件多选记录可供固定操作菜单使用', () => {
  const { api } = createAPI();
  api.state.entries = [
    {path:'/mnt/user/downloads/Photos', name:'Photos', folder:true},
    {path:'/mnt/user/downloads/one.zip', name:'one.zip', folder:false}
  ];
  assert.equal(api.selectedEntries().length, 0);
  api.state.selection.add('/mnt/user/downloads/one.zip');
  assert.equal(api.selectedEntries().length, 1);
  api.state.selection.add('/mnt/user/downloads/Photos');
  assert.equal(api.selectedEntries().length, 2);
  assert.match(script, /chosen\.length === 1 && !chosen\[0\]\.folder/);
  assert.match(script, /setSearchOpen\(false\)/);
});

test('原生上下滚动浮动按钮仅在增强版 File Station 页面隐藏', () => {
  assert.match(script, /html\.ufs-active-page \.move_to_end,html\.ufs-active-page \.back_to_top\{display:none!important\}/);
  assert.match(script, /document\.documentElement\.classList\.add\('ufs-active-page'\)/);
  assert.match(script, /document\.documentElement\.classList\.remove\('ufs-active-page'\)/);
  // Avoid broad selectors that would disable global arrows on other Unraid pages.
  assert.doesNotMatch(script, /'\.move_to_end,\.back_to_top\{display:none!important\}'/);
});


test('v0.1.6 DSM 结构：导航与固定操作栏仅属于右侧主区域', () => {
  const { api } = createAPI();
  const html = api.renderWorkspaceMarkup();
  const sidebar = html.indexOf('<aside class="ufs-sidebar">');
  const resizer = html.indexOf('<div class="ufs-resizer"');
  const main = html.indexOf('<main class="ufs-main">');
  const navigation = html.indexOf('<div class="ufs-navigation"');
  const actions = html.indexOf('<div class="ufs-file-actions"');
  const content = html.indexOf('<div class="ufs-content">');
  const list = html.indexOf('<div class="ufs-list"');
  const inspector = html.indexOf('<aside class="ufs-inspector"');
  assert.ok(sidebar >= 0 && sidebar < resizer && resizer < main);
  assert.ok(main < navigation && navigation < actions && actions < content);
  assert.ok(content < list && list < inspector);
  assert.ok(html.indexOf('</main>') > inspector);
  assert.equal((html.match(/class="ufs-navigation"/g) || []).length, 1);
  assert.equal((html.match(/class="ufs-file-actions"/g) || []).length, 1);
});

test('v0.1.5 地址框尺寸限制在右侧工具栏，保持白底且不突出', () => {
  const { api } = createAPI();
  assert.match(api.renderBrowserBarMarkup(), /class="ufs-address"/);
  assert.doesNotMatch(api.renderBrowserBarMarkup(), /ufs-view-controls/);
  assert.match(api.renderFileActionsMarkup(), /ufs-view-controls/);
  assert.match(script, /#ufs-app \.ufs-address\{display:flex;align-items:center;gap:2px;flex:1 1 auto;[^']*height:30px;min-height:30px;max-height:30px/);
  assert.match(script, /background:var\(--ufs-bg\);box-shadow:none;line-height:28px/);
  assert.match(script, /#ufs-app \.ufs-main\{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;overflow:hidden/);
  assert.match(script, /#ufs-app \.ufs-content\{display:flex;flex:1;min-width:0;min-height:0;overflow:hidden/);
  assert.doesNotMatch(script, /#ufs-app \.ufs-toolbar\{height:44px/);
});


test('DSM 风格浅蓝选中高亮与橙色目录树选中态分离', () => {
  assert.match(script, /--ufs-sel:#e4f0fc/);
  assert.match(script, /--ufs-tree-sel:#fff0e2/);
  assert.match(script, /ufs-entry\.ufs-selected\{background:var\(--ufs-sel\);outline:none\}/);
  assert.match(script, /ufs-entry\.ufs-selected:hover\{background:var\(--ufs-selected-hover\)\}/);
  assert.doesNotMatch(script, /function renderSelectionBar/);
  assert.doesNotMatch(script, /renderSelectionBarMarkup/);
  assert.match(script, /if \(event\.target === \$\('\.ufs-list', app\)/);
  assert.match(script, /if \(!state\.selection\.has\(entry\.path\)\)/);
});

test('单选、Ctrl/⌘ 增减选和 Shift 连选不会修改固定工具栏', () => {
  const { api } = createAPI();
  const entries = ['a', 'b', 'c', 'd'].map(name => ({
    name, path:'/mnt/user/downloads/'+name, folder:true
  }));
  const e = (overrides={}) => ({ metaKey:false, ctrlKey:false, shiftKey:false, ...overrides });
  api.state.entries = entries;
  api.updateSelection(e(), entries[0], 0, entries);
  assert.deepEqual([...api.state.selection], [entries[0].path]);
  api.updateSelection(e({metaKey:true}), entries[2], 2, entries);
  assert.deepEqual([...api.state.selection].sort(), [entries[0].path, entries[2].path].sort());
  api.updateSelection(e({ctrlKey:true}), entries[0], 0, entries);
  assert.deepEqual([...api.state.selection], [entries[2].path]);
  // Ctrl toggling a updated the anchor to a; Shift clicking c selects a..c.
  api.updateSelection(e({shiftKey:true}), entries[2], 2, entries);
  assert.deepEqual([...api.state.selection].sort(), entries.slice(0, 3).map(x=>x.path).sort());
  api.updateSelection(e(), entries[3], 3, entries);
  assert.deepEqual([...api.state.selection], [entries[3].path]);
  assert.doesNotMatch(api.renderWorkspaceMarkup(), /ufs-selection-bar/);
});

test('底部统计仅汇总可知文件大小，不计算文件夹内容大小', () => {
  const { api } = createAPI();
  const file1 = { name:'a.zip', path:'/mnt/user/a.zip', folder:false, size:1024 };
  const file2 = { name:'b.zip', path:'/mnt/user/b.zip', folder:false, size:2048 };
  const folder = { name:'photos', path:'/mnt/user/photos', folder:true };
  assert.equal(api.selectionStatus([file1, file2]), '已选择 2 个项目 · 合计 3 KB');
  assert.equal(api.selectionStatus([file1, folder]), '已选择 2 个项目 · 已知文件合计 1 KB');
  assert.equal(api.selectionStatus([folder]), '已选择 1 个项目');
  assert.match(script, /selectionStatus\(chosen\)/);
});


test('v0.1.7 Shift 左键连选阻止默认文本选择，但正常左键与右键不阻止', () => {
  const { api } = createAPI();
  assert.equal(api.shouldSuppressTextSelection({ button:0, shiftKey:true }), true);
  assert.equal(api.shouldSuppressTextSelection({ button:0, shiftKey:false }), false);
  assert.equal(api.shouldSuppressTextSelection({ button:2, shiftKey:true }), false);
  assert.equal(api.shouldSuppressTextSelection({ button:1, shiftKey:true }), false);
  assert.match(script, /row\.addEventListener\('mousedown', \(event\) => \{[\s\S]*?if \(shouldSuppressTextSelection\(event\)\) event\.preventDefault\(\)/);
  assert.match(script, /row\.addEventListener\('click', \(event\) => selectEntry\(event, entry, index, entries\)\)/);
});

test('v0.1.7 文件列表和共享目录树使用箭头光标，文字不能被浏览器选中', () => {
  assert.match(script, /#ufs-app \.ufs-tree-row,#ufs-app \.ufs-tree-row \*,#ufs-app \.ufs-entry,#ufs-app \.ufs-entry \*\{user-select:none;-webkit-user-select:none;cursor:default!important\}/);
  assert.match(script, /#ufs-app \.ufs-search\{/); // Search inputs are intentionally outside the reset.
  assert.match(script, /#ufs-app \.ufs-crumb\{/);  // Breadcrumb remains separately operable.
  assert.match(script, /@version\s+0\.2\.10\b/);
});


test('详细信息切换后鼠标焦点不残留，键盘焦点仍保留', () => {
  assert.match(script, /event\.detail > 0\) event\.currentTarget\.blur\(\)/);
  assert.match(script, /#ufs-app button:focus:not\(:focus-visible\)\{outline:none!important;box-shadow:none!important\}/);
  assert.match(script, /#ufs-app button:focus-visible/);
  assert.match(script, /classList\.toggle\('ufs-view-active', state\.inspector\)/);
});

test('表头单元格与排序按钮垂直居中，不受 Unraid 全局 CSS 基线影响', () => {
  assert.match(script, /#ufs-app \.ufs-head\{align-items:stretch;padding-top:0;padding-bottom:0\}/);
  assert.match(script, /#ufs-app \.ufs-head>span\{display:flex;align-items:center;min-width:0;height:100%/);
  assert.match(script, /#ufs-app \.ufs-head \.ufs-sort-button\{display:inline-flex;align-items:center;justify-content:flex-start;width:100%;height:100%/);
  assert.match(script, /#ufs-app \.ufs-menu \.ufs-location-popover-close\{display:inline-flex/);
});

test('v0.1.11 还原 v0.1.9 路径栏的白底、宽度和原高度', () => {
  assert.match(script, /#ufs-app \.ufs-navigation\{height:42px;min-height:42px;max-height:42px/);
  assert.match(script, /#ufs-app \.ufs-address\{display:flex;align-items:center;gap:2px;flex:1 1 auto;width:auto;min-width:0;max-width:none;height:30px;min-height:30px;max-height:30px/);
  assert.match(script, /background:var\(--ufs-bg\);box-shadow:none;line-height:28px/);
  assert.doesNotMatch(script, /max-width:65%;height:28px/);
  assert.doesNotMatch(script, /#ufs-app \.ufs-address\{display:inline-flex/);
});

test('仅缩短面包屑箭头两侧空隙，避免 Unraid 全局按钮样式拉宽按钮', () => {
  assert.match(script, /#ufs-app \.ufs-crumb\{[^']*width:auto;min-width:0;max-width:none;min-height:0;height:auto;margin:0;padding:0 2px/);
  assert.match(script, /#ufs-app \.ufs-address>\.ufs-svg\{width:12px;height:12px;min-width:12px;flex:0 0 12px\}/);
  assert.match(script, /#ufs-app \.ufs-svg\{height:16px;width:16px;min-width:16px/); // Other icons unchanged.
  const { api } = createAPI();
  const paths = ['/mnt/user','/mnt/user/downloads','/mnt/user/downloads/aria2'];
  assert.deepEqual([...api.breadcrumbDisplayPaths(paths).visible],paths);
  assert.equal(api.breadcrumbDisplayPaths(paths).hidden.length,0);
});



test('v0.1.12 六列总宽只计算必要的 track、gap 和内边距，不叠加额外百分比', () => {
  const { api } = createAPI();
  assert.equal(api.columnLayout({}).minWidth, 1069);
  assert.match(api.columnLayout({}).columns, /^minmax\(280px, 1fr\)/);
  assert.match(script, /#ufs-app \.ufs-head,#ufs-app \.ufs-entry\{display:grid;grid-template-columns:var\(--ufs-columns\);width:100%;min-width:var\(--ufs-table-min-width\);box-sizing:border-box/);
  assert.match(script, /#ufs-app \.ufs-entry\{width:100%;min-width:var\(--ufs-table-min-width\)\}/);
  assert.doesNotMatch(script, /width:max\(100%,var\(--ufs-table-min-width\)\)/);
  assert.match(script, /#ufs-app \.ufs-grid \.ufs-entry\{[^']*width:auto/);
});

test('滚动诊断可区分小范围溢出、真实宽度不足和纵向滚动', () => {
  const { api } = createAPI();
  const fit = api.inspectListScrollMetrics({clientWidth:1600,scrollWidth:1600,clientHeight:550,scrollHeight:900});
  assert.equal(fit.horizontalOverflow, 0);
  assert.equal(fit.verticalOverflow, 350);
  assert.equal(fit.requiredWidth, 1085); // 1069px table + 16px outer list padding
  const tooWide = api.inspectListScrollMetrics({clientWidth:950,scrollWidth:1085,clientHeight:550,scrollHeight:550});
  assert.equal(tooWide.horizontalOverflow, 135);
  assert.equal(tooWide.verticalOverflow, 0);
  assert.equal(api.inspectListScrollMetrics(null), null);
  api.state.columnWidths = {locations:700};
  const custom = api.inspectListScrollMetrics({clientWidth:1200,scrollWidth:1535,clientHeight:550,scrollHeight:550});
  assert.equal(custom.horizontalOverflow, 335);
  assert.equal(custom.requiredWidth, 1535);
  assert.equal(custom.columns.locations, 700);
});

test('文件列表使用透明原生细滚动条，悬停或滚动时显示，保留拖动和内部滚动', () => {
  assert.match(script, /#ufs-app \.ufs-list\{scrollbar-width:thin;scrollbar-color:transparent transparent\}/);
  assert.match(script, /#ufs-app \.ufs-list:hover,#ufs-app \.ufs-list\.ufs-scroll-active\{scrollbar-color:/);
  assert.match(script, /#ufs-app \.ufs-list::-webkit-scrollbar\{width:6px;height:6px;background:transparent\}/);
  assert.match(script, /#ufs-app \.ufs-list:hover::-webkit-scrollbar-thumb,#ufs-app \.ufs-list\.ufs-scroll-active::-webkit-scrollbar-thumb/);
  assert.match(script, /list\.addEventListener\('scroll', \(\) => \{/);
  assert.match(script, /clearTimeout\(idleTimer\)/);
  assert.match(script, /}, 1100\)/);
  assert.match(script, /}, \{ passive: true \}\)/);
  assert.match(script, /setupListScrollbars\(\$\('\.ufs-list', app\)\)/);
  assert.match(script, /#ufs-app \.ufs-list\{min-width:0;min-height:0;overflow:auto;flex:1/);
  assert.doesNotMatch(script, /#ufs-app \.ufs-list\{[^']*overflow:hidden/);
  assert.match(script, /html\.ufs-active-page,html\.ufs-active-page body\{overflow-y:hidden!important/);
});


test('v0.1.13 默认选择目录树返回顺序的第一个真实共享文件夹', () => {
  const { api } = createAPI();
  const shares = [
    {path:'/mnt/user/notes.txt',folder:false},
    {path:'/mnt/user/TimeMachine',folder:true},
    {path:'/mnt/user/appdata',folder:true},
    {path:'/mnt/user/downloads',folder:true},
  ];
  assert.equal(api.firstSharePath(shares), '/mnt/user/TimeMachine');
  assert.equal(api.firstSharePath([...shares].reverse()), '/mnt/user/downloads');
  // This must not use file-list sort order (which sorts TimeMachine/appdata differently).
  api.state.tree.set('/mnt/user', shares.filter(x => x.folder));
  assert.equal(api.defaultSharePath(), '/mnt/user/TimeMachine');
  assert.equal(api.firstSharePath([{path:'/mnt/user/downloads/sub',folder:true},...shares]), '/mnt/user/TimeMachine');
});

test('根目录是虚拟分组，深层目录和真实 share 的判定独立', () => {
  const { api } = createAPI();
  assert.equal(api.isShareRoot('/mnt/user'), false);
  assert.equal(api.isShareRoot('/mnt/user/TimeMachine'), true);
  assert.equal(api.isShareRoot('/mnt/user/downloads'), true);
  assert.equal(api.isShareRoot('/mnt/user/downloads/aria2'), false);
  assert.equal(api.isShareRoot('/mnt/disk1/TimeMachine'), false);
  assert.equal(api.firstSharePath([]), null);
  assert.equal(api.firstSharePath(null), null);
  assert.equal(api.firstSharePath([{path:'/mnt/user/a/b',folder:true}]), null);
  assert.equal(api.firstSharePath([{path:'/mnt/user/bad/../path',folder:true}]), null);
  assert.equal(api.firstSharePath([{path:'/mnt/disk1/hidden',folder:true}]), null);
  assert.equal(api.firstSharePath([{path:'/mnt/user/file.txt',folder:false}]), null);
});

test('首次从根入口读取目录后替换 URL 且不渲染根文件列表或根标签', () => {
  assert.match(script, /const start = isDemo \? '\/mnt\/user\/downloads' : new URLSearchParams\(location\.search\)\.get\('dir'\) \|\| PREFIX;/);
  assert.match(script, /void initializeBrowser\(start\)/);
  assert.match(script, /async function initializeBrowser\(start\) \{[\s\S]*?if \(start === PREFIX\) \{[\s\S]*?await loadTree\(PREFIX\);[\s\S]*?const home = defaultSharePath\(\);/);
  assert.match(script, /start = home;\s*writeUrl\(home, true\)/);
  assert.match(script, /state\.tabs = \[\{ id: state\.nextId\+\+, path: start, history: \[start\], cursor: 0 \}\]/);
  assert.match(script, /const row = element\('div', 'ufs-tree-row' \+\s*\(path === PREFIX \? ' ufs-tree-group'/);
  assert.match(script, /if \(path !== PREFIX\) row\.addEventListener\('click'/);
  assert.match(script, /ufs-tree-row\.ufs-tree-group:hover\{background:transparent!important\}/);
});

test('根目录不能通过上一级、新标签、面包屑和历史回退被再次选中', () => {
  assert.match(script, /if \(path === PREFIX\) return notify\('请选择左侧的具体共享文件夹'\)/);
  assert.match(script, /if \(path === PREFIX\) \{ void addDefaultTab\(\); return; \}/);
  assert.match(script, /add\.addEventListener\('click', \(\) => \{ void addDefaultTab\(\); \}\)/);
  assert.match(script, /currentPath\(\) === PREFIX \|\| isShareRoot\(currentPath\(\)\)/);
  assert.match(script, /const crumb = element\(path === PREFIX \? 'span' : 'button'/);
  assert.match(script, /if \(path !== PREFIX\) crumb\.addEventListener\('click'/);
  assert.match(script, /const path = requested === PREFIX \? defaultSharePath\(\) : resolveRenamedFolderPath\(requested\)/);
  assert.match(script, /if \(requested === PREFIX \|\| path !== requested\)/);
  assert.match(script, /restoreBrowserPath\(path, event\.state\?\.ufs \? event\.state\.tabId : null\)/);
});

test('没有共享目录时显示明确空状态，读取失败后允许用户重试', () => {
  assert.match(script, /if \(!home\) \{[\s\S]*?state\.busy = false;[\s\S]*?renderFiles\(state\.rootLoadError \|\| '没有可访问的共享文件夹'\)/);
  assert.match(script, /if \(path === PREFIX\) state\.rootLoadError = error\.message/);
  assert.match(script, /if \(state\.rootLoadError\) state\.tree\.delete\(PREFIX\)/);
  assert.match(script, /state\.tree\.delete\(PREFIX\);\s*state\.rootLoadError = '';\s*await initializeBrowser\(PREFIX\)/);
  assert.match(script, /add\.disabled = state\.initializing \|\| \(state\.busy && !activeTab\(\)\)/);
  assert.doesNotMatch(script, /state\.tabs = \[\{ id: state\.nextId\+\+, path: PREFIX/);
});

test('v0.1.14 VM 环境支持取消的异步目录读取', async () => {
  const {api} = createAPI();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(api.listDirectory('/mnt/user', {signal:controller.signal}), {name:'AbortError'});
  const live = await api.listDirectory('/mnt/user');
  assert.equal(live[0].path, '/mnt/user/downloads');
});

test('v0.1.14 浏览器历史与标签历史不相互压入重复记录', () => {
  assert.match(script, /function navigate\(path, addHistory = true, urlMode = addHistory \? 'push' : 'replace'\)/);
  assert.match(script, /navigate\(tab\.history\[next\], false, 'replace'\)/);
  assert.match(script, /navigate\(path, false, 'none'\)/);
  assert.match(script, /history\[replace \? 'replaceState' : 'pushState'\]/);
  assert.match(script, /const stateValue = \{ ufs: true, tabId: tab\?\.id \?\? null, path \}/);
  assert.match(script, /if \(!tab \|\| destroyed\) return/);
});

test('v0.1.14 目录加载具备取消、过期保护、请求去重与失败重试', () => {
  assert.match(script, /if \(treeLoads\.has\(path\)\) return treeLoads\.get\(path\)/);
  assert.match(script, /treeLoads\.set\(path, pending\)/);
  assert.match(script, /treeLoads\.delete\(path\)/);
  assert.match(script, /state\.directoryController\?\.abort\(\)/);
  assert.match(script, /new AbortController\(\)/);
  assert.match(script, /listDirectory\(path, \{signal: controller\.signal\}\)/);
  assert.match(script, /request !== state\.requestId \|\| tabId !== activeTab\(\)\?\.id/);
  assert.match(script, /if \(retry\) state\.tree\.delete\(path\)/);
  assert.doesNotMatch(script, /catch \(error\) \{\s*state\.tree\.set\(path, \[\]\)/);
});

test('v0.1.14 正常退出会注销页面级监听并释放观察器', () => {
  assert.match(script, /function cleanupApp\(\) \{/);
  assert.match(script, /lifecycle\.abort\(\)/);
  assert.match(script, /onCleanup\(\(\) => observer\.disconnect\(\)\)/);
  assert.match(script, /onCleanup\(\(\) => locationObserver\.disconnect\(\)\)/);
  assert.match(script, /onCleanup\(setupListScrollbars\(\$\('\.ufs-list', app\)\)\)/);
  assert.match(script, /window\.addEventListener\('pagehide'/);
  assert.match(script, /document\.addEventListener\('pointerdown',[\s\S]*?\{ signal: lifecycle\.signal \}\)/);
});

test('v0.1.14 初始化状态禁止在未创建标签时操作历史或新标签', () => {
  assert.match(script, /state\.initializing = true/);
  assert.match(script, /state\.initializing = false/);
  assert.match(script, /if \(destroyed \|\| generation !== state\.initGeneration\) return/);
  assert.match(script, /if \(!tab \|\| destroyed\) return/);
  assert.match(script, /state\.initializing \|\| tab\.cursor <= 0/);
  assert.match(script, /add\.disabled = state\.initializing/);
});


test('v0.1.15 可视窗口计算：滚动定位、超扫描和 10000 项有限挂载', () => {
  const {api} = createAPI();
  const top=api.virtualWindow(10000,0,760,'list');
  assert.equal(top.start,0);
  assert.ok(top.end>0 && top.end<70);
  assert.equal(top.before,0);
  assert.equal(top.after + (top.end-top.start)*38,10000*38);
  const middle=api.virtualWindow(10000,190000,760,'list');
  assert.ok(middle.start>4000 && middle.end<6000);
  assert.ok(middle.end-middle.start<70);
  assert.equal(middle.before + (middle.end-middle.start)*38 + middle.after,10000*38);
  const bottom=api.virtualWindow(10000,380000,760,'list');
  assert.equal(bottom.end,10000);
  assert.ok(bottom.start>=9900);
});

test('v0.1.15 网格虚拟化适配容器宽度且不截断最后一行', () => {
  const {api} = createAPI();
  assert.equal(api.virtualGridColumns(1420),10);
  assert.equal(api.virtualGridColumns(250),1);
  const top=api.virtualWindow(10001,0,600,'grid',10);
  assert.equal(top.start,0);
  assert.ok(top.end<=150 && top.end>50);
  const bottom=api.virtualWindow(10001,200000,600,'grid',10);
  assert.equal(bottom.end,10001);
  assert.equal(bottom.columns,10);
  assert.equal(bottom.before+Math.ceil((bottom.end-bottom.start)/10)*132+bottom.after,
    Math.ceil(10001/10)*132);
});

test('v0.1.15 虚拟渲染保留全量 Shift 选择索引及原有位置和列宽功能', () => {
  assert.match(script,/const VIRTUAL_THRESHOLD = 200/);
  assert.match(script,/list\.classList\.add\('ufs-virtualized'\)/);
  assert.match(script,/for \(let i = range\.start; i < range\.end; i\+\+\)/);
  assert.match(script,/createFileRow\(data\.entries\[i\],i,data\.entries\)/);
  assert.match(script,/selectEntry\(event, entry, index, entries\)/);
  assert.match(script,/row\.dataset\.ufsFile = entry\.path/);
  assert.match(script,/renderLocationTags\(entry\)/);
  assert.match(script,/ufs-virtual-grid/);
  assert.match(script,/scheduleVirtualWindow\(\)/);
  assert.match(script,/visibleCache && visibleCache\.entries === state\.entries/);
});


test('v0.1.16 只禁用虚拟文件区的滚动锚定，保留原生滚动与正常列表', () => {
  assert.match(script, /#ufs-app \.ufs-list\.ufs-virtualized\{overflow-anchor:none\}/);
  assert.match(script, /#ufs-app \.ufs-list\{min-width:0;min-height:0;overflow:auto;flex:1/);
  assert.match(script, /#ufs-app \.ufs-list,#ufs-app \.ufs-sidebar,#ufs-app \.ufs-inspector\{overscroll-behavior:contain\}/);
  assert.match(script, /list\.addEventListener\('scroll', \(\) => \{/);
  assert.match(script, /'\#ufs-app \.ufs-virtual-spacer\{height:0/);
  assert.doesNotMatch(script, /#ufs-app \.ufs-sidebar\{overflow-anchor:none/);
  assert.doesNotMatch(script, /addEventListener\('wheel'/);
});


test('v0.2.2 仍是纯用户脚本，复制、移动及删除等写入操作未开放', () => {
  const { api } = createAPI();
  assert.equal(api.FILE_WRITES_ENABLED, false);
  assert.match(script, /const FILE_WRITES_ENABLED = false/);
  assert.equal(api.CREATE_FOLDER_ENABLED, true);
  assert.equal(api.RENAME_ENABLED, true);
  assert.match(script, /mode: 'file', action: '0'/);
  assert.match(script, /const NATIVE_CONTROL_URL = '\/webGui\/include\/Control\.php'/);
  assert.doesNotMatch(script, /fetch\([^)]*Control\.php/);
  assert.doesNotMatch(script, /GM_xmlhttpRequest|@require/);
});

test('v0.2.0 写入路径比只读浏览更严格，禁止双重 URL 解码和原生任务分隔符', () => {
  const { api } = createAPI();
  assert.equal(api.safeWritePath('/mnt/user/TimeMachine', true), true);
  assert.equal(api.safeWritePath('/mnt/user/TimeMachine'), false);
  assert.equal(api.safeWritePath('/mnt/user/TimeMachine/照片 1.jpg'), true);
  assert.equal(api.safeWriteName('新建文件夹'), true);
  for (const name of ['', '.', '..', '../x', 'a/b', 'a\\b', '%2e%2e', '测试%25',
    ' bad', 'bad ', 'x\rhidden', 'x\nhidden', 'x\0hidden']) {
    assert.equal(api.safeWriteName(name), false, JSON.stringify(name));
  }
  for (const path of ['/mnt/user', '/mnt/user/', '/mnt/user//folder', '/mnt/user/share/../etc',
    '/mnt/user/share/./file', '/mnt/user/share/file%2fname', '/mnt/user/share/x\rhidden',
    '/mnt/disk1/share/file', '/mnt/user/share/file\\name']) {
    assert.equal(api.safeWritePath(path, true), false, JSON.stringify(path));
  }
});

test('v0.2.0 新建与重命名预览保留 /mnt/user 边界、默认拒绝覆盖', () => {
  const { api } = createAPI();
  const mkdir = api.planFileOperation({type:'mkdir',parent:'/mnt/user/TimeMachine',name:'新目录'});
  assert.equal(mkdir.target, '/mnt/user/TimeMachine/新目录');
  assert.equal(mkdir.source, '/mnt/user/TimeMachine');
  assert.equal(mkdir.previewOnly, true);
  assert.equal(Object.isFrozen(mkdir),true);

  const rename = api.planFileOperation({
    type:'rename',source:'/mnt/user/TimeMachine/notes.txt',folder:false,name:'新名称.txt'
  });
  assert.equal(rename.target,'/mnt/user/TimeMachine/新名称.txt');
  assert.throws(()=>api.planFileOperation({type:'rename',
    source:'/mnt/user/TimeMachine',folder:true,name:'new'}),/只能操作共享文件夹内/);
  assert.throws(()=>api.planFileOperation({type:'rename',
    source:'/mnt/user/TimeMachine/notes.txt',folder:false,name:'notes.txt'}),/相同/);
  assert.throws(()=>api.planFileOperation({type:'mkdir',
    parent:'/mnt/user/TimeMachine',name:'x',conflictPolicy:'overwrite'}),/不允许覆盖/);
  assert.throws(()=>api.planFileOperation({type:'unknown'}),/不支持/);
});

test('v0.2.0 复制、移动、删除仅生成预览并拦截目录套娃及共享根操作', () => {
  const { api } = createAPI();
  const copy = api.planFileOperation({
    type:'copy',source:'/mnt/user/downloads/zip',destinationDir:'/mnt/user/TimeMachine',folder:true
  });
  assert.equal(copy.target,'/mnt/user/TimeMachine/zip');
  assert.equal(copy.conflictPolicy,'fail');
  const del=api.planFileOperation({type:'delete',source:'/mnt/user/TimeMachine/old.txt',folder:false});
  assert.equal(del.target,'');
  for (const type of ['copy','move']) {
    assert.throws(()=>api.planFileOperation({
      type,source:'/mnt/user/downloads/dir',folder:true,destinationDir:'/mnt/user/downloads/dir/sub'
    }),/目录复制或移动到其内部/);
    assert.throws(()=>api.planFileOperation({
      type,source:'/mnt/user/downloads/dir',folder:true,destinationDir:'/mnt/user/downloads'
    }),/源和目标不能相同/);
  }
  assert.throws(()=>api.planFileOperation({
    type:'delete',source:'/mnt/user/downloads',folder:true
  }),/只能操作共享文件夹内/);
  assert.throws(()=>api.planFileOperation({
    type:'move',source:'/mnt/user/downloads/x',destinationDir:'/mnt/user/TimeMachine'
  }),/必须明确/);
});

test('v0.2.0 原生请求仅生成描述，不会主动提交任何网络操作', () => {
  const { api } = createAPI();
  const input=[
    [{type:'mkdir',parent:'/mnt/user/downloads',name:'new'},0,'/mnt/user/downloads','new'],
    [{type:'rename',source:'/mnt/user/downloads/dir',folder:true,name:'renamed'},2,'/mnt/user/downloads/dir','renamed'],
    [{type:'rename',source:'/mnt/user/downloads/a.txt',folder:false,name:'b.txt'},7,'/mnt/user/downloads/a.txt','b.txt'],
    [{type:'copy',source:'/mnt/user/downloads/dir',folder:true,destinationDir:'/mnt/user/TimeMachine'},3,'/mnt/user/downloads/dir','/mnt/user/TimeMachine'],
    [{type:'copy',source:'/mnt/user/downloads/a.txt',folder:false,destinationDir:'/mnt/user/TimeMachine'},8,'/mnt/user/downloads/a.txt','/mnt/user/TimeMachine'],
    [{type:'move',source:'/mnt/user/downloads/dir',folder:true,destinationDir:'/mnt/user/TimeMachine'},4,'/mnt/user/downloads/dir','/mnt/user/TimeMachine'],
    [{type:'move',source:'/mnt/user/downloads/a.txt',folder:false,destinationDir:'/mnt/user/TimeMachine'},9,'/mnt/user/downloads/a.txt','/mnt/user/TimeMachine'],
    [{type:'delete',source:'/mnt/user/downloads/dir',folder:true},1,'/mnt/user/downloads/dir',''],
    [{type:'delete',source:'/mnt/user/downloads/a.txt',folder:false},6,'/mnt/user/downloads/a.txt','']
  ];
  for (const [inputSpec,action,source,target] of input) {
    const native=api.previewNativeOperationRequest(api.planFileOperation(inputSpec));
    assert.equal(native.method,'POST');
    assert.equal(native.mode,'file');
    assert.equal(native.endpoint,'/webGui/include/Control.php');
    assert.equal(native.action,action);
    assert.equal(native.source,source);
    assert.equal(native.target,target);
    assert.equal(native.taskEvents,'/sub/filemanager');
    assert.equal(native.requiresCsrfToken,true);
    assert.equal(native.globallySharedTask,true);
    assert.equal(native.previewOnly,true);
  }
});

test('v0.2.0 模拟任务必须先确认；运行期间只能单任务，不能取消或插队', async () => {
  const { api } = createAPI();
  let finish;
  const runner=api.createFileOperationCoordinator(()=>new Promise(resolve=>{finish=resolve;}));
  assert.equal(runner.snapshot().status,'idle');
  assert.equal(runner.review({type:'mkdir',parent:'/mnt/user/downloads',name:'test'}).status,
    'awaiting-confirmation');
  await assert.rejects(runner.confirm(false),/明确确认/);
  const running=runner.confirm(true);
  assert.equal(runner.snapshot().status,'running');
  assert.equal(runner.cancel(),false);
  assert.throws(()=>runner.review({type:'mkdir',parent:'/mnt/user/downloads',name:'other'}),/正在执行/);
  finish({simulated:true});
  const done=await running;
  assert.equal(done.status,'completed');
  assert.equal(done.result.simulated,true);
  assert.equal(runner.snapshot().status,'completed');
  await assert.rejects(runner.confirm(true),/没有等待确认/);
});

test('v0.2.0 模拟失败可恢复，且没有模拟执行器时拒绝确认', async () => {
  const { api } = createAPI();
  const blocked=api.createFileOperationCoordinator();
  blocked.review({type:'mkdir',parent:'/mnt/user/downloads',name:'test'});
  await assert.rejects(blocked.confirm(true),/禁止向真实 NAS 提交文件写入/);
  assert.equal(blocked.snapshot().status,'awaiting-confirmation');
  assert.equal(blocked.cancel(),true);
  assert.equal(blocked.snapshot().status,'idle');

  const runner=api.createFileOperationCoordinator(async ()=>{throw Error('模拟任务失败');});
  runner.review({type:'rename',source:'/mnt/user/downloads/a',folder:false,name:'b'});
  const failed=await runner.confirm(true);
  assert.equal(failed.status,'failed');
  assert.match(failed.error,/模拟任务失败/);
  assert.equal(runner.review({type:'mkdir',parent:'/mnt/user/downloads',name:'retry'}).status,
    'awaiting-confirmation');
});


test('v0.2.1 文件名限制危险字符和 UTF-8 字节边界', () => {
  const {api}=createAPI();
  assert.equal(api.FILE_WRITES_ENABLED,false);
  assert.equal(api.CREATE_FOLDER_ENABLED,true);
  assert.equal(api.safeWriteName('中'.repeat(85)),true);
  assert.equal(api.safeWriteName('中'.repeat(86)),false);
  for (const name of ['a"b',"a'b",'a&b','a<b','a>b','a;b','x%20','x\rtask','folder/child','\ud800']) {
    assert.equal(api.safeWriteName(name),false,JSON.stringify(name));
  }
  assert.equal(api.safeWritePath('/mnt/user/TimeMachine/新建文件夹'),true);
  assert.equal(api.safeWritePath('/mnt/user/TimeMachine/a"b'),false);
});

test('v0.2.1 原生任务读取格式及任务身份匹配', () => {
  const {api}=createAPI();
  assert.equal(api.parseNativeActive(''),null);
  assert.throws(()=>api.parseNativeActive('<html>login</html>'),/状态格式异常/);
  assert.throws(()=>api.parseNativeActive('{"action":0}'),/状态不完整/);
  const task=api.parseNativeActive('{"action":"0","source":"/mnt/user/downloads","target":"新目录"}');
  assert.equal(api.matchesCreateTask(task,{source:'/mnt/user/downloads',name:'新目录'}),true);
  assert.equal(api.matchesCreateTask(task,{source:'/mnt/user/downloads',name:'other'}),false);
  assert.equal(api.matchesCreateTask({...task,action:6},{source:'/mnt/user/downloads',name:'新目录'}),false);
});

test('v0.2.1 未经列表验证即使 HTTP 200 也不报告成功', async () => {
  const modes=[];
  const {api}=createAPI({fetch:async(url,opts)=>{
    assert.equal(url,'/webGui/include/Control.php');
    assert.equal(opts.method,'POST');
    assert.equal(opts.credentials,'same-origin');
    const body=new URLSearchParams(opts.body);
    modes.push(body.get('mode'));
    assert.equal(body.get('csrf_token'),'test-csrf');
    if(body.get('mode')==='file') {
      assert.equal(body.get('action'),'0');
      assert.equal(decodeURIComponent(body.get('source')),'/mnt/user/downloads');
      assert.equal(decodeURIComponent(body.get('target')),'测试文件夹');
    }
    return {ok:true,text:async()=>''};
  }});
  const plan=api.planFileOperation({type:'mkdir',parent:'/mnt/user/downloads',name:'测试文件夹'});
  await assert.rejects(api.createNativeFolder(plan),/结果不确定.*无法在目标目录确认/);
  assert.deepEqual(modes,['read','file','read','read']);
});

test('v0.2.1 原生任务占用与缺失 CSRF 均在写入前拦截', async () => {
  const modes=[];
  const mock=async(_url,opts)=>{
    const mode=new URLSearchParams(opts.body).get('mode');
    modes.push(mode);
    return {ok:true,text:async()=>JSON.stringify({action:'6',source:'/mnt/user/downloads/a',target:''})};
  };
  const plan={type:'mkdir',parent:'/mnt/user/downloads',name:'test'};
  const {api}=createAPI({fetch:mock});
  await assert.rejects(api.createNativeFolder(api.planFileOperation(plan)),/正在执行其他原生文件任务/);
  assert.deepEqual(modes,['read']);
  const {api:missing}=createAPI({fetch:mock,csrfToken:null});
  await assert.rejects(missing.createNativeFolder(missing.planFileOperation(plan)),/CSRF Token/);
  assert.deepEqual(modes,['read']);
});


test('v0.2.1.1 弹窗样式分为标题、表单、底部操作区且不影响文件操作', () => {
  assert.match(script,/ufs-create-fields/);
  assert.match(script,/form\.append\(fields, buttons\)/);
  assert.match(script,/nameSection\.append\(feedback\)/);
  assert.match(script,/#ufs-app \.ufs-create-head\{[^}]*border-bottom:1px/);
  assert.match(script,/#ufs-app \.ufs-create-location\{[^}]*background:var\(--ufs-panel\)/);
  assert.match(script,/#ufs-app \.ufs-create-input:focus\{[^}]*border-color:var\(--ufs-accent\)/);
  assert.match(script,/#ufs-app \.ufs-create-buttons\{[^}]*border-top:1px/);
  assert.match(script,/input\.select\(\)/);
  assert.match(script,/await createNativeFolder\(plan/);
  assert.equal(createAPI().api.CREATE_FOLDER_ENABLED,true);
});


test('v0.2.2 重命名仅允许单个 Share 内项目，默认禁止覆盖与非法路径', () => {
  const {api}=createAPI();
  assert.equal(api.RENAME_ENABLED,true);
  const file=api.planFileOperation({type:'rename',source:'/mnt/user/downloads/file.txt',name:'new.txt',folder:false});
  assert.equal(file.target,'/mnt/user/downloads/new.txt');
  assert.equal(api.previewNativeOperationRequest(file).action,7);
  const folder=api.planFileOperation({type:'rename',source:'/mnt/user/downloads/old',name:'new',folder:true});
  assert.equal(api.previewNativeOperationRequest(folder).action,2);
  for(const spec of [
    {source:'/mnt/user/downloads',folder:true,name:'renamed'},
    {source:'/mnt/user/downloads/old',folder:true,name:'old'},
    {source:'/mnt/user/downloads/old',folder:true,name:'../outside'},
    {source:'/mnt/user/downloads/old',folder:true,name:'x"bad'},
  ]) assert.throws(()=>api.planFileOperation({type:'rename',...spec}),/只能|不能|无效|相同|不安全/);
  assert.throws(()=>api.planFileOperation({type:'rename',source:'/mnt/user/downloads/a.txt',
    name:'b.txt',folder:false,conflictPolicy:'overwrite'}),/不允许覆盖/);
});

test('v0.2.2 仅高亮主文件名，目录和隐藏文件选择完整名称',()=>{
  const {api}=createAPI();
  assert.equal(api.renameSelectionEnd('photo.raw',false),5);
  assert.equal(api.renameSelectionEnd('backup.tar.gz',false),10);
  assert.equal(api.renameSelectionEnd('.env',false),4);
  assert.equal(api.renameSelectionEnd('README',false),6);
  assert.equal(api.renameSelectionEnd('dir.with.dot',true),12);
});

test('v0.2.2 只替换路径组件前缀，不误伤名称相似的目录',()=>{
  const {api}=createAPI();
  const f=path=>api.remapPathPrefix(path,'/mnt/user/downloads/Movies','/mnt/user/downloads/Films');
  assert.equal(f('/mnt/user/downloads/Movies'),'/mnt/user/downloads/Films');
  assert.equal(f('/mnt/user/downloads/Movies/2026/a.txt'),'/mnt/user/downloads/Films/2026/a.txt');
  assert.equal(f('/mnt/user/downloads/Movies-Backup'),'/mnt/user/downloads/Movies-Backup');
  assert.equal(f('/mnt/user/downloads/Movies2/sub'),'/mnt/user/downloads/Movies2/sub');
});

test('v0.2.2 模拟重命名请求包含 CSRF 和 action 7，并在目录确认后成功', async()=>{
  const calls=[];
  const {api,sandbox}=createAPI({fetch:async(_url,opts)=>{
    const data=new URLSearchParams(opts.body);calls.push(data.get('mode'));
    assert.equal(data.get('csrf_token'),'test-csrf');
    if(data.get('mode')==='file'){
      assert.equal(data.get('action'),'7');
      assert.equal(decodeURIComponent(data.get('source')),'/mnt/user/downloads/old.txt');
      assert.equal(decodeURIComponent(data.get('target')),'new.txt');
      sandbox.window.__UFS_DEMO__['/mnt/user/downloads']=[{name:'new.txt',folder:false}];
    }
    return {ok:true,text:async()=>''};
  }});
  sandbox.window.__UFS_DEMO__['/mnt/user/downloads']=[{name:'old.txt',folder:false}];
  const plan=api.planFileOperation({type:'rename',source:'/mnt/user/downloads/old.txt',folder:false,name:'new.txt'});
  const result=await api.renameNativeEntry(plan);
  assert.equal(result.name,'new.txt');
  assert.deepEqual(calls,['read','file','read','read']);
});

test('v0.2.2 目标冲突或源丢失必须在写入前拒绝',async()=>{
  const requests=[];
  const {api,sandbox}=createAPI({fetch:async(_url,opts)=>{
    requests.push(new URLSearchParams(opts.body).get('mode'));
    return {ok:true,text:async()=>''};
  }});
  const data=sandbox.window.__UFS_DEMO__;
  data['/mnt/user/downloads']=[{name:'old.txt',folder:false},{name:'new.txt',folder:false}];
  const plan=api.planFileOperation({type:'rename',source:'/mnt/user/downloads/old.txt',folder:false,name:'new.txt'});
  await assert.rejects(api.renameNativeEntry(plan),/目标名称已存在/);
  assert.deepEqual(requests,[]);
  data['/mnt/user/downloads']=[{name:'other.txt',folder:false}];
  await assert.rejects(api.renameNativeEntry(plan),/已不存在/);
  assert.deepEqual(requests,[]);
});

test('v0.2.2 未观察到重命名结果不得误报成功或自动重新发起请求',async()=>{
  const requests=[];
  const {api,sandbox}=createAPI({fetch:async(_url,opts)=>{
    const body=new URLSearchParams(opts.body);requests.push(body.get('mode'));
    return {ok:true,text:async()=>''};
  }});
  sandbox.window.__UFS_DEMO__['/mnt/user/downloads']=[{name:'old.txt',folder:false}];
  const plan=api.planFileOperation({type:'rename',source:'/mnt/user/downloads/old.txt',folder:false,name:'new.txt'});
  await assert.rejects(api.renameNativeEntry(plan),/结果不确定/);
  assert.deepEqual(requests,['read','file','read','read']);
});

test('v0.2.2 原生任务签名区分文件及文件夹的重命名',()=>{
  const {api}=createAPI();
  const task={action:'2',source:'/mnt/user/downloads/old',target:'new'};
  assert.equal(api.matchesRenameTask(task,{source:task.source,name:'new',folder:true}),true);
  assert.equal(api.matchesRenameTask(task,{source:task.source,name:'new',folder:false}),false);
  assert.equal(api.matchesRenameTask({...task,target:'other'},{source:task.source,name:'new',folder:true}),false);
});


test('v0.2.2 单个 UserScript 写入锁阻止新建文件夹与重命名并发', async () => {
  let unblock;
  let entered;
  const started=new Promise(resolve=>{entered=resolve;});
  const gate=new Promise(resolve=>{unblock=resolve;});
  const modes=[];
  const {api,sandbox}=createAPI({fetch:async(_url,opts)=>{
    const mode=new URLSearchParams(opts.body).get('mode');
    modes.push(mode);
    if(mode==='read') { entered(); await gate; }
    return {ok:true,text:async()=>''};
  }});
  sandbox.window.__UFS_DEMO__['/mnt/user/downloads']=[{name:'old.txt',folder:false}];
  const rename=api.planFileOperation({type:'rename',source:'/mnt/user/downloads/old.txt',name:'new.txt',folder:false});
  const active=api.renameNativeEntry(rename);
  await started;
  const mkdir=api.planFileOperation({type:'mkdir',parent:'/mnt/user/downloads',name:'new-folder'});
  await assert.rejects(api.createNativeFolder(mkdir),/已有文件操作正在执行/);
  assert.deepEqual(modes,['read']);
  unblock();
  await assert.rejects(active,/结果不确定/);
  assert.equal(modes.filter(v=>v==='file').length,1);
});


test('v0.2.2.1 仅接管 Browse 页面 filemonitor，不覆盖 Unraid 全局 refresh',()=>{
  assert.match(script,/function takeOverNativeFileMonitor\(/);
  assert.match(script,/if \(isDemo \|\| !browsePage \|\| !app\?\.isConnected/);
  assert.match(script,/native\.start = function ufsPausedNativeFileMonitorStart\(\)/);
  assert.match(script,/native\.stop\(\)/);
  assert.match(script,/new window\.NchanSubscriber\(NATIVE_CHANGE_EVENTS/);
  assert.match(script,/const value = String\(raw\)\.trim\(\)/);
  assert.match(script,/if \(value === '1'\)/);
  assert.match(script,/else if \(value === '0' && sawExternalTask\)/);
  assert.match(script,/if \(localWriteInProgress\(\)\) return/);
  assert.match(script,/void refreshDirectory\(\)/);
  assert.doesNotMatch(script,/(?:window\.)?refresh\s*=\s*function/);
});


test('v0.2.3 复制计划仅允许单项和真实共享目录，阻止源父目录及递归目标',()=>{
  const {api}=createAPI();
  assert.equal(api.COPY_ENABLED,true);
  const src='/mnt/user/TimeMachine/Photos';
  const good=api.planFileOperation({type:'copy',source:src,destinationDir:'/mnt/user/downloads',folder:true});
  assert.equal(good.target,'/mnt/user/downloads/Photos');
  assert.equal(api.nativeCopyTarget(good),'/mnt/user/downloads/');
  assert.equal(api.previewNativeOperationRequest(good).action,3);
  assert.equal(api.copyDestinationAllowed(good,'/mnt/user/downloads'),true);
  assert.equal(api.copyDestinationAllowed(good,'/mnt/user/TimeMachine'),false);
  assert.equal(api.copyDestinationAllowed(good,src),false);
  assert.equal(api.copyDestinationAllowed(good,src+'/child'),false);
  assert.equal(api.copyDestinationAllowed(good,'/mnt/user'),false);
  for(const target of ['/mnt/user/TimeMachine','/mnt/user/TimeMachine/Photos',
    '/mnt/user/TimeMachine/Photos/sub','/mnt/disk1', '/mnt/user']) {
    assert.throws(()=>api.planFileOperation({type:'copy',source:src,destinationDir:target,folder:true}),
      /不能|无效|相同|文件夹/);
  }
  const file=api.planFileOperation({type:'copy',source:'/mnt/user/TimeMachine/notes.txt',
    destinationDir:'/mnt/user/downloads',folder:false});
  assert.equal(api.previewNativeOperationRequest(file).action,8);
  assert.equal(api.nativeCopyTarget(file),'/mnt/user/downloads/');
  assert.equal(api.copyDestinationAllowed(file,'/mnt/user/TimeMachine'),false);
});

test('v0.2.3 原生文件/目录复制 action、源路径和目标目录带末尾斜杠',()=>{
  const {api}=createAPI();
  const file={type:'copy',source:'/mnt/user/a/test.txt',destinationDir:'/mnt/user/b',folder:false};
  assert.equal(api.matchesCopyTask({action:'8',source:file.source,target:'/mnt/user/b/'},file),true);
  assert.equal(api.matchesCopyTask({action:'8',source:file.source+'/',target:'/mnt/user/b/'},file),false);
  assert.equal(api.matchesCopyTask({action:'3',source:file.source,target:'/mnt/user/b/'},file),false);
  const folder={...file,folder:true};
  assert.equal(api.matchesCopyTask({action:'3',source:file.source,target:'/mnt/user/b/'},folder),true);
});

test('v0.2.3 复制目标冲突与源文件消失时不允许提交文件操作',async()=>{
  const modes=[];
  const {api,sandbox}=createAPI({fetch:async(_url,opts)=>{
    modes.push(new URLSearchParams(opts.body).get('mode'));
    return {ok:true,text:async()=>''};
  }});
  const demo=sandbox.window.__UFS_DEMO__;
  demo['/mnt/user/a']=[{name:'data.bin',folder:false}];
  demo['/mnt/user/b']=[{name:'data.bin',folder:false}];
  const plan=api.planFileOperation({type:'copy',source:'/mnt/user/a/data.bin',
    destinationDir:'/mnt/user/b',folder:false});
  await assert.rejects(api.copyNativeEntry(plan),/已有同名项目/);
  assert.deepEqual(modes,[]);
  demo['/mnt/user/b']=[];
  demo['/mnt/user/a']=[];
  await assert.rejects(api.copyNativeEntry(plan),/已不存在/);
  assert.deepEqual(modes,[]);
});

test('v0.2.3 复制 HTTP 200 但未观察到原生任务，不得凭目录出现误报成功',async()=>{
  const modes=[];
  const {api,sandbox}=createAPI({fetch:async(_url,opts)=>{
    const data=new URLSearchParams(opts.body);
    modes.push(data.get('mode'));
    if(data.get('mode')==='file'){
      assert.equal(data.get('action'),'8');
      assert.equal(decodeURIComponent(data.get('source')),'/mnt/user/a/data.bin');
      assert.equal(decodeURIComponent(data.get('target')),'/mnt/user/b/');
      sandbox.window.__UFS_DEMO__['/mnt/user/b']=[{name:'data.bin',folder:false}];
    }
    return {ok:true,text:async()=>''};
  }});
  const demo=sandbox.window.__UFS_DEMO__;
  demo['/mnt/user/a']=[{name:'data.bin',folder:false}];
  demo['/mnt/user/b']=[];
  const plan=api.planFileOperation({type:'copy',source:'/mnt/user/a/data.bin',
    destinationDir:'/mnt/user/b',folder:false});
  await assert.rejects(api.copyNativeEntry(plan),/结果不确定.*无法确认原生复制任务已执行完毕/);
  assert.equal(modes.filter(mode=>mode==='file').length,1);
});

test('v0.2.3 复制观察原生任务完成后核对目录并保留源文件',async()=>{
  const modes=[];
  let progressCount=0;
  const {api,sandbox}=createAPI({fetch:async(_url,opts)=>{
    const body=new URLSearchParams(opts.body);
    const mode=body.get('mode');
    modes.push(mode);
    if(mode==='read'){
      if(++progressCount===2)return {ok:true,text:async()=>JSON.stringify({
        action:'8',source:'/mnt/user/a/data.bin',target:'/mnt/user/b/'})};
    }
    if(mode==='file'){
      assert.equal(body.get('csrf_token'),'test-csrf');
      assert.equal(body.get('action'),'8');
      sandbox.window.__UFS_DEMO__['/mnt/user/b']=[{name:'data.bin',folder:false}];
    }
    return {ok:true,text:async()=>''};
  }});
  const demo=sandbox.window.__UFS_DEMO__;
  demo['/mnt/user/a']=[{name:'data.bin',folder:false}];
  demo['/mnt/user/b']=[];
  const plan=api.planFileOperation({type:'copy',source:'/mnt/user/a/data.bin',
    destinationDir:'/mnt/user/b',folder:false});
  const result=await api.copyNativeEntry(plan);
  assert.equal(result.path,'/mnt/user/b/data.bin');
  assert.equal(demo['/mnt/user/a'].length,1);
  assert.equal(modes.filter(x=>x==='file').length,1);
});

test('v0.2.3 复制与重命名复用写入锁，第二个操作不触发 Control.php',async()=>{
  let entered;
  let unlock;
  const start=new Promise(resolve=>{entered=resolve;});
  const gate=new Promise(resolve=>{unlock=resolve;});
  const modes=[];
  const {api,sandbox}=createAPI({fetch:async(_url,opts)=>{
    const mode=new URLSearchParams(opts.body).get('mode');
    modes.push(mode);
    if(mode==='read'){entered();await gate;}
    return {ok:true,text:async()=>''};
  }});
  const demo=sandbox.window.__UFS_DEMO__;
  demo['/mnt/user/a']=[{name:'data.bin',folder:false}];
  demo['/mnt/user/b']=[];
  const plan=api.planFileOperation({type:'copy',source:'/mnt/user/a/data.bin',
    destinationDir:'/mnt/user/b',folder:false});
  const active=api.copyNativeEntry(plan);
  await start;
  const second=api.planFileOperation({type:'mkdir',parent:'/mnt/user/b',name:'new'});
  await assert.rejects(api.createNativeFolder(second),/已有文件操作正在执行/);
  assert.deepEqual(modes,['read']);
  unlock();
  await assert.rejects(active,/结果不确定/);
});


test('v0.2.3 文件复制完成但大小与源文件不一致时不能报告成功',async()=>{
  let reads=0;
  const {api,sandbox}=createAPI({fetch:async(_url,opts)=>{
    const b=new URLSearchParams(opts.body);
    if(b.get('mode')==='read' && ++reads===2) return {
      ok:true,text:async()=>JSON.stringify({
        action:8,source:'/mnt/user/a/data.bin',target:'/mnt/user/b/'})
    };
    if(b.get('mode')==='file'){
      sandbox.window.__UFS_DEMO__['/mnt/user/b']=[{name:'data.bin',folder:false,size:99}];
    }
    return {ok:true,text:async()=>''};
  }});
  sandbox.window.__UFS_DEMO__['/mnt/user/a']=[{name:'data.bin',folder:false,size:1024}];
  sandbox.window.__UFS_DEMO__['/mnt/user/b']=[];
  const plan=api.planFileOperation({type:'copy',source:'/mnt/user/a/data.bin',
    destinationDir:'/mnt/user/b',folder:false});
  await assert.rejects(api.copyNativeEntry(plan),/结果不确定.*大小与源文件不一致/);
});


test('v0.2.3.1 复制目录选择器按钮独立覆盖 Unraid 的最小宽度与 margin',()=>{
  assert.match(script,/#ufs-app \.ufs-copy-tree-row\{[^}]*height:32px/);
  assert.match(script,/#ufs-app \.ufs-copy-expand\{[^}]*width:24px;min-width:24px;max-width:24px/);
  assert.match(script,/#ufs-app \.ufs-copy-expand\{[^}]*margin:0;padding:0/);
  assert.match(script,/#ufs-app \.ufs-copy-choose\{[^}]*min-width:0;max-width:calc\(100% - 55px\);height:30px/);
  assert.match(script,/#ufs-app \.ufs-copy-choose\{[^}]*margin:0;padding:4px 7px/);
  assert.match(script,/expand\.addEventListener\('click',/);
  assert.match(script,/choose\.addEventListener\('click',/);
});


test('v0.2.3.2 动画仅显示不确定进度、提供三阶段和减少动态效果支持',()=>{
  assert.match(script,/ufs-copy-progress-panel/);
  assert.match(script,/ufs-copy-progress-spinner/);
  assert.match(script,/@keyframes ufs-copy-flow/);
  assert.match(script,/@keyframes ufs-copy-spin/);
  assert.match(script,/@media\(prefers-reduced-motion:reduce\)/);
  assert.match(script,/track\.setAttribute\('role','progressbar'\)/);
  assert.match(script,/aria-label',\(isMove\?'移动任务进行中，进度未知':'复制任务进行中，进度未知'\)/);
  assert.match(script,/track\.setAttribute\('aria-valuenow','100'\)/);
  assert.match(script,/showCopyFields\(summary,progressPanel\)/);
  assert.match(script,/renderCopyProgress\('success',outcome\.copyOutcome/);
  assert.match(script,/renderCopyProgress\('uncertain',message\)/);
  assert.match(script,/showCopyFields\(summary,location\)/);
  assert.doesNotMatch(script,/await waitNative\(850\)/);
});

test('v0.2.3.2 复制阶段由原生任务流程发出，不虚构完成比例',async()=>{
  let reads=0;
  const observed=[];
  const {api,sandbox}=createAPI({fetch:async(_url,opts)=>{
    const data=new URLSearchParams(opts.body);
    if(data.get('mode')==='read' && ++reads===2) {
      return {ok:true,text:async()=>JSON.stringify({
        action:8,source:'/mnt/user/a/report.txt',target:'/mnt/user/b/'
      })};
    }
    if(data.get('mode')==='file') {
      sandbox.window.__UFS_DEMO__['/mnt/user/b']=[{name:'report.txt',folder:false,size:100}];
    }
    return {ok:true,text:async()=>''};
  }});
  sandbox.window.__UFS_DEMO__['/mnt/user/a']=[{name:'report.txt',folder:false,size:100}];
  sandbox.window.__UFS_DEMO__['/mnt/user/b']=[];
  const plan=api.planFileOperation({type:'copy',source:'/mnt/user/a/report.txt',
    destinationDir:'/mnt/user/b',folder:false});
  await api.copyNativeEntry(plan,(text,phase)=>observed.push({text,phase}));
  assert.deepEqual(observed.map(x=>x.phase),['checking','copying','verifying']);
  assert.match(observed[0].text,/检查/);
  assert.match(observed[2].text,/核对/);
});


test('v0.2.3.3 rsync 八进制转义按 UTF-8 还原且不更改异常字节',()=>{
  const {api}=createAPI();
  assert.equal(api.decodeRsyncFilename('中文\\#344\\#270\\#255.txt'),'中文中.txt');
  assert.equal(api.decodeRsyncFilename('\\#344\\#270\\#255\\#346\\#226\\#207.jpg'),'中文.jpg');
  assert.equal(api.decodeRsyncFilename('\\#377\\#377.dat'),'\\#377\\#377.dat');
  assert.equal(api.shortenCopyName('testing.bin',90),'testing.bin');
});

test('v0.2.3.3 解析 rsync progress2 原始行的真实百分比速度 ETA 和文件名',()=>{
  const {api}=createAPI();
  const progress=api.parseRsyncProgress(
    '<i class="fa fa-spin"></i>Copying... mnt/user/downloads/\\#344\\#270\\#255\\#346\\#226\\#207.jpg'+
    '\n 10,485,760  42%  5.10MB/s  0:00:06 (xfr#1, to-chk=3/5)');
  assert.equal(progress.percent,42);
  assert.equal(progress.bytes,10485760);
  assert.equal(progress.speed,'5.10MB/s');
  assert.equal(progress.eta,'0:00:06');
  assert.equal(progress.filename,'mnt/user/downloads/中文.jpg');
  assert.equal(api.parseRsyncProgress('Copying... file.txt').percent,null);
  assert.equal(api.parseRsyncProgress('Done').percent,null);
});


test('复制状态 JSON 的 text 解包、中文文件名与状态消息隔离',()=>{
  const {api}=createAPI();
  const wrapped=api.parseRsyncProgress(JSON.stringify({
    action:8,text:[
      '<i class="fa fa-spin"></i>Copying... /mnt/user/downloads/\\#344\\#270\\#255\\#346\\#226\\#207.jpg',
      '10,485,760  42%  5.10MB/s  0:00:06 (xfr#1, to-chk=3/5)'
    ]
  }));
  assert.equal(wrapped.filename,'/mnt/user/downloads/中文.jpg');
  assert.equal(wrapped.percent,42);
  assert.equal(wrapped.speed,'5.10MB/s');
  assert.equal(wrapped.eta,'0:00:06');
  assert.doesNotMatch(wrapped.filename,/["}\]]/);
  assert.equal(api.parseRsyncProgress('Copying... file.txt').filename,'file.txt');
  for(const raw of [
    'Done',
    JSON.stringify({action:8,text:['Done']}),
    JSON.stringify({action:8,text:'Done'}),
    JSON.stringify({action:8,text:['Starting...']}),
    JSON.stringify({action:8,source:'/mnt/user/data'}),
    '{invalid-json',
    'Task completed successfully'
  ]) {
    const info=api.parseRsyncProgress(raw);
    assert.equal(info.filename,'','不应把状态消息识别为文件名：'+raw);
    assert.equal(info.percent,null,'没有真实 rsync 进度时不应制造百分比：'+raw);
  }
});

test('切换到完成核对等非复制阶段时清除过期文件名和传输指标',()=>{
  assert.match(script,/if\(phase!=='copying'\)\s*\{\s*progressFile\.textContent='';\s*progressFile\.removeAttribute\('title'\);/);
  assert.match(script,/speedValue\.textContent=phase==='success'\?'已完成':'—'/);
  assert.match(script,/etaValue\.textContent='—'/);
  assert.match(script,/transferValue\.textContent=''/);
  assert.match(script,/lastCopyTransferred=''/);
  assert.match(script,/lastCopyEta=''/);
});

test('v0.2.3.3 取消任务需持有当前写入锁，拒绝未归属的全局停止',async()=>{
  let reads=0;
  const actions=[];
  const {api}=createAPI({fetch:async(_url,opts)=>{
    const data=new URLSearchParams(opts.body);
    if(data.get('mode')==='read') ++reads;
    if(data.get('mode')==='file')actions.push(data.get('action'));
    return {ok:true,text:async()=>''};
  }});
  const plan=api.planFileOperation({type:'copy',source:'/mnt/user/a/x.bin',
    destinationDir:'/mnt/user/b',folder:false});
  await assert.rejects(api.requestCancelNativeCopy(plan,{observedOwnTask:true}),/无法确认/);
  assert.equal(reads,0);
  assert.deepEqual(actions,[]);
});

test('v0.2.3.3 后台任务、手动完成与取消确认的保护逻辑存在',()=>{
  assert.match(script,/ufs-copy-task-trigger/);
  assert.match(script,/activeCopySession=copyJob/);
  assert.match(script,/await \(isMove\?moveNativeEntry:copyNativeEntry\)\(plan,updateCopyProgress,control,/);
  assert.match(script,/button\.hidden=copyJobs\.length===0/);
  assert.match(script,/background\.addEventListener\('click',minimize\)/);
  assert.match(script,/Unraid 使用全局停止接口/);
  assert.match(script,/requestCancelNativeCopy\(activeCopySession\.plan,control\)/);
  assert.doesNotMatch(script,/await waitNative\(850\)/);
});


test('v0.2.3.4 真实 rsync -h 输出 557.06K、1.08M、2.50G 可被解析并随进度更新',()=>{
  const {api}=createAPI();
  const samples=[
    ['         32.77K   1%    0.00kB/s    0:00:00  ',1,'32.77K','0.00kB/s','0:00:00'],
    ['        557.06K  17%  500.49kB/s    0:00:05  ',17,'557.06K','500.49kB/s','0:00:05'],
    ['          1.08M  34%  500.24kB/s    0:00:04  ',34,'1.08M','500.24kB/s','0:00:04'],
    ['          2.50G  72%  122.18MB/s    0:00:07  ',72,'2.50G','122.18MB/s','0:00:07'],
    ['          4.19M 100%    1.94GB/s    0:00:00 (xfr#1, to-chk=0/1)',100,'4.19M','1.94GB/s','0:00:00']
  ];
  for(const [line,percent,transferred,speed,eta] of samples){
    const parsed=api.parseRsyncProgress('Copying... /mnt/user/downloads/test.zip\n'+line);
    assert.equal(parsed.percent,percent,line);
    assert.equal(parsed.transferred,transferred,line);
    assert.equal(parsed.speed,speed,line);
    assert.equal(parsed.eta,eta,line);
    assert.equal(parsed.bytes,null,'-h 输出四舍五入的数量，不能宣称精确字节数');
  }
  const exact=api.parseRsyncProgress(' 10,485,760  42%  5.10MB/s  0:00:06');
  assert.equal(exact.bytes,10485760);
  assert.equal(exact.transferred,'10,485,760');
  assert.equal(api.parseRsyncProgress('Copying... test.zip').percent,null);
  assert.equal(api.parseRsyncProgress('Not a progress 250% 40MB/s 0:01:00').percent,null);
});


test('v0.2.3.5 仅未知进度使用流光，真实进度必须纯色且通过宽度表示',()=>{
  assert.match(script,/#ufs-app \.ufs-copy-progress-track\{[^}]*height:8px/);
  assert.match(script,/#ufs-app \.ufs-copy-progress-fill\{[^}]*background:var\(--ufs-accent\)/);
  assert.match(script,/data-progress-mode=indeterminate\] \.ufs-copy-progress-fill\{[^}]*linear-gradient/);
  assert.match(script,/data-progress-mode=determinate\] \.ufs-copy-progress-fill\{[^}]*background:var\(--ufs-accent\);background-image:none;animation:none;transition:width \.2s ease-out/);
  assert.match(script,/progressPanel\.dataset\.progressMode='indeterminate'/);
  assert.match(script,/progressPanel\.dataset\.progressMode='determinate'/);
  assert.match(script,/@media\(prefers-reduced-motion:reduce\)/);
  assert.match(script,/data-progress-mode=determinate\] \.ufs-copy-progress-fill\{transition:none/);
  assert.match(script,/data-phase=success\] \.ufs-copy-progress-fill\{[^}]*background:#34895e/);
  assert.match(script,/fill\.style\.width=info\.percent\+'%'/);
});


test('v0.2.3.6 选中可用目标时展开并懒加载，箭头保留独立折叠语义',()=>{
  assert.match(script,/choose\.addEventListener\('click',\(\)=>\{[\s\S]*?selected=path;[\s\S]*?opened\.add\(path\);[\s\S]*?renderPicker\(\);[\s\S]*?void loadChildren\(path\)/);
  assert.match(script,/expand\.addEventListener\('click',\(\)=>\{[\s\S]*?if\(opened\.has\(path\)\) \{opened\.delete\(path\);renderPicker\(\);\}/);
  assert.match(script,/choose\.disabled=!permitted \|\| busy/);
});


test('v0.2.3.7 复制目的地支持行内新建文件夹且复用安全原生创建接口',()=>{
  assert.match(script,/function beginInlineCreate\(parent\)/);
  assert.match(script,/function confirmInlineCreate\(\)/);
  assert.match(script,/function cancelInlineCreate\(\)/);
  assert.match(script,/icon\('folder-plus'\)/);
  assert.match(script,/planFileOperation\(\{type:'mkdir',parent:draft\.parent,name:draft\.input\.value\}\)/);
  assert.match(script,/await createNativeFolder\(plan,/);
  assert.match(script,/selected=created\.path/);
  assert.match(script,/submit\.disabled=false/);
  assert.match(script,/if\(busy \|\| inlineDraft \|\| mkdirUncertain \|\| submit\.disabled/);
  assert.match(script,/draft\.uncertain=true/);
  assert.match(script,/mkdirUncertain=true/);
  assert.match(script,/const restoreFocus=inlineDraft && !inlineDraft\.busy/);
  assert.match(script,/if\(pending\.get\(path\)===task\) pending\.delete\(path\)/);
});

test('v0.2.3.7 行内目录操作图标紧邻名称并重置原生按钮 CSS',()=>{
  assert.match(script,/#ufs-app \.ufs-copy-mkdir-trigger\{[^}]*min-width:25px/);
  assert.match(script,/#ufs-app \.ufs-copy-inline-row\{[^}]*height:36px/);
  assert.match(script,/#ufs-app \.ufs-copy-inline-input\{[^}]*min-width:40px/);
  assert.match(script,/row\.append\(expand,choose,mkdir\)/);
  assert.match(script,/mkdir\.disabled=busy \|\| nativeWriteBusy \|\| !!inlineDraft \|\| mkdirUncertain/);
});


test('v0.2.3.8 选中目录只有整行高亮，按钮 hover 不再叠加内层背景',()=>{
  assert.match(script,/#ufs-app \.ufs-copy-tree-row\.ufs-copy-selected\{background:rgba\(235,120,37,\.11\)/);
  assert.match(script,/#ufs-app \.ufs-copy-tree-row\.ufs-copy-selected \.ufs-copy-choose\{background:transparent/);
  assert.match(script,/#ufs-app \.ufs-copy-tree-row:not\(\.ufs-copy-selected\):hover\{background:var\(--ufs-hover\)/);
  assert.match(script,/#ufs-app \.ufs-copy-tree-row \.ufs-copy-choose:hover:not\(:disabled\)\{background:transparent\}/);
  assert.match(script,/#ufs-app \.ufs-copy-tree-row\.ufs-copy-selected \.ufs-copy-mkdir-trigger:hover:not\(:disabled\)\{background:transparent\}/);
  assert.doesNotMatch(script,/#ufs-app \.ufs-copy-choose:hover:not\(:disabled\)\{background:var\(--ufs-hover\)/);
});

test('v0.2.3.8 folder-plus 使用官方 Lucide 闭合文件夹与居中十字路径',()=>{
  assert.match(script,/'folder-plus':\['M12 10v6','M9 13h6','M20 20a2 2 0 0 0 2-2V8/);
  assert.doesNotMatch(script,/'folder-plus':\['M3 7a2 2 0 0 1/);
  assert.match(script,/mkdir\.append\(icon\('folder-plus'\)\)/);
});

test('v0.2.3.9 复制目录子文件夹与主文件列表使用相同中文数字排序，共享根保持原有顺序',()=>{
  const {api}=createAPI();
  const names=['folder10','aria2_cache','新建文件夹33','folder2','aria2','folder1'];
  const entries=names.map(name=>({name,folder:true,path:'/mnt/user/downloads/'+name}));
  api.state.entries=[...entries,{name:'note.txt',folder:false,path:'/mnt/user/downloads/note.txt'}];
  const main=Array.from(api.visibleEntries()).filter(item=>item.folder).map(item=>item.name);
  const picker=Array.from(api.sortedCopyFolders('/mnt/user/downloads',entries)).map(item=>item.name);
  assert.deepEqual(picker,main,'复制目标排序必须等于主文件列表的名称升序');
  assert.ok(picker.indexOf('folder2')<picker.indexOf('folder10'),'必须使用 numeric:true');
  assert.deepEqual(entries.map(item=>item.name),names,'不能就地修改 Browse 原始数据');
  const roots=['TimeMachine','appdata','docker','downloads'].map(name=>({
    name,folder:true,path:'/mnt/user/'+name
  }));
  assert.deepEqual(Array.from(api.sortedCopyFolders('/mnt/user',roots),item=>item.name),
    ['TimeMachine','appdata','docker','downloads'],'Share 根顺序不可重新排序');
  assert.deepEqual(Array.from(api.sortedCopyFolders('/mnt/user/downloads',
    [...entries,{name:'note.txt',folder:false,path:'/mnt/user/downloads/note.txt'},
      {name:'invalid',folder:true,path:'/mnt/disk1/invalid'}]),item=>item.name),main,
    '目录选择器仍只展示安全的文件夹路径');
});

test('v0.2.3.9 懒加载、行内新建和异步刷新共用复制目录排序函数',()=>{
  assert.match(script,/nodes\.set\(path, sortedCopyFolders\(path, entries\)\)/);
  assert.match(script,/nodes\.set\(draft\.parent, sortedCopyFolders\(draft\.parent,\s*\[/);
  assert.match(script,/nodes\.set\(draft\.parent, sortedCopyFolders\(draft\.parent, children\)\)/);
});

test('v0.2.3.10 普通 & 的复制路径独立允许，其他写入继续拒绝', () => {
  const {api} = createAPI();
  const names=['[DHR&MakariHoshiyume&VCB-Studio] 1080p.mkv','Folder&A','A&B'];
  for (const name of names) {
    const source='/mnt/user/TimeMachine/'+name;
    assert.equal(api.safeCopyName(name),true,name);
    assert.equal(api.safeCopyPath(source),true,source);
    assert.equal(api.safeWritePath(source),false,'mkdir/rename/move 禁止原有 & 路径');
    const plan=api.planFileOperation({
      type:'copy',source,destinationDir:'/mnt/user/downloads/Media&Archive',folder:false
    });
    assert.equal(plan.source,source);
    assert.equal(plan.target,'/mnt/user/downloads/Media&Archive/'+name);
    assert.equal(api.copyDestinationAllowed(plan,'/mnt/user/downloads/Media&Archive'),true);
    assert.throws(()=>api.planFileOperation({
      type:'rename',source,folder:false,name:'new.mkv'
    }),/只能操作共享文件夹内/);
  }
  assert.equal(api.safeCopyPath('/mnt/user/TimeMachine/Folder&A/Episode&Bonus.mkv'),true);
});

test('v0.2.3.10 HTML 实体及高风险名称仍禁止复制', () => {
  const {api}=createAPI();
  for(const name of ['A&amp;B','A&#38;B','A&copy;B','A&copy','A%25B',
    'A"B',"A'B",'a;b','a\\b','a/b','bad\\nname',' bad','bad ']) {
    assert.equal(api.safeCopyName(name),false,JSON.stringify(name));
    // Slash is invalid *within one name* but may separate legal path parts.
    if (name !== 'a/b') {
      assert.equal(api.safeCopyPath('/mnt/user/downloads/'+name),false,JSON.stringify(name));
    }
  }
  assert.equal(api.safeCopyPath('/mnt/user/downloads/a/b'),true);
  assert.equal(api.safeCopyPath('/mnt/disk1/Folder&A'),false);
  assert.equal(api.safeCopyPath('/mnt/user/downloads/../Folder&A'),false);
  assert.equal(api.safeCopyPath('/mnt/user/downloads',true),true);
  assert.match(api.copyBlockedReason({path:'/mnt/user/downloads/A&amp;B'}),
    /无法安全处理/);
  assert.match(api.copyBlockedReason({
    path:'/mnt/user/downloads/A&B',copyPathVerified:false
  }),/路径与文件名不一致/);
  assert.equal(api.copyBlockedReason({path:'/mnt/user/downloads/A&B',
    copyPathVerified:true}),'');
});

test('v0.2.3.10 复制菜单及提交前必须验证原生 Browse 文件名一致性',()=>{
  assert.match(script,/copyPathVerified: cells\[2\]\?\.textContent === path\.substring/);
  assert.match(script,/chosen\.map\(copyBlockedReason\)\.find\(Boolean\)/);
  assert.match(script,/button\.disabled = true;[\s\S]*?button\.title = disabledReason/);
  assert.match(script,/entries\.some\(item => !item \|\| \(isMove\?!safeWritePath\(item\.path\):copyBlockedReason\(item\)\)/);
  assert.match(script,/if \(sourceEntry\.copyPathVerified === false\)/);
  assert.match(script,/safeCopyPath\(item\.path, true\) && item\.copyPathVerified !== false/);
  assert.match(script,/!safeCopyPath\(plan\.source\)/);
  assert.match(script,/function safeWriteName\(name\)/);
  assert.match(script,/const RENAME_ENABLED = true/);
});

test('v0.2.3.12 全部弹窗统一 52px 标题、64px 底栏和独立滚动内容',()=>{
  assert.match(script,/#ufs-app \.ufs-create-dialog\{[^}]*max-height:calc\(100% - 16px\);min-height:0;overflow:hidden/);
  assert.match(script,/#ufs-app \.ufs-create-head\{[^}]*height:52px;min-height:52px;flex:0 0 52px/);
  assert.match(script,/#ufs-app \.ufs-create-form\{[^}]*flex:1 1 auto;[^}]*min-height:0;overflow:hidden/);
  assert.match(script,/#ufs-app \.ufs-create-fields\{[^}]*flex:1 1 auto;[^}]*min-height:0;overflow-y:auto;overscroll-behavior:contain/);
  assert.match(script,/#ufs-app \.ufs-create-buttons\{[^}]*height:64px;min-height:64px;flex:0 0 64px/);
  assert.match(script,/#ufs-app \.ufs-copy-dialog\{width:min\(465px,100%\)\}/);
  assert.match(script,/form\.append\(fields,fixedOptions,footer\);[\s\S]*?dialog\.append\(header,form\);/);
  assert.match(script,/form\.append\(fields, buttons\);\s*dialog\.append\(top, form\);/);
  assert.match(script,/form\.append\(fields, buttons\);\s*dialog\.append\(header, form\);/);
});
test('v0.2.3.12 弹窗及目录树复用细滚动条和滚动触发显示，避免双滚动条同时突出',()=>{
  assert.match(script,/#ufs-app \.ufs-create-dialog \.ufs-create-fields,#ufs-app \.ufs-copy-picker,#ufs-app \.ufs-task-center-body\{scrollbar-width:thin;scrollbar-color:transparent transparent\}/);
  assert.match(script,/#ufs-app \.ufs-copy-dialog \.ufs-create-fields:has\(\.ufs-copy-picker:hover\)\{scrollbar-color:transparent transparent\}/);
  assert.match(script,/#ufs-app \.ufs-copy-dialog \.ufs-create-fields:has\(\.ufs-copy-picker:hover\)::-webkit-scrollbar-thumb/);
  assert.equal((script.match(/setupListScrollbars\(fields\);/g)||[]).length,3,
    '新建、重命名和复制的内容区都应复用滚动条监听');
  assert.equal((script.match(/setupListScrollbars\(picker\);/g)||[]).length,1,
    '复制目录树仅注册一次滚动监听');
  assert.match(script,/onCleanup\(setupListScrollbars\(\$\('\.ufs-list', app\)\)\)/,
    '保留主文件列表原有滚动条绑定');
  assert.match(script,/window\.confirm\(/,'不改动原生取消复制确认交互');
});

test('v0.2.3.13 复制弹窗焦点、Esc 分层处理和原生取消安全行为',()=>{
  assert.match(script,/const opener = document\.activeElement/);
  assert.match(script,/dialog\.tabIndex = -1/);
  assert.match(script,/const focusDialog = \(\) =>/);
  assert.match(script,/const restoreFocus = \(preferred\) =>/);
  assert.match(script,/const reopen=\(\)=>\{[\s\S]*?focusDialog\(\)/);
  assert.match(script,/dialog\.addEventListener\('keydown',event=>\{\s*if\(event\.key!=='Escape'\) return;\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);/);
  assert.match(script,/if\(inlineDraft && !inlineDraft\.busy\) \{cancelInlineCreate\(\);return;\}/);
  assert.match(script,/close\(\); \/\/ During an active copy this minimizes/);
  assert.match(script,/showCopyFields\(summary,progressPanel\);[\s\S]*?focusDialog\(\);/);
  assert.match(script,/const yes=window\.confirm\(/);
  assert.match(script,/requestCancelNativeCopy\(activeCopySession\.plan,control\)/);
});

test('v0.2.3.14 新建文件夹工具栏直接调用现有弹窗，不再通过单项下拉菜单',()=>{
  assert.match(script, /class="ufs-ico ufs-create-trigger" title="新建文件夹" aria-label="新建文件夹">新建文件夹<\/button>/);
  assert.doesNotMatch(script, /function showCreateMenu\(/);
  assert.match(script, /\$\('\.ufs-create-trigger', app\)\.addEventListener\('click', \(\) => \{\s*closeMenu\(\);\s*showCreateFolderDialog\(\);\s*\}\)/);
  assert.match(script, /function showCreateFolderDialog\(\) \{[\s\S]*?if \(!CREATE_FOLDER_ENABLED \|\| destroyed/);
  assert.match(script, /if \(!safeWritePath\(parent, true\)\) return notify/);
  assert.match(script, /await createNativeFolder\(plan,/);
  assert.match(script, /for \(const selector of \['\.ufs-more', '\.ufs-operations'\]\)/);
});

test('v0.2.3.15 文件工具栏两按钮统一 28px 实体外观且不影响其他控件',()=>{
  assert.match(script,/#ufs-app \.ufs-file-actions \.ufs-create-trigger,#ufs-app \.ufs-file-actions \.ufs-operations\{[^}]*height:28px;min-height:28px;max-height:28px;[^}]*padding:0 10px;[^}]*border-radius:5px;background:#e8edf1;[^}]*font-size:13px;font-weight:500/);
  assert.match(script,/#ufs-app \.ufs-file-actions \.ufs-create-trigger\{margin-right:1px\}/);
  assert.match(script,/#ufs-app \.ufs-file-actions \.ufs-create-trigger:hover:not\(:disabled\),#ufs-app \.ufs-file-actions \.ufs-operations:hover:not\(:disabled\)\{background:#d5dce2\}/);
  assert.match(script,/#ufs-app \.ufs-file-actions \.ufs-operations>\.ufs-svg\{[^}]*height:16px/);
  assert.match(script,/#ufs-app \.ufs-file-actions\{[^}]*gap:5px;height:34px;min-height:34px;max-height:34px/);
  assert.match(script,/class="ufs-ico ufs-create-trigger" title="新建文件夹" aria-label="新建文件夹">新建文件夹<\/button>/);
  assert.match(script,/class="ufs-ico ufs-operations" title="文件操作" aria-label="文件操作" aria-haspopup="menu" aria-expanded="false">操作/);
});

test('v0.2.3.16 移除文件操作栏的冗余「文件」标签，保留工具栏与两按钮',()=>{
  assert.doesNotMatch(script, /ufs-section-label/);
  assert.match(script, /'<div class="ufs-file-actions" role="toolbar" aria-label="文件内容和视图">',\s*'<button type="button" class="ufs-ico ufs-create-trigger"/);
  assert.match(script, /'<button type="button" class="ufs-ico ufs-operations"/);
  assert.match(script, /#ufs-app \.ufs-file-actions\{display:flex;align-items:center;gap:5px;height:34px/);
  assert.match(script, /#ufs-app \.ufs-file-actions \.ufs-create-trigger,#ufs-app \.ufs-file-actions \.ufs-operations\{[^}]*height:28px;min-height:28px;max-height:28px/);
});


test('v0.2.4 批量复制整体进度按字节加权，避免切换文件时归零或提前满格',()=>{
  const {api}=createAPI();
  const rows=[
    {entry:{name:'a.bin',size:1000,folder:false},status:'success'},
    {entry:{name:'b.bin',size:9000,folder:false},status:'copying'}
  ];
  let v=api.batchCopyOverallProgress(rows,1,50);
  assert.equal(v.mode,'bytes');
  assert.equal(v.percent,55);
  v=api.batchCopyOverallProgress(rows,1,100);
  assert.equal(v.percent,99.9,'最终核验之前不能显示 100%');
  rows[1].status='success';
  assert.equal(api.batchCopyOverallProgress(rows).percent,100);
});

test('v0.2.4 包含文件夹时按项目完成度，拒绝套用文件夹 rsync 百分比',()=>{
  const {api}=createAPI();
  const rows=[
    {entry:{name:'first.txt',size:1024,folder:false},status:'success'},
    {entry:{name:'Photos',size:null,folder:true},status:'copying'},
    {entry:{name:'third.txt',size:10,folder:false},status:'pending'},
    {entry:{name:'fourth.txt',size:10,folder:false},status:'pending'}
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(api.batchCopyOverallProgress(rows,1,67))),
    {percent:25,mode:'items'},'文件夹当前百分比不得用于整体进度');
  rows[1].status='success';
  rows[2].status='copying';
  assert.equal(api.batchCopyOverallProgress(rows,2,45).percent,61.25);
  const unknown=[
    {entry:{folder:false,size:null},status:'success'},
    {entry:{folder:false,size:0},status:'pending'}
  ];
  assert.equal(api.batchCopyOverallProgress(unknown).mode,'items');
});

test('v0.2.4 文件操作菜单支持多选复制，但批量任务必须顺序执行且严守全局停止保护',()=>{
  assert.match(script,/chosen\.map\(copyBlockedReason\)\.find\(Boolean\)/);
  assert.match(script,/showCopyDialog\(chosen\)/);
  assert.match(script,/const entries=Array\.isArray\(entryOrEntries\)\?entryOrEntries\.slice\(\):\[entryOrEntries\]/);
  assert.match(script,/copyDestinationAllowedForAll=dir=>entries\.every/);
  assert.match(script,/async function preflightBatchCopy\(plans\)/);
  assert.match(script,/await preflightBatchCopy\(plans\)/);
  assert.match(script,/for\(let i=0;i<plans\.length;i\+\+\)/);
  assert.match(script,/await \(isMove\?moveNativeEntry:copyNativeEntry\)\(plans\[i\],/);
  assert.match(script,/if\(batch\.stopAfterCurrent\)/);
  assert.match(script,/requestCancelNativeCopy\(activeCopySession\.plan,control\)/);
  assert.match(script,/const batch=multi\?/);
  assert.match(script,/showCopyFields\(batchListPanel\)/);
  assert.match(script,/batchScroll\.replaceChildren\(\)/);
  assert.match(script,/filtered\.slice\(0,500\)/);
});

test('v0.2.4 后台入口位于底部右侧状态栏，不占工具栏高度',()=>{
  const source=script.slice(script.indexOf('function renderFileActionsMarkup()'),
    script.indexOf('function renderWorkspaceMarkup()'));
  const status=script.slice(script.indexOf('function renderUI()'),
    script.indexOf("$$('[data-ufs-icon]', app)"));
  assert.doesNotMatch(source,/ufs-copy-task-trigger/);
  assert.match(status,/class="ufs-status-hint"/);
  assert.match(status,/class="ufs-copy-task-trigger"/);
  assert.match(script,/#ufs-app \.ufs-status \.ufs-copy-task-trigger\{flex:0 0 auto/);
  assert.match(script,/const minimize=\(\)=>/);
  assert.match(script,/const reopen=\(\)=>/);
});


test('v0.2.5 队列使用单一执行器、逐项启动并只在执行时检查原生写入锁',()=>{
  assert.match(script,/const copyJobs=\[\]/);
  assert.match(script,/function registerCopyJob\(job\)/);
  assert.match(script,/async function runCopyQueue\(\)/);
  assert.match(script,/if\(copyQueueRunning \|\| copyQueuePaused \|\| copyRecoveryLocked/);
  assert.match(script,/const job=copyJobs\.find\(item=>item\.status==='queued'\)/);
  assert.match(script,/while\(nativeWriteBusy && !destroyed\) await waitNative\(150\)/);
  assert.match(script,/await job\.execute\(\)/);
  assert.match(script,/if\(\(job\.status==='failed' && !job\.recoverable\)/);
  assert.match(script,/if\(!window\.confirm\('确认已核实失败或不确定的原生复制任务/);
  assert.match(script,/prepare:\(\)=>\{submit\.hidden=false;submit\.disabled=false;\}/);
  assert.match(script,/cancelQueued:\(\)=>/);
  assert.match(script,/if\(copyJob\?\.status==='queued'\)/);
});

test('v0.2.5 方案 A 底部胶囊显示运行中总进度与独立排队数量',()=>{
  assert.match(script,/const queued=copyJobs\.filter\(job=>job\.status==='queued'\)\.length/);
  assert.match(script,/active\?copyJobPhaseLabel\(active\)/);
  assert.match(script,/\.ufs-task-badge-percent/);
  assert.match(script,/\.ufs-task-badge-speed/);
  assert.match(script,/element\('span','ufs-task-badge-divider'\)/);
  assert.match(script,/element\('span','ufs-task-badge-wait'\)/);
  assert.match(script,/function showCopyTaskCenter\(focus=true\)/);
  assert.match(script,/job\.cancelQueued\(\)/);
  assert.match(script,/function resumeCopyQueue\(\)/);
  assert.match(script,/#ufs-app \.ufs-status \.ufs-copy-task-trigger\[hidden\]\{display:none!important\}/);
  assert.match(script,/\.addEventListener\('click',\(\)=>showCopyTaskCenter\(\)\)/);
});


test('v0.2.5.1 预检收集全部同名冲突，不跳过、不覆盖、不改变待处理队列',()=>{
  const {api}=createAPI();
  const plans=[
    {source:'/mnt/user/TimeMachine/Photos',target:'/mnt/user/downloads/Photos'},
    {source:'/mnt/user/TimeMachine/notes.txt',target:'/mnt/user/downloads/notes.txt'},
    {source:'/mnt/user/TimeMachine/another.zip',target:'/mnt/user/downloads/another.zip'}
  ];
  const existing=[
    {name:'Photos',path:'/mnt/user/downloads/Photos'},
    {name:'notes.txt',path:'/mnt/user/downloads/notes.txt'},
    {name:'unrelated.txt',path:'/mnt/user/downloads/unrelated.txt'}
  ];
  assert.deepEqual(Array.from(api.findBatchCopyConflicts(plans,existing)),['Photos','notes.txt']);
  assert.deepEqual(Array.from(api.findBatchCopyConflicts(plans,[])),[]);
  assert.equal(plans.length,3);
  assert.match(script,/error\.copyConflicts=conflicts/);
  assert.match(script,/if\(conflicts\.length\)\s*\{/);
  assert.match(script,/throw error/);
});

test('v0.2.5.1 预检状态醒目、冲突列表在目标树上方并允许重新选择目标',()=>{
  assert.match(script,/正在检查复制任务…/);
  assert.match(script,/showCopyFields\(checkingPanel\)/);
  assert.match(script,/showCopyFields\(preflightNotice,summary,location\)/);
  assert.match(script,/fields\.scrollTop=0/);
  assert.match(script,/noticeDetail\.textContent=conflicts\.length/);
  assert.match(script,/showPreflightError\(error,error\.copyConflicts\|\|\[\]\)/);
  assert.match(script,/if\(selected!==path\) clearPreflightError\(\)/);
  assert.match(script,/copyJob\.preflightRejected=true/);
  assert.match(script,/job\.preflightRejected\?'预检未通过 · 未开始':'失败'/);
  assert.match(script,/max-height:152px;overflow:auto/);
});

test('v0.2.6 同名策略只允许用于复制，文件和目录类型冲突优先拒绝',()=>{
  const {api}=createAPI();
  const base={type:'copy',source:'/mnt/user/a/file.bin',destinationDir:'/mnt/user/b',folder:false};
  assert.equal(api.planFileOperation({...base,conflictPolicy:'skip'}).conflictPolicy,'skip');
  assert.equal(api.planFileOperation({...base,conflictPolicy:'overwrite'}).conflictPolicy,'overwrite');
  assert.throws(()=>api.planFileOperation({...base,conflictPolicy:'rename'}),/不允许/);
  assert.throws(()=>api.planFileOperation({type:'mkdir',parent:'/mnt/user/a',name:'test',conflictPolicy:'overwrite'}),/不允许/);
  assert.deepEqual(Array.from(api.findBatchCopyTypeConflicts([
    {...base,target:'/mnt/user/b/file.bin'},
    {...base,source:'/mnt/user/a/dir',target:'/mnt/user/b/dir',folder:true}
  ],[
    {name:'file.bin',path:'/mnt/user/b/file.bin',folder:true},
    {name:'dir',path:'/mnt/user/b/dir',folder:true}
  ])),['file.bin']);
  assert.match(script,/ufs-copy-policy-choice:hover::after/);
  assert.match(script,/radio.checked=value==='skip'/);
  assert.match(script,/exist: plan.conflictPolicy==='overwrite'\?'1':''/);
  assert.match(script,/destination:selected,conflictPolicy,count:entries.length/);
});

test('v0.2.6 忽略同名顶层文件直接结束，不发原生写入请求',async()=>{
  const calls=[];
  const {api,sandbox}=createAPI({fetch:async (_url,opts)=>{
    calls.push(new URLSearchParams(opts.body).get('mode'));
    return {ok:true,text:async()=>''};
  }});
  const demo=sandbox.window.__UFS_DEMO__;
  demo['/mnt/user/a']=[{name:'file.bin',folder:false,size:2048}];
  demo['/mnt/user/b']=[{name:'file.bin',folder:false,size:100}];
  const plan=api.planFileOperation({type:'copy',source:'/mnt/user/a/file.bin',
    destinationDir:'/mnt/user/b',folder:false,conflictPolicy:'skip'});
  const output=await api.copyNativeEntry(plan);
  assert.equal(output.copyOutcome,'skipped');
  assert.deepEqual(calls,[]);
});

test('v0.2.6 批量忽略文件也应计入已处理进度，不伪造目录百分比',()=>{
  const {api}=createAPI();
  const rows=[
    {entry:{folder:false,size:500},status:'skipped'},
    {entry:{folder:false,size:500},status:'success'}
  ];
  assert.equal(api.batchCopyOverallProgress(rows).percent,100);
  rows[1].status='pending';
  assert.equal(api.batchCopyOverallProgress(rows).percent,50);
});

test('v0.2.6.1 radio 改为外圈 + 小圆点，悬浮与焦点提示不同时展示',()=>{
  assert.match(script,/\.ufs-copy-policy-radio:checked\+\.ufs-copy-policy-ring::after/);
  assert.match(script,/\.ufs-copy-policy-radio:focus-visible\+\.ufs-copy-policy-ring/);
  assert.match(script,/ufs-copy-policy:not\(:has\(\.ufs-copy-policy-choice:hover\)\)/);
  assert.doesNotMatch(script,/ufs-copy-policy-choice:focus-within::after/);
  assert.match(script,/option\.append\(radio,element\('span','ufs-copy-policy-ring'\)/);
});

test('v0.2.6.2 rsync 真实速度只在运行且未过期时可见，5 秒后隐藏',()=>{
  const {api}=createAPI();
  const job={status:'running',phase:'copying',speed:'85.6MB/s',speedUpdatedAt:10000,percent:42};
  assert.equal(api.currentCopySpeed(job,14000),'85.6MB/s');
  assert.equal(api.currentCopySpeed(job,15000),'85.6MB/s');
  assert.equal(api.currentCopySpeed(job,15001),'');
  assert.equal(api.currentCopySpeed({...job,phase:'verifying'},11000),'');
  assert.equal(api.currentCopySpeed({...job,status:'queued'},11000),'');
  assert.equal(api.currentCopySpeed({...job,speedUpdatedAt:0},11000),'');
  assert.equal(api.copyJobMeta(job),'速度暂无数据');
  assert.equal(api.copyJobMeta({...job,speedUpdatedAt:0}),'速度获取中…');
  assert.equal(api.copyJobMeta({...job,phase:'checking'}),'正在验证源文件和目标目录');
  assert.equal(api.copyJobMeta({...job,phase:'verifying'}),'正在核对复制结果');
  assert.equal(api.copyJobStatusLabel(job),'复制中 42%');
  assert.equal(api.copyJobStatusLabel({...job,phase:'checking'}),'正在检查');
  assert.equal(api.copyJobStatusLabel({...job,phase:'verifying'}),'正在核验');
});

test('v0.2.6.2 任务中心、底部胶囊同时显示速度并沿用同一旋转节点',()=>{
  assert.match(script,/function copyJobSignal\(job,phase,info\)/);
  assert.match(script,/function synchronizeCopySpeedTimer\(active\)/);
  assert.match(script,/copyJob\.speedUpdatedAt=0/);
  assert.match(script,/ufs-task-badge-speed/);
  assert.match(script,/ufs-task-center-meta/);
  assert.match(script,/data-status=running/);
  assert.match(script,/button\.dataset\.renderKey!==signature/);
  assert.match(script,/@media\(prefers-reduced-motion:reduce\).*ufs-task-live-spinner/);
  assert.match(script,/\.ufs-task-live-spinner\{.*animation:ufs-copy-spin/);
});

test('v0.2.6.3 任务中心图标均已注册真实 SVG 路径，不再回退为文件图标',()=>{
  const start=script.indexOf('  const ICONS = {');
  const end=script.indexOf('  function icon(',start);
  assert.ok(start>=0 && end>start,'缺少本地图标定义');
  const inventory=vm.runInNewContext(script.slice(start,end)+'\nICONS');
  for(const name of ['clock-3','chevron-up','check-circle','alert-circle']) {
    assert.ok(Array.isArray(inventory[name]) && inventory[name].length>0,
      name+' 必须存在 SVG 路径定义');
    assert.notDeepEqual(Array.from(inventory[name]),Array.from(inventory.file),
      name+' 不得回退为文件图标');
  }
  assert.equal(inventory['clock-3'][1],'M12 6v6h4','时钟必须有三点方向的指针');
  assert.equal(inventory['chevron-up'][0],'m18 15-6-6-6 6','展开箭头必须指向上方');
  assert.equal(inventory['check-circle'][1],'m8 12 3 3 5-6','完成状态需要圆圈内对勾');
  assert.equal(inventory['alert-circle'][1],'M12 8v4','异常状态需要圆圈内感叹号');
});

test('v0.2.6.4 同页切换不刷新且保留队列，原生界面有待处理队列时只读',()=>{
  assert.match(script,/function switchFileManager\(mode\)/);
  assert.match(script,/fileManagerMode=mode/);
  assert.match(script,/app\.hidden=native/);
  assert.match(script,/nativeElements\.forEach\(node=>node\.classList\.toggle\('ufs-hide-native',!native\)\)/);
  assert.match(script,/switchFileManager\(initialNative\?'native':'file-station'\)/);
  assert.match(script,/function guardNativeInteraction\(event\)/);
  assert.match(script,/function nativeQueueIsProtected\(\)/);
  assert.match(script,/\['queued','running','uncertain','stopped'\]/);
  assert.match(script,/window\.addEventListener\(type,guardNativeInteraction/);
  assert.match(script,/function takeOverNativeFileMonitor\(\)/);
  assert.match(script,/beforeunload/);
  assert.doesNotMatch(script,/location\.reload\(\)/);
  assert.doesNotMatch(script,/if \(disabled\) \{\s*if \(\$\('#ufs-native-enable'\)\)/);
});

test('v0.2.6.5 原生界面切换不无条件刷新，失败不会锁住目录加载',()=>{
  assert.match(script,/function refreshNativeListIfNeeded\(\)/);
  assert.match(script,/nativeListRevision===nativeListRefreshed/);
  assert.match(script,/const timeout=setTimeout\(\(\)=>controller\.abort\(\),10000\)/);
  assert.match(script,/if\(!response\.ok\) throw new Error\('HTTP '/);
  assert.match(script,/原生目录更新失败/);
  assert.match(script,/nativeRefreshRetry\.addEventListener\('click'/);
  assert.match(script,/markNativeListDirty\(\)/);
  assert.match(script,/原列表已保留/);
  assert.doesNotMatch(script,/\bwindow\.loadList\(\)/);
  assert.match(script,/The preserved table is already rendered/);
});

test('v0.2.6.5 folder-open SVG 不包含错误的额外线段参数',()=>{
  const begin=script.indexOf('  const ICONS = {');
  const end=script.indexOf('  function icon(',begin);
  const icons=vm.runInNewContext(script.slice(begin,end)+'\nICONS');
  assert.equal(icons['folder-open'][0],
    'M3 7a2 2 0 0 1 2-2h4l2 2h9a2 2 0 0 1 2 2');
  assert.doesNotMatch(icons['folder-open'][0],/l2 2 2h9/);
});


test('v0.2.7 阶段一：任务快照仅包含安全可序列化数据',()=>{
  const {api}=createAPI();
  const task={
    taskId:'task_abcdefgh',name:'复制资料',destination:'/mnt/user/downloads',
    conflictPolicy:'skip',status:'queued',createdAt:100,updatedAt:101,
    dialog:{nodeType:1},execute(){throw new Error('不应调用 UI 或执行器');},
    items:[
      {source:'/mnt/user/TimeMachine/a.zip',folder:false,size:1024,
        status:'queued',submission:'not-submitted',updatedAt:100},
      {source:'/mnt/user/TimeMachine/Photos',folder:true,size:null,
        status:'queued',submission:'not-submitted',updatedAt:100}
    ]
  };
  const snapshot=api.validateCopyQueueSnapshot({schema:1,savedAt:200,tasks:[task]});
  assert.equal(snapshot.tasks.length,1);
  assert.equal(snapshot.tasks[0].items.length,2);
  assert.equal(snapshot.tasks[0].dialog,undefined);
  assert.equal(snapshot.tasks[0].execute,undefined);
  assert.doesNotThrow(()=>JSON.stringify(snapshot));
  assert.equal(snapshot.tasks[0].items[1].size,null);
  assert.equal(api.copyRecoveryAssessment(snapshot).requiresConfirmation,true);
});

test('v0.2.7 阶段一：原生提交意图永远恢复为待核实，不会宣称完成',()=>{
  const {api}=createAPI();
  const template={
    taskId:'task_abcdefgh',name:'批量复制',destination:'/mnt/user/downloads',
    conflictPolicy:'overwrite',status:'copying',createdAt:100,updatedAt:150,
    items:[
      {source:'/mnt/user/TimeMachine/a.zip',folder:false,size:100,
        status:'success',submission:'confirmed'},
      {source:'/mnt/user/TimeMachine/b.zip',folder:false,size:200,
        status:'submission-intent',submission:'intent-saved'},
      {source:'/mnt/user/TimeMachine/c.zip',folder:false,size:300,
        status:'queued',submission:'not-submitted'}
    ]
  };
  const output=api.copyRecoveryAssessment({schema:1,tasks:[template],savedAt:200});
  assert.deepEqual(Array.from(output.tasks[0].items.map(x=>x.restoreStatus)),
    ['terminal','needs-verification','waiting']);
  assert.equal(output.requiresConfirmation,true);
  assert.equal(output.tasks[0].restoreStatus,'needs-verification');
  const changed=JSON.parse(JSON.stringify(template));
  changed.items[1].submission='unknown';
  changed.items[1].status='failed';
  const unknown=api.copyRecoveryAssessment({schema:1,tasks:[changed]}).tasks[0].items[1];
  assert.equal(unknown.restoreStatus,'needs-verification');
});

test('v0.2.7 阶段一：坏快照、目录自复制及重复 ID 全部拒绝恢复',()=>{
  const {api}=createAPI();
  const base={
    taskId:'task_abcdefgh',name:'文件夹复制',destination:'/mnt/user/downloads',
    conflictPolicy:'skip',status:'queued',
    items:[{source:'/mnt/user/TimeMachine/Photos',folder:true,
      status:'queued',submission:'not-submitted'}]
  };
  const snap={schema:1,tasks:[base]};
  assert.doesNotThrow(()=>api.validateCopyQueueSnapshot(snap));
  assert.throws(()=>api.validateCopyQueueSnapshot({...snap,schema:2}),/不兼容/);
  assert.throws(()=>api.validateCopyQueueSnapshot({schema:1,tasks:[base,base]}),/重复/);
  assert.throws(()=>api.validateCopyQueueSnapshot({schema:1,tasks:[
    {...base,destination:'/mnt/user/TimeMachine/Photos/deep'}
  ]}),/不安全/);
  assert.throws(()=>api.validateCopyQueueSnapshot({schema:1,tasks:[
    {...base,items:[{...base.items[0],source:'/etc/shadow'}]}
  ]}),/不安全/);
  assert.throws(()=>api.createCopyQueueStore(null),/不可用/);
  assert.match(script,/table\.get\('dispatcher'\)/);
  assert.match(script,/table\.put\(\{key:'dispatcher',owner,expiresAt:now\+ttl\}\)/);
});


test('v0.2.7 执行前必须先保存原生提交意图，失去持久化所有权拒绝复制',()=>{
  assert.match(script,/if\(beforeSubmit\) await beforeSubmit\(\);/);
  assert.match(script,/copyItemCheckpoint\(copyJob,0,'submission-intent','intent-saved'\)/);
  assert.match(script,/outcome\.copyOutcome==='skipped'\?'not-submitted':'confirmed'/);
  assert.match(script,/function persistCopyQueue\(\)/);
  assert.match(script,/persistentCopyStore\.writeOwned\(snap,copyOwnerId\)/);
  assert.match(script,/const writeOwned=\(snapshot,owner\)=>/);
  assert.match(script,/tx\.objectStore\('leases'\)\.get\('dispatcher'\)/);
  assert.match(script,/if\(destroyed \|\| !copyOwnerHeld \|\| \(copyQueuePaused && status!=='excluded'\)\)/);
});

test('v0.2.7 恢复任务仅展示记录，自动暂停，必须手动确认',()=>{
  assert.match(script,/copyRecoveryLocked=assessed\.requiresConfirmation/);
  assert.match(script,/function confirmRecoveredCopyQueue\(\)/);
  assert.match(script,/copyQueuePaused=assessed\.requiresConfirmation/);
  assert.match(script,/确认恢复队列/);
  assert.match(script,/稍后处理/);
  assert.match(script,/if\(copyQueueRunning \|\| copyQueuePaused \|\| copyRecoveryLocked/);
  assert.match(script,/if\(copyRecoveryLocked \|\| !copyQueuePaused/);
  assert.match(script,/请先逐项核实并排除/);
  assert.match(script,/function executeRecoveredCopyJob\(job\)/);
});

test('v0.2.7 持久化恢复状态不允许盲目重发失败及提交阶段项目',()=>{
  const {api}=createAPI();
  const items=[
    ['queued','not-submitted'],
    ['checking','not-submitted'],
    ['submission-intent','intent-saved'],
    ['copying','unknown'],
    ['failed','not-submitted'],
    ['success','confirmed']
  ].map(([status,submission],i)=>({
    source:'/mnt/user/TimeMachine/test'+i+'.txt',
    status,submission,folder:false
  }));
  const r=api.copyRecoveryAssessment({schema:1,tasks:[{
    taskId:'copy_abcdefgh',name:'混合队列',destination:'/mnt/user/downloads',
    conflictPolicy:'skip',status:'running',items
  }]});
  assert.deepEqual(Array.from(r.tasks[0].items.map(i=>i.restoreStatus)),[
    'waiting','waiting','needs-verification','needs-verification','needs-verification','terminal'
  ]);
  assert.equal(r.requiresConfirmation,true);
});

test('v0.2.7.1 刷新后仅重新观察严格匹配的原生任务，无法确定时不宣称成功',()=>{
  assert.match(script,/async function monitorRecoveredNativeTask\(\)/);
  assert.match(script,/if\(matches\.length!==1\)\s*\{[\s\S]*?return;/);
  assert.match(script,/matchesCopyTask\(active,signature\)/);
  assert.match(script,/const unwatch=observeNativeProgress\(data=>/);
  assert.match(script,/if\(finishedEvent && sameTaskObserved\)/);
  assert.match(script,/await verifyRecoveredNativeCopy\(job,index\)/);
  assert.match(script,/job\.record\.operation==='move'\?!!origin:!origin/);
  assert.match(script,/await persistentCopyStore\.read\(\)/);
  assert.match(script,/job\.recoveryMonitoring=false/);
  assert.match(script,/copyQueuePaused=true; \/\/ NEVER resume waiting jobs/);
  assert.match(script,/const previous=\{status:item\.status,submission:item\.submission/);
  const reconnect=script.slice(script.indexOf('async function monitorRecoveredNativeTask()'),
    script.indexOf('async function discardRecoveredCopyJob('));
  assert.doesNotMatch(reconnect,/postNativeControl\(\{\s*mode:\s*'file'/);
  assert.doesNotMatch(reconnect,/copyNativeEntry\(/);
});

test('v0.2.7.2 Tampermonkey 自动更新元数据与脚本版本保持一致',()=>{
  const header=script.split('// ==/UserScript==',1)[0];
  const updateUrl='https://raw.githubusercontent.com/nukewarrior/unraid-file-station/feat/file-station-v0.1/src/unraid-file-station.user.js';
  assert.match(header,/^\/\/ @version\s+0\.2\.10\.1$/m);
  assert.ok(header.split('\n').includes('// @updateURL    '+updateUrl));
  assert.ok(header.split('\n').includes('// @downloadURL  '+updateUrl));
  assert.equal(header.match(/^\/\/ @version\s+/gm)?.length,1);
});

test('v0.2.7.3 无 ETA 的真实 rsync 速度和顶层原生 text 数组',()=>{
  const {api}=createAPI();
  const noEta=api.parseRsyncProgress('Copying... videos/a.mp4\n5,242,880 28% 45.2MB/s');
  assert.equal(noEta.filename,'videos/a.mp4');
  assert.equal(noEta.percent,28);
  assert.equal(noEta.speed,'45.2MB/s');
  assert.equal(noEta.eta,'');
  const speedOnly=api.parseRsyncProgress('Copying... videos/b.mp4\ncurrent 31.3MB/s');
  assert.equal(speedOnly.percent,null);
  assert.equal(speedOnly.speed,'31.3MB/s');
  const direct=api.parseRsyncProgress({action:8,text:['Copying... videos/c.mp4','5.10M 42% 6.4MB/s']});
  assert.equal(direct.filename,'videos/c.mp4');
  assert.equal(direct.speed,'6.4MB/s');
  assert.equal(direct.percent,42);
  assert.equal(api.parseRsyncProgress('{"action":8,"text":["Done"]}').filename,'');
  assert.equal(api.parseRsyncProgress('{"action":8,"text":["Done"]}').speed,'');
});

test('v0.2.7.3 固定复制策略栏、实时速度状态与超时清理结构',()=>{
  assert.match(script,/form\.append\(fields,fixedOptions,footer\)/);
  assert.match(script,/fixedOptions\.hidden=!nodes\.includes\(location\)/);
  assert.match(script,/ufs-copy-fixed-options\[hidden\]/);
  assert.match(script,/正在获取复制速度/);
  assert.match(script,/暂无实时速度数据/);
  assert.match(script,/copyJob\.eta=''/);
  assert.match(script,/clearInterval\(batchMetricsTimer\)/);
  assert.match(script,/clearInterval\(singleMetricsTimer\)/);
});


test('v0.2.7.5 单项与批量使用统一布局、统一阶段及真实速度展示',()=>{
  assert.match(script,/const progressPanel=element\('div','ufs-copy-progress-panel ufs-unified-progress'\)/);
  assert.match(script,/const batchPanel=element\('div','ufs-batch-panel ufs-unified-progress'\)/);
  assert.match(script,/renderSharedCopyStages\(stageNodes,phase,lastActiveCopyStep\)/);
  assert.match(script,/renderSharedCopyStages\(batchStageNodes,visualPhase/);
  assert.match(script,/const batchCurrentFile=element\('div','ufs-copy-current-file'\)/);
  assert.match(script,/batchCurrentFile\.textContent='当前文件：'/);
  assert.match(script,/if\(info\?\.percent!=null && !entry\.folder && !isMove\)/,
    '目录不能将内部当前文件的进度冒充为整个目录的进度');
  assert.match(script,/progressFilePercent\.textContent='当前文件进度 '/);
  assert.match(script,/progressFilePercent\.hidden=true/);
  assert.match(script,/按项目计算 · 非字节进度/);
  assert.match(script,/currentCopySpeed\(copyJob\)/);
  assert.match(script,/ufs-unified-metrics/);
});


test('v0.2.8 诊断模块默认对文件名、路径和认证信息脱敏',()=>{
  const {api}=createAPI();
  const clean=api.diagnosticSanitize({
    source:'/mnt/user/Photos/私密相册/旅行.jpg',
    destination:'/mnt/user/Backup',
    csrf_token:'very-secret-value',
    message:'读取 /mnt/user/Photos/私密相册 失败',
    endpoint:'https://nas.example.com/secret?token=abc'
  });
  assert.match(clean.source,/^\[PATH:path_[a-z0-9]+\]$/);
  assert.match(clean.destination,/^\[PATH:path_[a-z0-9]+\]$/);
  assert.equal(clean.csrf_token,'[REDACTED]');
  assert.equal(JSON.stringify(clean).includes('私密相册'),false);
  assert.equal(JSON.stringify(clean).includes('very-secret-value'),false);
  assert.equal(JSON.stringify(clean).includes('nas.example.com'),false);
});

test('v0.2.8 默认记录警告和关键操作，但不保存增强诊断事件',async()=>{
  const {api}=createAPI();
  api.diagnosticLog('INFO','queue.checkpoint',{
    taskId:'copy_test',status:'checking',source:'/mnt/user/hidden.zip'
  });
  api.diagnosticLog('DEBUG','native.poll',{elapsed:700});
  api.diagnosticMarkIssue();
  const events=await api.diagnosticReadAll();
  assert.equal(events.some(e=>e.code==='queue.checkpoint'),true);
  assert.equal(events.some(e=>e.code==='native.poll'),false);
  assert.equal(events.some(e=>e.code==='user.issue_marker'),true);
  assert.equal(JSON.stringify(events).includes('hidden.zip'),false);
});

test('v0.2.8 诊断界面、持久化与导出必须与复制队列独立',()=>{
  assert.match(script,/const DIAGNOSTIC_DATABASE='ufs-diagnostics-v1'/);
  assert.match(script,/const COPY_QUEUE_DATABASE='ufs-copy-queue-v1'/);
  assert.match(script,/function diagnosticPrune\(/);
  assert.match(script,/function diagnosticExport\(/);
  assert.match(script,/function diagnosticMarkIssue\(/);
  assert.match(script,/ufs-diagnostic-button/);
  assert.match(script,/diagnosticLog\('INFO','copy\.submission_intent'/);
  assert.match(script,/diagnosticLog\('WARN','queue\.restore_assessed'/);
  assert.match(script,/window\.addEventListener\('unhandledrejection',captureRejection/);
});

test('v0.2.9 移动使用原生 action 4/9，禁覆盖，并与现有任务队列持久化兼容',()=>{
 const {api}=createAPI();
 assert.match(script,/async function moveNativeEntry\(/);
 assert.match(script,/plan\.conflictPolicy!=='fail'/);
 assert.match(script,/action:plan\.folder\?'4':'9'/);
 assert.match(script,/if\(beforeSubmit\)await beforeSubmit\(\)/);
 assert.match(script,/function matchesMoveTask\(/);
 assert.match(script,/task\.operation\|\|'copy'/);
 assert.match(script,/showCopyDialog\(chosen,'move'\)/);
 assert.match(api.renderHeaderMarkup(),/ufs-refresh/);
});

test('v0.2.10 永久删除必须校验源路径、明确确认并保存提交意图',()=>{
  const {api}=createAPI();
  const file='/mnt/user/TimeMachine/notes.txt';
  const plan=api.planFileOperation({type:'delete',source:file,folder:false});
  assert.equal(plan.type,'delete');
  assert.equal(plan.target,'');
  assert.throws(()=>api.planFileOperation({type:'delete',source:'/mnt/user/TimeMachine',folder:true}),/只能操作/);
  assert.throws(()=>api.planFileOperation({type:'delete',source:'/mnt/user/TimeMachine/a%20b',folder:false}),/只能操作/);
  assert.equal(api.matchesDeleteTask({action:6,source:file,target:''},{folder:false,source:file}),true);
  assert.equal(api.matchesDeleteTask({action:1,source:file,target:''},{folder:false,source:file}),false);
  assert.match(script,/async function deleteNativeEntry\(/);
  assert.match(script,/action:plan\.folder\?'1':'6'/);
  assert.match(script,/if\(beforeSubmit\)await beforeSubmit\(\)/);
  assert.match(script,/if\(needConfirm&&!check\.checked\)return/);
  assert.match(script,/showDeleteDialog\(chosen\)/);
  assert.match(script,/copyItemCheckpoint\(job,i,'submission-intent','intent-saved'\)/);
  assert.match(script,/删除请求可能已发送；结果不确定/);
});
test('v0.2.10 删除记录可恢复并且不会将源缺失直接当作成功',()=>{
  const {api}=createAPI();
  const source='/mnt/user/TimeMachine/notes.txt';
  const record={
    taskId:'delete_task_000001',name:'notes.txt',destination:'/mnt/user/TimeMachine',
    conflictPolicy:'fail',operation:'delete',status:'running',createdAt:100,updatedAt:101,
    items:[{source,folder:false,status:'submission-intent',submission:'intent-saved',updatedAt:101}]
  };
  const snapshot=api.validateCopyQueueSnapshot({schema:1,savedAt:101,tasks:[record]});
  assert.equal(snapshot.tasks[0].operation,'delete');
  const assessed=api.copyRecoveryAssessment(snapshot);
  assert.equal(assessed.requiresConfirmation,true);
  assert.equal(assessed.tasks[0].restoreStatus,'needs-verification');
  assert.match(script,/if\(job\.record\.operation==='delete'\) \{\s*const current=await listDirectory/);
  assert.match(script,/if\(finishedEvent && sameTaskObserved\)/);
});
