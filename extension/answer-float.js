(function (root) {
  'use strict';
  const schema = root.XiaoyaQuestion;
  const dom = root.XiaoyaAnswerDOM;
  const { extract } = dom;
  if (root.__xiaoyaAnswerFloat) return;
  root.__xiaoyaAnswerFloat = true;
  const records = new Map();
  let route = location.href, available = false, revision = '', checking = false, lastCheck = 0, scheduled = false, alive = true;
  const send = async message => {
    try { return await chrome.runtime.sendMessage(message); }
    catch { return { ok: false, error: '扩展连接已失效，请刷新页面后重试。' }; }
  };
  function cancel(record) {
    if (!record.requestId) return;
    record.controller?.abort();
    void send({ type: 'ai:query-cancel', requestId: record.requestId });
    record.requestId = null;
  }
  function clear() {
    for (const record of records.values()) { cancel(record); record.host.remove(); }
    records.clear();
  }
  function fingerprint(node) { return dom.fingerprint(node); }
  function mount(node) {
    const host = document.createElement('div');
    host.className = 'xiaoya-ai-float';
    // The platform's preview listens on the entire question, including descendants.
    for (const type of ['click', 'dblclick', 'pointerdown', 'mousedown', 'keydown', 'keyup', 'input', 'change']) {
      host.addEventListener(type, event => event.stopPropagation());
    }
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = ':host{display:block!important;margin:8px 0!important;text-align:left!important}*{box-sizing:border-box}section{font:14px/1.6 system-ui,sans-serif;color:#203343;max-width:560px}button{font:inherit;border:1px solid #b8d8d0;border-radius:18px;padding:5px 12px;background:#edf8f4;color:#14634f;cursor:pointer}button:focus-visible{outline:3px solid #4c9f8b;outline-offset:2px}button:disabled{opacity:.6;cursor:wait}.panel{margin-top:8px;border:1px solid #cfe1dc;border-radius:12px;padding:14px;background:#fff;box-shadow:0 4px 16px #173f3310}.note{font-size:12px;color:#64746e;margin:8px 0}p{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0}textarea{display:block;width:100%;min-height:70px;resize:vertical;font:inherit;border:1px solid #b8ccc5;border-radius:8px;padding:8px;background:#fff;color:#203343}label{display:block;font-size:13px;margin:10px 0}.actions{display:flex;gap:8px}[hidden]{display:none!important}';
    const section = document.createElement('section');
    const button = document.createElement('button'); button.type = 'button'; button.textContent = '✦ AI 答案'; button.setAttribute('aria-expanded', 'false');
    const recognized = extract(node).question;
    const badge = document.createElement('span'); badge.className = 'note';
    badge.textContent = recognized ? ` 已识别：${recognized.typeLabel || ({single:'单选题',multiple:'多选题',short:'简答题',attachment:'附件题',fill:'填空题',judgment:'判断题',compound:'组合题'}[recognized.type] || '文字题')}${recognized.type === 'fill' ? ` · ${recognized.blankCount} 空` : ''}` : ' 题目结构待检查';
    const panel = document.createElement('div'); panel.className = 'panel'; panel.hidden = true;
    const title = document.createElement('strong'); title.textContent = 'AI 参考答案';
    const status = document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const explanation = document.createElement('p');
    const note = document.createElement('p'); note.className = 'note'; note.textContent = '点击后将本题题干、选项、图片及补充要求发送给你配置的 AI 服务。图片需模型支持识图；答案请自行核对。';
    const requirementsLabel = document.createElement('label'); requirementsLabel.textContent = '本题补充要求（可选）';
    const requirements = document.createElement('textarea'); requirements.maxLength = 2000; requirements.placeholder = '例如：100 字以内，分三点。修改后点击重新生成。';
    requirementsLabel.append(requirements);
    const warning = document.createElement('p'); warning.className = 'note'; warning.textContent = extract(node).warning || '';
    const actions = document.createElement('div'); actions.className = 'actions';
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重新生成'; retry.hidden = true;
    const stop = document.createElement('button'); stop.type = 'button'; stop.textContent = '取消请求'; stop.hidden = true;
    actions.append(retry, stop); panel.append(title, status, explanation, warning, note, requirementsLabel, actions); section.append(button, badge, panel); shadow.append(style, section);
    const record = { host, fingerprint: fingerprint(node), requestId: null, loaded: false };
    records.set(node, record);
    // Outside the stem and answer containers: extraction never includes our UI.
    node.append(host);
    const current = () => alive && records.get(node) === record && node.isConnected && location.href === route && fingerprint(node) === record.fingerprint;
    async function query() {
      if (record.requestId || !current()) return;
      const extracted = extract(node);
      if (extracted.error) {
        status.textContent = extracted.error; requirementsLabel.hidden = true;
        note.textContent = '当前题目未发送给 AI，需后续适配该题型或内容。';
        record.loaded = true; return;
      }
      const id = crypto.randomUUID(); record.requestId = id; record.controller = new AbortController();
      status.textContent = '正在查询 AI…'; explanation.textContent = ''; retry.hidden = true; stop.hidden = false; requirements.disabled = true;
      const startRevision = revision;
      let response, mediaTimer;
      try {
        mediaTimer = setTimeout(() => record.controller.abort(), 15000);
        const question = extracted.resources?.length ? await root.XiaoyaAnswerMedia.prepare(extracted, { signal: record.controller.signal }) : extracted.question;
        clearTimeout(mediaTimer);
        if (!current() || record.requestId !== id || record.controller.signal.aborted) return;
        response = await send({ type: 'ai:query', requestId: id, question, instructions: requirements.value });
      } catch (error) {
        response = { ok: false, error: record.controller.signal.aborted ? '图片读取已取消或超过 15 秒，请手动重试。' : error.message };
      } finally { clearTimeout(mediaTimer); }
      if (!current() || record.requestId !== id || revision !== startRevision) return;
      record.requestId = null; requirements.disabled = false; stop.hidden = true; retry.hidden = false; record.loaded = true;
      if (!response?.ok) { status.textContent = response?.error || '查询失败，请重试。'; return; }
      if (response.revision !== revision) { status.textContent = 'AI 配置已变化，请重新查询。'; return; }
      status.textContent = response.result.answer;
      explanation.textContent = `解释：${response.result.explanation}`;
    }
    button.addEventListener('click', event => {
      if (!event.isTrusted) return;
      panel.hidden = !panel.hidden; button.setAttribute('aria-expanded', String(!panel.hidden));
      if (!panel.hidden && !record.loaded) void query();
    });
    retry.addEventListener('click', event => { if (event.isTrusted) void query(); });
    stop.addEventListener('click', event => {
      if (!event.isTrusted) return;
      cancel(record); requirements.disabled = false; status.textContent = '请求已取消，服务商可能已接收并计费。'; stop.hidden = true; retry.hidden = false; record.loaded = true;
    });
  }
  async function check() {
    if (checking || !alive) return;
    checking = true; lastCheck = Date.now();
    const response = await send({ type: 'ai:available' });
    checking = false;
    if (!alive) return;
    if (revision !== response?.revision || available !== Boolean(response?.ok && response.available)) clear();
    revision = response?.revision || ''; available = Boolean(response?.ok && response.available);
    scan();
  }
  function scan() {
    if (!alive) return;
    if (route !== location.href) { clear(); route = location.href; lastCheck = 0; available = false; }
    if (!schema.isPage(location.href)) { clear(); return; }
    const nodes = [...document.querySelectorAll('#question_content .question')].filter(node => !node.parentElement?.closest('.question'));
    for (const [node, record] of records) {
      if (!nodes.includes(node) || !record.host.isConnected || fingerprint(node) !== record.fingerprint) { cancel(record); record.host.remove(); records.delete(node); }
    }
    if (nodes.length && Date.now() - lastCheck > 10000) void check();
    if (available) for (const node of nodes) if (!records.has(node)) mount(node);
  }
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true; setTimeout(() => { scheduled = false; scan(); }, 150);
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['id', 'class', 'src', 'srcset', 'data-src', 'data-tex', 'data-latex'] });
  let interval = setInterval(scan, 1500);
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'ai:changed') { clear(); available = false; lastCheck = 0; if (schema.isPage(location.href)) void check(); }
  });
  addEventListener('pagehide', () => { alive = false; clear(); clearInterval(interval); observer.disconnect(); });
  addEventListener('pageshow', event => {
    if (!event.persisted) return;
    alive = true; available = false; lastCheck = 0;
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['id', 'class', 'src', 'srcset', 'data-src', 'data-tex', 'data-latex'] });
    interval = setInterval(scan, 1500); scan();
  });
  scan();
})(globalThis);
