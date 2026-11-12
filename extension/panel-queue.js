'use strict';
// 视频课件逐项选择和队列设置；两个开始入口都按点击时冻结的清单直接启动。
(function () {
  const get = id => document.getElementById(id);
  const taskData = globalThis.XiaoyaTaskData;
  const DEFAULTS = { rate: 2, background: true, muted: true, recursive: true, autoNext: true };
  const SWITCHES = { background: 'optBackground', muted: 'optMuted', autoNext: 'optAutoNext' };
  const RATES = [1, 1.25, 1.5, 2];
  const startButtons = [...document.querySelectorAll('[data-queue-start]')];
  const stopButtons = [...document.querySelectorAll('[data-queue-stop]')];
  const statusLabels = [...document.querySelectorAll('[data-queue-status]')];
  const countLabels = [...document.querySelectorAll('[data-queue-count]')];
  let options = { ...DEFAULTS };
  let starting = false;
  let selectionAccount = state.account;
  let selected = new Map();
  let aggressive = false;
  let pendingAggressiveOptIn = false;

  const activeTabId = async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  const readState = () => chrome.storage.session.get(['xiaoyaRun', 'xiaoyaPendingScan']);
  const saveOptions = () => chrome.storage.local.set({ options });
  const setStatus = status => statusLabels.forEach(label => { label.textContent = status; });
  const setMessage = (message, context = null) => document.querySelectorAll('[data-video-message]').forEach(label => {
    const labelContext = label.closest('#videoActions') ? 'quick' : 'settings';
    label.textContent = !context || context === labelContext ? message : '';
  });
  const escapeHtml = value => String(value ?? '').replace(/[&<>\"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const isMedia = task => Number(task?.typeCode) === 1 || task?.type === '视频课件';
  const mediaTarget = task => {
    if (typeof taskData?.mediaTarget !== 'function') return null;
    const target = taskData.mediaTarget(task);
    return target?.id === undefined || target?.id === null || target.id === '' ? null : { ...target, id: String(target.id) };
  };
  const mediaTasks = () => state.tasks.filter(isMedia);
  const allRouteKey = task => {
    const courseId = task?.courseId;
    const nodeId = task?.nodeId;
    return courseId !== null && courseId !== undefined && nodeId !== null && nodeId !== undefined
      ? JSON.stringify([String(courseId), String(nodeId)])
      : null;
  };
  const currentFilters = () => model.visibleTasks(state.tasks, filters(), Date.now());
  const visibleMedia = () => currentFilters().filter(isMedia);
  const routeCounts = () => {
    const counts = new Map();
    for (const task of mediaTasks()) {
      const key = allRouteKey(task);
      if (key !== null) counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  };
  const idCounts = () => {
    const counts = new Map();
    for (const task of mediaTasks()) {
      const target = mediaTarget(task);
      if (target) counts.set(target.id, (counts.get(target.id) || 0) + 1);
    }
    return counts;
  };

  function taskProblem(task, routes = routeCounts(), ids = idCounts()) {
    const target = mediaTarget(task);
    const platformProblem = typeof taskData?.mediaProblem === 'function'
      ? String(taskData.mediaProblem(task, Date.now()) || '')
      : '暂时无法核对任务状态';
    if (platformProblem) return platformProblem;
    if (!target) return '缺少可唯一定位的任务标识';
    const routeKey = allRouteKey(task);
    if (routeKey !== null && routes.get(routeKey) > 1) return '课程和节点标识重复，暂不能单独选择';
    if (ids.get(target.id) > 1) return '任务标识重复，暂不能单独选择';
    if (!state.account) return '请先登录小雅并刷新任务';
    return '';
  }

  function syncSelection() {
    if (state.account !== selectionAccount) {
      selected.clear();
      selectionAccount = state.account;
    }
  }

  function selectedRows() {
    const routes = routeCounts();
    const ids = idCounts();
    const visibleIds = new Set(visibleMedia().map(task => mediaTarget(task)?.id).filter(Boolean));
    const rowsById = new Map();
    for (const task of mediaTasks()) {
      const target = mediaTarget(task);
      if (!target) continue;
      const rows = rowsById.get(target.id) || [];
      rows.push(task);
      rowsById.set(target.id, rows);
    }
    return [...selected.entries()].map(([id, savedTarget]) => {
      const rows = rowsById.get(id) || [];
      const task = rows.length === 1 ? rows[0] : null;
      const target = task ? mediaTarget(task) : savedTarget;
      const changed = target && Object.keys(savedTarget).some(key => savedTarget[key] !== target[key]);
      const problem = rows.length === 0 ? '任务已不在当前列表中，请刷新任务后重新选择'
        : rows.length > 1 ? '任务标识重复，暂不能单独选择'
          : changed ? '任务身份或名称已变化，请重新选择'
          : taskProblem(task, routes, ids);
      return { id, target: savedTarget, task, problem, hidden: !visibleIds.has(id) };
    });
  }

  function renderCheckbox(task) {
    if (!isMedia(task)) return '';
    const target = mediaTarget(task);
    const id = target?.id;
    const checked = Boolean(id && selected.has(id));
    const problem = taskProblem(task);
    const label = problem ? `暂不可选择：${problem}：${task.name}` : `选择视频课件：${task.name}`;
    const identity = id ? `data-video-id="${escapeHtml(id)}"` : '';
    return `<input class="video-check" type="checkbox" ${identity} data-video-task="${escapeHtml(task.id)}" data-key="v-${escapeHtml(task.id)}" aria-label="${escapeHtml(label)}" title="${escapeHtml(problem || task.name)}" ${checked ? 'checked' : ''} ${problem || isLocked() ? 'disabled' : ''}>`;
  }

  function isLocked() { return starting || Boolean(activeRun?.enabled || activePending); }
  let activeRun = null;
  let activePending = null;

  function renderOptions() {
    Object.entries(SWITCHES).forEach(([key, id]) => { get(id).checked = options[key]; });
    RATES.forEach((rate, index) => {
      const button = document.querySelector(`[data-rate="${rate}"]`);
      button.setAttribute('aria-pressed', options.rate === rate);
      if (options.rate === rate) moveThumb(get('rate'), index);
    });
  }

  function renderSelection() {
    syncSelection();
    const visibleIds = new Set(visibleMedia().map(task => mediaTarget(task)?.id).filter(Boolean));
    const hidden = [...selected.keys()].filter(id => !visibleIds.has(id)).length;
    const locked = isLocked();
    get('videoActions').hidden = state.chip !== 'media' && !selected.size;
    get('videoAll').hidden = state.chip !== 'media';
    get('videoSelected').textContent = `已选 ${selected.size} 项${hidden ? `（筛选外 ${hidden} 项）` : ''}`;
    get('videoAll').disabled = locked || !state.account || !visibleMedia().some(task => !taskProblem(task));
    get('videoClear').disabled = locked || !selected.size;
    startButtons.forEach(button => { button.disabled = locked || !selected.size || !state.account; });
    stopButtons.forEach(button => { button.disabled = !activeRun?.enabled && !activePending; });
    get('optAggressive').checked = aggressive;
    get('optAggressive').disabled = locked;
    get('gear').classList.toggle('running', Boolean(activeRun?.enabled));
    document.querySelectorAll('[data-video-id]').forEach(input => {
      input.checked = selected.has(input.dataset.videoId);
      input.disabled = locked || !state.account || Boolean(taskForRow(input.dataset.videoTask) && taskProblem(taskForRow(input.dataset.videoTask)));
    });
  }

  function taskForRow(id) { return state.tasks.find(task => String(task.id) === String(id)); }

  async function render() {
    syncSelection();
    const stored = await readState();
    activeRun = stored.xiaoyaRun || null;
    activePending = stored.xiaoyaPendingScan || null;
    const tabId = await activeTabId();
    let status = activeRun ? `${activeRun.tabId !== tabId ? '小雅后台运行：' : ''}${activeRun.status || '等待页面响应…'}` : '尚未开始';
    if (activePending) status = activePending.status;
    const running = Boolean(activeRun?.enabled);
    const current = activeRun?.current || activeRun?.selection?.[activeRun?.selectionIndex];
    if (running && current?.name && !String(status).includes(current.name)) status = `${status} · ${current.name}`;
    if (running && activeRun?.options?.aggressive) status = `激进模式 · ${status}`;
    setStatus(starting ? '正在启动所选队列…' : status);
    const total = activeRun?.selection?.length || 0;
    const completed = activeRun?.completed?.length || 0;
    countLabels.forEach(label => { label.textContent = total ? `已完成 ${completed}/${total} 项` : `已完成 ${completed} 项`; });
    get('queueLogs').replaceChildren(...(activeRun?.logs || []).slice(-6).reverse().map(entry => {
      const item = document.createElement('li');
      item.textContent = `${new Date(entry.time).toLocaleTimeString('zh-CN')} ${entry.text}`;
      return item;
    }));
    renderSelection();
  }

  async function startQueue(context) {
    syncSelection();
    if (starting || isLocked()) return;
    setMessage('');
    const account = state.account;
    const ids = [...selected.keys()];
    if (!account) { setMessage('请先登录小雅并刷新任务。', context); return; }
    if (!ids.length) return;

    // Freeze the checked IDs, canonical targets and options synchronously at the click.
    const rowsById = new Map(selectedRows().map(row => [row.id, row]));
    const rows = ids.map(id => rowsById.get(id)).filter(Boolean);
    const issues = rows.filter(row => row.problem || !row.target);
    if (rows.length !== ids.length || issues.length) {
      const details = issues.map(row => `${row.target?.name || row.task?.name || '所选项目'}：${row.problem || '缺少可定位的任务身份'}`);
      if (rows.length !== ids.length) details.push('所选清单已变化，请刷新任务后重新选择。');
      setMessage(details.join('\n') || '所选清单已变化，请刷新任务后重新选择。', context);
      return;
    }
    const selection = rows.map(row => ({ ...row.target }));
    const requestOptions = { ...options, aggressive };
    starting = true;
    setMessage('正在向后台核对账号和所选任务…', context);
    renderSelection();
    try {
      const tabId = await activeTabId();
      const result = await chrome.runtime.sendMessage({ type: 'start-selected', tabId, account, selection, options: requestOptions });
      if (result?.error) throw new Error(result.error);
      if (!result?.ok) throw new Error('后台未确认请求，请到浏览器扩展管理页重新加载“小雅刷课助手”后再试。');
      setMessage('', context);
    } catch (error) {
      setMessage(error.message, context);
    } finally {
      starting = false;
      await render();
    }
  }

  async function stopQueue() {
    const stored = await readState();
    await chrome.runtime.sendMessage({ type: 'stop', tabId: stored.xiaoyaPendingScan?.tabId ?? stored.xiaoyaRun?.tabId ?? await activeTabId() });
    await render();
  }

  buildSeg(get('rate'), RATES.map(rate => `<button data-rate="${rate}">${rate}x</button>`).join(''), RATES.length);
  get('rate').addEventListener('click', event => {
    const button = event.target.closest('[data-rate]');
    if (!button) return;
    options.rate = Number(button.dataset.rate);
    saveOptions();
    renderOptions();
  });
  Object.entries(SWITCHES).forEach(([key, id]) => get(id).addEventListener('change', event => {
    options[key] = event.target.checked;
    saveOptions();
  }));

  globalThis.XiaoyaPanelVideo = { checkbox: renderCheckbox, render, busy: isLocked };
  get('list').addEventListener('change', event => {
    const input = event.target.closest('[data-video-id]');
    if (!input || isLocked()) return;
    const task = taskForRow(input.dataset.videoTask);
    const target = task && mediaTarget(task);
    if (input.checked && target && !taskProblem(task)) selected.set(target.id, target);
    else if (!input.checked && input.dataset.videoId) selected.delete(input.dataset.videoId);
    renderList(false);
  });
  get('videoAll').addEventListener('click', () => {
    if (isLocked() || !state.account) return;
    for (const task of visibleMedia()) {
      if (taskProblem(task)) continue;
      const target = mediaTarget(task);
      if (target) selected.set(target.id, target);
    }
    renderList(false);
  });
  get('videoClear').addEventListener('click', () => {
    if (isLocked()) return;
    selected.clear();
    setMessage('');
    renderList(false);
  });
  get('optAggressive').addEventListener('change', event => {
    if (isLocked()) {
      aggressive = false;
      event.target.checked = false;
      return;
    }
    if (!event.target.checked) {
      aggressive = false;
      return;
    }
    event.target.checked = false;
    if (pendingAggressiveOptIn) return;
    pendingAggressiveOptIn = true;
    get('aggressiveConfirm').showModal();
  });
  get('aggressiveCancel').addEventListener('click', () => get('aggressiveConfirm').close());
  get('aggressiveEnable').addEventListener('click', () => {
    if (!pendingAggressiveOptIn) return;
    pendingAggressiveOptIn = false;
    aggressive = !isLocked();
    get('optAggressive').checked = aggressive;
    get('aggressiveConfirm').close();
  });
  get('aggressiveConfirm').addEventListener('cancel', () => {
    pendingAggressiveOptIn = false;
    aggressive = false;
    get('optAggressive').checked = false;
  });
  get('aggressiveConfirm').addEventListener('close', () => {
    if (!pendingAggressiveOptIn) return;
    pendingAggressiveOptIn = false;
    aggressive = false;
    get('optAggressive').checked = false;
  });
  const buttonContext = button => button.closest('#videoActions') ? 'quick' : 'settings';
  startButtons.forEach(button => button.addEventListener('click', () => {
    const context = buttonContext(button);
    startQueue(context).catch(error => setMessage(error.message, context));
  }));
  stopButtons.forEach(button => button.addEventListener('click', () => {
    const context = buttonContext(button);
    stopQueue().catch(error => setMessage(error.message, context));
  }));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && (changes.xiaoyaRun || changes.xiaoyaPendingScan)) render();
  });

  (async () => {
    options = { ...DEFAULTS, ...(await chrome.storage.local.get('options')).options };
    renderOptions();
    renderList(false);
    await render();
  })().catch(error => setStatus(error.message));
})();
