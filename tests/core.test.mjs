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

test('只读工具栏全部显式禁用且文件图标不使用 emoji', () => {
  assert.match(script, /class="ufs-ico ufs-write" disabled/);
  assert.doesNotMatch(script, /'📁'|'📄'/);
  assert.match(script, /const ICONS =/);
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
