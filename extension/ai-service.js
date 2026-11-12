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
      let timer, expired = false;
      const aborted = new Promise((_, reject) => job.controller.signal.addEventListener('abort', () => reject(new AIError(expired ? 'timeout' : 'cancelled')), { once: true }));
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
        const options = { signal: job.controller.signal, fetchImpl, instructions: message.instructions };
        return query ? client.query(settings, message.question, options) : client.completion(settings, options);
      };
      try {
        timer = setTimeout(() => { expired = true; job.controller.abort(); }, timeoutMs);
        const started = Date.now();
        const result = await Promise.race([work(), aborted]);
        return query ? { ok: true, result, revision } : { ok: true, elapsedMs: Date.now() - started };
      } finally {
        clearTimeout(timer);
        if (active === job) active = null;
      }
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
