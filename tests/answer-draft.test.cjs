const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const draftTask = { id: '11:task-1', courseId: '11', nodeId: '21', taskId: '31', name: '作业', courseName: '课程', typeCode: 2 };
const nextTask = { ...draftTask, id: '11:task-2', nodeId: '22', taskId: '32' };
const draftPage = { tabId: 9, pageToken: 'page-token' };

function fixture() {
  let listener;
  let account = 'account-a';
  let beforeVerify = null;
  let beforeActivation = null;
  let batch = {
    id: 'batch-a', account,
    tasks: [draftTask],
    results: [{ status: 'draft', draftPage }],
    enabled: false, inFlight: false
  };
  let busy = false;
  let activations = 0;
  const calls = [];
  const driver = {
    async focusDraft(task, reference, verifyBatch, canFocus) {
      calls.push({ task, reference });
      if (beforeVerify) await beforeVerify();
      const allowed = await verifyBatch();
      calls.push({ allowed });
      if (!allowed) return false;
      if (beforeActivation) await beforeActivation();
      if (!canFocus()) return false;
      activations += 1;
      return true;
    }
  };
  const chrome = {
    runtime: {
      id: 'extension-id',
      getURL: path => `chrome-extension://extension-id/${path}`,
      onMessage: { addListener(callback) { listener = callback; } }
    },
    storage: { local: {}, session: { async get() { return {}; } } },
    sidePanel: { setPanelBehavior: async () => {} },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    tabs: {
      onCreated: { addListener() {} },
      onUpdated: { addListener() {} },
      onRemoved: { addListener() {} },
      async query() { return []; },
      async get() { throw Error('No tab access expected in this worker test'); },
      async update() { throw Error('No tab activation expected in this worker test'); }
    },
    windows: { async update() { throw Error('No window activation expected in this worker test'); } }
  };
  const context = vm.createContext({
    chrome, URL, crypto: require('node:crypto'), console, setTimeout, clearTimeout,
    XiaoyaAIService: { createService: () => ({}) },
    XiaoyaTaskData: { createTaskStore: () => ({
      async currentAccount() { return account; },
      async load() { return { status: 'ok', account, tasks: [nextTask] }; }
    }) },
    XiaoyaAnswerDriver: { createDriver: () => driver },
    XiaoyaAnswerBatch: {
      eligible: task => Boolean(task),
      createEngine: () => ({
        async get() { return structuredClone(batch); },
        getId() { return batch.id; },
        busy() { return busy || Boolean(batch.enabled); },
        async start({ account, tasks }) {
          batch = { id: 'batch-b', account, tasks, results: [], enabled: true, inFlight: false };
          return { ok: true, batch: structuredClone(batch) };
        }
      })
    }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../extension/worker.js'), 'utf8'), context);
  async function send(message, sender = { id: 'extension-id', url: 'chrome-extension://extension-id/sidepanel.html' }) {
    return new Promise(resolve => {
      const staysOpen = listener(message, sender, resolve);
      assert.equal(staysOpen, true);
    });
  }
  return {
    calls, send,
    get activations() { return activations; },
    setAccount(value) { account = value; },
    setBatch(value) { batch = value; },
    beforeVerify(callback) { beforeVerify = callback; },
    beforeActivation(callback) { beforeActivation = callback; },
    setBusy(value) { busy = value; }
  };
}

test('only the matching current-batch draft for the same account can focus its original page', async () => {
  const f = fixture();
  const result = await f.send({ type: 'auto:open-draft', batchId: 'batch-a', taskId: draftTask.id });
  assert.equal(result.ok, true);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].task.id, draftTask.id);
  assert.deepEqual(f.calls[0].reference, draftPage);
  assert.equal(f.calls[1].allowed, true);
  assert.equal(f.activations, 1);
});

test('replaced batch, wrong account, running batch, or non-draft results cannot focus a page', async () => {
  const cases = [
    { label: 'replaced batch', update: f => f.setBatch({ id: 'batch-b', account: 'account-a', tasks: [draftTask], results: [{ status: 'draft', draftPage }], enabled: false, inFlight: false }), expected: /已被新批次替换/ },
    { label: 'different account', update: f => f.setAccount('account-b'), expected: /所属账号不同/ },
    { label: 'running batch', update: f => f.setBusy(true), expected: /仍在运行/ },
    { label: 'no longer a draft', update: f => f.setBatch({ id: 'batch-a', account: 'account-a', tasks: [draftTask], results: [{ status: 'pending', draftPage }], enabled: false, inFlight: false }), expected: /找不到/ }
  ];
  for (const item of cases) {
    const f = fixture();
    item.update(f);
    const result = await f.send({ type: 'auto:open-draft', batchId: 'batch-a', taskId: draftTask.id });
    assert.equal(result.ok, false, item.label);
    assert.match(result.error, item.expected, item.label);
    assert.equal(f.calls.length, 0, item.label);
  }
});

test('an account change during page verification prevents activation', async () => {
  const f = fixture();
  f.beforeVerify(() => f.setAccount('account-b'));
  const result = await f.send({ type: 'auto:open-draft', batchId: 'batch-a', taskId: draftTask.id });
  assert.equal(result.ok, false);
  assert.match(result.error, /无法确认/);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].allowed, false);
  assert.equal(f.activations, 0);
});

test('an unrelated pending receipt does not prevent returning to an already open draft page', async () => {
  const f = fixture();
  f.setBatch({ id: 'batch-a', account: 'account-a', tasks: [draftTask], results: [{ status: 'draft', draftPage }], enabled: false, inFlight: true });
  const result = await f.send({ type: 'auto:open-draft', batchId: 'batch-a', taskId: draftTask.id });
  assert.equal(result.ok, true);
  assert.equal(f.activations, 1);
});

test('a new batch starts without waiting for a pending optional draft lookup', async () => {
  const f = fixture();
  let locate, resume;
  const locating = new Promise(resolve => { locate = resolve; });
  const lookup = new Promise(resolve => { resume = resolve; });
  f.beforeActivation(async () => { locate(); await lookup; });
  const draft = f.send({ type: 'auto:open-draft', batchId: 'batch-a', taskId: draftTask.id });
  await locating;
  const next = await f.send({ type: 'auto:start', account: 'account-a', ids: [nextTask.id] });
  resume();
  assert.equal(next.ok, true);
  assert.equal(next.batch.id, 'batch-b');
  assert.match((await draft).error, /已取消返回/);
  assert.equal(f.activations, 0);
});

test('non-panel senders cannot request draft-page focus', async () => {
  const f = fixture();
  const result = await f.send({ type: 'auto:open-draft', batchId: 'batch-a', taskId: draftTask.id }, {
    id: 'extension-id', url: 'chrome-extension://extension-id/sidepanel.html', tab: { id: 2 }
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /只有任务面板/);
  assert.equal(f.calls.length, 0);
});
