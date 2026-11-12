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

test('answer toolbar hides only when inactive on media filter and names a finished answer batch', async () => {
  const { parseHTML } = require('linkedom');
  const { document } = parseHTML(fs.readFileSync(require.resolve('../extension/sidepanel.html'), 'utf8'));
  const model = require('../extension/panel-model.js');
  const task = { ...draftTask, type: '作业', start: Date.now() - 1000, end: Date.now() + 86400000, finished: false, finishedAt: null };
  const state = { account: 'account-a', tasks: [task], chip: 'media', tab: 'pending', query: '', day: null };
  const filters = () => ({ tab: state.tab, chip: state.chip, query: state.query, day: state.day });
  let batch = {
    id: 'batch-a', account: 'account-a', stage: 'finished', message: '',
    tasks: [task], results: [{ status: 'done', message: '已完成' }], enabled: false, inFlight: false
  };
  let onChanged, resolveDraft;
  const draftReply = new Promise(resolve => { resolveDraft = resolve; });
  const batchModel = {
    KEY: 'xiaoyaAnswerBatch',
    eligible: item => [2, 3, 4].includes(item.typeCode),
    selection: (tasks, ids, account, previousAccount) => account === previousAccount
      ? ids.filter(id => tasks.some(item => item.id === id && [2, 3, 4].includes(item.typeCode)))
      : []
  };
  const chrome = {
    runtime: { async sendMessage(message) {
      if (message.type === 'auto:get') return { ok: true, batch: structuredClone(batch) };
      if (message.type === 'auto:open-draft') return draftReply;
      return { ok: true };
    } },
    storage: { onChanged: { addListener(callback) { onChanged = callback; } } }
  };
  const context = vm.createContext({
    chrome, document, state, model, filters, XiaoyaAnswerBatch: batchModel, $: id => document.getElementById(id),
    renderList() {}, update() {}, esc: value => String(value).replace(/[&<>\"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]))
  });
  vm.runInContext(fs.readFileSync(require.resolve('../extension/panel-answer.js'), 'utf8'), context);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush();
  const toolbar = document.getElementById('answerToolbar');
  const progress = document.getElementById('answerProgress');
  assert.equal(toolbar.hidden, true, 'finished results do not occupy the video filter');

  assert.equal(document.getElementById('answerStage').textContent, '本批答题处理结束，可以开始下一批。');
  state.chip = 'all';
  context.XiaoyaPanelAnswer.render();
  assert.equal(toolbar.hidden, false, 'the previous answer result remains available in other filters');
  assert.equal(progress.hidden, false);

  state.chip = 'media';
  const list = document.getElementById('list');
  list.innerHTML = context.XiaoyaPanelAnswer.checkbox(task);
  const input = list.querySelector('[data-answer-id]');
  input.checked = true;
  const change = document.createEvent('Event');
  change.initEvent('change', true, true);
  input.dispatchEvent(change);
  assert.equal(toolbar.hidden, false, 'an answer selection keeps its controls accessible on media filter');
  assert.equal(document.getElementById('answerReview').disabled, false);
  input.checked = false;
  const clear = document.createEvent('Event');
  clear.initEvent('change', true, true);
  input.dispatchEvent(clear);
  assert.equal(toolbar.hidden, true);

  batch = { ...batch, stage: 'answering', message: '正在答题…', enabled: true };
  onChanged({ xiaoyaAnswerBatch: { newValue: batch } }, 'local');
  assert.equal(toolbar.hidden, false, 'a running answer batch remains visible');
  assert.equal(document.getElementById('answerStop').hidden, false);
  batch = { ...batch, stage: 'waiting-receipt', enabled: false, inFlight: true, results: [{ status: 'uncertain', message: '等待回执' }] };
  onChanged({ xiaoyaAnswerBatch: { newValue: batch } }, 'local');
  assert.equal(toolbar.hidden, false, 'receipt verification remains accessible on media filter');
  assert.equal(document.getElementById('answerVerify').hidden, false);

  batch = { ...batch, stage: 'finished', inFlight: false, results: [{ status: 'draft', message: '待补附件', draftPage }] };
  state.chip = 'all';
  onChanged({ xiaoyaAnswerBatch: { newValue: batch } }, 'local');
  const draftButton = document.querySelector('[data-draft-index="0"]');
  assert.ok(draftButton);
  draftButton.click();
  state.chip = 'media';
  context.XiaoyaPanelAnswer.render();
  assert.equal(toolbar.hidden, false, 'returning to a draft keeps answer controls visible while in progress');
  assert.match(document.querySelector('[data-draft-index="0"]').textContent, /正在定位原页面/);
  resolveDraft({ ok: true });
  await flush();
  await flush();
  assert.equal(toolbar.hidden, true, 'the toolbar hides again after the optional draft return ends');
});
