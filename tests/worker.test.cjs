const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const taskData = require('../extension/task-data.js');

function worker({ connected = false, injectionFails = false, runReply = { ok: true }, url = 'https://whut.ai-augmented.com/app/jx-web/mycourse', loggedInHome = true, otherTabs = [], snapshot } = {}) {
  let listener, alarm, account = snapshot?.account;
  const data = {};
  const injected = [];
  const requests = [];
  const created = [];
  const updates = [];
  const recipients = [];
  const tabs = new Map([[1, { id: 1, url, status: 'complete' }], ...otherTabs.map(tab => [tab.id, tab])]);
  const context = vm.createContext({ URL, setTimeout, clearTimeout, crypto: { randomUUID() { return 'new-run'; } },
    chrome: {
      alarms: { create() {}, onAlarm: { addListener(fn) { alarm = fn; } } },
      runtime: { id: 'test', getURL: name => `chrome-extension://test/${name}`, onMessage: { addListener(fn) { listener = fn; } } },
      storage: { session: {
        async get() { return structuredClone(data); },
        async set(value) { Object.assign(data, structuredClone(value)); },
        async remove(key) { delete data[key]; }
      } },
      scripting: { async executeScript(options) {
        if (injectionFails) throw new Error('Cannot access page');
        injected.push(options);
        if (options.files.includes('content.js')) connected = true;
      } },
      tabs: {
        async get(id) { return { ...tabs.get(id) }; },
        async query() { return [...tabs.values()].filter(tab => tab.url.startsWith('https://whut.ai-augmented.com/')); },
        async create(options) { created.push(options); const tab = { id: 2, url: options.url, status: 'loading' }; tabs.set(2, tab); return tab; },
        async update(id, options) { updates.push({ id, ...options }); Object.assign(tabs.get(id), options); },
        async reload(id) { updates.push({ id, reload: true }); },
        onUpdated: { addListener() {}, removeListener() {} },
        async sendMessage(tabId, message) {
          requests.push(message.type);
          recipients.push(tabId);
          if (!connected) throw new Error('Receiving end does not exist');
          if (message.type === 'health') return { ok: true, protocol: 6, loggedInHome };
          return runReply;
        },
        onRemoved: { addListener() {} }
      }
    }
  });
  if (snapshot) context.XiaoyaTaskData = { ...taskData, createTaskStore: () => ({
    async load(options) { assert.equal(options.force, true); return snapshot; },
    async currentAccount() { return account; }
  }) };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/worker.js'), 'utf8'), context);
  return { data, injected, requests, created, updates, recipients,
    tick: () => alarm({ name: 'xiaoya-tick' }),
    setAccount(value) { account = value; },
    setPage(id, nextUrl, loggedIn) { tabs.set(id, { id, url: nextUrl, status: 'complete' }); loggedInHome = loggedIn; },
    send(message, sender = {}) { return new Promise(resolve => listener({ options: { rate: 2 }, tabId: 1, ...message }, sender, resolve)); }
  };
}
function workerForPanel({ sidePanel } = {}) {
  let updated;
  const remembered = [];
  const context = vm.createContext({ URL, setTimeout, clearTimeout, crypto: {}, chrome: {
    alarms: { create() {}, onAlarm: { addListener() {} } },
    runtime: { onMessage: { addListener() {} } },
    storage: { session: {} },
    sidePanel,
    tabs: { onUpdated: { addListener(fn) { updated = fn; } }, onRemoved: { addListener() {} } }
  } });
  context.importScripts = (...names) => {
    if (names[0] === 'answer-batch.js') return;
    if (names[0] === 'ai-question.js') { assert.deepEqual(names, ['ai-question.js', 'ai-client.js', 'ai-service.js']); return; }
    assert.equal(names[0], 'task-data.js');
    context.XiaoyaTaskData = { createTaskStore: () => ({ rememberCourses: async list => { remembered.push(...list); } }) };
  };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/worker.js'), 'utf8'), context);
  return { remembered, navigate: url => updated(1, { url }) };
}
test('the toolbar icon is set to open the side panel', () => {
  const calls = [];
  workerForPanel({ sidePanel: { setPanelBehavior: async options => { calls.push(options.openPanelOnActionClick); } } });
  assert.deepEqual(calls, [true]);
});
test('opening a course page remembers that course, and other pages are ignored', () => {
  const f = workerForPanel();
  f.navigate('https://whut.ai-augmented.com/app/jx-web/mycourse/12345/resource/_/9');
  f.navigate('https://whut.ai-augmented.com/app/jx-web/mycourse');
  f.navigate('https://example.com/app/jx-web/mycourse/999');
  assert.deepEqual(f.remembered.map(course => course.id), ['12345']);
});
test('scan repairs a missing content-script connection before starting', async () => {
  const f = worker();
  assert.equal((await f.send({ type: 'scan' })).ok, true);
  assert.equal(f.injected.length, 2);
  assert.equal(f.injected[0].world, 'MAIN');
  assert.equal(f.data.xiaoyaRun.scanOnly, true);
  assert.equal(f.data.xiaoyaRun.mode, 'home');
  assert.equal(f.requests.at(-1), 'run');
});
test('connected pages do not receive duplicate scripts', async () => {
  const f = worker({ connected: true });
  assert.equal((await f.send({ type: 'start' })).ok, true);
  assert.equal(f.injected.length, 0);
});
test('a missing startup acknowledgment fails explicitly and preserves the error', async () => {
  const g = worker({ connected: true, runReply: null });
  const reply = await g.send({ type: 'scan' });
  assert.match(reply.error, /未接收到启动命令/);
  assert.equal(g.data.xiaoyaRun, undefined);
  assert.equal(g.data.xiaoyaError.text, reply.error);
});
test('script injection failures are surfaced without a fake running state', async () => {
  const f = worker({ injectionFails: true });
  const reply = await f.send({ type: 'scan' });
  assert.match(reply.error, /Cannot access page/);
  assert.equal(f.data.xiaoyaRun, undefined);
  assert.equal(f.data.xiaoyaError.tabId, 1);
});
test('unsupported sites are rejected before injection', async () => {
  const f = worker({ url: 'https://example.com/app/jx-web/mycourse' });
  assert.ok((await f.send({ type: 'start' })).error);
  assert.equal(f.injected.length, 0);
});
test('background start keeps one existing Xiaoya tab and protects it from automatic discard', async () => {
  const f = worker({ connected: true });
  assert.equal((await f.send({ type: 'start', options: { background: true, muted: true } })).ok, true);
  assert.equal(f.created.length, 0);
  assert.equal(f.data.xiaoyaRun.tabId, 1);
  assert.equal(f.data.xiaoyaRun.sourceTabId, 1);
  assert.equal(f.data.xiaoyaRun.protectedTab, true);
  assert.ok(f.recipients.every(id => id === 1), 'all commands stay on the original Xiaoya tab');
  assert.deepEqual(f.updates[0], { id: 1, autoDiscardable: false });
  await f.send({ type: 'stop' });
  assert.equal(f.data.xiaoyaRun.enabled, false);
  assert.deepEqual(f.updates.at(-1), { id: 1, autoDiscardable: true });
});
test('task preview stays on the original page even when background mode is selected', async () => {
  const f = worker({ connected: true });
  await f.send({ type: 'scan', options: { background: true } });
  assert.equal(f.created.length, 0);
  assert.equal(f.data.xiaoyaRun.tabId, 1);
});
test('failed background startup releases automatic discard protection', async () => {
  const f = worker({ connected: true, runReply: null });
  assert.ok((await f.send({ type: 'start', options: { background: true } })).error);
  assert.equal(f.data.xiaoyaRun, undefined);
  assert.deepEqual(f.updates.at(-1), { id: 1, autoDiscardable: true });
});
test('scan from an unrelated site opens Xiaoya without navigating the unrelated tab', async () => {
  const f = worker({ url: 'https://example.com/', connected: true, loggedInHome: false });
  assert.equal((await f.send({ type: 'scan' })).ok, true);
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].url, 'https://whut.ai-augmented.com/app/jx-web/mycourse');
  assert.equal(f.data.xiaoyaPendingScan.tabId, 2);
  assert.equal(f.data.xiaoyaRun, undefined);
  assert.equal(f.updates.some(update => update.id === 1 && update.url), false);
  f.setPage(2, 'https://whut.ai-augmented.com/app/jx-web/mycourse', true);
  await f.send({ type: 'login-ready' }, { tab: { id: 2 } });
  assert.equal(f.data.xiaoyaRun.scanOnly, true);
  assert.equal(f.data.xiaoyaRun.tabId, 2);
  assert.equal(f.data.xiaoyaPendingScan, undefined);
});
test('login-ready resumes only the pending target after login and only once', async () => {
  const f = worker({ connected: true, loggedInHome: false });
  await f.send({ type: 'scan' });
  assert.ok(f.data.xiaoyaPendingScan);
  assert.equal(f.data.xiaoyaRun, undefined);
  await f.send({ type: 'login-ready' }, { tab: { id: 99 } });
  assert.equal(f.data.xiaoyaRun, undefined);
  f.setPage(1, 'https://whut.ai-augmented.com/app/jx-web/mycourse', true);
  await f.send({ type: 'login-ready' }, { tab: { id: 1 } });
  await f.send({ type: 'login-ready' }, { tab: { id: 1 } });
  assert.equal(f.requests.filter(type => type === 'run').length, 1);
});
test('scan reuses an existing Xiaoya tab when invoked from another website', async () => {
  const f = worker({ url: 'https://example.com/', connected: true,
    otherTabs: [{ id: 8, url: 'https://whut.ai-augmented.com/app/jx-web/mycourse', status: 'complete' }] });
  await f.send({ type: 'scan' });
  assert.equal(f.created.length, 0);
  assert.equal(f.data.xiaoyaRun.tabId, 8);
});
test('stop cancels login continuation without reading any credentials', async () => {
  const f = worker({ connected: true, loggedInHome: false });
  await f.send({ type: 'scan' }); await f.send({ type: 'stop' });
  f.setPage(1, 'https://whut.ai-augmented.com/app/jx-web/mycourse', true);
  await f.send({ type: 'login-ready' }, { tab: { id: 1 } });
  assert.equal(f.data.xiaoyaPendingScan, undefined);
  assert.equal(f.data.xiaoyaRun, undefined);
});

const mediaTasks = [11, 12, 13].map(node_id => taskData.normalizeTask({ node_id, task_type: 1, name: node_id === 12 ? '未选.pdf' : '同名.mp4' }, { id: '42', name: '课程甲' }));
const mediaSnapshot = { status: 'ok', account: 'u1', tasks: mediaTasks, failures: [] };
const panelSender = { id: 'test', url: 'chrome-extension://test/sidepanel.html' };
const selectedTargets = [mediaTasks[0], mediaTasks[2]].map(taskData.mediaTarget);
const selectedStart = { type: 'start-selected', account: 'u1', selection: selectedTargets };
const pageSender = (target, documentId) => ({ tab: { id: 1 }, url: target.url, frameId: 0, documentId });
const pageGet = { type: 'get', selectedProtocol: 1 };
const nextSelected = (index = 0) => ({ type: 'selected-advance', runId: 'new-run', index });

test('selected worker navigates only the ordered list and isolates old or mismatched documents', async () => {
  const f = worker({ snapshot: mediaSnapshot });
  const [first, second] = selectedTargets;
  const firstPage = pageSender(first, 'first'), secondPage = pageSender(second, 'second');
  assert.equal((await f.send(selectedStart, panelSender)).ok, true);
  assert.deepEqual(f.updates.map(update => update.url), [first.url]);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.injected, []);
  assert.equal((await f.send({ type: 'get' }, firstPage)).run, null);
  assert.equal((await f.send(pageGet, secondPage)).run, null);
  assert.equal((await f.send(nextSelected(), firstPage)).accepted, false);
  assert.equal((await f.send(pageGet, firstPage)).run.selectionIndex, 0);
  await f.tick();
  assert.equal(f.requests.at(-1), 'selected-tick');
  assert.equal((await f.send(nextSelected(), firstPage)).accepted, true);
  assert.equal((await f.send(nextSelected(), firstPage)).accepted, false);
  assert.deepEqual(f.updates.map(update => update.url), [first.url, second.url]);
  assert.equal((await f.send(pageGet, secondPage)).run.selectionIndex, 1);
  assert.equal((await f.send(nextSelected(1), secondPage)).accepted, true);
  assert.equal(f.data.xiaoyaRun.enabled, false);
  assert.deepEqual(f.data.xiaoyaRun.completed, [first.id, second.id]);
});

test('selected worker rejects changed, duplicate, finished or wrong-account tasks before navigation', async () => {
  const [first, second] = selectedTargets;
  for (const [snapshot, request] of [
    [mediaSnapshot, { ...selectedStart, account: 'another' }],
    [mediaSnapshot, { ...selectedStart, selection: [first, first] }],
    [mediaSnapshot, { ...selectedStart, selection: [{ ...first, url: second.url }] }],
    [{ ...mediaSnapshot, tasks: [{ ...mediaTasks[0], finished: true }, ...mediaTasks.slice(1)] }, selectedStart],
    [{ ...mediaSnapshot, tasks: [...mediaTasks, { ...mediaTasks[0], id: 'other-task' }] }, selectedStart]
  ]) {
    const f = worker({ snapshot });
    assert.ok((await f.send(request, panelSender)).error);
    assert.equal(f.data.xiaoyaRun, undefined);
    assert.deepEqual(f.updates, []);
  }
});

test('selected worker stops after account change or manual stop and rejects late page writes', async () => {
  for (const accountChange of [true, false]) {
    const f = worker({ snapshot: mediaSnapshot });
    const firstPage = pageSender(selectedTargets[0], 'first');
    await f.send(selectedStart, panelSender);
    const { run } = await f.send(pageGet, firstPage);
    if (accountChange) f.setAccount('another');
    else await f.send({ type: 'stop' });
    assert.equal((await f.send(nextSelected(), firstPage)).accepted, false);
    assert.equal((await f.send({ type: 'save', run }, firstPage)).accepted, false);
    assert.equal(f.data.xiaoyaRun.enabled, false);
    assert.equal(f.requests.at(-1), 'selected-halt');
    assert.deepEqual(f.updates.map(update => update.url), [selectedTargets[0].url]);
  }
});

test('selected worker enables aggressive mode only with an explicit boolean and uses no playback background protection', async () => {
  for (const aggressive of [true, false, 'true', undefined]) {
    const f = worker({ snapshot: mediaSnapshot });
    const response = await f.send({ ...selectedStart, options: { aggressive, background: true } }, panelSender);
    assert.equal(response.ok, true);
    assert.equal(f.data.xiaoyaRun.options.aggressive, aggressive === true);
    assert.equal(f.data.xiaoyaRun.options.background, aggressive !== true);
    assert.equal(f.updates.some(update => update.autoDiscardable === false), aggressive !== true);
  }
});
