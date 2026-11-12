const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const taskData = require('../extension/task-data.js');

const ORIGIN = 'https://whut.ai-augmented.com';
const NOW = Date.now();
const task = (overrides = {}) => ({ id: '42:99', courseId: '42', nodeId: '11', taskId: '99', name: '第1讲.mp4',
  typeCode: 1, finished: false, start: NOW - 1000, end: NOW + 3_600_000, ...overrides });

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function store({ token = 'tok', accountId = '9', notices = [], postResponse = { success: true }, postStatus = 200 } = {}) {
  const calls = [];
  const storage = { get: async () => ({}), set: async () => {}, remove: async () => {} };
  const created = taskData.createTaskStore({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (options.method === 'POST') return response(postResponse, postStatus);
      if (url.endsWith('/api/jx-auth/oauth2/info')) return response({ success: true, data: { info: { id: accountId } } });
      if (url.includes('queryTaskNotices')) return response({ success: true, data: { student_tasks: notices } });
      return response({ success: true, data: [] });
    },
    storage,
    getToken: async () => token,
    now: () => NOW,
    timeoutMs: 50
  });
  return { store: created, calls, posts: () => calls.filter(call => call.options.method === 'POST') };
}

const platformRow = (overrides = {}) => ({ group_id: '42', node_id: '11', task_id: '99', task_type: 1,
  finish: 0, end_time: new Date(NOW + 3_600_000).toISOString(), ...overrides });

test('finishProblem 只放行未完成、未截止的自主观看任务', () => {
  const { finishProblem } = taskData;
  assert.equal(finishProblem(task(), NOW), '');
  assert.match(finishProblem(task({ typeCode: 2 }), NOW), /不属于视频课件/);
  assert.equal(finishProblem(task({ finished: true }), NOW), '已完成');
  assert.equal(finishProblem(task({ end: NOW - 1 }), NOW), '已截止');
  assert.equal(finishProblem(task({ end: null }), NOW), '');
  assert.match(finishProblem(task({ taskId: null }), NOW), /缺少任务 ID/);
  assert.match(finishProblem(task({ courseId: 'x' }), NOW), /无法定位/);
});

test('finishTask 按平台要求的三个字段提交，并带上登录令牌', async () => {
  const { store: created, posts } = store({ notices: [platformRow()] });
  assert.deepEqual(await created.finishTask(task(), '9'), { status: 'submitted' });
  assert.equal(posts().length, 1);
  const { url, options } = posts()[0];
  assert.equal(url, `${ORIGIN}/api/jx-iresource/resource/finishActivity`);
  assert.equal(options.method, 'POST');
  assert.equal(options.credentials, 'include');
  assert.equal(options.headers.authorization, 'Bearer tok');
  assert.equal(options.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(options.body), { group_id: '42', node_id: '11', task_id: '99' });
});

test('平台已记为完成时不再重复提交', async () => {
  const { store: created, posts } = store({ notices: [platformRow({ finish: 2 })] });
  assert.deepEqual(await created.finishTask(task(), '9'), { status: 'already' });
  assert.equal(posts().length, 0);
});

test('平台侧已截止或任务已消失时不发 POST', async () => {
  const overdue = store({ notices: [platformRow({ end_time: new Date(NOW - 1).toISOString() })] });
  await assert.rejects(overdue.store.finishTask(task(), '9'), /已到截止时间/);
  assert.equal(overdue.posts().length, 0);

  const missing = store({ notices: [platformRow({ task_id: '404' })] });
  await assert.rejects(missing.store.finishTask(task(), '9'), /找不到这条任务/);
  assert.equal(missing.posts().length, 0);
});

test('账号变化、接口失败和未登录都明确报错', async () => {
  const changed = store({ notices: [platformRow()], accountId: '8' });
  await assert.rejects(changed.store.finishTask(task(), '9'), /账号已变化/);
  assert.equal(changed.posts().length, 0);

  const failed = store({ notices: [platformRow()], postResponse: { success: false, message: '任务不可提交' } });
  await assert.rejects(failed.store.finishTask(task(), '9'), /任务不可提交/);

  const anonymous = store({ notices: [platformRow()], token: null });
  await assert.rejects(anonymous.store.finishTask(task(), '9'), /请先登录小雅/);
  assert.equal(anonymous.posts().length, 0);
});

function worker({ before, after, finish } = {}) {
  let listener;
  const stored = {};
  const sent = [];
  const pings = [];
  const store = {
    loads: [],
    async load(options = {}) {
      store.loads.push(Boolean(options.force));
      return options.force ? after : before;
    },
    async finishTask(row, account) {
      sent.push({ id: row.id, account });
      return finish(row);
    },
    async currentAccount() { return '9'; }
  };
  const context = vm.createContext({ URL, setTimeout, clearTimeout, crypto: { randomUUID() { return 'run'; } },
    chrome: {
      sidePanel: { setPanelBehavior: () => Promise.resolve() },
      alarms: { create() {}, onAlarm: { addListener() {} } },
      runtime: { id: 'test', getURL: name => `chrome-extension://test/${name}`, onMessage: { addListener(fn) { listener = fn; } },
        sendMessage(message) { pings.push(message); return Promise.resolve(); } },
      storage: { session: {
        async get() { return structuredClone(stored); },
        async set(value) { Object.assign(stored, structuredClone(value)); },
        async remove(key) { delete stored[key]; }
      } },
      tabs: { onUpdated: { addListener() {} }, onRemoved: { addListener() {} }, async query() { return []; } }
    } });
  context.XiaoyaTaskData = { createTaskStore: () => store, finishProblem: taskData.finishProblem };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/worker.js'), 'utf8'), context);
  const panel = { id: 'test', url: 'chrome-extension://test/sidepanel.html' };
  return { store, sent, pings,
    send(message, sender = panel) {
      return new Promise(resolve => listener({ ...message }, sender, resolve));
    }
  };
}

const snapshot = (tasks, account = '9') => ({ status: 'ok', account, tasks, failures: [], fetchedAt: NOW });

test('finish-submit 只接受任务面板、且必须开启激进模式', async () => {
  const own = task();
  const instance = worker({ before: snapshot([own]), after: snapshot([{ ...own, finished: true }]), finish: async () => ({ status: 'submitted' }) });
  const fromTab = await instance.send({ type: 'finish-submit', aggressive: true, account: '9',
    selection: [{ id: own.id, courseId: '42', nodeId: '11', taskId: '99', name: '第1讲.mp4' }] }, { id: 'test', url: 'https://whut.ai-augmented.com/app/jx-web/mycourse', tab: { id: 1 } });
  assert.match(fromTab.error, /只能从任务面板/);

  const noMode = await instance.send({ type: 'finish-submit', account: '9',
    selection: [{ id: own.id, courseId: '42', nodeId: '11', taskId: '99', name: '第1讲.mp4' }] });
  assert.match(noMode.error, /激进模式/);
  assert.equal(instance.sent.length, 0);
});

test('finish-submit 逐条提交，并返回平台核对后的完成状态', async () => {
  const a = task();
  const b = task({ id: '42:100', nodeId: '12', taskId: '100', name: '第2讲.mp4' });
  const instance = worker({ before: snapshot([a, b]),
    after: snapshot([{ ...a, finished: true }, b]),
    finish: async row => { if (row.id === b.id) throw new Error('平台未确认完成。'); return { status: 'submitted' }; } });
  const result = await instance.send({ type: 'finish-submit', aggressive: true, account: '9', selection: [
    { id: a.id, courseId: '42', nodeId: '11', taskId: '99', name: '第1讲.mp4' },
    { id: b.id, courseId: '42', nodeId: '12', taskId: '100', name: '第2讲.mp4' }
  ] });
  assert.equal(result.ok, true);
  assert.deepEqual(instance.sent.map(row => row.account), ['9', '9']);
  const [first, second] = result.results;
  assert.equal(first.status, 'submitted');
  assert.equal(first.verified, true);
  assert.equal(second.status, 'failed');
  assert.match(second.message, /平台未确认完成/);
  assert.equal(result.snapshot.tasks.length, 2);
  assert.deepEqual(instance.store.loads, [false, true]);
  assert.deepEqual(instance.pings.map(ping => [ping.done, ping.status]), [[1, 'submitted'], [2, 'failed']],
    '每条结束都通知面板，而不是等整批结束');
  assert.equal(instance.pings[0].total, 2);
});

test('清单身份变化或已完成后整体拒绝，不提交任何一条', async () => {
  const done = task({ id: '42:98', taskId: '98', finished: true });
  const instance = worker({ before: snapshot([done]), after: snapshot([done]), finish: async () => ({ status: 'submitted' }) });
  const result = await instance.send({ type: 'finish-submit', aggressive: true, account: '9', selection: [
    { id: done.id, courseId: '42', nodeId: '11', taskId: '98', name: '第1讲.mp4' }] });
  assert.match(result.error, /已完成/);
  assert.equal(instance.sent.length, 0);

  const current = task();
  const other = worker({ before: snapshot([current]), after: snapshot([current]), finish: async () => ({ status: 'submitted' }) });
  const changed = await other.send({ type: 'finish-submit', aggressive: true, account: '9', selection: [
    { id: current.id, courseId: '42', nodeId: '99', taskId: '99', name: '第1讲.mp4' }] });
  assert.match(changed.error, /身份已变化/);
  assert.equal(other.sent.length, 0);
});

test('激进模式下开始刷课变为完成任务，确认后直接提交且不打开播放页', async () => {
  const { parseHTML } = require('linkedom');
  const { document } = parseHTML(fs.readFileSync(path.join(__dirname, '../extension/sidepanel.html'), 'utf8'));
  const model = require(path.join(__dirname, '../extension/panel-model.js'));
  const now = Date.now();
  const tasks = [{ id: '42:99', taskId: '99', courseId: '42', courseName: '课程 42', nodeId: '11', resourceId: 'r11',
    typeCode: 1, type: '视频课件', name: '第1讲.mp4', finished: false, start: now - 1000, end: now + 86_400_000, finishedAt: null }];
  const state = { account: '9', tasks, chip: 'media', tab: 'pending', query: '', day: null };
  const filters = () => ({ tab: state.tab, chip: state.chip, query: state.query, day: state.day });
  const messages = [];
  const marked = [];
  let refreshed = null;
  let runtimeListener = null;
  let run = null, pending = null;
  const chrome = {
    tabs: { async query() { return [{ id: 7 }]; } },
    storage: {
      local: { async get(key) { return key === 'options' ? { options: {} } : {}; }, async set() {} },
      session: { async get() { return { xiaoyaRun: run, xiaoyaPendingScan: pending }; } },
      onChanged: { addListener() {} }
    },
    runtime: {
      onMessage: { addListener(fn) { runtimeListener = fn; } },
      async sendMessage(message) {
        messages.push(JSON.parse(JSON.stringify(message)));
        if (message.type === 'finish-submit') {
          return { ok: true, results: [{ id: '42:99', name: '第1讲.mp4', status: 'submitted', verified: true }],
            snapshot: { status: 'ok', account: '9', tasks: [{ ...tasks[0], finished: true, finishedAt: now }], failures: [], fetchedAt: now } };
        }
        return { ok: true };
      }
    }
  };
  for (const id of ['aggressiveConfirm', 'finishConfirm']) {
    const dialog = document.getElementById(id);
    Object.defineProperty(dialog, 'open', { get() { return this.hasAttribute('open'); }, set(value) { value ? this.setAttribute('open', '') : this.removeAttribute('open'); } });
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => {
      dialog.open = false;
      const close = document.createEvent('Event');
      close.initEvent('close', false, false);
      dialog.dispatchEvent(close);
    };
  }
  const context = vm.createContext({
    chrome, document, state, model, filters, XiaoyaTaskData: taskData, setTimeout, clearTimeout,
    buildSeg: (element, html) => { element.innerHTML = html; }, moveThumb() {},
    renderList() { context.XiaoyaPanelVideo?.render(); }
  });
  context.XiaoyaPanelRefresh = async snapshot => { refreshed = snapshot; };
  context.XiaoyaPanelMarkDone = ids => marked.push(...ids);
  context.XiaoyaPanelRefreshData = async () => {};
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/panel-queue.js'), 'utf8'), context);
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));
  await flush();

  state.chip = 'all';
  await context.XiaoyaPanelVideo.render();
  assert.equal(document.getElementById('videoActions').hidden, true, '没有勾选时底栏不占位置');
  assert.equal(document.getElementById('videoAll').hidden, false, '全部分类里的全选菜单提供视频/文档全选');
  assert.equal(document.getElementById('videoAll').textContent, '全选视频/文档');

  const list = document.getElementById('list');
  list.innerHTML = context.XiaoyaPanelVideo.checkbox(tasks[0]);
  document.getElementById('videoAll').click();
  await flush();
  const starts = [...document.querySelectorAll('[data-queue-start]')];
  assert.equal(document.getElementById('videoActions').hidden, false, '勾选后底栏出现');
  assert.ok(document.getElementById('videoActions').contains(document.getElementById('optAggressive')), '激进开关在底栏视频行里');
  assert.equal(document.getElementById('videoSelected').textContent, '已选 1 项');
  assert.ok(starts.every(button => button.textContent === '开始刷课' && !button.disabled), '默认按钮是开始刷课');

  document.getElementById('videoAll').click();
  const change = document.createEvent('Event');
  change.initEvent('change', true, true);
  document.getElementById('optAggressive').checked = true;
  document.getElementById('optAggressive').dispatchEvent(change);
  await flush();
  assert.equal(document.getElementById('aggressiveConfirm').open, true);
  document.getElementById('aggressiveEnable').click();
  await flush();
  assert.equal(document.getElementById('optAggressive').checked, true);
  assert.ok(starts.every(button => button.textContent === '完成任务'), '激进模式下同一个开始按钮改为完成任务');
  assert.ok(starts.every(button => !button.disabled));
  assert.equal(messages.length, 0);

  starts[0].click();
  assert.equal(document.getElementById('finishConfirm').open, true);
  assert.equal(document.getElementById('finishConfirmList').children.length, 1);
  assert.match(document.getElementById('finishConfirmList').textContent, /第1讲\.mp4/);
  assert.equal(messages.length, 0, '确认前不发送任何请求');

  document.getElementById('finishGo').click();
  await flush();
  const sent = messages.find(message => message.type === 'finish-submit');
  assert.deepEqual(sent, { type: 'finish-submit', tabId: 7, account: '9', aggressive: true,
    selection: [{ id: '42:99', courseId: '42', nodeId: '11', taskId: '99', name: '第1讲.mp4' }] });
  assert.equal(messages.some(message => message.type === 'start-selected'), false, '激进模式不打开播放页');
  assert.match([...document.querySelectorAll('[data-video-message]')].map(node => node.textContent).join('\n'), /提交 1 项，确认完成 1 项/);

  runtimeListener({ type: 'finish:progress', id: '42:99', status: 'submitted' });
  assert.deepEqual(marked, ['42:99'], '后台每确认一条，面板先把它移出待完成');
  assert.equal(refreshed?.status, 'ok');
  assert.equal(document.getElementById('finishConfirm').open, false);
});
