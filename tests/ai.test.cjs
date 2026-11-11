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
