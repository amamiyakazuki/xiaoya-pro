(function () {
  'use strict';
  const ai = globalThis.XiaoyaAI;
  const el = id => document.getElementById(id);
  const fields = ['aiAddress', 'aiKey', 'aiModel'];
  let saved = { address: '', model: '', hasKey: false }, busy = false, requestId = null;
  const draft = () => ({ address: el('aiAddress').value, key: el('aiKey').value, model: el('aiModel').value });
  function status(text, tone = '') {
    el('aiStatus').textContent = text;
    el('aiStatus').dataset.tone = tone;
  }
  function lock(value, testing = false) {
    busy = value;
    [...fields, 'aiSave', 'aiTest', 'aiDelete'].forEach(id => { el(id).disabled = value; });
    el('aiCancel').hidden = !testing;
    el('aiCancel').disabled = !testing;
    el('aiTest').textContent = testing ? '测试中…' : '测试连接';
    el('aiSettings').setAttribute('aria-busy', String(value));
  }
  function preview() {
    try { el('aiEndpoint').textContent = ai.endpoint(el('aiAddress').value).endpoint; }
    catch { el('aiEndpoint').textContent = el('aiAddress').value.trim() ? '地址无效，请检查填写格式' : '填写地址后显示实际请求地址'; }
  }
  function apply(config) {
    saved = config;
    el('aiAddress').value = config.address;
    el('aiModel').value = config.model;
    el('aiKey').value = '';
    el('aiKey').placeholder = config.hasKey ? '已保存；留空保留，输入新密钥替换' : '填写自己的 API 密钥';
    preview();
  }
  async function send(message) {
    try {
      const result = await chrome.runtime.sendMessage(message);
      return result || { ok: false, error: '扩展未响应，请重新打开设置。' };
    } catch { return { ok: false, error: '与扩展后台的连接中断，请重新打开设置。请求不会自动重试。' }; }
  }
  async function execute(type) {
    if (busy) return;
    let settings, target;
    try {
      settings = draft();
      target = ai.config(settings, { endpoint: saved.address, key: saved.hasKey ? 'stored-key' : '' });
    } catch (error) { status(ai.failure(error).error, 'error'); return; }
    lock(true);
    status('正在确认 API 域名访问权限…');
    try {
      // Call directly in the click handler, before any await, preserving user activation.
      const granted = await chrome.permissions.request({ origins: [target.permission] });
      if (!granted) { status(ai.failure(new ai.AIError('permission')).error, 'error'); return; }
      if (type === 'ai:test') {
        requestId = crypto.randomUUID();
        lock(true, true);
        status('正在发送固定样题，最多等待 25 秒…');
      }
      const result = await send({ type, config: settings, ...(requestId ? { requestId } : {}) });
      if (!result.ok) status(result.error, 'error');
      else if (type === 'ai:save') {
        apply(result.config);
        status('已保存到当前浏览器。', 'success');
      } else status(`连接成功（${(result.elapsedMs / 1000).toFixed(1)} 秒）。已收到有效回答；这不代表作业答案正确。测试不会保存配置。`, 'success');
    } catch { status('无法获得域名访问权限，请重新打开设置后重试。', 'error'); }
    finally { requestId = null; lock(false); }
  }
  el('aiSave').addEventListener('click', () => execute('ai:save'));
  el('aiTest').addEventListener('click', () => execute('ai:test'));
  el('aiCancel').addEventListener('click', async () => {
    if (!requestId) return;
    const cancellingId = requestId;
    el('aiCancel').disabled = true;
    const result = await send({ type: 'ai:cancel', requestId });
    if (!result.ok && requestId === cancellingId) { status(result.error, 'error'); el('aiCancel').disabled = false; }
  });
  el('aiDelete').addEventListener('click', async () => {
    if (busy) return;
    lock(true);
    const result = await send({ type: 'ai:delete' });
    if (result.ok) { apply(result.config); status('已删除本机 AI 配置和密钥。'); }
    else status(result.error, 'error');
    lock(false);
  });
  fields.forEach(id => el(id).addEventListener('input', () => {
    preview();
    status('有未保存的修改；测试使用当前填写内容。');
  }));
  window.addEventListener('pagehide', () => {
    if (requestId) void send({ type: 'ai:cancel', requestId });
  });
  lock(true);
  send({ type: 'ai:get' }).then(result => {
    if (result.ok) { apply(result.config); status(saved.hasKey ? '已有本机配置；密钥不回显。' : '填写自己的服务信息后保存或测试。'); }
    else status(result.error, 'error');
    lock(false);
  });
})();
