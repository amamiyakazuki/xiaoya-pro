'use strict';
if (typeof importScripts === 'function') importScripts('task-data.js');
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
const KEY = 'xiaoyaRun';
chrome.alarms.create('xiaoya-tick', { periodInMinutes: 0.5 });
// Serialize commands so two tabs cannot acquire the queue simultaneously.
let commands = Promise.resolve();
const HOME = 'https://whut.ai-augmented.com/app/jx-web/mycourse';
const PENDING = 'xiaoyaPendingScan';
function isHome(url) {
  try { const value = new URL(url); return value.origin === new URL(HOME).origin && value.pathname.replace(/\/$/, '') === new URL(HOME).pathname; }
  catch { return false; }
}
async function resumeScan(tabId) {
  const pending = (await chrome.storage.session.get(PENDING))[PENDING];
  if (!pending || pending.tabId !== tabId) return { ok: true };
  const tab = await chrome.tabs.get(tabId);
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
async function handle(message, sender) {
    const stored = (await chrome.storage.session.get(KEY))[KEY];
    if (message.type === 'login-ready') return await resumeScan(sender.tab?.id);
    if (message.type === 'scan') {
      if (stored?.enabled) throw new Error('队列正在运行，请先停止再重新获取待办。');
      const current = await chrome.tabs.get(message.tabId);
      const matches = await chrome.tabs.query({ url: 'https://whut.ai-augmented.com/*' });
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
    if (message.type === 'get') return { run: stored?.tabId === sender.tab?.id ? stored : null };
    if (message.type === 'start' || message.type === 'scan-resume') {
      const tab = await chrome.tabs.get(message.tabId);
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
        await chrome.storage.session.set({ [KEY]: stored });
        await chrome.tabs.sendMessage(stored.tabId, { type: 'halt' }).catch(() => {});
        await releasePage(stored);
      }
      return { ok: true };
    }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!['get', 'start', 'scan', 'login-ready', 'save', 'stop'].includes(message?.type)) return;
  commands = commands.then(() => handle(message, sender)).then(reply, async error => {
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
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== 'xiaoya-tick') return;
  const run = (await chrome.storage.session.get(KEY))[KEY];
  if (run?.enabled) await chrome.tabs.sendMessage(run.tabId, { type: 'tick' }).catch(() => {});
});
chrome.tabs.onRemoved.addListener(async tabId => {
  const run = (await chrome.storage.session.get(KEY))[KEY];
  if (run?.tabId === tabId) await chrome.storage.session.remove(KEY);
  const pending = (await chrome.storage.session.get(PENDING))[PENDING];
  if (pending?.tabId === tabId) await chrome.storage.session.remove(PENDING);
});
