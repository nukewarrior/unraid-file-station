// ==UserScript==
// @name         Unraid File Station
// @namespace    https://github.com/nukewarrior/unraid-file-station
// @version      0.1.0
// @description  DSM-inspired read-only file browser inside Unraid WebGUI 7.2.2
// @match        *://*/Shares*
// @match        *://*/Main/Browse*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const PREFIX = '/mnt/user';
  const STORE = 'unraid-file-station:v1:';
  const isDemo = document.documentElement.getAttribute('data-ufs-demo') === 'true';
  const browsePage = /\/(?:Shares|Main)\/Browse\/?$/.test(location.pathname);
  const sharesPage = /\/Shares\/?$/.test(location.pathname);
  if (!isDemo && !browsePage && !sharesPage) return;

  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));
  const safePath = (path) => typeof path === 'string' &&
    (path === PREFIX || path.startsWith(PREFIX + '/')) &&
    !path.split('/').some((part) => part === '..' || part === '.' || part.includes('\0'));
  const formatSize = (value) => {
    if (value == null || value < 0) return '—';
    if (value < 1024) return value + ' B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
    return (value / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0) + ' ' + units[i];
  };
  const formattedDate = (timestamp) => timestamp ? new Date(timestamp * 1000).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }) : '—';
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function encodeFileUrl(path) {
    return path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  }
  function parseBrowse(html, directory) {
    // Browse.php responds with bare tbody/tfoot fragments, not an entire table.
    const doc = new DOMParser().parseFromString('<table>' + html + '</table>', 'text/html');
    if (!doc.querySelector('tbody, tfoot')) throw new Error('Unraid 返回了无法识别的目录数据');
    return $$('i[id^="row_"][type]', doc).map((icon) => {
      const row = icon.closest('tr');
      const cells = row ? Array.from(row.cells) : [];
      const path = icon.getAttribute('data') || '';
      const folder = icon.getAttribute('type') === 'd';
      if (!safePath(path) || !row || cells.length < 7 || !path.startsWith(directory.replace(/\/$/, '') + '/')) return null;
      return {
        path, name: path.substring(path.lastIndexOf('/') + 1), folder,
        size: folder ? null : Number(cells[5].getAttribute('data') || '0'),
        mtime: Number(cells[6].getAttribute('data') || '0'),
        owner: (cells[3].textContent || '').trim(),
        permissions: (cells[4].textContent || '').trim()
      };
    }).filter(Boolean);
  }
  async function listDirectory(path) {
    if (!safePath(path)) throw new Error('仅允许访问 /mnt/user 下的共享目录');
    if (isDemo) {
      const data = window.__UFS_DEMO__ || {};
      await Promise.resolve();
      return (data[path] || []).map((entry) => ({
        ...entry, path: path + '/' + entry.name, size: entry.folder ? null : entry.size
      }));
    }
    const url = new URL('/webGui/include/Browse.php', location.origin);
    // Unraid 7.2.2 applies rawurldecode to this parameter after PHP has decoded the query.
    url.searchParams.set('dir', encodeURIComponent(path));
    url.searchParams.set('path', location.pathname.replace(/^\/+/, ''));
    const response = await fetch(url.toString(), { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('读取失败：HTTP ' + response.status);
    const html = await response.text();
    if (/Invalid path/i.test(html)) throw new Error('目录无效或没有访问权限');
    return parseBrowse(html, path);
  }


  // Small local SVG set: no external fonts, CDNs or global icon CSS.
  const ICONS = {
    folder:['M3 7a2 2 0 0 1 2-2h4l2 2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
    'folder-open':['M3 7a2 2 0 0 1 2-2h4l2 2h9a2 2 0 0 1 2 2','M3 11h17a2 2 0 0 1 1.9 2.6L20 19H4a2 2 0 0 1-1.9-2.6z'],
    file:['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z','M14 2v6h6'],
    archive:['M4 4h16v16H4z','M4 9h16','M12 9v8','M10 13h4'],
    image:['M3 3h18v18H3z','M8 8h.01','m3 13 5-5 5 5'],
    video:['M3 5h18v14H3z','m10 4 5 3-5 3z'],
    disc:['M4 5h16v14H4z','M7 9h10','M7 13h10'],
    drive:['M5 5h14l3 11v3H2v-3z','M2 16h20','M17 18h.01'],
    'chevron-right':['m9 18 6-6-6-6'],
    'chevron-down':['m6 9 6 6 6-6'],
    'chevron-left':['m15 18-6-6 6-6'],
    'arrow-left':['M19 12H5','m12 19-7-7 7-7'],
    'arrow-right':['M5 12h14','m12 5 7 7-7 7'],
    'arrow-up':['M12 19V5','m5 12 7-7 7 7'],
    refresh:['M20 7v5h-5','M4 17v-5h5','M5.6 9A7 7 0 0 1 18 6l2 1','M18.4 15A7 7 0 0 1 6 18l-2-1'],
    theme:['M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13z'],
    list:['M8 6h13','M8 12h13','M8 18h13','M3 6h.01','M3 12h.01','M3 18h.01'],
    grid:['M3 3h7v7H3z','M14 3h7v7h-7z','M3 14h7v7H3z','M14 14h7v7h-7z'],
    panel:['M3 3h18v18H3z','M15 3v18'],
    plus:['M12 5v14','M5 12h14'],
    upload:['M12 16V3','m5 10 7-7 7 7','M4 17v3h16v-3'],
    copy:['M8 4h11a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z','M4 16H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v1'],
    move:['M4 7h16','m15 3 5 4-5 4','M20 17H4','m9 13-5 4 5 4'],
    trash:['M3 6h18','M8 6V4h8v2','M5 6l1 15h12l1-15','M10 10v7','M14 10v7'],
    search:['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z','m17 17 4 4'],
    close:['M6 6l12 12','M18 6 6 18'],
    download:['M12 3v13','m5 10 7 7 7-7','M4 18v3h16v-3'],
    info:['M12 17v-5','M12 8h.01','M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z'],
    'external-link':['M14 3h7v7','M21 3l-9 9','M20 13v7H4V4h7']
  };
  function icon(name, className = '') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('ufs-svg');
    if (className) svg.classList.add(className);
    (ICONS[name] || ICONS.file).forEach((d) => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      svg.append(path);
    });
    return svg;
  }
  function fileIcon(entry) {
    if (entry.folder) return icon('folder', 'ufs-folder-icon');
    const ext = entry.name.split('.').pop().toLowerCase();
    const kind = ['jpg','jpeg','png','webp','gif','svg','heic','raw'].includes(ext) ? 'image' :
      ['mp4','mov','mkv','webm','avi'].includes(ext) ? 'video' :
      ['zip','7z','rar','tar','gz'].includes(ext) ? 'archive' : 'file';
    return icon(kind, 'ufs-file-icon');
  }

  const css = [
    '#ufs-app{--ufs-accent:#eb7825;--ufs-accent-soft:#fff1e4;--ufs-bg:#fff;--ufs-panel:#f7f8fa;--ufs-text:#252a30;--ufs-muted:#727a85;--ufs-border:#e1e5eb;--ufs-hover:#f2f5f8;--ufs-sel:#fff0e2;--ufs-sidebar-width:245px;color:var(--ufs-text);background:var(--ufs-bg);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;border:1px solid var(--ufs-border);border-radius:7px;overflow:hidden;display:flex;flex-direction:column;height:var(--ufs-available-height,65vh);min-height:260px;margin:0 0 8px;line-height:1.45;font-size:13px;position:relative}',
    '#ufs-app.ufs-dsm{--ufs-accent:#318bd2;--ufs-accent-soft:#e8f3ff;--ufs-panel:#f4f7fa;--ufs-hover:#edf4fc;--ufs-sel:#e7f2ff}',
    '#ufs-app *,#ufs-app *::before,#ufs-app *::after{box-sizing:border-box}#ufs-app button,#ufs-app input{font-family:inherit;font-size:inherit;font-weight:inherit;letter-spacing:normal;text-transform:none;line-height:1.4;box-shadow:none;text-shadow:none;border-radius:5px}#ufs-app button{cursor:pointer}#ufs-app button:disabled{opacity:.42;cursor:not-allowed}#ufs-app button:focus-visible,#ufs-app input:focus-visible,#ufs-app .ufs-entry:focus-visible{outline:2px solid var(--ufs-accent);outline-offset:1px}',
    '#ufs-app .ufs-svg{height:16px;width:16px;min-width:16px;display:inline-block;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;vertical-align:middle;pointer-events:none}#ufs-app .ufs-folder-icon{color:#dba44e}#ufs-app .ufs-file-icon{color:#889bac}#ufs-app .ufs-mark{color:var(--ufs-accent)}',
    '#ufs-app .ufs-top,#ufs-app .ufs-toolbar,#ufs-app .ufs-navigation,#ufs-app .ufs-tabs,#ufs-app .ufs-status{display:flex;align-items:center;gap:7px;border-bottom:1px solid var(--ufs-border);flex-shrink:0;min-width:0}',
    '#ufs-app .ufs-top{background:var(--ufs-panel);height:48px;padding:0 14px}#ufs-app .ufs-heading{font-size:16px;font-weight:650;letter-spacing:0;text-transform:none}#ufs-app .ufs-version{font-size:11px;color:var(--ufs-muted)}',
    '#ufs-app .ufs-spacer{flex:1;min-width:6px}#ufs-app .ufs-muted{color:var(--ufs-muted)}#ufs-app .ufs-ico{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:30px;height:30px;padding:4px 9px;border:1px solid transparent;background:transparent;color:var(--ufs-text);white-space:nowrap;vertical-align:middle}#ufs-app .ufs-ico:hover:not(:disabled){background:var(--ufs-hover)}',
    '#ufs-app .ufs-ico.ufs-primary{background:var(--ufs-accent);border-color:var(--ufs-accent);color:#fff}#ufs-app .ufs-ico.ufs-primary:hover{filter:brightness(.96)}#ufs-app .ufs-ico.ufs-view-active{background:var(--ufs-accent-soft);color:var(--ufs-accent);border-color:var(--ufs-accent-soft)}#ufs-app .ufs-ico.ufs-view-active:hover{background:var(--ufs-accent-soft)}',
    '#ufs-app .ufs-tabs{height:36px;background:var(--ufs-panel);padding:3px 9px;gap:5px;overflow-x:auto;overflow-y:hidden}#ufs-app .ufs-tab{display:inline-flex;align-items:center;gap:8px;border:1px solid transparent;height:29px;min-width:0;max-width:220px;padding:3px 10px;background:transparent;color:var(--ufs-muted)}#ufs-app .ufs-tab.ufs-active{background:var(--ufs-bg);border-color:var(--ufs-border);color:var(--ufs-text);font-weight:600}',
    '#ufs-app .ufs-tab-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#ufs-app .ufs-tab-close{display:flex;align-items:center;border:0;background:transparent;color:var(--ufs-muted);height:19px;width:19px;padding:0;justify-content:center}#ufs-app .ufs-tab-close:hover{background:var(--ufs-hover)}',
    '#ufs-app .ufs-toolbar{height:44px;padding:0 10px;overflow-x:auto}#ufs-app .ufs-toolbar::-webkit-scrollbar,#ufs-app .ufs-tabs::-webkit-scrollbar{height:4px}#ufs-app .ufs-separator{height:18px;width:1px;background:var(--ufs-border);flex-shrink:0}#ufs-app .ufs-write[disabled]{color:var(--ufs-muted)}',
    '#ufs-app .ufs-navigation{height:42px;padding:0 10px}#ufs-app .ufs-address{display:flex;align-items:center;gap:6px;min-width:60px;flex:1;padding:4px 10px;border:1px solid var(--ufs-border);border-radius:5px;background:var(--ufs-panel);overflow-x:auto;scrollbar-width:none;white-space:nowrap}#ufs-app .ufs-address::-webkit-scrollbar{display:none}',
    '#ufs-app .ufs-crumb{border:0;background:none;color:var(--ufs-text);padding:2px;white-space:nowrap;flex-shrink:0}#ufs-app .ufs-crumb:hover{color:var(--ufs-accent)}#ufs-app .ufs-search{height:29px;border:1px solid var(--ufs-border);background:var(--ufs-bg);color:var(--ufs-text);border-radius:5px;padding:4px 9px;width:175px;min-width:92px;max-width:22%}',
    '#ufs-app .ufs-workspace{display:flex;flex:1;min-height:0;overflow:hidden}#ufs-app .ufs-sidebar{background:var(--ufs-panel);width:var(--ufs-sidebar-width);flex:0 0 var(--ufs-sidebar-width);min-width:0;overflow:auto;padding:8px 7px}#ufs-app .ufs-resizer{width:5px;flex:0 0 5px;background:var(--ufs-border);cursor:col-resize;touch-action:none;opacity:.7}#ufs-app .ufs-resizer:hover{background:var(--ufs-accent)}',
    '#ufs-app .ufs-tree-label{padding:7px 8px;color:var(--ufs-muted);font-size:12px;font-weight:600;letter-spacing:0}#ufs-app .ufs-tree-row{display:flex;align-items:center;gap:7px;width:100%;height:31px;min-height:31px;padding:0 7px;border:0;background:transparent;text-align:left;color:var(--ufs-text);border-radius:5px;min-width:0}',
    '#ufs-app .ufs-tree-row:hover{background:var(--ufs-hover)}#ufs-app .ufs-tree-row.ufs-current{background:var(--ufs-sel);color:var(--ufs-accent);font-weight:600}#ufs-app .ufs-tree-toggle{display:inline-flex;align-items:center;justify-content:center;width:16px;min-width:16px;height:24px;min-height:0;padding:0!important;margin:0;border:0;background:transparent;color:var(--ufs-muted);flex:0 0 16px;line-height:1}',
    '#ufs-app .ufs-tree-spacer{width:16px;flex:0 0 16px}#ufs-app .ufs-tree-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;text-transform:none;letter-spacing:normal}',
    '#ufs-app .ufs-main{display:flex;flex-direction:column;flex:1;min-width:0;background:var(--ufs-bg)}#ufs-app .ufs-list{min-height:0;overflow:auto;flex:1;padding:0 8px;outline:0}',
    '#ufs-app .ufs-head,#ufs-app .ufs-entry{display:grid;grid-template-columns:minmax(160px,2.5fr) minmax(72px,.65fr) minmax(132px,1.2fr) minmax(82px,.75fr);align-items:center;gap:10px;padding:0 12px;border-bottom:1px solid var(--ufs-border)}#ufs-app .ufs-head{height:34px;min-height:34px;font-weight:600;color:var(--ufs-muted);font-size:12px;position:sticky;top:0;background:var(--ufs-bg);z-index:1}',
    '#ufs-app .ufs-entry{min-height:38px;height:38px;border-radius:3px;cursor:default}#ufs-app .ufs-entry:hover{background:var(--ufs-hover)}#ufs-app .ufs-entry.ufs-selected{background:var(--ufs-sel);outline:1px solid var(--ufs-accent);outline-offset:-1px}#ufs-app .ufs-entry>span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#ufs-app .ufs-file-name{display:flex;align-items:center;gap:9px;min-width:0}#ufs-app .ufs-file-name .ufs-filename{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}',
    '#ufs-app .ufs-sort-button{display:inline-flex;align-items:center;gap:5px;width:100%;height:30px;border:0;padding:0;background:transparent;text-align:left;color:inherit;white-space:nowrap}#ufs-app .ufs-sort-button .ufs-sort-mark{color:var(--ufs-accent);font-size:12px}',
    '#ufs-app .ufs-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(125px,1fr));gap:10px;align-content:start;padding:14px}#ufs-app .ufs-grid .ufs-entry{display:flex;height:auto;flex-direction:column;text-align:center;gap:7px;border:1px solid var(--ufs-border);padding:16px 8px;min-width:0;min-height:107px}',
    '#ufs-app .ufs-grid .ufs-file-name{flex-direction:column;max-width:100%;gap:7px}#ufs-app .ufs-grid .ufs-file-name .ufs-svg{width:34px;height:34px}#ufs-app .ufs-grid .ufs-extra{display:none}',
    '#ufs-app .ufs-inspector{width:285px;min-width:220px;max-width:38%;border-left:1px solid var(--ufs-border);background:var(--ufs-panel);padding:14px;overflow:auto}#ufs-app .ufs-inspector[hidden]{display:none}#ufs-app .ufs-inspector h3{margin:0 0 12px;font-size:14px}#ufs-app .ufs-prop{display:flex;justify-content:space-between;gap:15px;margin:10px 0;word-break:break-word}#ufs-app .ufs-prop span:first-child{color:var(--ufs-muted);flex-shrink:0}',
    '#ufs-app .ufs-status{height:30px;border-top:1px solid var(--ufs-border);border-bottom:0;background:var(--ufs-panel);justify-content:space-between;padding:0 12px;color:var(--ufs-muted);font-size:12px;gap:14px}#ufs-app .ufs-status span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
    '#ufs-app .ufs-empty{padding:48px 20px;text-align:center;color:var(--ufs-muted)}#ufs-app .ufs-error{color:#c13d37}#ufs-app .ufs-menu{position:fixed;z-index:2147483647;background:var(--ufs-bg);border:1px solid var(--ufs-border);border-radius:7px;box-shadow:0 10px 32px #0002;min-width:190px;padding:5px}',
    '#ufs-app .ufs-menu button{background:transparent;border:0;display:block;width:100%;text-align:left;padding:8px 12px;color:var(--ufs-text)}#ufs-app .ufs-menu button:hover{background:var(--ufs-hover)}#ufs-app .ufs-toast{position:absolute;bottom:42px;right:25px;background:#30363c;color:#fff;padding:10px 14px;border-radius:6px;box-shadow:0 5px 18px #0003;max-width:360px}',
    '.ufs-hide-native{display:none!important}#ufs-native-enable{margin:8px;padding:7px 12px;background:#e87526;color:#fff;border:0;border-radius:5px;cursor:pointer}',
    '@media(max-width:980px){#ufs-app .ufs-inspector{display:none}#ufs-app .ufs-entry,#ufs-app .ufs-head{grid-template-columns:minmax(140px,1fr) 85px 150px}#ufs-app .ufs-permission{display:none}}',
    '@media(max-width:720px){#ufs-app .ufs-sidebar{width:42px;flex-basis:42px;padding:4px}#ufs-app .ufs-resizer{display:none}#ufs-app .ufs-sidebar .ufs-tree-name,#ufs-app .ufs-tree-label,#ufs-app .ufs-tree-toggle,#ufs-app .ufs-sidebar .ufs-tree-spacer{display:none}#ufs-app .ufs-toolbar{overflow-x:auto}#ufs-app .ufs-entry,#ufs-app .ufs-head{grid-template-columns:minmax(120px,1fr) 80px}#ufs-app .ufs-date{display:none}#ufs-app .ufs-search{width:90px}}'
  ].join('\n');

  const state = {
    tabs: [], activeId: 0, nextId: 1, entries: [], tree: new Map(),
    expanded: new Set([PREFIX]), selection: new Set(), lastIndex: -1,
    view: localStorage.getItem(STORE + 'view') || 'list',
    theme: localStorage.getItem(STORE + 'theme') || 'unraid',
    inspector: false, filter: '', busy: false, requestId: 0,
    sortKey: 'name', sortDirection: 1
  };
  let app;
  let nativeElements = [];
  let currentMenu = null;
  function activeTab() { return state.tabs.find((tab) => tab.id === state.activeId); }
  function currentPath() { return activeTab() ? activeTab().path : PREFIX; }
  function notify(message) {
    const previous = $('.ufs-toast', app);
    if (previous) previous.remove();
    const toast = element('div', 'ufs-toast', message);
    app.append(toast);
    setTimeout(() => { if (toast.isConnected) toast.remove(); }, 3500);
  }
  function nativeMode() {
    if (isDemo) { notify('演示模式没有原生文件管理器'); return; }
    localStorage.setItem(STORE + 'native', '1');
    location.reload();
  }
  function toggleTheme() {
    state.theme = state.theme === 'unraid' ? 'dsm' : 'unraid';
    localStorage.setItem(STORE + 'theme', state.theme);
    app.classList.toggle('ufs-dsm', state.theme === 'dsm');
    notify(state.theme === 'dsm' ? '已切换到 DSM 经典主题' : '已切换到 Unraid 融合主题');
  }
  function writeUrl(path, replace) {
    if (isDemo) return;
    const url = new URL(location.href);
    url.searchParams.set('dir', path);
    history[replace ? 'replaceState' : 'pushState']({ ufs: true }, '', url);
  }
  function addTab(path, activate = true) {
    if (!safePath(path)) return;
    const tab = { id: state.nextId++, path, history: [path], cursor: 0 };
    state.tabs.push(tab);
    if (activate) switchTab(tab.id);
    else renderTabs();
  }
  function closeTab(id) {
    if (state.tabs.length === 1) return notify('至少保留一个标签页');
    const index = state.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    state.tabs.splice(index, 1);
    if (state.activeId === id) switchTab(state.tabs[Math.max(0, index - 1)].id);
    else renderTabs();
  }
  function switchTab(id) {
    state.activeId = id;
    state.selection.clear();
    state.filter = '';
    state.lastIndex = -1;
    const search = $('.ufs-search', app);
    if (search) search.value = '';
    writeUrl(currentPath(), true);
    renderTabs();
    refreshDirectory();
  }
  function navigate(path, addHistory = true) {
    if (!safePath(path)) return notify('此版本仅支持访问 User Shares');
    const tab = activeTab();
    if (!tab || tab.path === path) return;
    tab.path = path;
    if (addHistory) {
      tab.history = tab.history.slice(0, tab.cursor + 1);
      tab.history.push(path);
      tab.cursor = tab.history.length - 1;
    }
    state.selection.clear();
    state.lastIndex = -1;
    state.filter = '';
    $('.ufs-search', app).value = '';
    writeUrl(path, false);
    renderTabs();
    refreshDirectory();
  }
  function stepHistory(amount) {
    const tab = activeTab();
    const next = tab.cursor + amount;
    if (next < 0 || next >= tab.history.length) return;
    tab.cursor = next;
    navigate(tab.history[next], false);
  }
  async function loadTree(path) {
    if (state.tree.has(path)) return;
    try {
      const entries = await listDirectory(path);
      state.tree.set(path, entries.filter((entry) => entry.folder));
      renderTree();
    } catch (error) {
      state.tree.set(path, []);
      renderTree();
      notify('目录树读取失败：' + error.message);
    }
  }
  async function refreshDirectory() {
    const path = currentPath();
    const request = ++state.requestId;
    state.busy = true;
    state.entries = [];
    renderNavigation();
    renderFiles();
    try {
      const entries = await listDirectory(path);
      if (request !== state.requestId) return;
      state.entries = entries;
      state.busy = false;
      state.tree.set(path, entries.filter((entry) => entry.folder));
      renderFiles();
      renderTree();
      renderNavigation();
    } catch (error) {
      if (request !== state.requestId) return;
      state.busy = false;
      state.entries = [];
      renderFiles(error.message);
      renderNavigation();
    }
  }
  function renderTabs() {
    const target = $('.ufs-tabs', app);
    target.replaceChildren();
    state.tabs.forEach((tab) => {
      const node = element('button', 'ufs-tab' + (tab.id === state.activeId ? ' ufs-active' : ''));
      node.title = tab.path;
      node.append(icon('folder', 'ufs-folder-icon'));
      node.append(element('span', 'ufs-tab-name', tab.path === PREFIX ? '共享文件夹' : tab.path.split('/').pop()));
      const close = element('span', 'ufs-tab-close');
      close.append(icon('close'));
      close.title = '关闭标签';
      close.addEventListener('click', (event) => { event.stopPropagation(); closeTab(tab.id); });
      node.append(close);
      node.addEventListener('click', () => { if (state.activeId !== tab.id) switchTab(tab.id); });
      target.append(node);
    });
    const add = element('button', 'ufs-ico');
    add.append(icon('plus'));
    add.setAttribute('aria-label', '新建标签页');
    add.title = '新建标签页';
    add.addEventListener('click', () => addTab(PREFIX));
    target.append(add);
  }
  function renderTree() {
    const target = $('.ufs-tree', app);
    target.replaceChildren();
    target.append(element('div', 'ufs-tree-label', '共享文件夹'));
    function appendNode(path, level) {
      const wrapper = element('div', 'ufs-tree-node');
      const row = element('div', 'ufs-tree-row' + (currentPath() === path ? ' ufs-current' : ''));
      row.style.paddingLeft = (6 + level * 14) + 'px';
      const children = state.tree.get(path);
      const hasKnownChildren = children && children.length > 0;
      const toggler = element('button', 'ufs-tree-toggle');
      toggler.append(icon(state.expanded.has(path) ? 'chevron-down' : 'chevron-right'));
      if (children && !hasKnownChildren) toggler.style.visibility = 'hidden';
      toggler.title = '展开或折叠';
      toggler.addEventListener('click', async () => {
        if (state.expanded.has(path)) state.expanded.delete(path);
        else { state.expanded.add(path); await loadTree(path); }
        renderTree();
      });
      row.append(toggler, icon(state.expanded.has(path) ? 'folder-open' : 'folder', 'ufs-folder-icon'));
      if (path === PREFIX) row.lastChild.replaceWith(icon('drive', 'ufs-file-icon'));
      row.append(element('span', 'ufs-tree-name', path === PREFIX ? '所有共享文件夹' : path.split('/').pop()));
      row.title = path;
      row.addEventListener('click', (event) => { if (event.target === toggler) return; navigate(path); });
      wrapper.append(row);
      target.append(wrapper);
      if (state.expanded.has(path)) {
        (state.tree.get(path) || []).forEach((entry) => appendNode(entry.path, level + 1));
      }
    }
    appendNode(PREFIX, 0);
  }
  function renderNavigation() {
    const address = $('.ufs-address', app);
    address.replaceChildren();
    const parts = currentPath().split('/').filter(Boolean);
    const paths = [PREFIX];
    for (let i = 3; i <= parts.length; i++) paths.push('/' + parts.slice(0, i).join('/'));
    [...new Set(paths)].forEach((path, index) => {
      if (index) address.append(icon('chevron-right', 'ufs-muted'));
      const crumb = element('button', 'ufs-crumb', path === PREFIX ? '共享文件夹' : path.split('/').pop());
      crumb.title = path;
      crumb.addEventListener('click', () => navigate(path));
      address.append(crumb);
    });
    const tab = activeTab();
    $('.ufs-back', app).disabled = !tab || tab.cursor <= 0;
    $('.ufs-next', app).disabled = !tab || tab.cursor >= tab.history.length - 1;
    $('.ufs-up', app).disabled = currentPath() === PREFIX;
    $('.ufs-refresh', app).disabled = state.busy;
  }
  function visibleEntries() {
    const q = state.filter.trim().toLocaleLowerCase();
    return state.entries.filter((entry) => !q || entry.name.toLocaleLowerCase().includes(q))
      .sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  }
  function selectEntry(event, entry, index, visible) {
    if (event.shiftKey && state.lastIndex >= 0) {
      const a = Math.min(state.lastIndex, index);
      const b = Math.max(state.lastIndex, index);
      if (!event.metaKey && !event.ctrlKey) state.selection.clear();
      visible.slice(a, b + 1).forEach((item) => state.selection.add(item.path));
    } else if (event.metaKey || event.ctrlKey) {
      if (state.selection.has(entry.path)) state.selection.delete(entry.path);
      else state.selection.add(entry.path);
      state.lastIndex = index;
    } else {
      state.selection.clear();
      state.selection.add(entry.path);
      state.lastIndex = index;
    }
    renderSelection();
  }
  function renderSelection() {
    $$('[data-ufs-file]', app).forEach((node) => node.classList.toggle('ufs-selected', state.selection.has(node.dataset.ufsFile)));
    const count = state.selection.size;
    $('.ufs-count', app).textContent = state.busy ? '正在读取目录…' :
      state.entries.length + ' 个项目' + (count ? ' · 已选择 ' + count + ' 个项目' : '');
    renderInspector();
  }
  function renderInspector() {
    const box = $('.ufs-inspector', app);
    box.hidden = !state.inspector;
    if (!state.inspector) return;
    box.replaceChildren();
    box.append(element('h3', '', '详细信息'));
    const chosen = state.entries.filter((entry) => state.selection.has(entry.path));
    if (chosen.length !== 1) {
      box.append(element('div', 'ufs-muted', chosen.length ? '选中了 ' + chosen.length + ' 个项目' : '选择文件后查看详细信息'));
      return;
    }
    const entry = chosen[0];
    const props = [['名称', entry.name], ['类型', entry.folder ? '文件夹' : '文件'], ['大小', formatSize(entry.size)],
      ['修改日期', formattedDate(entry.mtime)], ['所有者', entry.owner || '—'], ['权限', entry.permissions || '—'], ['路径', entry.path]];
    props.forEach(([label, value]) => {
      const row = element('div', 'ufs-prop');
      row.append(element('span', '', label), element('span', '', value));
      box.append(row);
    });
  }
  function renderFiles(error = '') {
    const list = $('.ufs-list', app);
    list.replaceChildren();
    list.classList.toggle('ufs-grid', state.view === 'grid');
    $('.ufs-list-button', app).classList.toggle('ufs-view-active', state.view === 'list');
    $('.ufs-grid-button', app).classList.toggle('ufs-view-active', state.view === 'grid');
    if (state.view === 'list') {
      const head = element('div', 'ufs-head');
      ['名称', '大小', '修改日期', '权限'].forEach((name, index) =>
        head.append(element('span', index === 2 ? 'ufs-date' : index === 3 ? 'ufs-permission' : '', name)));
      list.append(head);
    }
    if (error) list.append(element('div', 'ufs-empty ufs-error', error + '。可切换回 Unraid 原生界面检查。'));
    else if (state.busy) list.append(element('div', 'ufs-empty', '正在读取文件…'));
    else {
      const entries = visibleEntries();
      if (!entries.length) list.append(element('div', 'ufs-empty', state.filter ? '没有匹配的文件' : '此文件夹为空'));
      entries.forEach((entry, index) => {
        const row = element('div', 'ufs-entry');
        row.dataset.ufsFile = entry.path;
        row.tabIndex = 0;
        row.title = entry.path;
        const name = element('div', 'ufs-file-name');
        name.append(fileIcon(entry));
        name.append(element('span', 'ufs-filename', entry.name));
        row.append(name,
          element('span', 'ufs-extra', formatSize(entry.size)),
          element('span', 'ufs-extra ufs-date', formattedDate(entry.mtime)),
          element('span', 'ufs-extra ufs-permission', entry.permissions || '—'));
        row.addEventListener('click', (event) => selectEntry(event, entry, index, entries));
        row.addEventListener('dblclick', () => openEntry(entry));
        row.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          if (!state.selection.has(entry.path)) {
            state.selection.clear();
            state.selection.add(entry.path);
            state.lastIndex = index;
            renderSelection();
          }
          showMenu(event.clientX, event.clientY, entry);
        });
        list.append(row);
      });
    }
    renderSelection();
  }
  function openEntry(entry) {
    if (entry.folder) return navigate(entry.path);
    const ext = (entry.name.split('.').pop() || '').toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'pdf', 'mp4', 'webm', 'txt'].includes(ext)) {
      notify('预览功能将在下一阶段接入。可以先下载或使用原生文件管理器。');
    } else downloadEntry(entry);
  }
  function downloadEntry(entry) {
    if (entry.folder) return notify('文件夹打包下载将在后续版本提供');
    if (isDemo) return notify('演示模式不会下载真实文件');
    const link = element('a');
    link.href = encodeFileUrl(entry.path);
    link.download = entry.name;
    link.style.display = 'none';
    document.body.append(link);
    link.click();
    link.remove();
  }
  function closeMenu() {
    if (currentMenu) currentMenu.remove();
    currentMenu = null;
  }
  function showMenu(x, y, entry) {
    closeMenu();
    const menu = element('div', 'ufs-menu');
    const actions = [
      [entry.folder ? '打开' : '打开 / 下载', () => openEntry(entry)],
      ...(entry.folder ? [['在新标签中打开', () => addTab(entry.path)]] : [['下载', () => downloadEntry(entry)]]),
      ['复制文件路径', async () => {
        try { await navigator.clipboard.writeText(entry.path); notify('已复制路径'); }
        catch (_) { notify('浏览器阻止了剪贴板访问'); }
      }],
      ['重命名 / 移动 / 删除（原生）', nativeMode]
    ];
    actions.forEach(([label, fn]) => {
      const button = element('button', '', label);
      button.addEventListener('click', () => { closeMenu(); fn(); });
      menu.append(button);
    });
    app.append(menu);
    menu.style.left = Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8)) + 'px';
    currentMenu = menu;
  }
  function renderUI() {
    app = element('section');
    app.id = 'ufs-app';
    app.className = state.theme === 'dsm' ? 'ufs-dsm' : '';
    app.setAttribute('aria-label', 'Unraid File Station');
    app.innerHTML = [
      '<div class="ufs-top"><span data-ufs-icon="folder-open" class="ufs-mark"></span><span class="ufs-heading">File Station</span>',
      '<span class="ufs-version">Unraid 7.2.2 · 只读预览</span><span class="ufs-spacer"></span>',
      '<button type="button" class="ufs-ico ufs-theme" title="切换主题"><span data-ufs-icon="theme"></span><span>主题</span></button>',
      '<button type="button" class="ufs-ico ufs-refresh" title="刷新目录"><span data-ufs-icon="refresh"></span><span>刷新</span></button>',
      '<button type="button" class="ufs-ico ufs-native"><span data-ufs-icon="external-link"></span><span>返回原生</span></button></div>',
      '<div class="ufs-tabs"></div>',
      '<div class="ufs-toolbar" role="toolbar" aria-label="文件工具栏">',
      '<button type="button" class="ufs-ico ufs-write" disabled title="只读预览版不支持新建"><span data-ufs-icon="plus"></span>新建</button>',
      '<button type="button" class="ufs-ico ufs-write" disabled title="只读预览版不支持上传"><span data-ufs-icon="upload"></span>上传</button>',
      '<span class="ufs-separator"></span>',
      '<button type="button" class="ufs-ico ufs-write" disabled title="只读预览版不支持复制"><span data-ufs-icon="copy"></span>复制</button>',
      '<button type="button" class="ufs-ico ufs-write" disabled title="只读预览版不支持移动"><span data-ufs-icon="move"></span>移动</button>',
      '<button type="button" class="ufs-ico ufs-write" disabled title="只读预览版不支持删除"><span data-ufs-icon="trash"></span>删除</button>',
      '<span class="ufs-spacer"></span>',
      '<button type="button" class="ufs-ico ufs-list-button" title="列表视图" aria-label="列表视图"><span data-ufs-icon="list"></span></button>',
      '<button type="button" class="ufs-ico ufs-grid-button" title="网格视图" aria-label="网格视图"><span data-ufs-icon="grid"></span></button>',
      '<button type="button" class="ufs-ico ufs-details-button" title="显示或隐藏详细信息" aria-label="显示或隐藏详细信息"><span data-ufs-icon="panel"></span></button></div>',
      '<div class="ufs-navigation"><button type="button" class="ufs-ico ufs-back" title="后退" aria-label="后退"><span data-ufs-icon="arrow-left"></span></button>',
      '<button type="button" class="ufs-ico ufs-next" title="前进" aria-label="前进"><span data-ufs-icon="arrow-right"></span></button>',
      '<button type="button" class="ufs-ico ufs-up" title="上一级" aria-label="上一级"><span data-ufs-icon="arrow-up"></span></button>',
      '<div class="ufs-address"></div><input class="ufs-search" type="search" placeholder="筛选当前文件夹" aria-label="筛选当前文件夹"></div>',
      '<div class="ufs-workspace"><aside class="ufs-sidebar"><div class="ufs-tree"></div></aside>',
      '<div class="ufs-resizer" role="separator" aria-label="调整目录树宽度" aria-orientation="vertical"></div>',
      '<main class="ufs-main"><div class="ufs-list" tabindex="0"></div></main>',
      '<aside class="ufs-inspector" hidden></aside></div>',
      '<div class="ufs-status"><span class="ufs-count">准备就绪</span>',
      '<span>只读预览 · 写入操作请使用原生文件管理器</span></div>'
    ].join('');
    $$('[data-ufs-icon]', app).forEach((placeholder) => {
      placeholder.replaceWith(icon(placeholder.dataset.ufsIcon,
        placeholder.classList.contains('ufs-mark') ? 'ufs-mark' : ''));
    });
    $('.ufs-refresh', app).addEventListener('click', refreshDirectory);
    $('.ufs-theme', app).addEventListener('click', toggleTheme);
    $('.ufs-native', app).addEventListener('click', nativeMode);
    // Writes remain disabled in v0.1; native Unraid is the only write surface.
    $('.ufs-back', app).addEventListener('click', () => stepHistory(-1));
    $('.ufs-next', app).addEventListener('click', () => stepHistory(1));
    $('.ufs-up', app).addEventListener('click', () => navigate(currentPath().split('/').slice(0, -1).join('/') || PREFIX));
    $('.ufs-search', app).addEventListener('input', (event) => { state.filter = event.target.value; renderFiles(); });
    $('.ufs-list-button', app).addEventListener('click', () => setView('list'));
    $('.ufs-grid-button', app).addEventListener('click', () => setView('grid'));
    $('.ufs-details-button', app).addEventListener('click', () => {
      state.inspector = !state.inspector; renderInspector();
    });
    $('.ufs-list', app).addEventListener('contextmenu', (event) => {
      if (event.target === $('.ufs-list', app)) {
        event.preventDefault();
        showMenu(event.clientX, event.clientY, { path: currentPath(), name: '', folder: true });
      }
    });
    document.addEventListener('pointerdown', (event) => {
      if (currentMenu && !currentMenu.contains(event.target)) closeMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (!app.isConnected || !app.contains(event.target)) return;
      if (event.target.closest('input,textarea,[contenteditable]')) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        visibleEntries().forEach((entry) => state.selection.add(entry.path));
        renderSelection();
      }
      if (event.key === 'Escape') { closeMenu(); state.selection.clear(); renderSelection(); }
      if (event.key === 'Backspace' && !event.metaKey && !event.ctrlKey) { event.preventDefault(); stepHistory(-1); }
    });
    window.addEventListener('popstate', () => {
      if (!app.isConnected || isDemo) return;
      const path = new URLSearchParams(location.search).get('dir') || PREFIX;
      if (!safePath(path) || path === currentPath()) return;
      const tab = activeTab();
      tab.path = path; tab.history = [path]; tab.cursor = 0;
      state.selection.clear(); renderTabs(); refreshDirectory();
    });
    return app;
  }
  function setView(view) {
    state.view = view;
    localStorage.setItem(STORE + 'view', view);
    renderFiles();
  }
  function addSharesEntry() {
    const form = document.querySelector('form[name="share_form"]');
    if (!form || $('#ufs-shares-entry')) return;
    const button = element('button', '', 'FILE STATION');
    button.id = 'ufs-shares-entry';
    button.type = 'button';
    button.style.cssText = 'border:1px solid #e87526;color:#e87526;background:transparent;border-radius:4px;padding:9px 12px;margin-left:10px;font-weight:bold;cursor:pointer';
    button.addEventListener('click', () => { location.href = '/Shares/Browse?dir=' + encodeURIComponent(PREFIX); });
    form.append(button);
  }
  function setupBrowser() {
    const original = $('table.indexer');
    const native = original && original.closest('.autoheight');
    if (!native && !isDemo) return false;
    const mount = isDemo ? $('#ufs-demo-mount') : native.parentNode;
    if (!mount) return false;
    const disabled = !isDemo && localStorage.getItem(STORE + 'native') === '1';
    if (disabled) {
      if ($('#ufs-native-enable')) return true;
      const button = element('button', '', '打开 File Station');
      button.id = 'ufs-native-enable';
      button.addEventListener('click', () => {
        localStorage.removeItem(STORE + 'native');
        location.reload();
      });
      native.parentNode.insertBefore(button, native);
      return true;
    }
    const start = isDemo ? '/mnt/user/downloads' : new URLSearchParams(location.search).get('dir') || PREFIX;
    if (!safePath(start)) return false;
    const style = element('style');
    style.textContent = css;
    document.head.append(style);
    const root = renderUI();
    if (isDemo) mount.append(root);
    else {
      nativeElements = [native, $('#buttons')].filter(Boolean);
      nativeElements.forEach((node) => node.classList.add('ufs-hide-native'));
      native.parentNode.insertBefore(root, native);
    }
    state.tabs = [{ id: state.nextId++, path: start, history: [start], cursor: 0 }];
    state.activeId = state.tabs[0].id;
    renderTabs();
    renderNavigation();
    renderTree();
    loadTree(PREFIX);
    refreshDirectory();
    return true;
  }
  function begin() {
    if (sharesPage && !isDemo) {
      addSharesEntry();
      const observer = new MutationObserver(() => addSharesEntry());
      observer.observe(document.body, { childList: true, subtree: true });
      return;
    }
    if (!browsePage && !isDemo) return;
    if (setupBrowser()) return;
    // WebGUI may mount the Browse table after scripts or Ajax initialization.
    let attempts = 0;
    const timer = setInterval(() => {
      if (setupBrowser() || ++attempts >= 25) clearInterval(timer);
    }, 200);
  }
  // Explicit opt-in hook for pure-function tests; never enabled on production WebGUI.
  if (isDemo && window.__UFS_TEST_MODE__ === true) {
    window.__UFS_TEST_API__ = { safePath, formatSize, encodeFileUrl, parseBrowse, listDirectory };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin, { once: true });
  else begin();
})();
