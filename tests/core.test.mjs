import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../src/unraid-file-station.user.js', import.meta.url), 'utf8');

function createAPI() {
  const rows = [];
  const sandbox = {
    location: { pathname: '/demo/', search: '' },
    document: {
      documentElement: { getAttribute: () => 'true' },
      readyState: 'loading',
      addEventListener() {},
    },
    window: {
      __UFS_TEST_MODE__: true,
      __UFS_DEMO__: {
        '/mnt/user': [
          { name: 'downloads', folder: true },
          { name: '演示文件.txt', folder: false, size: 1024 },
        ],
      },
    },
    localStorage: { getItem: () => null },
    DOMParser: class {
      parseFromString() {
        return {
          querySelector: () => (rows.length ? {} : null),
          querySelectorAll: () => rows,
        };
      }
    },
    URL, URLSearchParams, setTimeout, clearTimeout, console,
  };
  vm.runInNewContext(script, sandbox, { filename: 'unraid-file-station.user.js' });
  return { api: sandbox.window.__UFS_TEST_API__, rows };
}

function makeIcon(path, type = 'f') {
  const cells = Array.from({ length: 9 }, () => ({
    getAttribute: () => null,
    textContent: '',
  }));
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

test('只读版本默认只包含两条工具行，移除长期禁用的写入栏', () => {
  const { api } = createAPI();
  const header = api.renderHeaderMarkup();
  const navigation = api.renderBrowserBarMarkup();
  const selection = api.renderSelectionBarMarkup();
  assert.match(header, /class="ufs-top"/);
  assert.match(header, /class="ufs-tabs"/);
  assert.match(header, /ufs-more/);
  assert.match(navigation, /class="ufs-navigation"/);
  assert.match(navigation, /ufs-search-trigger/);
  const fileActions = api.renderFileActionsMarkup();
  assert.match(fileActions, /ufs-grid-button/);
  assert.match(fileActions, /class="ufs-file-actions"/);
  assert.doesNotMatch(navigation, /ufs-grid-button|ufs-file-actions/);
  assert.match(selection, /class="ufs-selection-bar"[^>]*hidden/);
  assert.doesNotMatch(header + navigation + selection, /ufs-toolbar|ufs-write/);
  assert.match(script, /const ICONS =/);
  assert.doesNotMatch(script, /'📁'|'📄'/);
  assert.match(script, /nativeBreadcrumb = \$\('\.title \.left'\)/);
  assert.match(script, /footer = isDemo \? null : document\.querySelector\('#footer'\)/);
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


test('统一导航栏保留内部滚动，且选中操作栏默认隐藏', () => {
  const { api } = createAPI();
  assert.match(api.renderBrowserBarMarkup(), /ufs-search[^"]*"[^>]*hidden/);
  assert.match(api.renderSelectionBarMarkup(), /ufs-selection-count/);
  assert.match(script, /#ufs-app \.ufs-navigation\{height:42px;min-height:42px;max-height:42px/);
  assert.match(script, /#ufs-app \[hidden\]\{display:none!important/);
  assert.match(script, /#ufs-app \.ufs-sidebar\{[^']*overflow:auto/);
  assert.match(script, /#ufs-app \.ufs-list\{[^']*overflow:auto/);
});

test('选中操作栏根据已选项目提供可用操作', () => {
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
  assert.match(script, /chosen\.length !== 1 \|\| chosen\[0\]\.folder/);
  assert.match(script, /setSearchOpen\(false\)/);
});

test('原生上下滚动浮动按钮仅在增强版 File Station 页面隐藏', () => {
  assert.match(script, /html\.ufs-active-page \.move_to_end,html\.ufs-active-page \.back_to_top\{display:none!important\}/);
  assert.match(script, /document\.documentElement\.classList\.add\('ufs-active-page'\)/);
  assert.match(script, /document\.documentElement\.classList\.remove\('ufs-active-page'\)/);
  // Avoid broad selectors that would disable global arrows on other Unraid pages.
  assert.doesNotMatch(script, /'\.move_to_end,\.back_to_top\{display:none!important\}'/);
});


test('v0.1.5 DSM 结构：导航和操作栏仅属于右侧主区域', () => {
  const { api } = createAPI();
  const html = api.renderWorkspaceMarkup();
  const sidebar = html.indexOf('<aside class="ufs-sidebar">');
  const resizer = html.indexOf('<div class="ufs-resizer"');
  const main = html.indexOf('<main class="ufs-main">');
  const navigation = html.indexOf('<div class="ufs-navigation"');
  const actions = html.indexOf('<div class="ufs-file-actions"');
  const selection = html.indexOf('<div class="ufs-selection-bar"');
  const content = html.indexOf('<div class="ufs-content">');
  const list = html.indexOf('<div class="ufs-list"');
  const inspector = html.indexOf('<aside class="ufs-inspector"');
  assert.ok(sidebar >= 0 && sidebar < resizer && resizer < main);
  assert.ok(main < navigation && navigation < actions && actions < selection);
  assert.ok(selection < content && content < list && list < inspector);
  assert.ok(html.indexOf('</main>') > inspector);
  assert.equal((html.match(/class="ufs-navigation"/g) || []).length, 1);
  assert.equal((html.match(/class="ufs-file-actions"/g) || []).length, 1);
});

test('v0.1.5 地址框尺寸限制在右侧工具栏，保持白底且不突出', () => {
  const { api } = createAPI();
  assert.match(api.renderBrowserBarMarkup(), /class="ufs-address"/);
  assert.doesNotMatch(api.renderBrowserBarMarkup(), /ufs-view-controls/);
  assert.match(api.renderFileActionsMarkup(), /ufs-view-controls/);
  assert.match(script, /#ufs-app \.ufs-address\{display:flex;align-items:center;flex:1 1 auto;[^']*height:30px;min-height:30px;max-height:30px/);
  assert.match(script, /background:var\(--ufs-bg\);box-shadow:none;line-height:28px/);
  assert.match(script, /#ufs-app \.ufs-main\{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;overflow:hidden/);
  assert.match(script, /#ufs-app \.ufs-content\{display:flex;flex:1;min-width:0;min-height:0;overflow:hidden/);
  assert.doesNotMatch(script, /#ufs-app \.ufs-toolbar\{height:44px/);
});
