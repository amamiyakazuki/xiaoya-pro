(function () {
  'use strict';
  const ai = globalThis.XiaoyaAI;
  const el = id => document.getElementById(id);
  const fields = ['aiAddress', 'aiKey', 'aiModel', 'aiVisionModel', 'aiVisionOk', 'aiPreset'];
  const PRESETS = [
    { key: 'custom', label: '自定义', address: '' },
    { key: 'deepseek', label: 'DeepSeek', address: 'https://api.deepseek.com', model: 'deepseek-flash',
      vision: 'deepseek-flash', hint: 'deepseek-flash 原生支持图片，闲时半价' },
    { key: 'zhipu', label: '智谱 BigModel', address: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash',
      vision: 'glm-4v-flash', hint: '文本模型免费；识图可用 glm-4v-flash（同样免费）' },
    { key: 'siliconflow', label: '硅基流动', address: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen3-8B',
      hint: '9B 及以下模型免费；视觉模型按量付费' },
    { key: 'dashscope', label: '阿里百炼', address: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus',
      vision: 'qwen-vl-plus', hint: '必须填兼容模式地址；图片题建议用 qwen-vl-plus' },
    { key: 'ark', label: '火山方舟', address: 'https://ark.cn-beijing.volces.com/api/v3', model: '',
      modelPlaceholder: '控制台的接入点 ID（ep-…）', hint: '模型要填接入点 ID，不是 doubao-xxx' },
    { key: 'ollama', label: 'Ollama（本地）', address: 'http://localhost:11434/v1', model: 'qwen3:8b',
      vision: 'qwen2.5vl:7b', hint: '本机运行，密钥随便填一个即可' },
    { key: 'openrouter', label: 'OpenRouter', address: 'https://openrouter.ai/api/v1', model: '',
      modelPlaceholder: '模型 ID，免费款以 :free 结尾', hint: '一个 key 可调多家模型' },
    { key: 'gemini', label: 'Google Gemini', address: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash',
      vision: 'gemini-2.5-flash', hint: '需要能访问 Google；免费层识图较强' }
  ];
  const MODEL_PLACEHOLDER = '填写服务商提供的模型名称';
  // 保存的是补齐后的完整请求地址，按规范化结果反查预设。
  const presetFor = value => {
    const raw = (value || '').trim();
    if (!raw) return PRESETS[0];
    let normalized = '';
    try { normalized = ai.endpoint(raw).endpoint; } catch { return PRESETS.find(item => item.address === raw) || PRESETS[0]; }
    return PRESETS.find(item => {
      if (!item.address) return false;
      try { return ai.endpoint(item.address).endpoint === normalized; } catch { return false; }
    }) || PRESETS[0];
  };
  let saved = { address: '', model: '', hasKey: false, visionModel: '', visionOk: true }, busy = false, requestId = null;
  const draft = () => ({ address: el('aiAddress').value, key: el('aiKey').value, model: el('aiModel').value,
    visionModel: el('aiVisionModel').value, visionOk: el('aiVisionOk').checked });
  const applyPreset = (preset, fill) => {
    const option = [...el('aiPreset').options].find(item => item.value === preset.key);
    if (option) option.selected = true;
    el('aiPresetHint').textContent = preset.hint || '';
    el('aiModel').placeholder = preset.modelPlaceholder || MODEL_PLACEHOLDER;
    el('aiVisionModel').placeholder = preset.vision ? `如 ${preset.vision}；留空则由主模型处理图片` : '如 glm-4v-flash；留空则由主模型处理图片';
    if (fill) {
      el('aiAddress').value = preset.address;
      el('aiModel').value = preset.model || '';
    }
  };
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
    el('aiVisionModel').value = config.visionModel || '';
    el('aiVisionOk').checked = config.visionOk !== false;
    applyPreset(presetFor(config.address), false);
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
  el('aiPreset').innerHTML = PRESETS.map(preset => `<option value="${preset.key}">${preset.label}</option>`).join('');
  el('aiPreset').addEventListener('change', () => {
    const preset = PRESETS.find(item => item.key === el('aiPreset').value);
    if (!preset) return;
    applyPreset(preset, Boolean(preset.address));
    preview();
    if (preset.address) status('已填入预设地址，填写密钥后保存或测试。');
  });
  el('aiAddress').addEventListener('input', () => {
    const preset = presetFor(el('aiAddress').value);
    if (el('aiPreset').value !== preset.key) applyPreset(preset, false);
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
