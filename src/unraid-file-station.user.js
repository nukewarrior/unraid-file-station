// ==UserScript==
// @name         Unraid File Station
// @namespace    https://github.com/nukewarrior/unraid-file-station
// @version      0.2.3.14
// @description  DSM-inspired File Station with native mkdir, rename and copy for Unraid 7.2.2
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
  function extractLocations(cell) {
    // Browse.php puts disk/pool names in device_* spans. The surrounding cell also
    // contains lock-state tooltips ("Not encrypted", "Locked", etc.), not locations.
    // Never read its complete textContent or execute the original inline handlers.
    if (!cell || typeof cell.querySelectorAll !== 'function') return [];
    const names = Array.from(cell.querySelectorAll('span[id^="device_"]'))
      .map((node) => (node.textContent || '').trim())
      .filter((name) => name && name !== '---');
    return [...new Set(names)];
  }
  function locationNames(entry) {
    return Array.isArray(entry.locations) ? entry.locations.filter((name) => typeof name === 'string' && name.trim()) : [];
  }
  function fitLocationNames(names, availablePx, measure = (text) => String(text).length * 7) {
    const unique = [...new Set(names.filter((name) => typeof name === 'string' && name.trim()))];
    if (!unique.length) return { visible: [], hidden: 0 };
    const total = unique.join(', ');
    if (measure(total) <= availablePx) return { visible: unique, hidden: 0 };
    // Keep a visible, explicit "view all" affordance whenever names do not fit.
    const more = '查看全部' + unique.length + '处';
    const budget = Math.max(0, availablePx - measure(more) - 16);
    const visible = [];
    for (const name of unique) {
      const candidate = [...visible, name].join(', ');
      if (measure(candidate) > budget) break;
      visible.push(name);
    }
    return { visible, hidden: unique.length - visible.length };
  }
  let locationUpdatePending = false;
  function scheduleLocationDisplay() {
    if (!app || locationUpdatePending) return;
    locationUpdatePending = true;
    requestAnimationFrame(() => {
      locationUpdatePending = false;
      if (!app || !app.isConnected) return;
      const list = $('.ufs-list', app);
      if (!list || state.view !== 'list') return;
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext && canvas.getContext('2d');
      if (ctx) ctx.font = getComputedStyle(list).font || '13px sans-serif';
      const measure = (text) => ctx ? ctx.measureText(text).width : String(text).length * 7;
      $$('.ufs-location-trigger', list).forEach((button) => {
        const names = button._ufsNames || [];
        const available = button.parentElement?.clientWidth || 0;
        if (available <= 0) return;
        const result = fitLocationNames(names, Math.max(0, available - 2), measure);
        const shown = result.visible.join(', ');
        const label = result.hidden ? '查看全部' + names.length + '处' : '';
        button.replaceChildren();
        if (shown) button.append(element('span', 'ufs-location-text', shown));
        if (result.hidden) {
          if (shown) button.append(element('span', 'ufs-location-ellipsis', '…'));
          button.append(element('span', 'ufs-location-more-link', label));
        }
      });
    });
  }
  function renderLocationTags(entry) {
    const names = locationNames(entry);
    const cell = element('span', 'ufs-extra ufs-location-col');
    if (!names.length) {
      cell.append(element('span', 'ufs-muted', '—'));
      cell.title = '存储位置未知';
      return cell;
    }
    const trigger = element('button', 'ufs-location-trigger', names.join(', '));
    trigger.type = 'button';
    trigger._ufsNames = names;
    trigger.title = names.join(', ');
    trigger.setAttribute('aria-label', '查看全部 ' + names.length + ' 个存储位置');
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      showLocationPopover(trigger, names);
    });
    trigger.addEventListener('dblclick', (event) => event.stopPropagation());
    cell.append(trigger);
    return cell;
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
      if (!safePath(path) || !row || cells.length < 8 || !path.startsWith(directory.replace(/\/$/, '') + '/')) return null;
      return {
        path, name: path.substring(path.lastIndexOf('/') + 1), folder,
        // Browse.php leaves '&' unescaped in data attributes; HTML entity
        // decoding may change the pathname before it reaches JavaScript.
        copyPathVerified: cells[2]?.textContent === path.substring(path.lastIndexOf('/') + 1),
        size: folder ? null : Number(cells[5].getAttribute('data') || '0'),
        mtime: Number(cells[6].getAttribute('data') || '0'),
        owner: (cells[3].textContent || '').trim(),
        permissions: (cells[4].textContent || '').trim(),
        locations: extractLocations(cells[7])
      };
    }).filter(Boolean);
  }
  async function listDirectory(path, options = {}) {
    if (!safePath(path)) throw new Error('仅允许访问 /mnt/user 下的共享目录');
    if (isDemo) {
      const data = window.__UFS_DEMO__ || {};
      await Promise.resolve();
      if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
      return (data[path] || []).map((entry) => ({
        ...entry, path: path + '/' + entry.name, size: entry.folder ? null : entry.size
      }));
    }
    const url = new URL('/webGui/include/Browse.php', location.origin);
    // Unraid 7.2.2 applies rawurldecode to this parameter after PHP has decoded the query.
    url.searchParams.set('dir', encodeURIComponent(path));
    url.searchParams.set('path', location.pathname.replace(/^\/+/, ''));
    const response = await fetch(url.toString(), { credentials: 'same-origin', cache: 'no-store', signal: options.signal });
    if (!response.ok) throw new Error('读取失败：HTTP ' + response.status);
    const html = await response.text();
    if (/Invalid path/i.test(html)) throw new Error('目录无效或没有访问权限');
    return parseBrowse(html, path);
  }



  // v0.2.1: create-folder is separately enabled; all other writes remain previews.
  // The generic operation planner is a dry-run contract. Production writes
  // are enabled only for mkdir in createNativeFolder(), not a security boundary.
  const FILE_WRITES_ENABLED = false;
  const CREATE_FOLDER_ENABLED = true;
  const RENAME_ENABLED = true;
  const COPY_ENABLED = true;
  const NATIVE_CONTROL_URL = '/webGui/include/Control.php';
  const NATIVE_TASK_EVENTS = '/sub/filemanager';
  const NATIVE_CHANGE_EVENTS = '/sub/filemonitor';

  function safeWriteName(name) {
    // Control.php performs an additional rawurldecode; reject '%' until its
    // complete encoding behavior is exercised against a real test share.
    // Reject CR/LF because the native task file separates sources with CR.
    if (typeof name !== 'string' || !name || name === '.' || name === '..' ||
        name.trim() !== name || /[\/\\%"'&<>;\u0000-\u001f\u007f]/.test(name)) return false;
    try {
      // EncodeURIComponent counts Unicode as UTF-8 bytes, unlike name.length.
      return encodeURIComponent(name).replace(/%[0-9a-f]{2}/gi, 'x').length <= 255;
    } catch (_) { return false; }
  }
  function safeWritePath(path, allowShareRoot = false) {
    if (!safePath(path) || path === PREFIX || path.endsWith('/') || path.includes('//')) return false;
    const parts = path.slice(PREFIX.length + 1).split('/');
    return parts.length >= (allowShareRoot ? 1 : 2) && parts.every(safeWriteName);
  }
  // Copy-only relaxation: allow unambiguous '&' while preserving all other
  // write restrictions. Browse.php emits raw paths as HTML attributes; if
  // the HTML parser would reinterpret an entity, refuse to copy that name.
  function safeCopyName(name) {
    if (safeWriteName(name)) return true;
    if (typeof name !== 'string' || !name.includes('&') ||
        !safeWriteName(name.replace(/&/g, '_'))) return false;
    const parsed = new DOMParser().parseFromString('<i data="' + name + '"></i>', 'text/html');
    return parsed.querySelector('i')?.getAttribute('data') === name;
  }
  function safeCopyPath(path, allowShareRoot = false) {
    if (!safePath(path) || path === PREFIX || path.endsWith('/') || path.includes('//')) return false;
    const parts = path.slice(PREFIX.length + 1).split('/');
    return parts.length >= (allowShareRoot ? 1 : 2) && parts.every(safeCopyName);
  }
  function copyBlockedReason(entry) {
    if (entry?.copyPathVerified === false) {
      return '原生目录返回的路径与文件名不一致，可能存在 HTML 实体解码；已禁止复制以避免操作错误文件';
    }
    if (!safeCopyPath(entry?.path)) {
      return '文件名或上级目录包含无法安全处理的字符（例如 HTML 实体、% 或引号），暂不支持复制';
    }
    return '';
  }
  function parentPath(path) { return path.slice(0, path.lastIndexOf('/')); }
  function fileName(path) { return path.slice(path.lastIndexOf('/') + 1); }

  function planFileOperation(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('文件操作参数无效');
    }
    const { type, source, parent, name, destinationDir, folder, conflictPolicy = 'fail' } = input;
    if (conflictPolicy !== 'fail') throw new Error('当前不允许覆盖目标文件');
    if (!['mkdir', 'rename', 'copy', 'move', 'delete'].includes(type)) {
      throw new Error('不支持的文件操作');
    }

    if (type === 'mkdir') {
      if (!safeWritePath(parent, true) || !safeWriteName(name)) {
        throw new Error('新建文件夹名称或父目录不安全');
      }
      return Object.freeze({
        type, source: parent, target: parent + '/' + name, name,
        folder: true, conflictPolicy, previewOnly: true
      });
    }

    // Shared-folder roots cannot be renamed, moved, copied or deleted here.
    if (!(type === 'copy' ? safeCopyPath(source) : safeWritePath(source))) throw new Error('只能操作共享文件夹内的文件或子目录');
    if (typeof folder !== 'boolean') throw new Error('必须明确文件或目录类型');

    if (type === 'rename') {
      if (!safeWriteName(name) || name === fileName(source)) {
        throw new Error('重命名目标无效或与原名称相同');
      }
      const target = parentPath(source) + '/' + name;
      if (!safeWritePath(target)) throw new Error('重命名目标路径无效');
      return Object.freeze({ type, source, target, name, folder, conflictPolicy, previewOnly: true });
    }
    if (type === 'copy' || type === 'move') {
      const validatePath = type === 'copy' ? safeCopyPath : safeWritePath;
      if (!validatePath(destinationDir, true)) throw new Error('目标文件夹路径无效');
      const target = destinationDir + '/' + fileName(source);
      if (!validatePath(target) || target === source) throw new Error('源和目标不能相同');
      if (folder && (destinationDir === source || destinationDir.startsWith(source + '/'))) {
        throw new Error('不能将目录复制或移动到其内部');
      }
      return Object.freeze({ type, source, target, destinationDir, folder, conflictPolicy, previewOnly: true });
    }
    return Object.freeze({ type, source, target: '', folder, conflictPolicy, previewOnly: true });
  }

  // This descriptor documents 7.2.2's native contract but never sends POST.
  // Existing-path conflicts and symlink resolution require further preflight;
  // the native task slot is shared across all WebGUI tabs.
  function previewNativeOperationRequest(plan) {
    if (!plan || plan.previewOnly !== true || !['mkdir', 'rename', 'copy', 'move', 'delete'].includes(plan.type)) {
      throw new Error('请先生成有效的操作预览');
    }
    const actions = {
      mkdir: 0,
      rename: plan.folder ? 2 : 7,
      copy: plan.folder ? 3 : 8,
      move: plan.folder ? 4 : 9,
      delete: plan.folder ? 1 : 6
    };
    return Object.freeze({
      endpoint: NATIVE_CONTROL_URL, method: 'POST', mode: 'file',
      action: actions[plan.type], source: plan.source,
      target: plan.type === 'mkdir' || plan.type === 'rename' ? plan.name :
        plan.type === 'delete' ? '' : plan.destinationDir,
      requiresCsrfToken: true, taskEvents: NATIVE_TASK_EVENTS,
      globallySharedTask: true, previewOnly: true
    });
  }

  // Generic operation coordinator stays mock-only in v0.2.1.
  // Production mkdir is handled separately by createNativeFolder().
  function createFileOperationCoordinator(mockExecutor) {
    let task = { status: 'idle', plan: null, result: null, error: '' };
    const snapshot = () => Object.freeze({ ...task });
    function review(input) {
      if (task.status === 'running') throw new Error('已有文件任务正在执行');
      const plan = planFileOperation(input);
      task = { status: 'awaiting-confirmation', plan, result: null, error: '' };
      return snapshot();
    }
    function cancel() {
      if (task.status !== 'awaiting-confirmation') return false;
      task = { status: 'idle', plan: null, result: null, error: '' };
      return true;
    }
    async function confirm(acknowledged) {
      if (task.status !== 'awaiting-confirmation') throw new Error('没有等待确认的文件操作');
      if (acknowledged !== true) throw new Error('请先明确确认文件操作');
      if (FILE_WRITES_ENABLED || !isDemo || window.__UFS_TEST_MODE__ !== true ||
          typeof mockExecutor !== 'function') {
        throw new Error('v0.2.0 禁止向真实 NAS 提交文件写入');
      }
      const plan = task.plan;
      task = { status: 'running', plan, result: null, error: '' };
      try {
        const result = await mockExecutor(plan);
        task = { status: 'completed', plan, result, error: '' };
      } catch (error) {
        task = { status: 'failed', plan, result: null, error: String(error?.message || error) };
      }
      return snapshot();
    }
    return Object.freeze({ review, confirm, cancel, snapshot });
  }


  // Unraid 7.2.2 is a shared global task slot. No API here can reserve it
  // atomically across tabs. The user must accept this residual race.
  function nativeCsrfToken() {
    const token = window.csrf_token;
    if (typeof token !== 'string' || !token) throw new Error('无法取得 Unraid CSRF Token，请刷新 WebGUI');
    return token;
  }
  async function postNativeControl(fields) {
    const body = new URLSearchParams({ ...fields, csrf_token: nativeCsrfToken() });
    const response = await fetch(NATIVE_CONTROL_URL, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: body.toString(), signal: lifecycle.signal
    });
    if (!response.ok) throw new Error('原生文件接口 HTTP ' + response.status);
    return response.text();
  }
  function parseNativeActive(raw) {
    if (!raw || !String(raw).trim()) return null;
    let data;
    try { data = JSON.parse(raw); } catch (_) { throw new Error('原生任务状态格式异常，无法安全操作'); }
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
        !Number.isInteger(Number(data.action)) || typeof data.source !== 'string' ||
        typeof data.target !== 'string') {
      throw new Error('原生任务状态不完整，无法安全操作');
    }
    return data;
  }
  async function readNativeActive() {
    return parseNativeActive(await postNativeControl({ mode: 'read' }));
  }
  function matchesCreateTask(active, plan) {
    return active && Number(active.action) === 0 &&
      active.source === plan.source && active.target === plan.name;
  }
  function observeNativeProgress(onProgress) {
    if (typeof window.NchanSubscriber !== 'function') return () => {};
    let subscriber;
    try {
      subscriber = new window.NchanSubscriber(NATIVE_TASK_EVENTS, { subscriber: 'websocket' });
      subscriber.on('message', (raw) => {
        try {
          const data = JSON.parse(raw);
          if (data && typeof data === 'object') onProgress(data);
        } catch (_) { /* Malformed progress events cannot authorize success. */ }
      });
      subscriber.start();
    } catch (_) { /* Read-only task polling remains available. */ }
    return () => { try { subscriber?.stop(); } catch (_) {} };
  }
  function waitNative(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  let nativeWriteBusy = false;
  let ownFileChangeQuietUntil = 0;
  async function withNativeWriteLock(operation) {
    if (nativeWriteBusy) throw new Error('已有文件操作正在执行，请稍后重试');
    nativeWriteBusy = true;
    try { return await operation(); }
    finally {
      // filemonitor is published at one-second intervals, even after the
      // Control.php reply. Avoid treating trailing own events as external.
      ownFileChangeQuietUntil = Date.now() + 3000;
      nativeWriteBusy = false;
    }
  }
  async function createNativeFolder(plan, progress = () => {}) {
    return withNativeWriteLock(async () => {
    if (!CREATE_FOLDER_ENABLED || !plan || plan.type !== 'mkdir' ||
        plan.conflictPolicy !== 'fail' || !safeWritePath(plan.source, true) ||
        !safeWriteName(plan.name) || plan.target !== plan.source + '/' + plan.name) {
      throw new Error('无效的新建文件夹计划');
    }
    if (isDemo && window.__UFS_TEST_MODE__ !== true) {
      throw new Error('演示模式不允许真实写入');
    }
    // Preflight must be fresh; state.entries might be filtered, sorted or stale.
    const entries = await listDirectory(plan.source);
    if (entries.some(entry => entry.path === plan.target || entry.name === plan.name)) {
      throw new Error('同名文件或文件夹已存在，未执行创建');
    }
    if (await readNativeActive()) throw new Error('Unraid 正在执行其他原生文件任务，请稍后重试');
    // Verify CSRF before starting the subscriber or attempting any write.
    nativeCsrfToken();
    let afterRequest = false;
    let eventError = '';
    let eventDone = false;
    const unwatch = observeNativeProgress(data => {
      if (typeof data.status === 'string') {
        progress(data.status.replace(/<[^>]*>/g, '').slice(0, 130));
      }
      if (data.error) eventError = String(data.error).replace(/<[^>]*>/g, '').slice(0, 200);
      if (data.done === 1) eventDone = true;
    });
    try {
      // Like Unraid's native Browse.page, values are inner URL-encoded because
      // Control.php applies rawurldecode again after parsing the form body.
      afterRequest = true;
      const reply = await postNativeControl({
        mode: 'file', action: '0', title: encodeURIComponent('新建文件夹'),
        source: encodeURIComponent(plan.source), target: encodeURIComponent(plan.name),
        hdlink: '', sparse: '', exist: '', zfs: ''
      });
      if (reply.trim()) throw new Error('原生接口返回了非预期内容');
      progress('正在等待 Unraid 确认任务…');
      const deadline = Date.now() + 30000;
      let idleChecks = 0;
      while (Date.now() < deadline) {
        await waitNative(500);
        const active = await readNativeActive();
        if (active) {
          if (!matchesCreateTask(active, plan)) {
            throw new Error('原生任务被其他操作占用，无法确认创建结果');
          }
          idleChecks = 0;
        } else {
          idleChecks++;
          // Two consecutive idle checks avoid checking before the native
          // daemon has observed the task file. No status event is proof alone.
          if (idleChecks >= 2 || eventDone) break;
        }
      }
      if (idleChecks === 0) throw new Error('原生创建任务仍在进行或无法确认结束');
      if (eventError) throw new Error('Unraid 报告任务错误：' + eventError);
      // A status event / HTTP 200 is never the success criterion.
      const verified = await listDirectory(plan.source);
      const created = verified.find(entry => entry.path === plan.target);
      if (!created || !created.folder) throw new Error('无法在目标目录确认新建文件夹，请先手动刷新检查');
      return created;
    } catch (error) {
      if (afterRequest) {
        throw new Error('创建请求可能已被 Unraid 接收；结果不确定，请刷新目录核实后再操作。详情：' +
          String(error?.message || error));
      }
      throw error;
    } finally {
      unwatch();
    }
    });
  }


  function matchesRenameTask(active, plan) {
    return active && Number(active.action) === (plan.folder ? 2 : 7) &&
      active.source === plan.source && active.target === plan.name;
  }
  function renameSelectionEnd(name, folder) {
    if (folder) return name.length;
    const dot = name.lastIndexOf('.');
    return dot > 0 ? dot : name.length;
  }
  function remapPathPrefix(path, source, target) {
    return path === source ? target :
      (typeof path === 'string' && path.startsWith(source + '/') ?
        target + path.slice(source.length) : path);
  }
  async function renameNativeEntry(plan, progress = () => {}) {
    return withNativeWriteLock(async () => {
      if (!RENAME_ENABLED || !plan || plan.type !== 'rename' ||
          plan.conflictPolicy !== 'fail' || !safeWritePath(plan.source) ||
          !safeWriteName(plan.name) || typeof plan.folder !== 'boolean' ||
          plan.target !== parentPath(plan.source) + '/' + plan.name ||
          plan.target === plan.source) {
        throw new Error('无效的重命名操作');
      }
      if (isDemo && window.__UFS_TEST_MODE__ !== true) {
        throw new Error('演示模式不允许真实写入');
      }
      const parent = parentPath(plan.source);
      // Never rely on the rendered/filtered/virtualized file list for conflicts.
      const before = await listDirectory(parent);
      const original = before.find(item => item.path === plan.source);
      if (!original || original.folder !== plan.folder) {
        throw new Error('原文件或文件夹已不存在或类型发生变化，请刷新目录');
      }
      if (before.some(item => item.path === plan.target || item.name === plan.name)) {
        throw new Error('目标名称已存在，未执行重命名');
      }
      if (await readNativeActive()) throw new Error('Unraid 正在执行其他原生文件任务，请稍后重试');
      nativeCsrfToken();
      let afterRequest = false;
      let eventError = '';
      let eventDone = false;
      const unwatch = observeNativeProgress(data => {
        if (typeof data.status === 'string') {
          progress(data.status.replace(/<[^>]*>/g, '').slice(0, 130));
        }
        if (data.error) eventError = String(data.error).replace(/<[^>]*>/g, '').slice(0, 200);
        if (data.done === 1) eventDone = true;
      });
      try {
        afterRequest = true;
        const reply = await postNativeControl({
          mode: 'file', action: plan.folder ? '2' : '7', title: encodeURIComponent('重命名'),
          source: encodeURIComponent(plan.source), target: encodeURIComponent(plan.name),
          hdlink: '', sparse: '', exist: '', zfs: ''
        });
        if (reply.trim()) throw new Error('原生接口返回了非预期内容');
        progress('正在等待 Unraid 确认重命名…');
        const deadline = Date.now() + 30000;
        let idleChecks = 0;
        while (Date.now() < deadline) {
          await waitNative(500);
          const active = await readNativeActive();
          if (active) {
            if (!matchesRenameTask(active, plan)) {
              throw new Error('原生任务被其他操作占用，无法确认重命名结果');
            }
            idleChecks = 0;
          } else {
            idleChecks++;
            if (idleChecks >= 2 || eventDone) break;
          }
        }
        if (idleChecks === 0) throw new Error('原生重命名仍在进行或无法确认结束');
        if (eventError) throw new Error('Unraid 报告任务错误：' + eventError);
        const verified = await listDirectory(parent);
        const oldItem = verified.find(item => item.path === plan.source);
        const newItem = verified.find(item => item.path === plan.target);
        if (oldItem || !newItem || newItem.folder !== plan.folder) {
          throw new Error('无法确认旧名称消失且新名称出现，请手动检查目录');
        }
        return newItem;
      } catch (error) {
        if (afterRequest) {
          throw new Error('重命名请求可能已被 Unraid 接收；结果不确定，请先刷新目录核实。详情：' +
            String(error?.message || error));
        }
        throw error;
      } finally {
        unwatch();
      }
    });
  }



  // rsync --out-format=%f quotes non-ASCII UTF-8 bytes as octal \#NNN.
  // Decode *consecutive* escaped bytes as one UTF-8 sequence. Preserve
  // malformed escape groups literally rather than replacing filenames.
  function decodeRsyncFilename(text) {
    return String(text ?? '').replace(/(?:\\#[0-7]{3})+/g, escaped => {
      try {
        return decodeURIComponent(escaped.replace(/\\#([0-7]{3})/g,
          (_,digits)=>'%' + Number.parseInt(digits,8).toString(16).padStart(2,'0')));
      } catch (_) { return escaped; }
    });
  }
  function stripNativeStatusHtml(status) {
    const text=String(status??'');
    // Strip markup before decoding into text nodes; never inject native output as HTML.
    const clean=text.replace(/<[^>]*>/g,'').replace(/&nbsp;/g,' ')
      .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
    return decodeRsyncFilename(clean);
  }
  function parseRsyncProgress(status) {
    const text=stripNativeStatusHtml(status).replace(/\r/g,'\n');
    const lines=text.split('\n').map(line=>line.trim()).filter(Boolean);
    // In Unraid, progress2 output normally follows the current filename.
    // Accept decimal percentages, speed and ETA only from a real rsync line.
    const matched=[...text.matchAll(/(?:^|\s)([\d,.]+[kKMGTPE]?(?:i?B)?)\s+(\d{1,3}(?:\.\d+)?)%\s+([\d,.]+\s*[kKMGTPE]?(?:i?B)?\/s)\s+(\d{1,4}:\d\d(?::\d\d)?)/g)].pop();
    let percent=null,bytes=null,transferred='',speed='',eta='';
    if(matched) {
      const value=Number(matched[2]);
      if(Number.isFinite(value) && value>=0 && value<=100) {
        percent=value;
        transferred=matched[1];
        // A human-readable -h quantity is rounded, not an exact byte count.
        // Only expose exact bytes when rsync gives an unsuffixed integer.
        bytes=/^[\d,]+$/.test(transferred)?Number(transferred.replace(/,/g,'')):null;
        speed=matched[3].replace(/\s+/g,'');
        eta=matched[4];
      }
    }
    let filename='';
    for(const line of lines) {
      if(/\b(?:Copying|复制中|正在复制)\s*\.{2,3}\s*/i.test(line)) {
        filename=line.replace(/^.*?\b(?:Copying|复制中|正在复制)\s*\.{2,3}\s*/i,'').trim();
        break;
      }
    }
    if(!filename && lines.length && !/\d{1,3}(?:\.\d+)?%/.test(lines[0])) {
      filename=lines[0];
    }
    return {percent,bytes,transferred,speed,eta,filename,text};
  }
  function shortenCopyName(value,max=96) {
    const name=String(value??'');
    return name.length>max ? name.slice(0,Math.ceil((max-1)/2))+'…'+
      name.slice(-(Math.floor((max-1)/2))) : name;
  }

  // Copy source intentionally has no trailing slash: rsync copies the source
  // entry (including a folder's name), not only the folder's contents.
  // Copy target is the existing destination directory WITH a trailing slash.
  function nativeCopyTarget(plan) { return plan.destinationDir + '/'; }
  function matchesCopyTask(active, plan) {
    return active && Number(active.action) === (plan.folder ? 3 : 8) &&
      active.source === plan.source && active.target === nativeCopyTarget(plan);
  }
  function copyDestinationAllowed(plan, destinationDir) {
    if (!plan || !safeCopyPath(destinationDir, true) ||
        destinationDir === parentPath(plan.source)) return false;
    return !plan.folder || (destinationDir !== plan.source &&
      !destinationDir.startsWith(plan.source + '/'));
  }
  async function copyNativeEntry(plan, progress = () => {}, control = {}) {
    return withNativeWriteLock(async () => {
      if (!COPY_ENABLED || !plan || plan.type !== 'copy' ||
          plan.conflictPolicy !== 'fail' || plan.previewOnly !== true ||
          !safeCopyPath(plan.source) || typeof plan.folder !== 'boolean' ||
          !copyDestinationAllowed(plan, plan.destinationDir) ||
          plan.target !== plan.destinationDir + '/' + fileName(plan.source)) {
        throw new Error('无效的复制操作或目标位置');
      }
      if (isDemo && window.__UFS_TEST_MODE__ !== true) {
        throw new Error('演示模式不允许真实写入');
      }
      progress('正在检查源文件和目标目录…', 'checking');
      // Preflight fresh directories independently, never trust filtered UI
      // rows nor the destination picker cache.
      const originEntries = await listDirectory(parentPath(plan.source));
      const sourceEntry = originEntries.find(entry => entry.path === plan.source);
      if (!sourceEntry || sourceEntry.folder !== plan.folder) {
        throw new Error('源文件或目录已不存在，请刷新目录后重试');
      }
      if (sourceEntry.copyPathVerified === false) {
        throw new Error('原生目录返回路径与文件名不一致，拒绝复制以防操作错误文件');
      }
      const destinationEntries = await listDirectory(plan.destinationDir);
      if (destinationEntries.some(entry =>
        entry.name === fileName(plan.source) || entry.path === plan.target)) {
        throw new Error('目标文件夹中已有同名项目，未执行复制');
      }
      if (await readNativeActive()) throw new Error('Unraid 正在执行其他原生文件任务，请稍后重试');
      nativeCsrfToken();
      let submitted = false;
      let eventError = '';
      let eventDone = false;
      let observedOwnTask = false;
      const unwatch = observeNativeProgress(data => {
        if (typeof data.status === 'string' && data.status) {
          progress(stripNativeStatusHtml(data.status), null, parseRsyncProgress(data.status));
        }
        if (data.error) eventError = stripNativeStatusHtml(data.error).slice(0, 200);
        if (data.done === 1) eventDone = true;
      });
      try {
        submitted = true;
        const reply = await postNativeControl({
          mode: 'file', action: plan.folder ? '3' : '8', title: encodeURIComponent('复制'),
          source: encodeURIComponent(plan.source),
          target: encodeURIComponent(nativeCopyTarget(plan)),
          hdlink: '', sparse: '', exist: '', zfs: ''
        });
        if (reply.trim()) throw new Error('原生接口返回了非预期内容');
        progress('正在复制，完成后自动核对目标…', 'copying');
        // Large rsync tasks are allowed to continue for hours. The UI never
        // retries, issues mode=start, or stops someone else's global task.
        const deadline = Date.now() + 6 * 60 * 60 * 1000;
        let consecutiveIdle = 0;
        while (Date.now() < deadline) {
          await waitNative(700);
          if (eventError && !control.cancelRequested) throw new Error('Unraid 报告复制错误：' + eventError);
          const active = await readNativeActive();
          if (control.cancelRequested) {
            if (active && matchesCopyTask(active, plan)) { consecutiveIdle=0; continue; }
            if (active && Number(active.action)===99) { consecutiveIdle=0; continue; }
            if (active) throw new Error('取消后出现其他原生任务，无法确认停止结果');
            if (++consecutiveIdle>=2) throw new Error('复制已请求停止；目标可能留有不完整文件');
            continue;
          }
          if (active) {
            if (!matchesCopyTask(active, plan)) {
              throw new Error('原生任务被其他操作占用，无法确认复制结果');
            }
            observedOwnTask = true;
            control.observedOwnTask=true;
            consecutiveIdle = 0;
          } else {
            ++consecutiveIdle;
            if (consecutiveIdle >= 2 && (observedOwnTask || eventDone)) break;
            // If rsync completed between polls and the WebSocket is missing,
            // do not pretend a copied entry proves the full rsync succeeded.
            if (consecutiveIdle >= 5 && !observedOwnTask && !eventDone) {
              throw new Error('无法确认原生复制任务已执行完毕');
            }
          }
        }
        if (consecutiveIdle < 2 || !(observedOwnTask || eventDone)) {
          throw new Error('复制任务尚未结束或无法确认结束');
        }
        if (control.cancelRequested) throw new Error('复制已请求停止；目标可能留有不完整文件');
        if (eventError) throw new Error('Unraid 报告复制错误：' + eventError);
        progress('正在核对复制结果…', 'verifying');
        const verified = await listDirectory(plan.destinationDir);
        const result = verified.find(entry => entry.path === plan.target);
        if (!result || result.folder !== plan.folder) {
          throw new Error('目标目录未出现预期文件或文件夹，请检查复制状态');
        }
        // For individual files, compare the reported byte size when both
        // directory readings provide it. This catches obvious partial copies,
        // but does not constitute cryptographic content verification.
        if (!plan.folder && Number.isFinite(sourceEntry.size) &&
            Number.isFinite(result.size) && sourceEntry.size !== result.size) {
          throw new Error('复制后目标文件大小与源文件不一致，请检查文件完整性');
        }
        // A directory appearing proves only its top-level presence. The native
        // job's completion is required; we do not claim checksum verification.
        return result;
      } catch (error) {
        if (control.cancelRequested && submitted) {
          throw new Error('复制已请求取消；目标目录可能留有不完整文件，请手动检查。详情：'+
            String(error?.message||error));
        }
        if (submitted) throw new Error(
          '复制请求可能已被 Unraid 接收；结果不确定，请检查目标目录及原生任务状态，切勿直接重试。详情：' +
          String(error?.message || error)
        );
        throw error;
      } finally {
        unwatch();
      }
    });
  }


  async function requestCancelNativeCopy(plan, control={}) {
    if (!nativeWriteBusy || !plan || !control || control.cancelRequested ||
        !control.observedOwnTask) {
      throw new Error('无法确认当前复制任务归属，拒绝发送全局停止指令');
    }
    // Not atomic! Control.php mode=file action=99 replaces the global task.
    // Check twice and only send while a confirmed matching task is active.
    const first=await readNativeActive();
    if (!matchesCopyTask(first,plan)) throw new Error('原生任务已改变，拒绝取消');
    await waitNative(300);
    const second=await readNativeActive();
    if (!matchesCopyTask(second,plan)) throw new Error('原生任务已改变，拒绝取消');
    control.cancelRequested=true;
    try {
      const reply=await postNativeControl({mode:'file',action:'99'});
      if(reply.trim()) throw new Error('原生取消请求返回非预期内容');
    } catch(error) {
      // Do not reset cancelRequested: status can now be uncertain and a retry
      // could kill a different user's newly started task.
      throw new Error('停止指令提交结果不确定，请检查 NAS 原生文件任务：'+String(error?.message||error));
    }
  }

  // Small local SVG set: no external fonts, CDNs or global icon CSS.
  const ICONS = {
    folder:['M3 7a2 2 0 0 1 2-2h4l2 2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
    'folder-open':['M3 7a2 2 0 0 1 2-2h4l2 2 2h9a2 2 0 0 1 2 2','M3 11h17a2 2 0 0 1 1.9 2.6L20 19H4a2 2 0 0 1-1.9-2.6z'],
    'folder-plus':['M12 10v6','M9 13h6','M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'],
    check:['m5 12 4 4 10-10'],
    file:['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z','M14 2v6h6'],
    more:['M5 12h.01','M12 12h.01','M19 12h.01'],
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
    '#ufs-app{--ufs-accent:#eb7825;--ufs-accent-soft:#fff1e4;--ufs-bg:#fff;--ufs-panel:#f7f8fa;--ufs-text:#252a30;--ufs-muted:#727a85;--ufs-border:#e1e5eb;--ufs-hover:#f2f5f8;--ufs-sel:#e4f0fc;--ufs-selected-hover:#d8e9fa;--ufs-tree-sel:#fff0e2;--ufs-sidebar-width:245px;color:var(--ufs-text);background:var(--ufs-bg);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;border:1px solid var(--ufs-border);border-radius:7px;overflow:hidden;display:flex;flex-direction:column;height:var(--ufs-available-height,65vh);min-height:260px;margin:0 0 8px;line-height:1.45;font-size:13px;position:relative}',
    '#ufs-app.ufs-dsm{--ufs-accent:#318bd2;--ufs-accent-soft:#e8f3ff;--ufs-panel:#f4f7fa;--ufs-hover:#edf4fc;--ufs-sel:#e4f0fc;--ufs-selected-hover:#d8e9fa;--ufs-tree-sel:#e7f2ff}',
    '#ufs-app *,#ufs-app *::before,#ufs-app *::after{box-sizing:border-box}#ufs-app button,#ufs-app input{font-family:inherit;font-size:inherit;font-weight:inherit;letter-spacing:normal;text-transform:none;line-height:1.4;box-shadow:none;text-shadow:none;border-radius:5px}#ufs-app button{cursor:pointer}#ufs-app button:disabled{opacity:.42;cursor:not-allowed}#ufs-app button:focus-visible,#ufs-app input:focus-visible,#ufs-app .ufs-entry:focus-visible{outline:2px solid var(--ufs-accent);outline-offset:1px}',
    '#ufs-app .ufs-svg{height:16px;width:16px;min-width:16px;display:inline-block;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;vertical-align:middle;pointer-events:none}#ufs-app .ufs-folder-icon{color:#dba44e}#ufs-app .ufs-file-icon{color:#889bac}#ufs-app .ufs-mark{color:var(--ufs-accent)}',
    '#ufs-app .ufs-top,#ufs-app .ufs-navigation,#ufs-app .ufs-status{display:flex;align-items:center;gap:7px;border-bottom:1px solid var(--ufs-border);flex-shrink:0;min-width:0}',
    '#ufs-app .ufs-top{background:var(--ufs-panel)}#ufs-app .ufs-heading{font-weight:650;letter-spacing:0;text-transform:none}',
    '#ufs-app .ufs-spacer{flex:1;min-width:6px}#ufs-app .ufs-muted{color:var(--ufs-muted)}#ufs-app .ufs-ico{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:30px;height:30px;padding:4px 9px;border:1px solid transparent;background:transparent;color:var(--ufs-text);white-space:nowrap;vertical-align:middle}#ufs-app .ufs-ico:hover:not(:disabled){background:var(--ufs-hover)}',
    '#ufs-app .ufs-ico.ufs-primary{background:var(--ufs-accent);border-color:var(--ufs-accent);color:#fff}#ufs-app .ufs-ico.ufs-primary:hover{filter:brightness(.96)}#ufs-app .ufs-ico.ufs-view-active{background:var(--ufs-accent-soft);color:var(--ufs-accent);border-color:var(--ufs-accent-soft)}#ufs-app .ufs-ico.ufs-view-active:hover{background:var(--ufs-accent-soft)}',
    '#ufs-app .ufs-tab{display:inline-flex;align-items:center;gap:6px;border:1px solid transparent;min-width:0;max-width:195px;background:transparent;color:var(--ufs-muted)}#ufs-app .ufs-tab.ufs-active{background:var(--ufs-bg);border-color:var(--ufs-border);color:var(--ufs-text);font-weight:600}',
    '#ufs-app .ufs-tab-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#ufs-app .ufs-tab-close{display:flex;align-items:center;border:0;background:transparent;color:var(--ufs-muted);height:19px;width:19px;padding:0;justify-content:center}#ufs-app .ufs-tab-close:hover{background:var(--ufs-hover)}',
    '#ufs-app .ufs-navigation{height:42px;min-height:42px;max-height:42px;width:100%;max-width:100%;margin:0;padding:0 11px;overflow:hidden;gap:5px;align-items:center;border-radius:0;background:var(--ufs-bg)}#ufs-app .ufs-navigation>.ufs-ico{flex:0 0 auto;min-height:0;height:30px}#ufs-app .ufs-address{display:flex;align-items:center;gap:2px;flex:1 1 auto;width:auto;min-width:0;max-width:none;height:30px;min-height:30px;max-height:30px;align-self:center;padding:0 10px;margin:0;border:1px solid var(--ufs-border);border-radius:4px;background:var(--ufs-bg);box-shadow:none;line-height:28px;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;white-space:nowrap}#ufs-app .ufs-address::-webkit-scrollbar{display:none}',
    '#ufs-app .ufs-crumb{border:0;background:none;color:var(--ufs-muted);display:inline-flex;align-items:center;justify-content:flex-start;width:auto;min-width:0;max-width:none;min-height:0;height:auto;margin:0;padding:0 2px;white-space:nowrap;flex:0 0 auto}#ufs-app .ufs-crumb:hover{color:var(--ufs-accent)}#ufs-app .ufs-crumb:last-child{color:var(--ufs-text);font-weight:600}#ufs-app .ufs-search{height:29px;border:1px solid var(--ufs-border);background:var(--ufs-bg);color:var(--ufs-text);border-radius:4px;padding:4px 9px;width:150px;min-width:0;max-width:none}',
    '#ufs-app .ufs-address>.ufs-svg{width:12px;height:12px;min-width:12px;flex:0 0 12px}',
    '#ufs-app .ufs-workspace{display:flex;flex:1;min-height:0;overflow:hidden}#ufs-app .ufs-sidebar{background:var(--ufs-panel);width:var(--ufs-sidebar-width);flex:0 0 var(--ufs-sidebar-width);min-width:0;overflow:auto;padding:8px 7px}#ufs-app .ufs-resizer{width:5px;flex:0 0 5px;background:var(--ufs-border);cursor:col-resize;touch-action:none;opacity:.7}#ufs-app .ufs-resizer:hover{background:var(--ufs-accent)}',
    '#ufs-app .ufs-tree-label{padding:7px 8px;color:var(--ufs-muted);font-size:12px;font-weight:600;letter-spacing:0}#ufs-app .ufs-tree-row{display:flex;align-items:center;gap:7px;width:100%;height:31px;min-height:31px;padding:0 7px;border:0;background:transparent;text-align:left;color:var(--ufs-text);border-radius:5px;min-width:0}',
    '#ufs-app .ufs-tree-row.ufs-tree-group:hover{background:transparent!important}#ufs-app .ufs-tree-row.ufs-tree-group{cursor:default}' ,
    '#ufs-app .ufs-tree-row:hover{background:var(--ufs-hover)}#ufs-app .ufs-tree-row.ufs-current{background:var(--ufs-tree-sel);color:var(--ufs-accent);font-weight:600}#ufs-app .ufs-tree-toggle{display:inline-flex;align-items:center;justify-content:center;width:16px;min-width:16px;height:24px;min-height:0;padding:0!important;margin:0;border:0;background:transparent;color:var(--ufs-muted);flex:0 0 16px;line-height:1}',
    '#ufs-app .ufs-tree-spacer{width:16px;flex:0 0 16px}#ufs-app .ufs-tree-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;text-transform:none;letter-spacing:normal}',
    // Browser text selection and I-beam cursors conflict with desktop-style file picking.
    // Scope this only to navigable rows; inputs / breadcrumbs stay selectable.
    '#ufs-app .ufs-tree-row,#ufs-app .ufs-tree-row *,#ufs-app .ufs-entry,#ufs-app .ufs-entry *{user-select:none;-webkit-user-select:none;cursor:default!important}',
    '#ufs-app .ufs-main{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;overflow:hidden;background:var(--ufs-bg)}#ufs-app .ufs-content{display:flex;flex:1;min-width:0;min-height:0;overflow:hidden}#ufs-app .ufs-list{min-width:0;min-height:0;overflow:auto;flex:1;padding:0 8px;outline:0}',
    '#ufs-app .ufs-head,#ufs-app .ufs-entry{display:grid;grid-template-columns:var(--ufs-columns);width:100%;min-width:var(--ufs-table-min-width);box-sizing:border-box;align-items:center;gap:10px;padding:0 12px;border-bottom:1px solid var(--ufs-border)}#ufs-app .ufs-head{height:34px;min-height:34px;font-weight:600;color:var(--ufs-muted);font-size:12px;position:sticky;top:0;background:var(--ufs-bg);z-index:1}',
    '#ufs-app .ufs-entry{min-height:38px;height:38px;border-radius:3px;cursor:default}#ufs-app .ufs-entry:hover{background:var(--ufs-hover)}#ufs-app .ufs-entry.ufs-selected{background:var(--ufs-sel);outline:none}#ufs-app .ufs-entry.ufs-selected:hover{background:var(--ufs-selected-hover)}#ufs-app .ufs-entry>span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#ufs-app .ufs-file-name{display:flex;align-items:center;gap:9px;min-width:0}#ufs-app .ufs-file-name .ufs-filename{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}',
    '#ufs-app .ufs-sort-button{display:inline-flex;align-items:center;gap:5px;width:100%;height:30px;border:0;padding:0;background:transparent;text-align:left;color:inherit;white-space:nowrap}#ufs-app .ufs-sort-button .ufs-sort-mark{color:var(--ufs-accent);font-size:12px}',
    '#ufs-app .ufs-head>span{position:relative}#ufs-app .ufs-column-grip{position:absolute;right:-6px;top:0;width:12px;height:100%;cursor:col-resize!important;touch-action:none;z-index:3;user-select:none;-webkit-user-select:none}#ufs-app .ufs-column-grip:hover,#ufs-app .ufs-column-grip:active{border-right:2px solid var(--ufs-accent)}#ufs-app .ufs-entry{width:100%;min-width:var(--ufs-table-min-width)}',
    '#ufs-app .ufs-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(125px,1fr));gap:10px;align-content:start;padding:14px}#ufs-app .ufs-grid .ufs-entry{display:flex;height:auto;flex-direction:column;text-align:center;gap:7px;border:1px solid var(--ufs-border);padding:16px 8px;min-width:0;min-height:107px;width:auto}',
    // Prevent Chromium scroll anchoring from changing scrollTop while virtual
    // spacers and mounted rows are replaced. The native wheel/scrollbar remains in control.
    '#ufs-app .ufs-list.ufs-virtualized{overflow-anchor:none}',
    '#ufs-app .ufs-virtual-spacer{height:0;min-width:var(--ufs-table-min-width);pointer-events:none}#ufs-app .ufs-virtual-body{min-width:var(--ufs-table-min-width)}#ufs-app .ufs-grid.ufs-virtualized{display:block;padding:14px}#ufs-app .ufs-grid.ufs-virtualized .ufs-virtual-spacer,#ufs-app .ufs-grid.ufs-virtualized .ufs-virtual-body{min-width:0;width:100%}#ufs-app .ufs-virtual-grid{display:grid;grid-template-columns:repeat(var(--ufs-grid-cols,4),minmax(0,1fr));gap:10px;grid-auto-rows:122px;padding-bottom:10px}#ufs-app .ufs-grid .ufs-virtual-grid .ufs-entry{height:122px;min-height:0;box-sizing:border-box;overflow:hidden}',
    '#ufs-app .ufs-grid .ufs-file-name{flex-direction:column;max-width:100%;gap:7px}#ufs-app .ufs-grid .ufs-file-name .ufs-svg{width:34px;height:34px}#ufs-app .ufs-grid .ufs-extra{display:none}',
    '#ufs-app .ufs-inspector{width:285px;flex:0 0 285px;min-width:220px;max-width:38%;border-left:1px solid var(--ufs-border);background:var(--ufs-panel);padding:14px;overflow:auto}#ufs-app .ufs-inspector[hidden]{display:none}#ufs-app .ufs-inspector h3{margin:0 0 12px;font-size:14px}#ufs-app .ufs-prop{display:flex;justify-content:space-between;gap:15px;margin:10px 0;word-break:break-word}#ufs-app .ufs-prop span:first-child{color:var(--ufs-muted);flex-shrink:0}',
    '#ufs-app .ufs-status{height:30px;border-top:1px solid var(--ufs-border);border-bottom:0;background:var(--ufs-panel);justify-content:space-between;padding:0 12px;color:var(--ufs-muted);font-size:12px;gap:14px}#ufs-app .ufs-status span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
    '#ufs-app .ufs-empty{padding:48px 20px;text-align:center;color:var(--ufs-muted)}#ufs-app .ufs-error{color:#c13d37}#ufs-app .ufs-menu{position:fixed;z-index:2147483647;background:var(--ufs-bg);border:1px solid var(--ufs-border);border-radius:7px;box-shadow:0 10px 32px #0002;min-width:190px;padding:5px}',
    '#ufs-app .ufs-menu button{background:transparent;border:0;display:block;width:100%;text-align:left;padding:8px 12px;color:var(--ufs-text)}#ufs-app .ufs-menu button:hover{background:var(--ufs-hover)}#ufs-app .ufs-toast{position:absolute;bottom:42px;right:25px;background:#30363c;color:#fff;padding:10px 14px;border-radius:6px;box-shadow:0 5px 18px #0003;max-width:360px}',
    "#ufs-app .ufs-dialog-overlay{position:absolute;inset:0;z-index:2147483640;display:flex;align-items:center;justify-content:center;background:rgba(22,28,36,.40);backdrop-filter:blur(1px);padding:16px}",
    "#ufs-app .ufs-create-dialog{width:min(440px,100%);max-height:calc(100% - 16px);min-height:0;overflow:hidden;background:var(--ufs-bg);border:1px solid var(--ufs-border);border-radius:10px;box-shadow:0 20px 55px rgba(0,0,0,.24);display:flex;flex-direction:column;padding:0;gap:0}",
    "#ufs-app .ufs-create-head{display:flex;align-items:center;justify-content:space-between;height:52px;min-height:52px;flex:0 0 52px;gap:12px;padding:0 20px;border-bottom:1px solid var(--ufs-border)}",
    "#ufs-app .ufs-create-head h3{font-size:16px;line-height:1.4;margin:0;font-weight:650;color:var(--ufs-text)}",
    "#ufs-app .ufs-create-head .ufs-create-dismiss{border:0;background:transparent;color:var(--ufs-muted);padding:4px;display:flex;align-items:center;justify-content:center;width:28px;height:28px;min-width:28px;flex:0 0 28px}",
    "#ufs-app .ufs-create-head .ufs-create-dismiss:hover:not(:disabled){color:var(--ufs-text);background:var(--ufs-hover)}",
    "#ufs-app .ufs-create-form{display:flex;flex:1 1 auto;flex-direction:column;gap:0;margin:0;min-width:0;min-height:0;overflow:hidden}",
    "#ufs-app .ufs-create-fields{display:flex;flex:1 1 auto;flex-direction:column;gap:17px;padding:18px 20px 20px;min-width:0;min-height:0;overflow-y:auto;overscroll-behavior:contain}",
    "#ufs-app .ufs-create-field{min-width:0}",
    "#ufs-app .ufs-create-dialog .ufs-create-label{display:block;font-size:12px;font-weight:500;color:var(--ufs-muted);line-height:1.5;margin:0 0 7px}",
    "#ufs-app .ufs-create-location{display:block;width:100%;min-height:36px;padding:8px 10px;background:var(--ufs-panel);border:1px solid var(--ufs-border);border-radius:5px;color:var(--ufs-text);font-size:13px;line-height:19px;overflow-wrap:anywhere}",
    "#ufs-app .ufs-create-input{display:block;width:100%;height:36px;min-height:36px;margin:0;border:1px solid #cbd2da;border-radius:5px;color:var(--ufs-text);background:var(--ufs-bg);padding:7px 10px;line-height:20px;transition:border-color .15s,box-shadow .15s}",
    "#ufs-app .ufs-create-input:focus{border-color:var(--ufs-accent);outline:none!important;box-shadow:0 0 0 2px rgba(235,120,37,.18)}",
    "#ufs-app .ufs-create-input::selection{background:var(--ufs-accent);color:#fff}",
    "#ufs-app .ufs-create-feedback{min-height:17px;margin-top:8px;font-size:12px;line-height:1.5;color:var(--ufs-muted);overflow-wrap:anywhere}",
    "#ufs-app .ufs-create-feedback.ufs-error{color:#c13d37}",
    "#ufs-app .ufs-create-buttons{display:flex;align-items:center;justify-content:flex-end;height:64px;min-height:64px;flex:0 0 64px;gap:9px;padding:0 20px;background:var(--ufs-bg);border-top:1px solid var(--ufs-border)}",
    "#ufs-app .ufs-create-buttons button{display:inline-flex;align-items:center;justify-content:center;min-width:85px;min-height:34px;height:34px;padding:6px 16px;margin:0;border-radius:5px;border:1px solid var(--ufs-border);background:var(--ufs-bg);color:var(--ufs-text);font-weight:500;line-height:1.4}",
    "#ufs-app .ufs-create-buttons .ufs-create-cancel:hover:not(:disabled){background:var(--ufs-hover)}",
    "#ufs-app .ufs-create-buttons .ufs-create-submit{background:var(--ufs-accent);color:#fff;border-color:var(--ufs-accent)}",
    "#ufs-app .ufs-create-buttons .ufs-create-submit:hover:not(:disabled){filter:brightness(.96)}",
    "@media(max-width:560px){#ufs-app .ufs-dialog-overlay{padding:10px}#ufs-app .ufs-create-head{padding:0 15px}#ufs-app .ufs-create-fields{padding:15px}#ufs-app .ufs-create-buttons{padding:0 15px}}",
    '#ufs-app .ufs-rename-original{display:block;min-height:20px;padding:1px 0;color:var(--ufs-text);font-size:13px;line-height:1.5;overflow-wrap:anywhere}',
    // v0.2.3.12: All dialogs share one fixed header/footer and scrolling body.
    // Copy alone keeps a wider shell and an independently scrolling picker.
    "#ufs-app .ufs-copy-dialog{width:min(465px,100%)}",
    "#ufs-app .ufs-copy-summary{display:flex;align-items:center;gap:10px;padding:10px;background:var(--ufs-panel);border:1px solid var(--ufs-border);border-radius:5px;min-width:0}",
    "#ufs-app .ufs-copy-summary-info{display:flex;flex:1;flex-direction:column;gap:3px;min-width:0;font-size:13px;overflow-wrap:anywhere}",
    "#ufs-app .ufs-copy-summary-info span{color:var(--ufs-muted);font-size:12px}",
    "#ufs-app .ufs-copy-picker{height:225px;overflow:auto;border:1px solid var(--ufs-border);border-radius:5px;padding:6px 0;background:var(--ufs-bg)}",
    "#ufs-app .ufs-copy-tree-group{padding:5px 11px 7px;color:var(--ufs-muted);font-size:12px;font-weight:600}",
    "#ufs-app .ufs-copy-tree-row{display:flex;align-items:center;height:32px;min-height:32px;gap:0;padding-right:7px}",
    "#ufs-app .ufs-copy-expand{display:flex;align-items:center;justify-content:center;flex:0 0 24px;width:24px;min-width:24px;max-width:24px;height:28px;min-height:28px;margin:0;padding:0;border:0;background:transparent;color:var(--ufs-muted)}",
    "#ufs-app .ufs-copy-choose{display:flex;align-items:center;gap:7px;flex:0 1 auto;min-width:0;max-width:calc(100% - 55px);height:30px;min-height:30px;margin:0;padding:4px 7px;border:0;background:transparent;color:var(--ufs-text);text-align:left;border-radius:4px;font-size:13px}",
    "#ufs-app .ufs-copy-choose span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    "#ufs-app .ufs-copy-tree-row.ufs-copy-selected{background:rgba(235,120,37,.11);border-radius:4px}",
    "#ufs-app .ufs-copy-tree-row.ufs-copy-selected .ufs-copy-choose{background:transparent;color:var(--ufs-text);font-weight:600}",
    "#ufs-app .ufs-copy-tree-row:not(.ufs-copy-selected):hover{background:var(--ufs-hover);border-radius:4px}",
    "#ufs-app .ufs-copy-tree-row .ufs-copy-choose:hover:not(:disabled){background:transparent}",
    "#ufs-app .ufs-copy-choose:disabled{opacity:.38;cursor:not-allowed}",
    "#ufs-app .ufs-copy-tree-status{padding-top:6px;padding-bottom:7px;font-size:12px;color:var(--ufs-muted)}",
    "#ufs-app .ufs-copy-mkdir-trigger{display:flex;align-items:center;justify-content:center;flex:0 0 25px;width:25px;min-width:25px;max-width:25px;height:27px;min-height:27px;margin:0 0 0 2px;padding:4px;border:0;background:transparent;color:var(--ufs-accent);opacity:0;visibility:hidden}",
    "#ufs-app .ufs-copy-tree-row:hover .ufs-copy-mkdir-trigger,#ufs-app .ufs-copy-tree-row.ufs-copy-selected .ufs-copy-mkdir-trigger,#ufs-app .ufs-copy-tree-row:focus-within .ufs-copy-mkdir-trigger{opacity:1;visibility:visible}",
    "#ufs-app .ufs-copy-mkdir-trigger:hover:not(:disabled){background:var(--ufs-accent-soft)}",
    "#ufs-app .ufs-copy-tree-row.ufs-copy-selected .ufs-copy-mkdir-trigger:hover:not(:disabled){background:transparent}",
    "#ufs-app .ufs-copy-inline-row{display:flex;align-items:center;gap:5px;height:36px;min-height:36px;padding-right:7px;min-width:0}",
    "#ufs-app .ufs-copy-inline-row>.ufs-folder-icon{flex:0 0 16px;margin:0 3px 0 24px}",
    "#ufs-app .ufs-copy-inline-input{flex:1 1 auto;width:0;min-width:40px;height:28px;min-height:28px;margin:0;padding:3px 7px;border:1px solid var(--ufs-accent);border-radius:4px;background:var(--ufs-bg);color:var(--ufs-text);font-size:13px;outline:none}",
    "#ufs-app .ufs-copy-inline-action{flex:0 0 26px;display:flex;justify-content:center;align-items:center;width:26px;min-width:26px;height:28px;min-height:28px;margin:0;padding:4px;border:0;background:transparent;color:var(--ufs-muted)}",
    "#ufs-app .ufs-copy-inline-action.ufs-copy-inline-confirm{color:var(--ufs-accent)}",
    "#ufs-app .ufs-copy-inline-action:hover:not(:disabled){background:var(--ufs-hover)}",
    "#ufs-app .ufs-copy-inline-error{color:var(--ufs-muted);font-size:12px;line-height:1.45;white-space:normal;overflow-wrap:anywhere;padding:3px 7px 6px}",
    "#ufs-app .ufs-copy-inline-error[data-error=true]{color:#c13d37}",
    "#ufs-app .ufs-copy-dialog[data-inline-mkdir=active] .ufs-copy-submit{opacity:.42;cursor:not-allowed}",
    "#ufs-app .ufs-copy-destination{margin-top:9px;color:var(--ufs-muted);font-size:12px;overflow-wrap:anywhere}",
    "#ufs-app .ufs-copy-dialog .ufs-create-feedback{margin-top:8px}",
    "@media(max-height:650px){#ufs-app .ufs-copy-picker{height:min(200px,30vh)}}",
    "#ufs-app .ufs-copy-progress-panel{display:flex;flex-direction:column;gap:0;min-width:0}",
    "#ufs-app .ufs-copy-progress-target{display:flex;align-items:center;gap:8px;color:var(--ufs-muted);font-size:12px;line-height:1.5;overflow-wrap:anywhere}",
    "#ufs-app .ufs-copy-progress-target .ufs-folder-icon{color:var(--ufs-accent);flex-shrink:0}",
    "#ufs-app .ufs-copy-progress-status{display:flex;align-items:center;justify-content:space-between;gap:9px;margin:22px 0 11px;font-size:13px}",
    "#ufs-app .ufs-copy-progress-state{display:flex;align-items:center;gap:8px;min-width:0;font-weight:600}",
    "#ufs-app .ufs-copy-progress-state-text{min-width:0;overflow-wrap:anywhere}",
    "#ufs-app .ufs-copy-progress-spinner{width:16px;height:16px;flex:0 0 16px;border:2px solid rgba(235,120,37,.19);border-top-color:var(--ufs-accent);border-radius:50%;animation:ufs-copy-spin .9s linear infinite}",
    "#ufs-app .ufs-copy-progress-indicator{font-size:11px;color:var(--ufs-accent);white-space:nowrap}",
    "#ufs-app .ufs-copy-progress-track{position:relative;height:8px;border-radius:8px;background:var(--ufs-panel);overflow:hidden}",
    "#ufs-app .ufs-copy-progress-fill{position:absolute;top:0;bottom:0;left:0;width:35%;border-radius:8px;background:var(--ufs-accent)}",
    "#ufs-app .ufs-copy-progress-panel[data-progress-mode=indeterminate] .ufs-copy-progress-fill{background:linear-gradient(90deg,transparent,rgba(235,120,37,.76),var(--ufs-accent),transparent);animation:ufs-copy-flow 1.7s cubic-bezier(.4,0,.2,1) infinite}",
    "#ufs-app .ufs-copy-progress-panel[data-progress-mode=determinate] .ufs-copy-progress-fill{background:var(--ufs-accent);background-image:none;animation:none;transition:width .2s ease-out}",
    "#ufs-app .ufs-copy-progress-stages{display:flex;justify-content:space-between;gap:7px;margin-top:14px;font-size:11px;line-height:1.5}",
    "#ufs-app .ufs-copy-progress-stage{color:var(--ufs-muted);white-space:nowrap}",
    "#ufs-app .ufs-copy-progress-stage[data-status=active]{color:var(--ufs-accent);font-weight:600}",
    "#ufs-app .ufs-copy-progress-stage[data-status=done]{color:#34895e}",
    "#ufs-app .ufs-copy-progress-note{margin-top:19px;font-size:12px;line-height:1.5;color:var(--ufs-muted);overflow-wrap:anywhere}",
    "#ufs-app .ufs-copy-progress-panel[data-phase=success] .ufs-copy-progress-spinner{animation:none;border-color:#34895e;background:#34895e;position:relative}",
    "#ufs-app .ufs-copy-progress-panel[data-phase=success] .ufs-copy-progress-spinner::after{content:'';position:absolute;left:3px;top:0;width:5px;height:9px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}",
    "#ufs-app .ufs-copy-progress-panel[data-phase=success] .ufs-copy-progress-fill{animation:none;width:100%;background:#34895e}",
    "#ufs-app .ufs-copy-progress-panel[data-phase=success] .ufs-copy-progress-indicator,#ufs-app .ufs-copy-progress-panel[data-phase=success] .ufs-copy-progress-state{color:#34895e}",
    "#ufs-app .ufs-copy-progress-panel[data-phase=uncertain] .ufs-copy-progress-spinner{animation:none;border-color:#c13d37;border-top-color:transparent}",
    "#ufs-app .ufs-copy-progress-panel[data-phase=uncertain] .ufs-copy-progress-fill{animation:none;width:0}",
    "#ufs-app .ufs-copy-progress-panel[data-phase=uncertain] .ufs-copy-progress-state,#ufs-app .ufs-copy-progress-panel[data-phase=uncertain] .ufs-copy-progress-indicator,#ufs-app .ufs-copy-progress-panel[data-phase=uncertain] .ufs-copy-progress-note{color:#c13d37}",
    "@keyframes ufs-copy-spin{to{transform:rotate(360deg)}}",
    "@keyframes ufs-copy-flow{from{transform:translateX(-110%)}to{transform:translateX(305%)}}",
    "@media(prefers-reduced-motion:reduce){#ufs-app .ufs-copy-progress-spinner,#ufs-app .ufs-copy-progress-panel[data-progress-mode=indeterminate] .ufs-copy-progress-fill,#ufs-app .ufs-copy-progress-panel[data-progress-mode=determinate] .ufs-copy-progress-fill{animation:none}#ufs-app .ufs-copy-progress-panel[data-progress-mode=determinate] .ufs-copy-progress-fill{transition:none}}",
    "#ufs-app .ufs-copy-task-trigger{margin:0 3px;min-width:0;padding:4px 9px;border:1px solid var(--ufs-border);font-size:12px;color:var(--ufs-accent);background:var(--ufs-panel)}",
    "#ufs-app .ufs-copy-task-trigger[hidden],#ufs-app .ufs-copy-background[hidden],#ufs-app .ufs-copy-cancel[hidden]{display:none!important}",
    "#ufs-app .ufs-copy-background{display:inline-flex;align-items:center;justify-content:center;height:34px;min-height:34px;min-width:85px;margin:0;padding:6px 10px;border:1px solid var(--ufs-border);border-radius:5px;background:var(--ufs-bg);color:var(--ufs-text);font-size:12px}",
    "#ufs-app .ufs-copy-current-file{min-height:18px;margin-top:10px;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ufs-text)}",
    "#ufs-app .ufs-copy-progress-metrics{min-height:18px;margin-top:4px;font-size:12px;color:var(--ufs-muted);font-variant-numeric:tabular-nums}",
    "#ufs-app .ufs-copy-progress-panel[data-phase=success] .ufs-copy-progress-note{color:#34895e}",
    "#ufs-app .ufs-copy-progress-panel[data-phase=success] .ufs-copy-progress-track{background:#d8f2e2}",
    "#ufs-app .ufs-copy-progress-panel[data-phase=cancelled] .ufs-copy-progress-fill{animation:none}",
    "@media(max-width:560px){#ufs-app .ufs-copy-background{min-width:70px;padding:6px 7px}#ufs-app .ufs-copy-progress-stages{font-size:10px}}",
    // Only the enhanced Browse view is locked; the native view and every other Unraid page scroll normally.
    'html.ufs-active-page,html.ufs-active-page body{overflow-y:hidden!important;overscroll-behavior-y:none}',
    // Unraid adds two fixed global page-scroll arrows; neither applies to our internally scrolling browser.
    // Scope to this mode because Unraid's periodic jQuery fadeIn() may change inline display styles.
    'html.ufs-active-page .move_to_end,html.ufs-active-page .back_to_top{display:none!important}',
    '#ufs-app .ufs-list,#ufs-app .ufs-sidebar,#ufs-app .ufs-inspector{overscroll-behavior:contain}',
    // File Station-only thin native scrollbar. Keep scrolling and thumb dragging intact:
    // scroll activity and hover show the thumb; idle leaves a transparent track.
    '#ufs-app .ufs-list{scrollbar-width:thin;scrollbar-color:transparent transparent}#ufs-app .ufs-list:hover,#ufs-app .ufs-list.ufs-scroll-active{scrollbar-color:rgba(105,115,126,.48) transparent}#ufs-app .ufs-list::-webkit-scrollbar{width:6px;height:6px;background:transparent}#ufs-app .ufs-list::-webkit-scrollbar-track{background:transparent}#ufs-app .ufs-list::-webkit-scrollbar-thumb{background:transparent;border-radius:8px}#ufs-app .ufs-list:hover::-webkit-scrollbar-thumb,#ufs-app .ufs-list.ufs-scroll-active::-webkit-scrollbar-thumb{background:rgba(105,115,126,.48)}#ufs-app .ufs-list::-webkit-scrollbar-thumb:hover{background:rgba(94,104,115,.7)}#ufs-app .ufs-list::-webkit-scrollbar-corner{background:transparent}',
    // Use the same native idle/hover/scroll scrollbar policy in every modal body
    // and the copy destination tree. Keep wheel, trackpad and thumb dragging native.
    '#ufs-app .ufs-create-dialog .ufs-create-fields,#ufs-app .ufs-copy-picker{scrollbar-width:thin;scrollbar-color:transparent transparent}',
    '#ufs-app .ufs-create-dialog .ufs-create-fields:hover,#ufs-app .ufs-create-dialog .ufs-create-fields.ufs-scroll-active,#ufs-app .ufs-copy-picker:hover,#ufs-app .ufs-copy-picker.ufs-scroll-active{scrollbar-color:rgba(105,115,126,.48) transparent}',
    '#ufs-app .ufs-create-dialog .ufs-create-fields::-webkit-scrollbar,#ufs-app .ufs-copy-picker::-webkit-scrollbar{width:6px;height:6px;background:transparent}',
    '#ufs-app .ufs-create-dialog .ufs-create-fields::-webkit-scrollbar-track,#ufs-app .ufs-copy-picker::-webkit-scrollbar-track{background:transparent}',
    '#ufs-app .ufs-create-dialog .ufs-create-fields::-webkit-scrollbar-thumb,#ufs-app .ufs-copy-picker::-webkit-scrollbar-thumb{background:transparent;border-radius:8px}',
    '#ufs-app .ufs-create-dialog .ufs-create-fields:hover::-webkit-scrollbar-thumb,#ufs-app .ufs-create-dialog .ufs-create-fields.ufs-scroll-active::-webkit-scrollbar-thumb,#ufs-app .ufs-copy-picker:hover::-webkit-scrollbar-thumb,#ufs-app .ufs-copy-picker.ufs-scroll-active::-webkit-scrollbar-thumb{background:rgba(105,115,126,.48)}',
    '#ufs-app .ufs-create-dialog .ufs-create-fields::-webkit-scrollbar-thumb:hover,#ufs-app .ufs-copy-picker::-webkit-scrollbar-thumb:hover{background:rgba(94,104,115,.7)}',
    '#ufs-app .ufs-create-dialog .ufs-create-fields::-webkit-scrollbar-corner,#ufs-app .ufs-copy-picker::-webkit-scrollbar-corner{background:transparent}',
    // Hovering the inner picker should not illuminate the outer body's scrollbar.
    '#ufs-app .ufs-copy-dialog .ufs-create-fields:has(.ufs-copy-picker:hover){scrollbar-color:transparent transparent}',
    '#ufs-app .ufs-copy-dialog .ufs-create-fields:has(.ufs-copy-picker:hover)::-webkit-scrollbar-thumb{background:transparent}',

    '#ufs-app .ufs-menu .ufs-location-copy{width:auto;flex:0 0 auto;white-space:nowrap;padding:4px 9px;font-size:12px;color:var(--ufs-accent);border:1px solid var(--ufs-border)}',
    '.ufs-hide-native{display:none!important}#ufs-native-enable{margin:8px;padding:7px 12px;background:#e87526;color:#fff;border:0;border-radius:5px;cursor:pointer}',
    // Pointer focus should not leave a colored ring after details is closed.
    // Preserve the visible outline for keyboard navigation using :focus-visible.
    '#ufs-app button:focus:not(:focus-visible){outline:none!important;box-shadow:none!important}#ufs-app .ufs-details-button:focus:not(:focus-visible){outline:none!important;box-shadow:none!important}',
    // Unraid styles can shift button baselines; stretch table-header cells then
    // center the sort button's contents explicitly inside the header's fixed height.
    '#ufs-app .ufs-head{align-items:stretch;padding-top:0;padding-bottom:0}#ufs-app .ufs-head>span{display:flex;align-items:center;min-width:0;height:100%;margin:0;padding:0;vertical-align:middle}#ufs-app .ufs-head .ufs-sort-button{display:inline-flex;align-items:center;justify-content:flex-start;width:100%;height:100%;min-height:0;margin:0;padding:0;line-height:1.3;vertical-align:middle}',
    '#ufs-app .ufs-location-col{display:flex;align-items:center;min-width:0;overflow:hidden;white-space:nowrap}#ufs-app .ufs-entry .ufs-location-trigger{display:inline-flex;align-items:center;gap:4px;width:100%;min-width:0;max-width:100%;height:30px;min-height:0;overflow:hidden;padding:0;border:0;background:transparent;border-radius:0;text-align:left;color:var(--ufs-text);font-size:12px;font-weight:400;line-height:1.4;cursor:pointer!important}#ufs-app .ufs-entry .ufs-location-trigger:hover{color:var(--ufs-accent);background:transparent}#ufs-app .ufs-location-text{white-space:nowrap;overflow:hidden;text-overflow:clip;flex:0 1 auto;min-width:0}#ufs-app .ufs-location-ellipsis{white-space:nowrap;flex-shrink:0;color:var(--ufs-muted)}#ufs-app .ufs-location-more-link{color:var(--ufs-accent);font-size:11px;flex:0 0 auto;white-space:nowrap;text-decoration:underline;text-underline-offset:2px}#ufs-app .ufs-location-popover{width:min(440px,calc(100vw - 20px));max-width:none;padding:0;overflow:hidden}#ufs-app .ufs-location-popover-header{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--ufs-border);font-weight:600}#ufs-app .ufs-menu .ufs-location-popover-close{display:inline-flex;align-items:center;justify-content:center;flex:0 0 28px;width:28px;height:28px;min-width:28px;padding:0;border:0;background:transparent;color:var(--ufs-muted);text-align:center}#ufs-app .ufs-location-popover-items{display:grid;grid-template-columns:repeat(auto-fill,minmax(85px,1fr));gap:6px;padding:12px;max-height:min(300px,50vh);overflow-y:auto;overscroll-behavior:contain}#ufs-app .ufs-location-device{padding:6px 8px;border-radius:4px;background:var(--ufs-panel);font-size:12px;overflow-wrap:anywhere}#ufs-app .ufs-owner{min-width:0;overflow:hidden;text-overflow:ellipsis}',
    '@media(max-width:720px){#ufs-app .ufs-sidebar{width:42px;flex-basis:42px;padding:4px}#ufs-app .ufs-resizer{display:none}#ufs-app .ufs-sidebar .ufs-tree-name,#ufs-app .ufs-tree-label,#ufs-app .ufs-tree-toggle,#ufs-app .ufs-sidebar .ufs-tree-spacer{display:none}#ufs-app .ufs-search{width:90px}}',
    '#ufs-app .ufs-top{height:46px;gap:9px;padding:0 12px}#ufs-app .ufs-brand{display:flex;align-items:center;gap:7px;flex-shrink:0;white-space:nowrap}#ufs-app .ufs-heading{font-size:15px}#ufs-app .ufs-brand-divider{height:19px;width:1px;background:var(--ufs-border);flex-shrink:0}#ufs-app .ufs-preview-chip{font-size:11px;color:var(--ufs-muted);white-space:nowrap}#ufs-app .ufs-app-actions{display:flex;align-items:center;gap:3px;flex-shrink:0}',
    '#ufs-app .ufs-top .ufs-tabs{display:flex;align-items:center;flex:1;min-width:0;height:100%;gap:4px;padding:0;background:transparent;border:0;overflow-x:auto;overflow-y:hidden;scrollbar-width:none}#ufs-app .ufs-top .ufs-tabs::-webkit-scrollbar{display:none}#ufs-app .ufs-top .ufs-tab{flex-shrink:0;height:31px;min-width:85px;max-width:195px;padding:4px 8px}#ufs-app .ufs-top .ufs-tabs>.ufs-ico{flex:0 0 auto}',
    '#ufs-app .ufs-file-actions{display:flex;align-items:center;gap:5px;height:34px;min-height:34px;max-height:34px;flex-shrink:0;padding:0 10px;border-bottom:1px solid var(--ufs-border);background:var(--ufs-bg);overflow:hidden}#ufs-app .ufs-file-actions .ufs-section-label{font-size:12px;color:var(--ufs-muted);font-weight:500}#ufs-app .ufs-file-actions .ufs-view-controls{display:flex;align-items:center;gap:3px;margin-left:auto;flex-shrink:0}#ufs-app .ufs-file-actions .ufs-ico{height:28px;min-height:0;padding:3px 8px}',
    '#ufs-app .ufs-search-wrap{display:flex;align-items:center;gap:3px;min-width:0;flex-shrink:0;margin-left:auto}#ufs-app .ufs-search{width:150px;min-width:0;max-width:none}#ufs-app [hidden]{display:none!important}',
    '@media(max-width:850px){#ufs-app .ufs-preview-chip{display:none}#ufs-app .ufs-search{width:115px}}',
    '@media(max-width:720px){#ufs-app .ufs-brand-divider{display:none}#ufs-app .ufs-top{padding:0 7px;gap:6px}#ufs-app .ufs-navigation{padding:0 6px;gap:3px}#ufs-app .ufs-search{width:90px}#ufs-app .ufs-view-controls .ufs-details-button{display:none}}',
  ].join('\n');


  const COLUMNS = [
    { key:'name', label:'名称', width:280, min:180, max:900 },
    { key:'size', label:'大小', width:95, min:65, max:260 },
    { key:'mtime', label:'修改日期', width:155, min:115, max:300 },
    { key:'owner', label:'OWNER', width:95, min:65, max:250 },
    { key:'permissions', label:'权限', width:120, min:90, max:270 },
    { key:'locations', label:'LOCATION', width:250, min:120, max:900 }
  ];
  const COLUMN_GAP = 10, COLUMN_PADDING = 24;
  const VIRTUAL_THRESHOLD = 200;
  const VIRTUAL_ROW_HEIGHT = 38, VIRTUAL_GRID_STEP = 132, VIRTUAL_OVERSCAN = 8;
  function virtualGridColumns(width) {
    return Math.max(1, Math.floor((Math.max(0, width - 28) + 10) / 135));
  }
  function virtualWindow(total, scrollTop, viewportHeight, view = 'list', columns = 1) {
    const cols = view === 'grid' ? Math.max(1, Math.floor(columns)) : 1;
    const step = view === 'grid' ? VIRTUAL_GRID_STEP : VIRTUAL_ROW_HEIGHT;
    const offset = view === 'grid' ? 14 : 34;
    const rows = Math.ceil(total / cols);
    const first = Math.max(0, Math.floor((Math.max(0, scrollTop) - offset) / step));
    const startRow = Math.max(0, Math.min(rows, first - VIRTUAL_OVERSCAN));
    const endRow = Math.max(startRow, Math.min(rows,
      Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewportHeight) - offset) / step) + VIRTUAL_OVERSCAN));
    return {start:startRow * cols, end:Math.min(total,endRow*cols),
      before:startRow*step, after:(rows-endRow)*step, columns:cols};
  }
  function clampColumnWidth(key, value) {
    const spec = COLUMNS.find((column) => column.key === key);
    const n = Number(value);
    return spec && Number.isFinite(n) ? Math.round(Math.max(spec.min, Math.min(spec.max, n))) : null;
  }
  function readColumnWidths(raw) {
    let parsed;
    try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch (_) { return {}; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result = {};
    for (const column of COLUMNS) {
      if (Object.prototype.hasOwnProperty.call(parsed, column.key)) {
        const width = clampColumnWidth(column.key, parsed[column.key]);
        if (width !== null) result[column.key] = width;
      }
    }
    return result;
  }
  function columnLayout(widths) {
    const values = COLUMNS.map((column) =>
      Object.prototype.hasOwnProperty.call(widths, column.key)
        ? clampColumnWidth(column.key, widths[column.key]) || column.width : column.width);
    const trackWidths = COLUMNS.map((column, index) =>
      column.key === 'name' && !Object.prototype.hasOwnProperty.call(widths, 'name')
        ? 'minmax(' + column.width + 'px, 1fr)' : values[index] + 'px');
    return {
      columns: trackWidths.join(' '),
      minWidth: values.reduce((sum, width) => sum + width, 0) +
        COLUMN_GAP * (COLUMNS.length - 1) + COLUMN_PADDING
    };
  }
  function applyColumnLayout() {
    if (!app) return;
    const layout = columnLayout(state.columnWidths);
    app.style.setProperty('--ufs-columns', layout.columns);
    app.style.setProperty('--ufs-table-min-width', layout.minWidth + 'px');
  }
  function inspectListScrollMetrics(list) {
    if (!list) return null;
    const clientWidth = list.clientWidth;
    const scrollWidth = list.scrollWidth;
    const clientHeight = list.clientHeight;
    const scrollHeight = list.scrollHeight;
    const requiredWidth = columnLayout(state.columnWidths).minWidth + 16; // list padding 8px each side
    return {
      clientWidth, scrollWidth, clientHeight, scrollHeight,
      horizontalOverflow: Math.max(0, scrollWidth - clientWidth),
      verticalOverflow: Math.max(0, scrollHeight - clientHeight),
      requiredWidth, columns: { ...state.columnWidths }
    };
  }
  function setupListScrollbars(list) {
    let idleTimer = null;
    list.addEventListener('scroll', () => {
      list.classList.add('ufs-scroll-active');
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        list.classList.remove('ufs-scroll-active');
        idleTimer = null;
      }, 1100);
    }, { passive: true });
    // Hover also reveals the native thumb so users can grab and drag it.
    // No overflow:hidden or simulated scrolling: accessibility remains native.
    return () => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      list.classList.remove('ufs-scroll-active');
    };
  }
  function updateColumnWidth(key, value, persist = false) {
    const width = clampColumnWidth(key, value);
    if (width === null) return;
    state.columnWidths[key] = width;
    applyColumnLayout();
    scheduleLocationDisplay();
    if (persist) localStorage.setItem(STORE + 'columns', JSON.stringify(state.columnWidths));
  }
  function resetColumnWidths() {
    state.columnWidths = {};
    localStorage.removeItem(STORE + 'columns');
    applyColumnLayout();
    scheduleLocationDisplay();
    notify('已恢复默认列宽');
  }
  function autoSizeColumn(key) {
    const spec = COLUMNS.find((column) => column.key === key);
    if (!spec) return;
    const cellText = (entry) => {
      if (key === 'name') return entry.name;
      if (key === 'size') return formatSize(entry.size);
      if (key === 'mtime') return formattedDate(entry.mtime);
      if (key === 'owner') return entry.owner || '—';
      if (key === 'permissions') return entry.permissions || '—';
      return locationNames(entry).join(', ') || '—';
    };
    // Canvas measurement avoids guessing text width for multilingual file names.
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext && canvas.getContext('2d');
    const list = $('.ufs-list', app);
    if (ctx && list) ctx.font = getComputedStyle(list).font || '13px sans-serif';
    const measure = (text) => ctx ? ctx.measureText(text).width : String(text).length * 8;
    const maxText = Math.max(measure(spec.label), ...state.entries.map((entry) => measure(cellText(entry))));
    updateColumnWidth(key, maxText + (key === 'name' ? 56 : 24), true);
  }
  function attachColumnResizer(cell, key) {
    const grip = element('span', 'ufs-column-grip');
    grip.setAttribute('role', 'separator');
    grip.setAttribute('aria-label', '调整' + (COLUMNS.find(x => x.key === key)?.label || key) + '列宽');
    grip.setAttribute('aria-orientation', 'vertical');
    grip.title = '拖动调整列宽，双击适应内容';
    let beginX = 0, beginWidth = 0, dragging = false;
    grip.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      dragging = true;
      beginX = event.clientX;
      beginWidth = cell.getBoundingClientRect().width;
      grip.setPointerCapture(event.pointerId);
      event.stopPropagation();
      event.preventDefault();
    });
    grip.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      updateColumnWidth(key, beginWidth + event.clientX - beginX);
    });
    const finish = () => {
      if (!dragging) return;
      dragging = false;
      localStorage.setItem(STORE + 'columns', JSON.stringify(state.columnWidths));
    };
    grip.addEventListener('pointerup', finish);
    grip.addEventListener('pointercancel', finish);
    grip.addEventListener('lostpointercapture', finish);
    grip.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      event.preventDefault();
      autoSizeColumn(key);
    });
    grip.addEventListener('click', (event) => event.stopPropagation());
    cell.append(grip);
  }

  const state = {
    tabs: [], activeId: 0, nextId: 1, entries: [], tree: new Map(),
    expanded: new Set([PREFIX]), selection: new Set(), lastIndex: -1, rootLoadError: '',
    view: localStorage.getItem(STORE + 'view') || 'list',
    theme: localStorage.getItem(STORE + 'theme') || 'unraid',
    inspector: false, filter: '', searchOpen: false, busy: false, requestId: 0,
    initializing: false, initGeneration: 0, directoryController: null, virtual: null,
    sortKey: 'name', sortDirection: 1,
    columnWidths: readColumnWidths(localStorage.getItem(STORE + 'columns'))
  };
  let app;
  let activeCopySession = null;
  function updateCopyTaskButton() {
    const button=app && $('.ufs-copy-task-trigger',app);
    if (!button) return;
    button.hidden=!activeCopySession;
    if (activeCopySession) {
      const phase=activeCopySession.phase;
      button.textContent=phase==='success'?'复制已完成':phase==='uncertain'?'复制待核实':
        phase==='cancelled'?'复制已停止':'复制任务进行中';
      button.setAttribute('aria-label','查看'+button.textContent);
    }
  }
  let nativeElements = [];
  let currentMenu = null;
  const treeLoads = new Map();
  let renameGeneration = 0;
  const renamedFolderRedirects = [];
  const cleanupTasks = [];
  const lifecycle = new AbortController();
  let destroyed = false;
  function onCleanup(fn) { cleanupTasks.push(fn); }
  function cleanupApp() {
    if (destroyed) return;
    destroyed = true;
    ++state.initGeneration;
    ++state.requestId;
    lifecycle.abort();
    state.directoryController?.abort();
    for (const task of cleanupTasks.splice(0)) {
      try { task(); } catch (_) { /* Cleanup must never interrupt page unload. */ }
    }
    document.documentElement.classList.remove('ufs-active-page');
  }
  window.addEventListener('pagehide', (event) => { if (!event.persisted) cleanupApp(); });
  function activeTab() { return state.tabs.find((tab) => tab.id === state.activeId); }
  function currentPath() { return activeTab() ? activeTab().path : PREFIX; }
  // A share group is not a browsable file location. Preserve the server's order:
  // the sidebar shows TimeMachine first if it is first in Browse.php's response.
  function firstSharePath(entries) {
    const first = (entries || []).find((entry) => entry.folder && safePath(entry.path) &&
      entry.path.startsWith(PREFIX + '/') &&
      !entry.path.slice(PREFIX.length + 1).includes('/'));
    return first ? first.path : null;
  }
  function defaultSharePath() {
    return firstSharePath(state.tree.get(PREFIX) || []);
  }
  function isShareRoot(path) {
    return typeof path === 'string' && path.startsWith(PREFIX + '/') &&
      !path.slice(PREFIX.length + 1).includes('/');
  }
  async function addDefaultTab() {
    if (destroyed || state.initializing) return;
    // A previous root read failure must not permanently cache an empty tree.
    if (state.rootLoadError) state.tree.delete(PREFIX);
    if (!state.tree.has(PREFIX)) await loadTree(PREFIX);
    if (destroyed) return;
    const home = defaultSharePath();
    if (!home) return notify(state.rootLoadError ? '无法读取共享文件夹，请稍后重试' : '没有可访问的共享文件夹');
    addTab(home);
  }
  function notify(message) {
    if (!app || destroyed) return;
    const previous = $('.ufs-toast', app);
    if (previous) previous.remove();
    const toast = element('div', 'ufs-toast', message);
    app.append(toast);
    const timer = setTimeout(() => { if (toast.isConnected) toast.remove(); }, 3500);
    onCleanup(() => clearTimeout(timer));
  }
  function nativeMode() {
    if (isDemo) { notify('演示模式没有原生文件管理器'); return; }
    localStorage.setItem(STORE + 'native', '1');
    document.documentElement.classList.remove('ufs-active-page');
    location.reload();
  }
  function toggleTheme() {
    state.theme = state.theme === 'unraid' ? 'dsm' : 'unraid';
    localStorage.setItem(STORE + 'theme', state.theme);
    app.classList.toggle('ufs-dsm', state.theme === 'dsm');
    notify(state.theme === 'dsm' ? '已切换到 DSM 经典主题' : '已切换到 Unraid 融合主题');
  }
  function setSearchOpen(open) {
    state.searchOpen = Boolean(open);
    const input = $('.ufs-search', app);
    const trigger = $('.ufs-search-trigger', app);
    input.hidden = !state.searchOpen;
    trigger.setAttribute('aria-expanded', String(state.searchOpen));
    trigger.classList.toggle('ufs-view-active', state.searchOpen);
    if (state.searchOpen) input.focus();
    else if (state.filter) {
      state.filter = '';
      input.value = '';
      renderFiles();
    }
  }
  function writeUrl(path, replace) {
    if (isDemo || destroyed) return;
    const url = new URL(location.href);
    url.searchParams.set('dir', path);
    const tab = activeTab();
    // Snapshot tab cursor in the actual browser entry. This avoids generating
    // new browser entries while traversing a tab's internal history.
    const stateValue = { ufs: true, tabId: tab?.id ?? null, path };
    history[replace ? 'replaceState' : 'pushState'](stateValue, '', url);
  }
  function addTab(path, activate = true) {
    if (path === PREFIX) { void addDefaultTab(); return; }
    if (!safePath(path) || destroyed) return;
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
    if (destroyed || !state.tabs.some(tab => tab.id === id)) return;
    state.activeId = id;
    state.selection.clear();
    state.filter = '';
    state.lastIndex = -1;
    const search = $('.ufs-search', app);
    if (search) search.value = '';
    writeUrl(currentPath(), true);
    renderTabs();
    void refreshDirectory();
  }
  function navigate(path, addHistory = true, urlMode = addHistory ? 'push' : 'replace') {
    if (path === PREFIX) return notify('请选择左侧的具体共享文件夹');
    if (!safePath(path)) return notify('此版本仅支持访问 User Shares');
    const tab = activeTab();
    if (!tab || tab.path === path || destroyed) return;
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
    if (urlMode !== 'none') writeUrl(path, urlMode === 'replace');
    renderTabs();
    void refreshDirectory();
  }
  function stepHistory(amount) {
    const tab = activeTab();
    if (!tab || destroyed) return;
    const next = tab.cursor + amount;
    if (next < 0 || next >= tab.history.length) return;
    tab.cursor = next;
    // The browser entry represents the current tab location, not each click
    // inside the tab's own Back/Forward timeline.
    navigate(tab.history[next], false, 'replace');
  }
  function restoreBrowserPath(path, preferredTabId) {
    if (!safePath(path) || path === PREFIX || destroyed) return false;
    let tab = state.tabs.find((item) => item.id === preferredTabId);
    if (!tab) tab = activeTab();
    if (!tab) { addTab(path); return true; }
    const switchedTab = state.activeId !== tab.id;
    if (switchedTab) state.activeId = tab.id;
    if (tab.path === path) {
      if (switchedTab) {
        state.selection.clear();
        state.lastIndex = -1;
        state.filter = '';
        const search = $('.ufs-search', app);
        if (search) search.value = '';
        renderTabs();
        void refreshDirectory(); // A matching path on another tab still needs its content.
      } else {
        renderTabs();
        renderNavigation();
      }
      return true;
    }
    let index = tab.history.lastIndexOf(path);
    if (index === -1) {
      tab.history = tab.history.slice(0, tab.cursor + 1);
      tab.history.push(path);
      index = tab.history.length - 1;
    }
    tab.cursor = index;
    navigate(path, false, 'none'); // popstate must never push/replace itself
    return true;
  }

  function resolveRenamedFolderPath(path) {
    let next = path;
    for (const redirect of renamedFolderRedirects) {
      next = remapPathPrefix(next, redirect.source, redirect.target);
    }
    return next;
  }
  function applyRenameToBrowser(plan) {
    // Only called after listDirectory has verified a successful rename.
    const oldPath = plan.source, newPath = plan.target;
    ++renameGeneration;
    treeLoads.clear();
    if (plan.folder) {
      renamedFolderRedirects.push({source: oldPath, target: newPath});
      for (const tab of state.tabs) {
        tab.path = remapPathPrefix(tab.path, oldPath, newPath);
        tab.history = tab.history.map(path => remapPathPrefix(path, oldPath, newPath));
      }
      state.expanded = new Set([...state.expanded].map(path => remapPathPrefix(path, oldPath, newPath)));
      const transformed = new Map();
      for (const [path, entries] of state.tree) {
        transformed.set(remapPathPrefix(path, oldPath, newPath), entries.map(entry => {
          const replacement = remapPathPrefix(entry.path, oldPath, newPath);
          return replacement === entry.path ? entry : {...entry, path: replacement, name: fileName(replacement)};
        }));
      }
      state.tree = transformed;
    }
    const parent = parentPath(oldPath);
    // Parent contents may have changed; never keep a potentially stale entry.
    state.tree.delete(parent);
    state.selection.clear();
    state.lastIndex = -1;
    if (activeTab()) writeUrl(currentPath(), true);
    renderTabs();
    renderTree();
    renderNavigation();
    if (activeTab()) void refreshDirectory();
    // The parent may be represented in the sidebar although a different tab
    // is active. Force a re-read; stale tree loads are generation guarded.
    if (currentPath() !== parent) void loadTree(parent, true);
  }

  async function loadTree(path, retry = false) {
    if (destroyed || !safePath(path)) return;
    if (!retry && state.tree.has(path)) return;
    if (treeLoads.has(path)) return treeLoads.get(path);
    const generation = renameGeneration;
    const pending = (async () => {
      try {
        const entries = await listDirectory(path);
        if (destroyed || generation !== renameGeneration) return;
        if (path === PREFIX) state.rootLoadError = '';
        // An active-directory refresh may already have newer directory data.
        if (retry || !state.tree.has(path)) {
          state.tree.set(path, entries.filter((entry) => entry.folder));
        }
        renderTree();
      } catch (error) {
        if (destroyed || generation !== renameGeneration) return;
        if (path === PREFIX) state.rootLoadError = error.message;
        // Do not cache an unsuccessful read as an empty folder: next click retries.
        if (retry) state.tree.delete(path);
        renderTree();
        notify('目录树读取失败：' + error.message);
      } finally {
        if (treeLoads.get(path) === pending) treeLoads.delete(path);
      }
    })();
    treeLoads.set(path, pending);
    return pending;
  }
  async function refreshDirectory() {
    if (destroyed) return;
    if (!activeTab()) {
      if (state.initializing) return;
      state.tree.delete(PREFIX);
      state.rootLoadError = '';
      await initializeBrowser(PREFIX);
      return;
    }
    state.directoryController?.abort();
    const controller = new AbortController();
    state.directoryController = controller;
    const path = currentPath();
    const tabId = activeTab().id;
    const request = ++state.requestId;
    state.busy = true;
    state.entries = [];
    renderNavigation();
    renderFiles();
    try {
      const entries = await listDirectory(path, {signal: controller.signal});
      if (destroyed || request !== state.requestId || tabId !== activeTab()?.id ||
          path !== currentPath() || controller.signal.aborted) return;
      state.entries = entries;
      state.busy = false;
      state.tree.set(path, entries.filter((entry) => entry.folder));
      renderFiles();
      renderTree();
      renderNavigation();
    } catch (error) {
      if (destroyed || controller.signal.aborted || error.name === 'AbortError' ||
          request !== state.requestId) return;
      state.busy = false;
      state.entries = [];
      renderFiles(error.message);
      renderNavigation();
    } finally {
      if (state.directoryController === controller) state.directoryController = null;
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
    add.disabled = state.initializing || (state.busy && !activeTab());
    add.append(icon('plus'));
    add.setAttribute('aria-label', '新建标签页');
    add.title = '新建标签页';
    add.addEventListener('click', () => { void addDefaultTab(); });
    target.append(add);
  }
  function renderTree() {
    const target = $('.ufs-tree', app);
    target.replaceChildren();
    target.append(element('div', 'ufs-tree-label', '共享文件夹'));
    function appendNode(path, level) {
      const wrapper = element('div', 'ufs-tree-node');
      const row = element('div', 'ufs-tree-row' +
        (path === PREFIX ? ' ufs-tree-group' : currentPath() === path ? ' ufs-current' : ''));
      row.style.paddingLeft = (7 + level * 16) + 'px';
      const children = state.tree.get(path);
      const hasKnownChildren = children && children.length > 0;
      const toggler = element('button', 'ufs-tree-toggle');
      toggler.append(icon(state.expanded.has(path) ? 'chevron-down' : 'chevron-right'));
      if (children && !hasKnownChildren) toggler.style.visibility = 'hidden';
      toggler.title = '展开或折叠';
      toggler.type = 'button';
      toggler.addEventListener('click', async (event) => {
        event.stopPropagation(); // Arrow expands tree; it never navigates the row.
        event.preventDefault();
        if (state.expanded.has(path)) state.expanded.delete(path);
        else { state.expanded.add(path); await loadTree(path); }
        renderTree();
      });
      row.append(toggler, icon(state.expanded.has(path) ? 'folder-open' : 'folder', 'ufs-folder-icon'));
      if (path === PREFIX) row.lastChild.replaceWith(icon('drive', 'ufs-file-icon'));
      row.append(element('span', 'ufs-tree-name', path === PREFIX ? '所有共享文件夹' : path.split('/').pop()));
      row.title = path;
      if (path !== PREFIX) row.addEventListener('click', (event) => {
        if (event.target.closest('.ufs-tree-toggle')) return;
        navigate(path);
      });
      wrapper.append(row);
      target.append(wrapper);
      if (state.expanded.has(path)) {
        (state.tree.get(path) || []).forEach((entry) => appendNode(entry.path, level + 1));
      }
    }
    appendNode(PREFIX, 0);
  }
  function breadcrumbDisplayPaths(paths) {
    if (paths.length <= 4) return { visible: paths, hidden: [] };
    return { visible: [paths[0], null, ...paths.slice(-2)], hidden: paths.slice(1, -2) };
  }
  function showBreadcrumbMenu(trigger, hiddenPaths) {
    if (currentMenu && currentMenu._ufsTrigger === trigger) {
      closeMenu();
      return;
    }
    closeMenu();
    const menu = element('div', 'ufs-menu');
    menu.setAttribute('role', 'menu');
    menu._ufsTrigger = trigger;
    hiddenPaths.forEach((path) => {
      const item = element('button', '', path.split('/').pop());
      item.type = 'button';
      item.title = path;
      item.addEventListener('click', (event) => {
        event.stopPropagation();
        closeMenu();
        navigate(path);
      });
      menu.append(item);
    });
    app.append(menu);
    const rect = trigger.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(rect.left, innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(rect.bottom + 4, innerHeight - menu.offsetHeight - 8)) + 'px';
    currentMenu = menu;
    trigger.setAttribute('aria-expanded', 'true');
  }
  function renderNavigation() {
    const address = $('.ufs-address', app);
    address.replaceChildren();
    const parts = currentPath().split('/').filter(Boolean);
    const paths = [PREFIX];
    for (let i = 3; i <= parts.length; i++) paths.push('/' + parts.slice(0, i).join('/'));
    const { visible, hidden } = breadcrumbDisplayPaths([...new Set(paths)]);
    visible.forEach((path, index) => {
      if (index) address.append(icon('chevron-right', 'ufs-muted'));
      if (path === null) {
        const ellipsis = element('button', 'ufs-crumb ufs-crumb-more', '…');
        ellipsis.title = hidden.map((hiddenPath) => hiddenPath.split('/').pop()).join(' / ');
        ellipsis.setAttribute('aria-label', '选择中间目录');
        ellipsis.setAttribute('aria-haspopup', 'menu');
        ellipsis.setAttribute('aria-expanded', 'false');
        ellipsis.addEventListener('click', (event) => {
          event.stopPropagation();
          showBreadcrumbMenu(ellipsis, hidden);
        });
        address.append(ellipsis);
      } else {
        // The top group is a location label, not a clickable directory.
        const crumb = element(path === PREFIX ? 'span' : 'button', 'ufs-crumb',
          path === PREFIX ? '共享文件夹' : path.split('/').pop());
        crumb.title = path;
        if (path !== PREFIX) crumb.addEventListener('click', () => navigate(path));
        address.append(crumb);
      }
    });
    // Long names still scroll horizontally inside the compact breadcrumb.
    address.scrollLeft = address.scrollWidth;
    const tab = activeTab();
    $('.ufs-back', app).disabled = !tab || state.initializing || tab.cursor <= 0;
    $('.ufs-next', app).disabled = !tab || state.initializing || tab.cursor >= tab.history.length - 1;
    $('.ufs-up', app).disabled = !tab || state.initializing || currentPath() === PREFIX || isShareRoot(currentPath());
    $('.ufs-refresh', app).disabled = state.busy || state.initializing;
  }
  let visibleCache = null;
  const nameCollator = new Intl.Collator('zh-CN', {numeric:true});
  // The main file list and copy destination picker share one folder-name order.
  // Keep top-level Shares in Browse.php's original order (first Share stays first).
  function sortedCopyFolders(parent, entries) {
    const folders = entries.filter(item => item.folder &&
      safeCopyPath(item.path, true) && item.copyPathVerified !== false);
    return parent === PREFIX ? folders : folders.sort((a, b) => nameCollator.compare(a.name, b.name));
  }
  function visibleEntries() {
    if (visibleCache && visibleCache.entries === state.entries &&
        visibleCache.filter === state.filter && visibleCache.sortKey === state.sortKey &&
        visibleCache.sortDirection === state.sortDirection) return visibleCache.result;
    const q = state.filter.trim().toLocaleLowerCase();
    const direction = state.sortDirection;
    const nameCompare = (a, b) => nameCollator.compare(a.name,b.name);
    const result = state.entries.filter((entry) => !q || entry.name.toLocaleLowerCase().includes(q))
      .sort((a, b) => {
        const foldersFirst = Number(b.folder) - Number(a.folder);
        if (foldersFirst) return foldersFirst;
        if (state.sortKey === 'size') return direction * ((a.size || 0) - (b.size || 0)) || nameCompare(a, b);
        if (state.sortKey === 'mtime') return direction * ((a.mtime || 0) - (b.mtime || 0)) || nameCompare(a, b);
        if (state.sortKey === 'owner') return direction * (a.owner || '').localeCompare(b.owner || '', 'zh-CN', { numeric: true }) || nameCompare(a, b);
        if (state.sortKey === 'permissions') return direction * (a.permissions || '').localeCompare(b.permissions || '') || nameCompare(a, b);
        if (state.sortKey === 'locations') return direction *
          locationNames(a).join(',').localeCompare(locationNames(b).join(','), 'zh-CN', { numeric: true }) || nameCompare(a, b);
        return direction * nameCompare(a, b);
      });
    visibleCache = {entries:state.entries,filter:state.filter,
      sortKey:state.sortKey,sortDirection:state.sortDirection,result};
    return result;
  }
  function updateSelection(event, entry, index, visible) {
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
  }
  function shouldSuppressTextSelection(event) {
    return event.button === 0 && event.shiftKey === true;
  }
  function selectEntry(event, entry, index, visible) {
    updateSelection(event, entry, index, visible);
    renderSelection();
  }
  function selectedEntries() {
    return state.entries.filter((entry) => state.selection.has(entry.path));
  }
  function selectionStatus(chosen) {
    const files = chosen.filter((entry) => !entry.folder && Number.isFinite(entry.size) && entry.size >= 0);
    const knownBytes = files.reduce((total, entry) => total + entry.size, 0);
    return '已选择 ' + chosen.length + ' 个项目' +
      (files.length ? (files.length === chosen.length ? ' · 合计 ' : ' · 已知文件合计 ') + formatSize(knownBytes) : '');
  }
  function renderSelection() {
    $$('[data-ufs-file]', app).forEach((node) => node.classList.toggle('ufs-selected', state.selection.has(node.dataset.ufsFile)));
    const chosen = selectedEntries();
    $('.ufs-count', app).textContent = state.busy ? '正在读取目录…' :
      visibleEntries().length + (state.filter ? ' 个匹配项目' : ' 个项目') +
      (chosen.length ? ' · ' + selectionStatus(chosen) : '');
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
      ['修改日期', formattedDate(entry.mtime)], ['所有者', entry.owner || '—'], ['权限', entry.permissions || '—'],
      ['存储位置', locationNames(entry).join(', ') || '—'], ['逻辑路径', entry.path]];
    props.forEach(([label, value]) => {
      const row = element('div', 'ufs-prop');
      row.append(element('span', '', label), element('span', '', value));
      box.append(row);
    });
  }
  function createFileRow(entry, index, entries) {
    const row = element('div', 'ufs-entry');
    row.dataset.ufsFile = entry.path;
    row.dataset.ufsIndex = String(index);
    row.classList.toggle('ufs-selected', state.selection.has(entry.path));
    row.tabIndex = 0;
    row.title = entry.path;
    const name = element('div', 'ufs-file-name');
    name.append(fileIcon(entry));
    name.append(element('span', 'ufs-filename', entry.name));
    row.append(name,
      element('span', 'ufs-extra', formatSize(entry.size)),
      element('span', 'ufs-extra ufs-date', formattedDate(entry.mtime)),
      element('span', 'ufs-extra ufs-owner', entry.owner || '—'),
      element('span', 'ufs-extra ufs-permission', entry.permissions || '—'),
      renderLocationTags(entry));
    // Shift+click selects a file range. Suppress the browser's native Shift+mousedown
    // text selection without cancelling the following click/keyboard selection logic.
    row.addEventListener('mousedown', (event) => {
      if (shouldSuppressTextSelection(event)) event.preventDefault();
    });
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
    return row;
  }
  let virtualScheduled = false;
  function updateVirtualWindow(force = false) {
    const data = state.virtual;
    if (!data || destroyed || !app) return;
    const list = $('.ufs-list', app);
    if (!list || !list.isConnected || data.list !== list) return;
    const cols = data.view === 'grid' ? virtualGridColumns(list.clientWidth) : 1;
    const gridResized = data.view === 'grid' && data.columns > 0 && data.columns !== cols;
    const currentlyAtBottom = list.scrollHeight - list.clientHeight - list.scrollTop <= 6;
    // Viewport resize changes clientHeight before ResizeObserver runs, making an
    // otherwise bottom-anchored scroll appear above the bottom. Remember the
    // last position from before the resize instead of relying only on the new
    // clientHeight.
    const nearBottom = gridResized && (currentlyAtBottom || data.atBottom === true);
    const anchorIndex = gridResized ?
      Math.floor(Math.max(0, list.scrollTop - 14) / VIRTUAL_GRID_STEP) * data.columns : 0;
    const gridTotalHeight = 28 + Math.ceil(data.entries.length / cols) * VIRTUAL_GRID_STEP;
    const desiredScrollTop = gridResized ? (nearBottom ?
      Math.max(0, gridTotalHeight - list.clientHeight) :
      (anchorIndex === 0 ? Math.min(list.scrollTop, 14) :
        14 + Math.floor(anchorIndex / cols) * VIRTUAL_GRID_STEP)) : list.scrollTop;
    // Compute the new virtual window from its final scroll position, so a
    // resized grid never renders a stale middle slice for one animation frame.
    const range = virtualWindow(data.entries.length,desiredScrollTop,list.clientHeight,data.view,cols);
    if (!force && data.start === range.start && data.end === range.end &&
        data.columns === cols) {
      data.atBottom = currentlyAtBottom;
      return;
    }
    data.start = range.start;
    data.end = range.end;
    data.columns = cols;
    data.before.style.height = range.before + 'px';
    data.after.style.height = range.after + 'px';
    if (data.view === 'grid') data.body.style.setProperty('--ufs-grid-cols',String(cols));
    const fragment = document.createDocumentFragment();
    for (let i = range.start; i < range.end; i++) {
      fragment.append(createFileRow(data.entries[i],i,data.entries));
    }
    data.body.replaceChildren(fragment);
    if (gridResized) list.scrollTop = desiredScrollTop;
    data.atBottom = list.scrollHeight - list.clientHeight - list.scrollTop <= 6;
    scheduleLocationDisplay();
  }
  function scheduleVirtualWindow() {
    if (!state.virtual || virtualScheduled || destroyed) return;
    virtualScheduled = true;
    requestAnimationFrame(() => {
      virtualScheduled = false;
      updateVirtualWindow();
    });
  }
  function renderFiles(error = '') {
    const list = $('.ufs-list', app);
    state.virtual = null;
    list.replaceChildren();
    list.scrollTop = 0;
    list.scrollLeft = 0;
    list.classList.toggle('ufs-grid', state.view === 'grid');
    list.classList.remove('ufs-virtualized');
    $('.ufs-list-button', app).classList.toggle('ufs-view-active', state.view === 'list');
    $('.ufs-grid-button', app).classList.toggle('ufs-view-active', state.view === 'grid');
    if (state.view === 'list') {
      const head = element('div', 'ufs-head');
      [['name', '名称'], ['size', '大小'], ['mtime', '修改日期'], ['owner', 'OWNER'],
        ['permissions', '权限'], ['locations', 'LOCATION']].forEach(([key, label]) => {
        const className = { mtime: 'ufs-date', owner: 'ufs-owner', permissions: 'ufs-permission',
          locations: 'ufs-location-col' }[key] || '';
        const cell = element('span', className);
        const button = element('button', 'ufs-sort-button');
        button.type = 'button';
        button.append(element('span', '', label));
        if (state.sortKey === key) button.append(element('span', 'ufs-sort-mark', state.sortDirection === 1 ? '↑' : '↓'));
        button.addEventListener('click', () => {
          if (state.sortKey === key) state.sortDirection *= -1;
          else { state.sortKey = key; state.sortDirection = 1; }
          state.lastIndex = -1;
          renderFiles();
        });
        cell.append(button);
        attachColumnResizer(cell, key);
        head.append(cell);
      });
      list.append(head);
    }
    if (error) list.append(element('div', 'ufs-empty ufs-error', error + '。可切换回 Unraid 原生界面检查。'));
    else if (state.busy) list.append(element('div', 'ufs-empty', '正在读取文件…'));
    else {
      const entries = visibleEntries();
      if (!entries.length) list.append(element('div', 'ufs-empty', state.filter ? '没有匹配的文件' : '此文件夹为空'));
      else if (entries.length > VIRTUAL_THRESHOLD) {
        list.classList.add('ufs-virtualized');
        const before = element('div','ufs-virtual-spacer');
        const body = element('div',state.view === 'grid' ?
          'ufs-virtual-body ufs-virtual-grid' : 'ufs-virtual-body');
        const after = element('div','ufs-virtual-spacer');
        list.append(before,body,after);
        state.virtual = {list,view:state.view,entries,before,body,after,
          start:-1,end:-1,columns:0};
        updateVirtualWindow(true);
      } else {
        const fragment = document.createDocumentFragment();
        entries.forEach((entry,index)=>fragment.append(createFileRow(entry,index,entries)));
        list.append(fragment);
      }
    }
    renderSelection();
    scheduleLocationDisplay();
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
    if (currentMenu?._ufsTrigger) currentMenu._ufsTrigger.setAttribute('aria-expanded', 'false');
    if (currentMenu) currentMenu.remove();
    currentMenu = null;
    for (const selector of ['.ufs-more', '.ufs-operations']) {
      const trigger = app && $(selector, app);
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
    }
  }
  async function copyText(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_) { /* Fall back for browser permission or insecure HTTP origin. */ }
    }
    // The Unraid WebGUI is frequently accessed over plain HTTP. execCommand is
    // a best-effort user-gesture fallback, not a server-side clipboard service.
    const textarea = element('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;pointer-events:none';
    document.body.append(textarea);
    try {
      textarea.focus();
      textarea.select();
      return Boolean(document.execCommand('copy'));
    } catch (_) { return false; }
    finally { textarea.remove(); }
  }
  async function copySelectedPaths() {
    const paths = selectedEntries().map((entry) => entry.path);
    if (!paths.length) return notify('请先选择文件或文件夹');
    if (await copyText(paths.join('\n'))) notify('已复制 ' + paths.length + ' 个文件路径');
    else notify('浏览器不允许访问剪贴板，请检查站点权限');
  }
  function showSelectedDetails() {
    if (!selectedEntries().length) return notify('请先选择文件或文件夹');
    if (!state.inspector) {
      state.inspector = true;
      $('.ufs-details-button', app).classList.add('ufs-view-active');
    }
    renderInspector();
  }
  function showFileActionMenu(x, y, entry) {
    closeMenu();
    const chosen = selectedEntries();
    const menu = element('div', 'ufs-menu');
    menu.setAttribute('role', 'menu');
    const actions = [];
    if (entry && chosen.length === 1) {
      actions.push([entry.folder ? '打开文件夹' : '打开 / 下载', () => openEntry(entry)]);
      if (entry.folder) actions.push(['在新标签页中打开', () => addTab(entry.path)]);
    }
    if (chosen.length) {
      if (chosen.length === 1 && !nativeWriteBusy) {
        if (safeWritePath(chosen[0].path) && chosen[0].copyPathVerified !== false) {
          actions.push(['重命名', () => showRenameDialog(chosen[0])]);
        }
        actions.push(['复制到…', () => showCopyDialog(chosen[0]),
          copyBlockedReason(chosen[0])]);
      }
      actions.push(['复制路径（' + chosen.length + ' 项）', copySelectedPaths]);
      if (chosen.length === 1 && !chosen[0].folder)
        actions.push(['下载文件', () => downloadEntry(chosen[0])]);
      actions.push(['属性', showSelectedDetails]);
      actions.push(['取消选择', () => {
        state.selection.clear();
        state.lastIndex = -1;
        renderSelection();
      }]);
    } else {
      actions.push(['刷新当前目录', refreshDirectory]);
    }
    actions.push(['返回原生文件管理器（其他写入操作）', nativeMode]);
    actions.forEach(([label, action, disabledReason]) => {
      const button = element('button', '', label);
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      if (disabledReason) {
        button.disabled = true;
        button.title = disabledReason;
        button.setAttribute('aria-description', disabledReason);
      } else {
        button.addEventListener('click', () => { closeMenu(); action(); });
      }
      menu.append(button);
    });
    app.append(menu);
    menu.style.left = Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8)) + 'px';
    currentMenu = menu;
  }
  function showMenu(x, y, entry) {
    showFileActionMenu(x, y, entry);
  }

  let createFolderBusy = false;
  function showCreateFolderDialog() {
    if (!CREATE_FOLDER_ENABLED || destroyed || !activeTab() || state.busy || createFolderBusy || nativeWriteBusy ||
        $('.ufs-dialog-overlay', app)) return;
    const parent = currentPath();
    if (!safeWritePath(parent, true)) return notify('当前目录不允许新建文件夹');
    const overlay = element('div', 'ufs-dialog-overlay');
    const dialog = element('div', 'ufs-create-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', '新建文件夹');
    const top = element('div', 'ufs-create-head');
    top.append(element('h3', '', '新建文件夹'));
    const dismissButton = element('button', 'ufs-create-dismiss');
    dismissButton.type = 'button';
    dismissButton.title = '关闭';
    dismissButton.setAttribute('aria-label', '关闭新建文件夹窗口');
    dismissButton.append(icon('close'));
    top.append(dismissButton);
    const form = element('form', 'ufs-create-form');
    const fields = element('div', 'ufs-create-fields');
    const locationSection = element('div', 'ufs-create-field');
    locationSection.append(element('label', 'ufs-create-label', '当前位置'));
    locationSection.append(element('div', 'ufs-create-location', parent));
    const nameSection = element('div', 'ufs-create-field');
    const label = element('label', 'ufs-create-label', '文件夹名称');
    const input = element('input', 'ufs-create-input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = '新建文件夹';
    input.maxLength = 255; // UTF-8 byte limit is checked again by planFileOperation.
    input.setAttribute('aria-label', '文件夹名称');
    label.append(input);
    nameSection.append(label);
    const feedback = element('div', 'ufs-create-feedback');
    feedback.setAttribute('role', 'status');
    feedback.textContent = '同名文件夹不会被覆盖';
    nameSection.append(feedback);
    const buttons = element('div', 'ufs-create-buttons');
    const cancel = element('button', 'ufs-create-cancel', '取消');
    cancel.type = 'button';
    const submit = element('button', 'ufs-create-submit', '创建');
    submit.type = 'submit';
    buttons.append(cancel, submit);
    fields.append(locationSection, nameSection);
    form.append(fields, buttons);
    dialog.append(top, form);
    overlay.append(dialog);
    app.append(overlay);
    setupListScrollbars(fields);
    const close = () => { if (!createFolderBusy) overlay.remove(); };
    dismissButton.addEventListener('click', close);
    cancel.addEventListener('click', close);
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !createFolderBusy) { event.stopPropagation(); close(); }
    });
    input.addEventListener('input', () => {
      if (!createFolderBusy) {
        feedback.textContent = '同名文件夹不会被覆盖';
        feedback.classList.remove('ufs-error');
      }
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (createFolderBusy || submit.disabled) return;
      let plan;
      try {
        plan = planFileOperation({ type: 'mkdir', parent, name: input.value });
      } catch (error) {
        feedback.textContent = String(error.message || error);
        feedback.classList.add('ufs-error');
        return;
      }
      createFolderBusy = true;
      input.disabled = true;
      submit.disabled = true;
      cancel.disabled = true;
      dismissButton.disabled = true;
      submit.textContent = '创建中…';
      feedback.classList.remove('ufs-error');
      feedback.textContent = '正在检查目标目录…';
      try {
        await createNativeFolder(plan, message => {
          if (dialog.isConnected && message) feedback.textContent = message;
        });
        if (destroyed) return;
        overlay.remove();
        notify('已创建文件夹：' + plan.name);
        if (currentPath() === parent) await refreshDirectory();
        else state.tree.delete(parent);
      } catch (error) {
        if (destroyed) return;
        feedback.classList.add('ufs-error');
        feedback.textContent = String(error?.message || error);
        // A request which may have been accepted must never be submitted again
        // from this same dialog; ask the user to refresh and inspect first.
        if (feedback.textContent.includes('结果不确定')) {
          submit.textContent = '请刷新后核实';
          submit.disabled = true;
        }
      } finally {
        createFolderBusy = false;
        if (dialog.isConnected) {
          input.disabled = false;
          cancel.disabled = false;
          dismissButton.disabled = false;
          if (submit.textContent !== '请刷新后核实') {
            submit.disabled = false;
            submit.textContent = '创建';
          }
        }
      }
    });
    input.focus();
    input.select();
  }


  function showRenameDialog(entry) {
    if (!RENAME_ENABLED || destroyed || !entry || !activeTab() ||
        state.busy || nativeWriteBusy || $('.ufs-dialog-overlay', app) ||
        !safeWritePath(entry.path) || currentPath() !== parentPath(entry.path)) return;
    const source = entry.path;
    const parent = parentPath(source);
    const overlay = element('div', 'ufs-dialog-overlay');
    const dialog = element('div', 'ufs-create-dialog ufs-rename-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', '重命名');
    const header = element('div', 'ufs-create-head');
    header.append(element('h3', '', '重命名'));
    const dismiss = element('button', 'ufs-create-dismiss ufs-rename-dismiss');
    dismiss.type = 'button';
    dismiss.title = '关闭';
    dismiss.setAttribute('aria-label', '关闭重命名窗口');
    dismiss.append(icon('close'));
    header.append(dismiss);
    const form = element('form', 'ufs-create-form ufs-rename-form');
    const fields = element('div', 'ufs-create-fields');
    const where = element('div', 'ufs-create-field');
    where.append(element('label', 'ufs-create-label', '当前位置'),
      element('div', 'ufs-create-location', parent));
    const original = element('div', 'ufs-create-field');
    original.append(element('label', 'ufs-create-label', '原名称'),
      element('div', 'ufs-rename-original', entry.name));
    const nameField = element('div', 'ufs-create-field');
    const label = element('label', 'ufs-create-label', '新名称');
    const input = element('input', 'ufs-create-input ufs-rename-input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = entry.name;
    input.maxLength = 255;
    input.setAttribute('aria-label', '新名称');
    label.append(input);
    nameField.append(label);
    const feedback = element('div', 'ufs-create-feedback ufs-rename-feedback');
    feedback.setAttribute('role', 'status');
    feedback.textContent = '同名目标不会主动覆盖；并发变化无法完全阻止';
    nameField.append(feedback);
    fields.append(where, original, nameField);
    const buttons = element('div', 'ufs-create-buttons');
    const cancel = element('button', 'ufs-create-cancel ufs-rename-cancel', '取消');
    cancel.type = 'button';
    const submit = element('button', 'ufs-create-submit ufs-rename-submit', '重命名');
    submit.type = 'submit';
    buttons.append(cancel, submit);
    form.append(fields, buttons);
    dialog.append(header, form);
    overlay.append(dialog);
    app.append(overlay);
    setupListScrollbars(fields);
    let busy = false;
    const close = () => { if (!busy) overlay.remove(); };
    dismiss.addEventListener('click', close);
    cancel.addEventListener('click', close);
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !busy) { event.stopPropagation(); close(); }
    });
    input.addEventListener('input', () => {
      if (busy) return;
      feedback.classList.remove('ufs-error');
      feedback.textContent = '同名目标不会主动覆盖；并发变化无法完全阻止';
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (busy || submit.disabled || nativeWriteBusy) return;
      let plan;
      try {
        plan = planFileOperation({type:'rename', source, name: input.value, folder:entry.folder});
      } catch (error) {
        feedback.textContent = String(error?.message || error);
        feedback.classList.add('ufs-error');
        return;
      }
      busy = true;
      input.disabled = true;
      submit.disabled = true;
      cancel.disabled = true;
      dismiss.disabled = true;
      submit.textContent = '重命名中…';
      feedback.classList.remove('ufs-error');
      feedback.textContent = '正在检查文件与目标名称…';
      try {
        await renameNativeEntry(plan, message => {
          if (dialog.isConnected && message) feedback.textContent = message;
        });
        if (destroyed) return;
        overlay.remove();
        applyRenameToBrowser(plan);
        notify('重命名成功：' + plan.name);
      } catch (error) {
        if (destroyed) return;
        feedback.textContent = String(error?.message || error);
        feedback.classList.add('ufs-error');
        if (feedback.textContent.includes('结果不确定')) {
          submit.disabled = true;
          submit.textContent = '请刷新后核实';
        }
      } finally {
        busy = false;
        if (dialog.isConnected) {
          input.disabled = false;
          dismiss.disabled = false;
          cancel.disabled = false;
          if (submit.textContent !== '请刷新后核实') {
            submit.disabled = false;
            submit.textContent = '重命名';
          }
        }
      }
    });
    input.focus();
    input.setSelectionRange(0, renameSelectionEnd(entry.name, entry.folder));
  }


  function showCopyDialog(entry) {
    if (!COPY_ENABLED || destroyed || !entry || !activeTab() || state.busy ||
        nativeWriteBusy || $('.ufs-dialog-overlay', app) ||
        copyBlockedReason(entry) || currentPath() !== parentPath(entry.path)) return;
    const source = entry.path;
    // The menu action may remove the opener before this dialog is constructed.
    // Fall back to the file list when returning focus to a detached opener.
    const opener = document.activeElement;
    const overlay = element('div','ufs-dialog-overlay');
    const dialog = element('div','ufs-create-dialog ufs-copy-dialog');
    dialog.tabIndex = -1;
    dialog.setAttribute('role','dialog');
    dialog.setAttribute('aria-modal','true');
    dialog.setAttribute('aria-label','复制到');
    const header = element('div','ufs-create-head');
    const heading=element('h3','','复制到');
    header.append(heading);
    const dismiss = element('button','ufs-create-dismiss');
    dismiss.type='button';
    dismiss.setAttribute('aria-label','关闭复制窗口');
    dismiss.append(icon('close'));
    header.append(dismiss);
    const form=element('form','ufs-create-form ufs-copy-form');
    const fields=element('div','ufs-create-fields');
    const summary=element('div','ufs-create-field');
    summary.append(element('label','ufs-create-label','已选择'));
    const summaryContent=element('div','ufs-copy-summary');
    summaryContent.append(icon(entry.folder?'folder':'file','ufs-folder-icon'));
    const details=element('div','ufs-copy-summary-info');
    details.append(element('strong','',entry.name));
    details.append(element('span','', (entry.folder?'文件夹':'文件')+' · '+parentPath(source)));
    summaryContent.append(details);
    summary.append(summaryContent);
    const location=element('div','ufs-create-field');
    location.append(element('label','ufs-create-label','目标位置'));
    const picker=element('div','ufs-copy-picker');
    picker.setAttribute('role','tree');
    picker.setAttribute('aria-label','选择复制目标文件夹');
    const destinationText=element('div','ufs-copy-destination','请选择目标文件夹');
    location.append(picker,destinationText);
    const feedback=element('div','ufs-create-feedback ufs-copy-feedback',
      '已存在同名项目时拒绝复制；不允许将文件夹复制到自身内部');
    feedback.setAttribute('role','status');
    location.append(feedback);
    fields.append(summary,location);
    // Prepared once; shown in place of the picker only after the user submits.
    // This is an indeterminate animation, never a synthetic percentage.
    const progressPanel=element('div','ufs-copy-progress-panel');
    progressPanel.dataset.phase='checking';
    progressPanel.dataset.progressMode='indeterminate';
    progressPanel.append(element('label','ufs-create-label','复制到'));
    const progressTarget=element('div','ufs-copy-progress-target');
    progressTarget.append(icon('folder','ufs-folder-icon'));
    const progressTargetPath=element('span','ufs-copy-progress-target-text');
    progressTarget.append(progressTargetPath);
    progressPanel.append(progressTarget);
    const progressStatus=element('div','ufs-copy-progress-status');
    const progressState=element('div','ufs-copy-progress-state');
    const progressSpinner=element('span','ufs-copy-progress-spinner');
    progressSpinner.setAttribute('aria-hidden','true');
    const progressStateText=element('span','ufs-copy-progress-state-text','正在检查目标…');
    progressState.append(progressSpinner,progressStateText);
    const progressIndicator=element('span','ufs-copy-progress-indicator','准备中');
    progressStatus.append(progressState,progressIndicator);
    progressPanel.append(progressStatus);
    const track=element('div','ufs-copy-progress-track');
    track.setAttribute('role','progressbar');
    track.setAttribute('aria-label','复制任务进行中，进度未知');
    // No aria-valuenow or made-up percentage: rsync does not reliably provide it.
    const fill=element('div','ufs-copy-progress-fill');
    track.append(fill);
    progressPanel.append(track);
    const progressStages=element('div','ufs-copy-progress-stages');
    const stages=[
      ['checking','目标检查'],['copying','文件复制'],['verifying','完成核对']
    ];
    const stageNodes=stages.map(([phase,title])=>{
      const node=element('span','ufs-copy-progress-stage','○ '+title);
      node.dataset.step=phase;
      progressStages.append(node);
      return node;
    });
    progressPanel.append(progressStages);
    const progressFile=element('div','ufs-copy-current-file');
    const progressMetrics=element('div','ufs-copy-progress-metrics');
    progressPanel.append(progressFile,progressMetrics);
    const progressNote=element('div','ufs-copy-progress-note');
    progressNote.setAttribute('role','status');
    progressNote.setAttribute('aria-live','polite');
    progressPanel.append(progressNote);
    let visibleCopyPhase='checking';
    function renderCopyProgress(phase,message='') {
      visibleCopyPhase=phase;
      progressPanel.dataset.phase=phase;
      const stageIndex=stages.findIndex(([key])=>key===phase);
      stageNodes.forEach((node,index)=>{
        const state=phase==='success'?'done':phase==='uncertain'
          ?(index<lastActiveCopyStep?'done':index===lastActiveCopyStep?'error':'pending')
          :(index<stageIndex?'done':index===stageIndex?'active':'pending');
        node.dataset.status=state;
        node.textContent=(state==='done'?'✓ ':state==='active'?'● ':state==='error'?'! ':'○ ')+stages[index][1];
      });
      const labels={
        checking:['正在检查目标…','准备中','正在检查源文件和目标目录…'],
        copying:['正在复制文件…','进行中','正在等待 Unraid 完成文件操作，请勿关闭页面。'],
        verifying:['正在核对复制结果…','核对中','正在检查目标目录和复制结果…'],
        success:['复制完成','已完成','复制结果已核对，窗口即将关闭。'],
        uncertain:['无法确认复制结果','需核实','结果不确定，请检查目标目录及原生任务状态，切勿直接重试。']
      };
      const info=labels[phase] || labels.checking;
      progressStateText.textContent=info[0];
      progressIndicator.textContent=info[1];
      progressNote.textContent=message || info[2];
      track.setAttribute('aria-label',phase==='success'?'复制完成':
        phase==='uncertain'?'复制结果无法确认':'复制任务进行中，进度未知');
      if(phase==='success') {fill.style.width='100%';track.setAttribute('aria-valuenow','100');}
      if(phase==='uncertain' || phase==='cancelled') {fill.style.animation='none';}
      if(phase==='checking') {progressPanel.dataset.progressMode='indeterminate';fill.style.width='35%';fill.style.animation='';track.removeAttribute('aria-valuenow');}
    }
    let lastActiveCopyStep=0;
    function updateCopyProgress(message,phase,info) {
      if(closed || destroyed) return;
      if(phase) {
        const next=stages.findIndex(([key])=>key===phase);
        if(next>=0) lastActiveCopyStep=Math.max(lastActiveCopyStep,next);
        renderCopyProgress(phase);
      } else if(visibleCopyPhase==='copying' && message) {
        if(info?.filename) {
          const current=info.filename.trim().replace(/\/$/,'');
          progressFile.textContent='当前文件：'+shortenCopyName(current.split('/').pop()||current,90);
          progressFile.title=current;
        }
        if(info?.percent!=null) {
          progressPanel.dataset.progressMode='determinate';
          fill.style.animation='none';
          fill.style.width=info.percent+'%';
          track.setAttribute('aria-valuenow',String(info.percent));
          track.setAttribute('aria-label','复制进度 '+info.percent+'%');
          progressIndicator.textContent=info.percent+'%';
          progressMetrics.textContent=[info.transferred?'已传输 '+info.transferred:(info.bytes!=null?info.bytes.toLocaleString()+' 字节':''),info.speed,info.eta?'剩余 '+info.eta:''].filter(Boolean).join(' · ');
        }
        // Do not dump full rsync paths and octal bytes into a multi-line panel.
        progressNote.textContent='正在复制，请保持此页面打开。';
      }
    }
    const footer=element('div','ufs-create-buttons');
    const cancel=element('button','ufs-create-cancel ufs-copy-cancel','取消');
    cancel.type='button';
    const background=element('button','ufs-copy-background','后台运行');
    background.type='button';
    background.hidden=true;
    const submit=element('button','ufs-create-submit ufs-copy-submit','开始复制');
    submit.type='submit';
    submit.disabled=true;
    footer.append(background,cancel,submit);
    form.append(fields,footer);
    dialog.append(header,form);
    overlay.append(dialog);
    app.append(overlay);
    setupListScrollbars(fields);
    setupListScrollbars(picker);
    const focusDialog = () => {
      if (!destroyed && dialog.isConnected) dialog.focus({preventScroll:true});
    };
    const restoreFocus = (preferred) => {
      if (destroyed) return;
      const target = preferred?.isConnected && app.contains(preferred) ? preferred
        : opener?.isConnected && app.contains(opener) ? opener : $('.ufs-list', app);
      if (target?.isConnected) target.focus({preventScroll:true});
    };
    // Unlike create/rename there is no text input to focus automatically.
    focusDialog();
    let busy=false, closed=false, selected=null, requestVersion=0;
    let finalPhase='picker', cancelSubmitting=false;
    let control={cancelRequested:false,observedOwnTask:false};
    const nodes=new Map();
    const opened=new Set([PREFIX]);
    const pending=new Map();
    let inlineDraft=null;
    let mkdirUncertain=false;
    const close=()=>{
      if(inlineDraft?.busy) return;
      if(busy) {minimize();return;}
      closed=true; ++requestVersion;
      overlay.remove();
      if(activeCopySession?.dialog===dialog) {
        activeCopySession=null;
        updateCopyTaskButton();
      }
      restoreFocus();
    };
    const minimize=()=>{
      if(!busy || closed) return;
      overlay.remove();
      updateCopyTaskButton();
      restoreFocus($('.ufs-copy-task-trigger',app));
      notify('复制继续在当前页面运行；点击「复制任务进行中」可查看。请勿刷新页面。');
    };
    const reopen=()=>{
      if(closed || destroyed || $('.ufs-dialog-overlay',app)) return;
      app.append(overlay);
      updateCopyTaskButton();
      focusDialog();
    };
    dismiss.addEventListener('click',close);
    background.addEventListener('click',minimize);
    cancel.addEventListener('click',()=>{
      if(!busy || finalPhase==='success' || finalPhase==='uncertain' ||
          finalPhase==='cancelled') {close();return;}
      if(finalPhase==='cancelling') {minimize();return;}
      if(finalPhase!=='copying' || cancelSubmitting || control.cancelRequested) return;
      if(!control.observedOwnTask) {
        progressNote.textContent='原生任务归属尚未确认，暂时无法安全停止。可选择后台运行。';
        return;
      }
      const yes=window.confirm(
        '确定停止此次复制吗？\n\n取消可能留下不完整的文件或文件夹，需要手动检查目标目录。\n'+
        'Unraid 使用全局停止接口；即使已经检查任务归属，并发任务切换仍有误停风险。\n\n确定继续？'
      );
      if(!yes) return;
      cancelSubmitting=true;
      finalPhase='cancelling';
      cancel.disabled=true;
      cancel.textContent='正在停止…';
      void requestCancelNativeCopy(activeCopySession.plan,control).then(()=>{
        renderCopyProgress('uncertain','已发送停止指令，正在等待 Unraid 确认；请勿直接重试。');
        heading.textContent='正在停止复制';
      }).catch(error=>{
        if(!closed && !destroyed) {
          renderCopyProgress('uncertain',String(error?.message||error));
          heading.textContent='取消结果待核实';
        }
      }).finally(()=>{
        cancelSubmitting=false;
        // Do not offer a second kill request while the first is in flight.
        if(!closed) {cancel.disabled=false;cancel.textContent='后台运行';}
      });
    });
    overlay.addEventListener('click',event=>{if(event.target===overlay) close();});
    dialog.addEventListener('keydown',event=>{
      if(event.key!=='Escape') return;
      event.preventDefault();
      event.stopPropagation();
      // Inline mkdir is an editor inside the dialog: first Esc cancels that
      // editor, while the next Esc dismisses the copy picker.
      if(inlineDraft && !inlineDraft.busy) {cancelInlineCreate();return;}
      close(); // During an active copy this minimizes; it never sends action=99.
    });
    const setFeedback=(message,isError=false)=>{
      if(closed || !dialog.isConnected) return;
      feedback.textContent=message;
      feedback.classList.toggle('ufs-error',isError);
    };
    function renderPicker() {
      if(closed || !dialog.isConnected) return;
      // The picker is reconstructed during lazy directory reads. Restore a
      // live inline editor's caret rather than losing focus mid-typing.
      const restoreFocus=inlineDraft && !inlineDraft.busy &&
        document.activeElement===inlineDraft.input;
      const start=restoreFocus?inlineDraft.input.selectionStart:0;
      const end=restoreFocus?inlineDraft.input.selectionEnd:0;
      picker.replaceChildren();
      const root=element('div','ufs-copy-tree-group','共享文件夹');
      picker.append(root);
      function renderChildren(parent,depth) {
        const children=nodes.get(parent);
        if(!children) {
          const status=element('div','ufs-copy-tree-status',
            pending.has(parent)?'正在读取文件夹…':'尚未读取');
          status.style.paddingLeft=(12+depth*15)+'px';
          picker.append(status);
          return;
        }
        if(children.length===0 && inlineDraft?.parent!==parent) {
          const empty=element('div','ufs-copy-tree-status','没有子文件夹');
          empty.style.paddingLeft=(12+depth*15)+'px';
          picker.append(empty);
        }
        for(const item of children) {
          const path=item.path;
          const permitted=copyDestinationAllowed({source,folder:entry.folder},path);
          const row=element('div','ufs-copy-tree-row');
          row.style.paddingLeft=(5+depth*15)+'px';
          row.setAttribute('role','treeitem');
          row.setAttribute('aria-selected',String(selected===path));
          row.classList.toggle('ufs-copy-selected',selected===path);
          const expand=element('button','ufs-copy-expand');
          expand.type='button';
          expand.setAttribute('aria-label',(opened.has(path)?'折叠 ':'展开 ')+item.name);
          expand.append(icon(opened.has(path)?'chevron-down':'chevron-right'));
          expand.addEventListener('click',()=>{
            if(busy || inlineDraft || mkdirUncertain) return;
            if(opened.has(path)) {opened.delete(path);renderPicker();}
            else {opened.add(path);renderPicker();void loadChildren(path);}
          });
          const choose=element('button','ufs-copy-choose');
          choose.type='button';
          choose.disabled=!permitted || busy || !!inlineDraft || mkdirUncertain;
          choose.setAttribute('aria-label','选择 '+item.name);
          choose.append(icon(opened.has(path)?'folder-open':'folder','ufs-folder-icon'),
            element('span','',item.name));
          choose.addEventListener('click',()=>{
            if(busy || inlineDraft || mkdirUncertain || !permitted) return;
            selected=path;
            destinationText.textContent='目标：'+path;
            submit.disabled=!!inlineDraft || mkdirUncertain;
            // Choosing a destination also expands it. Clicking an already
            // expanded folder keeps it open; only the arrow can collapse it.
            opened.add(path);
            renderPicker();
            void loadChildren(path);
          });
          const mkdir=element('button','ufs-copy-mkdir-trigger');
          mkdir.type='button';
          mkdir.setAttribute('aria-label','在 '+item.name+' 下新建文件夹');
          mkdir.title='在此文件夹中新建文件夹';
          mkdir.disabled=busy || nativeWriteBusy || !!inlineDraft || mkdirUncertain ||
            !safeWritePath(path,true);
          mkdir.append(icon('folder-plus'));
          mkdir.addEventListener('click',event=>{
            event.stopPropagation();
            beginInlineCreate(path);
          });
          row.append(expand,choose,mkdir);
          picker.append(row);
          if(opened.has(path)) {
            if(inlineDraft?.parent===path) {
              inlineDraft.row.style.paddingLeft=(5+(depth+1)*15)+'px';
              picker.append(inlineDraft.row);
              if(inlineDraft.message.textContent) {
                inlineDraft.message.style.paddingLeft=(31+(depth+1)*15)+'px';
                picker.append(inlineDraft.message);
              }
            }
            renderChildren(path,depth+1);
          }
        }
      }
      renderChildren(PREFIX,0);
      if(restoreFocus && inlineDraft?.input.isConnected) {
        inlineDraft.input.focus();
        inlineDraft.input.setSelectionRange(start,end);
      }
    }
    async function loadChildren(path) {
      if(nodes.has(path) || pending.has(path) || closed) return pending.get(path);
      const request=requestVersion;
      const task=(async()=>{
        try {
          const entries=await listDirectory(path);
          if(closed || request!==requestVersion) return;
          nodes.set(path, sortedCopyFolders(path, entries));
          setFeedback('已存在同名项目时拒绝复制；不允许将文件夹复制到自身内部');
        } catch(error) {
          if(closed || request!==requestVersion) return;
          opened.delete(path);
          setFeedback('无法读取目标文件夹：'+String(error?.message||error),true);
        } finally {
          if(pending.get(path)===task) pending.delete(path);
          renderPicker();
        }
      })();
      pending.set(path,task);
      renderPicker();
      return task;
    }

    function cancelInlineCreate() {
      if(!inlineDraft || inlineDraft.busy) return;
      inlineDraft=null;
      delete dialog.dataset.inlineMkdir;
      submit.disabled=!selected || mkdirUncertain;
      if(mkdirUncertain) setFeedback('新建结果不确定，请刷新页面并检查目录后再操作。',true);
      renderPicker();
      focusDialog();
    }
    function beginInlineCreate(parent) {
      if(closed || busy || inlineDraft || nativeWriteBusy || mkdirUncertain ||
          !safeWritePath(parent,true)) return;
      const row=element('div','ufs-copy-inline-row');
      row.setAttribute('role','group');
      row.setAttribute('aria-label','在 '+fileName(parent)+' 下新建文件夹');
      row.append(icon('folder','ufs-folder-icon'));
      const input=element('input','ufs-copy-inline-input');
      input.type='text';
      input.value='新建文件夹';
      input.maxLength=255;
      input.autocomplete='off';
      input.spellcheck=false;
      input.setAttribute('aria-label','新文件夹名称');
      const cancelButton=element('button','ufs-copy-inline-action ufs-copy-inline-cancel');
      cancelButton.type='button';
      cancelButton.setAttribute('aria-label','取消新建文件夹');
      cancelButton.title='取消';
      cancelButton.append(icon('close'));
      const confirmButton=element('button','ufs-copy-inline-action ufs-copy-inline-confirm');
      confirmButton.type='button';
      confirmButton.setAttribute('aria-label','确认新建文件夹');
      confirmButton.title='创建';
      confirmButton.append(icon('check'));
      const message=element('div','ufs-copy-inline-error');
      message.setAttribute('role','status');
      row.append(input,cancelButton,confirmButton);
      inlineDraft={parent,row,input,message,cancelButton,confirmButton,busy:false,uncertain:false};
      dialog.dataset.inlineMkdir='active';
      opened.add(parent);
      submit.disabled=true;
      cancelButton.addEventListener('click',cancelInlineCreate);
      confirmButton.addEventListener('click',()=>{void confirmInlineCreate();});
      input.addEventListener('input',()=>{
        if(inlineDraft?.input===input && !inlineDraft.busy) {
          message.textContent='';
          message.dataset.error='false';
          if(message.isConnected) message.remove();
        }
      });
      input.addEventListener('keydown',event=>{
        if(event.key==='Escape') {
          event.preventDefault();
          event.stopPropagation();
          cancelInlineCreate();
        } else if(event.key==='Enter') {
          event.preventDefault();
          event.stopPropagation();
          if(!event.isComposing && event.keyCode!==229) void confirmInlineCreate();
        }
      });
      renderPicker();
      input.focus();
      input.select();
      void loadChildren(parent);
    }
    async function confirmInlineCreate() {
      const draft=inlineDraft;
      if(!draft || draft.busy || draft.uncertain || busy || nativeWriteBusy || closed) return;
      let plan;
      try {
        plan=planFileOperation({type:'mkdir',parent:draft.parent,name:draft.input.value});
      } catch(error) {
        draft.message.textContent=String(error?.message||error);
        draft.message.dataset.error='true';
        renderPicker();
        return;
      }
      draft.busy=true;
      draft.input.disabled=true;
      draft.cancelButton.disabled=true;
      draft.confirmButton.disabled=true;
      submit.disabled=true;
      draft.message.textContent='正在创建文件夹…';
      draft.message.dataset.error='false';
      renderPicker();
      try {
        const created=await createNativeFolder(plan,text=>{
          if(!closed && !destroyed && inlineDraft===draft && text) {
            draft.message.textContent=text;
            draft.message.dataset.error='false';
            if(!draft.message.isConnected) renderPicker();
          }
        });
        if(closed || destroyed || inlineDraft!==draft) return;
        // Invalidate stale lazy-load responses before updating the parent.
        ++requestVersion;
        pending.clear();
        const previous=nodes.get(draft.parent)||[];
        nodes.set(draft.parent, sortedCopyFolders(draft.parent,
          [...previous.filter(node=>node.path!==created.path),created]));
        nodes.set(created.path,[]);
        opened.add(draft.parent);
        opened.add(created.path);
        selected=created.path;
        destinationText.textContent='目标：'+created.path;
        inlineDraft=null;
        delete dialog.dataset.inlineMkdir;
        submit.disabled=false;
        setFeedback('已创建并选中新文件夹：'+created.name);
        state.tree.delete(draft.parent);
        renderPicker();
        if(currentPath()===draft.parent) void refreshDirectory();
        // Re-read the parent's actual children, not a stale in-memory list.
        // If it fails, keep the already server-verified created directory.
        const epoch=requestVersion;
        try {
          const children=await listDirectory(draft.parent);
          if(!closed && !destroyed && epoch===requestVersion) {
            nodes.set(draft.parent, sortedCopyFolders(draft.parent, children));
            renderPicker();
          }
        } catch(_) {
          if(!closed && !destroyed) {
            setFeedback('文件夹已创建并选中，但目录列表刷新失败，可重新展开后检查。',true);
          }
        }
      } catch(error) {
        if(closed || destroyed || inlineDraft!==draft) return;
        const text=String(error?.message||error);
        draft.message.textContent=text;
        draft.message.dataset.error='true';
        if(text.includes('结果不确定')) {
          draft.uncertain=true;
          mkdirUncertain=true;
          draft.confirmButton.disabled=true;
          draft.input.disabled=true;
          // This modal cannot issue another write until the user rechecks NAS.
          setFeedback('创建结果不确定，请刷新目录核实后再操作。',true);
        }
        renderPicker();
      } finally {
        draft.busy=false;
        if(inlineDraft===draft && !closed) {
          draft.input.disabled=draft.uncertain;
          draft.cancelButton.disabled=false;
          draft.confirmButton.disabled=draft.uncertain;
          renderPicker();
        }
      }
    }
    form.addEventListener('submit',async event=>{
      event.preventDefault();
      if(finalPhase==='success') {close();return;}
      if(busy || inlineDraft || mkdirUncertain || submit.disabled || !selected || nativeWriteBusy) return;
      let plan;
      try {
        plan=planFileOperation({type:'copy',source,destinationDir:selected,folder:entry.folder});
        if(!copyDestinationAllowed(plan,selected)) throw new Error('不能选择源位置或文件夹自身内部');
      } catch(error) {
        setFeedback(String(error?.message||error),true);
        return;
      }
      busy=true;
      finalPhase='copying';
      activeCopySession={dialog,plan,phase:'copying',reopen};
      updateCopyTaskButton();
      submit.disabled=true;
      cancel.disabled=false;
      cancel.textContent='取消复制';
      background.hidden=false;
      dismiss.disabled=false;
      dismiss.title='后台运行';
      submit.textContent='复制中…';
      progressTargetPath.textContent=plan.destinationDir;
      heading.textContent='正在复制';
      lastActiveCopyStep=0;
      fields.replaceChildren(summary,progressPanel);
      // The selected folder button was removed; keep Esc available while
      // the native copy task runs and the modal switches to progress.
      focusDialog();
      renderCopyProgress('checking');
      try {
        await copyNativeEntry(plan,updateCopyProgress,control);
        if(closed || destroyed) return;
        finalPhase='success';
        heading.textContent='复制完成';
        renderCopyProgress('success');
        activeCopySession.phase='success';
        updateCopyTaskButton();
        submit.textContent='完成';
        submit.disabled=false;
        cancel.hidden=true;
        background.hidden=true;
        dismiss.title='关闭';
        state.tree.delete(plan.destinationDir);
        if(currentPath()===plan.destinationDir) await refreshDirectory();
        else if(state.expanded.has(plan.destinationDir)) void loadTree(plan.destinationDir,true);
        notify('复制完成：'+fileName(plan.target)+'；点击「完成」关闭结果');
      } catch(error) {
        if(closed || destroyed) return;
        const message=String(error?.message||error);
        if(message.includes('结果不确定') || control.cancelRequested || message.includes('已请求取消')) {
          finalPhase=control.cancelRequested?'cancelled':'uncertain';
          heading.textContent=control.cancelRequested?'复制已请求停止':'复制结果待核实';
          renderCopyProgress('uncertain',message);
          activeCopySession.phase=finalPhase;
          updateCopyTaskButton();
          submit.textContent='请核实复制状态';
          submit.disabled=true;
          cancel.textContent='关闭';
          background.hidden=true;
          dismiss.title='关闭';
        } else {
          // Preflight failures happened without a native write. Let the user
          // choose another destination and retry from the original picker.
          heading.textContent='复制到';
          finalPhase='picker';
          activeCopySession=null;
          updateCopyTaskButton();
          background.hidden=true;
          cancel.textContent='取消';
          fields.replaceChildren(summary,location);
          setFeedback(message,true);
        }
      } finally {
        busy=false;
        if(dialog.isConnected) {
          cancel.disabled=false;
          dismiss.disabled=false;
          if(finalPhase==='picker') {
            submit.textContent='开始复制';
            submit.disabled=!selected;
          } else if(finalPhase==='success') {
            submit.textContent='完成';
            submit.disabled=false;
          }
          if(fields.contains(location)) renderPicker();
        }
      }
    });
    void loadChildren(PREFIX);
  }

  function showOperationsMenu() {
    const trigger = $('.ufs-operations', app);
    if (currentMenu && trigger.getAttribute('aria-expanded') === 'true') {
      closeMenu();
      return;
    }
    const rect = trigger.getBoundingClientRect();
    showFileActionMenu(rect.left, rect.bottom + 4, null);
    trigger.setAttribute('aria-expanded', 'true');
  }
  function showLocationPopover(trigger, names) {
    if (currentMenu && currentMenu.classList.contains('ufs-location-popover') &&
        currentMenu._ufsTrigger === trigger) {
      closeMenu();
      return;
    }
    closeMenu();
    const popup = element('div', 'ufs-menu ufs-location-popover');
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-label', '完整存储位置列表');
    const header = element('div', 'ufs-location-popover-header');
    header.append(element('span', '', '存储位置（' + names.length + '）'));
    const close = element('button', 'ufs-location-popover-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭位置列表');
    close.addEventListener('click', (event) => { event.stopPropagation(); closeMenu(); });
    header.append(close);
    const items = element('div', 'ufs-location-popover-items');
    names.forEach((name) => items.append(element('span', 'ufs-location-device', name)));
    const copy = element('button', 'ufs-location-copy', '复制位置');
    copy.type = 'button';
    copy.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (await copyText(names.join(', '))) notify('已复制 ' + names.length + ' 个存储位置');
      else notify('无法访问剪贴板，请检查浏览器权限');
    });
    header.insertBefore(copy, close);
    popup.append(header, items);
    // Reuse the same outside-click and Escape handling as the file action menu.
    popup._ufsTrigger = trigger;
    app.append(popup);
    const rect = trigger.getBoundingClientRect();
    popup.style.left = Math.max(8, Math.min(rect.left, innerWidth - popup.offsetWidth - 8)) + 'px';
    const below = rect.bottom + 6;
    popup.style.top = (below + popup.offsetHeight > innerHeight - 8 ?
      Math.max(8, rect.top - popup.offsetHeight - 6) : below) + 'px';
    currentMenu = popup;
    trigger.setAttribute('aria-expanded', 'true');
  }
  function showAppMenu() {
    const trigger = $('.ufs-more', app);
    if (currentMenu && trigger.getAttribute('aria-expanded') === 'true') {
      closeMenu();
      return;
    }
    closeMenu();
    const menu = element('div', 'ufs-menu');
    menu.setAttribute('role', 'menu');
    const actions = [
      ['重置文件列表列宽', resetColumnWidths],
      ['返回原生文件管理器（其他写入操作）', nativeMode],
      [state.theme === 'unraid' ? '切换至 DSM 经典主题' : '切换至 Unraid 融合主题', toggleTheme],
      ['关于 File Station v0.2.3.8', () => notify('File Station v0.2.3.8 · Unraid 7.2.2 · 修复选中背景叠加与文件夹加号图标')]
    ];
    actions.forEach(([label, fn]) => {
      const button = element('button', '', label);
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.addEventListener('click', () => { closeMenu(); fn(); });
      menu.append(button);
    });
    const rect = trigger.getBoundingClientRect();
    app.append(menu);
    menu.style.left = Math.max(8, Math.min(rect.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(rect.bottom + 5, innerHeight - menu.offsetHeight - 8)) + 'px';
    currentMenu = menu;
    trigger.setAttribute('aria-expanded', 'true');
  }
  function renderHeaderMarkup() {
    return [
      '<div class="ufs-top">',
      '<div class="ufs-brand"><span data-ufs-icon="folder-open" class="ufs-mark"></span><span class="ufs-heading">File Station</span></div>',
      '<span class="ufs-brand-divider" aria-hidden="true"></span>',
      '<div class="ufs-tabs" aria-label="目录标签页"></div>',
      '<div class="ufs-app-actions"><span class="ufs-preview-chip">文件操作可用</span>',
      '<button type="button" class="ufs-ico ufs-refresh" title="刷新目录" aria-label="刷新目录"><span data-ufs-icon="refresh"></span></button>',
      '<button type="button" class="ufs-ico ufs-more" title="更多选项" aria-label="更多选项" aria-haspopup="menu" aria-expanded="false"><span data-ufs-icon="more"></span></button>',
      '</div></div>'
    ].join('');
  }
  function renderBrowserBarMarkup() {
    return [
      '<div class="ufs-navigation" role="toolbar" aria-label="目录导航">',
      '<button type="button" class="ufs-ico ufs-back" title="后退" aria-label="后退"><span data-ufs-icon="arrow-left"></span></button>',
      '<button type="button" class="ufs-ico ufs-next" title="前进" aria-label="前进"><span data-ufs-icon="arrow-right"></span></button>',
      '<button type="button" class="ufs-ico ufs-up" title="上一级" aria-label="上一级"><span data-ufs-icon="arrow-up"></span></button>',
      '<div class="ufs-address" aria-label="当前位置"></div>',
      '<div class="ufs-search-wrap"><button type="button" class="ufs-ico ufs-search-trigger" title="筛选当前目录" aria-label="筛选当前目录" aria-expanded="false"><span data-ufs-icon="search"></span></button>',
      '<input class="ufs-search" type="search" placeholder="筛选当前目录" aria-label="筛选当前目录" hidden></div>',
      '</div>'
    ].join('');
  }
  function renderFileActionsMarkup() {
    return [
      '<div class="ufs-file-actions" role="toolbar" aria-label="文件内容和视图">',
      '<span class="ufs-section-label">文件</span>',
      '<button type="button" class="ufs-ico ufs-create-trigger" title="新建文件夹" aria-label="新建文件夹">新建文件夹</button>',
       '<button type="button" class="ufs-ico ufs-operations" title="文件操作" aria-label="文件操作" aria-haspopup="menu" aria-expanded="false">操作 <span data-ufs-icon="chevron-down"></span></button>',
       '<button type="button" class="ufs-ico ufs-copy-task-trigger" title="查看复制任务" hidden>复制任务进行中</button>',
      '<span class="ufs-spacer"></span>',
      '<div class="ufs-view-controls" role="group" aria-label="文件视图">',
      '<button type="button" class="ufs-ico ufs-list-button" title="列表视图" aria-label="列表视图"><span data-ufs-icon="list"></span></button>',
      '<button type="button" class="ufs-ico ufs-grid-button" title="网格视图" aria-label="网格视图"><span data-ufs-icon="grid"></span></button>',
      '<button type="button" class="ufs-ico ufs-details-button" title="详细信息" aria-label="详细信息"><span data-ufs-icon="panel"></span></button>',
      '</div></div>'
    ].join('');
  }
  function renderWorkspaceMarkup() {
    return [
      '<div class="ufs-workspace">',
      '<aside class="ufs-sidebar"><div class="ufs-tree"></div></aside>',
      '<div class="ufs-resizer" role="separator" aria-label="调整目录树宽度" aria-orientation="vertical"></div>',
      '<main class="ufs-main">',
      renderBrowserBarMarkup(),
      renderFileActionsMarkup(),
      '<div class="ufs-content">',
      '<div class="ufs-list" tabindex="0"></div>',
      '<aside class="ufs-inspector" hidden></aside>',
      '</div></main></div>'
    ].join('');
  }
  function renderUI() {
    app = element('section');
    app.id = 'ufs-app';
    app.className = state.theme === 'dsm' ? 'ufs-dsm' : '';
    app.setAttribute('aria-label', 'Unraid File Station');
    applyColumnLayout();
    app.innerHTML = [
      renderHeaderMarkup(),
      renderWorkspaceMarkup(),
      '<div class="ufs-status"><span class="ufs-count">准备就绪</span>',
      '<span>支持新建文件夹、重命名、复制 · 其他写入请使用原生文件管理器</span></div>'
    ].join('');
    $$('[data-ufs-icon]', app).forEach((placeholder) => {
      placeholder.replaceWith(icon(placeholder.dataset.ufsIcon,
        placeholder.classList.contains('ufs-mark') ? 'ufs-mark' : ''));
    });
    $('.ufs-refresh', app).addEventListener('click', refreshDirectory);
    $('.ufs-more', app).addEventListener('click', showAppMenu);
    $('.ufs-copy-task-trigger', app).addEventListener('click', () => {
      if (activeCopySession && !$('.ufs-dialog-overlay',app)) activeCopySession.reopen();
    });
    updateCopyTaskButton();
    // Only create-folder is writable in v0.2.1; other native actions remain disabled.
    $('.ufs-back', app).addEventListener('click', () => stepHistory(-1));
    $('.ufs-next', app).addEventListener('click', () => stepHistory(1));
    $('.ufs-up', app).addEventListener('click', () => {
      if (!activeTab() || isShareRoot(currentPath())) return;
      navigate(currentPath().split('/').slice(0, -1).join('/') || PREFIX);
    });
    $('.ufs-search-trigger', app).addEventListener('click', () => setSearchOpen(!state.searchOpen));
    $('.ufs-search', app).addEventListener('input', (event) => { state.filter = event.target.value; renderFiles(); });
    $('.ufs-search', app).addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); setSearchOpen(false); $('.ufs-search-trigger', app).focus(); }
    });
    $('.ufs-list-button', app).addEventListener('click', () => setView('list'));
    $('.ufs-grid-button', app).addEventListener('click', () => setView('grid'));
    function showDetails() {
      state.inspector = !state.inspector;
      $('.ufs-details-button', app).classList.toggle('ufs-view-active', state.inspector);
      renderInspector();
    }
    $('.ufs-details-button', app).addEventListener('click', (event) => {
      showDetails();
      if (event.detail > 0) event.currentTarget.blur(); // pointer click only; keyboard focus stays visible
    });
    $('.ufs-operations', app).addEventListener('click', showOperationsMenu);
    $('.ufs-create-trigger', app).addEventListener('click', () => {
      closeMenu();
      showCreateFolderDialog();
    });
    setupSidebarResizer();
    onCleanup(setupListScrollbars($('.ufs-list', app)));
    $('.ufs-list', app).addEventListener('scroll', scheduleVirtualWindow, {passive:true});
    if (typeof ResizeObserver !== 'undefined') {
      const locationObserver = new ResizeObserver(() => { scheduleLocationDisplay(); scheduleVirtualWindow(); });
      locationObserver.observe($('.ufs-list', app));
      onCleanup(() => locationObserver.disconnect());
    }
    $('.ufs-list', app).addEventListener('click', (event) => {
      // Clicking on blank space clears selection, but clicking headers/entries does not.
      if (event.target === $('.ufs-list', app) || event.target.classList.contains('ufs-empty')) {
        state.selection.clear();
        state.lastIndex = -1;
        renderSelection();
      }
    });
    $('.ufs-list', app).addEventListener('contextmenu', (event) => {
      if (event.target === $('.ufs-list', app)) {
        event.preventDefault();
        showMenu(event.clientX, event.clientY, { path: currentPath(), name: '', folder: true });
      }
    });
    document.addEventListener('pointerdown', (event) => {
      if (destroyed || !app.isConnected) return;
      const more = $('.ufs-more', app);
      const operations = $('.ufs-operations', app);
      const currentTrigger = currentMenu && currentMenu._ufsTrigger;
      if (currentMenu && !currentMenu.contains(event.target) &&
          !(more && more.contains(event.target)) &&
          !(operations && operations.contains(event.target)) &&
          !(currentTrigger && currentTrigger.contains(event.target))) closeMenu();
    }, { signal: lifecycle.signal });
    document.addEventListener('keydown', (event) => {
      if (destroyed || !app.isConnected || !app.contains(event.target)) return;
      if (event.target.closest('input,textarea,[contenteditable]')) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        visibleEntries().forEach((entry) => state.selection.add(entry.path));
        renderSelection();
      }
      if (event.key === 'Escape') { closeMenu(); state.selection.clear(); renderSelection(); }
      if (event.key === 'F2' && !event.ctrlKey && !event.metaKey && !event.altKey &&
          !nativeWriteBusy && !state.busy && !$('.ufs-dialog-overlay', app)) {
        const selected = selectedEntries();
        if (selected.length === 1 && safeWritePath(selected[0].path)) {
          event.preventDefault();
          showRenameDialog(selected[0]);
        }
      }
      if (event.key === 'Backspace' && !event.metaKey && !event.ctrlKey && activeTab()) { event.preventDefault(); stepHistory(-1); }
    }, { signal: lifecycle.signal });
    window.addEventListener('popstate', (event) => {
      if (!app.isConnected || isDemo || destroyed) return;
      const requested = new URLSearchParams(location.search).get('dir') || PREFIX;
      if (!safePath(requested)) return;
      const path = requested === PREFIX ? defaultSharePath() : resolveRenamedFolderPath(requested);
      if (!path) {
        if (activeTab()) writeUrl(currentPath(), true);
        else void initializeBrowser(PREFIX);
        return;
      }
      if (requested === PREFIX || path !== requested) {
        const url = new URL(location.href);
        url.searchParams.set('dir', path);
        history.replaceState({ufs:true, tabId:event.state?.tabId ?? activeTab()?.id ?? null, path}, '', url);
      }
      restoreBrowserPath(path, event.state?.ufs ? event.state.tabId : null);
    }, { signal: lifecycle.signal });
    return app;
  }

  function availableHeight(appTop, footerTop, viewportHeight, scrollOffset = 0) {
    // getBoundingClientRect().top is viewport-relative and becomes negative on page scroll.
    // Convert to a document-relative anchor before calculating height, preventing the
    // scroll -> taller app -> more scroll feedback loop seen in Unraid 7.2.2.
    const documentTop = appTop + Math.max(0, scrollOffset);
    const bottom = Number.isFinite(footerTop) && footerTop > 0
      ? Math.min(footerTop, viewportHeight) : viewportHeight;
    return Math.max(260, Math.floor(bottom - documentTop - 12));
  }
  function startLayoutSync() {
    // The enhanced Browse view scrolls inside the file panes, not the document.
    // Disable root scrolling only here; leaving other Unraid pages untouched.
    if (!isDemo) {
      document.documentElement.classList.add('ufs-active-page');
      if (window.scrollY) window.scrollTo(0, 0);
    }
    let scheduled = false;
    const measure = () => {
      scheduled = false;
      if (destroyed || !app || !app.isConnected) return;
      const top = app.getBoundingClientRect().top;
      const footer = isDemo ? null : document.querySelector('#footer');
      const footerTop = footer ? footer.getBoundingClientRect().top : NaN;
      const height = availableHeight(top, footerTop, window.innerHeight, window.scrollY);
      if (app.style.height !== height + 'px') app.style.height = height + 'px';
    };
    const schedule = () => {
      if (destroyed || scheduled) return;
      scheduled = true;
      requestAnimationFrame(measure);
    };
    window.addEventListener('resize', schedule, { signal: lifecycle.signal });
    if (window.visualViewport) window.visualViewport.addEventListener('resize', schedule, { signal: lifecycle.signal });
    // Never observe document.body: resizing #ufs-app would trigger that observer
    // and form a self-sustaining layout feedback cycle.
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(schedule);
      const targets = [document.querySelector('#header'),
        document.querySelector('header'), document.querySelector('nav'), document.querySelector('#footer')];
      [...new Set(targets.filter(Boolean))].forEach((node) => observer.observe(node));
      onCleanup(() => observer.disconnect());
    }
    // Recalculate after Unraid's masthead transitions (including collapsed state).
    document.addEventListener('transitionend', schedule, { signal: lifecycle.signal });
    const resizeTimers = new Set();
    document.addEventListener('click', () => {
      for (const delay of [120, 400]) {
        const timeout = setTimeout(() => { resizeTimers.delete(timeout); schedule(); }, delay);
        resizeTimers.add(timeout);
      }
    }, { signal: lifecycle.signal });
    onCleanup(() => { for (const timeout of resizeTimers) clearTimeout(timeout); resizeTimers.clear(); });
    schedule();
  }
  function setupSidebarResizer() {
    const handle = $('.ufs-resizer', app);
    const workspace = $('.ufs-workspace', app);
    const saved = Number(localStorage.getItem(STORE + 'sidebarWidth'));
    if (Number.isFinite(saved) && saved >= 170 && saved <= 420) {
      app.style.setProperty('--ufs-sidebar-width', saved + 'px');
    }
    let dragging = false;
    const adjust = (clientX) => {
      const width = Math.min(420, Math.max(170, clientX - workspace.getBoundingClientRect().left));
      if (workspace.clientWidth <= 720) return;
      app.style.setProperty('--ufs-sidebar-width', Math.min(width, workspace.clientWidth * 0.42) + 'px');
    };
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      dragging = true;
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener('pointermove', (event) => {
      if (dragging) adjust(event.clientX);
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      const width = parseFloat(app.style.getPropertyValue('--ufs-sidebar-width'));
      if (Number.isFinite(width)) localStorage.setItem(STORE + 'sidebarWidth', String(Math.round(width)));
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('lostpointercapture', end);
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
    if ($('#ufs-app')) return true;
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
      // Browse.page renders a separate native breadcrumb/filter strip above its table.
      // Hide it only on the enhanced Browse view, never on Shares/settings pages.
      const nativeBreadcrumb = $('.title .left')?.closest('.title');
      nativeElements = [native, $('#buttons'), nativeBreadcrumb].filter(Boolean);
      nativeElements.forEach((node) => node.classList.add('ufs-hide-native'));
      native.parentNode.insertBefore(root, native);
    }
    startLayoutSync();
    // Native filemonitor.start() is delayed; take ownership before it fires.
    if (!isDemo) {
      if (!takeOverNativeFileMonitor()) {
        // Normally Browse.page creates filemonitor before document-idle.
        // Retry briefly if scripts happen to initialize in another order.
        let monitorAttempts = 0;
        const retryMonitor = setInterval(() => {
          if (destroyed || takeOverNativeFileMonitor() || ++monitorAttempts >= 25) {
            clearInterval(retryMonitor);
          }
        }, 100);
        onCleanup(() => clearInterval(retryMonitor));
      }
    }
    // Resolve the root before creating a tab: do not briefly render the
    // "all shares" listing or put the virtual group into tab history.
    void initializeBrowser(start);
    return true;
  }
  async function initializeBrowser(start) {
    if (destroyed || state.initializing) return;
    const generation = ++state.initGeneration;
    state.initializing = true;
    try {
    if (start === PREFIX) {
      state.busy = true;
      renderTree();
      renderFiles();
      await loadTree(PREFIX);
      if (destroyed || generation !== state.initGeneration) return;
      const home = defaultSharePath();
      if (!home) {
        state.busy = false;
        renderTabs();
        renderNavigation();
        renderFiles(state.rootLoadError || '没有可访问的共享文件夹');
        return;
      }
      start = home;
      writeUrl(home, true); // root cannot remain in the browser Back stack
    }
    state.tabs = [{ id: state.nextId++, path: start, history: [start], cursor: 0 }];
    state.activeId = state.tabs[0].id;
    renderTabs();
    renderNavigation();
    renderTree();
    if (!state.tree.has(PREFIX)) void loadTree(PREFIX);
    void refreshDirectory();
    } finally {
      if (!destroyed && generation === state.initGeneration) {
        state.initializing = false;
        renderTabs();
        renderNavigation();
      }
    }
  }

  // Browse.page has its own subscriber. It treats a running native file task
  // as an *external* change whenever dfm.running=false, and calls global
  // refresh() -> location.replace(location.href). That reloads File Station.
  // Take over only this Browse instance while the enhanced UI is mounted.
  // In particular, Browse.page schedules filemonitor.start() three seconds
  // after page load: stop() alone is insufficient without gating start().
  function takeOverNativeFileMonitor() {
    if (isDemo || !browsePage || !app?.isConnected || destroyed ||
        typeof window.NchanSubscriber !== 'function') return false;
    const native = window.filemonitor;
    if (!native || typeof native.start !== 'function' || typeof native.stop !== 'function') {
      return false;
    }
    const nativeStart = native.start;
    // Guard against an earlier timer firing after the script takes over.
    try {
      native.start = function ufsPausedNativeFileMonitorStart() {};
    } catch (_) {
      return false;
    }
    // An unstarted native subscriber may throw when stopped: the deferred
    // start is already blocked, so this must not undo takeover.
    try { native.stop(); } catch (_) {}
    if (window.timers?.filemonitor) {
      clearTimeout(window.timers.filemonitor);
      window.timers.filemonitor = null;
    }
    let ownMonitor;
    let alive = true;
    let sawExternalTask = false;
    let pendingTimer = null;
    const clearPending = () => {
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
    };
    const localWriteInProgress = () => nativeWriteBusy || Date.now() < ownFileChangeQuietUntil;
    const scheduleLocalRefresh = () => {
      clearPending();
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        if (!alive || destroyed || !app?.isConnected) return;
        if (localWriteInProgress()) return;
        // The native full-page refresh would discard all tabs and selection.
        // Only refresh the active directory and its tree entries.
        if (activeTab() && !state.initializing && !state.busy) void refreshDirectory();
      }, 350);
    };
    try {
      ownMonitor = new window.NchanSubscriber(NATIVE_CHANGE_EVENTS, { subscriber: 'websocket' });
      ownMonitor.on('message', raw => {
        if (!alive || destroyed || !app?.isConnected) return;
        const value = String(raw).trim();
        if (value === '1') {
          if (localWriteInProgress()) {
            sawExternalTask = false;
            clearPending();
          } else {
            sawExternalTask = true;
          }
        } else if (value === '0' && sawExternalTask) {
          sawExternalTask = false;
          if (!localWriteInProgress()) scheduleLocalRefresh();
        }
      });
      ownMonitor.start();
    } catch (_) {
      alive = false;
      clearPending();
      try { ownMonitor?.stop(); } catch (_) {}
      native.start = nativeStart;
      try { native.start(); } catch (_) {}
      return false;
    }
    onCleanup(() => {
      alive = false;
      clearPending();
      try { ownMonitor.stop(); } catch (_) {}
      native.start = nativeStart;
    });
    return true;
  }

  function begin() {
    if (sharesPage && !isDemo) {
      addSharesEntry();
      const observer = new MutationObserver(() => addSharesEntry());
      observer.observe(document.body, { childList: true, subtree: true });
      onCleanup(() => observer.disconnect());
      return;
    }
    if (!browsePage && !isDemo) return;
    if (setupBrowser()) return;
    // WebGUI may mount the Browse table after scripts or Ajax initialization.
    let attempts = 0;
    const timer = setInterval(() => {
      if (destroyed || setupBrowser() || ++attempts >= 25) clearInterval(timer);
    }, 200);
    onCleanup(() => clearInterval(timer));
  }
  // Explicit opt-in hook for pure-function tests; never enabled on production WebGUI.
  if (isDemo && window.__UFS_TEST_MODE__ === true) {
    window.__UFS_TEST_API__ = { safePath, formatSize, encodeFileUrl, parseBrowse, extractLocations, locationNames, fitLocationNames, renderLocationTags, listDirectory, safeWriteName, safeWritePath, planFileOperation, previewNativeOperationRequest, createFileOperationCoordinator, FILE_WRITES_ENABLED, CREATE_FOLDER_ENABLED, RENAME_ENABLED, COPY_ENABLED, parseNativeActive, matchesCreateTask, matchesRenameTask, renameSelectionEnd, remapPathPrefix, resolveRenamedFolderPath, applyRenameToBrowser, createNativeFolder, renameNativeEntry, nativeCopyTarget, matchesCopyTask, copyDestinationAllowed, copyNativeEntry, decodeRsyncFilename, parseRsyncProgress, shortenCopyName, requestCancelNativeCopy, takeOverNativeFileMonitor, availableHeight, visibleEntries, sortedCopyFolders, safeCopyName, safeCopyPath, copyBlockedReason, selectedEntries, breadcrumbDisplayPaths, renderHeaderMarkup, renderBrowserBarMarkup, renderFileActionsMarkup, renderWorkspaceMarkup, COLUMNS, clampColumnWidth, readColumnWidths, columnLayout, inspectListScrollMetrics, virtualWindow, virtualGridColumns, firstSharePath, defaultSharePath, isShareRoot, selectionStatus, updateSelection, shouldSuppressTextSelection, state };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin, { once: true });
  else begin();
})();
