(function (root) {
  'use strict';
  const KEY = 'xiaoyaAIConfig';
  function createService({ chrome: api = chrome, client = root.XiaoyaAI, fetchImpl = fetch, timeoutMs = 25000 } = {}) {
    const { AIError } = client;
    let edits = Promise.resolve(), active = null;
    let revision = `${Date.now()}-${Math.random()}`;
    const owner = sender => `${sender.tab?.id ?? 'panel'}:${sender.frameId ?? 0}:${sender.documentId || sender.url}`;
    const page = sender => sender?.id === api.runtime.id && Number.isInteger(sender.tab?.id) && sender.frameId === 0 && root.XiaoyaQuestion?.isPage(sender.url);
    function changed() {
      revision = `${Date.now()}-${Math.random()}`;
      // Broadcast only a signal; never send configuration or credentials.
      api.tabs?.query({ url: 'https://whut.ai-augmented.com/*' }).then(tabs => {
        for (const tab of tabs) api.tabs.sendMessage(tab.id, { type: 'ai:changed' }).catch(() => {});
      }).catch(() => {});
    }
    // local storage is shared with content scripts unless explicitly restricted.
    // Existing content scripts use messages/session data, not storage.local.
    const ready = Promise.resolve().then(() => api.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })).then(() => true, () => false);
    const trusted = sender => sender?.id === api.runtime.id && sender.url === api.runtime.getURL('sidepanel.html');
    const summary = saved => saved ? { address: saved.endpoint, model: saved.model, hasKey: Boolean(saved.key),
      visionModel: saved.visionModel || '', visionOk: saved.visionOk !== false } : { address: '', model: '', hasKey: false, visionModel: '', visionOk: true };
    async function read() {
      if (!await ready) throw new AIError('storage');
      try { return (await api.storage.local.get(KEY))[KEY]; } catch { throw new AIError('storage'); }
    }
    function cancel() { active?.controller.abort(); }
    function edit(action) {
      cancel();
      const result = edits.then(action);
      edits = result.catch(() => {});
      return result;
    }
    async function permitted(settings) {
      if (!await api.permissions.contains({ origins: [settings.permission] })) throw new AIError('permission');
    }
    async function test(message, sender, query = false) {
      if (active) throw new AIError('busy');
      if (typeof message.requestId !== 'string' || !/^[\w-]{1,100}$/.test(message.requestId)) throw new AIError('format');
      const job = { requestId: message.requestId, owner: owner(sender), controller: new AbortController() };
      active = job;
      let timer, capTimer, expired = '';
      const aborted = new Promise((_, reject) => job.controller.signal.addEventListener('abort', () => reject(new AIError(expired || 'cancelled')), { once: true }));
      // 附件题要生成整段代码，给更长的等待时间。
      // limit 同时用作「首次响应」和「两段内容之间」的等待上限；只要还在持续输出就不会被打断。
      const limit = message.slow === true ? Math.max(timeoutMs, 60000) : timeoutMs;
      // 总时长上限留在扩展后台单次事件的 5 分钟限制之内。
      const cap = Math.max(limit, message.slow === true ? 270000 : 120000);
      const expire = code => { expired = code; job.controller.abort(); };
      const arm = code => { clearTimeout(timer); timer = setTimeout(() => expire(code), limit); };
      const progress = relay(message.requestId, sender, query);
      const onProgress = update => {
        if (job.controller.signal.aborted) return;
        // 已收到服务端内容后，计时从「等待响应」切换为「生成停顿」。
        if (update.stage !== 'waiting') arm('stalled');
        progress(update);
      };
      const work = async () => {
        await edits;
        const previous = await read();
        if (job.controller.signal.aborted) throw new AIError('cancelled');
        if (query && !previous) throw new AIError('unconfigured');
        let settings = query ? client.config({ address: previous.endpoint, key: previous.key, model: previous.model,
          visionModel: previous.visionModel, visionOk: previous.visionOk }) : client.config(message.config, previous);
        if (query && Array.isArray(message.question?.images) && message.question.images.length) {
          if (previous?.visionModel) settings = { ...settings, model: previous.visionModel };
          else if (previous?.visionOk === false) throw new AIError('images');
        }
        await permitted(settings);
        if (job.controller.signal.aborted) throw new AIError('cancelled');
        const options = { signal: job.controller.signal, fetchImpl, instructions: message.instructions, onProgress };
        return query ? client.query(settings, message.question, options) : client.completion(settings, options);
      };
      try {
        arm('timeout');
        capTimer = setTimeout(() => expire('overtime'), cap);
        const started = Date.now();
        const result = await Promise.race([work(), aborted]);
        return query ? { ok: true, result, revision } : { ok: true, elapsedMs: Date.now() - started };
      } finally {
        clearTimeout(timer);
        clearTimeout(capTimer);
        progress.flush();
        if (active === job) active = null;
      }
    }
    // 把查询进度发回发起请求的页面；按 250ms 节流，阶段变化立即发送。只发阶段、计数和答案预览，不含配置。
    function relay(requestId, sender, query) {
      const tabId = sender?.tab?.id;
      const target = query && Number.isInteger(tabId) && typeof api.tabs?.sendMessage === 'function';
      let last = 0, lastStage = '', pending = null, timer = null;
      const post = update => {
        last = Date.now(); lastStage = update.stage; pending = null;
        const options = sender.documentId ? { frameId: 0, documentId: sender.documentId } : { frameId: 0 };
        const preview = client.peek(update.text).slice(-1500);
        api.tabs.sendMessage(tabId, { type: 'ai:progress', requestId, stage: update.stage, chars: update.chars, reasoning: update.reasoning, preview }, options).catch(() => {});
      };
      const send = update => {
        if (!target) return;
        clearTimeout(timer);
        if (update.stage !== lastStage || Date.now() - last >= 250) { post(update); return; }
        pending = update;
        timer = setTimeout(() => pending && post(pending), 250 - (Date.now() - last));
      };
      send.flush = () => { clearTimeout(timer); pending = null; };
      return send;
    }
    async function handle(message, sender) {
      try {
        if (['ai:available', 'ai:query', 'ai:query-cancel'].includes(message.type)) {
          if (!page(sender)) throw new AIError('forbidden');
          if (message.type === 'ai:query-cancel') {
            if (active?.requestId === message.requestId && active.owner === owner(sender)) cancel();
            return { ok: true };
          }
          if (message.type === 'ai:available') {
            await edits;
            const saved = await read();
            const available = Boolean(saved?.key && await api.permissions.contains({ origins: [saved.permission] }));
            return { ok: true, available, revision };
          }
          return await test(message, sender, true);
        }
        if (!trusted(sender)) throw new AIError('forbidden');
        if (message.type === 'ai:cancel') {
          if (active?.requestId === message.requestId && active.owner === owner(sender)) cancel();
          return { ok: true };
        }
        if (message.type === 'ai:get') { await edits; return { ok: true, config: summary(await read()) }; }
        if (message.type === 'ai:save') return await edit(async () => {
          const settings = client.config(message.config, await read());
          await permitted(settings);
          try { await api.storage.local.set({ [KEY]: settings }); } catch { throw new AIError('storage'); }
          changed();
          return { ok: true, config: summary(settings) };
        });
        if (message.type === 'ai:delete') return await edit(async () => {
          await read();
          try { await api.storage.local.remove(KEY); } catch { throw new AIError('storage'); }
          changed();
          return { ok: true, config: summary(null) };
        });
        if (message.type === 'ai:test') return await test(message, sender);
        throw new AIError('format');
      } catch (error) { return client.failure(error); }
    }
    return { handle,
      available: async () => { await edits; const saved = await read(); return Boolean(saved?.key && await api.permissions.contains({ origins: [saved.permission] })); },
      querySaved: async (question, signal) => {
        const sender = { documentId: 'answer-batch', url: 'internal:answer-batch' };
        const requestId = `batch-${Date.now()}`;
        const abort = () => { if (active?.requestId === requestId && active.owner === owner(sender)) cancel(); };
        if (signal?.aborted) throw new AIError('cancelled');
        signal?.addEventListener('abort', abort, { once: true });
        try { return (await test({ requestId, question }, sender, true)).result; }
        catch (error) { throw new AIError(client.failure(error).code); }
        finally { signal?.removeEventListener('abort', abort); }
      }
    };
  }
  root.XiaoyaAIService = { createService };
  if (typeof module !== 'undefined') module.exports = root.XiaoyaAIService;
})(globalThis);
