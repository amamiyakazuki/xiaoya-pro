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
    timeout: 'AI 服务没有响应（普通题 25 秒、附件题 60 秒内没收到任何内容），请检查服务状态或换用响应更快的模型。',
    stalled: '生成中断：长时间没有收到新内容（普通题 25 秒、附件题 60 秒），已停止。可重试或换用更快的模型。',
    overtime: '生成时间过长（普通题 2 分钟、附件题 4.5 分钟），已停止。可在补充要求里限制篇幅后重试。',
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
    images: '题目含图片，但当前配置未开启图片识别；本题不会发送，请手动查看或改用支持识图的模型。',
    protocol: '当前只支持 Chat Completions 兼容服务；这不是 Messages、Responses 或原生 Gemini 地址，请改填兼容地址或完整请求地址。',
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
    if (/(?:\/(?:messages|responses)|:generatecontent)\/?$/i.test(path)) throw new AIError('protocol');
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
    const visionModel = typeof input?.visionModel === 'string' ? input.visionModel.trim() : '';
    if (visionModel && (visionModel.length > 200 || /[\x00-\x1f\x7f]/.test(visionModel))) throw new AIError('model');
    const visionOk = input?.visionOk === undefined ? previous?.visionOk !== false : input.visionOk !== false;
    return { ...target, model, key, visionModel, visionOk };
  }
  function failure(error) {
    const code = error instanceof AIError && MESSAGES[error.code] ? error.code : 'unknown';
    return { ok: false, code, error: MESSAGES[code] };
  }
  async function readJSON(response, prefix = '') {
    const reader = response.body?.getReader();
    if (!reader) throw new AIError('format');
    const decoder = new TextDecoder();
    let bytes = prefix.length, text = prefix;
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
  // 一次性返回的 Chat Completions 结果（也用于不支持流式、直接回 JSON 的服务）。
  function settle(data) {
    if (!Array.isArray(data?.choices)) throw new AIError('format');
    const choice = data?.choices?.[0];
    if (choice?.finish_reason === 'length') throw new AIError('truncated');
    if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) throw new AIError('filtered');
    if (!choice || choice.finish_reason !== 'stop' || typeof choice.message?.content !== 'string') throw new AIError('format');
    if (!choice.message.content.trim()) throw new AIError('empty');
    return choice.message.content.trim();
  }
  const STREAM_BYTES = 4 * 1024 * 1024, STREAM_CHARS = 200000;
  // 读取 SSE 流：逐段累计正文和思考内容，每收到数据就回报进度（包括服务端的保活注释）。
  async function readStream(response, first, onProgress) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = first, bytes = first.length, content = '', reasoning = 0, finish = null, refusal = false, done = false;
    const report = stage => onProgress?.({ stage, chars: content.length, reasoning, text: content });
    const line = raw => {
      const text = raw.trim();
      if (!text.startsWith('data:')) return;
      const payload = text.slice(5).trim();
      if (payload === '[DONE]') { done = true; return; }
      let event;
      try { event = JSON.parse(payload); } catch { throw new AIError('format'); }
      if (event?.error) throw new AIError('server');
      const choice = event?.choices?.[0];
      if (!choice) return;
      const delta = choice.delta || {};
      if (typeof delta.content === 'string') content += delta.content;
      const thought = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : typeof delta.reasoning === 'string' ? delta.reasoning : '';
      reasoning += thought.length;
      if (delta.refusal) refusal = true;
      if (choice.finish_reason) finish = choice.finish_reason;
      if (content.length > STREAM_CHARS) throw new AIError('size');
    };
    const drain = () => {
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      lines.forEach(line);
    };
    try {
      drain();
      report(content ? 'writing' : reasoning ? 'thinking' : 'responding');
      while (!done) {
        const { done: ended, value } = await reader.read();
        if (ended) break;
        bytes += value.byteLength;
        if (bytes > STREAM_BYTES) { await reader.cancel(); throw new AIError('size'); }
        buffer += decoder.decode(value, { stream: true });
        drain();
        report(content ? 'writing' : reasoning ? 'thinking' : 'responding');
      }
      buffer += decoder.decode();
      if (buffer) line(buffer);
    } finally {
      if (done) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (finish === 'length') throw new AIError('truncated');
    if (finish === 'content_filter' || refusal) throw new AIError('filtered');
    // 没有结束标记又没有 finish_reason，说明连接中途断开。
    if (!done && !finish) throw new AIError('network');
    if (finish && finish !== 'stop') throw new AIError('format');
    if (!content.trim()) throw new AIError('empty');
    return content.trim();
  }
  async function request(settings, { signal, fetchImpl = fetch, messages, stream = false, onProgress } = {}) {
    let response;
    onProgress?.({ stage: 'waiting', chars: 0, reasoning: 0, text: '' });
    try {
      response = await fetchImpl(settings.endpoint, {
        method: 'POST', signal, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.key}` },
        body: JSON.stringify({ model: settings.model, stream, messages })
      });
    } catch { throw new AIError(signal?.aborted ? 'cancelled' : 'network'); }
    if (!response.ok) {
      // Do not echo provider error bodies: gateways sometimes include credentials.
      await response.body?.cancel().catch(() => {});
      const status = response.status;
      throw new AIError([401, 403].includes(status) ? 'auth' : [400, 404, 422].includes(status) ? 'target' : status === 429 ? 'rate' : status >= 500 ? 'server' : 'http');
    }
    try {
      if (stream && response.body) {
        // 先看第一段内容：以 data: 开头按流式解析，否则按普通 JSON 处理。
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let first = '';
        while (!first.trim()) {
          const { done, value } = await reader.read();
          if (done) break;
          first += decoder.decode(value, { stream: true });
          onProgress?.({ stage: 'responding', chars: 0, reasoning: 0, text: '' });
        }
        reader.releaseLock();
        const sse = /event-stream/i.test(response.headers?.get?.('content-type') || '') || /^\s*(?:data:|:)/.test(first);
        if (sse) return await readStream(response, first, onProgress);
        return settle(await readJSON(response, first));
      }
      return settle(await readJSON(response));
    } catch (error) {
      if (error instanceof AIError) throw error;
      throw new AIError(signal?.aborted ? 'cancelled' : 'network');
    }
  }
  // 解码从 index 开始、可能还没写完的 JSON 字符串（index 指向开头引号之后）。
  function decodeFrom(text, index) {
    let out = '';
    for (; index < text.length; index++) {
      const ch = text[index];
      if (ch === '"') break;
      if (ch !== '\\') { out += ch; continue; }
      const next = text[index + 1];
      if (next === undefined) break;
      if (next === 'u') {
        const hex = text.slice(index + 2, index + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
        out += String.fromCharCode(parseInt(hex, 16)); index += 5; continue;
      }
      out += { n: '\n', t: '\t', r: '', b: '', f: '' }[next] ?? next; index += 1;
    }
    return out;
  }
  // 从生成到一半的 JSON 里取出正在写的内容，用于实时预览。
  // 附件题显示最后一个文件的 content（附带文件名）；其他题型显示 answer 字段。
  function peek(text) {
    if (!text) return '';
    const contents = [...text.matchAll(/"content"\s*:\s*"/g)];
    if (contents.length) {
      const last = contents[contents.length - 1];
      const names = [...text.slice(0, last.index).matchAll(/"fileName"\s*:\s*"([^"\\]{1,120})"/g)];
      const name = names.length ? names[names.length - 1][1] : `文件 ${contents.length}`;
      return `【${name}】\n${decodeFrom(text, last.index + last[0].length)}`;
    }
    const match = /"answer"\s*:\s*/.exec(text);
    if (!match) return '';
    const index = match.index + match[0].length;
    if (text[index] !== '"') return text.slice(index, index + 2000).replace(/,\s*"explanation"[\s\S]*$/, '').trim();
    return decodeFrom(text, index + 1);
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
    try { text = await request(settings, { ...options, stream: true, messages: schema.messages(clean, requirements) }); }
    catch (error) { if (clean.images?.length && error.code === 'target') throw new AIError('vision'); throw error; }
    options.onProgress?.({ stage: 'parsing', chars: text.length, reasoning: 0, text });
    try { return schema.answer(text, clean); } catch { throw new AIError('answer'); }
  }
  root.XiaoyaAI = Object.freeze({ AIError, endpoint, config, failure, completion, query, peek });
  if (typeof module !== 'undefined') module.exports = root.XiaoyaAI;
})(globalThis);
