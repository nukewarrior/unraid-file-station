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

  const css = [
    '#ufs-app{--ufs-accent:#e87526;--ufs-highlight:#fff2e8;--ufs-bg:#fff;--ufs-panel:#f7f8fa;--ufs-text:#24272c;--ufs-muted:#737d88;--ufs-border:#e1e5eb;--ufs-sel:#fff0e2;color:var(--ufs-text);background:var(--ufs-bg);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,"Microsoft Yahei",sans-serif;border:1px solid var(--ufs-border);border-radius:8px;overflow:hidden;display:flex;flex-direction:column;height:min(78vh,900px);min-height:510px;margin:12px 0;line-height:1.5;font-size:13px;box-sizing:border-box}',
    '#ufs-app *{box-sizing:border-box}#ufs-app button,#ufs-app input{font:inherit}#ufs-app button{cursor:pointer}#ufs-app button:disabled{opacity:.4;cursor:not-allowed}',
    '#ufs-app.ufs-dsm{--ufs-accent:#3289cf;--ufs-highlight:#eaf4ff;--ufs-sel:#e5f2ff;--ufs-panel:#f5f8fb}',
    '#ufs-app .ufs-top,#ufs-app .ufs-toolbar,#ufs-app .ufs-navigation,#ufs-app .ufs-tabs,#ufs-app .ufs-status{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--ufs-border);flex-shrink:0}',
    '#ufs-app .ufs-top{background:var(--ufs-panel);padding:12px 15px}#ufs-app .ufs-heading{font-size:18px;font-weight:650}#ufs-app .ufs-mark{color:var(--ufs-accent);font-size:20px}',
    '#ufs-app .ufs-spacer{flex:1}#ufs-app .ufs-muted{color:var(--ufs-muted)}#ufs-app .ufs-ico{border:1px solid transparent;background:transparent;color:var(--ufs-text);border-radius:5px;padding:5px 9px;min-height:30px;white-space:nowrap}',
    '#ufs-app .ufs-ico:hover{background:var(--ufs-highlight)}#ufs-app .ufs-primary{background:var(--ufs-accent);border:1px solid var(--ufs-accent);color:white}',
    '#ufs-app .ufs-primary:hover{filter:brightness(.96)}#ufs-app .ufs-tabs{background:var(--ufs-panel);padding:5px 10px;gap:4px}',
    '#ufs-app .ufs-tab{display:flex;align-items:center;gap:8px;border:1px solid transparent;padding:6px 10px;border-radius:5px;max-width:210px;background:none;color:var(--ufs-muted)}',
    '#ufs-app .ufs-tab.ufs-active{border-color:var(--ufs-border);background:var(--ufs-bg);color:var(--ufs-text)}#ufs-app .ufs-tab-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '#ufs-app .ufs-tab-close{padding:0 3px;border:none;background:none;color:var(--ufs-muted);cursor:pointer}',
    '#ufs-app .ufs-address{display:flex;align-items:center;gap:5px;background:var(--ufs-panel);padding:5px 10px;border:1px solid var(--ufs-border);border-radius:5px;min-width:80px;flex:1;overflow:hidden;white-space:nowrap}',
    '#ufs-app .ufs-crumb{border:none;background:transparent;color:var(--ufs-text);padding:0 2px;cursor:pointer;white-space:nowrap}#ufs-app .ufs-crumb:hover{color:var(--ufs-accent)}',
    '#ufs-app .ufs-search{border:1px solid var(--ufs-border);background:var(--ufs-bg);color:var(--ufs-text);border-radius:5px;padding:6px 9px;width:165px;min-width:90px;max-width:25%}',
    '#ufs-app .ufs-workspace{flex:1;min-height:0;display:flex;overflow:hidden}#ufs-app .ufs-sidebar{background:var(--ufs-panel);border-right:1px solid var(--ufs-border);width:245px;min-width:170px;max-width:40%;overflow:auto;padding:10px 6px}',
    '#ufs-app .ufs-tree-label{padding:5px 10px;font-weight:650;font-size:12px;color:var(--ufs-muted)}#ufs-app .ufs-tree-row{display:flex;align-items:center;gap:4px;width:100%;padding:5px 6px;border:none;background:transparent;text-align:left;color:var(--ufs-text);border-radius:5px;min-height:30px}',
    '#ufs-app .ufs-tree-row:hover{background:var(--ufs-highlight)}#ufs-app .ufs-tree-row.ufs-current{background:var(--ufs-sel);color:var(--ufs-accent);font-weight:650}',
    '#ufs-app .ufs-tree-toggle{padding:0 2px;border:0;background:transparent;color:var(--ufs-muted);width:16px;flex-shrink:0;cursor:pointer}',
    '#ufs-app .ufs-tree-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}',
    '#ufs-app .ufs-main{display:flex;flex-direction:column;flex:1;min-width:0;background:var(--ufs-bg)}#ufs-app .ufs-list{overflow:auto;flex:1;padding:5px 9px;outline:0}',
    '#ufs-app .ufs-head,#ufs-app .ufs-entry{display:grid;grid-template-columns:minmax(180px,2.8fr) minmax(70px,.7fr) minmax(125px,1.2fr) minmax(65px,.6fr);align-items:center;gap:10px;padding:8px 11px;border-bottom:1px solid var(--ufs-border)}',
    '#ufs-app .ufs-head{font-weight:650;color:var(--ufs-muted);font-size:12px;position:sticky;top:-5px;background:var(--ufs-bg);z-index:1}',
    '#ufs-app .ufs-entry{cursor:default;border-radius:4px;min-height:38px}#ufs-app .ufs-entry:hover{background:var(--ufs-highlight)}#ufs-app .ufs-entry.ufs-selected{background:var(--ufs-sel);outline:1px solid var(--ufs-accent)}',
    '#ufs-app .ufs-file-name{display:flex;align-items:center;gap:10px;min-width:0}#ufs-app .ufs-file-name span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '#ufs-app .ufs-folder-icon{color:#e5ad4c;font-size:19px}#ufs-app .ufs-file-icon{color:#8da1b4;font-size:19px}',
    '#ufs-app .ufs-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(125px,1fr));gap:10px;align-content:start;padding:14px}',
    '#ufs-app .ufs-grid .ufs-entry{display:flex;flex-direction:column;text-align:center;gap:7px;border:1px solid var(--ufs-border);padding:16px 8px;min-width:0;min-height:110px}',
    '#ufs-app .ufs-grid .ufs-file-name{flex-direction:column;max-width:100%;gap:7px;display:flex}#ufs-app .ufs-grid .ufs-file-name span:first-child{font-size:32px}',
    '#ufs-app .ufs-grid .ufs-extra{display:none}#ufs-app .ufs-inspector{width:285px;min-width:220px;max-width:38%;border-left:1px solid var(--ufs-border);background:var(--ufs-panel);padding:14px;overflow:auto}',
    '#ufs-app .ufs-inspector h3{margin:0 0 12px;font-size:14px}#ufs-app .ufs-prop{display:flex;justify-content:space-between;gap:15px;margin:10px 0;word-break:break-word}#ufs-app .ufs-prop span:first-child{color:var(--ufs-muted);flex-shrink:0}',
    '#ufs-app .ufs-status{border-top:1px solid var(--ufs-border);border-bottom:0;background:var(--ufs-panel);justify-content:space-between;color:var(--ufs-muted);font-size:12px}',
    '#ufs-app .ufs-empty{padding:48px 20px;text-align:center;color:var(--ufs-muted)}#ufs-app .ufs-error{color:#c13d37}',
    '#ufs-app .ufs-menu{position:fixed;z-index:2147483647;background:var(--ufs-bg);border:1px solid var(--ufs-border);border-radius:8px;box-shadow:0 10px 32px #0002;min-width:195px;padding:5px}',
    '#ufs-app .ufs-menu button{background:transparent;border:0;display:block;width:100%;text-align:left;padding:9px 12px;border-radius:5px;color:var(--ufs-text)}#ufs-app .ufs-menu button:hover{background:var(--ufs-highlight)}',
    '#ufs-app .ufs-toast{position:absolute;bottom:48px;right:25px;background:#30363c;color:white;padding:10px 14px;border-radius:6px;box-shadow:0 5px 18px #0003;max-width:360px}',
    '#ufs-app{position:relative}#ufs-app .ufs-truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ufs-hide-native{display:none!important}#ufs-native-enable{margin:8px;padding:7px 12px;background:#e87526;color:white;border:0;border-radius:5px;cursor:pointer}',
    '@media(max-width:950px){#ufs-app .ufs-sidebar{width:185px;min-width:140px}#ufs-app .ufs-inspector{display:none}#ufs-app .ufs-entry,#ufs-app .ufs-head{grid-template-columns:minmax(150px,1fr) 85px 145px}#ufs-app .ufs-permission{display:none}}',
    '@media(max-width:650px){#ufs-app .ufs-sidebar{width:40px;min-width:40px;padding:4px}#ufs-app .ufs-sidebar .ufs-tree-name,#ufs-app .ufs-tree-label,#ufs-app .ufs-tree-toggle{display:none}#ufs-app .ufs-toolbar{overflow-x:auto}#ufs-app .ufs-head,#ufs-app .ufs-entry{grid-template-columns:minmax(120px,1fr) 80px}#ufs-app .ufs-date{display:none}#ufs-app .ufs-search{width:95px}}'
  ].join('\n');

  const state = {
    tabs: [], activeId: 0, nextId: 1, entries: [], tree: new Map(),
    expanded: new Set([PREFIX]), selection: new Set(), lastIndex: -1,
    view: localStorage.getItem(STORE + 'view') || 'list',
    theme: localStorage.getItem(STORE + 'theme') || 'unraid',
    inspector: false, filter: '', busy: false, requestId: 0
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
      node.append(element('span', '', '📁'));
      node.append(element('span', 'ufs-tab-name', tab.path === PREFIX ? '共享文件夹' : tab.path.split('/').pop()));
      const close = element('span', 'ufs-tab-close', '×');
      close.title = '关闭标签';
      close.addEventListener('click', (event) => { event.stopPropagation(); closeTab(tab.id); });
      node.append(close);
      node.addEventListener('click', () => { if (state.activeId !== tab.id) switchTab(tab.id); });
      target.append(node);
    });
    const add = element('button', 'ufs-ico', '+');
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
      const toggler = element('button', 'ufs-tree-toggle', state.expanded.has(path) ? '▾' : '▸');
      toggler.title = '展开或折叠';
      toggler.addEventListener('click', async () => {
        if (state.expanded.has(path)) state.expanded.delete(path);
        else { state.expanded.add(path); await loadTree(path); }
        renderTree();
      });
      row.append(toggler, element('span', 'ufs-folder-icon', '📁'));
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
      if (index) address.append(element('span', 'ufs-muted', '›'));
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
    $('.ufs-list-button', app).classList.toggle('ufs-primary', state.view === 'list');
    $('.ufs-grid-button', app).classList.toggle('ufs-primary', state.view === 'grid');
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
        name.append(element('span', entry.folder ? 'ufs-folder-icon' : 'ufs-file-icon', entry.folder ? '📁' : '📄'));
        name.append(element('span', '', entry.name));
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
      '<div class="ufs-top"><span class="ufs-mark">▣</span><span class="ufs-heading">File Station</span>',
      '<span class="ufs-muted">Unraid 7.2.2 · 预览版</span><span class="ufs-spacer"></span>',
      '<button class="ufs-ico ufs-theme">◐ 主题</button><button class="ufs-ico ufs-refresh">↻ 刷新</button>',
      '<button class="ufs-ico ufs-native">返回原生</button></div>',
      '<div class="ufs-tabs"></div>',
      '<div class="ufs-toolbar"><button class="ufs-ico ufs-primary ufs-write">＋ 新建</button>',
      '<button class="ufs-ico ufs-write">↑ 上传</button><button class="ufs-ico ufs-write">复制</button>',
      '<button class="ufs-ico ufs-write">移动</button><button class="ufs-ico ufs-write">删除</button>',
      '<span class="ufs-spacer"></span><button class="ufs-ico ufs-list-button" title="列表视图">☷</button>',
      '<button class="ufs-ico ufs-grid-button" title="网格视图">▦</button>',
      '<button class="ufs-ico ufs-details-button" title="详细信息">◫</button></div>',
      '<div class="ufs-navigation"><button class="ufs-ico ufs-back" title="后退">←</button>',
      '<button class="ufs-ico ufs-next" title="前进">→</button>',
      '<button class="ufs-ico ufs-up" title="上一级">↑</button>',
      '<div class="ufs-address"></div><input class="ufs-search" type="search" placeholder="筛选当前文件夹" aria-label="筛选文件"></div>',
      '<div class="ufs-workspace"><aside class="ufs-sidebar"><div class="ufs-tree"></div></aside>',
      '<main class="ufs-main"><div class="ufs-list" tabindex="0"></div></main>',
      '<aside class="ufs-inspector" hidden></aside></div>',
      '<div class="ufs-status"><span class="ufs-count">准备就绪</span>',
      '<span>只读预览 · 写入操作仍由原生管理器处理</span></div>'
    ].join('');
    $('.ufs-refresh', app).addEventListener('click', refreshDirectory);
    $('.ufs-theme', app).addEventListener('click', toggleTheme);
    $('.ufs-native', app).addEventListener('click', nativeMode);
    $$('.ufs-write', app).forEach((button) =>
      button.addEventListener('click', () => notify('当前为只读预览版。请点击右上角「返回原生」执行写入操作。')));
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
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin, { once: true });
  else begin();
})();
