const { test } = require('node:test');
const assert = require('node:assert/strict');
const schema = require('../extension/ai-question.js');
const client = require('../extension/ai-client.js');
const { createService } = require('../extension/ai-service.js');
const { extract } = require('../extension/answer-dom.js');
const question = { id: 'question_123', type: 'single', stem: '1+1=?', options: [{ label: 'A', text: '2' }, { label: 'B', text: '3' }] };
const panel = { id: 'extension', url: 'chrome-extension://extension/sidepanel.html', documentId: 'panel' };
const page = { id: 'extension', url: 'https://whut.ai-augmented.com/app/jx-web/course_paper/mycourse/1/2/3/4', tab: { id: 10 }, frameId: 0, documentId: 'page' };
function fixture(options = {}) {
  let saved; const calls = [];
  const chrome = { runtime: { id: 'extension', getURL: file => `chrome-extension://extension/${file}` },
    storage: { local: { async setAccessLevel() {}, async get(key) { return { [key]: saved }; }, async set(data) { saved = data.xiaoyaAIConfig; }, async remove() { saved = null; } } },
    permissions: { async contains() { return options.permission !== false; } } };
  const service = createService({ chrome, client, timeoutMs: options.timeoutMs ?? 1000, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return options.fetchImpl ? options.fetchImpl(url, init) : new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ answer: ['A'], explanation: '相加得二。' }) } }] }));
  } });
  const send = (type, extra = {}, sender = page) => service.handle({ type: `ai:${type}`, ...extra }, sender);
  const save = () => send('save', { config: { address: 'https://example.com', key: 'private-key', model: 'model' } }, panel);
  return { send, save, calls };
}
const waitFor = async fn => { for (let i = 0; i < 40 && !fn(); i++) await new Promise(r => setTimeout(r, 2)); assert.ok(fn()); };
test('only exact platform assignment/resource routes qualify', () => {
  assert.ok(schema.isPage(page.url));
  assert.ok(schema.isPage('https://whut.ai-augmented.com/app/jx-web/mycourse/1/resource/_/2?preview=1'));
  for (const url of ['https://evil.test/app/jx-web/course_paper/mycourse/1/2/3/4', 'http://whut.ai-augmented.com/app/jx-web/course_paper/mycourse/1/2/3/4', 'https://whut.ai-augmented.com/app/jx-web/mycourse', page.url + '/extra']) assert.equal(schema.isPage(url), false);
});
test('question validation strips extra fields and limits size/options/identity', () => {
  assert.deepEqual(schema.validate({ ...question, manualAnswer: 'secret', key: 'secret' }), question);
  for (const bad of [{ ...question, id: 'question_content' }, { ...question, type: 'fill' }, { ...question, stem: 'x'.repeat(24001) }, { ...question, options: [{ label: 'X', text: '2' }] }, { ...question, options: question.options.slice(0, 1) }]) assert.throws(() => schema.validate(bad));
  assert.deepEqual(schema.validate({ ...question, type: 'short', options: [] }).options, []);
});
test('answers must match real options, cardinality and explanation; no unparsed fallback', () => {
  assert.equal(schema.answer('```json\n{"answer":["A"],"explanation":"ok"}\n```', question).answer, 'A. 2');
  for (const answer of [null, 'A', [], ['C'], ['A', 'A'], ['A', 'B']]) assert.throws(() => schema.answer(JSON.stringify({ answer, explanation: 'ok' }), question));
  assert.throws(() => schema.answer('{"answer":["A"],"explanation":""}', question));
  assert.throws(() => schema.answer('答案 A', question));
  assert.equal(schema.answer('{"answer":["B","A"],"explanation":"ok"}', { ...question, type: 'multiple' }).answer, 'B. 3\nA. 2');
  assert.equal(schema.answer('{"answer":"<img onerror=evil>","explanation":"text"}', { ...question, type: 'short' }).answer, '<img onerror=evil>');
});
test('availability exposes only a boolean and revision; missing config sends nothing', async () => {
  const f = fixture();
  assert.equal((await f.send('available')).available, false);
  assert.equal((await f.send('query', { requestId: 'r', question })).code, 'unconfigured');
  await f.save();
  const state = await f.send('available');
  assert.deepEqual(Object.keys(state).sort(), ['available', 'ok', 'revision']);
  assert.equal(state.available, true); assert.equal(f.calls.length, 0);
});
test('content messages require platform top-frame sender; cannot read/configure credentials', async () => {
  const f = fixture(); await f.save();
  for (const sender of [panel, { ...page, frameId: 1 }, { ...page, tab: null }, { ...page, id: 'other' }, { ...page, url: 'https://evil.test/' }]) {
    for (const type of ['available', 'query', 'query-cancel']) assert.equal((await f.send(type, { requestId: 'x', question }, sender)).code, 'forbidden');
  }
  for (const type of ['get', 'save', 'delete', 'test']) assert.equal((await f.send(type, {}, page)).code, 'forbidden');
  assert.equal(f.calls.length, 0);
});
test('question query uses saved credentials only, excludes manual answer and returns matched result', async () => {
  const f = fixture(); await f.save();
  const result = await f.send('query', { requestId: 'q1', question: { ...question, manualAnswer: 'student-private' }, config: { address: 'https://evil.test', key: 'other' } });
  assert.equal(result.result.answer, 'A. 2');
  const { url, init } = f.calls[0];
  assert.equal(url, 'https://example.com/v1/chat/completions');
  assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
  assert.equal(init.headers.Authorization, 'Bearer private-key');
  assert.ok(!init.body.includes('student-private')); assert.ok(!init.body.includes('question_123'));
  assert.ok(!JSON.stringify(result).includes('private-key'));
});
test('invalid questions and unmatched AI answers fail closed', async () => {
  const f = fixture(); await f.save();
  assert.equal((await f.send('query', { requestId: 'q', question: { ...question, options: [] } })).code, 'question');
  assert.equal(f.calls.length, 0);
  const other = fixture({ fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'private-key garbage' } }] })) });
  await other.save(); const result = await other.send('query', { requestId: 'q', question });
  assert.equal(result.code, 'answer'); assert.ok(!JSON.stringify(result).includes('private-key'));
});
test('query ownership prevents other tabs cancelling; busy and cancellation do not retry', async () => {
  const f = fixture({ fetchImpl: () => new Promise(() => {}) }); await f.save();
  const pending = f.send('query', { requestId: 'q', question }); await waitFor(() => f.calls.length);
  assert.equal((await f.send('query', { requestId: 'q2', question })).code, 'busy');
  await f.send('query-cancel', { requestId: 'q' }, { ...page, tab: { id: 11 } });
  assert.equal(f.calls[0].init.signal.aborted, false);
  await f.send('query-cancel', { requestId: 'q' }); assert.equal((await pending).code, 'cancelled');
  assert.equal(f.calls.length, 1);
});
test('config deletion cancels in-flight query and changes cache revision', async () => {
  const f = fixture({ fetchImpl: () => new Promise(() => {}) }); await f.save();
  const before = await f.send('available');
  const pending = f.send('query', { requestId: 'q', question }); await waitFor(() => f.calls.length);
  await f.send('delete', {}, panel);
  assert.equal((await pending).code, 'cancelled');
  const after = await f.send('available'); assert.equal(after.available, false); assert.notEqual(after.revision, before.revision);
});
test('query times out once and permission revocation prevents transmission', async () => {
  const f = fixture({ timeoutMs: 10, fetchImpl: () => new Promise(() => {}) }); await f.save();
  assert.equal((await f.send('query', { requestId: 'q', question })).code, 'timeout'); assert.equal(f.calls.length, 1);
  const opts = {}; const other = fixture(opts); await other.save(); opts.permission = false;
  assert.equal((await other.send('available')).available, false);
  assert.equal((await other.send('query', { requestId: 'q', question })).code, 'permission'); assert.equal(other.calls.length, 0);
});
function dom({ type = 'single', image = false, extraId = false, label = 'A.', stem = '1+1=?' } = {}) {
  const { parseHTML } = require('linkedom');
  const esc = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const cls = { single: 'single', multiple: 'multiple', short: 'subjective', attach: 'attach' }[type];
  const { document } = parseHTML(`<html><body><div class="question"><div class="exam_question_stem"><div class="stem_title">${esc(stem)}${image ? '<img src="data:image/png;base64,aGVsbG8=">' : ''}</div></div><div class="question_${cls}_subject" id="question_123">${['single', 'multiple'].includes(type) ? [label, 'B.'].map((value,i) => `<label class="ant-${type === 'multiple' ? 'checkbox' : 'radio'}-wrapper"><span class="exam_answer_item_sequence">${value}</span><div class="xy_rich_text_base">${i ? '3' : '2'}</div></label>`).join('') : ''}</div>${extraId ? '<div id="question_456"></div>' : ''}</div></body></html>`);
  return document.querySelector('.question');
}
test('DOM adapter extracts only stem/options, handles numeric IDs and rejects unsupported structures', () => {
  assert.deepEqual(extract(dom()).question, question);
  assert.equal(extract(dom({ type: 'short' })).question.options.length, 0);
  assert.equal(extract(dom({ type: 'multiple' })).question.type, 'multiple');
  assert.equal(extract(dom({ image: true })).resources.length, 1);
  assert.equal(extract(dom({ type: 'attach' })).question.type, 'attachment');
  assert.ok(extract(dom({ stem: '$$ x $$' })).question);
  for (const options of [{ extraId: true }, { label: 'Z.' }]) assert.ok(extract(dom(options)).error);
});
test('per-question instructions travel only with that query; length/type limits fail before sending', async () => {
  const f = fixture(); await f.save();
  await f.send('query', { requestId: 'q1', question, instructions: '100 字以内，分三点。' });
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal(JSON.parse(body.messages[1].content).requirements, '100 字以内，分三点。');
  await f.send('query', { requestId: 'q2', question });
  assert.equal(JSON.parse(JSON.parse(f.calls[1].init.body).messages[1].content).requirements, '');
  for (const instructions of ['x'.repeat(2001), { text: 'bad' }]) assert.equal((await f.send('query', { requestId: 'bad', question, instructions })).code, 'question');
  assert.equal(f.calls.length, 2);
});

function uiFixture() {
  const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.handlers = {}; this.isConnected = true; this.value = ''; this.textContent = ''; }
    append(...items) { this.children.push(...items); }
    attachShadow() { this.shadow = new Element('shadow'); return this.shadow; }
    setAttribute(key, value) { this[key] = value; }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    remove() { this.isConnected = false; }
    click(trusted = true) { this.handlers.click?.({ isTrusted: trusted }); }
  }
  const node = dom(); Object.defineProperty(node, 'children', { value: [] }); node.append = item => node.children.push(item);
  const location = { href: page.url }; let tick, changed, configured = true, revision = 'v1'; const sent = [], pending = [];
  const elements = [];
  const document = { body: {}, querySelectorAll: () => [node], createElement: tag => { const e = new Element(tag); elements.push(e); return e; } };
  const context = vm.createContext({ URL, document, location, XiaoyaQuestion: schema, XiaoyaAnswerDOM: require('../extension/answer-dom.js'), AbortController, crypto: require('node:crypto'), Date, setTimeout, clearTimeout,
    setInterval: fn => { tick = fn; return 1; }, clearInterval() {}, addEventListener() {}, MutationObserver: class { observe() {} disconnect() {} },
    chrome: { runtime: { onMessage: { addListener: fn => { changed = fn; } }, async sendMessage(message) {
      sent.push(message);
      if (message.type === 'ai:available') return { ok: true, available: configured, revision };
      if (message.type === 'ai:query') return new Promise(resolve => pending.push(resolve));
      return { ok: true };
    } } }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/answer-float.js'), 'utf8'), context);
  const find = (tag, text) => elements.filter(e => e.tag === tag && (!text || e.textContent === text)).at(-1);
  const resolve = () => pending.shift()({ ok: true, revision, result: { answer: 'A. 2', explanation: '<img onerror=bad>' } });
  return { node, location, sent, pending, find, resolve, tick: () => tick(), setConfig: value => { configured = value; revision += 'x'; changed({ type: 'ai:changed' }); } };
}
test('floating UI waits for trusted click, merges repeated opens, caches result and submits no form', async () => {
  const f = uiFixture(); await waitFor(() => f.find('button', '✦ AI 答案'));
  assert.equal(f.pending.length, 0);
  const button = f.find('button', '✦ AI 答案'); assert.equal(button.type, 'button');
  button.click(false); assert.equal(f.pending.length, 0);
  button.click(); button.click(); button.click(); assert.equal(f.pending.length, 1);
  f.resolve(); await new Promise(r => setImmediate(r));
  button.click(); button.click(); assert.equal(f.pending.length, 0);
  assert.ok(f.find('p', '解释：<img onerror=bad>'));
  f.find('textarea').value = '简洁一点'; assert.equal(f.pending.length, 0);
  f.find('button', '重新生成').click(); assert.equal(f.pending.length, 1);
  assert.equal(f.sent.filter(m => m.type === 'ai:query').at(-1).instructions, '简洁一点');
  assert.ok(f.sent.every(m => m.type.startsWith('ai:')));
  f.resolve();
});
test('floating UI cancels stale questions/routes and ignores delayed replies', async () => {
  const f = uiFixture(); await waitFor(() => f.find('button', '✦ AI 答案'));
  f.find('button', '✦ AI 答案').click();
  const oldHost = f.node.children[0];
  f.node.querySelector('.stem_title').textContent = 'new question'; f.tick();
  assert.equal(oldHost.isConnected, false);
  assert.equal(f.sent.filter(m => m.type === 'ai:query-cancel').length, 1);
  f.resolve(); await new Promise(r => setImmediate(r));
  assert.equal(f.find('p', 'A. 2'), undefined);
  f.find('button', '✦ AI 答案').click();
  f.location.href = 'https://whut.ai-augmented.com/app/jx-web/mycourse'; f.tick();
  assert.equal(f.sent.filter(m => m.type === 'ai:query-cancel').length, 2);
  f.resolve();
});
test('floating UI cancellation allows manual retry; configuration changes remove cached UI', async () => {
  const f = uiFixture(); await waitFor(() => f.find('button', '✦ AI 答案'));
  f.find('button', '✦ AI 答案').click(); f.find('button', '取消请求').click();
  assert.ok(f.find('p', '请求已取消，服务商可能已接收并计费。'));
  f.resolve(); await new Promise(r => setImmediate(r)); assert.equal(f.find('p', 'A. 2'), undefined);
  f.find('button', '重新生成').click(); f.setConfig(false);
  assert.equal(f.node.children[0].isConnected, false);
  f.resolve(); await new Promise(r => setImmediate(r));
  assert.ok(f.node.children.every(e => !e.isConnected));
});
test('floating controls stop preview ancestor handlers without preventing typing', async () => {
  const f = uiFixture(); await waitFor(() => f.node.children.length);
  const host = f.node.children[0]; let stops = 0;
  for (const type of ['click', 'pointerdown', 'keydown', 'input', 'change']) host.handlers[type]({ stopPropagation() { stops++; }, preventDefault() { throw Error('must preserve native input'); } });
  assert.equal(stops, 5);
});
