'use strict';
// 视频课件逐项选择和队列设置；两个开始入口都按点击时冻结的清单直接启动。
(function () {
  const get = id => document.getElementById(id);
  const taskData = globalThis.XiaoyaTaskData;
  const DEFAULTS = { rate: 2, background: true, muted: true, recursive: true, autoNext: true };
  const SWITCHES = { background: 'optBackground', muted: 'optMuted', autoNext: 'optAutoNext' };
  const RATES = [1, 1.25, 1.5, 2];
  const STARTING_STATUS = '正在核对账号和所选任务…';
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
  let finishing = false;
  let finishContext = 'quick';
  let lastDoneCount = 0;
  let taskRefreshTimer = null;
  let lastTaskRefresh = 0;
  const TASK_REFRESH_MS = 12000;

  // 批次进行中也让任务列表跟着平台走，避免已完成或很久以前的作业/测验一直挂在列表里。
  function scheduleTaskRefresh() {
    if (taskRefreshTimer) return;
    // 第一次在 1.5 秒后刷新，之后按 12 秒节流，既跟得上前几条，也不至于频繁请求。
    const elapsed = lastTaskRefresh ? Date.now() - lastTaskRefresh : TASK_REFRESH_MS - 1500;
    const wait = Math.max(0, TASK_REFRESH_MS - elapsed);
    taskRefreshTimer = setTimeout(() => {
      taskRefreshTimer = null;
      lastTaskRefresh = Date.now();
      Promise.resolve(globalThis.XiaoyaPanelRefreshData?.()).catch(() => {});
    }, wait);
    taskRefreshTimer?.unref?.();
  }

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

  // 直接提交完成状态的清单：必须是已勾选、身份完整、未完成且未截止的自主观看任务。
  function finishTargets() {
    const rows = selectedRows().filter(row => row.task);
    if (rows.length !== selected.size) return { rows: [], problem: '所选清单已变化，请刷新任务后重新选择。' };
    for (const row of rows) {
      const problem = row.problem || String(taskData?.finishProblem?.(row.task) || '');
      if (problem) return { rows: [], problem: `${row.task.name}：${problem}` };
    }
    return { rows, problem: '' };
  }

  // 激进模式下同一个开始按钮改为直接提交，这里的文案说明为什么暂时不能提交。
  function finishBlockedReason() {
    if (finishing) return '正在提交，请稍候';
    if (isLocked()) return '队列运行中暂时不能直接完成任务';
    if (!state.account) return '请先登录小雅并刷新任务';
    if (!selected.size) return '先勾选要完成的视频课件';
    return finishTargets().problem;
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
    const videoChip = state.chip === 'media' || state.chip === 'all';
    // 底栏只在有勾选、运行中或有待看的提示时出现；全选入口在列表栏。
    const quickMessage = Boolean(get('videoActions').querySelector('[data-video-message]')?.textContent);
    get('videoActions').hidden = !selected.size && !locked && !finishing && !quickMessage;
    get('videoAll').hidden = !videoChip;
    get('videoAll').textContent = state.chip === 'all' ? '全选视频/文档' : '全选';
    get('videoSelected').textContent = `已选 ${selected.size} 项${hidden ? `（筛选外 ${hidden} 项）` : ''}`;
    get('videoAll').disabled = locked || !state.account || !visibleMedia().some(task => !taskProblem(task));
    get('videoClear').disabled = locked || (!selected.size && !quickMessage);
    const finishBlocked = aggressive ? finishBlockedReason() : '';
    startButtons.forEach(button => {
      button.disabled = locked || finishing || !selected.size || !state.account || Boolean(finishBlocked);
      button.textContent = starting ? '正在启动…' : finishing ? '正在完成任务…' : aggressive ? '完成任务' : '开始刷课';
      button.title = finishBlocked || (aggressive ? '直接提交完成状态，不打开播放页，也不增加学习时长' : '按勾选顺序打开任务并播放');
    });
    stopButtons.forEach(button => { button.disabled = !activeRun?.enabled && !activePending; });
    get('optAggressive').checked = aggressive;
    get('optAggressive').disabled = locked;
    get('gear').classList.toggle('running', Boolean(activeRun?.enabled));
    document.querySelectorAll('[data-video-id]').forEach(input => {
      input.checked = selected.has(input.dataset.videoId);
      input.disabled = locked || !state.account || Boolean(taskForRow(input.dataset.videoTask) && taskProblem(taskForRow(input.dataset.videoTask)));
    });
    globalThis.XiaoyaPanelSelect?.render();
  }

  function taskForRow(id) { return state.tasks.find(task => String(task.id) === String(id)); }

  async function render() {
    syncSelection();
    const stored = await readState();
    activeRun = stored.xiaoyaRun || null;
    activePending = stored.xiaoyaPendingScan || null;
    const tabId = await activeTabId();
    let status;
    if (activeRun) status = `${activeRun.tabId !== tabId ? '小雅后台运行：' : ''}${activeRun.status || '等待页面响应…'}`;
    else if (aggressive) status = selected.size ? (finishBlockedReason() || '点「完成任务」直接提交') : '勾选后点「完成任务」直接提交';
    else status = selected.size ? '尚未开始' : '先勾选视频或课件';
    if (activePending) status = activePending.status;
    const running = Boolean(activeRun?.enabled);
    const current = activeRun?.current || activeRun?.selection?.[activeRun?.selectionIndex];
    if (running && current?.name && !String(status).includes(current.name)) status = `${status} · ${current.name}`;
    if (running && activeRun?.options?.aggressive) status = `激进模式 · ${status}`;
    setStatus(starting ? STARTING_STATUS : status);
    const total = activeRun?.selection?.length || 0;
    const completed = activeRun?.completed?.length || 0;
    if (completed > lastDoneCount) scheduleTaskRefresh();
    lastDoneCount = completed;
    // 平台已确认完成的任务不再占着勾选清单。
    for (const id of [...selected.keys()]) {
      if (state.tasks.find(row => String(row.id) === String(id))?.finished) selected.delete(id);
    }
    countLabels.forEach(label => { label.textContent = total ? `已完成 ${completed}/${total} 项` : `已完成 ${completed} 项`; });
    // 底栏的状态行：运行中、等待中，或上一轮停在仍勾选着的任务上（停止或出错）时显示。
    const leftover = Boolean(activeRun && !activeRun.enabled && (activeRun.selection || []).some(item => selected.has(String(item?.id))));
    get('videoActions').classList.toggle('show-status', starting || running || Boolean(activePending) || leftover);
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
    setStatus(STARTING_STATUS);
    renderSelection();
    try {
      const tabId = await activeTabId();
      const result = await chrome.runtime.sendMessage({ type: 'start-selected', tabId, account, selection, options: requestOptions });
      if (result?.error) throw new Error(result.error);
      if (!result?.ok) throw new Error('后台未确认请求，请到浏览器扩展管理页重新加载“小雅助手 Pro”后再试。');
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
      renderSelection();
      return;
    }
    if (!event.target.checked) {
      aggressive = false;
      renderSelection();
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
    renderSelection();
  });
  get('aggressiveConfirm').addEventListener('cancel', () => {
    pendingAggressiveOptIn = false;
    aggressive = false;
    get('optAggressive').checked = false;
    renderSelection();
  });
  get('aggressiveConfirm').addEventListener('close', () => {
    if (!pendingAggressiveOptIn) return;
    pendingAggressiveOptIn = false;
    aggressive = false;
    get('optAggressive').checked = false;
    renderSelection();
  });

  function finishQueue(context) {
    const blocked = finishBlockedReason();
    if (blocked) { setMessage(blocked, context); return; }
    const { rows } = finishTargets();
    get('finishConfirmList').replaceChildren(...rows.map(row => {
      const item = document.createElement('li');
      item.textContent = row.task.name;
      const meta = document.createElement('span');
      meta.textContent = `${row.task.courseName} · ${row.task.end === null ? '无截止时间' : `截止 ${new Date(row.task.end).toLocaleString('zh-CN')}`}`;
      item.appendChild(meta);
      return item;
    }));
    finishContext = context;
    setMessage('', context);
    get('finishConfirm').showModal();
  }

  async function submitFinished() {
    if (finishing) return;
    const blocked = finishBlockedReason();
    const { rows, problem } = finishTargets();
    get('finishConfirm').close();
    const context = finishContext;
    if (problem || blocked || !rows.length) {
      setMessage(problem || blocked || '当前没有可提交的视频课件。', context);
      return;
    }
    const selection = rows.map(row => ({ id: row.target.id, courseId: row.target.courseId, nodeId: row.target.nodeId,
      taskId: row.task.taskId, name: row.target.name }));
    finishing = true;
    let applied = false;
    renderSelection();
    setMessage('正在提交，请勿关闭侧栏…', context);
    try {
      const result = await chrome.runtime.sendMessage({ type: 'finish-submit', tabId: await activeTabId(),
        account: state.account, aggressive: true, selection });
      if (result?.error) throw new Error(result.error);
      if (!result?.ok) throw new Error('后台未确认请求，请到扩展管理页重新加载后再试。');
      const verified = result.results.filter(row => row.verified).length;
      const lines = result.results.map(row => `${row.name}：${row.status === 'failed' ? `失败 - ${row.message}`
        : row.verified ? '已完成' : '已提交，状态待刷新'}`);
      setMessage(`提交 ${result.results.length} 项，确认完成 ${verified} 项。\n${lines.join('\n')}`, context);
      if (result.snapshot?.tasks) for (const task of result.snapshot.tasks) if (task.finished) selected.delete(task.id);
      if (result.snapshot) { applied = true; await globalThis.XiaoyaPanelRefresh?.(result.snapshot); }
    } catch (error) {
      setMessage(error.message, context);
    } finally {
      finishing = false;
      await render();
      if (!applied) await Promise.resolve(globalThis.XiaoyaPanelRefreshData?.()).catch(() => {});
    }
  }

  get('finishCancel').addEventListener('click', () => get('finishConfirm').close());
  get('finishGo').addEventListener('click', () => { submitFinished().catch(error => setMessage(error.message, finishContext)); });
  const buttonContext = button => button.closest('#videoActions') ? 'quick' : 'settings';
  startButtons.forEach(button => button.addEventListener('click', () => {
    const context = buttonContext(button);
    if (aggressive) { finishQueue(context); return; }
    startQueue(context).catch(error => setMessage(error.message, context));
  }));
  stopButtons.forEach(button => button.addEventListener('click', () => {
    const context = buttonContext(button);
    stopQueue().catch(error => setMessage(error.message, context));
  }));
  chrome.runtime.onMessage?.addListener(message => {
    if (message?.type !== 'finish:progress') return;
    if (message.status !== 'failed' && message.id) globalThis.XiaoyaPanelMarkDone?.([message.id]);
    scheduleTaskRefresh();
  });
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
