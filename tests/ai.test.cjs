const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const client = require('../extension/ai-client.js');
const { createService } = require('../extension/ai-service.js');
const KEY = 'xiaoyaAIConfig';
const config = { address: 'https://api.example.com/v1', key: 'test-private-key', model: 'example-model' };
const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/sidepanel.html', documentId: 'panel-1' };
const reply = (content = '2', finish_reason = 'stop') => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason }] }));
function fixture(options = {}) {
  const data = {}, calls = [], permissions = [], levels = [];
  const api = {
    runtime: { id: sender.id, getURL: file => `chrome-extension://${sender.id}/${file}` },
    storage: { local: {
      async setAccessLevel(value) { levels.push(value); if (options.storageFails) throw Error(config.key); },
      async get(key) { return { [key]: data[key] }; },
      async set(values) { Object.assign(data, structuredClone(values)); },
      async remove(key) { delete data[key]; }
    } },
    permissions: { async contains(value) { permissions.push(value); return options.permitted !== false; } }
  };
  const fetchImpl = async (...args) => { calls.push(args); return options.fetchImpl ? options.fetchImpl(...args) : reply(); };
  const service = createService({ chrome: api, client, fetchImpl, timeoutMs: options.timeoutMs ?? 1000 });
  return { data, calls, permissions, levels, api, fetchImpl, service,
    send: (type, extra = {}, from = sender) => service.handle({ type: `ai:${type}`, config, ...extra }, from) };
}
const waitFor = async predicate => {
  for (let i = 0; i < 30 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(predicate(), 'expected asynchronous operation to start');
};

test('API addresses normalize root, version, proxy path and full endpoint without duplication', () => {
  for (const [input, expected] of [
    ['https://api.example.com', 'https://api.example.com/v1/chat/completions'],
    ['https://api.example.com/v1/', 'https://api.example.com/v1/chat/completions'],
    ['https://api.example.com/proxy/v2', 'https://api.example.com/proxy/v2/chat/completions'],
    ['https://api.example.com/v1/chat/completions/', 'https://api.example.com/v1/chat/completions'],
    ['http://127.0.0.1:1234/v1', 'http://127.0.0.1:1234/v1/chat/completions']
  ]) assert.equal(client.endpoint(input).endpoint, expected);
  assert.equal(client.endpoint('http://localhost:1234').permission, 'http://localhost/*');
});
test('rejects unsafe addresses, URL credentials, query keys and header injection', () => {
  for (const address of ['http://api.example.com', 'javascript:alert(1)', 'ftp://example.com', 'https://u:p@example.com', 'https://example.com?key=secret', 'https://example.com/#secret', 'https://exa mple.com', 'https:\\example.com']) {
    assert.throws(() => client.endpoint(address), { code: 'address' });
  }
  assert.throws(() => client.config({ ...config, key: 'key\r\nInjected:yes' }), { code: 'key' });
  assert.throws(() => client.config({ ...config, model: '' }), { code: 'model' });
});
test('saved key is retained only for the exact normalized endpoint', () => {
  const previous = client.config(config);
  assert.equal(client.config({ ...config, key: '' }, previous).key, config.key);
  for (const address of ['https://other.example.com/v1', 'https://api.example.com/v2']) {
    assert.throws(() => client.config({ ...config, address, key: '' }, previous), { code: 'key' });
  }
});
test('configuration is persisted only in trusted local storage and is never returned', async () => {
  const f = fixture();
  const saved = await f.send('save');
  assert.equal(saved.ok, true);
  assert.equal(f.data[KEY].key, config.key);
  assert.deepEqual(f.levels, [{ accessLevel: 'TRUSTED_CONTEXTS' }]);
  assert.equal((await f.send('get')).config.hasKey, true);
  assert.ok(!JSON.stringify([saved, await f.send('get')]).includes(config.key));
  await f.send('save', { config: { ...config, key: '', model: 'new-model' } });
  assert.equal(f.data[KEY].key, config.key);
  assert.equal(f.data[KEY].model, 'new-model');
  await f.send('delete');
  assert.equal(f.data[KEY], undefined);
  assert.equal((await f.send('get')).config.hasKey, false);
});
test('content scripts, foreign senders and other extension pages cannot access AI commands', async () => {
  const f = fixture();
  await f.send('save');
  for (const from of [{ ...sender, url: 'https://whut.ai-augmented.com/' }, { ...sender, id: 'other' }, { ...sender, url: sender.url + '?x' }, {}]) {
    for (const type of ['get', 'save', 'test', 'delete', 'cancel']) {
      assert.equal((await f.send(type, { requestId: 'probe' }, from)).code, 'forbidden');
    }
  }
  assert.equal(f.data[KEY].key, config.key);
  assert.equal(f.calls.length, 0);
});
test('storage access failure is closed and never echoes the underlying error', async () => {
  const f = fixture({ storageFails: true });
  const result = await f.send('save');
  assert.equal(result.code, 'storage');
  assert.ok(!JSON.stringify(result).includes(config.key));
  assert.equal(f.data[KEY], undefined);
});
test('batch query exposes only classified errors to the saved task result', async () => {
  const f = fixture();
  await f.send('save');
  f.api.permissions.contains = async () => { throw Error(config.key); };
  await assert.rejects(f.service.querySaved({}, new AbortController().signal), error => {
    assert.equal(error.code, 'unknown');
    assert.ok(!error.message.includes(config.key));
    return true;
  });
  assert.equal(f.calls.length, 0);
});
test('permission denial prevents both persistence and requests', async () => {
  const f = fixture({ permitted: false });
  assert.equal((await f.send('save')).code, 'permission');
  assert.equal((await f.send('test', { requestId: 'denied' })).code, 'permission');
  assert.equal(f.data[KEY], undefined);
  assert.equal(f.calls.length, 0);
});
test('connection test sends only a fixed sample with credential isolation and does not save drafts', async () => {
  const f = fixture();
  const result = await f.send('test', { requestId: 'sample' });
  assert.equal(result.ok, true);
  const [url, request] = f.calls[0];
  assert.equal(url, 'https://api.example.com/v1/chat/completions');
  assert.equal(request.credentials, 'omit');
  assert.equal(request.redirect, 'error');
  assert.equal(request.referrerPolicy, 'no-referrer');
  assert.equal(request.headers.Authorization, `Bearer ${config.key}`);
  assert.deepEqual(JSON.parse(request.body), { model: config.model, stream: false, messages: [{ role: 'user', content: '连接测试：1+1等于多少？请只回复数字。' }] });
  assert.equal(f.data[KEY], undefined);
  assert.ok(!JSON.stringify(result).includes(config.key));
});
test('HTTP errors are classified without retries or provider body leaks', async () => {
  for (const [status, code] of [[401, 'auth'], [403, 'auth'], [400, 'target'], [404, 'target'], [422, 'target'], [429, 'rate'], [500, 'server'], [502, 'server'], [302, 'http']]) {
    const f = fixture({ fetchImpl: async () => new Response(config.key, { status }) });
    const result = await f.send('test', { requestId: 'http' });
    assert.equal(result.code, code);
    assert.ok(!JSON.stringify(result).includes(config.key));
    assert.equal(f.calls.length, 1);
  }
});
test('rejects malformed, empty, truncated, refused, tool-call and oversized responses', async () => {
  for (const [make, code] of [
    [() => new Response('<html>gateway error</html>'), 'format'],
    [() => new Response('{}'), 'format'],
    [() => new Response('{"choices":{"0":{"finish_reason":"stop","message":{"content":"2"}}}}'), 'format'],
    [() => reply(' '), 'empty'],
    [() => reply('2', 'length'), 'truncated'],
    [() => reply('2', 'content_filter'), 'filtered'],
    [() => reply(null, 'tool_calls'), 'format'],
    [() => reply('x'.repeat(262145)), 'size']
  ]) {
    const f = fixture({ fetchImpl: async () => make() });
    assert.equal((await f.send('test', { requestId: 'response' })).code, code);
  }
});
test('network exception text never reaches the panel', async () => {
  const f = fixture({ fetchImpl: async () => { throw Error(config.key); } });
  const result = await f.send('test', { requestId: 'network' });
  assert.equal(result.code, 'network');
  assert.ok(!JSON.stringify(result).includes(config.key));
});
test('a connection lost while reading the body is reported as a network error', async () => {
  const f = fixture({ fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.error(Error(config.key)); } })) });
  const result = await f.send('test', { requestId: 'broken-body' });
  assert.equal(result.code, 'network');
  assert.ok(!JSON.stringify(result).includes(config.key));
});
test('timeout aborts pending request and releases the test slot', async () => {
  const f = fixture({ timeoutMs: 15, fetchImpl: () => new Promise(() => {}) });
  assert.equal((await f.send('test', { requestId: 'slow' })).code, 'timeout');
  assert.equal(f.calls[0][1].signal.aborted, true);
  assert.equal((await f.send('test', { requestId: 'slow2' })).code, 'timeout');
});
test('cancel is immediate, owner-scoped, and late response cannot turn into success', async () => {
  let release;
  const f = fixture({ fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  const pending = f.send('test', { requestId: 'running' });
  await waitFor(() => f.calls.length === 1);
  assert.equal((await f.send('test', { requestId: 'second' })).code, 'busy');
  await f.send('cancel', { requestId: 'running' }, { ...sender, documentId: 'panel-2' });
  assert.equal(f.calls[0][1].signal.aborted, false);
  await f.send('cancel', { requestId: 'running' });
  assert.equal((await pending).code, 'cancelled');
  release(reply());
});
test('configuration deletion cancels a running test without waiting for network', async () => {
  const f = fixture({ fetchImpl: () => new Promise(() => {}) });
  await f.send('save');
  const pending = f.send('test', { requestId: 'delete-running' });
  await waitFor(() => f.calls.length === 1);
  assert.equal((await f.send('delete')).ok, true);
  assert.equal((await pending).code, 'cancelled');
  assert.equal(f.data[KEY], undefined);
});
test('cancel before configuration has loaded prevents a late network request', async () => {
  const f = fixture();
  const pending = f.send('test', { requestId: 'early' });
  await f.send('cancel', { requestId: 'early' });
  assert.equal((await pending).code, 'cancelled');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.calls.length, 0);
});
test('real worker routing keeps video stop responsive during an AI request', async () => {
  const f = fixture({ fetchImpl: () => new Promise(() => {}) });
  let listener;
  Object.assign(f.api.runtime, { onMessage: { addListener(fn) { listener = fn; } } });
  f.api.storage.session = { async get() { return {}; }, async set() {} };
  f.api.alarms = { create() {}, onAlarm: { addListener() {} } };
  f.api.tabs = { onUpdated: { addListener() {} }, onRemoved: { addListener() {} } };
  const context = vm.createContext({ chrome: f.api, URL, fetch: f.fetchImpl, AbortController, TextDecoder, setTimeout, clearTimeout });
  const extension = path.join(__dirname, '../extension');
  context.importScripts = (...names) => names.forEach(name => vm.runInContext(fs.readFileSync(path.join(extension, name), 'utf8'), context));
  vm.runInContext(fs.readFileSync(path.join(extension, 'worker.js'), 'utf8'), context);
  assert.doesNotThrow(() => listener({ type: 42 }, sender, () => assert.fail('invalid messages are ignored')));
  const send = message => new Promise(resolve => listener(message, sender, resolve));
  const pending = send({ type: 'ai:test', requestId: 'integrated', config });
  await waitFor(() => f.calls.length === 1);
  const stopped = await Promise.race([send({ type: 'stop' }), new Promise(resolve => setTimeout(() => resolve(null), 100))]);
  assert.equal(stopped?.ok, true);
  await send({ type: 'ai:cancel', requestId: 'integrated' });
  assert.equal((await pending).code, 'cancelled');
});

test('protocol-specific endpoints are rejected instead of being guessed', () => {
  for (const address of ['https://api.example.com/v1/messages', 'https://api.example.com/v1/responses',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent']) {
    assert.throws(() => client.endpoint(address), { code: 'protocol' });
  }
});

test('vision model and capability flag are kept in the saved configuration', () => {
  const saved = client.config({ ...config, visionModel: 'glm-4v-flash', visionOk: false });
  assert.equal(saved.visionModel, 'glm-4v-flash');
  assert.equal(saved.visionOk, false);
  assert.equal(client.config({ ...config, visionModel: 'glm-4v-flash' }, saved).visionOk, false, '省略时沿用已保存的开关');
  assert.equal(client.config(config).visionOk, true, '默认按主模型支持图片处理');
});

test('image questions use the vision model, or are skipped when vision is off', async () => {
  globalThis.XiaoyaQuestion = require('../extension/ai-question.js');
  const question = { id: 'question_1', type: 'single', stem: '如图选择正确答案', options: [{ label: 'A', text: '甲' }, { label: 'B', text: '乙' }],
    images: ['data:image/png;base64,AAAA'] };

  const f = fixture();
  await f.send('save', { config: { ...config, visionModel: 'vision-model' } });
  await f.service.querySaved(question, null).catch(() => {});
  assert.equal(f.calls.length, 1);
  const body = JSON.parse(f.calls[0][1].body);
  assert.equal(body.model, 'vision-model');

  const g = fixture();
  await g.send('save', { config: { ...config, visionOk: false } });
  const skipped = await g.service.querySaved(question, null).catch(error => error);
  assert.equal(skipped.code, 'images', '关闭图片识别且没有识图模型时整题不发送');
  assert.equal(g.calls.length, 0);
});

test('attachment queries get a longer timeout than regular questions', async () => {
  globalThis.XiaoyaQuestion = require('../extension/ai-question.js');
  const f = fixture({ timeoutMs: 20, fetchImpl: () => new Promise(() => {}) });
  await f.send('save');
  const pageSender = { id: sender.id, url: 'https://whut.ai-augmented.com/app/jx-web/course_paper/mycourse/1/2/3/4', tab: { id: 5 }, frameId: 0, documentId: 'page-1' };
  const question = { id: 'question_1', type: 'attachment', stem: '写一段代码', options: [] };
  let settled = false;
  const pending = f.send('query', { requestId: 'slow-1', question, slow: true }, pageSender).finally(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(settled, false, '附件题不应按普通的 20ms 超时中断');
  await f.send('query-cancel', { requestId: 'slow-1' }, pageSender);
  assert.equal((await pending).code, 'cancelled');
});

// ---- 流式输出与分阶段超时 ----
const pageSender = { id: sender.id, url: 'https://whut.ai-augmented.com/app/jx-web/course_paper/mycourse/1/2/3/4', tab: { id: 5 }, frameId: 0, documentId: 'page-1' };
const shortQuestion = { id: 'question_1', type: 'short', stem: '简述哈夫曼树的作用', options: [] };
const sseEvent = (delta, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`;
// chunks: 字符串立即发送；数字表示先等待这么多毫秒；null 表示之后不再发送也不结束。
function sse(chunks) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ async start(controller) {
    for (const chunk of chunks) {
      if (chunk === null) return;
      if (typeof chunk === 'number') { await new Promise(resolve => setTimeout(resolve, chunk)); continue; }
      controller.enqueue(encoder.encode(chunk));
    }
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
function streamFixture(options) {
  globalThis.XiaoyaQuestion = require('../extension/ai-question.js');
  const f = fixture(options);
  const progress = [];
  f.api.tabs = { sendMessage: async (tabId, message, target) => { progress.push({ tabId, message, target }); } };
  return { ...f, progress };
}
const answerJSON = JSON.stringify({ answer: '按频率构造最优前缀编码，\n高频字符用短码。', explanation: '哈夫曼编码的带权路径长度最小。' });

test('queries stream the answer and relay stages, counts and a live preview to the asking page', async () => {
  const f = streamFixture({ fetchImpl: async () => sse([
    ': keep-alive\n\n',
    sseEvent({ role: 'assistant', reasoning_content: '先回忆定义' }),
    sseEvent({ content: answerJSON.slice(0, 20) }), 5,
    sseEvent({ content: answerJSON.slice(20) }),
    sseEvent({}, 'stop'), 'data: [DONE]\n\n'
  ]) });
  await f.send('save');
  const result = await f.send('query', { requestId: 'stream-1', question: shortQuestion }, pageSender);
  assert.equal(result.ok, true);
  assert.match(result.result.answer, /最优前缀编码/);
  assert.equal(JSON.parse(f.calls[0][1].body).stream, true, '题目查询使用流式请求');
  const stages = f.progress.map(item => item.message.stage);
  for (const stage of ['waiting', 'thinking', 'writing', 'parsing']) assert.ok(stages.includes(stage), `应回报 ${stage} 阶段`);
  assert.ok(f.progress.every(item => item.tabId === 5 && item.target.frameId === 0 && item.target.documentId === 'page-1'), '只发回发起请求的页面');
  assert.ok(f.progress.every(item => item.message.requestId === 'stream-1'));
  const writing = f.progress.filter(item => item.message.stage === 'writing').at(-1).message;
  assert.ok(writing.chars > 0);
  assert.match(f.progress.at(-1).message.preview, /高频字符用短码/, '预览取自 answer 字段，换行已还原');
  assert.ok(!JSON.stringify(f.progress).includes(config.key), '进度消息不含密钥');
});

test('a stream that goes quiet is stopped as stalled, while a steadily writing stream is never cut off', async () => {
  const quiet = streamFixture({ timeoutMs: 30, fetchImpl: async () => sse([sseEvent({ content: '{"answer":"写到一半' }), null]) });
  await quiet.send('save');
  const stalled = await quiet.send('query', { requestId: 'quiet', question: shortQuestion }, pageSender);
  assert.equal(stalled.code, 'stalled');

  // 每 10ms 一段、共约 120ms，远超 30ms 的等待上限，但一直在输出。
  const pieces = answerJSON.match(/.{1,6}/gs).flatMap(piece => [10, sseEvent({ content: piece })]);
  const busy = streamFixture({ timeoutMs: 30, fetchImpl: async () => sse([...pieces, sseEvent({}, 'stop'), 'data: [DONE]\n\n']) });
  await busy.send('save');
  const done = await busy.send('query', { requestId: 'busy', question: shortQuestion }, pageSender);
  assert.equal(done.ok, true, '持续输出时不按总时长中断');
});

test('no response at all still reports a timeout; truncation and dropped connections are classified', async () => {
  const silent = streamFixture({ timeoutMs: 20, fetchImpl: () => new Promise(() => {}) });
  await silent.send('save');
  assert.equal((await silent.send('query', { requestId: 'silent', question: shortQuestion }, pageSender)).code, 'timeout');

  const cut = streamFixture({ fetchImpl: async () => sse([sseEvent({ content: '{"answer":"太长' }), sseEvent({}, 'length'), 'data: [DONE]\n\n']) });
  await cut.send('save');
  assert.equal((await cut.send('query', { requestId: 'cut', question: shortQuestion }, pageSender)).code, 'truncated');

  const dropped = streamFixture({ fetchImpl: async () => sse([sseEvent({ content: '{"answer":"断' })]) });
  await dropped.send('save');
  assert.equal((await dropped.send('query', { requestId: 'dropped', question: shortQuestion }, pageSender)).code, 'network');
});

test('providers that ignore stream and return one JSON body still work', async () => {
  const f = streamFixture({ fetchImpl: async () => reply(answerJSON) });
  await f.send('save');
  const result = await f.send('query', { requestId: 'plain', question: shortQuestion }, pageSender);
  assert.equal(result.ok, true);
  assert.match(result.result.answer, /最优前缀编码/);
});

test('peek extracts the partially written answer from incomplete JSON', () => {
  assert.equal(client.peek(''), '');
  assert.equal(client.peek('{"answer'), '');
  assert.equal(client.peek('{"answer": "第一行\\n第二'), '第一行\n第二');
  assert.equal(client.peek('{"answer":"含\\"引号\\"和\\u4e2d文","explanation":"x"}'), '含"引号"和中文');
  assert.equal(client.peek('{"answer":"末尾半个转义\\'), '末尾半个转义');
  assert.equal(client.peek('{"answer":["A","C"],"explanation":"x"}'), '["A","C"]');
});
