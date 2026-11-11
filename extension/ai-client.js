(function (root) {
  'use strict';
  const MESSAGES = Object.freeze({
    address: '请填写有效的 HTTPS API 地址；本机服务可使用 http://localhost 或 http://127.0.0.1。地址不能含账号、查询参数或片段。',
    key: '请填写 API 密钥；更换请求地址后需重新填写密钥。',
    model: '请填写有效的模型名称。',
    permission: '尚未获得此 API 域名的访问权限，请再次点击保存或测试并允许访问。',
    storage: '无法安全读取或保存 AI 配置，请重新加载扩展后重试。',
    forbidden: '当前页面无权执行此 AI 操作。',
    busy: '已有 AI 请求正在运行，请先取消或等待完成。',
    cancelled: 'AI 请求已取消。服务商可能已接收请求并计费。',
    timeout: 'AI 请求超过 25 秒，请检查服务状态或换用响应更快的模型。',
    auth: '密钥无效或没有访问权限（401/403），请检查密钥和模型权限。',
    target: 'API 地址、模型名称或请求参数不被服务接受（400/404/422），请核对服务商说明。',
    rate: '服务限流或额度不足（429），请稍后再试或检查额度。',
    server: 'AI 服务暂时异常（5xx），请稍后再试。',
    http: 'AI 服务未接受请求，请检查地址和服务状态。',
    network: '连接失败，请检查网络、API 地址及证书；不支持重定向地址。',
    format: '返回内容不是有效的 Chat Completions 回答，请确认接口兼容性。',
    empty: '服务返回了空回答，请检查模型或稍后再试。',
    truncated: '回答被截断，请重试或更换模型。',
    filtered: '服务未提供可用回答，可能受到内容限制。',
    size: '服务返回内容过大，请求已停止。',
    question: '题目内容不完整或超出大小限制，未发送给 AI。',
    vision: '服务未接受图片输入，请确认当前模型及接口支持 Chat Completions 图片输入，或检查图片大小。',
    answer: 'AI 回答无法对应题目或格式不完整，请手动重试。',
    unconfigured: '请先在扩展设置页保存 AI 配置。',
    unknown: 'AI 操作失败，请重试；若扩展刚更新，请重新打开设置。'
  });
  class AIError extends Error {
    constructor(code) { super(MESSAGES[code] || MESSAGES.unknown); this.code = code; }
  }
  function endpoint(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new AIError('address');
    let url;
    try { url = new URL(value.trim()); } catch { throw new AIError('address'); }
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
    if ((!local && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || /[\s\\]/.test(value.trim())) throw new AIError('address');
    let path = url.pathname.replace(/\/+$/, '');
    if (!path) path = '/v1';
    if (!path.endsWith('/chat/completions')) path += '/chat/completions';
    url.pathname = path;
    return { endpoint: url.href, origin: url.origin, permission: `${url.protocol}//${url.hostname}/*` };
  }
  function config(input, previous) {
    const target = endpoint(input?.address);
    const model = typeof input?.model === 'string' ? input.model.trim() : '';
    if (!model || model.length > 200 || /[\x00-\x1f\x7f]/.test(model)) throw new AIError('model');
    let key = typeof input?.key === 'string' ? input.key.trim() : '';
    if (!key && previous?.endpoint === target.endpoint) key = previous.key;
    if (!key || key.length > 4096 || !/^[\x21-\x7e]+$/.test(key)) throw new AIError('key');
    return { ...target, model, key };
  }
  function failure(error) {
    const code = error instanceof AIError && MESSAGES[error.code] ? error.code : 'unknown';
    return { ok: false, code, error: MESSAGES[code] };
  }
  async function readJSON(response) {
    const reader = response.body?.getReader();
    if (!reader) throw new AIError('format');
    const decoder = new TextDecoder();
    let bytes = 0, text = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 262144) { await reader.cancel(); throw new AIError('size'); }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    try { return JSON.parse(text); } catch { throw new AIError('format'); }
  }
  async function request(settings, { signal, fetchImpl = fetch, messages } = {}) {
    let response;
    try {
      response = await fetchImpl(settings.endpoint, {
        method: 'POST', signal, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.key}` },
        body: JSON.stringify({ model: settings.model, stream: false, messages })
      });
    } catch { throw new AIError(signal?.aborted ? 'cancelled' : 'network'); }
    if (!response.ok) {
      // Do not echo provider error bodies: gateways sometimes include credentials.
      await response.body?.cancel().catch(() => {});
      const status = response.status;
      throw new AIError([401, 403].includes(status) ? 'auth' : [400, 404, 422].includes(status) ? 'target' : status === 429 ? 'rate' : status >= 500 ? 'server' : 'http');
    }
    let data;
    try { data = await readJSON(response); }
    catch (error) {
      if (error instanceof AIError) throw error;
      throw new AIError(signal?.aborted ? 'cancelled' : 'network');
    }
    if (!Array.isArray(data?.choices)) throw new AIError('format');
    const choice = data?.choices?.[0];
    if (choice?.finish_reason === 'length') throw new AIError('truncated');
    if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) throw new AIError('filtered');
    if (!choice || choice.finish_reason !== 'stop' || typeof choice.message?.content !== 'string') throw new AIError('format');
    if (!choice.message.content.trim()) throw new AIError('empty');
    return choice.message.content.trim();
  }
  async function completion(settings, options) {
    await request(settings, { ...options, messages: [{ role: 'user', content: '连接测试：1+1等于多少？请只回复数字。' }] });
    return { ok: true };
  }
  async function query(settings, question, options = {}) {
    const schema = root.XiaoyaQuestion;
    let clean, requirements;
    try { clean = schema.validate(question); requirements = schema.instructions(options.instructions); } catch { throw new AIError('question'); }
    let text;
    try { text = await request(settings, { ...options, messages: schema.messages(clean, requirements) }); }
    catch (error) { if (clean.images?.length && error.code === 'target') throw new AIError('vision'); throw error; }
    try { return schema.answer(text, clean); } catch { throw new AIError('answer'); }
  }
  root.XiaoyaAI = Object.freeze({ AIError, endpoint, config, failure, completion, query });
  if (typeof module !== 'undefined') module.exports = root.XiaoyaAI;
})(globalThis);
