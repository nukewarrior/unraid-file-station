// ==UserScript==
// @name         Unraid File Station
// @namespace    https://github.com/nukewarrior/unraid-file-station
// @version      0.2.13.9
// @updateURL    https://raw.githubusercontent.com/nukewarrior/unraid-file-station/feat/file-station-v0.1/src/unraid-file-station.user.js
// @downloadURL  https://raw.githubusercontent.com/nukewarrior/unraid-file-station/feat/file-station-v0.1/src/unraid-file-station.user.js
// @description  DSM-inspired File Station with guarded native file operations for Unraid 7.2.2
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
    const started=Date.now();
    try {
      const response = await fetch(url.toString(), { credentials: 'same-origin', cache: 'no-store', signal: options.signal });
      if (!response.ok) throw new Error('读取失败：HTTP ' + response.status);
      const html = await response.text();
      if (/Invalid path/i.test(html)) throw new Error('目录无效或没有访问权限');
      const entries=parseBrowse(html,path);
      const elapsed=Date.now()-started;
      if(elapsed>1500)diagnosticLog('WARN','directory.slow',{path,elapsed,count:entries.length});
      else diagnosticLog('DEBUG','directory.loaded',{path,elapsed,count:entries.length});
      return entries;
    } catch(error) {
      if(error?.name!=='AbortError')
        diagnosticLog('WARN','directory.load_failed',{path,elapsed:Date.now()-started,message:error?.message});
      throw error;
    }
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

  // Only update bytes for regular files whose sizes are known. Unraid Browse.php
  // does not report recursive folder sizes, so a folder's rsync percentage can
  // never be used as a trustworthy total-folder percentage.
  function batchCopyOverallProgress(rows,currentIndex=-1,currentPercent=null) {
    if (!Array.isArray(rows) || !rows.length) return {percent:0,mode:'items'};
    const success=rows.filter(row=>['success','skipped'].includes(row.status)).length;
    if(success===rows.length) return {percent:100,mode:rows.every(row=>!row.entry.folder &&
      Number.isFinite(row.entry.size))?'bytes':'items'};
    const allSizedFiles=rows.every(row=>!row.entry.folder && Number.isFinite(row.entry.size) &&
      row.entry.size>=0);
    const total=allSizedFiles?rows.reduce((sum,row)=>sum+row.entry.size,0):0;
    const current=rows[currentIndex];
    const fraction=current && current.status==='copying' && !current.entry.folder &&
      Number.isFinite(currentPercent) && currentPercent>=0 && currentPercent<=100
      ?currentPercent/100:0;
    let value;
    if (allSizedFiles && total>0) {
      const verified=rows.reduce((sum,row)=>sum+(['success','skipped'].includes(row.status)?row.entry.size:0),0);
      value=100*(verified+(current?current.entry.size*fraction:0))/total;
    } else {
      value=100*(success+fraction)/rows.length;
    }
    return {percent:Math.min(99.9,Math.max(0,Math.round(value*100)/100)),
      mode:allSizedFiles && total>0?'bytes':'items'};
  }

  // In strict mode, identify existing top-level destination names before writing.
  function findBatchCopyConflicts(plans, destinationItems) {
    const existing=new Set(destinationItems.flatMap(item=>[item.name,item.path]));
    return plans.filter(plan=>existing.has(plan.target) ||
      existing.has(fileName(plan.source))).map(plan=>fileName(plan.source));
  }

  // Existing files and directories cannot be interchanged by either policy.
  function findBatchCopyTypeConflicts(plans, items) {
    return plans.filter(plan => {
      const old=items.find(item=>item.path===plan.target ||
        item.name===fileName(plan.source));
      return old && (old.folder!==plan.folder || old.copyPathVerified===false);
    }).map(plan=>fileName(plan.source));
  }
  function parentPath(path) { return path.slice(0, path.lastIndexOf('/')); }
  function fileName(path) { return path.slice(path.lastIndexOf('/') + 1); }

  function planFileOperation(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('文件操作参数无效');
    }
    const { type, source, parent, name, destinationDir, folder, conflictPolicy = 'fail' } = input;
    if (conflictPolicy !== 'fail' &&
        !(['copy','move'].includes(type) && ['skip','overwrite'].includes(conflictPolicy)))
      throw new Error('当前不允许覆盖目标文件或使用该冲突策略');
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
    const diagnosticStart=Date.now();
    if(fields.mode!=='read')diagnosticLog('INFO','native.request',{mode:fields.mode,action:fields.action||null});
    const body = new URLSearchParams({ ...fields, csrf_token: nativeCsrfToken() });
    const response = await fetch(NATIVE_CONTROL_URL, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: body.toString(), signal: lifecycle.signal
    });
    const elapsed=Date.now()-diagnosticStart;
    if(!response.ok)diagnosticLog('ERROR','native.http_failed',{mode:fields.mode,status:response.status,elapsed});
    else if(fields.mode!=='read'||elapsed>1000)diagnosticLog(elapsed>1000?'WARN':'INFO','native.response',{mode:fields.mode,status:response.status,elapsed});
    else diagnosticLog('DEBUG','native.poll',{elapsed});
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
  async function ensureNativeSlotFreeAfterIntent(operation) {
    // The Unraid global active-task slot has no atomic reservation API.
    // Check once more after the durable checkpoint and before native POST.
    let active;
    try { active=await readNativeActive(); }
    catch(error) {
      diagnosticLog('WARN','native.pre_submit_read_failed',{operation,message:error?.message});
      throw new Error('保存提交意图后无法再次确认原生任务状态；本次请求未发送，持久化记录结果不确定。详情：'+String(error?.message||error));
    }
    if(!active)return;
    diagnosticLog('WARN','native.pre_submit_busy',{operation,activeAction:Number(active.action),
      taskId:activeCopySession?.taskId});
    throw new Error('保存提交意图后发现其他 Unraid 原生任务占用；本次请求未发送，持久化记录结果不确定，请先核实队列');
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
        } catch (error) {
          diagnosticLog('WARN','native.progress_malformed',{message:error?.message,bytes:String(raw).length});
        }
      });
      subscriber.start();
    } catch (error) {
      diagnosticLog('WARN','native.progress_subscribe_failed',{message:error?.message});
    }
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
      // Writes may alter the native table while it is hidden.
      markNativeListDirty();
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
    const clean=text.replace(/<br\s*\/?>|<\/(?:div|p|li|tr)>/gi,'\n')
      .replace(/<[^>]*>/g,'').replace(/&nbsp;/g,' ')
      .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
    return decodeRsyncFilename(clean);
  }
  // The Nchan status may itself be JSON (e.g. {"action":8,"text":["Copying...","..."]}).
  // Unwrap only its text payload; JSON metadata and malformed wrappers are not filenames.
  function extractNativeProgressText(status) {
    let payload=status;
    if(typeof payload==='string') {
      const raw=payload.trim();
      if(!raw.startsWith('{') && !raw.startsWith('[')) return payload;
      try { payload=JSON.parse(raw); } catch (_) { return ''; }
    }
    if(!payload || typeof payload!=='object' || Array.isArray(payload)) return '';
    const chunks=typeof payload.text==='string'?[payload.text]:
      Array.isArray(payload.text)?payload.text:[];
    return chunks.filter(chunk=>typeof chunk==='string').join('\n');
  }
  // Nchan can publish {status:"..."} or {text:[...]}; both are read-only.
  function nativeCopyProgressPayload(data) {
    if(typeof data?.status==='string' || (data?.status && typeof data.status==='object'))
      return data.status;
    if(typeof data?.text==='string' || Array.isArray(data?.text)) return data;
    return '';
  }
  function parseRsyncProgress(status) {
    const text=stripNativeStatusHtml(extractNativeProgressText(status)).replace(/\r/g,'\n');
    const lines=text.split('\n').map(line=>line.trim()).filter(Boolean);
    // In Unraid, progress2 output normally follows the current filename.
    // Accept decimal percentages, speed and ETA only from a real rsync line.
    // rsync sometimes omits ETA, while still providing valid observed speed.
    const matched=[...text.matchAll(/(?:^|\s)([\d,.]+[kKMGTPE]?(?:i?B)?)\s+(\d{1,3}(?:\.\d+)?)%\s+([\d,.]+\s*[kKMGTPE]?(?:i?B)?\/s)(?:\s+(\d{1,4}:\d\d(?::\d\d)?))?/g)].pop();
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
        eta=matched[4]||'';
      }
    }
    let filename='';
    for(const line of lines) {
      if(/\b(?:Copying|Moving|复制中|正在复制|移动中|正在移动)\s*\.{2,3}\s*/i.test(line)) {
        filename=line.replace(/^.*?\b(?:Copying|Moving|复制中|正在复制|移动中|正在移动)\s*\.{2,3}\s*/i,'').trim();
        break;
      }
    }
    // Status-only events ("Done", errors, JSON metadata) must never replace the current filename.
    // Never synthesize a percentage, bytes or ETA from speed-only status.
    if(!speed && /(?:(?:Copying|Moving)\s*\.{2,3}|复制中|正在复制|移动中|正在移动|xfr#\d+|to-chk=)/i.test(text)) {
      const rate=[...text.matchAll(/(?:^|\s)([\d,.]+\s*[kKMGTPE]?(?:i?B)?\/s)(?=\s|$|[,;])/g)].pop();
      if(rate) speed=rate[1].replace(/\s+/g,'');
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
  async function copyNativeEntry(plan, progress = () => {}, control = {}, beforeSubmit = null) {
    return withNativeWriteLock(async () => {
      if (!COPY_ENABLED || !plan || plan.type !== 'copy' ||
          !['fail','skip','overwrite'].includes(plan.conflictPolicy) || plan.previewOnly !== true ||
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
      const existing=destinationEntries.find(entry=>
        entry.name===fileName(plan.source) || entry.path===plan.target);
      if(existing && (existing.folder!==plan.folder || existing.copyPathVerified===false))
        throw new Error('目标已有同名但类型不一致或路径不可信的项目，未执行复制');
      diagnosticLog('INFO','copy.preflight',{taskId:activeCopySession?.taskId,
        source:plan.source,destination:plan.destinationDir,folder:plan.folder,
        conflictPolicy:plan.conflictPolicy,existing:!!existing,
        targetType:existing?(existing.folder?'folder':'file'):'absent',
        nestedConflictInspection:plan.folder?'not-performed':'not-applicable'});
      if(existing && plan.conflictPolicy==='fail') {
        diagnosticLog('WARN','copy.conflict_blocked',{taskId:activeCopySession?.taskId,source:plan.source});
        throw new Error('目标文件夹中已有同名项目，未执行复制');
      }
      // A top-level file can be skipped without submitting a native task.
      // A folder must still be merged by the native rsync task.
      if(existing && !plan.folder && plan.conflictPolicy==='skip') {
        diagnosticLog('INFO','copy.skipped_conflict',{taskId:activeCopySession?.taskId,
          folder:false,conflictPolicy:'skip',targetExistedBefore:true,
          nativeSubmitted:false});
        return {...existing,copyOutcome:'skipped'};
      }
      if (await readNativeActive()) throw new Error('Unraid 正在执行其他原生文件任务，请稍后重试');
      nativeCsrfToken();
      // Durable intent must be committed before any native file action.
      if(beforeSubmit) await beforeSubmit();
      await ensureNativeSlotFreeAfterIntent('copy');
      diagnosticLog('INFO','copy.submission_intent',{taskId:activeCopySession?.taskId,source:plan.source});
      let submitted = false;
      let eventError = '';
      let eventDone = false;
      let observedOwnTask = false;
      let lastProgressDiagnostic=0;
      const unwatch = observeNativeProgress(data => {
        const payload=nativeCopyProgressPayload(data);
        if(payload) {
          const info=parseRsyncProgress(payload);
          if(info.text) progress(info.text, null, info);
          if(Date.now()-lastProgressDiagnostic>=4000) {
            lastProgressDiagnostic=Date.now();
            diagnosticLog('DEBUG','copy.native_progress',{taskId:activeCopySession?.taskId,
              percent:info.percent,speed:info.speed,filename:info.filename,hasText:!!info.text});
          }
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
          hdlink: '', sparse: '', exist: plan.conflictPolicy==='overwrite'?'1':'', zfs: ''
        });
        if (reply.trim()) throw new Error('原生接口返回了非预期内容');
        diagnosticLog('INFO','copy.submitted',{taskId:activeCopySession?.taskId});
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
            if(!observedOwnTask)diagnosticLog('INFO','copy.native_task_matched',{taskId:activeCopySession?.taskId});
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
        const copyOutcome=existing && plan.folder?'merged':
          existing && plan.conflictPolicy==='overwrite'?'overwrite-allowed':'copied';
        diagnosticLog('INFO','copy.verified',{taskId:activeCopySession?.taskId,
          source:plan.source,folder:plan.folder,conflictPolicy:plan.conflictPolicy,
          targetExistedBefore:!!existing,copyOutcome,
          verificationScope:plan.folder?'top-level-only':'top-level-size-if-available',
          nestedConflictInspection:plan.folder?'not-performed':'not-applicable'});
        return {...result,copyOutcome};
      } catch (error) {
        diagnosticLog('ERROR','copy.native_failed',{taskId:activeCopySession?.taskId,
          submitted,cancelRequested:!!control.cancelRequested,message:error?.message});
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



  // v0.2.9: only rsync move (action 4/9); never use mv -f or merge targets.
  function matchesMoveTask(active,plan) {
    return active && Number(active.action)===(plan.folder?4:9) &&
      active.source===plan.source && active.target===plan.destinationDir+'/';
  }
  // Unraid Browse.page submits multi-selection sources joined by CR. The
  // upstream Control.php decodes this field once more; file_manager splits CR.
  // This is an eligibility gate, NOT a guarantee against a concurrent writer
  // creating a target between our preflight and the daemon's rename(2).
  function nativeMoveBatchEligible(plans) {
    if(!Array.isArray(plans) || plans.length<2 || plans.length>256)return false;
    const first=plans[0],parent=parentPath(first.source);
    if(!safeWritePath(parent,true) || !safeWritePath(first.destinationDir,true) ||
       parent===first.destinationDir)return false;
    const seen=new Set();
    for(const plan of plans) {
      if(!plan || plan.type!=='move' || plan.folder!==false ||
         !['fail','skip'].includes(plan.conflictPolicy) || plan.destinationDir!==first.destinationDir ||
         parentPath(plan.source)!==parent || !safeWritePath(plan.source) ||
         plan.target!==plan.destinationDir+'/'+fileName(plan.source) ||
         !copyDestinationAllowed(plan,first.destinationDir) || seen.has(plan.source))
        return false;
      seen.add(plan.source);
    }
    return plans.map(plan=>plan.source).join('\r').length<=16000;
  }
  // On Unraid file_manager, actions 4 and 9 share the same move case and
  // each CR-separated entry is checked using is_dir(). Keep this opt-in narrow:
  // ONE directory plus ordinary files, all from the same source parent.
  // Multiple folders, folder-only batches, nested targets and any ambiguous
  // path stay on the existing safe serial path.
  function nativeMoveMixedEligible(plans) {
    if(!Array.isArray(plans) || plans.length<2 || plans.length>256)return false;
    const first=plans[0];
    if(!first || typeof first.source!=='string' ||
       typeof first.destinationDir!=='string')return false;
    const parent=parentPath(first.source);
    if(!safeWritePath(parent,true) || !safeWritePath(first.destinationDir,true) ||
       parent===first.destinationDir)return false;
    let folders=0,files=0;
    const seen=new Set();
    for(const plan of plans) {
      if(!plan || plan.type!=='move' || typeof plan.folder!=='boolean' ||
         !['fail','skip'].includes(plan.conflictPolicy) || plan.destinationDir!==first.destinationDir ||
         parentPath(plan.source)!==parent || !safeWritePath(plan.source) ||
         plan.target!==plan.destinationDir+'/'+fileName(plan.source) ||
         !copyDestinationAllowed(plan,first.destinationDir) || seen.has(plan.source))
        return false;
      seen.add(plan.source);
      if(plan.folder)folders++;
      else files++;
    }
    return folders===1 && files>=1 &&
      plans.map(plan=>plan.source).join('\r').length<=16000;
  }
  function nativeMoveBatchMode(plans) {
    if(nativeMoveBatchEligible(plans))return 'native-move-files';
    if(nativeMoveMixedEligible(plans))return 'native-move-mixed';
    return null;
  }
  function nativeMoveFallbackReason(plans) {
    if(!Array.isArray(plans) || plans.length<2)return 'insufficient-items';
    const folders=plans.filter(p=>p.folder===true).length;
    if(folders>=2)return 'multiple-directories';
    if(folders===plans.length)return 'directories-only';
    if(new Set(plans.map(p=>p.destinationDir)).size>1 ||
       new Set(plans.map(p=>parentPath(p.source))).size>1)
      return 'different-source-or-target';
    return 'unsafe-or-unsupported-path';
  }
  function matchesMoveBatchTask(active,plans) {
    return !!nativeMoveBatchMode(plans) && active &&
      Number(active.action)===9 &&
      active.source===plans.map(plan=>plan.source).join('\r') &&
      active.target===plans[0].destinationDir+'/';
  }
  function savedMoveBatchPlans(record) {
    if(record?.operation!=='move' ||
       !['native-move-files','native-move-mixed'].includes(record.batchMode))return null;
    const plans=record.items.map(item=>({
      type:'move',source:item.source,folder:item.folder,
      destinationDir:record.destination,
      target:record.destination+'/'+fileName(item.source),conflictPolicy:'fail'
    }));
    return nativeMoveBatchMode(plans)===record.batchMode?plans:null;
  }
  async function moveNativeBatch(plans,progress=()=>{},control={},beforeSubmit=null) {
    return withNativeWriteLock(async()=>{
      const batchMode=nativeMoveBatchMode(plans);
      if(!MOVE_ENABLED || !batchMode)
        throw new Error('不符合原生批量移动条件');
      if(isDemo && window.__UFS_TEST_MODE__!==true)
        throw new Error('演示模式不能执行真实批量移动');
      const startedAt=Date.now(),sourceDir=parentPath(plans[0].source);
      progress('正在核实整批源文件和目标目录…','checking');
      // One fresh read per directory, not one read per item. Verify exact
      // source/type and every target's absence immediately before intent.
      const [sources,destinations]=await Promise.all([
        listDirectory(sourceDir),listDirectory(plans[0].destinationDir)
      ]);
      const originals=new Map(sources.map(entry=>[entry.path,entry]));
      const targets=new Set(destinations.map(entry=>entry.name));
      for(const plan of plans) {
        const origin=originals.get(plan.source);
        if(!origin || origin.folder!==plan.folder || origin.copyPathVerified===false)
          throw new Error('批量移动源项目类型不一致或已经变化');
        if(targets.has(fileName(plan.source)) ||
           destinations.some(entry=>entry.path===plan.target))
          throw new Error('目标存在同名项目，批量移动已拒绝');
      }
      if(await readNativeActive())throw new Error('Unraid 原生任务正在运行');
      nativeCsrfToken();
      if(beforeSubmit)await beforeSubmit(); // One durable transaction for ALL intents.
      // The IndexedDB commit can take time. Reduce the race with unrelated
      // native tasks by checking the shared active slot immediately again.
      // If busy, the saved intent stays uncertain; NEVER overwrite or retry.
      if(await readNativeActive())
        throw new Error('保存提交意图后发现另一个 Unraid 原生任务，整批未发送');
      const rawSources=plans.map(plan=>plan.source).join('\r');
      diagnosticLog('INFO','move.batch_intent',{taskId:activeCopySession?.taskId,
        count:plans.length,sourceDir,destination:plans[0].destinationDir,
        conflictPolicy:plans[0].conflictPolicy,targetExistingCount:0,
        strategy:'native-cr-source',batchMode,folderCount:plans.filter(p=>p.folder).length,
        overwriteGuard:'preflight-only',verificationScope:'top-level-only',
        nestedConflictInspection:'not-performed'});
      let submitted=false,seen=false,done=false,remoteError='';
      const stop=observeNativeProgress(data=>{
        const payload=nativeCopyProgressPayload(data);
        if(payload) {
          const info=parseRsyncProgress(payload);
          if(info.text)progress(info.text,null,info);
        }
        if(data.error)remoteError=stripNativeStatusHtml(data.error).slice(0,200);
        if(data.done===1)done=true;
      });
      try {
        submitted=true;
        const requestAt=Date.now();
        const reply=await postNativeControl({mode:'file',action:'9',
          title:encodeURIComponent('批量移动'),
          source:encodeURIComponent(rawSources),
          target:encodeURIComponent(plans[0].destinationDir+'/'),
          hdlink:'',sparse:'',exist:'',zfs:''});
        const requestMs=Date.now()-requestAt;
        if(reply.trim())throw new Error('原生批量移动接口返回非预期内容');
        progress(batchMode==='native-move-mixed'?
          'Unraid 正在批量移动文件及文件夹…':'Unraid 正在批量移动文件…','copying');
        const monitorAt=Date.now(),limit=monitorAt+6*60*60*1000;
        let idle=0,polls=0;
        while(Date.now()<limit){
          await waitNative(Date.now()-monitorAt<3000?200:700);
          if(remoteError)throw new Error('Unraid 报告批量移动错误：'+remoteError);
          const current=await readNativeActive();
          polls++;
          if(current) {
            if(!matchesMoveBatchTask(current,plans))
              throw new Error('原生任务不是本次批量移动，拒绝确认归属');
            seen=true;control.observedOwnTask=true;idle=0;
          } else {
            idle++;
            if(idle>=2 && (seen||done))break;
            if(!seen && !done && Date.now()-monitorAt>=3500)
              throw new Error('未观察到原生批量移动任务或完成事件');
          }
        }
        if(idle<2 || !(seen||done) || remoteError)
          throw new Error('无法确认原生批量移动已结束');
        const monitorMs=Date.now()-monitorAt,verifyAt=Date.now();
        progress('正在逐项核对批量移动结果…','verifying');
        const [afterSources,afterTargets]=await Promise.all([
          listDirectory(sourceDir),listDirectory(plans[0].destinationDir)
        ]);
        const afterSourceNames=new Set(afterSources.map(item=>item.path));
        const resultTargets=new Map(afterTargets.map(item=>[item.path,item]));
        const results=[];
        for(const plan of plans) {
          const item=resultTargets.get(plan.target),old=originals.get(plan.source);
          if(afterSourceNames.has(plan.source) || !item ||
             item.folder!==plan.folder || item.copyPathVerified===false ||
             (!plan.folder && Number.isFinite(old.size)&&Number.isFinite(item.size)&&
              old.size!==item.size))
            throw new Error('批量移动存在未核实项目：'+fileName(plan.source));
          results.push({...item,moveOutcome:'moved'});
        }
        diagnosticLog('INFO','move.batch_verified',{
          taskId:activeCopySession?.taskId,count:plans.length,requestMs,monitorMs,
          verifyMs:Date.now()-verifyAt,totalMs:Date.now()-startedAt,
          polls,observedOwnTask:seen,observedDone:done,
          strategy:'native-cr-source',batchMode,folderCount:plans.filter(p=>p.folder).length,
          conflictPolicy:plans[0].conflictPolicy,targetExistingCount:0,
          folderVerification:'top-level-only',nestedConflictInspection:'not-performed'});
        return results;
      }catch(error) {
        diagnosticLog('ERROR','move.batch_failed',{
          taskId:activeCopySession?.taskId,count:plans.length,submitted,
          message:error?.message,batchMode,
          verification:'all-items-uncertain-after-submit'});
        if(submitted)throw new Error('原生批量移动可能已提交，整批结果待核实；禁止自动重试或转为串行。详情：'+String(error?.message||error));
        throw error;
      }finally{stop();}
    });
  }

  async function moveNativeEntry(plan,progress=()=>{},control={},beforeSubmit=null) {
    return withNativeWriteLock(async()=>{
      if(!MOVE_ENABLED || !plan || plan.type!=='move' ||
         !['fail','skip','overwrite'].includes(plan.conflictPolicy) ||
         !safeWritePath(plan.source) || !safeWritePath(plan.destinationDir,true) ||
         !copyDestinationAllowed(plan,plan.destinationDir) ||
         plan.target!==plan.destinationDir+'/'+fileName(plan.source) ||
         typeof plan.folder!=='boolean')throw new Error('不安全的移动计划');
      if(isDemo && window.__UFS_TEST_MODE__!==true)throw new Error('演示模式不能移动真实文件');
      const startedAt=Date.now();
      progress('正在核对移动源与目标…','checking');
      const [sources,destinations]=await Promise.all([
        listDirectory(parentPath(plan.source)),listDirectory(plan.destinationDir)
      ]);
      const origin=sources.find(x=>x.path===plan.source);
      if(!origin || origin.folder!==plan.folder || origin.copyPathVerified===false)
        throw new Error('源路径已经变化或无法安全校验');
      const existing=destinations.find(x=>x.path===plan.target || x.name===fileName(plan.source));
      diagnosticLog('INFO','move.preflight',{taskId:activeCopySession?.taskId,
        source:plan.source,target:plan.target,folder:plan.folder,
        conflictPolicy:plan.conflictPolicy,targetExistedBefore:!!existing,
        targetType:existing?(existing.folder?'folder':'file'):'absent',
        typeMatches:existing?existing.folder===plan.folder:null,
        mergeCandidate:!!existing&&plan.folder&&existing.folder===true,
        nativeAction:plan.folder?'4':'9',
        nestedConflictInspection:plan.folder?'not-performed':'not-applicable'});
      if(existing?.copyPathVerified===false)
        throw new Error('同名目标路径无法核实，拒绝移动');
      if(existing && plan.conflictPolicy==='fail')
        throw new Error('目标存在同名项目，禁止移动或合并');
      if(existing && existing.folder!==plan.folder)
        throw new Error('目标同名文件与文件夹类型不同，拒绝移动以保护已有内容');
      // For a directory, let native rsync merge descendants. With
      // --ignore-existing only conflicting *files* remain in source.
      if(existing && plan.conflictPolicy==='skip' && !plan.folder) {
        diagnosticLog('INFO','move.skipped_conflict',{taskId:activeCopySession?.taskId,
          source:plan.source,target:plan.target,folder:false,
          conflictPolicy:'skip',targetExistedBefore:true,nativeSubmitted:false});
        return {...origin,copyOutcome:'skipped',moveOutcome:'skipped'};
      }
      if(await readNativeActive())throw new Error('Unraid 原生任务正在运行');
      nativeCsrfToken();
      if(beforeSubmit)await beforeSubmit(); // Durable intent BEFORE native POST.
      await ensureNativeSlotFreeAfterIntent('move');
      diagnosticLog('INFO','move.intent',{taskId:activeCopySession?.taskId,
        source:plan.source,target:plan.target,folder:plan.folder,
        conflictPolicy:plan.conflictPolicy,targetExistedBefore:!!existing,
        mergeCandidate:!!existing&&plan.folder,nativeAction:plan.folder?'4':'9',
        nestedConflictInspection:plan.folder?'not-performed':'not-applicable'});
      let submitted=false,seen=false,done=false,remoteError='';
      const stop=observeNativeProgress(data=>{
        const payload=nativeCopyProgressPayload(data);
        if(payload){const info=parseRsyncProgress(payload);if(info.text)progress(info.text,null,info);}
        if(data.error)remoteError=stripNativeStatusHtml(data.error).slice(0,200);
        if(data.done===1)done=true;
      });
      try {
        submitted=true;
        const requestStartedAt=Date.now();
        const response=await postNativeControl({mode:'file',
          action:plan.folder?'4':'9',title:encodeURIComponent('移动'),
          source:encodeURIComponent(plan.source),target:encodeURIComponent(plan.destinationDir+'/'),
          hdlink:'',sparse:'',exist:plan.conflictPolicy==='overwrite'?'1':'',zfs:''});
        const requestMs=Date.now()-requestStartedAt;
        if(response.trim())throw new Error('原生接口返回非预期内容');
        progress('Unraid 正在移动文件…','copying');
        let idle=0,polls=0;
        const monitorStartedAt=Date.now();
        const limit=monitorStartedAt+6*60*60*1000;
        // Short native moves complete in under a second. Poll quickly for the
        // first 3s, then revert to the original 700ms cadence for long jobs.
        // Keep TWO consecutive idle reads and positive own-task/done evidence.
        // Startup timeout is elapsed-time based, not five faster poll attempts.
        while(Date.now()<limit){
          await waitNative(Date.now()-monitorStartedAt<3000?200:700);
          if(remoteError)throw new Error('Unraid 报告移动错误：'+remoteError);
          const current=await readNativeActive();
          polls++;
          if(current){
            if(!matchesMoveTask(current,plan))throw new Error('无法确认当前原生任务归属');
            seen=true;control.observedOwnTask=true;idle=0;
          }else{
            idle++;
            if(idle>=2 && (seen||done))break;
            if(!seen && !done && Date.now()-monitorStartedAt>=3500)
              throw new Error('未观察到原生移动任务');
          }
        }
        if(idle<2 || !(seen||done) || remoteError)throw new Error('无法确认移动已结束');
        const monitorMs=Date.now()-monitorStartedAt;
        progress('正在核对移动结果…','verifying');
        const verificationStartedAt=Date.now();
        const [afterSource,afterDestination]=await Promise.all([
          listDirectory(parentPath(plan.source)),listDirectory(plan.destinationDir)
        ]);
        const target=afterDestination.find(x=>x.path===plan.target);
        const sourceRemains=afterSource.some(x=>x.path===plan.source);
        // Native --ignore-existing --remove-source-files can leave the
        // directory in source when conflicting child files were skipped.
        const partiallyMerged=sourceRemains && plan.folder &&
          plan.conflictPolicy==='skip' && target?.folder===true &&
          target.copyPathVerified!==false;
        if((sourceRemains && !partiallyMerged) || !target ||
           target.folder!==plan.folder || target.copyPathVerified===false)
          throw new Error('源仍存在或目标未核实，移动可能不完整');
        if(!plan.folder && Number.isFinite(origin.size)&&Number.isFinite(target.size)&&
           origin.size!==target.size)throw new Error('移动前后文件大小不同');
        diagnosticLog('INFO','move.verified',{taskId:activeCopySession?.taskId,
          source:plan.source,target:plan.target,folder:plan.folder,
          conflictPolicy:plan.conflictPolicy,targetExistedBefore:!!existing,
          partial:partiallyMerged,merged:!!existing&&plan.folder,sourceRemains,
          moveOutcome:partiallyMerged?'merged-partial':existing&&plan.folder?'merged':'moved',
          verificationScope:plan.folder?'top-level-only':'top-level-size-if-available',
          nestedConflictInspection:plan.folder?'not-performed':'not-applicable',
          requestMs,monitorMs,verifyMs:Date.now()-verificationStartedAt,
          totalMs:Date.now()-startedAt,polls,observedOwnTask:seen,observedDone:done});
        return {...target,moveOutcome:partiallyMerged?'merged-partial':
          existing&&plan.folder?'merged':'moved'};
      }catch(error){
        diagnosticLog('ERROR','move.failed',{taskId:activeCopySession?.taskId,
          folder:plan.folder,conflictPolicy:plan.conflictPolicy,
          targetExistedBefore:!!existing,submitted,message:error?.message});
        if(submitted)throw new Error('移动请求可能已提交；结果不确定，源目录可能部分删除。请检查两处目录，切勿直接重试。详情：'+String(error?.message||error));
        throw error;
      }finally{stop();}
    });
  }


  function matchesDeleteTask(active,plan) {
    return active && Number(active.action)===(plan.folder?1:6) &&
      active.source===plan.source && active.target==='';
  }
  async function deleteNativeEntry(plan,progress=()=>{},control={},beforeSubmit=null) {
    return withNativeWriteLock(async()=>{
      if(!DELETE_ENABLED || !plan || plan.type!=='delete' || plan.conflictPolicy!=='fail' ||
         !safeWritePath(plan.source) || typeof plan.folder!=='boolean' || plan.target!=='')
        throw new Error('不安全的永久删除计划');
      if(isDemo && window.__UFS_TEST_MODE__!==true)
        throw new Error('演示模式禁止永久删除');
      progress('正在核实原项目…','checking');
      const parent=parentPath(plan.source);
      const before=await listDirectory(parent);
      const origin=before.find(x=>x.path===plan.source);
      if(!origin || origin.folder!==plan.folder || origin.copyPathVerified===false)
        throw new Error('删除项目已变化或路径不可信，拒绝提交');
      if(await readNativeActive())throw new Error('Unraid 原生文件任务正在运行');
      nativeCsrfToken();
      if(beforeSubmit)await beforeSubmit();
      await ensureNativeSlotFreeAfterIntent('delete');
      diagnosticLog('WARN','delete.intent',{source:plan.source,folder:plan.folder});
      let submitted=false,seen=false,done=false,remoteError='';
      const unwatch=observeNativeProgress(data=>{
        if(data.error)remoteError=stripNativeStatusHtml(data.error).slice(0,200);
        if(data.done===1)done=true;
      });
      try{
        submitted=true;
        const result=await postNativeControl({mode:'file',
          action:plan.folder?'1':'6',title:encodeURIComponent('删除'),
          source:encodeURIComponent(plan.source),target:'',
          hdlink:'',sparse:'',exist:'',zfs:''});
        if(result.trim())throw new Error('原生删除接口返回非预期内容');
        progress('正在永久删除…','copying');
        let idle=0;const deadline=Date.now()+6*60*60*1000;
        while(Date.now()<deadline){
          await waitNative(700);
          if(remoteError)throw new Error('原生删除错误：'+remoteError);
          const current=await readNativeActive();
          if(current){
            if(!matchesDeleteTask(current,plan))
              throw new Error('原生任务归属不一致，结果待核实');
            seen=true;control.observedOwnTask=true;idle=0;
          }else{
            idle++;
            if(idle>=2 && (seen||done))break;
            if(idle>=5&&!seen&&!done)
              throw new Error('无法确认原生删除任务启动及结束');
          }
        }
        if(idle<2||!(seen||done)||remoteError)
          throw new Error('原生删除未确认完成');
        progress('正在核对删除结果…','verifying');
        const after=await listDirectory(parent);
        if(after.some(x=>x.path===plan.source))
          throw new Error('项目仍存在，可能未删除完毕');
        diagnosticLog('INFO','delete.verified',{source:plan.source});
        return {deleted:true,source:plan.source};
      }catch(error){
        diagnosticLog('ERROR','delete.failed',{submitted,message:error?.message});
        if(submitted)throw new Error('永久删除请求可能已发送；结果不确定，部分内容可能已删除。请人工核实，切勿直接重试。详情：'+String(error?.message||error));
        throw error;
      }finally{unwatch();}
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
    'folder-open':['M3 7a2 2 0 0 1 2-2h4l2 2h9a2 2 0 0 1 2 2','M3 11h17a2 2 0 0 1 1.9 2.6L20 19H4a2 2 0 0 1-1.9-2.6z'],
    'folder-plus':['M12 10v6','M9 13h6','M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'],
    check:['m5 12 4 4 10-10'],
    'check-circle':['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z','m8 12 3 3 5-6'],
    'alert-circle':['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z','M12 8v4','M12 16h.01'],
    'clock-3':['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z','M12 6v6h4'],
    file:['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z','M14 2v6h6'],
    more:['M5 12h.01','M12 12h.01','M19 12h.01'],
    'scroll-text':['M15 12h-5','M15 8h-5','M19 17V5a2 2 0 0 0-2-2H4','M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3'],
    archive:['M4 4h16v16H4z','M4 9h16','M12 9v8','M10 13h4'],
    image:['M3 3h18v18H3z','M8 8h.01','m3 13 5-5 5 5'],
    video:['M3 5h18v14H3z','m10 4 5 3-5 3z'],
    disc:['M4 5h16v14H4z','M7 9h10','M7 13h10'],
    drive:['M5 5h14l3 11v3H2v-3z','M2 16h20','M17 18h.01'],
    'chevron-right':['m9 18 6-6-6-6'],
    'chevron-down':['m6 9 6 6 6-6'],
    'chevron-left':['m15 18-6-6 6-6'],
    'chevron-up':['m18 15-6-6-6 6'],
    'arrow-left':['M19 12H5','m12 19-7-7 7-7'],
    'arrow-right':['M5 12h14','m12 5 7 7-7 7'],
    'arrow-up':['M12 19V5','m5 12 7-7 7 7'],
    'rotate-cw':['M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8','M21 3v5h-5'],
    theme:['M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13z'],
    list:['M8 6h13','M8 12h13','M8 18h13','M3 6h.01','M3 12h.01','M3 18h.01'],
    grid:['M3 3h7v7H3z','M14 3h7v7h-7z','M3 14h7v7H3z','M14 14h7v7h-7z'],
    panel:['M3 3h18v18H3z','M15 3v18'],
    plus:['M12 5v14','M5 12h14'],
    upload:['M12 16V3','m5 10 7-7 7 7','M4 17v3h16v-3'],
    copy:['M8 4h11a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z','M4 16H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v1'],
    move:['M4 7h16','m15 3 5 4-5 4','M20 17H4','m9 13-5 4 5 4'],
    trash:['M3 6h18','M8 6V4h8v2','M5 6l1 15h12l1-15','M10 10v7','M14 10v7'],
    eraser:['m7 21-4-4a2 2 0 0 1 0-3l10-10a2 2 0 0 1 3 0l5 5a2 2 0 0 1 0 3l-9 9H7z','m7 10 9 9','M12 21h10'],
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
    '#ufs-app .ufs-crumb:last-child{flex:0 1 auto;overflow:hidden}#ufs-app .ufs-crumb-label{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#ufs-app .ufs-address-measure>.ufs-crumb:last-child{flex:0 0 auto;overflow:visible}#ufs-app .ufs-address-measure .ufs-crumb-label{overflow:visible}',
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
    // Pointer-based drag state: never replace the dragged virtual row or alter native files on drop.
    '#ufs-app .ufs-entry.ufs-drag-source,#ufs-app .ufs-entry.ufs-drag-source *{cursor:grabbing!important}#ufs-app .ufs-entry.ufs-drag-ready,#ufs-app .ufs-entry.ufs-drag-ready *{cursor:grab!important}',
    '#ufs-app .ufs-tree-row.ufs-drop-valid,#ufs-app .ufs-entry.ufs-drop-valid,#ufs-app .ufs-address .ufs-crumb.ufs-drop-valid,#ufs-app .ufs-menu[data-ufs-breadcrumb-menu] button.ufs-drop-valid{background:rgba(65,148,220,.14)!important;outline:2px dashed #338bce;outline-offset:-2px;border-radius:4px}#ufs-app .ufs-tree-row.ufs-drop-invalid,#ufs-app .ufs-entry.ufs-drop-invalid,#ufs-app .ufs-address .ufs-crumb.ufs-drop-invalid,#ufs-app .ufs-menu[data-ufs-breadcrumb-menu] button.ufs-drop-invalid{background:rgba(215,74,65,.09)!important;outline:2px dashed #c64b40;outline-offset:-2px;border-radius:4px}#ufs-app .ufs-address .ufs-crumb.ufs-drop-expand{background:rgba(65,148,220,.14)!important;outline:2px dashed #338bce;outline-offset:-2px;border-radius:4px}',
    // Breadcrumb drop targets lift above adjacent crumbs without resizing the 30px address bar.
    // Tree rows, file rows and the overflow breadcrumb menu retain their existing drag styles.
    // Span (share root) and buttons (folders) require identical vertical metrics; avoid clipping inside the 30px scrollable address bar.
    '#ufs-app .ufs-address .ufs-crumb{position:relative;box-sizing:border-box;z-index:1;display:inline-flex;align-items:center;justify-content:flex-start;height:22px;min-height:22px;max-height:22px;line-height:20px;font-family:inherit;font-size:13px;font-weight:400;margin:0;padding:0 6px;transform-origin:center center;transition:transform .17s ease,box-shadow .17s ease,background-color .17s ease,color .17s ease,opacity .17s ease}#ufs-app .ufs-address .ufs-crumb:last-child{font-weight:600}#ufs-app.ufs-drag-active .ufs-address .ufs-crumb:not(.ufs-drop-valid):not(.ufs-drop-invalid):not(.ufs-drop-expand){opacity:.78}#ufs-app.ufs-drag-active .ufs-address>.ufs-svg{opacity:.62}',
    '#ufs-app .ufs-address .ufs-crumb.ufs-drop-valid{background:#fff!important;color:#1b527e!important;outline:1px solid #90c0eb!important;outline-offset:0;transform:translateY(-2px) scale(1.02);box-shadow:0 8px 17px rgba(58,148,212,.24),0 0 0 2px rgba(217,235,255,.95);border-radius:6px;z-index:5;opacity:1!important}',
    '#ufs-app .ufs-address .ufs-crumb.ufs-drop-invalid{background:#fff1ef!important;color:#a9433c!important;outline:1px solid #e0a19c!important;outline-offset:0;transform:translateY(-2px) scale(1.02);box-shadow:0 7px 15px rgba(207,90,82,.16),0 0 0 2px rgba(255,229,226,.85);border-radius:6px;z-index:5;opacity:1!important}',
    '#ufs-app .ufs-address .ufs-crumb.ufs-drop-expand{background:#eaf4ff!important;color:#1b527e!important;outline:1px solid #b3d4f2!important;outline-offset:0;transform:translateY(-2px) scale(1.02);box-shadow:0 5px 12px rgba(58,148,212,.18);border-radius:6px;z-index:5;opacity:1!important}',
    '@media(prefers-reduced-motion:reduce){#ufs-app .ufs-address .ufs-crumb{transition:none!important}}',
    '#ufs-app .ufs-drag-ghost{position:absolute;z-index:2147483630;pointer-events:none;display:flex;align-items:center;gap:8px;padding:8px 11px;border-radius:6px;background:#293a4cee;color:#fff;box-shadow:0 5px 18px #0003;font-size:12px;white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis}#ufs-app.ufs-drag-active .ufs-entry{user-select:none;cursor:grabbing!important}',
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
    "#ufs-app .ufs-copy-fixed-options{flex:0 0 auto;display:flex;flex-direction:column;gap:8px;min-width:0;padding:9px 20px 10px;border-top:1px solid var(--ufs-border);background:var(--ufs-bg)}",
    "#ufs-app .ufs-copy-fixed-options[hidden]{display:none!important}",
    "#ufs-app .ufs-copy-fixed-options .ufs-copy-destination{margin:0;min-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;overflow-wrap:normal}",
    "#ufs-app .ufs-copy-fixed-options .ufs-copy-policy{margin:0;padding-top:7px;gap:14px}",
    "#ufs-app .ufs-batch-speed-row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:20px;font-size:12px;font-variant-numeric:tabular-nums}",
    "#ufs-app .ufs-batch-speed-value{font-weight:600;text-align:right;color:var(--ufs-text);overflow-wrap:anywhere}",
    "#ufs-app .ufs-batch-speed-row[hidden]{display:none!important}",
    // v0.2.6.1: DSM-style outlined radio with a small center dot; protect it from Unraid global input focus styles.
    "#ufs-app .ufs-copy-policy{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-top:12px;padding-top:11px;border-top:1px solid var(--ufs-border);font-size:12px}",
    "#ufs-app .ufs-copy-policy-title{color:var(--ufs-muted);font-weight:500}",
    "#ufs-app .ufs-copy-policy-choice{position:relative;display:inline-flex;align-items:center;gap:6px;min-height:26px;color:var(--ufs-text);cursor:pointer;white-space:nowrap}",
    "#ufs-app .ufs-copy-policy-choice .ufs-copy-policy-radio{position:absolute!important;left:0;top:50%;transform:translateY(-50%);width:18px!important;height:18px!important;min-width:18px!important;margin:0!important;padding:0!important;opacity:0!important;appearance:none!important;outline:none!important;box-shadow:none!important;cursor:pointer;z-index:1}",
    "#ufs-app .ufs-copy-policy-ring{display:inline-flex;align-items:center;justify-content:center;flex:0 0 18px;width:18px;height:18px;border:2px solid #cbd3dd;border-radius:50%;background:var(--ufs-bg);pointer-events:none}",
    "#ufs-app .ufs-copy-policy-radio:checked+.ufs-copy-policy-ring{border-color:var(--ufs-accent)}",
    "#ufs-app .ufs-copy-policy-radio:checked+.ufs-copy-policy-ring::after{content:'';display:block;width:8px;height:8px;border-radius:50%;background:var(--ufs-accent)}",
    "#ufs-app .ufs-copy-policy-choice:hover .ufs-copy-policy-ring{border-color:var(--ufs-accent)}",
    "#ufs-app .ufs-copy-policy-radio:focus-visible+.ufs-copy-policy-ring{box-shadow:0 0 0 3px rgba(235,120,37,.14)}",
    "#ufs-app .ufs-copy-policy-choice::after{content:attr(data-tooltip);position:absolute;bottom:calc(100% + 7px);left:50%;transform:translateX(-50%);width:max-content;max-width:235px;white-space:normal;background:#30363c;color:#fff;font-size:12px;line-height:1.5;font-weight:400;padding:8px 10px;border-radius:5px;box-shadow:0 5px 16px #0003;opacity:0;visibility:hidden;pointer-events:none;z-index:20}",
    "#ufs-app .ufs-copy-policy-choice::before{content:'';position:absolute;bottom:calc(100% + 1px);left:50%;transform:translateX(-50%);border:6px solid transparent;border-bottom:0;border-top-color:#30363c;opacity:0;visibility:hidden;pointer-events:none;z-index:20}",
    // Do not show the focused radio's tooltip while another option is hovered.
    "#ufs-app .ufs-copy-policy-choice:hover::after,#ufs-app .ufs-copy-policy-choice:hover::before,#ufs-app .ufs-copy-policy:not(:has(.ufs-copy-policy-choice:hover)) .ufs-copy-policy-choice:has(.ufs-copy-policy-radio:focus-visible)::after,#ufs-app .ufs-copy-policy:not(:has(.ufs-copy-policy-choice:hover)) .ufs-copy-policy-choice:has(.ufs-copy-policy-radio:focus-visible)::before{opacity:1;visibility:visible}",
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
    "#ufs-app .ufs-status .ufs-status-hint{margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}#ufs-app .ufs-status .ufs-count{flex:0 0 auto;max-width:48%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#ufs-app .ufs-status .ufs-copy-task-trigger{flex:0 0 auto;max-width:55%;height:24px;min-height:24px;margin:0;padding:1px 9px;border:1px solid #f4d7c3;border-radius:4px;background:var(--ufs-accent-soft);color:var(--ufs-accent);font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#ufs-app .ufs-status .ufs-copy-task-trigger:hover{background:#fce1cb}#ufs-app .ufs-status .ufs-copy-task-trigger[data-phase=success]{background:#eaf7ef;color:#258755;border-color:#cdebd9}#ufs-app .ufs-status .ufs-copy-task-trigger[data-phase=uncertain],#ufs-app .ufs-status .ufs-copy-task-trigger[data-phase=failed]{background:#fff1e4;color:#a74c13}",
    "#ufs-app .ufs-copy-task-trigger[hidden],#ufs-app .ufs-copy-background[hidden],#ufs-app .ufs-copy-cancel[hidden]{display:none!important}",
    "#ufs-app .ufs-copy-background{display:inline-flex;align-items:center;justify-content:center;height:34px;min-height:34px;min-width:85px;margin:0;padding:6px 10px;border:1px solid var(--ufs-border);border-radius:5px;background:var(--ufs-bg);color:var(--ufs-text);font-size:12px}",
    "#ufs-app .ufs-copy-current-file{min-height:18px;margin-top:10px;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ufs-text)}",
    "#ufs-app .ufs-copy-progress-metrics{min-height:18px;margin-top:4px;font-size:12px;color:var(--ufs-muted);font-variant-numeric:tabular-nums}",
    "#ufs-app .ufs-copy-progress-panel[data-phase=success] .ufs-copy-progress-note{color:#34895e}",
    "#ufs-app .ufs-copy-progress-panel[data-phase=success] .ufs-copy-progress-track{background:#d8f2e2}",
    "#ufs-app .ufs-copy-progress-panel[data-phase=cancelled] .ufs-copy-progress-fill{animation:none}",
    "@media(max-width:560px){#ufs-app .ufs-copy-background{min-width:70px;padding:6px 7px}#ufs-app .ufs-copy-progress-stages{font-size:10px}}",

    // v0.2.4 batch copy: keep the 52px header, 64px footer, and one scrollable body.
    "#ufs-app .ufs-batch-summary-heading{font-size:12px;color:var(--ufs-muted);margin-bottom:8px}#ufs-app .ufs-batch-preview{background:var(--ufs-panel);border:1px solid var(--ufs-border);padding:8px 10px;border-radius:5px;display:flex;flex-direction:column;gap:8px;min-width:0}#ufs-app .ufs-batch-preview-row{display:flex;align-items:center;gap:8px;min-width:0;font-size:12px}#ufs-app .ufs-batch-preview-row span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}#ufs-app .ufs-batch-open-list{display:block;margin:7px 0 0 auto;padding:3px 0;border:0;background:transparent;color:var(--ufs-accent);font-size:12px;cursor:pointer}",
    "#ufs-app .ufs-batch-panel{display:flex;flex-direction:column;gap:12px;min-width:0}#ufs-app .ufs-batch-line{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:13px}#ufs-app .ufs-batch-percent{font-weight:650;font-size:19px;color:var(--ufs-accent);font-variant-numeric:tabular-nums}#ufs-app .ufs-batch-track{height:10px;border-radius:10px;background:var(--ufs-border);overflow:hidden}#ufs-app .ufs-batch-fill{height:100%;width:0;border-radius:10px;background:var(--ufs-accent);transition:width .2s ease-out}#ufs-app .ufs-batch-meta{font-size:12px;color:var(--ufs-muted)}#ufs-app .ufs-batch-current{background:var(--ufs-panel);border-radius:5px;padding:12px;overflow-wrap:anywhere;font-size:12px;display:flex;flex-direction:column;gap:6px}#ufs-app .ufs-batch-current-name{font-size:13px;font-weight:600;color:var(--ufs-text)}#ufs-app .ufs-batch-stats{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--ufs-muted)}",
    "#ufs-app .ufs-batch-list-back{align-self:flex-start;display:flex;align-items:center;gap:5px;border:0;background:transparent;color:var(--ufs-accent);padding:3px 0;font-size:12px}#ufs-app .ufs-batch-list-search{height:33px;flex:0 0 33px;width:100%;min-width:0;border:1px solid var(--ufs-border);border-radius:4px;padding:6px 9px;background:var(--ufs-bg);color:var(--ufs-text)}#ufs-app .ufs-batch-list-scroll{height:min(320px,40vh);min-height:120px;max-height:40vh;overflow-y:auto;overscroll-behavior:contain;border:1px solid var(--ufs-border);border-radius:5px}#ufs-app .ufs-batch-list-row{display:flex;align-items:center;gap:7px;min-width:0;min-height:36px;padding:6px 8px;border-bottom:1px solid var(--ufs-border)}#ufs-app .ufs-batch-list-row[data-status=copying]{background:var(--ufs-accent-soft)}#ufs-app .ufs-batch-list-index{flex:0 0 26px;color:var(--ufs-muted);font-size:11px}#ufs-app .ufs-batch-list-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}#ufs-app .ufs-batch-list-state{flex:0 0 auto;font-size:11px;color:var(--ufs-muted)}#ufs-app .ufs-batch-list-row[data-status=success] .ufs-batch-list-state{color:#258755}#ufs-app .ufs-batch-list-row[data-status=failed] .ufs-batch-list-state,#ufs-app .ufs-batch-list-row[data-status=uncertain] .ufs-batch-list-state{color:#c13d37}",
    "#ufs-app .ufs-batch-stop-choices{border:1px solid var(--ufs-border);border-radius:5px;padding:10px;display:flex;flex-direction:column;gap:8px}#ufs-app .ufs-batch-stop-choices button{padding:7px 9px;border:1px solid var(--ufs-border);border-radius:5px;background:var(--ufs-bg);color:var(--ufs-text);text-align:left}#ufs-app .ufs-batch-stop-choices button:hover{background:var(--ufs-hover)}#ufs-app .ufs-batch-warning{color:#a74c13;font-size:12px;overflow-wrap:anywhere}#ufs-app .ufs-batch-result-title{font-weight:600;font-size:14px}#ufs-app .ufs-batch-result-title[data-phase=success]{color:#258755}#ufs-app .ufs-batch-result-title[data-phase=uncertain]{color:#c13d37}",
    // v0.2.7.5: shared layout tokens for single-entry and batch-copy progress.
    "#ufs-app .ufs-unified-progress .ufs-copy-progress-status{margin:16px 0 8px;gap:12px}",
    "#ufs-app .ufs-unified-progress .ufs-copy-progress-state-text{font-size:13px;font-weight:600}",
    "#ufs-app .ufs-unified-progress .ufs-copy-progress-indicator,#ufs-app .ufs-unified-progress .ufs-batch-percent{font-size:19px;font-weight:650;color:var(--ufs-accent);font-variant-numeric:tabular-nums}",
    "#ufs-app .ufs-unified-progress .ufs-copy-progress-track,#ufs-app .ufs-unified-progress .ufs-batch-track{height:8px;border-radius:8px;background:var(--ufs-panel);overflow:hidden}",
    "#ufs-app .ufs-unified-progress .ufs-batch-fill{background:var(--ufs-accent);border-radius:8px}",
    "#ufs-app .ufs-unified-meta{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:8px;color:var(--ufs-muted);font-size:11px;line-height:1.5}",
    "#ufs-app .ufs-unified-meta span:last-child{text-align:right}",
    "#ufs-app .ufs-unified-progress .ufs-copy-progress-stages{margin:14px 0 13px;font-size:11px}",
    "#ufs-app .ufs-unified-current{background:var(--ufs-panel);border-radius:5px;padding:12px;display:flex;flex-direction:column;gap:0;min-width:0;margin-top:3px}",
    "#ufs-app .ufs-unified-current-top{display:flex;justify-content:space-between;gap:8px;color:var(--ufs-muted);font-size:11px;margin-bottom:7px}",
    "#ufs-app .ufs-unified-current-name{font-weight:600;font-size:13px;color:var(--ufs-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}",
    "#ufs-app .ufs-unified-current .ufs-copy-current-file{margin-top:6px;min-height:0;color:var(--ufs-muted);font-size:11px}",
    "#ufs-app .ufs-unified-metrics{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px;border-top:1px solid var(--ufs-border);padding-top:11px;margin-top:11px;min-height:0}",
    "#ufs-app .ufs-unified-metric,#ufs-app .ufs-unified-progress .ufs-batch-speed-row{display:flex;flex-direction:column;align-items:flex-start;justify-content:flex-start;gap:4px;min-width:0;color:var(--ufs-muted);font-size:11px}",
    "#ufs-app .ufs-unified-metric strong,#ufs-app .ufs-unified-progress .ufs-batch-speed-value{font-size:16px;font-weight:650;line-height:1.35;color:var(--ufs-text);text-align:left;word-break:break-word;overflow-wrap:anywhere}",
    "#ufs-app .ufs-unified-transfer{grid-column:1/-1;color:var(--ufs-muted);font-size:11px}",
    "#ufs-app .ufs-unified-file-percent{margin-top:4px;color:var(--ufs-accent);font-size:11px;font-variant-numeric:tabular-nums}",
    "#ufs-app .ufs-unified-file-percent[hidden]{display:none!important}",
    "#ufs-app .ufs-unified-progress .ufs-batch-current{gap:0;overflow:visible}",
    "#ufs-app .ufs-unified-progress .ufs-batch-current-name{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    "#ufs-app .ufs-unified-progress .ufs-batch-current-info{margin-top:4px}",
    "#ufs-app .ufs-unified-progress .ufs-copy-progress-note,#ufs-app .ufs-unified-progress .ufs-batch-warning{margin-top:11px;font-size:11px;line-height:1.6}",
    "#ufs-app .ufs-unified-progress .ufs-batch-stats{margin-top:11px}",
    "#ufs-app .ufs-unified-progress .ufs-batch-open-list{margin:10px 0 0 auto}",
    "#ufs-app .ufs-unified-progress[data-phase=success] .ufs-batch-fill{background:#34895e}",
    "@media(max-width:470px){#ufs-app .ufs-unified-current{padding:10px}#ufs-app .ufs-unified-metric strong,#ufs-app .ufs-unified-progress .ufs-batch-speed-value{font-size:14px}}",
    // v0.2.5.1: show every preflight conflict above the destination picker.
    "#ufs-app .ufs-preflight-notice{display:flex;flex-direction:column;gap:8px;border:1px solid #eac7c1;border-radius:6px;padding:12px;background:var(--ufs-bg);min-width:0}#ufs-app .ufs-preflight-notice[hidden]{display:none!important}#ufs-app .ufs-preflight-head{display:flex;align-items:center;gap:8px;color:#b34231;font-size:14px}#ufs-app .ufs-preflight-head .ufs-svg{flex:0 0 18px;width:18px;height:18px}#ufs-app .ufs-preflight-detail,#ufs-app .ufs-preflight-advice{font-size:12px;line-height:1.55;color:var(--ufs-text);overflow-wrap:anywhere}#ufs-app .ufs-preflight-conflicts{max-height:152px;overflow:auto;overscroll-behavior:contain;border:1px solid var(--ufs-border);border-radius:5px;padding:3px 8px}#ufs-app .ufs-preflight-conflicts[hidden]{display:none!important}#ufs-app .ufs-preflight-conflict-row{display:flex;align-items:flex-start;gap:7px;min-width:0;padding:6px 2px;border-bottom:1px solid var(--ufs-border);font-size:12px;color:var(--ufs-text)}#ufs-app .ufs-preflight-conflict-row:last-child{border-bottom:0}#ufs-app .ufs-preflight-conflict-row>span{min-width:0;overflow-wrap:anywhere}#ufs-app .ufs-preflight-conflict-row .ufs-svg{flex:0 0 15px;width:15px;height:15px}#ufs-app .ufs-preflight-checking{display:flex;align-items:center;gap:12px;padding:16px 4px;min-height:110px}#ufs-app .ufs-preflight-checking-icon{width:21px;height:21px;color:var(--ufs-accent);flex:0 0 21px;animation:ufs-copy-spin 1.4s linear infinite}#ufs-app .ufs-preflight-checking-body{display:flex;flex-direction:column;gap:8px;color:var(--ufs-text);font-size:13px}#ufs-app .ufs-preflight-checking-detail{font-size:12px;color:var(--ufs-muted);line-height:1.5}@media(prefers-reduced-motion:reduce){#ufs-app .ufs-preflight-checking-icon{animation:none}}",
    // v0.2.5: scheme-A task badge and bottom-right multi-task center.
    "#ufs-app .ufs-status .ufs-copy-task-trigger{display:inline-flex;align-items:center;justify-content:center;gap:5px;max-width:56%;flex:0 0 auto;padding:1px 8px;font-size:11px}#ufs-app .ufs-status .ufs-copy-task-trigger[hidden]{display:none!important}#ufs-app .ufs-copy-task-trigger>.ufs-svg{height:13px;width:13px;flex:0 0 13px}#ufs-app .ufs-task-badge-main{color:inherit;white-space:nowrap}#ufs-app .ufs-task-badge-divider{width:1px;height:13px;background:#e8c6aa;flex:0 0 1px;margin:0 1px}#ufs-app .ufs-task-badge-wait{display:inline-flex;align-items:center;gap:3px;color:inherit}#ufs-app .ufs-task-badge-wait>.ufs-svg{height:12px;width:12px}#ufs-app .ufs-task-badge-chevron{margin-left:1px}#ufs-app .ufs-status .ufs-copy-task-trigger[data-phase=paused]{background:#fff1e4;color:#a74c13}#ufs-app .ufs-status .ufs-copy-task-trigger[data-phase=queued]{background:#f0f2f5;color:#4f5b6a;border-color:#d9dfe6}",
    "#ufs-app .ufs-copy-task-center{position:absolute;right:10px;bottom:37px;z-index:2147483635;width:min(355px,calc(100% - 20px));max-height:min(405px,65vh);display:flex;flex-direction:column;background:var(--ufs-bg);border:1px solid var(--ufs-border);border-radius:9px;box-shadow:0 12px 30px #0003;overflow:hidden}#ufs-app .ufs-task-center-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex:0 0 43px;padding:0 12px;border-bottom:1px solid var(--ufs-border);font-size:13px;color:var(--ufs-text)}#ufs-app .ufs-task-center-close{border:0;background:transparent;font-size:20px;color:var(--ufs-muted);padding:3px 6px}#ufs-app .ufs-task-center-body{overflow-y:auto;min-height:0;padding:5px 9px}#ufs-app .ufs-task-center-row{display:flex;flex-direction:column;gap:4px;padding:9px 5px;border-bottom:1px solid var(--ufs-border)}#ufs-app .ufs-task-center-open{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;border:0;background:transparent;color:var(--ufs-text);padding:2px;min-width:0;text-align:left}#ufs-app .ufs-task-center-open:hover{color:var(--ufs-accent)}#ufs-app .ufs-task-center-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}#ufs-app .ufs-task-center-status{flex:0 0 auto;font-size:11px;color:var(--ufs-muted)}#ufs-app .ufs-task-center-row[data-status=running] .ufs-task-center-status{color:var(--ufs-accent)}#ufs-app .ufs-task-center-row[data-status=success] .ufs-task-center-status{color:#258755}#ufs-app .ufs-task-center-row[data-status=failed] .ufs-task-center-status,#ufs-app .ufs-task-center-row[data-status=uncertain] .ufs-task-center-status{color:#c13d37}#ufs-app .ufs-task-center-progress{height:5px;background:var(--ufs-border);border-radius:9px;overflow:hidden}#ufs-app .ufs-task-center-progress-fill{height:100%;background:var(--ufs-accent)}#ufs-app .ufs-task-center-remove{align-self:flex-end;padding:3px 7px;background:var(--ufs-bg);border:1px solid var(--ufs-border);border-radius:4px;color:var(--ufs-muted);font-size:11px}#ufs-app .ufs-task-center-paused{padding:11px 12px;border-top:1px solid var(--ufs-border);font-size:12px;color:var(--ufs-muted);display:flex;flex-direction:column;gap:8px}#ufs-app .ufs-task-center-paused button{border:1px solid var(--ufs-border);background:var(--ufs-panel);border-radius:5px;padding:7px;color:var(--ufs-text)}",
    "#ufs-app .ufs-task-center-head{gap:8px}#ufs-app .ufs-task-center-head>strong{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#ufs-app .ufs-task-center-actions{display:flex;align-items:center;gap:5px;flex:0 0 auto}#ufs-app .ufs-task-center-divider{width:1px;height:14px;margin:0 3px;background:var(--ufs-border)}#ufs-app .ufs-task-center-icon{position:relative;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;min-width:28px;min-height:28px;flex:0 0 28px;margin:0;padding:5px;border:0;background:transparent;color:var(--ufs-muted)}#ufs-app .ufs-task-center-icon:hover:not(:disabled){background:var(--ufs-hover);color:var(--ufs-text)}#ufs-app .ufs-task-center-icon>.ufs-svg{width:16px;height:16px}#ufs-app .ufs-task-center-line{display:flex;align-items:center;gap:7px;min-height:28px}#ufs-app .ufs-task-center-open{flex:1;width:auto;margin:0}#ufs-app .ufs-task-center-slot{width:28px;flex:0 0 28px}#ufs-app .ufs-task-center-cleanup-error{padding:9px 12px;border-top:1px solid var(--ufs-border);color:#c13d37;font-size:12px;overflow-wrap:anywhere}#ufs-app .ufs-task-center-cleanup-error[hidden]{display:none}",
    "#ufs-app .ufs-task-center-tooltip{position:absolute;width:max-content;padding:6px 8px;border:1px solid var(--ufs-border);border-radius:5px;background:var(--ufs-panel);color:var(--ufs-text);font-size:11px;line-height:1.4;white-space:normal;pointer-events:none;z-index:2}#ufs-app .ufs-task-center-tooltip[hidden]{display:none}@media(pointer:coarse){#ufs-app .ufs-task-center-icon{width:44px;height:44px;min-width:44px;min-height:44px;flex-basis:44px}#ufs-app .ufs-task-center-slot{width:44px;flex-basis:44px}#ufs-app .ufs-task-center-head{flex-basis:52px}}",
    // v0.2.6.2: task-center rate, phase icons and persistent spinner nodes.
    "#ufs-app .ufs-task-live-spinner{box-sizing:border-box;display:inline-block;flex:0 0 14px;width:14px;height:14px;border:2px solid rgba(235,120,37,.22);border-top-color:var(--ufs-accent);border-radius:50%;animation:ufs-copy-spin .9s linear infinite}",
    "#ufs-app .ufs-task-center-state{display:inline-flex;align-items:center;gap:5px;flex:0 0 auto;white-space:nowrap}#ufs-app .ufs-task-center-state>.ufs-svg{height:13px;width:13px;flex:0 0 13px;color:var(--ufs-muted)}",
    "#ufs-app .ufs-task-center-row[data-status=success] .ufs-task-center-state>.ufs-svg{color:#258755}#ufs-app .ufs-task-center-row[data-partial=true] .ufs-task-center-state>.ufs-svg{color:#b16b23}#ufs-app .ufs-task-center-row[data-status=failed] .ufs-task-center-state>.ufs-svg,#ufs-app .ufs-task-center-row[data-status=uncertain] .ufs-task-center-state>.ufs-svg{color:#c13d37}",
    "#ufs-app .ufs-task-center-meta{text-align:right;min-height:14px;line-height:1.3;font-size:11px;color:var(--ufs-muted);font-variant-numeric:tabular-nums}#ufs-app .ufs-task-center-meta-muted{color:var(--ufs-muted)}#ufs-app .ufs-task-center-name{font-size:12px}",
    "#ufs-app .ufs-status .ufs-copy-task-trigger[data-phase=running]{max-width:75%}#ufs-app .ufs-task-badge-percent,#ufs-app .ufs-task-badge-speed{white-space:nowrap;font-variant-numeric:tabular-nums}#ufs-app .ufs-task-badge-spinner{flex:0 0 13px;width:13px;height:13px;border-width:1.8px}",
    "@media(max-width:720px){#ufs-app .ufs-status .ufs-copy-task-trigger[data-phase=running]{max-width:84%}#ufs-app .ufs-task-badge-percent{display:none!important}}",
    "@media(prefers-reduced-motion:reduce){#ufs-app .ufs-task-live-spinner{animation:none}}",
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
    '#ufs-app .ufs-create-dialog .ufs-create-fields,#ufs-app .ufs-copy-picker,#ufs-app .ufs-task-center-body{scrollbar-width:thin;scrollbar-color:transparent transparent}',
    '#ufs-app .ufs-create-dialog .ufs-create-fields:hover,#ufs-app .ufs-create-dialog .ufs-create-fields.ufs-scroll-active,#ufs-app .ufs-copy-picker:hover,#ufs-app .ufs-copy-picker.ufs-scroll-active,#ufs-app .ufs-task-center-body:hover,#ufs-app .ufs-task-center-body.ufs-scroll-active{scrollbar-color:rgba(105,115,126,.48) transparent}',
    '#ufs-app .ufs-create-dialog .ufs-create-fields::-webkit-scrollbar,#ufs-app .ufs-copy-picker::-webkit-scrollbar,#ufs-app .ufs-task-center-body::-webkit-scrollbar{width:6px;height:6px;background:transparent}',
    '#ufs-app .ufs-create-dialog .ufs-create-fields::-webkit-scrollbar-track,#ufs-app .ufs-copy-picker::-webkit-scrollbar-track,#ufs-app .ufs-task-center-body::-webkit-scrollbar-track{background:transparent}',
    '#ufs-app .ufs-create-dialog .ufs-create-fields::-webkit-scrollbar-thumb,#ufs-app .ufs-copy-picker::-webkit-scrollbar-thumb,#ufs-app .ufs-task-center-body::-webkit-scrollbar-thumb{background:transparent;border-radius:8px}',
    '#ufs-app .ufs-create-dialog .ufs-create-fields:hover::-webkit-scrollbar-thumb,#ufs-app .ufs-create-dialog .ufs-create-fields.ufs-scroll-active::-webkit-scrollbar-thumb,#ufs-app .ufs-copy-picker:hover::-webkit-scrollbar-thumb,#ufs-app .ufs-copy-picker.ufs-scroll-active::-webkit-scrollbar-thumb,#ufs-app .ufs-task-center-body:hover::-webkit-scrollbar-thumb,#ufs-app .ufs-task-center-body.ufs-scroll-active::-webkit-scrollbar-thumb{background:rgba(105,115,126,.48)}',
    '#ufs-app .ufs-create-dialog .ufs-create-fields::-webkit-scrollbar-thumb:hover,#ufs-app .ufs-copy-picker::-webkit-scrollbar-thumb:hover,#ufs-app .ufs-task-center-body::-webkit-scrollbar-thumb:hover{background:rgba(94,104,115,.7)}',
    '#ufs-app .ufs-create-dialog .ufs-create-fields::-webkit-scrollbar-corner,#ufs-app .ufs-copy-picker::-webkit-scrollbar-corner,#ufs-app .ufs-task-center-body::-webkit-scrollbar-corner{background:transparent}',
    // Hovering the inner picker should not illuminate the outer body's scrollbar.
    '#ufs-app .ufs-copy-dialog .ufs-create-fields:has(.ufs-copy-picker:hover){scrollbar-color:transparent transparent}',
    '#ufs-app .ufs-copy-dialog .ufs-create-fields:has(.ufs-copy-picker:hover)::-webkit-scrollbar-thumb{background:transparent}',

    '#ufs-app .ufs-menu .ufs-location-copy{width:auto;flex:0 0 auto;white-space:nowrap;padding:4px 9px;font-size:12px;color:var(--ufs-accent);border:1px solid var(--ufs-border)}',
    '.ufs-hide-native{display:none!important}#ufs-app[hidden],#ufs-native-controls[hidden]{display:none!important}#ufs-native-controls{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin:8px}#ufs-native-enable{margin:0;padding:7px 12px;background:#e87526;color:#fff;border:0;border-radius:5px;cursor:pointer}#ufs-native-readonly-note,#ufs-native-refresh-note{font-size:12px;line-height:1.5;color:#a74c13}#ufs-native-readonly-note[hidden],#ufs-native-refresh-note[hidden],#ufs-native-refresh-retry[hidden]{display:none!important}#ufs-native-refresh-retry{padding:4px 9px;border:1px solid #dfbb9f;border-radius:4px;background:#fff7f0;color:#a74c13;cursor:pointer}',
    // Pointer focus should not leave a colored ring after details is closed.
    // Preserve the visible outline for keyboard navigation using :focus-visible.
    '#ufs-app button:focus:not(:focus-visible){outline:none!important;box-shadow:none!important}#ufs-app .ufs-details-button:focus:not(:focus-visible){outline:none!important;box-shadow:none!important}',
    // Unraid styles can shift button baselines; stretch table-header cells then
    // center the sort button's contents explicitly inside the header's fixed height.
    '#ufs-app .ufs-head{align-items:stretch;padding-top:0;padding-bottom:0}#ufs-app .ufs-head>span{display:flex;align-items:center;min-width:0;height:100%;margin:0;padding:0;vertical-align:middle}#ufs-app .ufs-head .ufs-sort-button{display:inline-flex;align-items:center;justify-content:flex-start;width:100%;height:100%;min-height:0;margin:0;padding:0;line-height:1.3;vertical-align:middle}',
    '#ufs-app .ufs-location-col{display:flex;align-items:center;min-width:0;overflow:hidden;white-space:nowrap}#ufs-app .ufs-entry .ufs-location-trigger{display:inline-flex;align-items:center;gap:4px;width:100%;min-width:0;max-width:100%;height:30px;min-height:0;overflow:hidden;padding:0;border:0;background:transparent;border-radius:0;text-align:left;color:var(--ufs-text);font-size:12px;font-weight:400;line-height:1.4;cursor:pointer!important}#ufs-app .ufs-entry .ufs-location-trigger:hover{color:var(--ufs-accent);background:transparent}#ufs-app .ufs-location-text{white-space:nowrap;overflow:hidden;text-overflow:clip;flex:0 1 auto;min-width:0}#ufs-app .ufs-location-ellipsis{white-space:nowrap;flex-shrink:0;color:var(--ufs-muted)}#ufs-app .ufs-location-more-link{color:var(--ufs-accent);font-size:11px;flex:0 0 auto;white-space:nowrap;text-decoration:underline;text-underline-offset:2px}#ufs-app .ufs-location-popover{width:min(440px,calc(100vw - 20px));max-width:none;padding:0;overflow:hidden}#ufs-app .ufs-location-popover-header{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--ufs-border);font-weight:600}#ufs-app .ufs-menu .ufs-location-popover-close{display:inline-flex;align-items:center;justify-content:center;flex:0 0 28px;width:28px;height:28px;min-width:28px;padding:0;border:0;background:transparent;color:var(--ufs-muted);text-align:center}#ufs-app .ufs-location-popover-items{display:grid;grid-template-columns:repeat(auto-fill,minmax(85px,1fr));gap:6px;padding:12px;max-height:min(300px,50vh);overflow-y:auto;overscroll-behavior:contain}#ufs-app .ufs-location-device{padding:6px 8px;border-radius:4px;background:var(--ufs-panel);font-size:12px;overflow-wrap:anywhere}#ufs-app .ufs-owner{min-width:0;overflow:hidden;text-overflow:ellipsis}',
    '@media(max-width:720px){#ufs-app .ufs-sidebar{width:42px;flex-basis:42px;padding:4px}#ufs-app .ufs-resizer{display:none}#ufs-app .ufs-sidebar .ufs-tree-name,#ufs-app .ufs-tree-label,#ufs-app .ufs-tree-toggle,#ufs-app .ufs-sidebar .ufs-tree-spacer{display:none}#ufs-app .ufs-search{width:90px}}',
    '#ufs-app .ufs-top{height:46px;gap:9px;padding:0 12px}#ufs-app .ufs-brand{display:flex;align-items:center;gap:7px;flex-shrink:0;white-space:nowrap}#ufs-app .ufs-heading{font-size:15px}#ufs-app .ufs-brand-divider{height:19px;width:1px;background:var(--ufs-border);flex-shrink:0}#ufs-app .ufs-preview-chip{font-size:11px;color:var(--ufs-muted);white-space:nowrap}#ufs-app .ufs-app-actions{display:flex;align-items:center;gap:3px;flex-shrink:0}',
    '#ufs-app .ufs-delete-list{max-height:230px;overflow:auto;min-height:0;border:1px solid var(--ufs-border);border-radius:5px;padding:6px}#ufs-app .ufs-delete-warning{display:flex;align-items:flex-start;gap:8px;color:#b53c34;line-height:1.5}#ufs-app .ufs-delete-acknowledge{display:flex;align-items:center;gap:8px;cursor:pointer}#ufs-app .ufs-delete-acknowledge input{width:16px;height:16px;accent-color:#c73f37}#ufs-app .ufs-delete-submit:not(:disabled){background:#c73f37;border-color:#c73f37;color:#fff}#ufs-app .ufs-delete-submit:hover:not(:disabled){background:#b4332c}',
    '#ufs-app .ufs-app-actions>.ufs-ico{flex:0 0 32px;width:32px;min-width:32px;height:32px;min-height:32px;max-height:32px;margin:0;padding:0;border-radius:6px}#ufs-app .ufs-app-actions>.ufs-ico>.ufs-svg{width:20px;height:20px;min-width:20px;stroke-width:1.8}',
    '@keyframes ufs-refresh-spin{to{transform:rotate(360deg)}}#ufs-app .ufs-app-actions>.ufs-refresh.ufs-spinning{opacity:1}#ufs-app .ufs-app-actions>.ufs-refresh.ufs-spinning>.ufs-svg{animation:ufs-refresh-spin 1s linear infinite;transform-origin:center}',
    '@media(prefers-reduced-motion:reduce){#ufs-app .ufs-app-actions>.ufs-refresh.ufs-spinning>.ufs-svg{animation:none}}',
    '#ufs-app .ufs-top .ufs-tabs{display:flex;align-items:center;flex:1;min-width:0;height:100%;gap:4px;padding:0;background:transparent;border:0;overflow-x:auto;overflow-y:hidden;scrollbar-width:none}#ufs-app .ufs-top .ufs-tabs::-webkit-scrollbar{display:none}#ufs-app .ufs-top .ufs-tab{flex-shrink:0;height:31px;min-width:85px;max-width:195px;padding:4px 8px}#ufs-app .ufs-top .ufs-tabs>.ufs-ico{flex:0 0 auto}',
    '#ufs-app .ufs-file-actions{display:flex;align-items:center;gap:5px;height:34px;min-height:34px;max-height:34px;flex-shrink:0;padding:0 10px;border-bottom:1px solid var(--ufs-border);background:var(--ufs-bg);overflow:hidden}#ufs-app .ufs-file-actions .ufs-view-controls{display:flex;align-items:center;gap:3px;margin-left:auto;flex-shrink:0}#ufs-app .ufs-file-actions .ufs-ico{height:28px;min-height:0;padding:3px 8px}',
    // v0.2.3.15: Treat only the two file-action buttons as one compact pair.
    // Explicit dimensions and margins isolate them from Unraid's global button styles.
    '#ufs-app .ufs-file-actions .ufs-create-trigger,#ufs-app .ufs-file-actions .ufs-operations{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;gap:5px;box-sizing:border-box;width:auto;min-width:0;height:28px;min-height:28px;max-height:28px;margin:0;padding:0 10px;border:1px solid transparent;border-radius:5px;background:#e8edf1;color:var(--ufs-text);font-size:13px;font-weight:500;line-height:1.4;white-space:nowrap}',
    // The toolbar has a 5px general gap: add 1px to this pair only.
    '#ufs-app .ufs-file-actions .ufs-create-trigger{margin-right:1px}',
    '#ufs-app .ufs-file-actions .ufs-create-trigger:hover:not(:disabled),#ufs-app .ufs-file-actions .ufs-operations:hover:not(:disabled){background:#d5dce2}',
    '#ufs-app .ufs-file-actions .ufs-operations>.ufs-svg{flex:0 0 16px;width:16px;height:16px;min-width:16px;vertical-align:middle}',
    '#ufs-app .ufs-search-wrap{display:flex;align-items:center;gap:3px;min-width:0;flex-shrink:0;margin-left:auto}#ufs-app .ufs-search{width:150px;min-width:0;max-width:none}#ufs-app [hidden]{display:none!important}',
    '@media(max-width:850px){#ufs-app .ufs-preview-chip{display:none}#ufs-app .ufs-search{width:115px}}',
    '.ufs-diagnostic-overlay{position:fixed;inset:0;z-index:2147483640;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}',
    '.ufs-diagnostic-panel{box-sizing:border-box;width:min(860px,100%);max-height:90vh;display:flex;flex-direction:column;gap:12px;border-radius:12px;padding:18px;background:#20252c;color:#e8edf3;box-shadow:0 15px 65px rgba(0,0,0,.45);font:13px/1.5 system-ui,sans-serif}',
    '.ufs-diagnostic-head{display:flex;justify-content:space-between;align-items:center;font-size:16px}.ufs-diagnostic-head button{font-size:23px;min-width:32px}',
    '.ufs-diagnostic-panel p{margin:0;color:#b8c2cf}.ufs-diagnostic-controls{display:flex;flex-wrap:wrap;gap:8px}',
    '.ufs-diagnostic-controls button,.ufs-diagnostic-head button{cursor:pointer;border:1px solid #5c6472;border-radius:6px;background:#303741;color:#f2f5f9;padding:7px 10px}',
    '.ufs-diagnostic-controls .ufs-diagnostic-primary{background:#2563a5;border-color:#2563a5;color:white}.ufs-diagnostic-controls button:focus-visible{outline:2px solid #fbbf24}',
    '.ufs-diagnostic-status{color:#cad5e2}.ufs-diagnostic-events{margin:0;overflow:auto;max-height:55vh;min-height:220px;white-space:pre-wrap;overflow-wrap:anywhere;background:#10151b;color:#cbd5e1;border-radius:8px;padding:12px;font:12px/1.6 ui-monospace,monospace}',
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

  // v0.2.8: local-only diagnostic timeline; it never authorizes or changes native writes.
  const DIAGNOSTIC_VERSION='0.2.13.9';
  const DIAGNOSTIC_DATABASE='ufs-diagnostics-v1';
  const DIAGNOSTIC_MAX_EVENTS=2500;
  const DIAGNOSTIC_RETENTION=24*60*60*1000;
  const diagnosticSessionId='session_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,10);
  const diagnosticTabId=(()=>{
    try {
      const key=STORE+'diagnostic-tab';
      let value=window.sessionStorage?.getItem(key);
      if(!value) {
        value='tab_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,10);
        window.sessionStorage?.setItem(key,value);
      }
      return value;
    } catch (_) { return 'tab_'+Math.random().toString(36).slice(2,10); }
  })();
  const diagnosticSalt=(()=>{
    try {
      const key=STORE+'diagnostic-salt';
      let value=localStorage.getItem(key);
      if(!value) {
        value=Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);
        localStorage.setItem(key,value);
      }
      return value;
    } catch (_) { return diagnosticSessionId; }
  })();
  let diagnosticCounter=0;
  let diagnosticDbPromise=null;
  let diagnosticFlushTimer=null;
  let diagnosticWriteTail=Promise.resolve();
  let diagnosticStorageError='';
  let diagnosticWritten=0;
  const diagnosticMemory=[];
  const diagnosticPending=[];
  function diagnosticPathId(value) {
    let h=2166136261;
    for(const ch of diagnosticSalt+':'+String(value)) {
      h=Math.imul(h^ch.charCodeAt(0),16777619)>>>0;
    }
    return 'path_'+h.toString(36);
  }
  function diagnosticScrub(text) {
    return String(text).slice(0,750)
      .replace(/(csrf_token|authorization|password|cookie|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*[^,\s;&]+/gi,'$1=[REDACTED]')
      .replace(/https?:\/\/[^\s"'<>]+/gi,'[URL]')
      .replace(/\/(?:mnt\/(?:user|disk\d+|cache)|boot)(?:\/[^\s"'<>]*)?/g,
        path=>'[PATH:'+diagnosticPathId(path)+']');
  }
  function diagnosticSanitize(value,key='',depth=0) {
    if(/token|cookie|password|secret|authorization|credential|csrf|header|body|requestPayload/i.test(key))
      return '[REDACTED]';
    if(value===null || typeof value==='boolean') return value;
    if(typeof value==='number') return Number.isFinite(value)?value:null;
    if(typeof value==='string') {
      if(/^(?:source|target|path|destination|dir|filename|name|file|currentFile)$/i.test(key))
        return '[PATH:'+diagnosticPathId(value)+']';
      return diagnosticScrub(value);
    }
    if(depth>=4) return '[DEPTH-LIMIT]';
    if(Array.isArray(value)) return value.slice(0,30)
      .map(item=>diagnosticSanitize(item,key,depth+1));
    if(value && typeof value==='object') {
      const clean={};
      for(const k of Object.keys(value).slice(0,45))
        clean[k]=diagnosticSanitize(value[k],k,depth+1);
      return clean;
    }
    return String(value).slice(0,60);
  }
  function diagnosticIsVerbose() {
    try { return Number(localStorage.getItem(STORE+'diagnostic-verbose-until'))>Date.now(); }
    catch (_) { return false; }
  }
  function diagnosticSetVerbose(enabled) {
    try { localStorage.setItem(STORE+'diagnostic-verbose-until',
      enabled?String(Date.now()+15*60*1000):'0'); }
    catch (_) { /* Diagnostic settings must not interrupt file operations. */ }
    diagnosticLog('INFO','diagnostic.mode',{verbose:diagnosticIsVerbose()});
  }
  function diagnosticDatabase() {
    if(diagnosticDbPromise) return diagnosticDbPromise;
    if(!window.indexedDB) return Promise.reject(new Error('IndexedDB 不可用'));
    diagnosticDbPromise=new Promise((resolve,reject)=>{
      const request=window.indexedDB.open(DIAGNOSTIC_DATABASE,1);
      request.onupgradeneeded=()=>{
        const db=request.result;
        if(!db.objectStoreNames.contains('events')) {
          const store=db.createObjectStore('events',{keyPath:'id',autoIncrement:true});
          store.createIndex('time','time');
        }
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error||new Error('无法打开诊断数据库'));
      request.onblocked=()=>reject(new Error('诊断数据库被其他标签页阻塞'));
    }).catch(error=>{diagnosticDbPromise=null;throw error;});
    return diagnosticDbPromise;
  }
  function diagnosticLog(level,code,details={}) {
    try {
      if(level==='DEBUG' && !diagnosticIsVerbose()) return;
      const record={
        eventId:diagnosticSessionId+'_'+(++diagnosticCounter),
        time:Date.now(),level,code,
        sessionId:diagnosticSessionId,tabId:diagnosticTabId,
        details:diagnosticSanitize(details)
      };
      diagnosticMemory.push(record);
      if(diagnosticMemory.length>350) diagnosticMemory.shift();
      diagnosticPending.push(record);
      if(diagnosticPending.length>=40) void diagnosticFlush();
      else if(diagnosticFlushTimer===null) diagnosticFlushTimer=setTimeout(
        ()=>{diagnosticFlushTimer=null;void diagnosticFlush();},400);
    } catch (_) { /* Diagnostics must never affect the native workflow. */ }
  }
  function diagnosticFlush() {
    if(diagnosticFlushTimer!==null) {
      clearTimeout(diagnosticFlushTimer);
      diagnosticFlushTimer=null;
    }
    const batch=diagnosticPending.splice(0,diagnosticPending.length);
    if(!batch.length) return diagnosticWriteTail;
    diagnosticWriteTail=diagnosticWriteTail.then(async()=>{
      const db=await diagnosticDatabase();
      await new Promise((resolve,reject)=>{
        const tx=db.transaction('events','readwrite');
        const store=tx.objectStore('events');
        for(const event of batch) store.add(event);
        tx.oncomplete=resolve;
        tx.onabort=()=>reject(tx.error||new Error('保存诊断事件失败'));
        tx.onerror=()=>{};
      });
      diagnosticWritten+=batch.length;
      if(diagnosticWritten>=150) {
        diagnosticWritten=0;
        await diagnosticPrune();
      }
      diagnosticStorageError='';
    }).catch(error=>{
      diagnosticStorageError=diagnosticScrub(error?.message||error);
    });
    return diagnosticWriteTail;
  }
  async function diagnosticStored() {
    const db=await diagnosticDatabase();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction('events','readonly');
      const req=tx.objectStore('events').getAll();
      req.onsuccess=()=>resolve(req.result||[]);
      req.onerror=()=>reject(req.error||new Error('读取诊断日志失败'));
    });
  }
  async function diagnosticPrune() {
    const events=await diagnosticStored();
    const oldest=Date.now()-DIAGNOSTIC_RETENTION;
    const expired=events.filter((event,index)=>
      event.time<oldest || index<events.length-DIAGNOSTIC_MAX_EVENTS);
    if(!expired.length) return;
    const db=await diagnosticDatabase();
    await new Promise((resolve,reject)=>{
      const tx=db.transaction('events','readwrite');
      const store=tx.objectStore('events');
      for(const event of expired) store.delete(event.id);
      tx.oncomplete=resolve;
      tx.onabort=()=>reject(tx.error||new Error('清理旧诊断日志失败'));
      tx.onerror=()=>{};
    });
  }
  async function diagnosticReadAll() {
    await diagnosticFlush();
    let persisted=[];
    try { persisted=await diagnosticStored(); }
    catch(error) { diagnosticStorageError=diagnosticScrub(error?.message||error); }
    const events=new Map();
    for(const item of [...persisted,...diagnosticMemory]) events.set(item.eventId,item);
    const oldest=Date.now()-DIAGNOSTIC_RETENTION;
    return [...events.values()].filter(e=>e.time>=oldest)
      .sort((a,b)=>a.time-b.time).slice(-DIAGNOSTIC_MAX_EVENTS);
  }
  function diagnosticSnapshot() {
    return {
      mode:fileManagerMode,view:state.view,
      path:state.tabs.length?currentPath():null,
      directoryLoading:state.busy,initializing:state.initializing,
      selectedCount:state.selection.size,
      queue:{running:copyQueueRunning,paused:copyQueuePaused,
        recoveryLocked:copyRecoveryLocked,ownerHeld:copyOwnerHeld,
        persistentError:Boolean(persistenceError)},
      tasks:copyJobs.slice(0,80).map(job=>({
        taskId:job.taskId,status:job.status,phase:job.phase,count:job.count,
        percent:job.percent,speed:job.speed,recovered:!!job.recovered,
        items:job.record?.items?.slice(0,30).map(item=>({
          source:item.source,status:item.status,submission:item.submission
        }))
      }))
    };
  }

  // Machine-first diagnosis: compact, evidence-linked and clearly separates
  // observed failures from hypotheses. Source events remain available below.
  function diagnosticTriage(events,snapshot,lease=null) {
    const catalogue={
      'queue.lease_denied':{
        issue:'QUEUE_LEASE_DENIED',severity:'warning',
        meaning:'队列租约申请被拒绝；不证明用户打开了多个 File Station 标签页',
        checks:'检查 lease.remainingMs、页面刷新时间和空闲持锁；确认无运行及待核实任务后等待释放'
      },
      'queue.lease_lost':{
        issue:'QUEUE_LEASE_LOST',severity:'critical',
        meaning:'当前队列控制权丢失，后续任务暂停',
        checks:'检查是否有其他页面写入；先核实原生任务和保存状态，不要强制抢锁'
      },
      'queue.snapshot_conflict':{
        issue:'QUEUE_SNAPSHOT_CHANGED',severity:'critical',
        meaning:'本地任务快照与 IndexedDB 最新记录不同，已阻止覆盖',
        checks:'刷新并核实恢复队列；不要删除数据库或自动重试已提交操作'
      },
      'queue.persistence_failed':{
        issue:'QUEUE_PERSISTENCE_FAILURE',severity:'critical',
        meaning:'任务持久化失败，操作状态可能待核实',
        checks:'先核对 IndexedDB 与 Unraid 原生任务结果，再决定是否恢复'
      },
      'queue.recovery_native_idle':{
        issue:'RECOVERY_NATIVE_IDLE_NO_RECEIPT',severity:'warning',
        meaning:'页面恢复时 Unraid 没有正在执行的原生任务，无法重放已丢失的完成回执',
        checks:'按 taskId 查看队列，不自动重发原生请求；用户可选择不再执行本项，无需 SSH 核验'
      },
      'queue.recovery_native_read_failed':{
        issue:'RECOVERY_NATIVE_READ_FAILED',severity:'warning',
        meaning:'刷新恢复时未能读取原生任务状态',
        checks:'核对 Control.php mode=read 是否正常，保留已提交项，不自动重发'
      },
      'queue.restore_failed':{
        issue:'QUEUE_RESTORE_FAILURE',severity:'critical',
        meaning:'已保存的队列无法读取',
        checks:'检查 IndexedDB 可用性和 schema，不要直接清空数据'
      },
      'dialog.move_enqueue_failed':{
        issue:'MOVE_SUBMISSION_REJECTED',severity:'warning',
        meaning:'移动弹窗提交时没有成功入队',
        checks:'查看同一 session 的 queue.lease_denied、queue.snapshot_conflict 和 details.stage'
      },
      'dialog.move_target_failed':{
        issue:'MOVE_TARGET_INVALID',severity:'warning',
        meaning:'拖放目标在异步读取或验证时失败',
        checks:'检查文件夹存在性及目标验证过程；未入队就不应执行原生写入'
      },
      'javascript.error':{
        issue:'JAVASCRIPT_ERROR',severity:'critical',
        meaning:'脚本运行期间发生 JavaScript 错误',
        checks:'查看 details.message 和堆栈，按 eventId 关联前后事件'
      },
      'javascript.unhandled_rejection':{
        issue:'UNHANDLED_REJECTION',severity:'critical',
        meaning:'发生未处理的异步异常',
        checks:'检查异常信息和最近一次用户交互事件'
      }
    };
    const focusMarker=[...events].reverse().find(e=>e.code==='user.issue_marker');
    const end=focusMarker?.time??events.at(-1)?.time??Date.now();
    const beginning=end-(focusMarker?3:15)*60*1000;
    const relevant=events.filter(e=>e.time>=beginning && e.time<=end+15000);
    const groups=new Map();
    for(const event of relevant) {
      const spec=catalogue[event.code];
      if(!spec)continue;
      const item=groups.get(spec.issue)||{
        code:spec.issue,severity:spec.severity,observation:spec.meaning,
        suggestedCheck:spec.checks,occurrences:0,firstSeen:null,lastSeen:null,
        evidenceEventIds:[],latestDetails:null
      };
      item.occurrences++;
      item.firstSeen||=new Date(event.time).toISOString();
      item.lastSeen=new Date(event.time).toISOString();
      item.latestDetails=event.details||{};
      if(item.evidenceEventIds.length<8)item.evidenceEventIds.push(event.eventId);
      groups.set(spec.issue,item);
    }
    // Root/blocker events outrank downstream UI symptoms of the same failure.
    const rootPriority={
      QUEUE_SNAPSHOT_CHANGED:95,QUEUE_LEASE_LOST:95,QUEUE_PERSISTENCE_FAILURE:95,
      QUEUE_RESTORE_FAILURE:95,QUEUE_LEASE_DENIED:90,
      JAVASCRIPT_ERROR:85,UNHANDLED_REJECTION:85,
      MOVE_TARGET_INVALID:70,MOVE_SUBMISSION_REJECTED:40
    };
    const issues=[...groups.values()].sort((a,b)=>{
      const weight=s=>s==='critical'?2:1;
      return weight(b.severity)-weight(a.severity) ||
        (rootPriority[b.code]||0)-(rootPriority[a.code]||0) ||
        Date.parse(b.lastSeen)-Date.parse(a.lastSeen);
    });
    for(const issue of issues) {
      const last=Date.parse(issue.lastSeen);
      // A later successful acquisition resolves that particular denied lease;
      // it does NOT explain whether it belonged to an old or live page.
      issue.outcome=issue.code==='QUEUE_LEASE_DENIED' &&
        relevant.some(e=>e.time>last && e.code==='queue.lease_acquired')
        ?'later_acquired':'not_confirmed';
    }
    const significant=new Set([
      ...Object.keys(catalogue),
      'queue.lease_acquired','queue.lease_released','queue.lease_release_failed',
      'queue.enqueued','queue.finished','drag.move_target',
      'dialog.move_open','dialog.move_closed','dialog.move_submit',
      'dialog.move_target_ready','dialog.move_submit_blocked','user.issue_marker'
    ]);
    const timeline=relevant.filter(e=>significant.has(e.code)).slice(-35)
      .map(e=>({at:new Date(e.time).toISOString(),eventId:e.eventId,
        code:e.code,level:e.level,details:e.details}));
    return {
      schemaVersion:1,scope:{
        from:new Date(beginning).toISOString(),
        to:new Date(end+15000).toISOString(),
        anchor:focusMarker?'latest_user_issue_marker':'latest_events',
        inspectedEvents:relevant.length,totalEvents:events.length
      },
      status:issues.length?'issues_observed':'no_recognized_failure_in_scope',
      primaryIssue:issues[0]||null,issues,
      queueState:snapshot?.queue||null,lease:lease||null,
      timeline,
      agentInstructions:{
        readFirst:'triage.primaryIssue / triage.issues / triage.timeline',
        verifyAgainst:'events（以 eventId 关联原始证据）',
        confidence:'issues 表示日志中确实观察到的异常事件；observation 不等于已证明根本原因',
        privacy:'路径、文件名、ownerTag 均为本地盐生成的标识；切勿将标识还原为真实路径'
      }
    };
  }

  function diagnosticMarkIssue() {
    diagnosticLog('WARN','user.issue_marker',{snapshot:diagnosticSnapshot()});
  }
  async function diagnosticExport() {
    const events=await diagnosticReadAll();
    let lease=null;
    try {lease=await copyLeaseObservation();}
    catch(error) {diagnosticLog('WARN','queue.lease_inspection_failed',{message:error?.message});}
    const snapshot=diagnosticSanitize(diagnosticSnapshot());
    const report={
      schemaVersion:1,app:'Unraid File Station',version:DIAGNOSTIC_VERSION,
      exportedAt:new Date().toISOString(),
      retentionHours:24,
      privacy:'敏感字段已隐藏；路径与文件名使用本地盐生成的非加密标识；导出前仍建议检查文件内容。',
      triage:diagnosticTriage(events,snapshot,lease),
      environment:{route:location.pathname,userAgent:typeof navigator==='undefined'?'unknown':navigator.userAgent},
      storageError:diagnosticStorageError||null,
      snapshot,events
    };
    const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json;charset=utf-8'});
    const url=URL.createObjectURL(blob);
    const link=document.createElement('a');
    link.href=url;
    const stamp=new Date().toISOString().replace(/[-:]/g,'').replace('T','-').slice(0,15);
    link.download='unraid-file-station-diagnostic-'+stamp+'.json';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),5000);
  }
  async function diagnosticClear() {
    await diagnosticFlush();
    try {
      const db=await diagnosticDatabase();
      await new Promise((resolve,reject)=>{
        const tx=db.transaction('events','readwrite');
        tx.objectStore('events').clear();
        tx.oncomplete=resolve;
        tx.onabort=()=>reject(tx.error||new Error('清空日志失败'));
        tx.onerror=()=>{};
      });
    } catch(error) {
      diagnosticStorageError=diagnosticScrub(error?.message||error);
    }
    diagnosticMemory.length=0;
    diagnosticPending.length=0;
  }

  // Isolated native capability probe. Only synthetic files under this exact
  // user-approved subtree may be created, changed, moved or deleted.
  const NATIVE_PROBE_ROOT='/mnt/user/downloads/新建文件夹';
  let nativeProbeRunning=false;
  function nativeProbeDownload(report) {
    const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json;charset=utf-8'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;
    a.download=(report.kind==='unraid-native-lifecycle-probe'?'unraid-file-station-lifecycle-probe-':'unraid-file-station-native-probe-')+new Date().toISOString()
      .replace(/[-:]/g,'').replace('T','-').slice(0,15)+'.json';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),15000);
  }
  function nativeProbeOwned(path,workspace) {
    return typeof path==='string' && workspace.startsWith(NATIVE_PROBE_ROOT+'/__ufs_probe_') &&
      (path===workspace || path.startsWith(workspace+'/')) &&
      safePath(path) && !path.split('/').some(part=>part==='.'||part==='..');
  }
  function nativeProbeSourcesOwned(source,workspace) {
    return typeof source==='string' && source.length>0 &&
      source.split('\r').every(part=>nativeProbeOwned(part,workspace));
  }
  let nativeProbeQueueFormat='unknown';
  function nativeProbeParseQueue(raw) {
    const response=String(raw??'').trim();
    if(response.startsWith('[')){
      const jobs=JSON.parse(response);
      if(!Array.isArray(jobs) || !jobs.every(job=>job && typeof job==='object' &&
         !Array.isArray(job) && Number.isSafeInteger(Number(job.id)) &&
         typeof job.source==='string' && typeof job.target==='string' &&
         typeof job.task==='string'))
        throw new Error('原生 mode=jobs JSON 队列结构不符合预期');
      return {format:'json',jobs};
    }
    // Unraid webgui before 2026-09-28 returns an HTML fragment, not JSON:
    // <div id="dfm_joblist"><i id="queue_1"...></i>Job [0001] - ...</div>
    // Parse as an inert document; never put server HTML into the live page.
    if(response.startsWith('<')){
      const parsed=new DOMParser().parseFromString(response,'text/html');
      const list=parsed.querySelector('#dfm_joblist');
      if(!list)throw new Error('mode=jobs 返回未知 HTML 结构，禁止执行队列操作');
      const jobs=[];
      let current=null;
      for(const node of list.childNodes){
        if(node.nodeType===1){
          if(node.tagName==='I' && /^queue_[1-9]\d*$/.test(node.id)){
            if(current && !current.legacyText.trim())
              throw new Error('mode=jobs 发现缺少内容的队列项');
            current={id:Number(node.id.slice(6)),legacyText:''};
            jobs.push(current);
          }else if(node.tagName!=='BR'){
            throw new Error('mode=jobs 包含未识别的 HTML 队列元素');
          }
        }else if(node.nodeType===3){
          if(current)current.legacyText+=node.textContent;
          else if(node.textContent.trim())
            throw new Error('mode=jobs HTML 包含无法识别的队列内容');
        }else if(node.nodeType!==8){
          throw new Error('mode=jobs HTML 包含未识别的节点');
        }
      }
      if(jobs.some(job=>!job.legacyText.trim()) ||
         (jobs.length===0 && list.textContent.trim()))
        throw new Error('mode=jobs HTML 队列项目无法可靠辨认');
      return {format:'html-legacy',jobs};
    }
    throw new Error('mode=jobs 响应格式未知，禁止执行队列操作');
  }
  function nativeProbeOwnQueuedJob(job,source,target,task) {
    if(!job || !Number.isSafeInteger(Number(job.id)))return false;
    if(typeof job.legacyText==='string'){
      // Legacy HTML only exposes a display string. Limit identity matching to
      // our own exact synthetic task suffix and inspect count separately.
      return job.legacyText.trim().endsWith(' - '+task+' '+source+' --> '+target);
    }
    return job.source===source && job.target===target && job.task===task;
  }
  async function nativeProbeQueue() {
    const raw=await postNativeControl({mode:'jobs'});
    const result=nativeProbeParseQueue(raw);
    nativeProbeQueueFormat=result.format;
    return result.jobs;
  }
  async function nativeProbeIdle(requireEmptyQueue=true) {
    if(nativeWriteBusy)throw new Error('File Station 正在执行其他原生写入');
    if(copyJobs.some(j=>['queued','running','verifying','uncertain','recovering'].includes(j.status)))
      throw new Error('File Station 存在未完成或待核实的任务，请先处理');
    const active=await readNativeActive();
    if(active)throw new Error('Unraid 已有活动文件任务，拒绝启动探针');
    const jobs=await nativeProbeQueue();
    if(requireEmptyQueue && jobs.length)throw new Error('Unraid 原生队列不为空（'+jobs.length+'项），拒绝启动探针');
    return jobs;
  }
  function nativeProbeOperationAllowed(report,expected,workspace,scope='basic') {
    if(scope==='lifecycle') {
      // The lifecycle suite has a distinct workspace prefix, and an existing
      // MP4 under the authorized root is a read-only input to its long copy.
      // This helper is ONLY used for mkdir and cleanup, never for the video POST.
      if(report?.kind!=='unraid-native-lifecycle-probe' ||
         report.workspace!==workspace || !nativeLifecycleOwn(workspace,report))
        return false;
      if(expected.action===0 && typeof expected.target==='string' &&
         safeWriteName(expected.target)) {
        if(expected.source===NATIVE_PROBE_ROOT)
          return expected.target===workspace.slice(NATIVE_PROBE_ROOT.length+1);
        return expected.source===workspace &&
          ['source','large','queue1','queue2'].includes(expected.target);
      }
      return expected.action===1 && expected.source===workspace && expected.target==='';
    }
    if(scope!=='basic')return false;
    const validSource=nativeProbeSourcesOwned(expected.source,workspace) ||
      (expected.action===0 && expected.source===NATIVE_PROBE_ROOT &&
       expected.target===workspace.slice(NATIVE_PROBE_ROOT.length+1));
    const validTarget=expected.action===0 || !expected.target ||
      nativeProbeOwned(expected.target.replace(/\/$/,''),workspace);
    return validSource && validTarget;
  }
  async function nativeProbeRun(report,operation,fields,expected,check,workspace,scope='basic') {
    if(!nativeProbeOperationAllowed(report,expected,workspace,scope))
      throw new Error('测试操作超出授权范围：'+operation);
    await nativeProbeIdle();
    let submitted=false,done=false,remoteError='',seen=false;
    let lastText='',progressCount=0;
    const started=performance.now();
    const unwatch=observeNativeProgress(data=>{
      if(data.done===1)done=true;
      if(data.error)remoteError=stripNativeStatusHtml(data.error).slice(0,350);
      if(data.status) {
        lastText=stripNativeStatusHtml(String(data.status)).slice(0,350);
        progressCount++;
      }
    });
    try {
      submitted=true;
      const response=await postNativeControl({
        mode:'file',action:String(expected.action),title:encodeURIComponent('UFS isolated probe'),
        source:encodeURIComponent(expected.source),target:encodeURIComponent(expected.target),
        hdlink:'',sparse:'',exist:'1',zfs:'',...fields
      });
      if(response.trim())throw new Error('原生接口非空响应：'+response.slice(0,100));
      const deadline=Date.now()+45000;
      let empty=0;
      while(Date.now()<deadline){
        await waitNative(350);
        if(remoteError)throw new Error('原生任务错误：'+remoteError);
        const active=await readNativeActive();
        if(active) {
          if(Number(active.action)!==expected.action ||
             active.source!==expected.source || active.target!==expected.target)
            throw new Error('检测到不属于探针的活动任务，停止进一步写入');
          seen=true;empty=0;
        } else {
          empty++;
          if(empty>=3 && (seen||done) && await check())break;
        }
      }
      if(empty<3 || !(seen||done) || !(await check()))
        throw new Error('未能在时限内确认测试任务完成；禁止自动清理');
      const result={name:operation,status:'passed',elapsedMs:Math.round(performance.now()-started),
        observedActive:seen,observedDone:done,progressEvents:progressCount,
        lastProgress:lastText};
      report.steps.push(result);
      return result;
    }catch(error) {
      if(submitted)report.uncertain=true;
      report.steps.push({name:operation,status:'failed',submitted,
        elapsedMs:Math.round(performance.now()-started),error:String(error.message||error)});
      throw error;
    }finally{unwatch();}
  }
  async function nativeProbeWaitFile(path,content) {
    const response=await postNativeControl({mode:'edit',file:encodeURIComponent(path)});
    return response===content;
  }
  async function nativeProbeEntries(path) {
    return await listDirectory(path);
  }
  async function nativeProbeShapeSafe(workspace,report) {
    const allowed=new Map([
      ['',new Set(['probe-owner.txt','source','target'])],
      ['source',new Set(['batch-a.txt','batch-b.txt','move.txt','queue.txt','merge-folder'])],
      ['target',new Set(['batch-a.txt','batch-b.txt','move.txt','queue.txt','merge-folder'])],
      ['source/merge-folder',new Set(['source-only.txt','shared.txt'])],
      ['target/merge-folder',new Set(['source-only.txt','target-only.txt','shared.txt'])]
    ]);
    for(const [relative,names] of allowed){
      const path=relative?workspace+'/'+relative:workspace;
      const entries=await nativeProbeEntries(path);
      if(entries.length>names.size)throw new Error('清理前发现未知额外文件');
      for(const entry of entries) {
        if(!names.has(entry.name) || !nativeProbeOwned(entry.path,workspace))
          throw new Error('清理前发现探针外的内容：'+entry.name);
        const shouldBeFolder=(relative==='' && (entry.name==='source'||entry.name==='target')) ||
          ((relative==='source'||relative==='target') && entry.name==='merge-folder');
        if(entry.folder!==shouldBeFolder)
          throw new Error('清理前目录结构与测试预期不符：'+entry.name);
        if(entry.copyPathVerified===false)
          throw new Error('清理前发现未经验证的路径');
      }
    }
    if(!(await nativeProbeWaitFile(workspace+'/probe-owner.txt',report.ownerToken)))
      throw new Error('测试所有权标记不匹配，禁止清理');
  }
  async function nativeProbeExecute(status) {
    if(nativeProbeRunning)throw new Error('已有原生能力测试在进行');
    nativeProbeRunning=true;
    const workspace=NATIVE_PROBE_ROOT+'/__ufs_probe_'+Date.now().toString(36)+'_'+
      Math.random().toString(36).slice(2,10);
    const report={
      schemaVersion:1,kind:'unraid-native-capability-probe',
      fileStationVersion:DIAGNOSTIC_VERSION,startedAt:new Date().toISOString(),
      scope:{authorizedRoot:NATIVE_PROBE_ROOT,workspace,syntheticDataOnly:true},
      environment:{route:location.pathname,userAgent:navigator.userAgent,
        nchanAvailable:typeof window.NchanSubscriber==='function',
        csrfAvailable:typeof window.csrf_token==='string'&&!!window.csrf_token},
      assumptions:[
        '只在专属临时子目录内创建或操作合成文本文件',
        '原生 Control.php 使用全局活动槽和队列；空闲检查不能消除其他标签页同时操作的竞争窗口',
        '不执行全局 action=99 取消，不删除或移动现有 MP4 文件',
        '报告反映本次实机观测，未观察到事件不等于原生不支持'
      ],
      ownerToken:'UFS_PROBE_OWNER_'+Math.random().toString(36).slice(2)+'_END',
      steps:[],queueObservations:[],uncertain:false,cleanup:'not_started',
      conclusion:{},endedAt:null
    };
    let workspaceCreated=false;
    const record=(name,statusValue,extra={})=>{
      report.steps.push({name,status:statusValue,...extra});
      status('测试：'+name+' — '+(statusValue==='passed'?'通过':statusValue==='skipped'?'跳过':'失败'));
    };
    const run=async(name,fields,expected,check)=>{
      status('执行：'+name);
      return nativeProbeRun(report,name,fields,expected,check,workspace);
    };
    const mkdir=async(parent,name)=>{
      const full=parent+'/'+name;
      if(!full.startsWith(workspace+'/') && full!==workspace)
        throw new Error('新建目录超出授权范围');
      return run('mkdir '+name,{}, {action:0,source:parent,target:name},
        async()=> (await nativeProbeEntries(parent)).some(e=>e.name===name&&e.folder));
    };
    const write=async(relative,content)=>{
      const path=workspace+'/'+relative;
      if(!nativeProbeOwned(path,workspace))throw new Error('写入范围非法');
      await nativeProbeIdle();
      const started=performance.now();
      await postNativeControl({mode:'save',file:encodeURIComponent(path),
        data:encodeURIComponent(content)});
      if(!(await nativeProbeWaitFile(path,content))) {
        report.uncertain=true;
        throw new Error('mode=save 内容回读失败，停止测试并保留现场');
      }
      record('save '+relative,'passed',{elapsedMs:Math.round(performance.now()-started),
        bytes:content.length});
    };
    try{
      if(isDemo)throw new Error('演示模式禁止原生能力实机测试');
      nativeCsrfToken();
      status('正在检查原生任务状态与授权目录…');
      const jobs=await nativeProbeIdle();
      report.environment.queueResponseFormat=nativeProbeQueueFormat;
      report.queueObservations.push({phase:'before',count:jobs.length});
      const base=await nativeProbeEntries(NATIVE_PROBE_ROOT);
      if(base.some(e=>e.name===workspace.split('/').pop()))
        throw new Error('测试子目录已存在，拒绝覆盖');
      record('native-read-and-jobs','passed',{active:null,queued:jobs.length,
        authorizedDirectoryItemCount:base.length});
      await mkdir(NATIVE_PROBE_ROOT,workspace.split('/').pop());
      workspaceCreated=true;
      await mkdir(workspace,'source');
      await mkdir(workspace,'target');
      await write('probe-owner.txt',report.ownerToken);
      const a1='UFS_BATCH_A_V1_'+report.ownerToken;
      const a2='UFS_BATCH_A_V2_'+report.ownerToken;
      const b='UFS_BATCH_B_'+report.ownerToken;
      const m='UFS_MOVE_'+report.ownerToken;
      const q='UFS_QUEUE_'+report.ownerToken;
      await write('source/batch-a.txt',a1);
      await write('source/batch-b.txt',b);
      await write('source/move.txt',m);
      await write('source/queue.txt',q);
      const src=workspace+'/source',dst=workspace+'/target';
      await mkdir(src,'merge-folder');
      await mkdir(dst,'merge-folder');
      const srcShared='UFS_MERGE_SOURCE_'+report.ownerToken;
      const dstShared='UFS_MERGE_TARGET_'+report.ownerToken;
      const dstOnly='UFS_MERGE_TARGET_ONLY_'+report.ownerToken;
      await write('source/merge-folder/source-only.txt','UFS_MERGE_SOURCE_ONLY_'+report.ownerToken);
      await write('source/merge-folder/shared.txt',srcShared);
      await write('target/merge-folder/target-only.txt',dstOnly);
      await write('target/merge-folder/shared.txt',dstShared);
      const a=src+'/batch-a.txt',bb=src+'/batch-b.txt';
      await run('native-multi-file-copy',{exist:'1'},
        {action:8,source:a+'\r'+bb,target:dst+'/'},
        async()=>(await nativeProbeWaitFile(dst+'/batch-a.txt',a1)) &&
          (await nativeProbeWaitFile(dst+'/batch-b.txt',b)));
      await write('source/batch-a.txt',a2);
      await run('native-copy-ignore-existing',{exist:''},
        {action:8,source:a,target:dst+'/'},
        async()=>await nativeProbeWaitFile(dst+'/batch-a.txt',a1));
      await run('native-copy-overwrite',{exist:'1'},
        {action:8,source:a,target:dst+'/'},
        async()=>await nativeProbeWaitFile(dst+'/batch-a.txt',a2));
      await run('native-folder-merge-skip',{exist:''},
        {action:3,source:src+'/merge-folder',target:dst+'/'},
        async()=> (await nativeProbeWaitFile(dst+'/merge-folder/shared.txt',dstShared)) &&
          (await nativeProbeWaitFile(dst+'/merge-folder/source-only.txt',
            'UFS_MERGE_SOURCE_ONLY_'+report.ownerToken)) &&
          (await nativeProbeWaitFile(dst+'/merge-folder/target-only.txt',dstOnly)));
      await run('native-folder-merge-overwrite',{exist:'1'},
        {action:3,source:src+'/merge-folder',target:dst+'/'},
        async()=> (await nativeProbeWaitFile(dst+'/merge-folder/shared.txt',srcShared)) &&
          (await nativeProbeWaitFile(dst+'/merge-folder/target-only.txt',dstOnly)));
      const movePath=src+'/move.txt';
      await run('native-same-share-move',{exist:'1'},
        {action:9,source:movePath,target:dst+'/'},
        async()=> (await nativeProbeWaitFile(dst+'/move.txt',m)) &&
          !(await nativeProbeEntries(src)).some(e=>e.name==='move.txt'));
      // Queue/start are global operations. Never remove arbitrary numbered jobs
      // or issue global stop. Require the queue to contain only our own entry.
      await nativeProbeIdle();
      const queueSource=src+'/queue.txt',queueTarget=dst+'/';
      status('测试：原生队列入队、查询与启动');
      const queuedAt=performance.now();
      report.queueObservations.push({phase:'before-enqueue',count:(await nativeProbeQueue()).length});
      // Set uncertain before POST: a failed response might still have queued a task.
      report.uncertain=true;
      await postNativeControl({
        mode:'file',task:encodeURIComponent('ufs-probe-copy'),action:'8',
        title:encodeURIComponent('UFS isolated queue probe'),
        source:encodeURIComponent(queueSource),target:encodeURIComponent(queueTarget),
        hdlink:'',sparse:'',exist:'1',zfs:''
      });
      const queue=await nativeProbeQueue();
      const onlyOurJob=queue.length===1 &&
        nativeProbeOwnQueuedJob(queue[0],queueSource,queueTarget,'ufs-probe-copy');
      report.queueObservations.push({phase:'after-enqueue',count:queue.length,
        ourJobPresent:onlyOurJob,elapsedMs:Math.round(performance.now()-queuedAt)});
      if(!onlyOurJob)throw new Error('队列身份不匹配，停止测试并保留现场');
      if(await readNativeActive())throw new Error('入队后发现活动任务，停止队列推进');
      const immediatelyBeforeStart=await nativeProbeQueue();
      if(immediatelyBeforeStart.length!==1 ||
         !nativeProbeOwnQueuedJob(immediatelyBeforeStart[0],
           queueSource,queueTarget,'ufs-probe-copy'))
        throw new Error('队列已发生变化，不执行 mode=start');
      const queueStartedAt=performance.now();
      const startReply=(await postNativeControl({mode:'start'})).trim();
      if(!['1','2'].includes(startReply))
        throw new Error('mode=start 返回非预期值 '+startReply);
      report.steps.push({name:'native-queue-enqueue-and-start',status:'passed',
        enqueueMs:Math.round(queueStartedAt-queuedAt),startReply});
      // The queued job is now active or already finished. Track it without
      // resubmission; its content is unique to this probe.
      const deadline=Date.now()+45000;
      let seen=false,idle=0,queueFinished=false;
      while(Date.now()<deadline){
        await waitNative(350);
        const active=await readNativeActive();
        if(active){
          if(Number(active.action)!==8 || active.source!==queueSource ||
             active.target!==queueTarget)
            throw new Error('原生活动槽被其他任务占用');
          seen=true;idle=0;
        }else{
          idle++;
          if(idle>=3 && await nativeProbeWaitFile(dst+'/queue.txt',q)){
            queueFinished=true;break;
          }
        }
      }
      if(!queueFinished)throw new Error('排队复制未能验证完成');
      if((await nativeProbeQueue()).length)
        throw new Error('排队任务完成后还有其他待执行任务');
      report.uncertain=false;
      report.queueObservations.push({phase:'after-start',count:0,observedActive:seen,
        durationMs:Math.round(performance.now()-queueStartedAt)});
      report.steps.push({name:'native-queued-job-execution',status:'passed',
        observedActive:seen});
      report.conclusion={
        batchCopy:'verified',skip:'verified',overwrite:'verified',
        move:'verified',folderMerge:'verified',nativeQueue:'verified',queueAutoAdvance:'not_tested',
        runningTaskEnqueue:'not_tested',globalCancel:'not_tested',
        f5Recovery:'not_tested',nativeCompletionHistory:'not_provided_by_read'
      };
      status('测试完成，开始核验并清理专属临时目录…');
    }catch(error){
      report.error=String(error?.message||error);
      report.steps.push({name:'probe-aborted',status:'failed',error:report.error});
      status('测试中止：'+report.error);
    }finally{
      if(workspaceCreated){
        try{
          if(report.uncertain)throw new Error('存在提交结果不确定的原生操作');
          await nativeProbeIdle();
          await nativeProbeShapeSafe(workspace,report);
          await run('cleanup-owned-workspace',{},
            {action:1,source:workspace,target:''},
            async()=> !(await nativeProbeEntries(NATIVE_PROBE_ROOT))
              .some(e=>e.name===workspace.split('/').pop()));
          report.cleanup='completed';
        }catch(error){
          report.cleanup='skipped_or_failed';
          report.cleanupReason=String(error?.message||error);
        }
      }else report.cleanup='nothing_created_or_unconfirmed';
      report.endedAt=new Date().toISOString();
      report.result=report.error?'failed':report.cleanup==='completed'?'passed':'needs_manual_check';
      status('测试结束：'+report.result+'；自动下载 JSON 报告'+
        (report.cleanup==='completed'?'；临时目录已清理':'；请检查报告中的临时目录状态'));
      try{nativeProbeDownload(report);}
      catch(error){status('自动下载失败：'+String(error?.message||error));}
      diagnosticLog('INFO','native_probe.completed',{result:report.result,
        cleanup:report.cleanup,stepCount:report.steps.length,uncertain:report.uncertain});
      nativeProbeRunning=false;
    }
  }
  function showNativeProbeDialog() {
    if(document.querySelector('.ufs-native-probe-overlay')||nativeProbeRunning)return;
    const overlay=element('div','ufs-diagnostic-overlay ufs-native-probe-overlay');
    const panel=element('section','ufs-diagnostic-panel');
    panel.setAttribute('role','dialog');
    panel.setAttribute('aria-modal','true');
    panel.setAttribute('aria-label','Unraid 原生能力测试');
    const header=element('div','ufs-diagnostic-head');
    header.append(element('strong','','原生能力测试 · v'+DIAGNOSTIC_VERSION));
    const close=element('button','','×');close.type='button';
    header.append(close);
    const hint=element('p','',
      '只在 '+NATIVE_PROBE_ROOT+' 下生成 __ufs_probe_ 开头的临时目录；不触碰现有 MP4。测试需独占原生文件任务，进行中不要在其他浏览器标签执行文件操作。测试结束自动下载 JSON；无法确认安全时保留现场而不强制删除。');
    const start=element('button','ufs-diagnostic-primary','开始安全测试');
    start.type='button';
    const stateText=element('div','ufs-diagnostic-status','尚未开始；运行期间请不要刷新或关闭页面。');
    const dismiss=()=>{if(!nativeProbeRunning)overlay.remove();};
    close.addEventListener('click',dismiss);
    overlay.addEventListener('click',event=>{if(event.target===overlay)dismiss();});
    overlay.addEventListener('keydown',event=>{
      if(event.key==='Escape' && !nativeProbeRunning){event.preventDefault();dismiss();}
    });
    start.addEventListener('click',()=>{
      if(!window.confirm('确认现在没有其他 Unraid 文件任务或用户在操作文件？\n\n脚本将在 '+NATIVE_PROBE_ROOT+
        ' 下创建并清理自己的临时测试文件，不读取或修改现有视频。\n\n原生接口不提供原子独占锁，不能完全排除其他标签页的并发竞争。'))return;
      start.disabled=true;
      close.disabled=true;
      void nativeProbeExecute(message=>{stateText.textContent=message;})
        .finally(()=>{close.disabled=false;start.disabled=true;});
    });
    panel.append(header,hint,start,stateText);
    overlay.append(panel);
    document.body.append(overlay);
    start.focus();
  }


  // Lifecycle test v0.2.13.8: only operates inside the user-authorized
  // /mnt/user/downloads/新建文件夹 subtree. Existing videos are READ-ONLY inputs.
  // A dedicated __ufs_lifecycle_* directory owns every generated output.
  const NATIVE_LIFECYCLE_KEY=STORE+'native-lifecycle-v1';
  let nativeLifecycleBusy=false;
  function nativeLifecycleOwn(path,run) {
    return typeof path==='string' &&
      typeof run?.workspace==='string' &&
      /^__ufs_lifecycle_[a-z0-9_]+$/.test(run.workspace.slice(NATIVE_PROBE_ROOT.length+1)) &&
      run.workspace.startsWith(NATIVE_PROBE_ROOT+'/') &&
      (path===run.workspace || path.startsWith(run.workspace+'/')) &&
      safePath(path) && !path.split('/').some(p=>p==='.'||p==='..');
  }
  function nativeLifecycleSnapshot(run) {
    sessionStorage.setItem(NATIVE_LIFECYCLE_KEY,JSON.stringify(run));
  }
  function nativeLifecycleRead() {
    try {
      const raw=sessionStorage.getItem(NATIVE_LIFECYCLE_KEY);
      if(!raw)return null;
      const run=JSON.parse(raw);
      if(!run || run.schemaVersion!==1 || !nativeLifecycleOwn(run.workspace,run) ||
         typeof run.ownerToken!=='string' || !run.ownerToken.startsWith('UFS_LIFECYCLE_') ||
         !Array.isArray(run.steps) || !Array.isArray(run.samples) ||
         !['preparing','before-reload','resuming','complete','stopped'].includes(run.phase))
        throw new Error('生命周期记录无法校验，拒绝自动恢复');
      return run;
    } catch(error) {
      diagnosticLog('ERROR','native_lifecycle.invalid_snapshot',{message:error?.message});
      return null;
    }
  }
  function nativeLifecycleNote(run,name,detail={}) {
    run.steps.push({time:new Date().toISOString(),...detail,name});
    nativeLifecycleSnapshot(run);
  }
  function nativeLifecycleFilePath(run,part,name) {
    const path=run.workspace+'/'+part+'/'+name;
    if(!nativeLifecycleOwn(path,run) || !['source','large','queue1','queue2'].includes(part))
      throw new Error('生命周期文件路径超出授权目录');
    return path;
  }
  async function nativeLifecycleFindVideo() {
    const folders=await nativeProbeEntries(NATIVE_PROBE_ROOT);
    const files=[];
    const inspect=async(dir,depth)=>{
      const entries=await nativeProbeEntries(dir);
      for(const entry of entries){
        if(entry.copyPathVerified===false)continue;
        if(!entry.folder && /\.mp4$/i.test(entry.name) &&
           Number.isFinite(entry.size) && entry.size>=64*1024*1024 &&
           entry.size<=2*1024*1024*1024 &&
           entry.path===dir+'/'+entry.name && safePath(entry.path) &&
           entry.path.startsWith(NATIVE_PROBE_ROOT+'/') &&
           !/^l/.test(entry.permissions||'') &&
           !entry.path.split('/').some(x=>x==='.'||x==='..'))
          files.push(entry);
        if(entry.folder && depth<1 && !entry.name.startsWith('__ufs_') &&
           entry.path===dir+'/'+entry.name && safePath(entry.path) &&
           !/^l/.test(entry.permissions||'') &&
           entry.path.startsWith(NATIVE_PROBE_ROOT+'/'))
          await inspect(entry.path,depth+1);
      }
    };
    for(const entry of folders){
      if(!entry.folder && /\.mp4$/i.test(entry.name) &&
         entry.copyPathVerified!==false && entry.path===NATIVE_PROBE_ROOT+'/'+entry.name &&
         safePath(entry.path) && !/^l/.test(entry.permissions||'') &&
         entry.size>=64*1024*1024 &&
         entry.size<=2*1024*1024*1024)files.push(entry);
      if(entry.folder && !entry.name.startsWith('__ufs_') &&
         entry.path===NATIVE_PROBE_ROOT+'/'+entry.name && safePath(entry.path) &&
         !/^l/.test(entry.permissions||''))
        await inspect(entry.path,0);
    }
    files.sort((a,b)=>b.size-a.size);
    return files[0]||null;
  }
  async function nativeLifecycleFileSize(directory,name) {
    const entries=await nativeProbeEntries(directory);
    const entry=entries.find(e=>e.name===name && !e.folder && e.copyPathVerified!==false);
    return entry ? entry.size : null;
  }
  function nativeLifecycleJobsOwned(run,jobs) {
    const expected=[
      {source:nativeLifecycleFilePath(run,'source','queue1.txt'),target:run.workspace+'/queue1/',task:run.tasks[0]},
      {source:nativeLifecycleFilePath(run,'source','queue2.txt'),target:run.workspace+'/queue2/',task:run.tasks[1]}
    ];
    const matches=jobs.map(job=>expected.findIndex(item=>
      nativeProbeOwnQueuedJob(job,item.source,item.target,item.task)));
    if(matches.some(i=>i<0) || new Set(matches).size!==matches.length)
      throw new Error('原生队列包含其他任务或未知任务，拒绝调度与清理');
    return matches;
  }
  function nativeLifecycleActiveOwned(run,active) {
    if(!active)return null;
    const possibilities=[
      {source:run.video.path,target:run.workspace+'/large/'},
      {source:nativeLifecycleFilePath(run,'source','queue1.txt'),target:run.workspace+'/queue1/'},
      {source:nativeLifecycleFilePath(run,'source','queue2.txt'),target:run.workspace+'/queue2/'}
    ];
    const i=possibilities.findIndex(item=>Number(active.action)===8 &&
      item.source===active.source && item.target===active.target);
    if(i<0)throw new Error('检测到不属于测试的原生活动任务，立即停止测试');
    return i===0?'large':'queue'+i;
  }
  async function nativeLifecycleSafeCleanup(run) {
    if(run.uncertain)throw new Error('原生写入或任务归属尚未确认，不允许清理');
    await nativeProbeIdle();
    if(!(await nativeProbeWaitFile(run.workspace+'/owner.txt',run.ownerToken))) {
      // mkdir may succeed before owner.txt can be written. An empty workspace
      // is safe to remove only when THIS session confirms that it created it
      // and no other native write was ever attempted afterward.
      const onlyInitialDirectory=run.workspaceCreated &&
        run.steps.some(step=>step.name==='mkdir-lifecycle-workspace' &&
          step.status==='passed') &&
        run.steps.every(step=>step.name==='selected-readonly-video' ||
          step.name==='mkdir-lifecycle-workspace' ||
          step.name==='setup-aborted');
      if(!onlyInitialDirectory ||
         (await nativeProbeEntries(run.workspace)).length!==0)
        throw new Error('所有权标记不匹配或非空目录，拒绝清理');
      return nativeProbeRun(run,'cleanup-empty-lifecycle-workspace',{},
        {action:1,source:run.workspace,target:''},
        async()=>!(await nativeProbeEntries(NATIVE_PROBE_ROOT))
          .some(e=>e.name===run.workspace.split('/').pop()),
        run.workspace,'lifecycle');
    }
    const layout=[
      ['',{'owner.txt':false,'source':true,'large':true,'queue1':true,'queue2':true}],
      ['source',{'queue1.txt':false,'queue2.txt':false}],
      ['large',{[run.video.name]:false}],
      ['queue1',{'queue1.txt':false}],
      ['queue2',{'queue2.txt':false}]
    ];
    for(const [dir,expected] of layout){
      const path=run.workspace+(dir?'/'+dir:'');
      const entries=await nativeProbeEntries(path);
      for(const entry of entries){
        if(!nativeLifecycleOwn(entry.path,run) ||
           !Object.hasOwn(expected,entry.name) ||
           expected[entry.name]!==entry.folder ||
           entry.copyPathVerified===false)
          throw new Error('测试目录内容异常，拒绝清理：'+dir+'/'+entry.name);
      }
    }
    return nativeProbeRun(run,'cleanup-lifecycle-workspace',{},
      {action:1,source:run.workspace,target:''},
      async()=>!(await nativeProbeEntries(NATIVE_PROBE_ROOT))
        .some(e=>e.name===run.workspace.split('/').pop()),
      run.workspace,'lifecycle');
  }
  async function nativeLifecycleFinalize(run,status,reason,notify) {
    try{
      run.phase='stopped';
      run.endedAt=new Date().toISOString();
      run.result=status;
      if(reason)run.error=String(reason?.message||reason);
      nativeLifecycleSnapshot(run);
      if(run.workspaceCreated && !run.uncertain){
        notify('正在核对测试数据并尝试清理临时目录…');
        try{
          await nativeLifecycleSafeCleanup(run);
          run.cleanup='completed';
        }catch(error){
          run.cleanup='skipped';
          run.cleanupReason=String(error.message||error);
        }
      }else{
        run.cleanup='skipped';
        run.cleanupReason=run.workspaceCreated?'操作结果未确认，保留测试目录':'测试目录未确认创建';
      }
      run.result=run.result==='passed'&&run.cleanup!=='completed'?'needs_manual_check':run.result;
      run.phase='complete';
      nativeLifecycleSnapshot(run);
      notify('生命周期测试结束：'+run.result+'。'+
        (run.cleanup==='completed'?'专属测试目录已清理。':'临时目录保留，请查看 JSON 报告。'));
      nativeProbeDownload({...run,kind:'unraid-native-lifecycle-probe'});
      diagnosticLog('INFO','native_lifecycle.finished',{result:run.result,cleanup:run.cleanup});
    }finally{nativeLifecycleBusy=false;}
  }
  function nativeLifecycleShowPanel(initial='') {
    let existing=document.querySelector('.ufs-native-lifecycle-overlay');
    if(existing)return message=>{
      const status=existing.querySelector('.ufs-native-lifecycle-status');
      if(status)status.textContent=message;
    };
    const overlay=element('div','ufs-diagnostic-overlay ufs-native-lifecycle-overlay');
    const panel=element('section','ufs-diagnostic-panel');
    panel.setAttribute('role','dialog');
    panel.setAttribute('aria-modal','true');
    panel.setAttribute('aria-label','原生任务生命周期测试');
    const title=element('div','ufs-diagnostic-head');
    title.append(element('strong','','原生任务生命周期专项测试'));
    const close=element('button','','×');
    close.type='button';
    close.addEventListener('click',()=>{if(!nativeLifecycleBusy)overlay.remove();});
    title.append(close);
    const text=element('p','',
      '只读取授权目录中的现有 MP4，复制结果和队列测试文件均创建在 __ufs_lifecycle_* 临时目录内；不会移动或删除原始视频。测试过程中可能自动刷新此页面一次。请不要使用其他标签页执行文件操作，也不要关闭当前标签页。');
    const status=element('div','ufs-diagnostic-status ufs-native-lifecycle-status',
      initial||'准备运行；要求原生队列为空，且没有正在执行的文件任务。');
    const controls=element('div','ufs-diagnostic-controls');
    const start=element('button','ufs-diagnostic-primary','开始生命周期测试');
    start.type='button';
    const download=element('button','','下载已有报告');
    download.type='button';
    controls.append(start,download);
    const existingRun=nativeLifecycleRead();
    start.disabled=nativeLifecycleBusy || !!existingRun && existingRun.phase!=='complete';
    download.disabled=!existingRun;
    start.addEventListener('click',()=>{
      if(!window.confirm('测试将复制授权目录内的一份大型视频到独立临时目录，然后在复制运行期间向原生队列追加两个小文件任务，并自动 F5 一次。\n\n原始视频保持不变，但复制会暂时占用等量磁盘空间。请确认没有其他 WebGUI 任务或用户正在执行文件操作。'))return;
      if(nativeLifecycleBusy)return;
      start.disabled=true;
      void nativeLifecycleStart(msg=>status.textContent=msg);
    });
    download.addEventListener('click',()=>{
      const r=nativeLifecycleRead();
      if(r)nativeProbeDownload({...r,kind:'unraid-native-lifecycle-probe'});
    });
    overlay.append(panel);
    panel.append(title,text,controls,status);
    document.body.append(overlay);
    return message=>{status.textContent=message;download.disabled=!nativeLifecycleRead();};
  }
  async function nativeLifecycleStart(notify){
    if(nativeLifecycleBusy)return;
    nativeLifecycleBusy=true;
    const workspace=NATIVE_PROBE_ROOT+'/__ufs_lifecycle_'+Date.now().toString(36)+'_'+
      Math.random().toString(36).slice(2,10);
    const run={
      schemaVersion:1,kind:'unraid-native-lifecycle-probe',version:DIAGNOSTIC_VERSION,
      startedAt:new Date().toISOString(),phase:'preparing',workspace,
      scope:{authorizedRoot:NATIVE_PROBE_ROOT,videoSourceReadOnly:true},
      ownerToken:'UFS_LIFECYCLE_'+Math.random().toString(36).slice(2),
      tasks:['ufs-lifecycle-'+Math.random().toString(36).slice(2)+'-1',
        'ufs-lifecycle-'+Math.random().toString(36).slice(2)+'-2'],
      workspaceCreated:false,uncertain:false,steps:[],samples:[],queueResponseFormat:null,
      conclusion:{runningEnqueue:'not_tested',f5Resume:'not_tested',
        automaticQueueAdvance:'not_tested',unattendedAdvance:'not_tested',
        cancel:'not_tested',largeCopySpeed:'not_benchmarked'},
      cleanup:'not_started'
    };
    try{
      if(isDemo)throw new Error('演示模式不允许运行生命周期测试');
      const old=nativeLifecycleRead();
      if(old && old.phase!=='complete')throw new Error('上次生命周期测试尚未结束，拒绝启动新任务');
      await nativeProbeIdle();
      run.queueResponseFormat=nativeProbeQueueFormat;
      notify('正在授权目录下寻找大型 MP4，仅作复制源文件…');
      const video=await nativeLifecycleFindVideo();
      if(!video)throw new Error('授权目录内未找到 64MB–2GB 且路径已核验的 MP4 文件');
      run.video={path:video.path,name:video.name,size:video.size,mtime:video.mtime};
      nativeLifecycleNote(run,'selected-readonly-video',{size:video.size,name:video.name});
      const existing=(await nativeProbeEntries(NATIVE_PROBE_ROOT))
        .some(e=>e.name===workspace.split('/').pop());
      if(existing)throw new Error('随机工作目录已存在，拒绝覆盖');
      notify('正在创建受限测试目录…');
      await nativeProbeRun(run,'mkdir-lifecycle-workspace',{},
        {action:0,source:NATIVE_PROBE_ROOT,target:workspace.split('/').pop()},
        async()=>(await nativeProbeEntries(NATIVE_PROBE_ROOT))
          .some(e=>e.name===workspace.split('/').pop()&&e.folder),workspace,'lifecycle');
      run.workspaceCreated=true;
      nativeLifecycleSnapshot(run);
      for(const subdir of ['source','large','queue1','queue2']){
        await nativeProbeRun(run,'mkdir-'+subdir,{},
          {action:0,source:workspace,target:subdir},
          async()=>(await nativeProbeEntries(workspace))
            .some(e=>e.name===subdir&&e.folder),workspace,'lifecycle');
      }
      for(const [name,contents] of [
        ['owner.txt',run.ownerToken],
        ['source/queue1.txt','UFS_LIFECYCLE_QUEUE1_'+run.ownerToken],
        ['source/queue2.txt','UFS_LIFECYCLE_QUEUE2_'+run.ownerToken]
      ]){
        await nativeProbeIdle();
        const dst=workspace+'/'+name;
        if(!nativeLifecycleOwn(dst,run))throw new Error('写入超出授权路径');
        // Save is not idempotent under network failures; checkpoint before POST.
        run.uncertain=true;
        nativeLifecycleSnapshot(run);
        await postNativeControl({mode:'save',file:encodeURIComponent(dst),
          data:encodeURIComponent(contents)});
        if(!(await nativeProbeWaitFile(dst,contents)))
          throw new Error('测试源文件写入后内容无法确认');
        run.uncertain=false;
        nativeLifecycleNote(run,'save-'+name,{size:contents.length});
      }
      await nativeProbeIdle();
      notify('正在发起大型视频原生复制，并采样活动任务…');
      run.phase='preparing';
      run.uncertain=true;
      nativeLifecycleSnapshot(run);
      const startedAt=Date.now();
      const target=workspace+'/large/';
      await postNativeControl({mode:'file',action:'8',
        title:encodeURIComponent('UFS lifecycle large-file copy'),
        source:encodeURIComponent(video.path),target:encodeURIComponent(target),
        hdlink:'',sparse:'',exist:'1',zfs:''});
      nativeLifecycleNote(run,'large-copy-submitted',{at:startedAt,size:video.size});
      // The original file is never written: only native copies into our workspace.
      let observed=false;
      for(let i=0;i<18;i++){
        const active=await readNativeActive();
        const owner=nativeLifecycleActiveOwned(run,active);
        if(owner==='large'){observed=true;break;}
        if(owner!==null)throw new Error('原生活动任务被其他探针任务占用');
        await waitNative(150);
      }
      run.conclusion.runningEnqueue=observed?'pending':'not_observed_large_copy_was_too_fast';
      nativeLifecycleNote(run,'large-copy-observation',{activeObserved:observed});
      if(!observed)throw new Error('大文件复制未能在活动槽中被观察到；本轮不入队或自动刷新，避免误判');
      // Submit both queued jobs only while a matching large-copy action is active.
      for(let i=0;i<2;i++){
        const active=await readNativeActive();
        if(nativeLifecycleActiveOwned(run,active)!=='large')
          throw new Error('复制任务已结束或活动槽不匹配；停止继续入队');
        const source=nativeLifecycleFilePath(run,'source','queue'+(i+1)+'.txt');
        const destination=workspace+'/queue'+(i+1)+'/';
        const queue=await nativeProbeQueue();
        nativeLifecycleJobsOwned(run,queue);
        run.phase='preparing';
        nativeLifecycleSnapshot(run);
        await postNativeControl({mode:'file',task:encodeURIComponent(run.tasks[i]),action:'8',
          title:encodeURIComponent('UFS lifecycle queued copy'),
          source:encodeURIComponent(source),target:encodeURIComponent(destination),
          hdlink:'',sparse:'',exist:'1',zfs:''});
        const after=await nativeProbeQueue();
        const ids=nativeLifecycleJobsOwned(run,after);
        if(!ids.includes(i))throw new Error('已提交的排队任务未能在原生队列中确认');
        nativeLifecycleNote(run,'queued-during-active',{which:i+1,queueCount:after.length,
          activeBeforeSubmission:'large'});
      }
      run.conclusion.runningEnqueue='verified';
      const beforeRefreshActive=nativeLifecycleActiveOwned(run,await readNativeActive());
      const beforeRefreshJobs=await nativeProbeQueue();
      nativeLifecycleJobsOwned(run,beforeRefreshJobs);
      run.conclusion.f5OverlapObserved=!!beforeRefreshActive && beforeRefreshJobs.length>0;
      nativeLifecycleNote(run,'before-f5-observation',{
        active:beforeRefreshActive,queued:beforeRefreshJobs.length,
        simultaneousActiveAndQueue:run.conclusion.f5OverlapObserved
      });
      run.phase='before-reload';
      run.uncertain=false;
      run.reloadRequestedAt=new Date().toISOString();
      nativeLifecycleSnapshot(run);
      notify('运行中入队成功。现在自动刷新本页面，随后恢复观测…');
      window.location.reload();
    }catch(error){
      if(!run.steps.some(x=>x.name==='large-copy-submitted') && !run.workspaceCreated)
        run.uncertain=false;
      nativeLifecycleNote(run,'setup-aborted',{error:String(error.message||error)});
      notify('测试中止：'+String(error.message||error));
      await nativeLifecycleFinalize(run,'failed',error,notify);
    }
  }
  async function nativeLifecycleResume(run,notify){
    if(nativeLifecycleBusy)return;
    nativeLifecycleBusy=true;
    try{
      run.phase='resuming';
      run.resumedAt=new Date().toISOString();
      run.conclusion.f5Resume='observed_new_page';
      nativeLifecycleSnapshot(run);
      let idleSince=null,allCompleted=false,manualAdvances=0;
      const initial=(await Promise.all([readNativeActive(),nativeProbeQueue()]));
      const firstOwner=nativeLifecycleActiveOwned(run,initial[0]);
      nativeLifecycleJobsOwned(run,initial[1]);
      nativeLifecycleNote(run,'after-f5-first-observation',{
        nativeActive:firstOwner,queueCount:initial[1].length,
        elapsedFromRefreshMs:Date.now()-new Date(run.reloadRequestedAt).getTime()});
      notify('刷新后已重新读取原生活动槽及服务器端队列，持续观察…');
      const until=Date.now()+10*60*1000;
      let nextSample=0;
      let lastProgress=null;
      const unsubscribe=observeNativeProgress(data=>{
        if(data?.done===1)lastProgress={event:'done',time:Date.now()};
        else if(data?.status)lastProgress={event:'progress',time:Date.now()};
      });
      try{
        while(Date.now()<until){
          const active=await readNativeActive();
          const owner=nativeLifecycleActiveOwned(run,active);
          const queued=await nativeProbeQueue();
          const queuedIndexes=nativeLifecycleJobsOwned(run,queued);
          const bigSize=await nativeLifecycleFileSize(run.workspace+'/large',run.video.name);
          const q1=await nativeLifecycleFileSize(run.workspace+'/queue1','queue1.txt');
          const q2=await nativeLifecycleFileSize(run.workspace+'/queue2','queue2.txt');
          const source1='UFS_LIFECYCLE_QUEUE1_'+run.ownerToken;
          const source2='UFS_LIFECYCLE_QUEUE2_'+run.ownerToken;
          const smallComplete=q1===source1.length && q2===source2.length;
          const largeSizeMatch=bigSize===run.video.size;
          const now=Date.now();
          if(now>=nextSample || !owner && queued.length===0){
            run.samples.push({at:new Date().toISOString(),owner,queueCount:queued.length,
              queuedIndexes,bigSize,q1,q2,lastProgress});
            if(run.samples.length>150)run.samples.shift();
            nativeLifecycleSnapshot(run);
            nextSample=now+1500;
          }
          if(!owner && queued.length===0 && smallComplete && largeSizeMatch){
            allCompleted=true;
            nativeLifecycleNote(run,'queue-finished',{
              queueCount:0,manualAdvances,largeTargetSize:bigSize,
              integrity:'sizes-only-no-hash',eventsObserved:!!lastProgress});
            break;
          }
          if(!owner && queued.length>0 && largeSizeMatch){
            if(idleSince===null)idleSince=now;
            // No automatic advancement observed for 6 seconds after the
            // initial large copy. Record it and then manually promote only
            // a queue whose items ALL match the probe's unique source/target.
            if(now-idleSince>=6000){
              if(run.conclusion.automaticQueueAdvance==='not_tested')
                run.conclusion.automaticQueueAdvance='not_observed_with_browser_open';
              if(manualAdvances>=2)throw new Error('手动推进两次仍未完成队列');
              const before=await nativeProbeQueue();
              nativeLifecycleJobsOwned(run,before);
              if((await readNativeActive())!==null)throw new Error('提交 mode=start 前活动槽变化');
              const reply=(await postNativeControl({mode:'start'})).trim();
              if(!['1','2'].includes(reply))throw new Error('手动推进返回未知状态 '+reply);
              manualAdvances++;
              nativeLifecycleNote(run,'manual-start-after-idle',{
                reply,manualAdvances,queuedBefore:before.length});
              idleSince=null;
            }
          }else idleSince=null;
          notify('正在观测：原生活动任务 '+(owner||'无')+
            '，待执行 '+queued.length+'，已手动推进 '+manualAdvances+' 次。');
          await waitNative(500);
        }
      }finally{unsubscribe();}
      if(!allCompleted)throw new Error('10 分钟内未能确认所有队列任务完成');
      // No manual start means the queue was advanced by an external frontend,
      // not necessarily a headless server-side scheduler.
      if(manualAdvances===0)
        run.conclusion.automaticQueueAdvance='observed_with_browser_open';
      if(manualAdvances>0 && run.conclusion.automaticQueueAdvance==='not_tested')
        run.conclusion.automaticQueueAdvance='partially_observed_with_browser_open';
      if(!(await nativeProbeWaitFile(run.workspace+'/queue1/queue1.txt',
           'UFS_LIFECYCLE_QUEUE1_'+run.ownerToken)) ||
         !(await nativeProbeWaitFile(run.workspace+'/queue2/queue2.txt',
           'UFS_LIFECYCLE_QUEUE2_'+run.ownerToken)))
        throw new Error('排队结果文本内容核验失败');
      // Source may have changed during the test; metadata is evidence but not a hash.
      const original=await nativeProbeEntries(run.video.path.slice(0,run.video.path.lastIndexOf('/')));
      const videoNow=original.find(e=>e.path===run.video.path);
      run.conclusion.sourceUnchangedByMetadata=!!videoNow &&
        videoNow.size===run.video.size && videoNow.mtime===run.video.mtime;
      run.conclusion.largeCopy='file_size_matches_not_hash_verified';
      run.conclusion.f5Resume=run.conclusion.f5OverlapObserved?
        'verified_inflight_reconnected_and_completed':'verified_post_refresh_state_only';
      run.uncertain=false;
      await nativeLifecycleFinalize(run,'passed','',notify);
    }catch(error){
      // After F5, a failed verification is not evidence that the native
      // operation completed. Preserve our isolated workspace for inspection.
      run.uncertain=true;
      nativeLifecycleNote(run,'resume-aborted',{error:String(error.message||error)});
      notify('恢复观测中止：'+String(error.message||error));
      await nativeLifecycleFinalize(run,'failed',error,notify);
    }
  }
  function nativeLifecycleOnMount(){
    if(isDemo)return;
    const run=nativeLifecycleRead();
    if(!run)return;
    if(run.phase==='before-reload'){
      const notify=nativeLifecycleShowPanel('检测到刷新前保存的测试状态，正在安全恢复观察…');
      void nativeLifecycleResume(run,notify);
    } else if(run.phase!=='complete'){
      // Never automatically resubmit a request whose state is not explicitly
      // "before-reload"; preserve native task/queue state for manual review.
      const notify=nativeLifecycleShowPanel();
      void nativeLifecycleFinalize(run,'failed',
        '页面在准备或恢复阶段意外中断；不自动重发任务。',notify);
    }
  }

  function showDiagnosticCenter() {
    if(document.querySelector('.ufs-diagnostic-overlay')) return;
    const overlay=element('div','ufs-diagnostic-overlay');
    const dialog=element('section','ufs-diagnostic-panel');
    dialog.setAttribute('role','dialog');
    dialog.setAttribute('aria-modal','true');
    dialog.setAttribute('aria-label','File Station 诊断中心');
    const head=element('div','ufs-diagnostic-head');
    head.append(element('strong','','诊断中心 · v'+DIAGNOSTIC_VERSION));
    const close=element('button','','×');
    close.type='button';close.title='关闭';
    const dismiss=()=>overlay.remove();
    close.addEventListener('click',dismiss);
    head.append(close);
    const hint=element('p','','日志仅保存于当前浏览器。路径和文件名会脱敏；请在分享前检查导出文件。');
    const controls=element('div','ufs-diagnostic-controls');
    const debug=element('button','',diagnosticIsVerbose()?'关闭增强诊断':'开启增强诊断（15分钟）');
    const mark=element('button','','标记问题');
    const refresh=element('button','','刷新日志');
    const download=element('button','ufs-diagnostic-primary','导出 JSON');
    const nativeProbe=element('button','','原生能力测试');
    const lifecycleProbe=element('button','','任务生命周期测试');
    const clear=element('button','','清空日志');
    for(const button of [debug,mark,refresh,download,nativeProbe,lifecycleProbe,clear]) button.type='button';
    controls.append(debug,mark,refresh,download,nativeProbe,lifecycleProbe,clear);
    lifecycleProbe.addEventListener('click',()=>{dismiss();nativeLifecycleShowPanel();});
    nativeProbe.addEventListener('click',()=>{dismiss();showNativeProbeDialog();});
    const status=element('div','ufs-diagnostic-status','正在读取诊断记录…');
    const preview=element('pre','ufs-diagnostic-events','');
    const reload=async()=>{
      const events=await diagnosticReadAll();
      const triage=diagnosticTriage(events,diagnosticSanitize(diagnosticSnapshot()));
      status.textContent=(triage.primaryIssue?
        'AI 诊断线索：'+triage.primaryIssue.code+' · '+triage.primaryIssue.occurrences+' 次 · ':
        'AI 诊断：近期未识别到异常 · ')+
        '已记录 '+events.length+' 条事件'+
        (diagnosticStorageError?' · 持久化不可用：'+diagnosticStorageError:'')+
        (diagnosticIsVerbose()?' · 增强诊断中':'');
      preview.textContent=events.slice(-100).map(event=>
        new Date(event.time).toLocaleTimeString('zh-CN',{hour12:false})+'  '+
        event.level.padEnd(5)+'  '+event.code+'  '+
        JSON.stringify(event.details)).join('\n')||'暂无日志';
      preview.scrollTop=preview.scrollHeight;
    };
    debug.addEventListener('click',()=>{
      diagnosticSetVerbose(!diagnosticIsVerbose());
      debug.textContent=diagnosticIsVerbose()?'关闭增强诊断':'开启增强诊断（15分钟）';
      void reload();
    });
    mark.addEventListener('click',()=>{
      diagnosticMarkIssue();
      void reload();
    });
    refresh.addEventListener('click',()=>void reload());
    download.addEventListener('click',async()=>{
      download.disabled=true;
      try { await diagnosticExport(); }
      catch(error) { status.textContent='导出失败：'+diagnosticScrub(error?.message||error); }
      finally { download.disabled=false; }
    });
    clear.addEventListener('click',async()=>{
      if(!window.confirm('确认清空本浏览器保存的 File Station 诊断记录？')) return;
      await diagnosticClear();
      void reload();
    });
    overlay.addEventListener('click',event=>{if(event.target===overlay)dismiss();});
    overlay.addEventListener('keydown',event=>{
      if(event.key==='Escape') {event.preventDefault();dismiss();}
    });
    dialog.append(head,hint,controls,status,preview);
    overlay.append(dialog);
    document.body.append(overlay);
    close.focus();
    void reload();
  }
  function startDiagnosticMonitoring() {
    diagnosticLog('INFO','page.mount',{version:DIAGNOSTIC_VERSION,route:location.pathname,
      verbose:diagnosticIsVerbose()});
    const captureError=event=>{
      const file=String(event.filename||'');
      const stack=String(event.error?.stack||'');
      if(!/unraid-file-station|ufs-/i.test(file+' '+stack)) return;
      diagnosticLog('ERROR','javascript.error',{
        type:event.error?.name||'Error',message:event.message||event.error?.message,
        file,line:event.lineno,column:event.colno,stack
      });
    };
    const captureRejection=event=>{
      const reason=event.reason;
      const stack=String(reason?.stack||'');
      if(!/unraid-file-station|ufs-/i.test(stack)) return;
      diagnosticLog('ERROR','javascript.unhandled_rejection',{
        type:reason?.name||'Error',message:reason?.message||String(reason),stack
      });
    };
    window.addEventListener('error',captureError,{signal:lifecycle.signal});
    window.addEventListener('unhandledrejection',captureRejection,{signal:lifecycle.signal});
    onCleanup(()=>{
      if(diagnosticFlushTimer!==null)clearTimeout(diagnosticFlushTimer);
      void diagnosticFlush();
    });
    void diagnosticPrune().catch(error=>{
      diagnosticStorageError=diagnosticScrub(error?.message||error);
    });
  }


  // v0.2.7 stage 1: durable data model only. Reading snapshots never submits
  // native writes, starts the scheduler or silently confirms copied files.
  const COPY_QUEUE_SCHEMA=1;
  const MOVE_ENABLED=true;
  const DELETE_ENABLED=true;
  const COPY_QUEUE_DATABASE='ufs-copy-queue-v1';
  const COPY_QUEUE_STATES=new Set([
    'queued','checking','submission-intent','copying','verifying',
    'success','skipped','failed','uncertain','excluded','running','stopped','removed'
  ]);
  function normalizeSavedCopyItem(item) {
    if (!item || typeof item!=='object' || Array.isArray(item) ||
        !safeCopyPath(item.source) || typeof item.folder!=='boolean' ||
        !COPY_QUEUE_STATES.has(item.status) ||
        !['not-submitted','intent-saved','confirmed','unknown'].includes(item.submission) ||
        (item.moveOutcome!==undefined && item.moveOutcome!=='merged-partial')) {
      throw new Error('持久化复制项目格式错误或路径不安全');
    }
    return {
      source:item.source,folder:item.folder,
      name:fileName(item.source),
      size:Number.isFinite(item.size)&&item.size>=0?item.size:null,
      status:item.status,submission:item.submission,
      ...(item.moveOutcome==='merged-partial'?{moveOutcome:'merged-partial'}:{}),
      updatedAt:Number.isFinite(item.updatedAt)?item.updatedAt:0
    };
  }
  function normalizeSavedCopyTask(task) {
    if (!task || typeof task!=='object' || Array.isArray(task) ||
        typeof task.taskId!=='string' || !/^[a-zA-Z0-9_-]{8,96}$/.test(task.taskId) ||
        typeof task.name!=='string' || !task.name || task.name.length>300 ||
        !safeCopyPath(task.destination,true) ||
        !['skip','overwrite','fail'].includes(task.conflictPolicy) ||
        !COPY_QUEUE_STATES.has(task.status) ||
        !Array.isArray(task.items) || !task.items.length || task.items.length>10000) {
      throw new Error('持久化复制任务格式错误或路径不安全');
    }
    const operation=task.operation||'copy';
    if(!['copy','move','delete'].includes(operation) ||
       (operation!=='copy' && (!safeWritePath(task.destination,true) ||
         (operation==='delete' && task.conflictPolicy!=='fail'))))
      throw new Error('持久化移动任务格式错误');
    const items=task.items.map(normalizeSavedCopyItem);
    if(operation!=='copy' && items.some(item=>!safeWritePath(item.source)))
      throw new Error('不安全的移动源路径');
    if(operation!=='delete' && items.some(item=>!copyDestinationAllowed(
      {source:item.source,folder:item.folder},task.destination))) {
      throw new Error('恢复任务包含不安全或自包含的目标目录');
    }
    if(task.batchMode!==undefined &&
       !['native-move-files','native-move-mixed'].includes(task.batchMode))
      throw new Error('未知的原生批量移动模式');
    if(['native-move-files','native-move-mixed'].includes(task.batchMode)) {
      const plans=items.map(item=>({type:'move',source:item.source,folder:item.folder,
        destinationDir:task.destination,
        target:task.destination+'/'+fileName(item.source),conflictPolicy:task.conflictPolicy}));
      if(operation!=='move' || nativeMoveBatchMode(plans)!==task.batchMode)
        throw new Error('持久化批量移动签名不匹配');
    }
    return {
      taskId:task.taskId,name:task.name,destination:task.destination,
      conflictPolicy:task.conflictPolicy,status:task.status,
      ...(operation==='copy'?{}:{operation}),
      ...(task.batchMode?{batchMode:task.batchMode}:{}),
      createdAt:Number.isFinite(task.createdAt)?task.createdAt:0,
      updatedAt:Number.isFinite(task.updatedAt)?task.updatedAt:0,
      items
    };
  }
  function validateCopyQueueSnapshot(snapshot) {
    if(!snapshot || typeof snapshot!=='object' || Array.isArray(snapshot) ||
        snapshot.schema!==COPY_QUEUE_SCHEMA ||
        !Array.isArray(snapshot.tasks) || snapshot.tasks.length>1000) {
      throw new Error('复制队列持久化格式不兼容，禁止自动恢复');
    }
    const tasks=snapshot.tasks.map(normalizeSavedCopyTask);
    const ids=new Set(tasks.map(task=>task.taskId));
    if(ids.size!==tasks.length)
      throw new Error('复制队列存在重复任务 ID，禁止自动恢复');
    return {
      schema:COPY_QUEUE_SCHEMA,
      savedAt:Number.isFinite(snapshot.savedAt)?snapshot.savedAt:0,
      tasks
    };
  }
  function copyRecoveryAssessment(snapshot) {
    const valid=validateCopyQueueSnapshot(snapshot);
    // Any pre-existing intent is ambiguous after reload, even when Browse.php
    // reports a matching filename and a size; a file may be incomplete.
    const tasks=valid.tasks.map(task=>{
      const items=task.items.map(item=>{
        const ambiguous=item.submission==='intent-saved' ||
          item.submission==='unknown' ||
          ['submission-intent','copying','verifying','uncertain'].includes(item.status);
        return {...item,restoreStatus:ambiguous?'needs-verification':
          ['success','skipped','excluded'].includes(item.status)?'terminal':
          item.status==='queued'||item.status==='checking'?'waiting':'needs-verification'};
      });
      // No native POST was possible for a failed task whose remaining items
      // have never saved submission intent. Do not turn it into "uncertain".
      const safelyFailed=task.status==='failed' && items.every(item=>
        (item.submission==='not-submitted' &&
          ['queued','checking','failed','skipped','excluded'].includes(item.status)) ||
        (item.submission==='confirmed' && ['success','skipped','excluded'].includes(item.status)));
      return {...task,restoreStatus:safelyFailed?'safe-failed':
        items.some(item=>item.restoreStatus==='needs-verification')
          ?'needs-verification':items.some(item=>item.restoreStatus==='waiting')
            ?'waiting':'terminal',items};
    });
    return {schema:valid.schema,savedAt:valid.savedAt,tasks,
      requiresConfirmation:tasks.some(task=>!['terminal','safe-failed'].includes(task.restoreStatus))};
  }
  function createCopyQueueStore(idb,dbName=COPY_QUEUE_DATABASE) {
    if(!idb || typeof idb.open!=='function')
      throw new Error('IndexedDB 不可用，无法保证复制任务持久化');
    let opened=null;
    const open=()=>opened ||= new Promise((resolve,reject)=>{
      const request=idb.open(dbName,COPY_QUEUE_SCHEMA);
      request.onupgradeneeded=()=>{
        const db=request.result;
        if(!db.objectStoreNames.contains('snapshots'))
          db.createObjectStore('snapshots',{keyPath:'key'});
        if(!db.objectStoreNames.contains('leases'))
          db.createObjectStore('leases',{keyPath:'key'});
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error||new Error('无法打开复制任务数据库'));
      request.onblocked=()=>reject(new Error('复制任务数据库被其他页面阻塞'));
    }).catch(error=>{opened=null;throw error;});
    const transaction=(store,mode,work)=>open().then(db=>new Promise((resolve,reject)=>{
      const tx=db.transaction(store,mode);
      const table=tx.objectStore(Array.isArray(store)?store[0]:store);
      let result;
      tx.oncomplete=()=>resolve(result);
      tx.onabort=()=>reject(tx.error||new Error('复制队列事务被中止'));
      tx.onerror=()=>{}; // onabort reports the transaction failure.
      try {work(table,value=>{result=value;},tx);} catch(error) {
        try{tx.abort();}catch(_){}
        reject(error);
      }
    }));
    const read=()=>transaction('snapshots','readonly',(table,result)=>{
      const request=table.get('active');
      request.onsuccess=()=>result(request.result?.snapshot??null);
    }).then(raw=>raw?validateCopyQueueSnapshot(raw):null);
    const write=snapshot=>{
      const valid=validateCopyQueueSnapshot(snapshot);
      return transaction('snapshots','readwrite',table=>
        {table.put({key:'active',snapshot:valid});});
    };
    // Lease verification and queue write MUST occur in the same transaction.
    // A tab that lost its lease must not overwrite the new controller's state.
    const writeOwned=(snapshot,owner)=>{
      const valid=validateCopyQueueSnapshot(snapshot);
      return transaction(['snapshots','leases'],'readwrite',(stores,result,tx)=>{
        const request=tx.objectStore('leases').get('dispatcher');
        request.onsuccess=()=>{
          if(!request.result || request.result.owner!==owner ||
              request.result.expiresAt<=Date.now()) {
            tx.abort();return;
          }
          tx.objectStore('snapshots').put({key:'active',snapshot:valid});
          result(true);
        };
      });
    };
    // Transaction serialization is crucial: separate tabs cannot both take
    // an active lease using a non-atomic localStorage "check then set".
    const claim=(owner,now=Date.now(),ttl=30000)=> {
      if(typeof owner!=='string' || owner.length<8 || owner.length>128 ||
          !Number.isFinite(ttl) || ttl<3000 || ttl>120000)
        return Promise.reject(new Error('无效的队列所有权参数'));
      return transaction('leases','readwrite',(table,result)=>{
        const request=table.get('dispatcher');
        request.onsuccess=()=>{
          const previous=request.result;
          if(previous && previous.owner!==owner && previous.expiresAt>now) {
            result(false);
            return;
          }
          table.put({key:'dispatcher',owner,expiresAt:now+ttl});
          result(true);
        };
      });
    };
    const release=owner=>transaction('leases','readwrite',(table,result)=>{
      const request=table.get('dispatcher');
      request.onsuccess=()=>{
        const held=request.result?.owner===owner;
        if(held) table.delete('dispatcher');
        result(held);
      };
    });
    // Inspection never changes the lease and is safe even if another tab is active.
    const inspect=()=>transaction('leases','readonly',(table,result)=>{
      const request=table.get('dispatcher');
      request.onsuccess=()=>result(request.result||null);
    });
    return {open,read,write,writeOwned,claim,release,inspect};
  }

  let activeCopySession = null;
  const copyJobs=[];
  let copyJobCounter=0;
  let copyQueueRunning=false;
  let copyQueuePaused=false;
  let copyCleanupPending=false;
  let copyCleanupError='';

  // Browser persistence is deliberately fail-closed. The only automatic
  // startup action is reading/restoring records, never scheduling work.
  let persistentCopyStore=null;
  let persistenceStartup=null;
  let persistenceError='';
  let copyRecoveryLocked=false;
  let copyPersistTail=Promise.resolve();
  let lastPersistedTasks=null;
  let copyOwnerHeld=false;
  let copyLeaseTimer=null;
  let copyLeaseRefreshPending=null;
  let copyLeaseReleasePending=null;
  let copyOwnerReservations=0;
  const copyOwnerId='ufs_'+Date.now().toString(36)+'_'+
    Math.random().toString(36).slice(2,16);
  const COPY_LEASE_TTL=30000;
  // taskId identifies one persisted record. An identical unfinished operation
  // is a collision, whereas completed historical records remain separate.
  function copyTaskSignature(record) {
    if(!record || !Array.isArray(record.items))return '';
    const items=record.items.map(item=>JSON.stringify([item.source,Boolean(item.folder)])).sort();
    return JSON.stringify([record.operation||'copy',record.destination,
      record.conflictPolicy,items]);
  }
  function findUnfinishedDuplicate(record,jobs=copyJobs) {
    const signature=copyTaskSignature(record);
    if(!signature)return null;
    return jobs.find(job=>job.record && (
      ['queued','running','uncertain','stopped'].includes(job.status) ||
      job.record.items.some(item=>
        ['intent-saved','unknown'].includes(item.submission) &&
        !['success','skipped','excluded'].includes(item.status))) &&
      copyTaskSignature(job.record)===signature) || null;
  }
  function copySavedSnapshot() {
    return validateCopyQueueSnapshot({schema:COPY_QUEUE_SCHEMA,savedAt:Date.now(),
      tasks:copyJobs.filter(job=>job.record).map(job=>job.record)});
  }
  // Lease may be surrendered only after the final durable checkpoint.
  // Queued/recovered/uncertain jobs must never lose their exclusive writer.
  function copyQueueNeedsOwnership() {
    return copyQueueRunning || copyCleanupPending || copyOwnerReservations>0 ||
      copyQueuePaused || copyRecoveryLocked ||
      copyJobs.some(job=>
        !['success','failed'].includes(job.status) ||
        job.record?.items?.some(item=>
          ['intent-saved','unknown'].includes(item.submission) &&
          !['success','skipped','excluded'].includes(item.status)));
  }
  function stopCopyLeaseTimer() {
    if(copyLeaseTimer!==null){clearInterval(copyLeaseTimer);copyLeaseTimer=null;}
  }
  async function releaseIdleCopyOwnership(reason='idle') {
    if(copyLeaseReleasePending) return copyLeaseReleasePending;
    if(!copyOwnerHeld || !persistentCopyStore || copyQueueNeedsOwnership() || destroyed)
      return false;
    const task=(async()=>{
      // Do not release while the final queue snapshot (or a renewal) is in flight.
      await copyPersistTail;
      if(copyLeaseRefreshPending)await copyLeaseRefreshPending;
      if(!copyOwnerHeld || copyQueueNeedsOwnership() || destroyed)return false;
      const released=await persistentCopyStore.release(copyOwnerId);
      copyOwnerHeld=false;
      stopCopyLeaseTimer();
      diagnosticLog(released?'INFO':'WARN','queue.lease_released',{
        reason,released,ownerTag:diagnosticPathId(copyOwnerId)});
      return released;
    })().catch(error=>{
      diagnosticLog('WARN','queue.lease_release_failed',{reason,message:String(error?.message||error)});
      return false;
    });
    copyLeaseReleasePending=task;
    try{return await task;}finally{if(copyLeaseReleasePending===task)copyLeaseReleasePending=null;}
  }
  async function copyLeaseObservation() {
    if(!persistentCopyStore?.inspect)return null;
    const lease=await persistentCopyStore.inspect();
    const now=Date.now();
    return lease?{
      state:lease.expiresAt>now?'active':'expired',
      remainingMs:Math.max(0,lease.expiresAt-now),
      ownerTag:diagnosticPathId(lease.owner),
      isCurrentOwner:lease.owner===copyOwnerId,
      observedAt:now
    }:{state:'none',remainingMs:0,ownerTag:null,isCurrentOwner:false,observedAt:now};
  }
  async function ensureCopyOwnership() {
    if(persistenceError) throw new Error(persistenceError);
    if(!persistentCopyStore) throw new Error('持久化尚未初始化，不能提交文件任务');
    if(copyLeaseReleasePending)await copyLeaseReleasePending;
    const won=await persistentCopyStore.claim(copyOwnerId,Date.now(),COPY_LEASE_TTL);
    if(!won) {
      copyOwnerHeld=false;
      let observation=null;
      try{observation=await copyLeaseObservation();}
      catch(error){diagnosticLog('WARN','queue.lease_inspection_failed',{message:error?.message});}
      diagnosticLog('WARN','queue.lease_denied',{
        remainingMs:observation?.remainingMs??null,
        holder:observation?.ownerTag??null,
        leaseState:observation?.state??'unknown'
      });
      const remaining=observation?.remainingMs>0 ?
        '（约 '+Math.ceil(observation.remainingMs/1000)+' 秒后过期）':'';
      throw new Error('文件操作队列被其他页面实例或尚未过期的旧租约占用'+remaining+'，请稍后重试');
    }
    copyOwnerHeld=true;
    diagnosticLog('INFO','queue.lease_acquired',{ownerTag:diagnosticPathId(copyOwnerId)});
    if(!copyLeaseTimer) {
      copyLeaseTimer=setInterval(()=>{
        if(!copyOwnerHeld || destroyed || copyLeaseReleasePending)return;
        if(!copyQueueNeedsOwnership()){
          void releaseIdleCopyOwnership('idle-heartbeat');
          return;
        }
        if(copyLeaseRefreshPending)return;
        const renewal=persistentCopyStore.claim(copyOwnerId,Date.now(),COPY_LEASE_TTL)
          .then(ok=>{
            if(!ok) {
              copyOwnerHeld=false;
              copyQueuePaused=true;
              diagnosticLog('ERROR','queue.lease_lost',{});
              updateCopyTaskButton();
            }
          }).catch(error=>copyPersistenceFailure(error));
        copyLeaseRefreshPending=renewal;
        void renewal.finally(()=>{
          if(copyLeaseRefreshPending===renewal)copyLeaseRefreshPending=null;
        }).catch(()=>{});
      },10000);
    }
  }
  function copyPersistenceFailure(error) {
    diagnosticLog('ERROR','queue.persistence_failed',{message:error?.message});
    persistenceError='复制任务持久化失败：'+String(error?.message||error);
    copyQueuePaused=true;
    copyOwnerHeld=false;
    updateCopyTaskButton();
    notify(persistenceError+'；后续任务已暂停，请勿直接重试。');
  }
  function persistCopyQueue() {
    // Serialize snapshots in enqueue order; keep the promise after a failure
    // so no later write can silently bypass an earlier failed write.
    const snap=copySavedSnapshot();
    const pending=copyPersistTail.then(async()=>{
      if(!copyOwnerHeld || !persistentCopyStore)
        throw new Error('当前标签页没有安全的队列写入权限');
      await persistentCopyStore.writeOwned(snap,copyOwnerId);
      diagnosticLog('DEBUG','queue.persisted',{tasks:snap.tasks.length});
      lastPersistedTasks=JSON.stringify(snap.tasks);
    });
    copyPersistTail=pending.catch(error=>{copyPersistenceFailure(error);throw error;});
    // Give callers the original error without creating a dangling rejection.
    void copyPersistTail.catch(()=>{});
    return pending;
  }
  async function copyItemCheckpoint(job,index,status,submission) {
    if(!job?.record?.items[index])
      throw new Error('持久化项目索引不一致，拒绝原生复制');
    const item=job.record.items[index];
    item.status=status;
    if(submission) item.submission=submission;
    item.updatedAt=Date.now();
    job.record.updatedAt=item.updatedAt;
    await persistCopyQueue();
    diagnosticLog('INFO','queue.checkpoint',{taskId:job.taskId,itemIndex:index,status,submission:item.submission});
    if(destroyed || !copyOwnerHeld || (copyQueuePaused && status!=='excluded'))
      throw new Error('持久化状态不可信或队列已暂停，拒绝继续复制');
  }
  async function copyBatchCheckpoint(job,status,submission) {
    const record=job?.record,plans=savedMoveBatchPlans(record);
    if(!plans || record.items.length!==plans.length)
      throw new Error('批量移动持久化记录不完整，拒绝提交');
    const time=Date.now();
    for(const item of record.items) {
      item.status=status;
      item.submission=submission;
      item.updatedAt=time;
    }
    record.updatedAt=time;
    await persistCopyQueue();
    diagnosticLog('INFO','queue.batch_checkpoint',{taskId:job.taskId,
      count:record.items.length,status,submission});
    if(destroyed || !copyOwnerHeld || copyQueuePaused)
      throw new Error('已失去队列持久化权限，拒绝提交原生批量移动');
  }
  function newCopyRecord(entries,destination,conflictPolicy,name,operation='copy') {
    return normalizeSavedCopyTask({
      taskId:'copy_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,16),
      name,destination,conflictPolicy,status:'queued',
      ...(operation==='copy'?{}:{operation}),
      createdAt:Date.now(),updatedAt:Date.now(),
      items:entries.map(entry=>({
        source:entry.path,folder:entry.folder,size:entry.size,
        status:'queued',submission:'not-submitted',updatedAt:Date.now()
      }))
    });
  }
  async function initializeCopyPersistence() {
    if(persistenceStartup) return persistenceStartup;
    persistenceStartup=(async()=>{
      try {
        persistentCopyStore=createCopyQueueStore(window.indexedDB);
        const saved=await persistentCopyStore.read();
        diagnosticLog('INFO','queue.restore_read',{tasks:saved?.tasks.length||0});
        if(destroyed) return;
        lastPersistedTasks=JSON.stringify(saved?.tasks||[]);
        if(saved?.tasks.length) {
          const assessed=copyRecoveryAssessment(saved);
          diagnosticLog('WARN','queue.restore_assessed',{
            tasks:assessed.tasks.length,requiresConfirmation:assessed.requiresConfirmation,
            statuses:assessed.tasks.map(task=>({taskId:task.taskId,status:task.restoreStatus}))});
          // Records recovered from a page reload have no old JavaScript
          // execution context. Even unsubmitted work must await user consent.
          copyQueuePaused=assessed.requiresConfirmation;
          copyRecoveryLocked=assessed.requiresConfirmation;
          for(const data of assessed.tasks) {
            const record=normalizeSavedCopyTask(data);
            // A checked but never submitted item can safely run a fresh
            // preflight after explicit user confirmation.
            for(const item of record.items)
              if(item.status==='checking' && item.submission==='not-submitted')
                item.status='queued';
            const job={
              id:++copyJobCounter,taskId:record.taskId,record,recovered:true,
              name:record.name,destination:record.destination,
              conflictPolicy:record.conflictPolicy,count:record.items.length,
              status:data.restoreStatus==='terminal'?'success':
                data.restoreStatus==='safe-failed'?'failed':
                data.restoreStatus==='needs-verification'?'uncertain':'queued',
              phase:data.restoreStatus==='safe-failed'?'failed':
                data.restoreStatus==='needs-verification'?'uncertain':'queued',
              preflightRejected:data.restoreStatus==='safe-failed',
              recoverable:data.restoreStatus==='safe-failed',
              percent:null,speed:'',speedUpdatedAt:0,
              reopen:()=>showRecoveredCopyDetails(job),
              cancelQueued:()=>void discardRecoveredCopyJob(job),
              prepare:()=>{},
              execute:()=>executeRecoveredCopyJob(job)
            };
            copyJobs.push(job);
            diagnosticLog('INFO','queue.restored_task',{
              taskId:job.taskId,operation:record.operation||'copy',
              items:record.items.length,status:job.status,originalStatus:record.status});
          }
          updateCopyTaskButton();
          // Reconnect only the already-running native rsync. No file writes,
          // queue resumption, or progress claims happen during this lookup.
          if(assessed.requiresConfirmation && assessed.tasks.some(task=>
            task.items?.some(item=>item.restoreStatus==='needs-verification')))
            void monitorRecoveredNativeTask();
        }
      } catch(error) {
        diagnosticLog('ERROR','queue.restore_failed',{message:error?.message});
        persistenceError='无法读取复制任务数据库：'+String(error?.message||error);
        copyQueuePaused=true;
        notify(persistenceError);
      }
    })();
    return persistenceStartup;
  }

  // A browser refresh destroys the original job's polling/websocket listeners,
  // but not Unraid's rsync process. Re-attach observability only when one and
  // only one saved submitted item matches Control.php mode=read exactly.
  async function monitorRecoveredNativeTask() {
    if(destroyed || !copyRecoveryLocked || !copyJobs.some(job=>job.recovered))return;
    let active;
    try {active=await readNativeActive();}
    catch(error) {
      diagnosticLog('WARN','queue.recovery_native_read_failed',{message:error?.message});
      return;
    } // Network errors preserve the existing "待核实" state.
    if(destroyed)return;
    if(!active){
      // The server's active slot does not retain historical completion receipts.
      // Preserve the saved task; never re-POST or read back both files.
      diagnosticLog('INFO','queue.recovery_native_idle',{
        unresolved:copyJobs.filter(job=>job.recovered&&job.status==='uncertain').length,
        action:'hold-for-user-decision'});
      return;
    }
    const matches=[];
    for(const job of copyJobs) {
      if(!job.recovered)continue;
      const grouped=savedMoveBatchPlans(job.record);
      if(grouped) {
        // One native CR-joined task owns ALL entries. Never mistake any one
        // source for an independently retryable task after a page reload.
        const ambiguous=job.record.items.every(item=>
          ['intent-saved','unknown'].includes(item.submission) &&
          ['submission-intent','copying','verifying','uncertain'].includes(item.status));
        if(ambiguous && matchesMoveBatchTask(active,grouped))
          matches.push({job,index:-1,batch:true,
            signature:{folder:false,source:grouped.map(p=>p.source).join('\r'),
              destinationDir:job.destination}});
        continue;
      }
      for(let i=0;i<job.record.items.length;i++){
        const item=job.record.items[i];
        if(!['intent-saved','unknown'].includes(item.submission) ||
            !['submission-intent','copying','verifying','uncertain'].includes(item.status))continue;
        const signature={
          folder:item.folder,source:item.source,destinationDir:job.destination
        };
        if((job.record.operation==='delete'?matchesDeleteTask(active,signature):
          job.record.operation==='move'?matchesMoveTask(active,signature):matchesCopyTask(active,signature)))matches.push({job,index:i,signature});
      }
    }
    if(matches.length!==1) {
      diagnosticLog('WARN','queue.recovery_match',{matched:matches.length,hasActive:!!active});
      return;
    }
    const {job,index,signature,batch=false}=matches[0];
    diagnosticLog('INFO','queue.recovery_attached',{
      taskId:job.taskId,itemIndex:index,batch,count:batch?job.record.items.length:1});
    job.recoveryMonitoring=true;
    job.recoveryMonitorIndex=index;
    job.recoveryBatch=batch;
    job.status='running';
    job.phase='copying';
    job.percent=null;
    job.speed='';
    job.speedUpdatedAt=0;
    // Keep the scheduler paused regardless of the native process state.
    copyQueuePaused=true;
    copyRecoveryLocked=true;
    updateCopyTaskButton();
    let finishedEvent=false;
    let errorEvent='';
    let stopped=false;
    const unwatch=observeNativeProgress(data=>{
      if(stopped || destroyed || !job.recoveryMonitoring)return;
      const payload=nativeCopyProgressPayload(data);
      if(payload) {
        const info=parseRsyncProgress(payload);
        copyJobSignal(job,'copying',info);
        if(!signature.folder && Number.isFinite(info?.percent))
          job.percent=Math.max(job.percent??0,Math.min(99.9,info.percent));
        if(typeof info?.eta==='string')job.eta=info.eta;
        updateCopyTaskButton();
      }
      if(data.error)errorEvent=stripNativeStatusHtml(data.error).slice(0,200);
      if(data.done===1)finishedEvent=true;
    });
    onCleanup(unwatch);
    let idle=0;
    let sameTaskObserved=true; // Matched against the first active read.
    try {
      while(!destroyed && !stopped) {
        await waitNative(950);
        if(destroyed) return;
        if(errorEvent)break;
        let current;
        try {current=await readNativeActive();}
        catch(_) {break;}
        if(destroyed)return;
        if(current) {
          if(!(job.record.operation==='delete'?matchesDeleteTask(current,signature):
            job.record.operation==='move'?matchesMoveTask(current,signature):matchesCopyTask(current,signature)))break;
          sameTaskObserved=true;
          idle=0;
        } else if(++idle>=2) {
          // A disappearing task is NOT itself proof of success. The shared
          // native progress channel must also have reported completion.
          if(finishedEvent && sameTaskObserved) {
            try {
              if(batch)await verifyRecoveredNativeBatch(job);
              else await verifyRecoveredNativeCopy(job,index);
              return;
            } catch(_) { /* Inconclusive or concurrent writes: mark uncertain. */ }
          }
          break;
        }
      }
    } finally {
      stopped=true;
      unwatch();
      if(!destroyed && job.recoveryMonitoring) {
        job.recoveryMonitoring=false;
        job.recoveryMonitorIndex=-1;
        job.recoveryBatch=false;
        diagnosticLog('WARN','queue.recovery_uncertain',{taskId:job.taskId,itemIndex:index,batch,
          hadDone:finishedEvent,errorEvent,matched:sameTaskObserved});
        job.status='uncertain';
        job.phase='uncertain';
        job.speed='';
        job.speedUpdatedAt=0;
        copyQueuePaused=true;
        copyRecoveryLocked=true;
        updateCopyTaskButton();
      }
    }
  }

  async function verifyRecoveredNativeBatch(job) {
    const plans=savedMoveBatchPlans(job.record);
    if(!plans || destroyed)throw new Error('无法恢复不可信的原生批量移动');
    const [sources,targets]=await Promise.all([
      listDirectory(parentPath(plans[0].source)),listDirectory(job.destination)
    ]);
    const sourceNames=new Set(sources.map(entry=>entry.path));
    const targetEntries=new Map(targets.map(entry=>[entry.path,entry]));
    for(let i=0;i<plans.length;i++) {
      const plan=plans[i],item=job.record.items[i];
      const target=targetEntries.get(plan.target);
      if(sourceNames.has(plan.source) || !target ||
         target.folder!==plan.folder || target.copyPathVerified===false ||
         (!plan.folder && Number.isFinite(item.size) && Number.isFinite(target.size) &&
          item.size!==target.size))
        throw new Error('批量恢复仍存在未核实文件');
    }
    await ensureCopyOwnership();
    await copyPersistTail;
    const saved=await persistentCopyStore.read();
    if(!saved || JSON.stringify(saved.tasks)!==lastPersistedTasks)
      throw new Error('批量恢复前队列快照发生变化');
    const oldItems=job.record.items.map(item=>({...item}));
    const oldStatus=job.record.status,oldUpdated=job.record.updatedAt;
    const time=Date.now();
    for(const item of job.record.items) {
      item.status='success';
      item.submission='confirmed';
      item.updatedAt=time;
    }
    job.record.updatedAt=time;
    job.record.status='success';
    try {await persistCopyQueue();}
    catch(error) {
      job.record.items=oldItems;
      job.record.status=oldStatus;
      job.record.updatedAt=oldUpdated;
      throw error;
    }
    diagnosticLog('INFO','queue.batch_recovery_verified',{
      taskId:job.taskId,count:plans.length,mode:'native-cr-source',
      batchMode:job.record.batchMode,folderVerification:'top-level-only'});
    job.recoveryMonitoring=false;
    job.recoveryMonitorIndex=-1;
    job.recoveryBatch=false;
    job.status='success';
    job.phase='success';
    job.speed='';
    job.speedUpdatedAt=0;
    copyQueuePaused=true;
    copyRecoveryLocked=copyJobs.some(j=>j.recovered&&
      (j.status==='queued'||j.status==='uncertain'||j.status==='running'));
    if(!copyRecoveryLocked)copyQueuePaused=false;
    updateCopyTaskButton();
  }
  async function verifyRecoveredNativeCopy(job,index) {
    const item=job.record.items[index];
    if(!item || destroyed)throw new Error('原生监控结果已失效');
    if(job.record.operation==='delete') {
      const current=await listDirectory(parentPath(item.source));
      if(current.some(entry=>entry.path===item.source))
        throw new Error('原生删除后源项目仍存在，结果待核实');
    } else {
    const target=job.destination+'/'+fileName(item.source);
    // As in the ordinary copy flow, verify the original and destination.
    // Existence/size alone are insufficient; we require matching native
    // activity AND the native done event before reaching this function.
    const [origins,destinations]=await Promise.all([
      listDirectory(parentPath(item.source)),listDirectory(job.destination)
    ]);
    const origin=origins.find(entry=>entry.path===item.source);
    const dest=destinations.find(entry=>entry.path===target);
    if((job.record.operation==='move'?!!origin:!origin) || !dest ||
        dest.folder!==item.folder || (origin && origin.folder!==item.folder) ||
        origin?.copyPathVerified===false || dest.copyPathVerified===false)
      throw new Error('原生任务结束后源或目标无法核实');
    if(job.record.operation!=='move' && !item.folder && Number.isFinite(origin?.size) &&
        Number.isFinite(dest.size) && origin.size!==dest.size)
      throw new Error('原生任务结束后文件大小不一致');
    }
    // Release of the old browser tab's lease may lag behind reload. If the
    // snapshot is no longer ours to update, keep it unverified instead.
    await ensureCopyOwnership();
    await copyPersistTail;
    const saved=await persistentCopyStore.read();
    if(!saved || JSON.stringify(saved.tasks)!==lastPersistedTasks)
      throw new Error('队列快照已被其他页面修改');
    const previous={status:item.status,submission:item.submission,
      updatedAt:item.updatedAt,jobStatus:job.record.status,jobUpdatedAt:job.record.updatedAt};
    item.status='success';
    item.submission='confirmed';
    item.updatedAt=Date.now();
    job.record.updatedAt=item.updatedAt;
    const waiting=job.record.items.some(x=>
      x.status==='queued' || (x.status==='checking' && x.submission==='not-submitted'));
    job.record.status=waiting?'queued':'success';
    try {
      await persistCopyQueue();
    } catch(error) {
      // Failed commit is not evidence of a persisted success.
      item.status=previous.status;
      item.submission=previous.submission;
      item.updatedAt=previous.updatedAt;
      job.record.status=previous.jobStatus;
      job.record.updatedAt=previous.jobUpdatedAt;
      throw error;
    }
    job.recoveryMonitoring=false;
    job.recoveryMonitorIndex=-1;
    job.status=waiting?'queued':'success';
    job.phase=waiting?'queued':'success';
    job.speed='';
    job.speedUpdatedAt=0;
    copyQueuePaused=true; // NEVER resume waiting jobs on native completion.
    copyRecoveryLocked=copyJobs.some(j=>j.recovered&&
      (j.status==='queued'||j.status==='uncertain'||j.status==='running'));
    if(!copyRecoveryLocked)copyQueuePaused=false;
    updateCopyTaskButton();
  }

  async function discardRecoveredCopyJob(job) {
    if(!job?.recovered || job.status!=='queued' || job.recoveryMonitoring || copyCleanupPending)return;
    // Removing a saved queue record NEVER resumes native work. Submitted or
    // uncertain items must first be resolved explicitly, not silently dropped.
    if(job.record?.items?.some(item=>
      !['success','skipped','excluded'].includes(item.status) &&
      !(item.status==='queued' && item.submission==='not-submitted'))) {
      copyCleanupError='未移除保存任务：仍包含已提交或待核实项目';
      notify(copyCleanupError);
      updateCopyTaskButton();
      return;
    }
    copyCleanupPending=true;
    copyCleanupError='';
    updateCopyTaskButton();
    try {
      await initializeCopyPersistence();
      await ensureCopyOwnership();
      await copyPersistTail;
      const fresh=await persistentCopyStore.read();
      if(JSON.stringify(fresh?.tasks||[])!==lastPersistedTasks)
        throw new Error('队列内容已在其他标签页发生变化，请重新加载后核实');
      if(destroyed)return;
      const index=copyJobs.indexOf(job);
      if(index<0)return;
      copyJobs.splice(index,1);
      try {await persistCopyQueue();}
      catch(error) {
        // A failed checkpoint must leave the original record available.
        copyJobs.splice(index,0,job);
        throw error;
      }
      copyRecoveryLocked=copyJobs.some(x=>x.recovered&&
        ['queued','uncertain','running'].includes(x.status));
      // A completed-only (or empty) queue is not a paused writer.
      if(copyJobs.every(x=>x.status==='success'))copyQueuePaused=false;
      diagnosticLog('INFO','queue.recovered_record_removed',{
        taskId:job.taskId,remaining:copyJobs.length});
      closeCopyTaskCenter();
      showCopyTaskCenter(false);
    } catch(error) {
      // A denied lease is transient contention, not broken IndexedDB.
      // Do NOT call copyPersistenceFailure here: it permanently poisons retries.
      copyCleanupError='未移除保存任务记录：'+String(error?.message||error);
      diagnosticLog('WARN','queue.recovered_record_removal_failed',{
        taskId:job.taskId,message:String(error?.message||error)});
      notify(copyCleanupError);
    } finally {
      copyCleanupPending=false;
      if(!destroyed)updateCopyTaskButton();
      void releaseIdleCopyOwnership('recovered-record-removed');
    }
  }
  async function executeRecoveredCopyJob(job) {
    if(['native-move-files','native-move-mixed'].includes(job.record.batchMode)) {
      // A batch that never reached native submission may be manually resumed.
      // Resume such a record via the conservative per-item path, removing the
      // batch marker BEFORE any single-item intent is persisted; otherwise
      // a second F5 would incorrectly look for a CR-joined native signature.
      if(job.record.items.some(item=>
          item.submission!=='not-submitted' ||
          !['queued','success','skipped','excluded'].includes(item.status)))
        throw new Error('原生批量移动存在已提交或未核实项，禁止恢复执行');
      delete job.record.batchMode;
      job.record.updatedAt=Date.now();
      await persistCopyQueue();
      diagnosticLog('INFO','move.batch_resume_serial',{taskId:job.taskId,
        count:job.record.items.length});
    }
    for(let i=0;i<job.record.items.length;i++){
      const item=job.record.items[i];
      if(['success','skipped','excluded'].includes(item.status))continue;
      if(item.status!=='queued' || item.submission!=='not-submitted')
        throw new Error('恢复任务包含未核实的原生提交记录，禁止执行');
      const plan=planFileOperation({type:job.record.operation||'copy',source:item.source,
        folder:item.folder,destinationDir:job.destination,
        conflictPolicy:job.conflictPolicy});
      try {
        await copyItemCheckpoint(job,i,'checking','not-submitted');
        const result=await (job.record.operation==='delete'?deleteNativeEntry:
          job.record.operation==='move'?moveNativeEntry:copyNativeEntry)(plan,(_,phase,info)=>{
          copyJobSignal(job,phase,info);
        },{},async()=>copyItemCheckpoint(job,i,'submission-intent','intent-saved'));
        if(result.moveOutcome==='merged-partial')
          job.record.items[i].moveOutcome='merged-partial';
        await copyItemCheckpoint(job,i,result.copyOutcome==='skipped'?'skipped':'success',
          result.copyOutcome==='skipped'?'not-submitted':'confirmed');
      } catch(error) {
        const unsafe=item.submission!=='not-submitted';
        item.status=unsafe?'uncertain':'failed';
        if(unsafe)item.submission='unknown';
        await persistCopyQueue().catch(()=>{});
        job.phase=unsafe?'uncertain':'failed';
        throw error;
      }
    }
    job.phase='success';
  }
  async function confirmRecoveredCopyQueue() {
    if(!copyRecoveryLocked || destroyed || !copyJobs.some(j=>j.recovered&&j.status==='queued'))return;
    if(copyJobs.some(j=>j.recovered&&j.recoveryMonitoring)) {
      notify('当前原生文件操作仍在运行；等待其结束并核实后才能恢复队列');
      return;
    }
    if(copyJobs.some(j=>j.recovered&&j.status==='uncertain')) {
      notify('存在原生完成结果未知的任务，请先决定是否不再执行该项；不能安全地自动重试');
      return;
    }
    const queuedDelete=copyJobs.some(job=>job.recovered&&job.status==='queued'&&job.record.operation==='delete');
    if(!window.confirm(queuedDelete?
      '确认继续执行尚未提交的永久删除任务？\n\n文件和文件夹会永久删除、无法撤销。已提交或待核实的任务不会自动重发。':
      '确认恢复尚未执行的文件任务队列？\n\n移动会移除原位置文件；复制仍使用原有忽略/覆盖策略。'))return;
    try {
      await ensureCopyOwnership();
      if(await readNativeActive())
        throw new Error('Unraid 正在执行原生任务，请等待其完成后再恢复');
      await copyPersistTail;
      const fresh=await persistentCopyStore.read();
      if(!fresh || JSON.stringify(fresh.tasks)!==lastPersistedTasks)
        throw new Error('队列内容已在其他标签页发生变化，需重新加载后核实');
      copyQueuePaused=false;
      copyRecoveryLocked=false;
      await persistCopyQueue();
      updateCopyTaskButton();
      void runCopyQueue();
      closeCopyTaskCenter();
    } catch(error) {
      copyQueuePaused=true;
      copyRecoveryLocked=true;
      notify('未恢复队列：'+String(error?.message||error));
    }
  }
  function showRecoveredCopyDetails(job) {
    if($('.ufs-dialog-overlay',app))return;
    closeCopyTaskCenter();
    const overlay=element('div','ufs-dialog-overlay');
    const dialog=element('div','ufs-create-dialog ufs-copy-dialog');
    dialog.setAttribute('role','dialog');
    dialog.setAttribute('aria-label',job.record.operation==='delete'?'恢复永久删除任务详情':job.record.operation==='move'?'恢复移动任务详情':'恢复复制任务详情');
    const h=element('div','ufs-create-head');
    h.append(element('h3','',job.record.operation==='delete'?'已保存永久删除任务':job.record.operation==='move'?'已保存移动任务':'已保存复制任务'));
    const close=element('button','ufs-create-dismiss','×');
    close.type='button';close.addEventListener('click',()=>overlay.remove());
    h.append(close);
    const body=element('div','ufs-create-fields');
    body.append(element('div','ufs-batch-meta',job.record.operation==='delete'?'来源：'+job.destination:'目标：'+job.destination));
    if(job.record.operation!=='delete')
      body.append(element('div','ufs-batch-meta','同名处理：'+
        (job.conflictPolicy==='overwrite'?'覆盖':job.conflictPolicy==='skip'?'忽略':'拒绝冲突')));
    if(job.record.operation==='delete')
      body.append(element('div','ufs-delete-warning','永久删除不能撤销；请在 NAS 上核实结果。'));
    for(let i=0;i<job.record.items.length;i++){
      const item=job.record.items[i];
      const row=element('div','ufs-batch-preview-row');
      const label=job.recoveryMonitoring && (job.recoveryBatch||job.recoveryMonitorIndex===i)?(job.record.operation==='delete'?'原生删除中':job.record.operation==='move'?'原生移动中':'原生复制中'):
        item.status==='success'?(item.moveOutcome==='merged-partial'?
          '部分移动 · 源目录仍有文件':'已完成'):
        item.status==='skipped'?'已忽略':
        item.status==='excluded'?'已排除，不重复执行':
        ['submission-intent','copying','verifying','uncertain'].includes(item.status) ||
        ['intent-saved','unknown'].includes(item.submission)?'结果未确认':
        item.status==='queued'?'等待恢复':'需要检查';
      row.append(element('span','',item.name+' · '+label));
      if(['原生复制中','原生移动中','原生删除中'].includes(label)) row.append(element('span','ufs-batch-meta',
        copyJobMeta(job)+(Number.isFinite(job.percent)?' · '+Math.floor(job.percent)+'%':'')));
      if((label==='结果未确认'||label==='需要检查') && job.status!=='running') {
        const skip=element('button','ufs-task-center-remove','不再执行此项');
        skip.type='button';
        skip.addEventListener('click',async()=>{
          if(!window.confirm('Unraid 原生任务目前不在活动列表，但缺少上一次操作的完成回执。\n\n确认后此项将不会重新执行，并不代表已经证明文件完整。后续队列仍需单独手动恢复。确认不再执行此项？'))return;
          try {
            await ensureCopyOwnership();
            if(await readNativeActive()) throw new Error('Unraid 仍有原生任务运行，禁止清除此状态');
            await copyItemCheckpoint(job,i,'excluded','confirmed');
            job.status='queued';job.phase='queued';
            if(job.record.items.every(x=>['success','skipped','excluded'].includes(x.status))){
              job.status='success';job.phase='success';
            }
            job.record.status=job.status;
            await persistCopyQueue();
            copyRecoveryLocked=copyJobs.some(x=>x.recovered&&
              (x.status==='queued'||x.status==='uncertain'));
            if(!copyRecoveryLocked)copyQueuePaused=false;
            updateCopyTaskButton();
            overlay.remove();
            showRecoveredCopyDetails(job);
          }catch(error){notify('核实状态保存失败：'+String(error?.message||error));}
        });
        row.append(skip);
      }
      body.append(row);
    }
    const footer=element('div','ufs-create-buttons');
    const done=element('button','ufs-create-submit','关闭');
    done.type='button';done.addEventListener('click',()=>overlay.remove());
    footer.append(done);dialog.append(h,body,footer);
    overlay.append(dialog);app.append(overlay);
  }

  // The displayed rate is a native rsync observation, never an estimated total.
  const COPY_SPEED_TTL_MS=5000;
  let copySpeedRefreshTimer=null;
  function currentCopySpeed(job,now=Date.now()) {
    return job?.status==='running' && job.phase==='copying' &&
      typeof job.speed==='string' && job.speed &&
      Number.isFinite(job.speedUpdatedAt) &&
      now-job.speedUpdatedAt>=0 && now-job.speedUpdatedAt<=COPY_SPEED_TTL_MS
      ?job.speed:'';
  }
  function copyJobPhaseLabel(job) {
    if(job.phase==='checking') return '正在检查';
    if(job.phase==='verifying') return '正在核验';
    return job.record?.operation==='delete'?'删除中':job.record?.operation==='move'?'移动中':'复制中';
  }
  function copyJobStatusLabel(job) {
    return job.status==='running'?copyJobPhaseLabel(job)+
      (job.phase==='copying' && Number.isFinite(job.percent)?' '+Math.floor(job.percent)+'%':''):
      job.status==='queued'?'等待中':job.status==='success'?
        (job.record?.items?.some(item=>item.moveOutcome==='merged-partial')?
          '部分移动 · 源目录有剩余':'已完成'):
      job.status==='failed'?(job.preflightRejected?'预检未通过 · 未开始':'失败'):
      job.status==='uncertain'?'待核实':'已停止';
  }
  function copyJobMeta(job) {
    if(job.phase==='checking') return job.record?.operation==='delete'?'正在检查待删除项目':'正在验证源文件和目标目录';
    if(job.record?.operation==='delete')return '永久删除中 · 无可靠百分比';
    if(job.phase==='verifying') return job.record?.operation==='delete'?'正在核对删除结果':job.record?.operation==='move'?'正在核对移动结果':'正在核对复制结果';
    const speed=currentCopySpeed(job);
    return speed?'速度 '+speed+(job.recoveryMonitoring && job.eta?' · 剩余 '+job.eta:''):
      (job.speedUpdatedAt?'速度暂无数据':'速度获取中…');
  }
  function copySpinner(className='') {
    const spinner=element('span','ufs-task-live-spinner'+(className?' '+className:''));
    spinner.setAttribute('aria-hidden','true');
    return spinner;
  }
  function copyJobSignal(job,phase,info) {
    if(!job || job.status!=='running') return;
    if(phase==='checking' || phase==='verifying' || phase==='copying') {
      if(job.phase!==phase) {
        job.phase=phase;
        job.speed='';
        job.speedUpdatedAt=0;
      }
    }
    if(info?.speed && typeof info.speed==='string' &&
        /^[\d,.]+\s*[kKMGTPE]?(?:i?B)?\/s$/.test(info.speed)) {
      job.speed=info.speed.trim();
      job.speedUpdatedAt=Date.now();
    }
    updateCopyTaskButton();
  }
  function synchronizeCopySpeedTimer(active) {
    if(active && !copySpeedRefreshTimer) {
      copySpeedRefreshTimer=setInterval(()=>{
        if(destroyed || !copyJobs.some(job=>job.status==='running')) {
          clearInterval(copySpeedRefreshTimer);
          copySpeedRefreshTimer=null;
        } else updateCopyTaskButton();
      },1000);
    } else if(!active && copySpeedRefreshTimer) {
      clearInterval(copySpeedRefreshTimer);
      copySpeedRefreshTimer=null;
    }
  }
  async function registerCopyJob(job) {
    await initializeCopyPersistence();
    if(persistenceError || copyRecoveryLocked)
      throw new Error(persistenceError||'请先处理之前恢复的复制队列，再创建新任务');
    await ensureCopyOwnership();
    // A newly claimed lease does not grant permission to overwrite a
    // snapshot created by a different, now-gone browser instance.
    await copyPersistTail;
    const fresh=await persistentCopyStore.read();
    if(JSON.stringify(fresh?.tasks||[])!==lastPersistedTasks) {
      diagnosticLog('WARN','queue.snapshot_conflict',{operation:job.record?.operation||'copy'});
      throw new Error('队列记录已由其他页面实例更新，请刷新页面并核实任务，禁止覆盖旧记录');
    }
    const duplicate=findUnfinishedDuplicate(job.record);
    if(duplicate){
      diagnosticLog('WARN','queue.duplicate_blocked',{
        existingTaskId:duplicate.taskId,newTaskId:job.taskId});
      throw new Error('相同来源、目标与操作的任务仍在队列中，请先处理已有任务，避免重复执行');
    }
    job.id=++copyJobCounter;
    job.status='queued';
    job.phase='queued';
    copyJobs.push(job);
    diagnosticLog('INFO','queue.enqueued',{taskId:job.taskId,count:job.count});
    try { await persistCopyQueue(); }
    catch(error) {
      copyJobs.splice(copyJobs.indexOf(job),1);
      updateCopyTaskButton();
      throw error;
    }
    updateCopyTaskButton();
    void runCopyQueue();
  }
  function removeCopyJob(job) {
    // Preserve immediate UI dismissal, but durably commit it under a fresh
    // lease. On failure restore the completed record rather than lose history.
    if(job?.status==='success' && job.record) {
      const oldIndex=copyJobs.indexOf(job);
      if(oldIndex<0)return;
      copyOwnerReservations++;
      copyJobs.splice(oldIndex,1);
      updateCopyTaskButton();
      void (async()=>{
        await initializeCopyPersistence();
        await ensureCopyOwnership();
        await copyPersistTail;
        const fresh=await persistentCopyStore.read();
        if(JSON.stringify(fresh?.tasks||[])!==lastPersistedTasks)
          throw new Error('其他页面修改了任务记录，不能清除当前记录');
        await persistCopyQueue();
      })().catch(error=>{
        if(!copyJobs.includes(job))
          copyJobs.splice(Math.min(oldIndex,copyJobs.length),0,job);
        diagnosticLog('WARN','queue.completed_removal_failed',{reason:String(error?.message||error)});
        updateCopyTaskButton();
        notify('完成记录未成功保存，已恢复记录：'+String(error?.message||error));
      }).finally(()=>{
        copyOwnerReservations--;
        void releaseIdleCopyOwnership('completed-dialog-dismissed');
      });
      return;
    }
    if(job?.record && !copyOwnerHeld) {
      diagnosticLog('WARN','queue.record_removal_blocked',{reason:'not-owner',status:job.status});
      return; // Keep the durable record for explicit later verification.
    }
    const index=copyJobs.indexOf(job);
    if(index>=0 && job.status!=='running') copyJobs.splice(index,1);
    if(activeCopySession===job && job.status!=='running') activeCopySession=null;
    if(job.record && copyOwnerHeld) void persistCopyQueue().catch(()=>{});
    updateCopyTaskButton();
  }
  async function runCopyQueue() {
    if(copyQueueRunning || copyQueuePaused || copyRecoveryLocked ||
        destroyed || !copyOwnerHeld) return;
    copyQueueRunning=true;
    try {
      while(!destroyed && !copyQueuePaused) {
        const job=copyJobs.find(item=>item.status==='queued');
        if(!job) break;
        // Native writes share a lock with rename/mkdir. Do not start while
        // another File Station operation owns that lock.
        while(nativeWriteBusy && !destroyed) await waitNative(150);
        if(destroyed || copyQueuePaused || job.status!=='queued') continue;
        job.status='running';
        job.phase='checking';
        diagnosticLog('INFO','queue.started',{taskId:job.taskId,count:job.count});
        job.speed='';
        job.speedUpdatedAt=0;
        job.percent=null;
        activeCopySession=job;
        job.prepare?.();
        updateCopyTaskButton();
        try {
          if(job.record) {
            job.record.status='running';
            job.record.updatedAt=Date.now();
            await persistCopyQueue();
          }
          if(destroyed || copyQueuePaused || !copyOwnerHeld)
            throw new Error('任务持久化权限已失效，拒绝执行');
          await job.execute();
          if(job.status==='running') {
            const state=job.phase;
            job.status=state==='success'?'success':state==='stopped'?'stopped':
              state==='uncertain'||state==='cancelled'?'uncertain':'failed';
          }
        } catch(error) {
          // A POST-intent that has reached native Unraid must NEVER be collapsed
          // into an ordinary retryable failure by the outer scheduler.
          const ambiguous=job.phase==='uncertain' ||
            job.record?.items?.some(item=>item.status==='uncertain' ||
              ((item.submission==='intent-saved'||item.submission==='unknown') &&
                !['success','skipped','excluded'].includes(item.status)));
          job.status=ambiguous?'uncertain':'failed';
          job.phase=job.status;
          job.error=String(error?.message||error);
        } finally {
          diagnosticLog(job.status==='success'?'INFO':'WARN','queue.finished',{
            taskId:job.taskId,status:job.status,phase:job.phase,message:job.error||''});
          if(activeCopySession===job) activeCopySession=null;
          if((job.status==='failed' && !job.recoverable) ||
              job.status==='uncertain'||job.status==='stopped') copyQueuePaused=true;
          if(job.record) {
            job.record.status=job.status;
            job.record.updatedAt=Date.now();
            await persistCopyQueue().catch(()=>{});
          }
          updateCopyTaskButton();
        }
      }
    } finally {
      copyQueueRunning=false;
      updateCopyTaskButton();
      void releaseIdleCopyOwnership('queue-drained');
    }
  }
  function resumeCopyQueue() {
    if(copyRecoveryLocked || !copyQueuePaused ||
        !copyJobs.some(job=>job.status==='queued')) return;
    const pendingDeletion=copyJobs.some(job=>job.status==='queued'&&job.record?.operation==='delete');
    if(!window.confirm(pendingDeletion?
      '确认继续执行后续永久删除？\n\n删除不可撤销；不会重发已提交或待核实项目。':
      '确认已核实失败或不确定的原生文件任务？\n\n仅执行尚未提交的排队项目。')) return;
    // A reopened browser tab does not necessarily own its old queue lease.
    // Reacquire and verify the durable snapshot BEFORE scheduling any work.
    void (async()=>{
      try {
        await initializeCopyPersistence();
        await ensureCopyOwnership();
        await copyPersistTail;
        const fresh=await persistentCopyStore.read();
        if(!fresh || JSON.stringify(fresh.tasks)!==lastPersistedTasks)
          throw new Error('队列记录已更新，请刷新后核实');
        if(await readNativeActive())
          throw new Error('Unraid 仍有原生文件操作运行');
        copyQueuePaused=false;
        updateCopyTaskButton();
        void runCopyQueue();
      } catch(error) {
        copyQueuePaused=true;
        notify('队列未继续：'+String(error?.message||error));
        updateCopyTaskButton();
      }
    })();
  }
  function isRemovableFailedCopyJob(job) {
    return job?.status==='failed' && !!job.record && !job.recoveryMonitoring &&
      job.record.items.every(item=>
        (item.submission==='not-submitted' &&
          ['queued','checking','failed','skipped','excluded'].includes(item.status)) ||
        (item.submission==='confirmed' && ['success','skipped','excluded'].includes(item.status)));
  }
  async function clearCompletedCopyJobs(job) {
    if(copyCleanupPending) return;
    // The header eraser only clears successful records. Explicit per-row
    // deletion can also dismiss a failed task that has no uncertain native POST.
    const targets=copyJobs.filter(item=>(job ?
      item===job && (item.status==='success'||isRemovableFailedCopyJob(item)):
      item.status==='success'));
    if(!targets.length) return;
    copyCleanupPending=true;
    copyCleanupError='';
    updateCopyTaskButton();
    let previous=null;
    try {
      await initializeCopyPersistence();
      await ensureCopyOwnership();
      await copyPersistTail;
      const fresh=await persistentCopyStore.read();
      if(JSON.stringify(fresh?.tasks||[])!==lastPersistedTasks)
        throw new Error('队列内容已在其他标签页发生变化，请重新加载后核实');
      if(destroyed) return;
      previous=copyJobs.slice();
      for(let index=copyJobs.length-1;index>=0;index--)
        if(targets.includes(copyJobs[index])) copyJobs.splice(index,1);
      await persistCopyQueue();
      if(copyJobs.every(item=>item.status==='success') && !copyRecoveryLocked)
        copyQueuePaused=false;
      diagnosticLog('INFO','queue.terminal_records_cleared',{
        count:targets.length,remaining:copyJobs.length});
    } catch(error) {
      if(previous) {
        // Restore only removed records; other jobs may have progressed or been cancelled.
        const added=copyJobs.filter(item=>!previous.includes(item));
        const restored=previous.filter(item=>targets.includes(item)||copyJobs.includes(item));
        copyJobs.splice(0,copyJobs.length,...restored,...added);
      }
      copyCleanupError='未清理任务记录：'+String(error?.message||error);
      notify(copyCleanupError);
    } finally {
      copyCleanupPending=false;
      if(!destroyed) updateCopyTaskButton();
      void releaseIdleCopyOwnership('records-cleared');
    }
  }
  function closeCopyTaskCenter(restoreFocus=false) {
    const panel=$('.ufs-copy-task-center',app);
    panel?._ufsScrollCleanup?.();
    panel?.remove();
    const trigger=$('.ufs-copy-task-trigger',app);
    trigger?.setAttribute('aria-expanded','false');
    if(restoreFocus && !destroyed)
      (trigger && !trigger.hidden?trigger:$('.ufs-list',app))?.focus({preventScroll:true});
  }
  function showCopyTaskCenter(focus=true) {
    if($('.ufs-copy-task-center',app)) {closeCopyTaskCenter(true);return;}
    if(!copyJobs.length || $('.ufs-dialog-overlay',app) ||
        document.querySelector('.ufs-diagnostic-overlay')) return;
    const panel=element('div','ufs-copy-task-center');
    panel.setAttribute('role','dialog');
    panel.setAttribute('aria-label',copyJobs.some(j=>['move','delete'].includes(j.record?.operation))?'文件任务中心':'复制任务中心');
    const head=element('div','ufs-task-center-head');
    head.append(element('strong','',(copyJobs.some(j=>['move','delete'].includes(j.record?.operation))?'文件任务':'复制任务')+' · '+copyJobs.length+' 项'));
    const actions=element('div','ufs-task-center-actions');
    const clear=element('button','ufs-task-center-icon ufs-task-center-clear');
    clear.type='button';
    clear.dataset.taskFocus='clear';
    clear.setAttribute('aria-label','清理已完成任务记录');
    clear.append(icon('eraser'));
    clear.addEventListener('click',()=>void clearCompletedCopyJobs());
    const divider=element('span','ufs-task-center-divider');
    divider.setAttribute('aria-hidden','true');
    const dismiss=element('button','ufs-task-center-close ufs-task-center-icon');
    dismiss.type='button';
    dismiss.dataset.taskFocus='close';
    // The close control is self-explanatory. Do not open a tooltip when the
    // panel auto-focuses this button.
    dismiss.setAttribute('aria-label','关闭任务中心');
    dismiss.append(icon('close'));
    dismiss.addEventListener('click',()=>closeCopyTaskCenter(true));
    actions.append(clear,divider,dismiss);
    head.append(actions);
    panel.append(head);
    const body=element('div','ufs-task-center-body');
    for(const job of copyJobs) {
      const row=element('div','ufs-task-center-row');
      row.dataset.taskId=job.taskId||'';
      row.dataset.status=job.status;
      row.dataset.phase=job.phase||'';
      row.dataset.partial=String(!!job.record?.items?.some(item=>
        item.moveOutcome==='merged-partial'));
      const line=element('div','ufs-task-center-line');
      const main=element('button','ufs-task-center-open');
      main.type='button';
      main.dataset.taskFocus='open-'+job.id;
      const info=element('span','ufs-task-center-name',job.name);
      info.title=job.name+' · 任务 '+String(job.taskId||job.id).slice(-8);
      const statusWrap=element('span','ufs-task-center-state');
      if(job.status==='running') statusWrap.append(copySpinner());
      else statusWrap.append(icon(job.status==='queued'?'clock-3':
        job.status==='success'?'check-circle':'alert-circle'));
      statusWrap.append(element('span','ufs-task-center-status',
        job.status==='success'?'历史 · '+copyJobStatusLabel(job):copyJobStatusLabel(job)));
      main.append(info,statusWrap);
      main.addEventListener('click',()=>{closeCopyTaskCenter();job.reopen();});
      line.append(main);
      if(job.status==='success' || isRemovableFailedCopyJob(job)) {
        const remove=element('button','ufs-task-center-icon ufs-task-center-dismiss-record');
        remove.type='button';
        remove.dataset.taskFocus='remove-'+job.id;
        remove.dataset.tooltip=job.status==='failed'?
          '移除未提交的失败记录，不会执行文件操作':'移除记录，保留复制文件';
        remove.setAttribute('aria-label',(job.status==='failed'?'移除失败记录：':'移除记录：')+job.name);
        remove.append(icon('trash'));
        remove.addEventListener('click',()=>void clearCompletedCopyJobs(job));
        line.append(remove);
      } else {
        const slot=element('span','ufs-task-center-slot');
        slot.setAttribute('aria-hidden','true');
        line.append(slot);
      }
      row.append(line);
      if(job.status==='running') {
        const meta=element('div','ufs-task-center-meta',copyJobMeta(job));
        meta.classList.toggle('ufs-task-center-meta-muted',!currentCopySpeed(job));
        row.append(meta);
        if(job.phase==='copying' && Number.isFinite(job.percent)) {
          const track=element('div','ufs-task-center-progress');
          const fill=element('div','ufs-task-center-progress-fill');
          fill.style.width=Math.min(99.9,job.percent)+'%';
          track.append(fill);
          row.append(track);
        }
      }
      if(job.status==='queued') {
        const cancel=element('button','ufs-task-center-remove',
          job.recovered?'移除保存记录':'取消排队');
        cancel.type='button';
        cancel.dataset.taskFocus='cancel-'+job.id;
        cancel.addEventListener('click',()=>{
          if(job.recovered) {
            void discardRecoveredCopyJob(job);
            return;
          }
          job.cancelQueued();
          closeCopyTaskCenter();
          updateCopyTaskButton();
        });
        row.append(cancel);
      }
      body.append(row);
    }
    panel.append(body);
    if(copyRecoveryLocked) {
      const panel=element('div','ufs-task-center-paused ufs-task-recovery');
      const uncertain=copyJobs.filter(job=>job.recovered&&job.status==='uncertain').length;
      const waiting=copyJobs.filter(job=>job.recovered&&job.status==='queued').length;
      const monitoring=copyJobs.some(job=>job.recovered&&job.recoveryMonitoring);
      panel.append(element('div','',monitoring?
        '已重新连接 Unraid 正在执行的原生文件任务；尚未提交的队列保持暂停。':
        uncertain?'上次有 '+uncertain+' 项已提交的原生任务失去完成回执。可选择不再执行该项，再决定是否继续队列；不会自动重做。':
        '检测到上次保存的 '+waiting+' 项待恢复任务，当前队列已暂停。'));
      const later=element('button','','稍后处理');
      later.type='button';later.dataset.taskFocus='later';
      later.addEventListener('click',()=>closeCopyTaskCenter(true));
      panel.append(later);
      const confirm=element('button','',monitoring?'等待当前复制完成':
        uncertain?'请先处理上次任务':'确认恢复队列');
      confirm.type='button';confirm.disabled=monitoring || uncertain>0 || waiting===0;
      confirm.dataset.taskFocus='recover';
      confirm.addEventListener('click',()=>void confirmRecoveredCopyQueue());
      panel.append(confirm);
      panel.setAttribute('role','group');
      panel.setAttribute('aria-label','文件队列手动恢复');
      panel.dataset.pending=String(waiting);
      panel.dataset.uncertain=String(uncertain);
      panel.classList.add('ufs-task-recovery-actions');
      panel.setAttribute('aria-live','polite');
      panel.style.cssText='display:flex;flex-wrap:wrap;align-items:center;gap:8px';
      body.append(panel);
    } else if(copyQueuePaused && copyJobs.some(job=>job.status==='queued')) {
      const paused=element('div','ufs-task-center-paused');
      paused.append(element('div','','后续队列已暂停，请先核实失败或待核实任务。'));
      const resume=element('button','','确认已核实，继续排队任务');
      resume.type='button';
      resume.dataset.taskFocus='resume';
      resume.addEventListener('click',()=>{
        resumeCopyQueue();
        closeCopyTaskCenter();
      });
      paused.append(resume);
      panel.append(paused);
    }
    const error=element('div','ufs-task-center-cleanup-error');
    error.setAttribute('role','alert');
    panel.append(error);
    const tooltip=element('div','ufs-task-center-tooltip');
    tooltip.id='ufs-copy-task-tooltip';
    tooltip.setAttribute('role','tooltip');
    tooltip.hidden=true;
    panel.append(tooltip);
    const showTooltip=event=>{
      const control=event.target.closest('.ufs-task-center-icon[data-tooltip]');
      if(!control) return;
      control.setAttribute('aria-describedby',tooltip.id);
      tooltip.textContent=control.dataset.tooltip;
      const bounds=panel.getBoundingClientRect();
      const button=control.getBoundingClientRect();
      const right=Math.max(8,bounds.right-button.right);
      tooltip.style.right=right+'px';
      tooltip.style.maxWidth=(panel.clientWidth-right-8)+'px';
      tooltip.hidden=false;
      const above=button.top-bounds.top-tooltip.offsetHeight-5;
      tooltip.style.top=Math.max(4,Math.min(panel.clientHeight-tooltip.offsetHeight-4,
        above>=4?above:button.bottom-bounds.top+5))+'px';
    };
    const hideTooltip=event=>{
      if(event.target.closest('.ufs-task-center-icon')?.contains(event.relatedTarget)) return;
      tooltip.hidden=true;
    };
    panel.addEventListener('mouseover',showTooltip);
    panel.addEventListener('focusin',showTooltip);
    panel.addEventListener('mouseout',hideTooltip);
    panel.addEventListener('focusout',hideTooltip);
    body.addEventListener('scroll',()=>{tooltip.hidden=true;},{passive:true});
    panel._ufsScrollCleanup=setupListScrollbars(body);
    app.append(panel);
    $('.ufs-copy-task-trigger',app)?.setAttribute('aria-expanded','true');
    updateCopyTaskButton();
    if(focus) dismiss.focus({preventScroll:true});
  }
  function updateCopyTaskButton() {
    updateNativeModeProtection();
    const button=app && $('.ufs-copy-task-trigger',app);
    if(!button) return;
    // Keep records visible until their deletion has been durably saved.
    if(copyCleanupPending && !copyJobs.length) return;
    button.hidden=copyJobs.length===0;
    const active=copyJobs.find(job=>job.status==='running');
    synchronizeCopySpeedTimer(active);
    if(!copyJobs.length) {
      button.replaceChildren();
      delete button.dataset.renderKey;
      button.removeAttribute('data-phase');
      closeCopyTaskCenter(Boolean($('.ufs-copy-task-center',app)?.contains(document.activeElement)));
      return;
    }
    const queued=copyJobs.filter(job=>job.status==='queued').length;
    const problems=copyJobs.some(job=>['failed','uncertain','stopped'].includes(job.status));
    const complete=copyJobs.every(job=>job.status==='success');
    const partialMove=copyJobs.some(job=>
      job.record?.items?.some(item=>item.moveOutcome==='merged-partial'));
    const phase=copyRecoveryLocked?'recovery':copyQueuePaused?'paused':active?'running':
      queued?'queued':complete?(partialMove?'partial':'success'):problems?'failed':'queued';
    const waitingRestore=copyJobs.filter(job=>job.recovered&&job.status==='queued').length;
    const needsCheck=copyJobs.filter(job=>job.recovered&&job.status==='uncertain').length;
    const text=copyRecoveryLocked?
      (active?.recoveryMonitoring?'原生文件操作中 · 队列暂停':
        needsCheck?'有 '+needsCheck+' 项原生任务待处理':'有 '+waitingRestore+' 项任务待恢复'):
      copyQueuePaused&&queued?'文件任务已暂停':
      active?copyJobPhaseLabel(active):
      queued?'等待中':complete?(partialMove?'部分移动 · 源目录有剩余':
        (copyJobs.some(job=>job.record?.operation==='delete')?'文件任务完成 ':
          copyJobs.some(job=>job.record?.operation==='move')?'移动完成 ':'复制完成 ')+
          copyJobs.length+' 项'):
      problems?(copyJobs.some(job=>job.status==='uncertain'||job.status==='stopped'||
        (job.status==='failed'&&!job.preflightRejected))?'文件任务待核实':
        '预检未通过'):(copyJobs.some(job=>['move','delete'].includes(job.record?.operation))?'文件任务 ':'复制任务 ')+copyJobs.length+' 项';
    const signature=phase+'|'+Boolean(queued)+'|'+Boolean(active)+'|'+Boolean(needsCheck);
    // Keep the spinner node alive between rsync events and one-second TTL checks.
    if(button.dataset.renderKey!==signature) {
      button.replaceChildren();
      button.append(active?copySpinner('ufs-task-badge-spinner'):
        icon(copyRecoveryLocked&&needsCheck?'alert-circle':
          copyRecoveryLocked?'clock-3':
          copyQueuePaused&&queued?'alert-circle':queued?'clock-3':
          complete?(partialMove?'alert-circle':'check-circle'):problems?'alert-circle':'copy'));
      button.append(element('span','ufs-task-badge-main'));
      if(active) {
        button.append(element('span','ufs-task-badge-percent'));
        button.append(element('span','ufs-task-badge-speed'));
      }
      if(queued) {
        const sep=element('span','ufs-task-badge-divider');
        sep.setAttribute('aria-hidden','true');
        const wait=element('span','ufs-task-badge-wait');
        wait.append(icon('clock-3'),element('span','',String(queued)));
        button.append(sep,wait);
      }
      button.append(icon('chevron-up','ufs-task-badge-chevron'));
      button.dataset.renderKey=signature;
    }
    const main=button.querySelector('.ufs-task-badge-main');
    if(main) main.textContent=text;
    if(active) {
      const percent=button.querySelector('.ufs-task-badge-percent');
      const speed=button.querySelector('.ufs-task-badge-speed');
      if(percent) {
        percent.textContent=active.phase==='copying' && Number.isFinite(active.percent)?
          ' '+Math.floor(active.percent)+'%':'';
        percent.hidden=!percent.textContent;
      }
      const liveRate=currentCopySpeed(active);
      if(speed) {
        speed.textContent=liveRate?' · '+liveRate:'';
        speed.hidden=!liveRate;
      }
    }
    const count=button.querySelector('.ufs-task-badge-wait span');
    if(count) count.textContent=String(queued);
    button.dataset.phase=phase;
    button.title=(copyRecoveryLocked?'文件队列待手动恢复：':'文件任务：')+
      (active?'1 项运行中'+
      (currentCopySpeed(active)?'，速度 '+currentCopySpeed(active):'')+'，':'')+
      queued+' 项等待，'+copyJobs.length+' 项总计；点击查看';
    button.setAttribute('aria-label',button.title);
    const open=$('.ufs-copy-task-center',app);
    if(open) {
      const focusedControl=document.activeElement;
      const completed=copyJobs.filter(job=>job.status==='success').length;
      const clear=open.querySelector('.ufs-task-center-clear');
      clear.disabled=copyCleanupPending || completed===0;
      clear.dataset.tooltip=copyCleanupPending?'正在保存清理结果':completed?
        '清理 '+completed+' 项已完成记录，保留文件':'没有可清理的已完成记录';
      clear.setAttribute('aria-label','清理已完成任务记录：'+clear.dataset.tooltip);
      for(const control of open.querySelectorAll('.ufs-task-center-dismiss-record,.ufs-task-center-row[data-status=success] .ufs-task-center-open,.ufs-task-center-row[data-status=queued] .ufs-task-center-remove'))
        control.disabled=copyCleanupPending;
      if(open.contains(focusedControl) && focusedControl.disabled)
        open.querySelector('.ufs-task-center-close').focus({preventScroll:true});
      const error=open.querySelector('.ufs-task-center-cleanup-error');
      error.hidden=!copyCleanupError;
      error.textContent=copyCleanupError;
      const nodes=Array.from(open.querySelectorAll('.ufs-task-center-row'));
      const changed=nodes.length!==copyJobs.length || nodes.some((node,index)=>
        node.dataset.status!==copyJobs[index].status);
      if(changed && copyCleanupPending) return;
      if(changed) {
        const scroll=open.querySelector('.ufs-task-center-body')?.scrollTop||0;
        const focused=open.contains(document.activeElement)?document.activeElement.dataset.taskFocus:null;
        closeCopyTaskCenter();
        showCopyTaskCenter(false);
        const body=$('.ufs-task-center-body',app);
        if(body) body.scrollTop=scroll;
        if(focused) {
          const control=$('[data-task-focus="'+focused+'"]',app);
          (control && !control.disabled?control:$('.ufs-task-center-close',app))?.focus({preventScroll:true});
        }
        return;
      }
      const row=open.querySelector('.ufs-task-center-row[data-status=running]');
      if(row && active) {
        row.dataset.phase=active.phase||'';
        const label=row.querySelector('.ufs-task-center-status');
        if(label) label.textContent=copyJobStatusLabel(active);
        const meta=row.querySelector('.ufs-task-center-meta');
        if(meta) {
          meta.textContent=copyJobMeta(active);
          meta.classList.toggle('ufs-task-center-meta-muted',!currentCopySpeed(active));
        }
        let track=row.querySelector('.ufs-task-center-progress');
        if(active.phase==='copying' && Number.isFinite(active.percent)) {
          if(!track) {
            track=element('div','ufs-task-center-progress');
            track.append(element('div','ufs-task-center-progress-fill'));
            row.append(track);
          }
          track.querySelector('.ufs-task-center-progress-fill').style.width=
            Math.min(99.9,active.percent)+'%';
        } else track?.remove();
      }
    }
  }
  let nativeElements = [];
  let fileManagerMode = 'file-station';
  let nativeControls = null;
  let nativeReadonlyNote = null;
  let nativeRefreshNote = null;
  let nativeRefreshRetry = null;
  let nativeListRevision = 0;
  let nativeListRefreshed = 0;
  let nativeRefreshInFlight = null;
  let nativeRefreshController = null;
  function markNativeListDirty() {
    nativeListRevision++;
    if(fileManagerMode==='native') void refreshNativeListIfNeeded();
  }
  // Unraid's loadList() leaves its orange spinner visible on failed AJAX.
  // Reuse the existing table without requesting it on every mode switch.
  async function refreshNativeListIfNeeded() {
    if(fileManagerMode!=='native' || destroyed ||
        nativeListRevision===nativeListRefreshed) return;
    if(nativeRefreshInFlight) return nativeRefreshInFlight;
    const revision=nativeListRevision;
    const work=(async()=>{
      const table=document.querySelector('table.indexer');
      const nativeDir=window.dir;
      if(!table || !table.querySelector('thead') ||
          typeof nativeDir!=='string' ||
          !/^\/(?:mnt|boot)(?:\/|$)/.test(nativeDir)) {
        if(nativeRefreshNote) {
          nativeRefreshNote.textContent='原生列表尚未就绪，请稍后重试';
          nativeRefreshNote.hidden=false;
        }
        if(nativeRefreshRetry) nativeRefreshRetry.hidden=false;
        return;
      }
      const controller=new AbortController();
      nativeRefreshController=controller;
      const timeout=setTimeout(()=>controller.abort(),10000);
      const startedRefresh=Date.now();
      try {
        const url=new URL('/webGui/include/Browse.php',location.origin);
        url.searchParams.set('dir',encodeURIComponent(nativeDir));
        url.searchParams.set('path',location.pathname.replace(/^\/+/, ''));
        const response=await fetch(url,{credentials:'same-origin',
          cache:'no-store',signal:controller.signal});
        if(!response.ok) throw new Error('HTTP '+response.status);
        const html=await response.text();
        const fragment=new DOMParser().parseFromString(
          '<table>'+html+'</table>','text/html');
        const rows=Array.from(fragment.querySelectorAll('tbody,tfoot'));
        if(!rows.some(node=>node.tagName==='TBODY'))
          throw new Error('目录返回格式异常');
        // Update the native tbody/tfoot without running its fragile loadList().
        table.querySelectorAll('tbody,tfoot').forEach(node=>node.remove());
        rows.forEach(node=>table.append(document.importNode(node,true)));
        if(typeof window.jQuery==='function') {
          try {window.jQuery(table).trigger('update',[true]);}
          catch (_) { /* Native sort plugin may be unavailable. */ }
        }
        nativeListRefreshed=revision;
        diagnosticLog('DEBUG','native.directory_refreshed',{elapsed:Date.now()-startedRefresh});
        if(nativeRefreshNote) nativeRefreshNote.hidden=true;
        if(nativeRefreshRetry) nativeRefreshRetry.hidden=true;
      } catch(error) {
        diagnosticLog('WARN','native.directory_refresh_failed',{elapsed:Date.now()-startedRefresh,message:error?.message});
        if(nativeRefreshNote) {
          nativeRefreshNote.textContent='原生目录更新失败（'+
            (error?.name==='AbortError'?'请求超时':String(error?.message||error))+
            '），原列表已保留';
          nativeRefreshNote.hidden=false;
        }
        if(nativeRefreshRetry) nativeRefreshRetry.hidden=false;
      } finally {
        clearTimeout(timeout);
        if(nativeRefreshController===controller) nativeRefreshController=null;
      }
    })();
    nativeRefreshInFlight=work;
    try {await work;}
    finally {
      nativeRefreshInFlight=null;
      if(fileManagerMode==='native' && !destroyed &&
          nativeListRevision!==revision && nativeListRefreshed===revision)
        void refreshNativeListIfNeeded();
    }
  }
  function nativeQueueIsProtected() {
    // Do not expose Unraid's shared write slot to another UI while pending jobs
    // exist or an earlier native write still requires verification.
    return nativeWriteBusy || copyJobs.some(job=>
      ['queued','running','uncertain','stopped'].includes(job.status));
  }
  function updateNativeModeProtection() {
    const protectedQueue=nativeQueueIsProtected();
    if (nativeReadonlyNote) nativeReadonlyNote.hidden=!protectedQueue;
    if (nativeControls) nativeControls.dataset.readonly=protectedQueue?'true':'false';
  }
  function guardNativeInteraction(event) {
    if (fileManagerMode!=='native' || !nativeQueueIsProtected()) return;
    if (event.type==='keydown' &&
        !['Enter',' ','Spacebar'].includes(event.key)) return;
    const target=event.target;
    if (!(target instanceof Element)) return;
    const inNative=nativeElements.some(node=>node===target || node.contains(target));
    // Browse.page may append operation dialogs/menus outside the native table.
    const inNativePopup=Boolean(target.closest(
      '.ui-dfm,#dfm_dialogWindow,.context-menu-list,.context-menu,.dfm_control'));
    if (!inNative && !inNativePopup) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type==='click' || event.type==='contextmenu') {
      if (nativeReadonlyNote) nativeReadonlyNote.textContent=
        '文件任务未结束：原生文件操作暂为只读，请先返回 File Station 处理任务。';
    }
  }
  function switchFileManager(mode) {
    if (!app || destroyed || (mode!=='native' && mode!=='file-station')) return;
    if (isDemo && mode==='native') {
      notify('演示模式没有原生文件管理器');return;
    }
    const previousMode=fileManagerMode;
    fileManagerMode=mode;
    diagnosticLog('INFO','ui.mode_switch',{from:previousMode,to:mode});
    const native=mode==='native';
    if (!isDemo) {
      if(native) localStorage.setItem(STORE+'native','1');
      else localStorage.removeItem(STORE+'native');
    }
    closeMenu();
    app.hidden=native;
    nativeElements.forEach(node=>node.classList.toggle('ufs-hide-native',!native));
    if(nativeControls) nativeControls.hidden=!native;
    document.documentElement.classList.toggle('ufs-active-page',!native && !isDemo);
    updateNativeModeProtection();
    if(native) {
      // The preserved table is already rendered. Request only if stale.
      void refreshNativeListIfNeeded();
    } else {
      requestAnimationFrame(()=>{
        if(destroyed || fileManagerMode!=='file-station') return;
        window.dispatchEvent(new Event('resize'));
        scheduleLocationDisplay();
      });
    }
  }
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
    // Registered pagehide cleanup runs before the diagnostic listener; record before abort.
    diagnosticLog('INFO','page.hide',{snapshot:diagnosticSnapshot()});
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
  onCleanup(()=>{
    stopCopyLeaseTimer();
    // Best-effort only: pagehide must not be relied upon to release an
    // asynchronously persisted lease while the browser is unloading.
    // Unloading an active task must never release the writer lease early.
    // This callback cannot assume IndexedDB completes before page teardown.
    if(copyOwnerHeld && persistentCopyStore && !copyQueueNeedsOwnership())
      void copyPersistTail.then(()=>persistentCopyStore.release(copyOwnerId)).catch(()=>{});
  });
  // Until v0.2.7 persists the queue, a true reload may discard browser jobs.
  window.addEventListener('beforeunload', event=>{
    if(!copyJobs.some(job=>['running','uncertain'].includes(job.status))) return;
    event.preventDefault();
    event.returnValue='';
  }, {signal:lifecycle.signal});
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
    switchFileManager('native');
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
      diagnosticLog('WARN','directory.refresh_failed',{path,message:error?.message});
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
      row.dataset.ufsDropPath=path;
      if (path !== PREFIX) row.addEventListener('click', (event) => {
        if (event.target.closest('.ufs-tree-toggle')) return;
        navigate(path);
      });
      if(dragMoveSession?.active && dragMoveSession.target===path)
        row.classList.add(canDropMoveAt(path,dragMoveSession)?'ufs-drop-valid':'ufs-drop-invalid');
      wrapper.append(row);
      target.append(wrapper);
      if (state.expanded.has(path)) {
        (state.tree.get(path) || []).forEach((entry) => appendNode(entry.path, level + 1));
      }
    }
    appendNode(PREFIX, 0);
  }
  function breadcrumbDisplayPaths(paths, availableWidth = Infinity, measureWidth = () => 0) {
    // Path depth alone never causes folding: show everything when it actually fits.
    if (paths.length <= 2 || measureWidth(paths) <= availableWidth) {
      return { visible: paths, hidden: [] };
    }
    // Fold the oldest middle directories first, keeping the current directory
    // and as many nearest ancestors as the measured container can accommodate.
    for (let count = 1; count <= paths.length - 2; count++) {
      const visible = [paths[0], null, ...paths.slice(count + 1)];
      if (measureWidth(visible) <= availableWidth || count === paths.length - 2) {
        return { visible, hidden: paths.slice(1, count + 1) };
      }
    }
    return { visible: paths, hidden: [] };
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
    menu.dataset.ufsBreadcrumbMenu = 'true';
    hiddenPaths.forEach((path) => {
      const item = element('button', '', path.split('/').pop());
      item.type = 'button';
      item.title = path;
      item.dataset.ufsDropPath = path;
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
  function fillBreadcrumb(container, visible, hidden, interactive) {
    container.replaceChildren();
    visible.forEach((path, index) => {
      if (index) container.append(icon('chevron-right', 'ufs-muted'));
      if (path === null) {
        const ellipsis = element('button', 'ufs-crumb ufs-crumb-more', '…');
        ellipsis.type = 'button';
        if (interactive) {
          ellipsis._ufsHiddenPaths = [...hidden];
          ellipsis.title = hidden.map((hiddenPath) => hiddenPath.split('/').pop()).join(' / ');
          ellipsis.setAttribute('aria-label', '选择中间目录');
          ellipsis.setAttribute('aria-haspopup', 'menu');
          ellipsis.setAttribute('aria-expanded', 'false');
          ellipsis.addEventListener('click', (event) => {
            event.stopPropagation();
            showBreadcrumbMenu(ellipsis, hidden);
          });
        }
        container.append(ellipsis);
      } else {
        const crumb = element(path === PREFIX ? 'span' : 'button', 'ufs-crumb');
        crumb.append(element('span', 'ufs-crumb-label',
          path === PREFIX ? '共享文件夹' : path.split('/').pop()));
        crumb.title = path;
        if (interactive) crumb.dataset.ufsDropPath = path;
        if (path !== PREFIX) {
          crumb.type = 'button';
          if (interactive) crumb.addEventListener('click', () => navigate(path));
        }
        container.append(crumb);
      }
    });
  }
  function renderBreadcrumbs() {
    if (!app || !app.isConnected) return;
    const address = $('.ufs-address', app);
    if (!address) return;
    const parts = currentPath().split('/').filter(Boolean);
    const paths = [PREFIX];
    for (let i = 3; i <= parts.length; i++) paths.push('/' + parts.slice(0, i).join('/'));
    const uniquePaths = [...new Set(paths)];
    const width = address.getBoundingClientRect().width;
    let display = { visible: uniquePaths, hidden: [] };
    if (width > 0 && uniquePaths.length > 2) {
      // Measure real rendered buttons, separators, Chinese glyphs, gaps and
      // padding in a natural-width hidden copy of the existing address bar.
      const probe = address.cloneNode(false);
      probe.classList.add('ufs-address-measure');
      probe.removeAttribute('aria-label');
      probe.setAttribute('aria-hidden', 'true');
      probe.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;pointer-events:none;width:max-content;max-width:none;flex:0 0 auto;overflow:visible;';
      address.parentElement.append(probe);
      try {
        const measureWidth = (visible) => {
          fillBreadcrumb(probe, visible, [], false);
          return probe.getBoundingClientRect().width;
        };
        display = breadcrumbDisplayPaths(uniquePaths, width - 1, measureWidth);
      } finally {
        probe.remove();
      }
    }
    if (currentMenu?._ufsTrigger?.classList.contains('ufs-crumb-more')) closeMenu();
    fillBreadcrumb(address, display.visible, display.hidden, true);
    // Preserve the drop indicator across an address-bar reflow while dragging.
    if (dragMoveSession?.active) {
      dragMoveHover(dragMoveSession.target);
      if (dragMoveSession.moreTrigger?.isConnected)
        dragMoveSession.moreTrigger.classList.add('ufs-drop-expand');
    }
    // The last directory can ellipsize only after all middle directories
    // have been folded. Preserve full names in title attributes.
    address.scrollLeft = address.scrollWidth;
  }
  let breadcrumbLayoutPending = false;
  function scheduleBreadcrumbLayout() {
    if (breadcrumbLayoutPending || destroyed || !app) return;
    breadcrumbLayoutPending = true;
    requestAnimationFrame(() => {
      breadcrumbLayoutPending = false;
      if (!destroyed && app?.isConnected) renderBreadcrumbs();
    });
  }
  function renderNavigation() {
    renderBreadcrumbs();
    const tab = activeTab();
    $('.ufs-back', app).disabled = !tab || state.initializing || tab.cursor <= 0;
    $('.ufs-next', app).disabled = !tab || state.initializing || tab.cursor >= tab.history.length - 1;
    $('.ufs-up', app).disabled = !tab || state.initializing || currentPath() === PREFIX || isShareRoot(currentPath());
    const refreshButton = $('.ufs-refresh', app);
    refreshButton.disabled = state.busy || state.initializing;
    refreshButton.classList.toggle('ufs-spinning', state.busy && !state.initializing);
    refreshButton.setAttribute('aria-busy', String(state.busy && !state.initializing));
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

  // v0.2.11: one transient pointer session; native writes always begin in the
  // existing "移动到" modal after explicit confirmation, never on pointerup.
  let dragMoveSession=null;
  let suppressDragMoveClick=false;
  let dragMoveClickTimer=null;
  let pendingDragMoveDialogTimer=null;
  function canDropMoveAt(destination,session) {
    if(!session || !Array.isArray(session.items) || !session.items.length ||
       !safeWritePath(destination,true) || !state.tree.has(PREFIX) ||
       destination===session.sourceDir || destroyed || !MOVE_ENABLED)return false;
    return session.items.every(item=>
      item.copyPathVerified!==false && safeWritePath(item.path) &&
      parentPath(item.path)===session.sourceDir &&
      copyDestinationAllowed({source:item.path,folder:item.folder},destination) &&
      safeWritePath(destination+'/'+item.name));
  }
  function dragMoveHover(path) {
    for(const node of $$('[data-ufs-drop-path]',app))
      node.classList.remove('ufs-drop-valid','ufs-drop-invalid');
    const session=dragMoveSession;
    if(!session?.active || !path)return;
    const valid=canDropMoveAt(path,session);
    for(const node of $$('[data-ufs-drop-path]',app))
      if(node.dataset.ufsDropPath===path)
        node.classList.add(valid?'ufs-drop-valid':'ufs-drop-invalid');
  }
  function dragMoveReset() {
    const session=dragMoveSession;
    if(!session)return;
    clearTimeout(session.expandTimer);
    dragMoveSession=null;
    session.ghost?.remove();
    app?.classList.remove('ufs-drag-active');
    for(const node of $$('[data-ufs-drop-path],.ufs-drag-source,.ufs-drop-expand',app))
      node.classList.remove('ufs-drop-valid','ufs-drop-invalid','ufs-drag-source','ufs-drop-expand');
    if (currentMenu?._ufsTrigger?.classList.contains('ufs-crumb-more')) closeMenu();
    try { if(app.hasPointerCapture(session.pointerId))app.releasePointerCapture(session.pointerId); }
    catch (_) { /* Pointer may already have been released by the browser. */ }
  }
  function dragMoveHitAt(clientX,clientY) {
    const hit=document.elementFromPoint(clientX,clientY);
    if(!hit || !app.contains(hit))return null;
    return hit.closest('.ufs-tree-row[data-ufs-drop-path],.ufs-entry[data-ufs-drop-path],.ufs-address .ufs-crumb[data-ufs-drop-path],.ufs-address .ufs-crumb-more,.ufs-menu[data-ufs-breadcrumb-menu] button[data-ufs-drop-path]');
  }
  function dragMoveTargetAt(clientX,clientY) {
    return dragMoveHitAt(clientX,clientY)?.dataset.ufsDropPath||null;
  }
  function dragMoveBeginPointer(event) {
    if(event.button!==0 || (event.pointerType!=='mouse' && event.pointerType!=='pen') ||
       event.shiftKey || event.metaKey || event.ctrlKey || event.altKey ||
       dragMoveSession || destroyed || !MOVE_ENABLED || state.busy ||
       state.initializing || $('.ufs-dialog-overlay',app) || !activeTab())return;
    const row=event.target.closest('.ufs-entry[data-ufs-file]');
    if(!row || !$('.ufs-list',app)?.contains(row))return;
    const entry=state.entries.find(item=>item.path===row.dataset.ufsFile);
    if(!entry)return;
    const selected=state.selection.has(entry.path)?selectedEntries():[entry];
    const items=selected.filter(Boolean).map(item=>({...item}));
    if(!items.length || items.some(item=>!safeWritePath(item.path) || item.copyPathVerified===false))
      return; // Invalid source is not a drag handle; normal click still works.
    const sourceDir=currentPath();
    dragMoveSession={
      pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,
      sourceDir,items,sourcePath:entry.path,active:false,target:null,moreTrigger:null,
      expandTimer:null,ghost:null
    };
    // Do not capture at pointerdown: that would redirect ordinary click/dblclick
    // away from the row and break selection and folder navigation.
  }
  function dragMovePointer(event) {
    const session=dragMoveSession;
    if(!session || session.pointerId!==event.pointerId)return;
    if(destroyed || !app.isConnected || currentPath()!==session.sourceDir || state.busy) {
      dragMoveReset();return;
    }
    if(!session.active && Math.hypot(event.clientX-session.startX,event.clientY-session.startY)<7)
      return;
    if(!session.active) {
      session.active=true;
      try {app.setPointerCapture(event.pointerId);}
      catch (_) {dragMoveReset();return;}
      app.classList.add('ufs-drag-active');
      // Preserve multi-selection and the original DOM row during the entire drag.
      // For an unselected row, update only CSS selection classes (no renderFiles()).
      if(!state.selection.has(session.sourcePath)) {
        state.selection.clear();state.selection.add(session.sourcePath);
        renderSelection();
      }
      const ghost=element('div','ufs-drag-ghost');
      ghost.append(icon('copy'),element('span','','移动 '+session.items.length+' 项'));
      app.append(ghost);
      session.ghost=ghost;
      diagnosticLog('INFO','drag.move_started',{count:session.items.length});
    }
    event.preventDefault();
    const bounds=app.getBoundingClientRect();
    session.ghost.style.left=Math.max(4,Math.min(bounds.width-145,event.clientX-bounds.left+12))+'px';
    session.ghost.style.top=Math.max(4,Math.min(bounds.height-42,event.clientY-bounds.top+12))+'px';
    const hit=dragMoveHitAt(event.clientX,event.clientY);
    const target=hit?.dataset.ufsDropPath||null;
    const moreTrigger=hit?.classList.contains('ufs-crumb-more') ? hit : null;
    if(target!==session.target || moreTrigger!==session.moreTrigger) {
      clearTimeout(session.expandTimer);
      if(session.moreTrigger) session.moreTrigger.classList.remove('ufs-drop-expand');
      session.target=target;
      session.moreTrigger=moreTrigger;
      dragMoveHover(target);
      if(moreTrigger && moreTrigger._ufsHiddenPaths?.length) {
        moreTrigger.classList.add('ufs-drop-expand');
        // "…" is a menu trigger, never a drop destination by itself.
        session.expandTimer=setTimeout(()=>{
          if(dragMoveSession!==session || !session.active ||
             session.moreTrigger!==moreTrigger || !moreTrigger.isConnected)return;
          if(currentMenu?._ufsTrigger!==moreTrigger) {
            showBreadcrumbMenu(moreTrigger,moreTrigger._ufsHiddenPaths);
            diagnosticLog('INFO','drag.breadcrumb_menu_expanded',
              {hiddenCount:moreTrigger._ufsHiddenPaths.length});
          }
        },600);
      } else if(target && hit?.classList.contains('ufs-tree-row') &&
         canDropMoveAt(target,session) && !state.expanded.has(target)){
        session.expandTimer=setTimeout(()=>{
          if(dragMoveSession!==session || !session.active || session.target!==target)return;
          state.expanded.add(target);
          renderTree();
          void loadTree(target); // Lazy-load children; keep session across DOM replacement.
        },700);
      }
    }
    const sidebar=$('.ufs-sidebar',app);
    if(sidebar?.contains(document.elementFromPoint(event.clientX,event.clientY))) {
      const r=sidebar.getBoundingClientRect();
      if(event.clientY<r.top+28)sidebar.scrollTop-=10;
      else if(event.clientY>r.bottom-28)sidebar.scrollTop+=10;
    }
  }
  function dragMovePointerUp(event) {
    const session=dragMoveSession;
    if(!session || session.pointerId!==event.pointerId)return;
    const active=session.active;
    const destination=dragMoveTargetAt(event.clientX,event.clientY);
    const sourceDir=session.sourceDir,items=session.items;
    const dropSurface=dragMoveHitAt(event.clientX,event.clientY);
    const valid=active && destination && canDropMoveAt(destination,session);
    const dropKind=dropSurface?.closest('.ufs-menu[data-ufs-breadcrumb-menu]')?'breadcrumb-menu':
      dropSurface?.closest('.ufs-address')?'breadcrumb':
      dropSurface?.closest('.ufs-tree-row')?'tree':'list';
    dragMoveReset();
    if(!active)return; // Existing click/Ctrl/Shift selection behavior is preserved.
    // Pointer capture may synthesize a click after pointerup. Suppress that
    // single click so it cannot navigate or collapse the multi-selection.
    suppressDragMoveClick=true;
    clearTimeout(dragMoveClickTimer);
    // A synthesized click may follow pointerup; keep the guard briefly.
    dragMoveClickTimer=setTimeout(()=>{suppressDragMoveClick=false;dragMoveClickTimer=null;},250);
    if(currentPath()!==sourceDir)return;
    if(valid) {
      diagnosticLog('INFO','drag.move_target',{target:destination,count:items.length,surface:dropKind});
      // Do not attach a modal backdrop before the pointerup-generated click.
      clearTimeout(pendingDragMoveDialogTimer);
      pendingDragMoveDialogTimer=setTimeout(()=>{
        pendingDragMoveDialogTimer=null;
        if(destroyed || !app.isConnected || currentPath()!==sourceDir || state.busy)return;
        showCopyDialog(items,'move',{initialDestination:destination});
      },0);
    } else if(destination) {
      notify('不能移动到此文件夹：源位置、文件夹自身或内部目录不可作为目标');
    }
  }
  function installDragMove() {
    app.addEventListener('pointerdown',dragMoveBeginPointer);
    window.addEventListener('pointermove',dragMovePointer,{signal:lifecycle.signal});
    window.addEventListener('pointerup',dragMovePointerUp,{signal:lifecycle.signal});
    window.addEventListener('pointercancel',dragMoveReset,{signal:lifecycle.signal});
    app.addEventListener('lostpointercapture',()=>{
      if(dragMoveSession?.active)dragMoveReset();
      else dragMoveSession=null;
    });
    app.addEventListener('click',event=>{
      if(!suppressDragMoveClick || event.target.closest('.ufs-dialog-overlay'))return;
      suppressDragMoveClick=false;
      clearTimeout(dragMoveClickTimer);
      dragMoveClickTimer=null;
      event.preventDefault();event.stopImmediatePropagation();
    },true);
    onCleanup(()=>{
      dragMoveReset();
      clearTimeout(dragMoveClickTimer);
      clearTimeout(pendingDragMoveDialogTimer);
      pendingDragMoveDialogTimer=null;
    });
  }

  function createFileRow(entry, index, entries) {
    const row = element('div', 'ufs-entry');
    row.dataset.ufsFile = entry.path;
    row.dataset.ufsIndex = String(index);
    row.classList.add('ufs-drag-ready');
    if(entry.folder)row.dataset.ufsDropPath=entry.path;
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
      if (chosen.length === 1 && !nativeWriteBusy &&
          safeWritePath(chosen[0].path) && chosen[0].copyPathVerified !== false) {
        actions.push(['重命名', () => showRenameDialog(chosen[0])]);
      }
      {
        const blocked = chosen.map(copyBlockedReason).find(Boolean) || '';
        actions.push(['复制到…', () => showCopyDialog(chosen),
          blocked || (chosen.some(item => parentPath(item.path) !== currentPath()) ?
            '只能复制当前目录下已选择的项目' : '')]);
        actions.push(['移动到…',()=>showCopyDialog(chosen,'move'),
          chosen.some(item=>!safeWritePath(item.path)||item.copyPathVerified===false)?
            '当前选择包含不安全的移动路径':
            chosen.some(item=>parentPath(item.path)!==currentPath())?'只能移动当前目录下的项目':'']);
        actions.push(['删除',()=>showDeleteDialog(chosen),
          chosen.some(item=>!safeWritePath(item.path)||item.copyPathVerified===false)?
            '当前选择包含不安全的删除路径':
            chosen.some(item=>parentPath(item.path)!==currentPath())?'只能删除当前目录下的项目':'']);
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


  function showCopyDialog(entryOrEntries,operation='copy',options={}) {
    const isMove=operation==='move';
    const requestedDestination=isMove && typeof options?.initialDestination==='string' ? options.initialDestination : null;
    if(!['copy','move'].includes(operation))return;
    // Snapshot the selection: navigation or re-selection must not alter this batch.
    const entries=Array.isArray(entryOrEntries)?entryOrEntries.slice():[entryOrEntries];
    const entry=entries[0];
    const multi=entries.length>1;
    if (!(isMove?MOVE_ENABLED:COPY_ENABLED) || destroyed || !entry || !activeTab() || state.busy ||
        $('.ufs-dialog-overlay', app) ||
        entries.some(item => !item || (isMove?!safeWritePath(item.path):copyBlockedReason(item)) ||
          currentPath() !== parentPath(item.path))) return;
    const source = entry.path;
    const copyDestinationAllowedForAll=dir=>entries.every(item =>
      copyDestinationAllowed({source:item.path,folder:item.folder},dir) && (!isMove||safeWritePath(dir,true)));
    // The menu action may remove the opener before this dialog is constructed.
    // Fall back to the file list when returning focus to a detached opener.
    const opener = document.activeElement;
    const logMoveDialog=(code,details={})=>{
      if(isMove)diagnosticLog('INFO',code,{count:entries.length,...details});
    };
    const overlay = element('div','ufs-dialog-overlay');
    const dialog = element('div','ufs-create-dialog ufs-copy-dialog');
    dialog.tabIndex = -1;
    dialog.setAttribute('role','dialog');
    dialog.setAttribute('aria-modal','true');
    dialog.setAttribute('aria-label',(isMove?'移动到':'复制到'));
    const header = element('div','ufs-create-head');
    const heading=element('h3','',(isMove?'移动到':'复制到'));
    header.append(heading);
    const dismiss = element('button','ufs-create-dismiss');
    dismiss.type='button';
    dismiss.setAttribute('aria-label',(isMove?'关闭移动窗口':'关闭复制窗口'));
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
    if(multi) {
      summaryContent.replaceChildren();
      const files=entries.filter(item=>!item.folder).length;
      summary.append(element('div','ufs-batch-summary-heading',
        '已选择 '+entries.length+' 项（'+files+' 个文件、'+(entries.length-files)+' 个文件夹）'));
      summaryContent.className='ufs-batch-preview';
      entries.slice(0,3).forEach(item=>{
        const row=element('div','ufs-batch-preview-row');
        row.append(icon(item.folder?'folder':'file','ufs-folder-icon'),
          element('span','',item.name));
        row.title=item.name;
        summaryContent.append(row);
      });
      const more=element('button','ufs-batch-open-list',
        '查看全部 '+entries.length+' 项');
      more.type='button';
      summary.append(summaryContent,more);
    } else {
      summary.append(summaryContent);
    }
    const location=element('div','ufs-create-field');
    location.append(element('label','ufs-create-label','目标位置'));
    const picker=element('div','ufs-copy-picker');
    picker.setAttribute('role','tree');
    picker.setAttribute('aria-label',(isMove?'选择移动目标文件夹':'选择复制目标文件夹'));
    const destinationText=element('div','ufs-copy-destination','请选择目标文件夹');
    location.append(picker);
    let conflictPolicy='skip';
    const policy=element('div','ufs-copy-policy');
    policy.setAttribute('role','group');
    policy.setAttribute('aria-label','遇到同名项目');
    policy.append(element('span','ufs-copy-policy-title','遇到同名项目'));
    for(const [value,label,tip] of [
      ['skip','忽略',isMove?
        '同名普通文件保留目标和源文件；同名文件夹合并，冲突文件留在源目录。':
        '跳过目标中已存在的同名文件；同名文件夹会合并。'],
      ['overwrite','覆盖',isMove?
        '同名文件夹合并并覆盖内部同名文件；目标独有文件保留。':
        '允许用源文件替换同名文件；同名文件夹会合并。']
    ]) {
      const option=element('label','ufs-copy-policy-choice');
      option.dataset.tooltip=tip;
      const radio=element('input','ufs-copy-policy-radio');
      radio.type='radio';
      radio.name='ufs-copy-conflict-policy';
      radio.value=value;
      radio.checked=value==='skip';
      radio.setAttribute('aria-label',label);
      radio.addEventListener('change',()=>{
        if(!busy && (!copyJob || copyJob.status==='failed' || copyJob.recoverable) && radio.checked)
          conflictPolicy=value;
      });
      option.append(radio,element('span','ufs-copy-policy-ring'),element('span','',label));
      policy.append(option);
    }
    const preflightNotice=element('section','ufs-preflight-notice');
    preflightNotice.setAttribute('role','alert');
    preflightNotice.setAttribute('aria-live','assertive');
    preflightNotice.hidden=true;
    const noticeHead=element('div','ufs-preflight-head');
    noticeHead.append(icon('alert-triangle'),element('strong','ufs-preflight-title'));
    const noticeDetail=element('div','ufs-preflight-detail');
    const noticeConflicts=element('div','ufs-preflight-conflicts');
    const noticeAdvice=element('div','ufs-preflight-advice');
    preflightNotice.append(noticeHead,noticeDetail,noticeConflicts,noticeAdvice);
    const checkingPanel=element('div','ufs-preflight-checking');
    checkingPanel.setAttribute('role','status');
    checkingPanel.setAttribute('aria-live','polite');
    checkingPanel.append(icon('folder-search','ufs-preflight-checking-icon'));
    const checkingContent=element('div','ufs-preflight-checking-body');
    checkingContent.append(element('strong','',(isMove?'正在检查移动任务…':'正在检查复制任务…')),
      element('div','ufs-preflight-checking-detail',
        '正在核验源文件、目标目录及全部同名冲突，请稍候。'));
    checkingPanel.append(checkingContent);
    const feedback=element('div','ufs-create-feedback ufs-copy-feedback',
      (isMove?'不允许将文件夹移动到自身内部。':'不允许将文件夹复制到自身内部。'));
    feedback.setAttribute('role','status');
    location.append(feedback);
    const fixedOptions=element('div','ufs-copy-fixed-options');
    fixedOptions.append(destinationText,policy);
    fields.append(summary,location);
    function showPreflightError(error,conflicts=[]) {
      preflightNotice.hidden=false;
      const heading=preflightNotice.querySelector('.ufs-preflight-title');
      heading.textContent=conflicts.length?'发现 '+conflicts.length+' 项同名冲突':(isMove?'移动预检未通过':'复制预检未通过');
      noticeDetail.textContent=conflicts.length?
        '所选 '+entries.length+(isMove?' 项均未开始移动，本次预检没有修改目标文件。':' 项均未开始复制，目标目录的已有文件不会被覆盖。'):
        (isMove?'本次未开始移动：':'本次未开始复制：')+String(error?.message||error);
      noticeConflicts.replaceChildren();
      noticeConflicts.hidden=!conflicts.length;
      for(const name of conflicts) {
        const row=element('div','ufs-preflight-conflict-row');
        row.append(icon('file','ufs-folder-icon'),element('span','',name));
        row.title=name;
        noticeConflicts.append(row);
      }
      noticeAdvice.textContent=(isMove?
        '可以更改同名策略或选择其他目标目录；同名文件夹允许合并，但文件与文件夹类型冲突仍会拒绝。':
        '请选择其他目标文件夹，或取消后重新选择需要复制的项目。');
      showCopyFields(preflightNotice,summary,location);
      fields.scrollTop=0;
      // Keep the original status text for compatibility with screen readers
      // and tests, but never rely on it as the primary visible error.
      setFeedback(String(error?.message||error),true);
    }
    function clearPreflightError() {
      preflightNotice.hidden=true;
      noticeConflicts.replaceChildren();
      setFeedback((isMove?'不允许将文件夹移动到自身内部。':'不允许将文件夹复制到自身内部。'));
    }
    // Prepared once; shown in place of the picker only after the user submits.
    // This is an indeterminate animation, never a synthetic percentage.
    const progressPanel=element('div','ufs-copy-progress-panel ufs-unified-progress');
    progressPanel.dataset.phase='checking';
    progressPanel.dataset.progressMode='indeterminate';
    progressPanel.append(element('label','ufs-create-label',(isMove?'移动到':'复制到')));
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
    track.setAttribute('aria-label',(isMove?'移动任务进行中，进度未知':'复制任务进行中，进度未知'));
    // No aria-valuenow or made-up percentage: rsync does not reliably provide it.
    const fill=element('div','ufs-copy-progress-fill');
    track.append(fill);
    progressPanel.append(track);
    const singleSummary=element('div','ufs-unified-meta');
    const singleDone=element('span','','已完成 0 / 1 项');
    const singleBasis=element('span','',entry.folder?'文件夹总体进度未知':'当前文件进度');
    singleSummary.append(singleDone,singleBasis);
    progressPanel.append(singleSummary);
    const progressStages=element('div','ufs-copy-progress-stages');
    const stages=[
      ['checking','目标检查'],['copying',(isMove?'文件移动':'文件复制')],['verifying','完成核对']
    ];
    const stageNodes=stages.map(([phase,title])=>{
      const node=element('span','ufs-copy-progress-stage','○ '+title);
      node.dataset.step=phase;
      progressStages.append(node);
      return node;
    });
    progressPanel.append(progressStages);
    const singleCurrent=element('div','ufs-unified-current');
    const singleCurrentTop=element('div','ufs-unified-current-top');
    singleCurrentTop.append(element('span','','当前项目 · 第 1 / 1 项'),
      element('span','',entry.folder?'文件夹':'文件'));
    const singleCurrentName=element('div','ufs-unified-current-name',entry.name);
    singleCurrentName.title=entry.name;
    const progressFile=element('div','ufs-copy-current-file');
    const progressFilePercent=element('div','ufs-unified-file-percent');
    progressFilePercent.hidden=true;
    const progressMetrics=element('div','ufs-copy-progress-metrics ufs-unified-metrics');
    const speedMetric=element('div','ufs-unified-metric');
    const speedLabel=element('span','','当前速度');
    const speedValue=element('strong','',(isMove?'正在获取移动速度…':'正在获取复制速度…'));
    speedMetric.append(speedLabel,speedValue);
    const etaMetric=element('div','ufs-unified-metric');
    const etaLabel=element('span','','当前文件预计剩余');
    const etaValue=element('strong','','—');
    etaMetric.append(etaLabel,etaValue);
    const transferValue=element('div','ufs-unified-transfer');
    progressMetrics.append(speedMetric,etaMetric,transferValue);
    singleCurrent.append(singleCurrentTop,singleCurrentName,progressFile,progressFilePercent,progressMetrics);
    progressPanel.append(singleCurrent);
    const progressNote=element('div','ufs-copy-progress-note');
    progressNote.setAttribute('role','status');
    progressNote.setAttribute('aria-live','polite');
    progressPanel.append(progressNote);
    let visibleCopyPhase='checking';
    let lastCopyTransferred='',lastCopyEta='';
    function renderSingleCopyMetrics() {
      if(visibleCopyPhase!=='copying') return;
      const rate=currentCopySpeed(copyJob);
      speedValue.textContent=rate || (copyJob?.speedUpdatedAt?'暂无实时速度数据':(isMove?'正在获取移动速度…':'正在获取复制速度…'));
      etaValue.textContent=rate && lastCopyEta?lastCopyEta:'—';
      transferValue.textContent=lastCopyTransferred?'已传输 '+lastCopyTransferred:'';
    }
    function renderSharedCopyStages(nodes,phase,lastStep=1) {
      const stageIndex=stages.findIndex(([key])=>key===phase);
      nodes.forEach((node,index)=>{
        const state=phase==='success'?'done':phase==='uncertain'||phase==='failed'||phase==='stopped'
          ?(index<lastStep?'done':index===lastStep?'error':'pending')
          :(index<stageIndex?'done':index===stageIndex?'active':'pending');
        node.dataset.status=state;
        node.textContent=(state==='done'?'✓ ':state==='active'?'● ':state==='error'?'! ':'○ ')+stages[index][1];
      });
    }
    function renderCopyProgress(phase,message='') {
      visibleCopyPhase=phase;
      progressPanel.dataset.phase=phase;
      renderSharedCopyStages(stageNodes,phase,lastActiveCopyStep);
      singleDone.textContent='已完成 '+(phase==='success'?1:0)+' / 1 项';
      singleBasis.textContent=entry.folder?'文件夹总体进度未知':'当前文件进度';
      const labels={
        checking:['正在检查目标…','准备中','正在检查源文件和目标目录…'],
        copying:[(isMove?'正在移动文件…':'正在复制文件…'),'进行中','正在等待 Unraid 完成文件操作，请勿关闭页面。'],
        verifying:[(isMove?'正在核对移动结果…':'正在核对复制结果…'),'核对中',(isMove?'正在检查目标目录和移动结果…':'正在检查目标目录和复制结果…')],
        success:[(isMove?'移动完成':'复制完成'),'已完成',(isMove?'移动结果已核对，窗口即将关闭。':'复制结果已核对，窗口即将关闭。')],
        uncertain:[(isMove?'无法确认移动结果':'无法确认复制结果'),'需核实','结果不确定，请检查目标目录及原生任务状态，切勿直接重试。']
      };
      const info=labels[phase] || labels.checking;
      progressStateText.textContent=info[0];
      progressIndicator.textContent=info[1];
      progressNote.textContent=message || info[2];
      if(phase!=='copying') {
        progressFile.textContent='';
        progressFile.removeAttribute('title');
        progressFilePercent.textContent='';
        progressFilePercent.hidden=true;
        speedValue.textContent=phase==='success'?'已完成':'—';
        etaValue.textContent='—';
        transferValue.textContent='';
        lastCopyTransferred='';
        lastCopyEta='';
      } else renderSingleCopyMetrics();
      track.setAttribute('aria-label',phase==='success'?(isMove?'移动完成':'复制完成'):
        phase==='uncertain'?(isMove?'移动结果无法确认':'复制结果无法确认'):(isMove?'移动任务进行中，进度未知':'复制任务进行中，进度未知'));
      if(phase==='success') {fill.style.width='100%';track.setAttribute('aria-valuenow','100');}
      if(phase==='uncertain' || phase==='cancelled') {fill.style.animation='none';}
      if(phase==='checking') {progressPanel.dataset.progressMode='indeterminate';fill.style.width='35%';fill.style.animation='';track.removeAttribute('aria-valuenow');}
    }
    let lastActiveCopyStep=0;
    function updateCopyProgress(message,phase,info) {
      if(closed || destroyed) return;
      copyJobSignal(copyJob,phase,info);
      if(phase) {
        const next=stages.findIndex(([key])=>key===phase);
        if(next>=0) lastActiveCopyStep=Math.max(lastActiveCopyStep,next);
        renderCopyProgress(phase);
      } else if(visibleCopyPhase==='copying' && message) {
        if(info?.filename) {
          const current=info.filename.trim().replace(/\/$/,'');
          if(progressFile.title!==current) {
            progressFilePercent.textContent='';
            progressFilePercent.hidden=true;
          }
          progressFile.textContent='当前文件：'+shortenCopyName(current.split('/').pop()||current,90);
          progressFile.title=current;
        }
        if(info?.percent!=null && entry.folder) {
          // rsync reports the nested current file, not the entire folder.
          progressFilePercent.textContent='当前文件进度 '+info.percent+'%';
          progressFilePercent.hidden=false;
        }
        if(info?.percent!=null && !entry.folder && !isMove) {
          if(copyJob) {
            copyJob.percent=Math.max(copyJob.percent??0,Math.min(99.9,info.percent));
            updateCopyTaskButton();
          }
          progressPanel.dataset.progressMode='determinate';
          fill.style.animation='none';
          fill.style.width=info.percent+'%';
          track.setAttribute('aria-valuenow',String(info.percent));
          track.setAttribute('aria-label',(isMove?'移动进度 ':'复制进度 ')+info.percent+'%');
          progressIndicator.textContent=info.percent+'%';
        }
        if(info?.transferred) lastCopyTransferred=info.transferred;
        if(info?.eta) lastCopyEta=info.eta;
        renderSingleCopyMetrics();
        // Do not dump full rsync paths and octal bytes into a multi-line panel.
        progressNote.textContent=(isMove?'正在移动，请保持此页面打开。':'正在复制，请保持此页面打开。');
      }
    }
    const footer=element('div','ufs-create-buttons');
    const cancel=element('button','ufs-create-cancel ufs-copy-cancel','取消');
    cancel.type='button';
    const background=element('button','ufs-copy-background','后台运行');
    background.type='button';
    background.hidden=true;
    const submit=element('button','ufs-create-submit ufs-copy-submit',(isMove?'开始移动':'开始复制'));
    submit.type='submit';
    submit.disabled=true;
    footer.append(background,cancel,submit);
    form.append(fields,fixedOptions,footer);
    function showCopyFields(...nodes) {
      fields.replaceChildren(...nodes);
      fixedOptions.hidden=!nodes.includes(location);
    }
    dialog.append(header,form);
    overlay.append(dialog);
    app.append(overlay);
    logMoveDialog('dialog.move_open',{prefilled:!!requestedDestination});
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
    let prefillPending=!!requestedDestination, prefillOverridden=false;
    let prefillLoadError='';
    let finalPhase='picker', cancelSubmitting=false;
    let control={cancelRequested:false,observedOwnTask:false};
    const nodes=new Map();
    const opened=new Set([PREFIX]);
    const pending=new Map();
    let inlineDraft=null;
    let mkdirUncertain=false;
    let copyJob=null;
    const batch=multi?{
      rows:entries.map(item=>({entry:{...item},status:'pending',error:''})),
      currentIndex:-1,currentPercent:null,percent:0,mode:'items',
      started:false,preflighting:false,finished:false,stopAfterCurrent:false,view:'main',phase:'picker',error:''
    }:null;
    const close=(reason='button')=>{
      if(enqueuePending || inlineDraft?.busy || (multi && batch.preflighting)) return;
      if(busy || copyJob?.status==='queued') {minimize();return;}
      logMoveDialog('dialog.move_closed',{reason,phase:finalPhase,prefillPending});
      closed=true; ++requestVersion;
      overlay.remove();
      if(copyJob) removeCopyJob(copyJob);
      restoreFocus();
    };
    const minimize=()=>{
      if((!busy && copyJob?.status!=='queued') || closed) return;
      overlay.remove();
      updateCopyTaskButton();
      restoreFocus($('.ufs-copy-task-trigger',app));
      notify((isMove?'移动继续在当前页面运行；点击底部右侧任务按钮可恢复窗口。请勿刷新页面。':'复制继续在当前页面运行；点击底部右侧任务按钮可恢复窗口。请勿刷新页面。'));
    };
    const reopen=()=>{
      if(closed || destroyed || $('.ufs-dialog-overlay',app)) return;
      app.append(overlay);
      updateCopyTaskButton();
      focusDialog();
    };
    dismiss.addEventListener('click',()=>close('dismiss'));
    background.addEventListener('click',minimize);
    cancel.addEventListener('click',()=>{
      if(copyJob?.status==='queued') {
        const queued=copyJob;
        queued.status='removed';
        removeCopyJob(queued);
        copyJob=null;
        closed=true; ++requestVersion;
        overlay.remove();
        updateCopyTaskButton();
        restoreFocus();
        return;
      }
      if(multi) {
        if(batch.view==='list') {showBatchMain();return;}
        if(batch.finished || !batch.started) {close('cancel');return;}
        batchStopChoices.hidden=!batchStopChoices.hidden;
        return;
      }
      if(!busy || finalPhase==='success' || finalPhase==='uncertain' ||
          finalPhase==='cancelled') {close('cancel');return;}
      if(finalPhase==='cancelling') {minimize();return;}
      if(finalPhase!=='copying' || cancelSubmitting || control.cancelRequested) return;
      if(isMove){progressNote.textContent='移动任务不可安全立即停止，请等待完成并核实。';return;}
      if(!control.observedOwnTask) {
        progressNote.textContent='原生任务归属尚未确认，暂时无法安全停止。可选择后台运行。';
        return;
      }
      const yes=window.confirm(
        (isMove?'确定停止此次移动吗？\n\n取消可能留下不完整的文件或文件夹，需要手动检查目标目录。\n':'确定停止此次复制吗？\n\n取消可能留下不完整的文件或文件夹，需要手动检查目标目录。\n')+
        'Unraid 使用全局停止接口；即使已经检查任务归属，并发任务切换仍有误停风险。\n\n确定继续？'
      );
      if(!yes) return;
      cancelSubmitting=true;
      finalPhase='cancelling';
      cancel.disabled=true;
      cancel.textContent='正在停止…';
      void requestCancelNativeCopy(activeCopySession.plan,control).then(()=>{
        renderCopyProgress('uncertain','已发送停止指令，正在等待 Unraid 确认；请勿直接重试。');
        heading.textContent=(isMove?'正在停止移动':'正在停止复制');
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
    // A backdrop click is intentional only when the user presses AND releases
    // on the backdrop. The synthetic click after a drag cannot close it.
    let backdropPointerId=null;
    overlay.addEventListener('pointerdown',event=>{
      backdropPointerId=event.target===overlay && event.isPrimary && event.button===0 ?
        event.pointerId:null;
    });
    overlay.addEventListener('pointerup',event=>{
      const intentional=event.target===overlay && event.pointerId===backdropPointerId;
      backdropPointerId=null;
      if(intentional)close('backdrop');
    });
    overlay.addEventListener('pointercancel',()=>{backdropPointerId=null;});
    dialog.addEventListener('keydown',event=>{
      if(event.key!=='Escape') return;
      event.preventDefault();
      event.stopPropagation();
      // Inline mkdir is an editor inside the dialog: first Esc cancels that
      // editor, while the next Esc dismisses the copy picker.
      if(inlineDraft && !inlineDraft.busy) {cancelInlineCreate();return;}
      if(multi && batch.view==='list') {showBatchMain();return;}
      close('escape'); // During an active copy this minimizes; it never sends action=99.
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
          const permitted=copyDestinationAllowedForAll(path);
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
            if(selected!==path) clearPreflightError();
            if(prefillPending){
              prefillOverridden=true;
              prefillPending=false;
              prefillLoadError='';
              submit.textContent=(isMove?'开始移动':'开始复制');
              logMoveDialog('dialog.move_target_manual',{target:path});
            }
            selected=path;
            destinationText.textContent='目标：'+path;
            destinationText.title=path;
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
          if(!prefillPending)
            setFeedback((isMove?'不允许将文件夹移动到自身内部。':'不允许将文件夹复制到自身内部。'));
        } catch(error) {
          if(closed || request!==requestVersion) return;
          opened.delete(path);
          if(prefillPending)prefillLoadError=String(error?.message||error);
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
        destinationText.title=created.path;
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

    // Batch mode reuses this dialog's existing target-tree picker, inline mkdir,
    // copyNativeEntry write lock, and current-page background session.
    const batchPanel=element('div','ufs-batch-panel ufs-unified-progress');
    const batchTargetLabel=element('label','ufs-create-label',(isMove?'移动到':'复制到'));
    const batchTarget=element('div','ufs-copy-progress-target');
    batchTarget.append(icon('folder','ufs-folder-icon'));
    const batchTargetPath=element('span','ufs-copy-progress-target-text');
    batchTarget.append(batchTargetPath);
    batchPanel.append(batchTargetLabel,batchTarget);
    const batchListPanel=element('div','ufs-batch-panel ufs-batch-list-panel');
    const batchHeading=element('div','ufs-batch-line ufs-copy-progress-status');
    const batchCaption=element('strong','','总体进度');
    const batchPercentText=element('span','ufs-batch-percent','0%');
    batchHeading.append(batchCaption,batchPercentText);
    const batchTrack=element('div','ufs-batch-track');
    batchTrack.setAttribute('role','progressbar');
    batchTrack.setAttribute('aria-label',(isMove?'批量移动总体进度':'批量复制总体进度'));
    batchTrack.setAttribute('aria-valuemin','0');
    batchTrack.setAttribute('aria-valuemax','100');
    const batchFill=element('div','ufs-batch-fill');
    batchTrack.append(batchFill);
    const batchMeta=element('div','ufs-batch-line ufs-batch-meta ufs-unified-meta');
    const batchDone=element('span','','已完成 0 / '+entries.length+' 项');
    const batchBasis=element('span','','按项目进度计算');
    batchMeta.append(batchDone,batchBasis);
    const batchStages=element('div','ufs-copy-progress-stages');
    const batchStageNodes=stages.map(([phase,title])=>{
      const node=element('span','ufs-copy-progress-stage','○ '+title);
      node.dataset.step=phase;
      batchStages.append(node);
      return node;
    });
    const batchCurrent=element('div','ufs-batch-current ufs-unified-current');
    const batchCurrentTop=element('div','ufs-unified-current-top');
    const batchCurrentOrdinal=element('span','','当前项目 · 第 1 / '+entries.length+' 项');
    const batchCurrentType=element('span','','准备中');
    batchCurrentTop.append(batchCurrentOrdinal,batchCurrentType);
    const batchCurrentName=element('span','ufs-batch-current-name',(isMove?'正在准备移动任务…':'正在准备复制任务…'));
    const batchCurrentInfo=element('span','ufs-batch-meta ufs-batch-current-info','等待安全预检');
    const batchCurrentFile=element('div','ufs-copy-current-file');
    const batchCurrentMetrics=element('div','ufs-unified-metrics');
    const batchSpeedRow=element('div','ufs-batch-speed-row');
    const batchSpeedValue=element('strong','ufs-batch-speed-value',(isMove?'正在获取移动速度…':'正在获取复制速度…'));
    batchSpeedRow.append(element('span','ufs-batch-meta','当前速度'),batchSpeedValue);
    const batchEtaRow=element('div','ufs-batch-speed-row');
    const batchEtaValue=element('strong','ufs-batch-speed-value','—');
    batchEtaRow.append(element('span','ufs-batch-meta','当前文件预计剩余'),batchEtaValue);
    batchCurrentMetrics.append(batchSpeedRow,batchEtaRow);
    batchCurrent.append(batchCurrentTop,batchCurrentName,batchCurrentInfo,batchCurrentFile,batchCurrentMetrics);
    const batchStats=element('div','ufs-batch-stats');
    const batchStatsDone=element('span','','成功 0');
    const batchStatsPending=element('span','','待执行 '+entries.length);
    batchStats.append(batchStatsDone,batchStatsPending);
    const batchListOpen=element('button','ufs-batch-open-list','查看全部 '+entries.length+' 项任务 →');
    batchListOpen.type='button';
    const batchNote=element('div','ufs-batch-warning','请勿刷新或关闭当前浏览器页面。');
    const batchStopChoices=element('div','ufs-batch-stop-choices');
    batchStopChoices.hidden=true;
    batchStopChoices.append(element('strong','',(isMove?'停止移动队列':'停止复制队列')));
    const stopSafely=element('button','','当前项目完成后停止（推荐）');
    stopSafely.type='button';
    stopSafely.addEventListener('click',()=>{
      batch.stopAfterCurrent=true;
      batchStopChoices.hidden=true;
      batchNote.textContent=(isMove?'将在当前项目移动完成后停止，后续项目不再开始。':'将在当前项目复制完成后停止，后续项目不再开始。');
      cancel.textContent='等待当前项结束';
      cancel.disabled=true;
      renderBatchProgress();
    });
    const stopNow=element('button','','尝试停止当前项目及后续队列…');
    stopNow.type='button';
    stopNow.addEventListener('click',()=>{
      if(isMove){batchNote.textContent='移动任务请等待当前项完成后停止后续队列。';return;}
      if(!busy || batch.currentIndex<0 || !control.observedOwnTask) {
        batchNote.textContent='尚未确认当前原生任务归属，无法安全发送停止指令；可选择等待当前项完成。';
        return;
      }
      if(!window.confirm((isMove?'停止当前移动可能留下不完整文件或文件夹。\nUnraid 的停止接口是全局操作，存在误停并发任务的风险。\n确定尝试停止当前任务及后续队列吗？':'停止当前复制可能留下不完整文件或文件夹。\nUnraid 的停止接口是全局操作，存在误停并发任务的风险。\n确定尝试停止当前任务及后续队列吗？'))) return;
      batch.stopAfterCurrent=true;
      batchStopChoices.hidden=true;
      cancel.disabled=true;
      cancel.textContent='正在尝试停止…';
      void requestCancelNativeCopy(activeCopySession.plan,control).catch(error=>{
        batchNote.textContent='停止请求结果待核实：'+String(error?.message||error);
      });
    });
    if(isMove)stopNow.hidden=true;
    batchStopChoices.append(stopSafely,stopNow,
      element('div','ufs-batch-warning','停止当前项目需要原生任务归属检查，结果可能不确定。'));
    batchPanel.append(batchHeading,batchTrack,batchMeta,batchStages,batchCurrent,batchStats,
      batchListOpen,batchStopChoices,batchNote);
    const batchListBack=element('button','ufs-batch-list-back','← 返回');
    batchListBack.type='button';
    const batchListSummary=element('div','ufs-batch-meta','共 '+entries.length+' 项');
    const batchSearch=element('input','ufs-batch-list-search');
    batchSearch.type='search';
    batchSearch.placeholder='搜索文件名或序号…';
    batchSearch.setAttribute('aria-label',(isMove?'筛选移动任务清单':'筛选复制任务清单'));
    const batchScroll=element('div','ufs-batch-list-scroll');
    batchScroll.setAttribute('role','list');
    batchListPanel.append(batchListBack,batchListSummary,batchSearch,batchScroll,
      element('div','ufs-batch-meta',(isMove?'清单视图仅用于查看，不改变目标目录和移动顺序。':'清单视图仅用于查看，不改变目标目录和复制顺序。')));
    function renderBatchRows() {
      if(!multi || batch.view!=='list') return;
      const q=batchSearch.value.trim().toLowerCase();
      const filtered=batch.rows.filter((row,index)=>
        !q || row.entry.name.toLowerCase().includes(q) || String(index+1)===q);
      batchListSummary.textContent='共 '+entries.length+' 项 · 当前显示 '+filtered.length+' 项';
      batchScroll.replaceChildren();
      // Cap mounted rows for very large selections. Searching can reach any row.
      const mounted=filtered.slice(0,500);
      mounted.forEach(row=>{
        const i=batch.rows.indexOf(row);
        const item=element('div','ufs-batch-list-row');
        item.dataset.status=row.status;
        item.setAttribute('role','listitem');
        const index=element('span','ufs-batch-list-index',String(i+1));
        const name=element('span','ufs-batch-list-name',row.entry.name);
        name.title=row.entry.name;
        const labels={pending:'等待',copying:'进行中',success:'成功',skipped:'忽略',
          failed:'失败',uncertain:'待核实'};
        const status=element('span','ufs-batch-list-state',
          row.moveOutcome==='merged-partial'?'部分移动':labels[row.status] || row.status);
        if(row.moveOutcome==='merged-partial')
          status.title='同名文件夹已合并，但源目录仍保留未转移的文件';
        if(row.error) {status.title=row.error;item.title=row.error;}
        item.append(index,icon(row.entry.folder?'folder':'file','ufs-folder-icon'),name,status);
        batchScroll.append(item);
      });
      if(filtered.length>500) batchScroll.append(
        element('div','ufs-batch-meta','列表较长，当前显示前 500 项；可通过搜索定位其他项目。'));
      if(!filtered.length) batchScroll.append(element('div','ufs-batch-meta','没有匹配项目'));
    }
    function showBatchList() {
      if(!multi) return;
      batch.view='list';
      batchListBack.textContent=batch.started?(isMove?'← 返回移动进度':'← 返回复制进度'):'← 返回目标选择';
      heading.textContent=batch.started?'任务清单（'+entries.length+'）':'已选项目（'+entries.length+'）';
      cancel.hidden=false;
      cancel.disabled=false;
      cancel.textContent=batch.started?(isMove?'返回移动进度':'返回复制进度'):'返回目标选择';
      submit.hidden=true;
      background.hidden=true;
      showCopyFields(batchListPanel);
      renderBatchRows();
      batchSearch.focus({preventScroll:true});
    }
    function showBatchMain() {
      if(!multi) return;
      batch.view='main';
      heading.textContent=batch.finished?(isMove?'移动结果':'复制结果'):batch.started?(isMove?'正在移动':'正在复制'):(isMove?'移动到':'复制到');
      cancel.hidden=batch.finished;
      cancel.disabled=batch.stopAfterCurrent && !batch.finished;
      cancel.textContent=batch.started?
        (batch.stopAfterCurrent?'等待当前项结束':'停止队列…'):'取消';
      submit.hidden=batch.started && !batch.finished;
      background.hidden=!batch.started || batch.finished;
      showCopyFields(...(batch.started?[batchPanel]:
        preflightNotice.hidden?[summary,location]:[preflightNotice,summary,location]));
      if(!batch.started) renderPicker();
      focusDialog();
    }
    batchSearch.addEventListener('input',renderBatchRows);
    batchListBack.addEventListener('click',showBatchMain);
    batchListOpen.addEventListener('click',showBatchList);
    if(multi) summary.querySelector('.ufs-batch-open-list').addEventListener('click',showBatchList);

    function refreshBatchCurrentMetrics() {
      if(!multi || !batch.started || batch.finished || batch.currentIndex<0) return;
      const rate=currentCopySpeed(copyJob),phase=copyJob?.phase;
      batchSpeedValue.textContent=phase==='checking'?'正在检查目标…':
        phase==='verifying'?(isMove?'正在核对移动结果…':'正在核对复制结果…'):
        rate || (copyJob?.speedUpdatedAt?'暂无实时速度数据':(isMove?'正在获取移动速度…':'正在获取复制速度…'));
      batchEtaValue.textContent=phase==='copying' && rate && copyJob?.eta?copyJob.eta:'—';
    }
    function renderBatchProgress() {
      if(!multi) return;
      const visualPhase=batch.finished?batch.phase:copyJob?.phase||'copying';
      batchPanel.dataset.phase=visualPhase;
      renderSharedCopyStages(batchStageNodes,visualPhase,
        visualPhase==='verifying'?2:1);
      const done=batch.rows.filter(row=>['success','skipped'].includes(row.status)).length;
      const skipped=batch.rows.filter(row=>row.status==='skipped').length;
      const partial=batch.rows.filter(row=>row.moveOutcome==='merged-partial').length;
      const waiting=batch.rows.filter(row=>row.status==='pending').length;
      const current=batch.rows[batch.currentIndex];
      const result=batchCopyOverallProgress(batch.rows,batch.currentIndex,isMove?null:batch.currentPercent);
      batch.percent=Math.max(batch.percent,result.percent);
      batch.mode=result.mode;
      batchPercentText.textContent=batch.percent.toFixed(batch.percent%1===0?0:2)+'%';
      batchFill.style.width=batch.percent+'%';
      batchTrack.setAttribute('aria-valuenow',String(batch.percent));
      batchDone.textContent='已完成 '+done+' / '+batch.rows.length+' 项';
      batchBasis.textContent=batch.mode==='bytes'?'按文件大小计算':'按项目计算 · 非字节进度';
      batchStatsDone.textContent='成功 '+(done-skipped-partial)+
        (partial?' · 部分移动 '+partial:'')+(skipped?' · 忽略 '+skipped:'');
      batchStatsPending.textContent=batch.finished
        ?'未执行 '+waiting
        :'等待 '+waiting;
      if(batch.finished) {
        const problems=batch.rows.filter(row=>row.status==='failed'||row.status==='uncertain').length;
        batchCaption.textContent='总体进度';
        batchCurrentOrdinal.textContent='已完成 '+done+' / '+batch.rows.length+' 项';
        batchCurrentType.textContent=batch.phase==='success'?'已完成':'需核实';
        batchCurrentFile.textContent='';
        batchCurrentName.textContent=batch.phase==='success'?
          '已处理 '+done+' 项（忽略 '+skipped+' 项'+
            (partial?'，部分移动 '+partial+' 项':'')+'）':batch.phase==='stopped'?
          '队列已停止，后续任务未执行':
          (isMove?'移动任务已暂停，需检查失败或待核实项目':'复制任务已暂停，需检查失败或待核实项目');
        batchCurrentInfo.textContent='成功 '+(done-skipped-partial)+
          ' · 部分移动 '+partial+' · 忽略 '+skipped+' · 问题 '+problems+' · 未执行 '+waiting;
        batchCurrentMetrics.hidden=true;
        batchCurrentInfo.title=batch.error||'';
        batchNote.textContent=batch.error || (batch.phase==='success'?
          (partial?'同名文件夹已合并，源目录仍保留部分文件；请检查源目录剩余项目。':
          batch.nativeGroup && copyJob?.record?.batchMode==='native-move-mixed'?
            '顶层移动结果已核对；文件夹内部内容并未递归校验，请在 NAS 上确认。':
            (isMove?'移动结果已核对。':'复制结果已核对。')):
          '请核实未完成项目，切勿直接重试。');
        batchListOpen.textContent='查看全部 '+batch.rows.length+' 项结果 →';
        batchStopChoices.hidden=true;
        if(batch.phase==='success') {
          batchPercentText.style.color='#258755';
          batchFill.style.background='#258755';
        }
      } else if(current) {
        refreshBatchCurrentMetrics();
        batchCurrentOrdinal.textContent='当前项目 · 第 '+(batch.currentIndex+1)+' / '+entries.length+' 项';
        batchCurrentType.textContent=current.entry.folder?'文件夹':'文件';
        batchCurrentName.textContent=current.entry.name;
        batchCurrentInfo.textContent='第 '+(batch.currentIndex+1)+' / '+entries.length+' 项'+
          (current.entry.folder?' · 文件夹':' · 文件')+
          (batch.currentPercent!=null && !current.entry.folder?' · 当前项目 '+batch.currentPercent+'%':'');
      }
      if(copyJob && Number.isFinite(batch.percent)) {
        copyJob.percent=batch.percent;
        updateCopyTaskButton();
      }
    }
    async function preflightBatchCopy(plans) {
      // Take fresh source + destination snapshots before submitting ANY write.
      if(new Set(plans.map(plan=>plan.target)).size!==plans.length)
        throw new Error((isMove?'有多个项目对应同一个目标文件名，拒绝批量移动':'有多个项目对应同一个目标文件名，拒绝批量复制'));
      const sourceItems=await listDirectory(parentPath(plans[0].source));
      const destinationItems=await listDirectory(plans[0].destinationDir);
      const typeConflicts=findBatchCopyTypeConflicts(plans,destinationItems);
      const topLevelMatches=plans.map(plan=>({
        plan,match:destinationItems.find(item=>item.path===plan.target ||
          item.name===fileName(plan.source))
      })).filter(item=>!!item.match);
      if(isMove)diagnosticLog('INFO','move.batch_preflight',{
        taskId:copyJob.taskId,count:plans.length,
        conflictPolicy:plans[0].conflictPolicy,
        targetExistingCount:topLevelMatches.length,
        sameNameFolderCount:topLevelMatches.filter(({plan,match})=>
          plan.folder&&match.folder===true).length,
        typeConflictCount:typeConflicts.length,
        folderCount:plans.filter(plan=>plan.folder).length,
        nestedConflictInspection:'not-performed'});
      const conflicts=typeConflicts.length?typeConflicts:
        plans[0].conflictPolicy==='fail'?
          findBatchCopyConflicts(plans,destinationItems):[];
      if(conflicts.length) {
        const error=new Error('发现 '+conflicts.length+
          (typeConflicts.length?' 项文件/文件夹类型冲突':' 项同名冲突')+(isMove?'，整批未开始移动':'，整批未开始复制'));
        error.copyConflicts=conflicts;
        throw error;
      }
      for(const [i,plan] of plans.entries()) {
        const fresh=sourceItems.find(item=>item.path===plan.source);
        if(!fresh || fresh.folder!==plan.folder || fresh.copyPathVerified===false)
          throw new Error('源项目已更改或路径不安全：'+fileName(plan.source));
        if(isMove && !safeWritePath(fresh.path))throw new Error('移动源路径包含不安全的字符');
        if(!isMove && copyBlockedReason(fresh)) throw new Error(copyBlockedReason(fresh));
        batch.rows[i].entry={...fresh};
      }
      if(await readNativeActive()) throw new Error('Unraid 正在执行其他原生文件任务，请稍后重试');
      nativeCsrfToken();
      return destinationItems;
    }
    async function startBatchCopy() {
      if(!multi || batch.started || batch.preflighting || batch.finished || busy || inlineDraft ||
          mkdirUncertain || submit.disabled || !selected || nativeWriteBusy) {
        if(copyJob) copyJob.phase='failed';
        return;
      }
      let plans;
      try {
        plans=entries.map(item=>planFileOperation({type:operation,source:item.path,
          destinationDir:selected,folder:item.folder,conflictPolicy:copyJob.conflictPolicy}));
        if(!copyDestinationAllowedForAll(selected))
          throw new Error('目标目录与所选源文件夹冲突');
      } catch(error) {
        if(copyJob) {copyJob.phase='failed';copyJob.error=String(error?.message||error);}
        setFeedback(String(error?.message||error),true);return;
      }
      // Refuse an unsafe destination BEFORE starting the batch. No native writes
      // occur during this phase, so a conflict leaves the target picker usable.
      batch.preflighting=true;
      copyJobSignal(copyJob,'checking');
      submit.disabled=true;
      cancel.disabled=true;
      dismiss.disabled=true;
      clearPreflightError();
      heading.textContent=(isMove?'正在检查移动任务':'正在检查复制任务');
      checkingPanel.querySelector('.ufs-preflight-checking-detail').textContent=
        '正在核验 '+entries.length+' 项源文件、目标目录及同名冲突，请稍候。';
      showCopyFields(checkingPanel);
      focusDialog();
      let destinationItems;
      try {
        destinationItems=await preflightBatchCopy(plans);
        if(destroyed || closed) return;
      } catch(error) {
        batch.phase='failed';
        batch.error=String(error?.message||error);
        copyJob.phase='failed';
        copyJob.error=batch.error;
        copyJob.recoverable=true;
        copyJob.preflightRejected=true;
        heading.textContent=(isMove?'移动到':'复制到');
        showCopyFields(summary,location);
        background.hidden=true;
        cancel.hidden=false;
        cancel.textContent='取消';
        submit.textContent=(isMove?'开始移动':'开始复制');
        submit.hidden=false;
        submit.disabled=false;
        showPreflightError(error,error.copyConflicts||[]);
        return;
      } finally {
        batch.preflighting=false;
        submit.disabled=false;
        cancel.disabled=false;
        dismiss.disabled=false;
      }
      if(destroyed || closed) return;
      // Unraid itself supports CR-joined sources. Only the narrow, verified
      // all-regular-file shape opts in; all other jobs keep the serial path.
      // Preserve fast native batch for ordinary moves with no conflicts.
      // If "skip" meets an existing target, switch to safe per-item checks.
      const topLevelExistingCount=plans.filter(plan=>
        destinationItems?.some(item=>item.path===plan.target ||
          item.name===fileName(plan.source))).length;
      const hasMoveConflict=isMove && topLevelExistingCount>0;
      const batchMoveMode=isMove && !hasMoveConflict?
        nativeMoveBatchMode(plans):null;
      const groupedMove=!!batchMoveMode;
      batch.nativeGroup=groupedMove;
      if(isMove)diagnosticLog('INFO','move.batch_strategy',{
        taskId:copyJob.taskId,count:plans.length,
        conflictPolicy:plans[0].conflictPolicy,
        targetExistingCount:topLevelExistingCount,
        strategy:groupedMove?'native-cr-source':'serial',batchMode:batchMoveMode,
        folderCount:plans.filter(p=>p.folder).length,
        reason:hasMoveConflict?'top-level-name-conflict':
          batchMoveMode||nativeMoveFallbackReason(plans),
        nestedConflictInspection:'not-performed'});
      batch.started=true;
      batch.phase='copying';
      busy=true;
      activeCopySession=copyJob;
      copyJob.plan=null;
      copyJob.phase='copying';
      copyJob.speed='';
      copyJob.speedUpdatedAt=0;
      updateCopyTaskButton();
      heading.textContent=(isMove?'正在移动':'正在复制');
      submit.hidden=true;
      submit.disabled=true;
      cancel.textContent='停止队列…';
      cancel.disabled=false;
      if(groupedMove) {
        // A single native request cannot safely stop between individual files.
        cancel.hidden=true;
        batchNote.textContent='Unraid 将一次处理整批项目；无法逐项停止。文件夹仅核对顶层位置，内部内容请自行核验。异常时不要重试。';
      }
      background.hidden=false;
      dismiss.title='后台运行';
      batchTargetPath.textContent=selected;
      showCopyFields(batchPanel);
      renderBatchProgress();
      focusDialog();
      const batchMetricsTimer=setInterval(()=>{
        if(!destroyed && !closed && batch.view==='main') refreshBatchCurrentMetrics();
      },1000);
      try {
        if(batch.stopAfterCurrent) {
          batch.phase='stopped';
        } else if(groupedMove) {
          batch.currentIndex=0;
          batch.currentPercent=null;
          batch.rows.forEach(row=>{row.status='copying';});
          batchCurrentFile.textContent='正在批量移动 '+plans.length+' 个项目';
          batchCurrentMetrics.hidden=false;
          batchEtaRow.hidden=true;
          renderBatchRows();
          renderBatchProgress();
          // The marker and ALL not-submitted statuses are recorded in ONE
          // snapshot. No native write occurs before the second durable write
          // changes every entry to submission-intent / intent-saved.
          copyJob.record.batchMode=batchMoveMode;
          await copyBatchCheckpoint(copyJob,'checking','not-submitted');
          const results=await moveNativeBatch(plans,(message,phase,info)=>{
            copyJobSignal(copyJob,phase,info);
            if(phase==='checking')batchCurrentInfo.textContent='正在核对整批源文件与目标目录…';
            if(phase==='verifying')batchCurrentInfo.textContent='正在核对全部 '+plans.length+' 个项目…';
            if(info?.filename)batchCurrentFile.textContent='当前文件：'+shortenCopyName(info.filename,90);
            renderBatchProgress();
          },control,async()=>copyBatchCheckpoint(copyJob,'submission-intent','intent-saved'));
          if(results.length!==plans.length)throw new Error('原生批量移动核验数量不一致');
          await copyBatchCheckpoint(copyJob,'success','confirmed');
          batch.rows.forEach(row=>{row.status='success';});
          renderBatchRows();
          renderBatchProgress();
        } else {
          for(let i=0;i<plans.length;i++) {
            if(batch.stopAfterCurrent) {batch.phase='stopped';break;}
            batch.currentIndex=i;
            batch.currentPercent=null;
            copyJob.speed='';
            copyJob.speedUpdatedAt=0;
            copyJob.eta='';
            batchSpeedValue.textContent=(isMove?'正在获取移动速度…':'正在获取复制速度…');
            batchEtaValue.textContent='—';
            batchCurrentFile.textContent='';
            batchCurrentFile.removeAttribute('title');
            batchCurrentMetrics.hidden=false;
            batchEtaRow.hidden=false;
            const row=batch.rows[i];
            row.status='copying';
            renderBatchRows();
            control={cancelRequested:false,observedOwnTask:false};
            activeCopySession.plan=plans[i];
            renderBatchProgress();
            await copyItemCheckpoint(copyJob,i,'checking','not-submitted');
            const outcome=await (isMove?moveNativeEntry:copyNativeEntry)(plans[i],(message,phase,info)=>{
              copyJobSignal(copyJob,phase,info);
              if(phase==='checking') batchCurrentInfo.textContent='正在检查源文件和目标目录…';
              if(phase==='verifying') batchCurrentInfo.textContent=(isMove?'正在核对移动结果…':'正在核对复制结果…');
              if(info && Number.isFinite(info.percent) && !row.entry.folder) {
                if(!isMove)batch.currentPercent=Math.max(batch.currentPercent??0,info.percent);
              }
              if(phase==='checking' || phase==='verifying') {
                batchCurrentFile.textContent='';
                batchCurrentFile.removeAttribute('title');
              } else if(info?.filename && copyJob.phase==='copying') {
                const filename=info.filename.trim().replace(/\/$/,'');
                batchCurrentFile.textContent='当前文件：'+shortenCopyName(filename.split('/').pop()||filename,90);
                batchCurrentFile.title=filename;
              }
              if(info?.eta) copyJob.eta=info.eta;
              renderBatchProgress();
            },control,async()=>copyItemCheckpoint(copyJob,i,'submission-intent','intent-saved'));
            if(outcome.moveOutcome==='merged-partial')
              copyJob.record.items[i].moveOutcome='merged-partial';
            await copyItemCheckpoint(copyJob,i,
              outcome.copyOutcome==='skipped'?'skipped':'success',
              outcome.copyOutcome==='skipped'?'not-submitted':'confirmed');
            row.moveOutcome=outcome.moveOutcome;
            row.status=outcome.copyOutcome==='skipped'?'skipped':'success';
            renderBatchRows();
            batch.currentPercent=null;
            renderBatchProgress();
          }
        }
        if(batch.phase!=='stopped') batch.phase='success';
      } catch(error) {
        batch.error=String(error?.message||error);
        const uncertain=control.cancelRequested ||
          batch.error.includes('结果不确定') || batch.error.includes('待核实') ||
          batch.error.includes('已请求取消');
        if(batch.nativeGroup) {
          const submitted=copyJob.record?.items.some(item=>item.submission!=='not-submitted');
          for(const row of batch.rows) {
            row.status=submitted?'uncertain':'failed';
            row.error=batch.error;
          }
          if(copyJob.record?.items) {
            for(const item of copyJob.record.items) {
              item.status=submitted?'uncertain':'failed';
              if(submitted)item.submission='unknown';
              item.updatedAt=Date.now();
            }
            copyJob.record.updatedAt=Date.now();
            await persistCopyQueue().catch(()=>{});
          }
          diagnosticLog('WARN','move.batch_reconcile',{
            taskId:copyJob.taskId,count:plans.length,
            status:submitted?'uncertain':'failed',submitted});
          renderBatchRows();
        } else if(batch.currentIndex>=0 && batch.rows[batch.currentIndex].status==='copying') {
          const row=batch.rows[batch.currentIndex];
          const record=copyJob.record?.items[batch.currentIndex];
          if(record) {
            const mayHaveSubmitted=record.submission!=='not-submitted';
            record.status=mayHaveSubmitted?'uncertain':'failed';
            if(mayHaveSubmitted)record.submission='unknown';
            record.updatedAt=Date.now();
            await persistCopyQueue().catch(()=>{});
          }
          row.status=uncertain?'uncertain':'failed';
          row.error=batch.error;
          renderBatchRows();
        }
        batch.phase=(uncertain || (batch.nativeGroup &&
          copyJob.record?.items.some(item=>item.submission!=='not-submitted')))?'uncertain':'failed';
        // A preflight error may have started no native task; it still cannot
        // automatically retry the batch or silently skip failed entries.
      } finally {
        clearInterval(batchMetricsTimer);
        batch.finished=true;
        busy=false;
        finalPhase=batch.phase;
        activeCopySession.phase=batch.phase;
        cancel.hidden=true;
        background.hidden=true;
        submit.hidden=false;
        submit.textContent='完成';
        submit.disabled=false;
        dismiss.title='关闭';
        renderBatchProgress();
        renderBatchRows();
        if(batch.view==='main') heading.textContent=(isMove?'移动结果':'复制结果');
        state.tree.delete(selected);
        if(isMove)state.tree.delete(parentPath(source));
        if(currentPath()===selected || (isMove && currentPath()===parentPath(source))) await refreshDirectory().catch(()=>{});
        else if(state.expanded.has(selected)) void loadTree(selected,true).catch(()=>{});
        updateCopyTaskButton();
      }
    }
    async function executeCopyJob() {
      if(multi) {
        await startBatchCopy();
        return;
      }
      if(busy || inlineDraft || mkdirUncertain || submit.disabled || !selected || nativeWriteBusy) {
        copyJob.phase='failed';
        copyJob.error='任务开始时写入资源不可用';
        return;
      }
      let plan;
      try {
        plan=planFileOperation({type:operation,source,destinationDir:selected,folder:entry.folder,
          conflictPolicy:copyJob.conflictPolicy});
        if(!copyDestinationAllowed(plan,selected)) throw new Error('不能选择源位置或文件夹自身内部');
      } catch(error) {
        setFeedback(String(error?.message||error),true);
        return;
      }
      busy=true;
      finalPhase='copying';
      activeCopySession=copyJob;
      copyJob.plan=plan;
      copyJob.phase='checking';
      copyJob.speed='';
      copyJob.speedUpdatedAt=0;
      updateCopyTaskButton();
      submit.disabled=true;
      cancel.disabled=false;
      cancel.textContent=(isMove?'取消移动':'取消复制');
      background.hidden=false;
      dismiss.disabled=false;
      dismiss.title='后台运行';
      submit.textContent=(isMove?'移动中…':'复制中…');
      progressTargetPath.textContent=plan.destinationDir;
      heading.textContent=(isMove?'正在移动':'正在复制');
      lastActiveCopyStep=0;
      showCopyFields(summary,progressPanel);
      // The selected folder button was removed; keep Esc available while
      // the native copy task runs and the modal switches to progress.
      focusDialog();
      renderCopyProgress('checking');
      const singleMetricsTimer=setInterval(()=>{
        if(!destroyed && !closed) renderSingleCopyMetrics();
      },1000);
      try {
        await copyItemCheckpoint(copyJob,0,'checking','not-submitted');
        const outcome=await (isMove?moveNativeEntry:copyNativeEntry)(plan,updateCopyProgress,control,
          async()=>copyItemCheckpoint(copyJob,0,'submission-intent','intent-saved'));
        if(outcome.moveOutcome==='merged-partial')
          copyJob.record.items[0].moveOutcome='merged-partial';
        await copyItemCheckpoint(copyJob,0,
          outcome.copyOutcome==='skipped'?'skipped':'success',
          outcome.copyOutcome==='skipped'?'not-submitted':'confirmed');
        if(closed || destroyed) return;
        finalPhase='success';
        heading.textContent=outcome.copyOutcome==='skipped'?'已忽略同名文件':
          outcome.moveOutcome==='merged-partial'?'文件夹已部分移动':
          (isMove?'移动完成':'复制完成');
        renderCopyProgress('success',outcome.copyOutcome==='skipped'?
          (isMove?'目标文件已存在，按「忽略」策略保留原文件，未提交移动请求。':'目标文件已存在，按「忽略」策略保留原文件，未提交复制请求。'):
          outcome.moveOutcome==='merged-partial'?
            '同名文件夹已合并，源目录仍有未转移的文件；请检查剩余项目，不会自动重做。':
          outcome.moveOutcome==='merged'||outcome.copyOutcome==='merged'?
            '同名文件夹已合并；内部同名文件按所选策略处理，目标独有文件保留。':
            (isMove?'移动结果已核对。':'复制结果已核对。'));
        if(outcome.moveOutcome==='merged-partial')
          progressStateText.textContent='部分移动 · 源目录有剩余';
        if(outcome.copyOutcome==='skipped') {
          progressStateText.textContent='已忽略同名文件';
          progressIndicator.textContent='已忽略';
        }
        activeCopySession.phase='success';
        updateCopyTaskButton();
        submit.textContent='完成';
        submit.disabled=false;
        cancel.hidden=true;
        background.hidden=true;
        dismiss.title='关闭';
        state.tree.delete(plan.destinationDir);
        if(isMove)state.tree.delete(parentPath(plan.source));
        if(currentPath()===plan.destinationDir || (isMove && currentPath()===parentPath(plan.source))) await refreshDirectory();
        else if(state.expanded.has(plan.destinationDir)) void loadTree(plan.destinationDir,true);
        notify((outcome.copyOutcome==='skipped'?'已忽略：':
          outcome.moveOutcome==='merged-partial'?'部分移动，源目录有剩余：':
          (isMove?'移动完成：':'复制完成：'))+
          fileName(plan.target)+'；点击「完成」关闭结果');
      } catch(error) {
        if(closed || destroyed) return;
        const message=String(error?.message||error);
        if(copyJob?.record?.items[0]) {
          const saved=copyJob.record.items[0];
          const mayHaveSubmitted=saved.submission!=='not-submitted';
          saved.status=mayHaveSubmitted?'uncertain':'failed';
          if(mayHaveSubmitted)saved.submission='unknown';
          saved.updatedAt=Date.now();
          await persistCopyQueue().catch(()=>{});
        }
        if(message.includes('结果不确定') || control.cancelRequested || message.includes('已请求取消')) {
          finalPhase=control.cancelRequested?'cancelled':'uncertain';
          heading.textContent=control.cancelRequested?(isMove?'移动已请求停止':'复制已请求停止'):(isMove?'移动结果待核实':'复制结果待核实');
          renderCopyProgress('uncertain',message);
          activeCopySession.phase=finalPhase;
          updateCopyTaskButton();
          submit.textContent=(isMove?'请核实移动状态':'请核实复制状态');
          submit.disabled=true;
          cancel.textContent='关闭';
          background.hidden=true;
          dismiss.title='关闭';
        } else {
          // Preflight failures happened without a native write. Let the user
          // choose another destination and retry from the original picker.
          heading.textContent=(isMove?'移动到':'复制到');
          finalPhase='picker';
          copyJob.phase='failed';
          copyJob.error=message;
          copyJob.recoverable=true;
          copyJob.preflightRejected=true;
          updateCopyTaskButton();
          background.hidden=true;
          cancel.textContent='取消';
          showCopyFields(summary,location);
          showPreflightError(error,[]);
          updateCopyTaskButton();
        }
      } finally {
        clearInterval(singleMetricsTimer);
        busy=false;
        if(copyJob) copyJob.phase=finalPhase==='picker'?'failed':finalPhase;
        if(dialog.isConnected) {
          cancel.disabled=false;
          dismiss.disabled=false;
          if(finalPhase==='picker') {
            submit.textContent=(isMove?'开始移动':'开始复制');
            submit.disabled=!selected;
          } else if(finalPhase==='success') {
            submit.textContent='完成';
            submit.disabled=false;
          }
          if(fields.contains(location)) renderPicker();
        }
      }
    }
    let enqueuePending=false;
    async function submitCopyJob() {
      const blocked=closed?'closed':destroyed?'destroyed':busy?'busy':
        enqueuePending?'enqueue-pending':batch?.preflighting?'preflight':
        inlineDraft?'inline-mkdir':mkdirUncertain?'mkdir-uncertain':
        prefillPending?'target-loading':!selected?'no-destination':
        submit.disabled?'submit-disabled':null;
      if(blocked){
        logMoveDialog('dialog.move_submit_blocked',{reason:blocked});
        if(isMove && !closed && !destroyed && dialog.isConnected)
          setFeedback(blocked==='target-loading'?'正在确认拖放目标，请稍候…':
            blocked==='no-destination'?'请先选择目标文件夹。':
            '暂时无法提交移动任务，请稍后重试（'+blocked+'）。',true);
        return;
      }
      if(copyJob && copyJob.status!=='failed') {
        logMoveDialog('dialog.move_submit_blocked',{reason:'existing-job'});
        return;
      }
      if(copyJob && copyJob.status==='failed') removeCopyJob(copyJob);
      if(isMove && conflictPolicy==='overwrite' &&
          !window.confirm('覆盖移动将替换目标中的同名普通文件，旧文件内容无法恢复。\n\n同名文件夹会合并并覆盖内部同名文件；目标独有文件保留。确认继续？'))
        return;
      try {
        const plans=entries.map(item=>planFileOperation({type:operation,
          source:item.path,destinationDir:selected,folder:item.folder,conflictPolicy}));
        if(!copyDestinationAllowedForAll(selected) ||
          new Set(plans.map(plan=>plan.target)).size!==plans.length)
          throw new Error('目标位置无效或存在重复目标名称');
      } catch(error) {
        logMoveDialog('dialog.move_submit_rejected',{reason:String(error?.message||error)});
        setFeedback(String(error?.message||error),true);return;
      }
      // Obtain the durable queue lease BEFORE replacing the picker with an
      // "已加入队列" screen. A denied claim must leave the modal unchanged.
      copyOwnerReservations++;
      try {
        enqueuePending=true;
        submit.disabled=true;
        submit.textContent='正在检查队列…';
        try {
          await initializeCopyPersistence();
          if(persistenceError || copyRecoveryLocked)
            throw new Error(persistenceError||'请先处理恢复的队列任务');
          await ensureCopyOwnership();
          await copyPersistTail;
          const fresh=await persistentCopyStore.read();
          if(JSON.stringify(fresh?.tasks||[])!==lastPersistedTasks)
            throw new Error('队列记录已变更，请刷新页面核实，禁止覆盖');
        } catch(error) {
          logMoveDialog('dialog.move_enqueue_failed',{reason:String(error?.message||error),stage:'lease'});
          setFeedback((isMove?'未开始移动：':'未开始复制：')+
            String(error?.message||error),true);
          return;
        } finally {
          enqueuePending=false;
          if(!closed && dialog.isConnected && finalPhase==='picker') {
            submit.disabled=!selected;
            submit.textContent=isMove?'开始移动':'开始复制';
          }
        }
      if(closed || destroyed || !dialog.isConnected)return;
      logMoveDialog('dialog.move_submit',{target:selected});
      const name=multi?entries[0].name+' 等 '+entries.length+' 项':entry.name;
      const record=newCopyRecord(entries,selected,conflictPolicy,name,operation);
      copyJob={
        dialog,reopen,execute:executeCopyJob,record,taskId:record.taskId,
        prepare:()=>{submit.hidden=false;submit.disabled=false;},
        cancelQueued:()=>{
          if(copyJob?.status!=='queued') return;
          const job=copyJob;
          job.status='removed';
          removeCopyJob(job);
          copyJob=null;closed=true;++requestVersion;overlay.remove();restoreFocus();
        },
        name,destination:selected,conflictPolicy,count:entries.length,
        batch,percent:null,plan:null,error:''
      };
      heading.textContent=(isMove?'等待移动':'等待复制');
      const waiting=element('div','ufs-batch-panel');
      waiting.append(element('strong','',(isMove?'已加入移动队列':'已加入复制队列')),
        element('div','ufs-batch-meta',(isMove?'等待前面的移动任务完成后自动开始。':'等待前面的复制任务完成后自动开始。')),
        element('div','ufs-batch-meta','目标：'+selected));
      fields.replaceChildren(waiting);
      submit.hidden=true;
      submit.disabled=true;
      cancel.hidden=false;
      cancel.disabled=false;
      cancel.textContent='取消排队';
      background.hidden=false;
      dismiss.title='后台运行';
      enqueuePending=true;
      // Nothing can be minimized/cancelled until the IndexedDB transaction
      // commits, otherwise the UI could disappear before the task exists.
      cancel.disabled=true;
      dismiss.disabled=true;
      background.disabled=true;
      try {
        await registerCopyJob(copyJob);
      } catch(error) {
        logMoveDialog('dialog.move_enqueue_failed',{reason:String(error?.message||error)});
        if(copyJob && copyJobs.includes(copyJob)) copyJobs.splice(copyJobs.indexOf(copyJob),1);
        copyJob=null;
        fields.replaceChildren(summary,location);
        cancel.textContent='取消';
        submit.hidden=false;
        submit.disabled=false;
        background.hidden=true;
        if(!closed && !dialog.isConnected) app.append(overlay);
        setFeedback('未加入队列：'+String(error?.message||error),true);
        updateCopyTaskButton();
      } finally {
        enqueuePending=false;
        cancel.disabled=false;
        dismiss.disabled=false;
        background.disabled=false;
      }
      } finally {
        copyOwnerReservations--;
        void releaseIdleCopyOwnership('submission-settled');
      }
    }
    form.addEventListener('submit',event=>{
      event.preventDefault();
      if(multi && batch?.finished) {close('completed');return;}
      if(!multi && (finalPhase==='success'||finalPhase==='uncertain'||
          finalPhase==='cancelled')) {close('completed');return;}
      void submitCopyJob();
    });
    if(requestedDestination) {
      submit.disabled=true;
      submit.textContent='正在确认目标…';
      setFeedback('正在确认拖放目标，请稍候…');
      logMoveDialog('dialog.move_target_loading',{target:requestedDestination});
      // Verify ancestors and the destination before enabling submission.
      // A manual picker choice takes precedence over this async preselection.
      void (async()=>{
        try{
          if(!copyDestinationAllowedForAll(requestedDestination) ||
             !safeWritePath(requestedDestination,true))
            throw new Error('拖放目标不安全');
          const parents=[];
          let at=requestedDestination;
          while(at!==PREFIX && at.startsWith(PREFIX+'/')){
            parents.unshift(at);at=parentPath(at);
          }
          await loadChildren(PREFIX);
          for(const child of parents){
            if(closed || destroyed || prefillOverridden)return;
            const upstream=nodes.get(parentPath(child));
            if(!upstream?.some(item=>item.path===child && item.folder &&
                item.copyPathVerified!==false))
              throw new Error(prefillLoadError||'拖放目标已发生变化');
            opened.add(child);
            await loadChildren(child);
          }
          if(closed || destroyed || prefillOverridden)return;
          if(!nodes.has(requestedDestination))
            throw new Error(prefillLoadError||'目标文件夹尚未成功读取');
          selected=requestedDestination;
          destinationText.textContent='目标：'+selected;
          destinationText.title=selected;
          prefillPending=false;
          submit.textContent='开始移动';
          submit.disabled=false;
          setFeedback('目标已确认，可以开始移动。');
          logMoveDialog('dialog.move_target_ready',{target:selected});
          renderPicker();
          picker.querySelector('.ufs-copy-tree-row.ufs-copy-selected')?.scrollIntoView({block:'nearest'});
        }catch(error){
          if(closed || destroyed || prefillOverridden)return;
          prefillPending=false;
          submit.disabled=true;
          submit.textContent='开始移动';
          setFeedback('无法确认拖放目标，请手动重新选择文件夹：'+String(error?.message||error),true);
          diagnosticLog('WARN','dialog.move_target_failed',{reason:String(error?.message||error)});
          renderPicker();
        }
      })();
    } else void loadChildren(PREFIX);
  }


  // Permanent deletion intentionally has a separate confirmation from the copy/move picker.
  function showDeleteDialog(input) {
    const entries=(Array.isArray(input)?input:[input]).filter(Boolean).map(item=>({...item}));
    if(!DELETE_ENABLED || !entries.length || destroyed || state.busy ||
       $('.ufs-dialog-overlay',app) || document.querySelector('.ufs-diagnostic-overlay') ||
       entries.some(item=>!safeWritePath(item.path)||item.copyPathVerified===false||
         parentPath(item.path)!==currentPath()))return;
    const parent=currentPath(),opener=document.activeElement;
    const overlay=element('div','ufs-dialog-overlay');
    const dialog=element('div','ufs-create-dialog ufs-delete-dialog');
    dialog.tabIndex=-1;
    dialog.setAttribute('role','dialog');
    dialog.setAttribute('aria-modal','true');
    dialog.setAttribute('aria-label','永久删除所选项目');
    const header=element('div','ufs-create-head');
    header.append(element('h3','','永久删除所选项目'));
    const dismiss=element('button','ufs-create-dismiss');
    dismiss.type='button';dismiss.setAttribute('aria-label','关闭删除窗口');
    dismiss.append(icon('close'));header.append(dismiss);
    const form=element('form','ufs-create-form');
    const body=element('div','ufs-create-fields');
    body.append(element('strong','','将永久删除 '+entries.length+' 个项目'));
    const list=element('div','ufs-delete-list');
    for(const item of entries){
      const row=element('div','ufs-batch-preview-row');
      row.append(icon(item.folder?'folder':'file'),element('span','',item.name));
      list.append(row);
    }
    body.append(list);
    const warning=element('div','ufs-delete-warning');
    warning.append(icon('alert-circle'),element('span','',
      '原生永久删除不会进入回收站。文件夹及其中所有内容将被直接删除，无法通过 File Station 撤销。'));
    body.append(warning);
    const needConfirm=entries.length>1||entries.some(item=>item.folder);
    const acknowledge=element('label','ufs-delete-acknowledge');
    const check=element('input');check.type='checkbox';check.checked=false;
    if(needConfirm){
      acknowledge.append(check,element('span','','我已了解永久删除的后果'));
      body.append(acknowledge);
    }
    const feedback=element('div','ufs-create-feedback');
    feedback.setAttribute('role','status');body.append(feedback);
    const footer=element('div','ufs-create-buttons');
    const cancel=element('button','ufs-create-cancel','取消');
    cancel.type='button';
    const submit=element('button','ufs-create-submit ufs-delete-submit','永久删除');
    submit.type='submit';submit.disabled=needConfirm;
    footer.append(cancel,submit);
    form.append(body,footer);dialog.append(header,form);
    overlay.append(dialog);app.append(overlay);
    setupListScrollbars(body);setupListScrollbars(list);
    dialog.focus({preventScroll:true});
    let job=null,closed=false,enqueuePending=false,stopAfterCurrent=false;
    const restore=()=>{
      const target=opener?.isConnected&&app.contains(opener)?opener:$('.ufs-list',app);
      target?.focus({preventScroll:true});
    };
    const close=()=>{
      if(enqueuePending)return;
      if(job && ['queued','running'].includes(job.status) && !['success','stopped'].includes(job.phase)){
        overlay.remove();restore();return;
      }
      closed=true;overlay.remove();
      if(job?.status==='success')removeCopyJob(job);
      restore();
    };
    dismiss.addEventListener('click',close);
    cancel.addEventListener('click',()=>{
      if(job?.status==='queued'){
        job.status='removed';removeCopyJob(job);
        closed=true;overlay.remove();restore();return;
      }
      if(job?.status==='running'){
        stopAfterCurrent=true;
        cancel.disabled=true;
        feedback.textContent='当前项目完成后停止后续队列，已经永久删除的内容无法撤销。';
        return;
      }
      close();
    });
    overlay.addEventListener('click',event=>{if(event.target===overlay)close();});
    dialog.addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}
    });
    check.addEventListener('change',()=>{if(!job)submit.disabled=!check.checked;});
    const renderProgress=(message,phase='')=>{
      if(closed||destroyed)return;
      feedback.textContent=message;
      if(phase)dialog.dataset.phase=phase;
    };
    async function executeDeleteJob(){
      let completed=0;
      submit.hidden=true;cancel.textContent='当前项完成后停止';cancel.disabled=false;
      for(let i=0;i<entries.length;i++){
        if(stopAfterCurrent){job.phase='stopped';break;}
        const item=entries[i],saved=job.record.items[i];
        const plan=planFileOperation({type:'delete',source:item.path,folder:item.folder});
        try{
          await copyItemCheckpoint(job,i,'checking','not-submitted');
          renderProgress('正在删除第 '+(i+1)+' / '+entries.length+' 项：'+item.name,'checking');
          await deleteNativeEntry(plan,(message,phase)=>{
            copyJobSignal(job,phase);
            renderProgress(message||'删除中…',phase);
          },{},async()=>copyItemCheckpoint(job,i,'submission-intent','intent-saved'));
          await copyItemCheckpoint(job,i,'success','confirmed');
          completed++;
          renderProgress('已永久删除 '+completed+' / '+entries.length+' 项','copying');
          state.tree.delete(parent);
          if(currentPath()===parent)await refreshDirectory().catch(()=>{});
        }catch(error){
          const sent=saved.submission!=='not-submitted';
          saved.status=sent?'uncertain':'failed';
          if(sent)saved.submission='unknown';
          saved.updatedAt=Date.now();
          await persistCopyQueue().catch(()=>{});
          job.phase=sent?'uncertain':'failed';
          job.error=String(error?.message||error);
          renderProgress((sent?'删除结果待核实：':'未开始删除：')+job.error,job.phase);
          cancel.textContent='关闭窗口';
          submit.hidden=true;
          throw error;
        }
      }
      if(job.phase!=='stopped')job.phase='success';
      if(!closed){
        renderProgress(job.phase==='stopped'?
          '已停止后续任务，已永久删除 '+completed+' 项。':
          '永久删除完成，共 '+completed+' 项。',job.phase);
        submit.hidden=false;submit.textContent='完成';submit.disabled=false;
        cancel.textContent='关闭';cancel.disabled=false;
      }
    }
    const reopen=()=>{
      if(!closed&&!destroyed&&!$('.ufs-dialog-overlay',app)&&
         !document.querySelector('.ufs-diagnostic-overlay')){
        app.append(overlay);dialog.focus({preventScroll:true});
      }
    };
    form.addEventListener('submit',event=>{
      event.preventDefault();
      if(closed||enqueuePending)return;
      if(job && ['success','stopped'].includes(job.phase)){close();return;}
      if(job)return;
      if(needConfirm&&!check.checked)return;
      void (async()=>{
        enqueuePending=true;submit.disabled=true;cancel.disabled=true;dismiss.disabled=true;
        try{
          // A fresh entire-batch preflight is read-only; item execution repeats its own checks.
          const fresh=await listDirectory(parent);
          for(const item of entries){
            const found=fresh.find(x=>x.path===item.path);
            if(!found || found.folder!==item.folder || found.copyPathVerified===false)
              throw new Error('待删除项目已变化，请刷新后重新选择：'+item.name);
          }
          if(await readNativeActive())
            throw new Error('Unraid 正在执行其他原生文件任务');
          copyOwnerReservations++;
          try {
            // A denied or stale lease must not switch delete to "已加入队列".
            await initializeCopyPersistence();
            if(persistenceError || copyRecoveryLocked)
              throw new Error(persistenceError||'请先处理恢复的队列任务');
            await ensureCopyOwnership();
            await copyPersistTail;
            const freshSnapshot=await persistentCopyStore.read();
            if(JSON.stringify(freshSnapshot?.tasks||[])!==lastPersistedTasks)
              throw new Error('队列记录已变更，请刷新页面核实，禁止覆盖');
          const name=entries.length===1?entries[0].name:
            entries[0].name+' 等 '+entries.length+' 项';
          const record=newCopyRecord(entries,parent,'fail',name,'delete');
          job={
            record,taskId:record.taskId,name,destination:parent,
            conflictPolicy:'fail',count:entries.length,percent:null,
            reopen,execute:executeDeleteJob,prepare:()=>{},
            cancelQueued:()=>{
              if(job?.status!=='queued')return;
              job.status='removed';removeCopyJob(job);
              closed=true;overlay.remove();restore();
            }
          };
          renderProgress('已加入删除队列，等待前面的文件任务执行完毕。','queued');
          cancel.textContent='取消排队';
          await registerCopyJob(job);
          } finally {
            copyOwnerReservations--;
            void releaseIdleCopyOwnership('delete-submission-settled');
          }
        }catch(error){
          if(job&&!copyJobs.includes(job))job=null;
          renderProgress('未提交删除：'+String(error?.message||error),'failed');
        }finally{
          enqueuePending=false;
          dismiss.disabled=false;cancel.disabled=false;
          if(!job)submit.disabled=needConfirm&&!check.checked;
        }
      })();
    });
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
      ['诊断中心（导出日志）', showDiagnosticCenter],
      ['重置文件列表列宽', resetColumnWidths],
      ['返回原生文件管理器（其他写入操作）', nativeMode],
      [state.theme === 'unraid' ? '切换至 DSM 经典主题' : '切换至 Unraid 融合主题', toggleTheme],
      ['关于 File Station v'+DIAGNOSTIC_VERSION, () => notify('File Station v'+DIAGNOSTIC_VERSION+' · 浏览器诊断日志与安全导出')]
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
      '<button type="button" class="ufs-ico ufs-refresh" title="刷新" aria-label="刷新目录"><span data-ufs-icon="rotate-cw"></span></button>',
      '<button type="button" class="ufs-ico ufs-diagnostic-button" title="诊断日志" aria-label="诊断日志"><span data-ufs-icon="scroll-text"></span></button>',
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
      '<button type="button" class="ufs-ico ufs-create-trigger" title="新建文件夹" aria-label="新建文件夹">新建文件夹</button>',
       '<button type="button" class="ufs-ico ufs-operations" title="文件操作" aria-label="文件操作" aria-haspopup="menu" aria-expanded="false">操作 <span data-ufs-icon="chevron-down"></span></button>',
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
      '<span class="ufs-status-hint">支持新建、重命名、复制、移动与删除</span>',
      '<button type="button" class="ufs-copy-task-trigger" title="查看复制任务" hidden>复制任务进行中</button></div>'
    ].join('');
    $$('[data-ufs-icon]', app).forEach((placeholder) => {
      placeholder.replaceWith(icon(placeholder.dataset.ufsIcon,
        placeholder.classList.contains('ufs-mark') ? 'ufs-mark' : ''));
    });
    $('.ufs-refresh', app).addEventListener('click', refreshDirectory);
    $('.ufs-more', app).addEventListener('click', showAppMenu);
    $('.ufs-diagnostic-button', app).addEventListener('click',showDiagnosticCenter);
    $('.ufs-copy-task-trigger', app).addEventListener('click',()=>showCopyTaskCenter());
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
    // Address width changes when the viewport, sidebar, or search area changes.
    const breadcrumbAddress = $('.ufs-address', app);
    if (typeof ResizeObserver !== 'undefined') {
      const breadcrumbObserver = new ResizeObserver(scheduleBreadcrumbLayout);
      breadcrumbObserver.observe(breadcrumbAddress);
      onCleanup(() => breadcrumbObserver.disconnect());
    }
    window.addEventListener('resize', scheduleBreadcrumbLayout, { signal: lifecycle.signal });
    installDragMove();
    onCleanup(setupListScrollbars($('.ufs-list', app)));
    onCleanup(()=>closeCopyTaskCenter());
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
      const center=$('.ufs-copy-task-center',app);
      const trigger=$('.ufs-copy-task-trigger',app);
      if(center && !center.contains(event.target) && !trigger?.contains(event.target))
        closeCopyTaskCenter(center.contains(document.activeElement));
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
      if(event.key==='Escape' && $('.ufs-copy-task-center',app)) {
        event.preventDefault();event.stopPropagation();
        closeCopyTaskCenter(true);
        return;
      }
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
    const initialNative = !isDemo && localStorage.getItem(STORE+'native')==='1';
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
    if (!isDemo) {
      nativeControls=element('div','');
      nativeControls.id='ufs-native-controls';
      const button=element('button','','打开 File Station');
      button.id='ufs-native-enable';
      button.type='button';
      button.addEventListener('click',()=>switchFileManager('file-station'));
      nativeReadonlyNote=element('span','','文件任务未结束：原生文件操作暂为只读。');
      nativeReadonlyNote.id='ufs-native-readonly-note';
      nativeRefreshNote=element('span','','');
      nativeRefreshNote.id='ufs-native-refresh-note';
      nativeRefreshNote.hidden=true;
      nativeRefreshRetry=element('button','','重试目录更新');
      nativeRefreshRetry.id='ufs-native-refresh-retry';
      nativeRefreshRetry.type='button';
      nativeRefreshRetry.hidden=true;
      nativeRefreshRetry.addEventListener('click',()=>void refreshNativeListIfNeeded());
      const diagnosticButton=element('button','','诊断日志');
      diagnosticButton.type='button';
      diagnosticButton.addEventListener('click',showDiagnosticCenter);
      nativeControls.append(button,diagnosticButton,nativeReadonlyNote,nativeRefreshNote,nativeRefreshRetry);
      native.parentNode.insertBefore(nativeControls,native);
      onCleanup(()=>nativeRefreshController?.abort());
      // Capturing on window precedes native document/body event listeners.
      for(const type of ['click','pointerdown','contextmenu','dblclick','keydown']) {
        window.addEventListener(type,guardNativeInteraction,
          {capture:true,signal:lifecycle.signal});
      }
    }
    switchFileManager(initialNative?'native':'file-station');
    startDiagnosticMonitoring();
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
    void initializeCopyPersistence();
    void initializeBrowser(start);
    nativeLifecycleOnMount();
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
          if (!localWriteInProgress()) {
            markNativeListDirty();
            scheduleLocalRefresh();
          }
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
    window.__UFS_TEST_API__ = { diagnosticSanitize, diagnosticScrub, diagnosticLog,
    diagnosticReadAll, diagnosticSnapshot, diagnosticMarkIssue, diagnosticSetVerbose,
    diagnosticIsVerbose, normalizeSavedCopyItem, normalizeSavedCopyTask, validateCopyQueueSnapshot, copyRecoveryAssessment, createCopyQueueStore, currentCopySpeed, copyJobPhaseLabel, copyJobStatusLabel, copyJobMeta, findBatchCopyConflicts, findBatchCopyTypeConflicts, batchCopyOverallProgress, safePath, formatSize, encodeFileUrl, parseBrowse, extractLocations, locationNames, fitLocationNames, renderLocationTags, listDirectory, safeWriteName, safeWritePath, planFileOperation, previewNativeOperationRequest, createFileOperationCoordinator, FILE_WRITES_ENABLED, CREATE_FOLDER_ENABLED, RENAME_ENABLED, COPY_ENABLED, MOVE_ENABLED, DELETE_ENABLED, matchesMoveTask, matchesDeleteTask, deleteNativeEntry, moveNativeEntry, parseNativeActive, matchesCreateTask, matchesRenameTask, renameSelectionEnd, remapPathPrefix, resolveRenamedFolderPath, applyRenameToBrowser, createNativeFolder, renameNativeEntry, nativeCopyTarget, matchesCopyTask, copyDestinationAllowed, copyNativeEntry, copyTaskSignature, findUnfinishedDuplicate, decodeRsyncFilename, parseRsyncProgress, shortenCopyName, requestCancelNativeCopy, takeOverNativeFileMonitor, availableHeight, visibleEntries, sortedCopyFolders, safeCopyName, safeCopyPath, copyBlockedReason, selectedEntries, breadcrumbDisplayPaths, renderHeaderMarkup, renderBrowserBarMarkup, renderFileActionsMarkup, renderWorkspaceMarkup, COLUMNS, clampColumnWidth, readColumnWidths, columnLayout, inspectListScrollMetrics, virtualWindow, virtualGridColumns, firstSharePath, defaultSharePath, isShareRoot, selectionStatus, updateSelection, shouldSuppressTextSelection, state };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin, { once: true });
  else begin();
})();
