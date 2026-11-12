'use strict';
if (typeof importScripts === 'function') importScripts('task-data.js');
if (typeof importScripts === 'function') importScripts('ai-question.js', 'ai-client.js', 'ai-service.js');
const aiService = globalThis.XiaoyaAIService?.createService();
if (typeof importScripts === 'function') importScripts('answer-batch.js', 'answer-driver.js');
let answerEngine, answerDriver, answerStartEpoch = 0, pendingAnswerStarts = 0;
const answerStore = globalThis.XiaoyaTaskData?.createTaskStore();
function answers() {
  if (answerEngine) return answerEngine;
  answerDriver = globalThis.XiaoyaAnswerDriver.createDriver({ chrome, getBatchId: () => answerEngine.getId(),
    verifySubmitted: async task => answerStore.checkSubmitted(task, (await answerEngine.get()).account)
  });
  answerEngine = globalThis.XiaoyaAnswerBatch.createEngine({ storage: chrome.storage.local, driver: answerDriver,
    getAccount: () => answerStore.currentAccount(), query: (q, signal) => aiService.querySaved(q, signal),
    aiReady: () => aiService.available()
  });
  return answerEngine;
}
const answerPanel = sender => sender.id === chrome.runtime.id && !sender.tab && sender.url === chrome.runtime.getURL('sidepanel.html');
async function handleAnswer(message, sender, ticket) {
  if (message.type === 'auto:permit') {
    if (sender.id !== chrome.runtime.id || !answerEngine) return { allowed: false };
    const task = answerEngine.getTask();
    return { allowed: Boolean(task && await answerDriver.permits(message, sender, task) && await answerEngine.permit(message)) };
  }
  if (!answerPanel(sender)) throw Error('只有任务面板可以控制批次。');
  const engine = answers();
  if (message.type === 'auto:stop') { answerStartEpoch++; return engine.stop(); }
  if (message.type === 'auto:get') return { ok: true, batch: await engine.get() };
  if (message.type === 'auto:verify') return engine.verify();
  if (message.type === 'auto:open-draft') {
    const batch = await engine.get();
    if (!batch || batch.id !== message.batchId) throw Error('这份待补附件记录已被新批次替换，请刷新侧栏。');
    const canFocus = () => !pendingAnswerStarts && !engine.busy() && engine.getId() === batch.id;
    if (!canFocus()) throw Error('批次仍在运行或准备中，暂时不能返回草稿页。');
    if (await answerStore.currentAccount() !== batch.account) throw Error('当前小雅账号与这份草稿所属账号不同，请切回原账号。');
    const index = batch.tasks.findIndex(task => task.id === message.taskId);
    if (index < 0 || batch.results[index]?.status !== 'draft' || !batch.results[index]?.draftPage) throw Error('找不到这份批次中的待补附件页面。');
    const task = batch.tasks[index];
    const draftPage = batch.results[index].draftPage;
    const focused = await answerDriver.focusDraft(task, draftPage, async () => {
      const account = await answerStore.currentAccount();
      const current = await engine.get();
      return canFocus() && current?.id === batch.id && account === batch.account
        && current.tasks[index]?.id === task.id && current.results[index]?.status === 'draft'
        && current.results[index]?.draftPage?.tabId === draftPage.tabId
        && current.results[index]?.draftPage?.pageToken === draftPage.pageToken;
    }, canFocus);
    if (focused === false) {
      if (!canFocus()) throw Error('批次正在切换，已取消返回原答题页。');
      throw Error('原答题页已关闭、已变化或账号状态无法确认，可稍后从小雅课程打开。');
    }
    return { ok: true };
  }
  if (message.type === 'auto:start') {
    if (!Array.isArray(message.ids) || !message.ids.length || message.ids.length > 200 || new Set(message.ids).size !== message.ids.length) throw Error('请选择 1–200 份任务。');
    const snapshot = await answerStore.load({ force: true });
    if (ticket !== answerStartEpoch) throw Error('启动已取消。');
    if (snapshot.status !== 'ok' || snapshot.account !== message.account) throw Error('无法确认当前账号，请刷新任务后重新选择。');
    const tasks = message.ids.map(id => snapshot.tasks.find(task => task.id === id));
    if (tasks.some(task => !globalThis.XiaoyaAnswerBatch.eligible(task))) throw Error('清单中的任务已完成、不可执行或身份变化，请刷新后重选。');
    return engine.start({ account: snapshot.account, tasks });
  }
  throw Error('未知批次操作。');
}

chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
const KEY = 'xiaoyaRun';
chrome.alarms.create('xiaoya-tick', { periodInMinutes: 0.5 });
// Serialize startup within each queue while allowing the two queues to work independently.
let videoCommands = Promise.resolve(), answerStartCommands = Promise.resolve();
const HOME = 'https://whut.ai-augmented.com/app/jx-web/mycourse';
const PAPER_PREFIX = 'https://whut.ai-augmented.com/app/jx-web/course_paper/';
const PENDING = 'xiaoyaPendingScan';
const SELECTED_PAGE_TIMEOUT = 45000;
function isAnswerTab(tab) {
  if (!answerEngine?.busy()) return false;
  if (answerDriver.usesTab(tab.id)) return true;
  const task = answerEngine.getTask();
  // Also protect the current paper URL while Chrome is opening the execution tab.
  return Boolean(task && [tab.url, tab.pendingUrl].some(url => globalThis.XiaoyaAnswerBatch.matches(url, task)));
}
function isHome(url) {
  try { const value = new URL(url); return value.origin === new URL(HOME).origin && value.pathname.replace(/\/$/, '') === new URL(HOME).pathname; }
  catch { return false; }
}
async function resumeScan(tabId) {
  const pending = (await chrome.storage.session.get(PENDING))[PENDING];
  if (!pending || pending.tabId !== tabId) return { ok: true };
  const tab = await chrome.tabs.get(tabId);
  if (isAnswerTab(tab)) {
    await chrome.storage.session.remove(PENDING);
    throw Error('原待办页正在答题，请从另一个小雅页面重新获取待办。');
  }
  if (!isHome(tab.url)) return { ok: true, waiting: true };
  await connectPage(tabId);
  const health = await chrome.tabs.sendMessage(tabId, { type: 'health' });
  if (!health?.loggedInHome) return { ok: true, waiting: true };
  const result = await handle({ type: 'scan-resume', tabId, options: pending.options }, {});
  await chrome.storage.session.remove(PENDING);
  return result;
}
async function releasePage(run) {
  if (run?.protectedTab) await chrome.tabs.update(run.tabId, { autoDiscardable: run.originalAutoDiscardable ?? true }).catch(() => {});
}
async function connectPage(tabId) {
  let health = await chrome.tabs.sendMessage(tabId, { type: 'health' }).catch(() => null);
  if (health?.protocol !== 6) {
    // Extension reloads don't automatically attach scripts to an already-open page.
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['background-mode.js'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['task-timing.js', 'content.js'] });
    health = await chrome.tabs.sendMessage(tabId, { type: 'health' }).catch(() => null);
  }
  if (!health?.ok || health.protocol !== 6) throw new Error('页面脚本连接失败，请刷新小雅首页后重试。');
}

function matchesSelectedPage(url, target) {
  if (!target) return false;
  try {
    const page = new URL(url);
    const match = page.pathname.match(/^\/app\/jx-web\/mycourse\/(\d+)\/resource\/[^/]+\/(\d+)\/?$/);
    return page.origin === new URL(HOME).origin && match?.[1] === target.courseId && match[2] === target.nodeId;
  } catch { return false; }
}

async function validateSelection(selection, account) {
  if (!Array.isArray(selection) || !selection.length) throw Error('请先勾选要处理的视频或课件。');
  const ids = selection.map(target => target?.id);
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw Error('清单中有重复或无法定位的任务，请重新选择。');
  const snapshot = await answerStore.load({ force: true });
  if (!account || snapshot.status !== 'ok' || snapshot.stale || snapshot.account !== account) throw Error('无法确认当前小雅账号，请刷新任务后重新选择。');
  const byId = new Map(), nodeCounts = new Map();
  for (const task of snapshot.tasks) {
    byId.set(task.id, byId.has(task.id) ? null : task);
    if (task.typeCode !== 1) continue;
    const key = `${task.courseId}/${task.nodeId}`;
    nodeCounts.set(key, (nodeCounts.get(key) || 0) + 1);
  }
  const { mediaProblem, mediaTarget } = globalThis.XiaoyaTaskData;
  const now = Date.now();
  return selection.map(requested => {
    const task = byId.get(requested.id);
    const issue = task ? mediaProblem(task, now) : '任务身份无法确认';
    if (issue) throw Error(`「${requested.name || requested.id}」${issue}，请刷新清单后重选。`);
    const target = mediaTarget(task);
    if (snapshot.failures?.some(failure => String(failure.courseId) === target.courseId)) throw Error(`「${target.courseName}」任务信息读取不完整，请刷新后重试。`);
    if (nodeCounts.get(`${target.courseId}/${target.nodeId}`) !== 1 || Object.keys(target).some(key => target[key] !== requested[key])) {
      throw Error(`「${requested.name || requested.id}」任务身份或名称已变化，请刷新清单后重选。`);
    }
    return target;
  });
}

async function navigateSelected(tab, target) {
  if (tab.url === target.url && !tab.pendingUrl) await chrome.tabs.reload(tab.id);
  else await chrome.tabs.update(tab.id, { url: target.url });
}

async function startSelected(message, sender, stored) {
  if (!answerPanel(sender)) throw Error('请从任务面板启动视频课件队列。');
  if (stored?.enabled || (await chrome.storage.session.get(PENDING))[PENDING]) throw Error('已有视频课件队列或待办扫描正在运行，请先停止。');
  const selection = await validateSelection(message.selection, message.account);
  const tab = await chrome.tabs.get(message.tabId);
  if (isAnswerTab(tab)) throw Error('这是答题执行页，请切到用于刷课的小雅首页或课程资源页。');
  const url = new URL(tab.pendingUrl || tab.url || 'about:blank');
  const resource = /^\/app\/jx-web\/mycourse\/[^/]+\/resource\//.test(url.pathname);
  if (!isHome(url.href) && !(url.origin === new URL(HOME).origin && resource)) throw Error('请登录小雅并打开“我的课程”首页，或课程资源页面。');
  const options = message.options || {};
  const aggressive = options.aggressive === true;
  const protectedTab = !aggressive && options.background === true;
  const run = { mode: 'selected', id: crypto.randomUUID(), tabId: tab.id, sourceTabId: tab.id, enabled: true,
    protectedTab, originalAutoDiscardable: tab.autoDiscardable, account: message.account, selection, selectionIndex: 0,
    pageDocumentId: null, pageRequestedAt: Date.now(), completed: [], logs: [], started: Date.now(),
    status: `正在打开：${selection[0].name}`,
    options: { rate: [1, 1.25, 1.5, 2].includes(options.rate) ? options.rate : 2,
      background: protectedTab, muted: options.muted === true, autoNext: options.autoNext !== false, aggressive } };
  try {
    if (protectedTab) await chrome.tabs.update(tab.id, { autoDiscardable: false });
    if (isAnswerTab(tab)) throw Error('这是答题执行页，请切到用于刷课的小雅首页或课程资源页。');
    await chrome.storage.session.remove('xiaoyaError');
    await chrome.storage.session.set({ [KEY]: run });
    await navigateSelected(tab, selection[0]);
  } catch (error) {
    await chrome.storage.session.remove(KEY);
    await releasePage(run);
    throw error;
  }
  return { ok: true };
}

function selectedTabSender(run, sender) {
  return run?.mode === 'selected' && run.enabled && run.tabId === sender.tab?.id
    && sender.frameId === 0 && Boolean(sender.documentId);
}

function selectedSender(run, sender) {
  return selectedTabSender(run, sender) && matchesSelectedPage(sender.url, run.selection[run.selectionIndex]);
}

async function pauseSelected(run, status) {
  run.enabled = false;
  run.status = status;
  await chrome.storage.session.set({ [KEY]: run });
  void chrome.tabs.sendMessage(run.tabId, { type: 'selected-halt' }).catch(() => {});
  await releasePage(run);
}

async function verifySelectedAccount(run) {
  const account = await answerStore.currentAccount().catch(() => null);
  if (account === run.account) return true;
  await pauseSelected(run, '小雅账号已变化或无法核对，视频课件队列已暂停。');
  return false;
}

async function advanceSelected(run, message, sender) {
  if (!selectedSender(run, sender) || run.pageDocumentId !== sender.documentId || run.id !== message.runId || run.selectionIndex !== message.index) {
    return { ok: true, accepted: false };
  }
  if (!await verifySelectedAccount(run)) return { ok: true, accepted: false };
  const current = run.selection[run.selectionIndex];
  run.completed.push(current.id);
  run.logs = [...run.logs.slice(-39), { time: Date.now(), text: `平台已确认完成：${current.name}` }];
  const next = run.selection[run.selectionIndex + 1];
  if (!next || run.options.autoNext === false) {
    run.enabled = false;
    run.status = next ? `已完成：${current.name}。自动下一任务未开启。` : `所选 ${run.selection.length} 项已全部完成。`;
    await chrome.storage.session.set({ [KEY]: run });
    await releasePage(run);
    return { ok: true, accepted: true };
  }
  run.selectionIndex++;
  run.pageDocumentId = null;
  run.pageRequestedAt = Date.now();
  run.status = `正在打开：${next.name}`;
  await chrome.storage.session.set({ [KEY]: run });
  try {
    const tab = await chrome.tabs.get(run.tabId);
    if (!matchesSelectedPage(tab.pendingUrl || tab.url, current) || isAnswerTab(tab)) throw Error('小雅标签页已切换');
    await navigateSelected(tab, next);
  } catch {
    run.enabled = false;
    run.status = `无法打开所选任务：${next.name}。队列已暂停。`;
    await chrome.storage.session.set({ [KEY]: run });
    await releasePage(run);
    return { ok: true, accepted: false };
  }
  return { ok: true, accepted: true };
}

async function handle(message, sender) {
    const stored = (await chrome.storage.session.get(KEY))[KEY];
    if (message.type === 'login-ready') return await resumeScan(sender.tab?.id);
    if (message.type === 'scan') {
      if (stored?.enabled) throw new Error('队列正在运行，请先停止再重新获取待办。');
      const current = await chrome.tabs.get(message.tabId);
      const matches = (await chrome.tabs.query({ url: 'https://whut.ai-augmented.com/*' })).filter(tab =>
        !isAnswerTab(tab) && ![tab.url, tab.pendingUrl].some(url => url?.startsWith(PAPER_PREFIX)));
      let target = matches.find(tab => tab.id === current.id) || matches.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
      if (!target) target = await chrome.tabs.create({ url: HOME, active: true });
      await chrome.storage.session.remove('xiaoyaError');
      await chrome.storage.session.set({ [PENDING]: { tabId: target.id, sourceTabId: current.id, options: message.options,
        status: '正在打开小雅；未登录时请先登录，成功后将自动获取任务。' } });
      if (!isHome(target.url)) await chrome.tabs.update(target.id, { url: HOME, active: true });
      else if (target.status !== 'loading') {
        await chrome.tabs.update(target.id, { active: true });
        await resumeScan(target.id);
      }
      return { ok: true };
    }
    if (message.type === 'get') {
      if (stored?.mode !== 'selected') return { run: stored?.tabId === sender.tab?.id ? stored : null };
      if (message.selectedProtocol !== 1 || !selectedSender(stored, sender)) return { run: null };
      if (stored.pageDocumentId !== sender.documentId) {
        if (!await verifySelectedAccount(stored)) return { run: null };
        stored.pageDocumentId = sender.documentId;
        await chrome.storage.session.set({ [KEY]: stored });
      }
      return { run: stored };
    }
    if (message.type === 'start-selected') return startSelected(message, sender, stored);
    if (message.type === 'selected-advance') return advanceSelected(stored, message, sender);
    if (message.type === 'start' || message.type === 'scan-resume') {
      const tab = await chrome.tabs.get(message.tabId);
      if (isAnswerTab(tab)) throw Error('这是答题执行页，请切到用于刷课的小雅首页或课程资源页。');
      const url = new URL(tab.url || 'about:blank');
      const home = /^\/app\/jx-web\/mycourse\/?$/.test(url.pathname);
      const resource = /^\/app\/jx-web\/mycourse\/[^/]+\/resource\//.test(url.pathname);
      if (url.origin !== 'https://whut.ai-augmented.com' || (!home && !resource)) {
        throw new Error('请登录小雅并打开“我的课程”首页，或课程资源页面。');
      }
      if (stored?.enabled) throw new Error('已有队列正在运行，请先点击停止再重新开始。');
      const protectedTab = message.type === 'start' && message.options?.background === true;
      try {
        if (protectedTab) await chrome.tabs.update(tab.id, { autoDiscardable: false });
        await connectPage(tab.id);
      } catch (error) {
        await releasePage({ tabId: tab.id, protectedTab, originalAutoDiscardable: tab.autoDiscardable });
        throw error;
      }
      await chrome.storage.session.remove('xiaoyaError');
      const run = { tabId: tab.id, sourceTabId: tab.id, protectedTab, originalAutoDiscardable: tab.autoDiscardable, id: crypto.randomUUID(), enabled: true,
        mode: home ? 'home' : 'directory', scanOnly: message.type === 'scan-resume', tasks: [], homeFinished: [],
        options: message.options, completed: [], visited: [], stack: [], logs: [], started: Date.now() };
      await chrome.storage.session.set({ [KEY]: run });
      try {
        const result = await chrome.tabs.sendMessage(tab.id, { type: 'run', run });
        if (!result?.ok) throw new Error('页面未确认接收队列');
      } catch {
        await chrome.storage.session.remove(KEY);
        await releasePage(run);
        throw new Error('页面未接收到启动命令，请刷新小雅首页后重试。');
      }
      return { ok: true };
    }
    if (message.type === 'save') {
      if (stored?.mode === 'selected') {
        if (!selectedTabSender(stored, sender) || stored.pageDocumentId !== sender.documentId || stored.id !== message.run?.id
          || stored.selectionIndex !== message.run?.selectionIndex || (message.run.enabled !== false && !selectedSender(stored, sender))) {
          return { ok: true, accepted: false };
        }
        const { enabled, status, logs } = message.run;
        await chrome.storage.session.set({ [KEY]: { ...stored, enabled, status, logs } });
        if (!enabled) await releasePage(stored);
        return { ok: true, accepted: true };
      }
      if (stored?.id === message.run?.id && stored.tabId === sender.tab?.id) {
        if (stored.enabled && !message.run.enabled) await releasePage(stored);
        await chrome.storage.session.set({ [KEY]: message.run });
      }
      return { ok: true };
    }
    if (message.type === 'stop') {
      const pending = (await chrome.storage.session.get(PENDING))[PENDING];
      if (pending && (pending.tabId === message.tabId || pending.sourceTabId === message.tabId)) await chrome.storage.session.remove(PENDING);
      if (stored && (stored.tabId === message.tabId || stored.sourceTabId === message.tabId)) {
        stored.enabled = false;
        if (stored.mode === 'selected') stored.status = '已手动停止视频课件队列。';
        await chrome.storage.session.set({ [KEY]: stored });
        await chrome.tabs.sendMessage(stored.tabId, { type: stored.mode === 'selected' ? 'selected-halt' : 'halt' }).catch(() => {});
        await releasePage(stored);
      }
      return { ok: true };
    }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (typeof message?.type === 'string' && message.type.startsWith('auto:')) {
    const ticket = answerStartEpoch;
    const action = () => handleAnswer(message, sender, ticket);
    const done = result => reply(result), failed = error => reply({ ok: false, error: error.message || '批次操作失败。' });
    if (message.type === 'auto:start' && answerPanel(sender)) {
      pendingAnswerStarts++;
      answerStartCommands = answerStartCommands.then(action).finally(() => { pendingAnswerStarts--; }).then(done, failed);
    } else action().then(done, failed);
    return true;
  }
  if (typeof message?.type === 'string' && message.type.startsWith('ai:')) {
    if (['ai:query', 'ai:test', 'ai:save', 'ai:delete'].includes(message.type) && answerEngine?.busy()) {
      reply({ ok: false, error: '自动作答正在运行，请停止后再操作 AI 设置或浮标。' }); return true;
    }
    // AI requests must not occupy the video queue's serialized command chain.
    if (aiService) aiService.handle(message, sender).then(reply);
    else reply({ ok: false, error: 'AI 模块尚未加载，请重新加载扩展。' });
    return true;
  }
  if (!['get', 'start', 'start-selected', 'selected-advance', 'scan', 'login-ready', 'save', 'stop'].includes(message?.type)) return;
  videoCommands = videoCommands.then(() => handle(message, sender)).then(reply, async error => {
    const failure = { text: error.message, tabId: message.tabId ?? sender.tab?.id, at: Date.now() };
    await chrome.storage.session.set({ xiaoyaError: failure });
    reply({ error: error.message });
  });
  return true;
});
// 记住打开过的课程页，这样全部做完的课程也能出现在任务面板里。
chrome.tabs.onUpdated.addListener((tabId, info) => {
  const id = info.url?.match(/^https:\/\/whut\.ai-augmented\.com\/app\/jx-web\/mycourse\/(\d+)/)?.[1];
  if (id) globalThis.XiaoyaTaskData?.createTaskStore().rememberCourses([{ id }]).catch(() => {});
});
async function tickVideo() {
  const run = (await chrome.storage.session.get(KEY))[KEY];
  if (!run?.enabled) return;
  if (run.mode !== 'selected') {
    void chrome.tabs.sendMessage(run.tabId, { type: 'tick' }).catch(() => {});
    return;
  }
  const tab = await chrome.tabs.get(run.tabId).catch(() => null);
  const target = run.selection[run.selectionIndex];
  const matching = matchesSelectedPage(tab?.pendingUrl || tab?.url, target);
  if (run.pageDocumentId && matching) {
    void chrome.tabs.sendMessage(run.tabId, { type: 'selected-tick' }, { documentId: run.pageDocumentId }).catch(() => {});
  } else if (Date.now() - run.pageRequestedAt >= SELECTED_PAGE_TIMEOUT) {
    await pauseSelected(run, `未连接到所选任务：${target.name}。队列已暂停，请检查小雅登录或页面加载状态。`);
  }
}
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== 'xiaoya-tick') return;
  const recovery = globalThis.XiaoyaAnswerBatch ? answers().get().catch(() => {}) : null;
  videoCommands = videoCommands.then(tickVideo).catch(() => {});
  await videoCommands;
  await recovery;
});
chrome.tabs.onRemoved.addListener(async tabId => {
  const run = (await chrome.storage.session.get(KEY))[KEY];
  if (run?.tabId === tabId) await chrome.storage.session.remove(KEY);
  const pending = (await chrome.storage.session.get(PENDING))[PENDING];
  if (pending?.tabId === tabId) await chrome.storage.session.remove(PENDING);
});
