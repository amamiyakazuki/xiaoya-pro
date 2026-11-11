(function (root) {
  'use strict';
  function createDriver({ chrome: api, getBatchId, verifySubmitted = null, now = Date.now, delay = ms => new Promise(r => setTimeout(r, ms)), timeout = 25000 }) {
    let tabId = null, pageToken = null, stopped = false, entering = false;
    const children = new Set();
    const matches = root.XiaoyaAnswerBatch.matches;
    api.tabs.onCreated?.addListener(tab => { if (entering && tab.openerTabId === tabId) children.add(tab.id); });
    const fatal = text => Object.assign(Error(text), { fatal: true });
    async function target(task) {
      if (entering) {
        for (const child of children) {
          const tab = await api.tabs.get(child).catch(() => null);
          if (tab && matches(tab.url, task)) { tabId = child; pageToken = null; children.clear(); break; }
        }
      }
      const tab = await api.tabs.get(tabId).catch(() => null);
      if (!tab || !matches(tab.url || tab.pendingUrl, task)) throw fatal('执行页已关闭或离开已确认任务，批次已暂停。');
      return tab;
    }
    async function send(task, action, extra = {}) {
      await target(task);
      const response = await api.tabs.sendMessage(tabId, { type: 'auto:page', batchId: getBatchId(), task, pageToken, action, ...extra }, { frameId: 0 });
      if (!response?.ok) throw Object.assign(Error(response?.error || '作业页面没有确认操作。'), { submissionBlocked: action === 'confirm' });
      return response;
    }
    async function inspect(task) {
      const result = await send(task, 'inspect');
      pageToken = result.snapshot.pageToken;
      return result.snapshot;
    }
    async function wait(task, signal, previous) {
      const until = now() + timeout; let last;
      const fallbackPages = new Set();
      do {
        if (signal?.aborted || stopped) throw Error('已停止');
        try {
          last = await inspect(task);
          if (previous && last.canEnterCurrent && !fallbackPages.has(last.pageToken)) {
            if (signal?.aborted || stopped) throw Error('已停止');
            fallbackPages.add(last.pageToken);
            await send(task, 'enter-current').catch(error => { if (error.fatal) throw error; });
          } else if (last.submitted || (!previous || last.pageKind === 'paper') && (
            last.complete && !last.canBegin || last.canBegin && !previous?.canBegin || last.canEnter && !previous?.canEnter)) return last;
          // If the paper loaded but is incomplete, keep waiting for lazy rendering.
        } catch (error) { if (error.fatal) throw error; }
        await delay(350);
      } while (now() < until);
      if (previous && (last?.pageKind !== 'paper' || last.canBegin)) throw Error('尚未进入可作答页面，可能遇到新窗口拦截或开始入口未响应。请检查执行页后重新选择该任务。');
      if (last) return last;
      throw Error('作业页面加载超时，请在平台检查后重试。');
    }
    async function open(task, signal) {
      stopped = false; entering = false; children.clear(); pageToken = null;
      if (signal?.aborted) throw Error('已停止');
      const tab = await api.tabs.create({ url: task.url, active: true }); tabId = tab.id;
      return wait(task, signal);
    }
    async function enter(task, signal) {
      entering = true;
      try {
        let snapshot = await inspect(task);
        for (let i = 0; i < 2 && (snapshot.canEnter || snapshot.canBegin); i++) {
          if (stopped || signal.aborted) throw Error('已停止');
          const previous = snapshot;
          // A navigation can close the reply channel; never click the same entry again.
          await send(task, 'enter').catch(error => { if (error.fatal) throw error; });
          snapshot = await wait(task, signal, previous);
          if (snapshot.pageToken === previous.pageToken && snapshot.canEnter === previous.canEnter && snapshot.canBegin === previous.canBegin && !snapshot.complete) break;
        }
        return snapshot;
      } finally { entering = false; children.clear(); }
    }
    async function verify(task) {
      const until = now() + timeout;
      let receiptSeen = false;
      do {
        try {
          const state = await inspect(task);
          receiptSeen ||= state.submissionSucceeded === true;
          if (!receiptSeen && state.submitted) return true;
          if (!receiptSeen && !stopped) {
            const confirmation = await send(task, 'confirm');
            if (confirmation.blocked) throw Object.assign(Error(confirmation.reason), { submissionBlocked: true });
          }
        } catch (error) { if (error.submissionBlocked) throw error; if (error.fatal) break; }
        // Read the authoritative task state as soon as the current submit succeeds.
        // Retain a bounded wait for server propagation, without clicking or resubmitting.
        if (receiptSeen && verifySubmitted && await verifySubmitted(task)) return true;
        await delay(receiptSeen ? 1000 : 500);
      } while (now() < until);
      // A fresh server result still works when the old tab shows a stale processing state.
      return verifySubmitted ? await verifySubmitted(task) : false;
    }
    return { open, enter, inspect, verify,
      fill: (task, item) => send(task, 'fill', { item }),
      submit: (task, fingerprint) => send(task, 'submit', { fingerprint }),
      halt() { stopped = true; if (tabId !== null) api.tabs.sendMessage(tabId, { type: 'auto:page', action: 'halt' }, { frameId: 0 }).catch(() => {}); },
      async recheck(task) {
        stopped = true;
        // Do not require an old content-script connection after extension reload.
        // A fresh unfinished result must not be overridden by an old submitted tab.
        if (verifySubmitted) return await verifySubmitted(task);
        const tabs = await api.tabs.query({ url: 'https://whut.ai-augmented.com/*' });
        for (const tab of tabs.filter(tab => matches(tab.url, task))) {
          tabId = tab.id; pageToken = null;
          try { if ((await inspect(task)).submitted) return true; } catch {}
        }
        return false;
      },
      async permits(message, sender, task) {
        if (stopped || sender.tab?.id !== tabId || sender.frameId !== 0 || message.pageToken !== pageToken || !matches(sender.url, task)) return false;
        try { await target(task); return true; } catch { return false; }
      }
    };
  }
  root.XiaoyaAnswerDriver = { createDriver };
  if (typeof module !== 'undefined') module.exports = root.XiaoyaAnswerDriver;
})(globalThis);
