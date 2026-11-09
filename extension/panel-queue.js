'use strict';
// 设置页中的学习选项和现有视频课件队列入口。发给后台的消息与原弹窗相同。
(function () {
  const get = id => document.getElementById(id);
  const DEFAULTS = { rate: 2, background: true, muted: true, recursive: true, autoNext: true };
  const SWITCHES = { background: 'optBackground', muted: 'optMuted', autoNext: 'optAutoNext', recursive: 'optRecursive' };
  const RATES = [1, 1.25, 1.5, 2];
  let options = { ...DEFAULTS };
  let lastTabId = null;

  const activeTabId = async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  const readState = () => chrome.storage.session.get(['xiaoyaRun', 'xiaoyaError', 'xiaoyaPendingScan']);
  const saveOptions = () => chrome.storage.local.set({ options });

  function renderOptions() {
    Object.entries(SWITCHES).forEach(([key, id]) => { get(id).checked = options[key]; });
    RATES.forEach((rate, index) => {
      const button = document.querySelector(`[data-rate="${rate}"]`);
      button.setAttribute('aria-pressed', options.rate === rate);
      if (options.rate === rate) moveThumb(get('rate'), index);
    });
  }

  async function render() {
    const stored = await readState();
    const run = stored.xiaoyaRun;
    const pending = stored.xiaoyaPendingScan;
    const tabId = await activeTabId();
    let status = run ? `${run.tabId !== tabId ? '小雅后台运行：' : ''}${run.status || '等待页面响应…'}` : '尚未开始';
    if (pending) status = pending.status;
    if (stored.xiaoyaError && stored.xiaoyaError.tabId === lastTabId) status = stored.xiaoyaError.text;
    const running = Boolean(run?.enabled);
    get('queueStatus').textContent = status;
    get('queueCount').textContent = `已完成 ${run?.completed?.length || 0} 项`;
    get('queueLogs').replaceChildren(...(run?.logs || []).slice(-6).reverse().map(entry => {
      const item = document.createElement('li');
      item.textContent = `${new Date(entry.time).toLocaleTimeString('zh-CN')} ${entry.text}`;
      return item;
    }));
    get('queueStart').disabled = running;
    get('queueStop').disabled = !running && !pending;
    get('gear').classList.toggle('running', running);
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

  get('queueStart').addEventListener('click', async () => {
    get('queueStart').disabled = true;
    get('queueStatus').textContent = '正在启动队列…';
    try {
      lastTabId = await activeTabId();
      const result = await chrome.runtime.sendMessage({ type: 'start', tabId: lastTabId, options: { ...options } });
      if (result?.error) throw new Error(result.error);
      if (!result?.ok) throw new Error('后台未确认请求，请到浏览器扩展管理页重新加载“小雅刷课助手”后再试。');
      await render();
    } catch (error) {
      await render();
      get('queueStatus').textContent = error.message;
    }
  });
  get('queueStop').addEventListener('click', async () => {
    const stored = await readState();
    await chrome.runtime.sendMessage({ type: 'stop', tabId: stored.xiaoyaPendingScan?.tabId ?? stored.xiaoyaRun?.tabId ?? await activeTabId() });
    await render();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && (changes.xiaoyaRun || changes.xiaoyaError || changes.xiaoyaPendingScan)) render();
  });

  (async () => {
    options = { ...DEFAULTS, ...(await chrome.storage.local.get('options')).options };
    renderOptions();
    await render();
  })().catch(error => { get('queueStatus').textContent = error.message; });
})();
