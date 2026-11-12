const { test } = require('node:test');
const assert = require('node:assert/strict');
const data = require('../extension/task-data.js');

const ORIGIN = 'https://whut.ai-augmented.com';
const T0 = Date.parse('2026-11-09T12:00:00+08:00');
const PAST = '2026-11-01T23:59:00+08:00';
const FUTURE = '2026-11-20T23:59:00+08:00';
const ok = value => ({ status: 200, ok: true, json: async () => ({ success: true, data: value }) });
const http = status => ({ status, ok: false, json: async () => ({ success: false }) });

function storageFake(initial = {}) {
  const values = structuredClone(initial);
  return {
    values,
    async get(key) { return key in values ? { [key]: structuredClone(values[key]) } : {}; },
    async set(items) { Object.assign(values, structuredClone(items)); },
    async remove(keys) { for (const key of [].concat(keys)) delete values[key]; }
  };
}

// 字段与真实接口一致：un_finish 没有 task_id、finish、resource_id；课程任务的 finish_time 总是有值。
const unfinishedRow = (group, task, extra = {}) => ({ id: `i${task}`, group_id: group, group_name: `课程${group}`, node_id: `n${task}`, name: `待办${task}`, task_type: 2, start_time: PAST, end_time: FUTURE, ...extra });
const noticeRow = (task, extra = {}) => ({ task_id: task, node_id: `n${task}`, task_type: 2, finish: 0, finish_time: PAST, start_time: PAST, end_time: FUTURE, ...extra });

// 按路径配置接口返回；未配置的课程默认返回一条任务和对应名称。
function harness({ routes = {}, token = 'token-a', account = 'u1', unfinished = [unfinishedRow('100', 1)], storage = storageFake(), timeoutMs } = {}) {
  const state = { calls: [], active: 0, peak: 0, time: T0, token };
  const fetchImpl = async (url, init) => {
    const path = url.slice(ORIGIN.length);
    state.calls.push({ url, path, init });
    state.active += 1;
    state.peak = Math.max(state.peak, state.active);
    try {
      await new Promise(resolve => setImmediate(resolve));
      for (const [prefix, reply] of Object.entries(routes)) {
        if (path.includes(prefix)) {
          const value = typeof reply === 'function' ? await reply(path, init) : reply;
          if (value instanceof Error) throw value;
          return value;
        }
      }
      if (path.endsWith('oauth2/info')) return ok({ info: { id: state.account ?? account } });
      if (path.endsWith('un_finish')) return ok(unfinished);
      if (path.includes('student/groups')) return ok([]);
      const id = path.match(/group_id=(\d+)/)?.[1];
      if (path.includes('queryTaskNotices')) return ok({ student_tasks: [noticeRow(Number(id) + 1)] });
      if (path.includes('queryCourseResources')) return ok([{ task_id: Number(id) + 1, name: `任务${id}` }]);
      throw new Error(`unexpected ${path}`);
    } finally {
      state.active -= 1;
    }
  };
  const store = data.createTaskStore({ fetchImpl, storage, getToken: async () => state.token, now: () => state.time, timeoutMs });
  return { store, state, storage };
}

test('taskStatus separates done, overdue and pending, and a done task stays done after its deadline', () => {
  assert.equal(data.taskStatus({ finished: true, end: T0 - 1000 }, T0), 'done');
  assert.equal(data.taskStatus({ finished: false, end: T0 - 1000 }, T0), 'overdue');
  assert.equal(data.taskStatus({ finished: false, end: T0 }, T0), 'overdue');
  assert.equal(data.taskStatus({ finished: false, end: T0 + 1000 }, T0), 'pending');
  assert.equal(data.taskStatus({ finished: false, end: null }, T0), 'pending');
});

test('normalizeTask maps types and keeps missing or invalid times as null', () => {
  const course = { id: '7', name: '高数' };
  const expected = { 1: '视频课件', 2: '作业', 3: '练习', 4: '测验', 5: '问卷', 6: '讨论', 99: '其他' };
  for (const [code, label] of Object.entries(expected)) assert.equal(data.normalizeTask({ task_id: 1, task_type: Number(code) }, course).type, label);
  const task = data.normalizeTask({ task_id: 1, end_time: 'not a date', start_time: null, finish: '2' }, course);
  assert.equal(task.end, null);
  assert.equal(task.start, null);
  assert.equal(task.finished, true);
  assert.equal(task.name, '未知任务名称');
  assert.equal(task.id, '7:1');
});

test('taskUrl follows the platform route and falls back to the course page without a node', () => {
  assert.equal(data.taskUrl('7', 'r1', 'n1'), `${ORIGIN}/app/jx-web/mycourse/7/resource/r1/n1`);
  assert.equal(data.taskUrl('7', null, 'n1'), `${ORIGIN}/app/jx-web/mycourse/7/resource/_/n1`);
  assert.equal(data.taskUrl('7', null, null), `${ORIGIN}/app/jx-web/mycourse/7`);
});

test('video queue requires an available named resource and keeps large node IDs exact', () => {
  const course = { id: '1234567890123456789', name: '课程甲' };
  const task = data.normalizeTask({ task_id: '11', node_id: '9876543210987654321', name: '第一讲', task_type: 1 }, course);
  assert.equal(data.mediaProblem(task, T0), '');
  assert.deepEqual(data.mediaTarget(task), {
    id: `${course.id}:11`, courseId: course.id, courseName: course.name, nodeId: '9876543210987654321', name: '第一讲',
    url: `${ORIGIN}/app/jx-web/mycourse/${course.id}/resource/_/9876543210987654321`
  });
  assert.match(data.mediaProblem({ ...task, nodeId: null }, T0), /定位/);
  assert.match(data.mediaProblem({ ...task, resourceId: '..' }, T0), /定位/);
  assert.match(data.mediaProblem({ ...task, name: '未知任务名称' }, T0), /名称/);
  assert.match(data.mediaProblem({ ...task, finished: true }, T0), /已完成/);
  assert.match(data.mediaProblem({ ...task, start: T0 + 1 }, T0), /未开放/);
  assert.match(data.mediaProblem({ ...task, end: T0 }, T0), /截止/);
});

test('refresh reads every course from notices, joins names, and also returns finished tasks', async () => {
  const f = harness({ routes: {
    queryTaskNotices: ok({ student_tasks: [noticeRow(1), noticeRow(2, { finish: 2, finish_time: PAST, end_time: PAST }), noticeRow(3, { end_time: PAST })] }),
    queryCourseResources: ok([{ task_id: 1, name: '第一章作业' }, { task_id: 2, name: '第二章作业' }, { task_id: 3, name: '第三章作业' }])
  } });
  const result = await f.store.refresh();
  assert.equal(result.status, 'ok');
  assert.equal(result.account, 'u1');
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.tasks.map(task => task.name), ['第一章作业', '第二章作业', '第三章作业']);
  assert.deepEqual(result.tasks.map(task => data.taskStatus(task, T0)), ['pending', 'done', 'overdue']);
  assert.equal(result.tasks[0].courseName, '课程100');
  assert.equal(result.tasks[0].url, `${ORIGIN}/app/jx-web/mycourse/100/resource/_/n1`);
  assert.equal(result.tasks[1].finishedAt, Date.parse(PAST));
});

test('every request is a GET to the Xiaoya origin and never touches completion or learning-record APIs', async () => {
  const f = harness({ unfinished: [unfinishedRow('100', 1), unfinishedRow('200', 2)] });
  await f.store.refresh();
  assert.equal(f.state.calls.length, 7);
  for (const call of f.state.calls) {
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.body, undefined);
    assert.ok(call.url.startsWith(`${ORIGIN}/api/`));
    assert.equal(call.init.headers.authorization, 'Bearer token-a');
    assert.doesNotMatch(call.url, /finishActivity|learnRecord/);
  }
});

test('never more than three requests run at once', async () => {
  const unfinished = Array.from({ length: 8 }, (_, i) => unfinishedRow(String(100 + i), i));
  const f = harness({ unfinished });
  const result = await f.store.refresh();
  assert.equal(result.tasks.length, 8);
  assert.equal(f.state.calls.length, 19);
  assert.equal(f.state.peak, data.MAX_CONCURRENT_REQUESTS);
});

test('simultaneous refreshes share one set of requests', async () => {
  const f = harness();
  const [a, b] = await Promise.all([f.store.refresh(), f.store.refresh()]);
  assert.equal(f.state.calls.length, 5);
  assert.equal(a, b);
  await f.store.refresh();
  assert.equal(f.state.calls.length, 10);
});

test('load uses the cache for five minutes, then refetches; force always refetches', async () => {
  const f = harness();
  await f.store.load();
  assert.equal(f.state.calls.length, 5);
  f.state.time = T0 + data.CACHE_TTL_MS - 1;
  const cached = await f.store.load();
  assert.equal(cached.fromCache, true);
  assert.equal(f.state.calls.length, 5);
  await f.store.load({ force: true });
  assert.equal(f.state.calls.length, 10);
  f.state.time += data.CACHE_TTL_MS;
  const fresh = await f.store.load();
  assert.equal(fresh.fromCache, false);
  assert.equal(f.state.calls.length, 15);
});

test('peek shows the cache without any request and reports staleness', async () => {
  const f = harness();
  assert.equal(await f.store.peek(), null);
  await f.store.refresh();
  const count = f.state.calls.length;
  f.state.time = T0 + data.CACHE_TTL_MS;
  const cached = await f.store.peek();
  assert.equal(cached.stale, true);
  assert.equal(cached.tasks.length, 1);
  assert.equal(f.state.calls.length, count);
});

test('a clock moved backwards does not keep an old cache alive', async () => {
  const f = harness();
  await f.store.refresh();
  f.state.time = T0 - 1000;
  assert.equal((await f.store.peek()).stale, true);
});

test('the token itself is never written to storage', async () => {
  const f = harness({ token: 'very-secret-token' });
  await f.store.refresh();
  assert.doesNotMatch(JSON.stringify(f.storage.values), /very-secret-token/);
});

test('one failing course keeps the others, falls back to its unfinished rows, and is reported', async () => {
  const unfinished = [unfinishedRow('100', 1), unfinishedRow('200', 2)];
  const f = harness({ unfinished, routes: { 'queryTaskNotices?group_id=200': http(500) } });
  const result = await f.store.refresh();
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.failures, [{ courseId: '200', courseName: '课程200', stage: 'tasks' }]);
  assert.deepEqual(result.tasks.map(task => task.name), ['任务100', '待办2']);
});

test('a partial result is not treated as fresh, so reopening retries it', async () => {
  const f = harness({ routes: { queryTaskNotices: new Error('network') } });
  await f.store.refresh();
  const count = f.state.calls.length;
  assert.equal((await f.store.peek()).stale, true);
  await f.store.load();
  assert.ok(f.state.calls.length > count);
});

test('a malformed task list counts as a failure rather than an empty course', async () => {
  const f = harness({ routes: { queryTaskNotices: ok({ student_tasks: null }) } });
  const result = await f.store.refresh();
  assert.deepEqual(result.failures.map(item => item.stage), ['tasks']);
  assert.equal(result.tasks.length, 1);
});

test('a business failure from the platform counts as a failure', async () => {
  const f = harness({ routes: { queryTaskNotices: { status: 200, ok: true, json: async () => ({ success: false }) } } });
  assert.deepEqual((await f.store.refresh()).failures.map(item => item.stage), ['tasks']);
});

test('when names fail, tasks stay visible with the best available name and the gap is reported', async () => {
  const f = harness({ routes: {
    queryCourseResources: http(500),
    queryTaskNotices: ok({ student_tasks: [noticeRow(1), noticeRow(9)] })
  } });
  const result = await f.store.refresh();
  assert.deepEqual(result.tasks.map(task => task.name), ['待办1', '未知任务名称']);
  assert.deepEqual(result.failures.map(item => item.stage), ['names']);
});

test('no token means login is required and nothing is requested', async () => {
  const f = harness({ token: null });
  assert.equal((await f.store.load()).status, 'login-required');
  assert.equal(await f.store.peek(), null);
  assert.equal(f.state.calls.length, 0);
});

test('an expired login is reported as login-required, not as zero tasks', async () => {
  for (const route of ['oauth2/info', 'un_finish', 'student/groups', 'queryTaskNotices', 'queryCourseResources']) {
    const f = harness({ routes: { [route]: http(401) } });
    const result = await f.store.refresh();
    assert.equal(result.status, 'login-required', route);
    assert.equal(await f.store.peek(), null, route);
  }
});

test('if the unfinished list fails, known courses are still read and the gap is reported', async () => {
  const f = harness({ routes: { un_finish: http(500) } });
  await f.store.rememberCourses([{ id: '300', name: '线代' }]);
  const result = await f.store.refresh();
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.failures.map(item => item.stage), ['unfinished']);
  assert.deepEqual(result.tasks.map(task => task.courseName), ['线代']);
});

test('if the unfinished list fails with no known courses, the result is an error rather than zero tasks', async () => {
  const f = harness({ routes: { un_finish: http(500) } });
  const result = await f.store.refresh();
  assert.equal(result.status, 'error');
  assert.equal(await f.store.peek(), null);
});

test('an account failure is reported as an error', async () => {
  const f = harness({ routes: { 'oauth2/info': new Error('offline') } });
  assert.equal((await f.store.refresh()).status, 'error');
});

test('a hung request times out and is reported instead of blocking the list', async () => {
  const f = harness({ timeoutMs: 5, routes: { queryTaskNotices: (path, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }) } });
  const result = await f.store.refresh();
  assert.deepEqual(result.failures.map(item => item.stage), ['tasks']);
});

test('the course list adds all-done courses with their real names', async () => {
  const f = harness({ unfinished: [unfinishedRow('100', 1)], routes: { 'student/groups': ok([{ id: 100, name: '课程100' }, { id: 700, name: '全部做完的课' }, null, { name: '缺编号' }]) } });
  const result = await f.store.refresh();
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.tasks.map(task => task.courseName), ['课程100', '全部做完的课']);
  assert.ok(f.state.calls.some(call => call.path === '/api/jx-iresource/group/student/groups?time_flag=1'));
});

test('if the course list fails, courses from unfinished tasks still load and the gap is reported', async () => {
  const f = harness({ routes: { 'student/groups': http(500) } });
  const result = await f.store.refresh();
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.failures.map(item => item.stage), ['courses']);
  assert.equal(result.tasks.length, 1);
});

test('a course list in an unexpected format counts as a failure', async () => {
  const f = harness({ routes: { 'student/groups': ok({ list: [] }) } });
  assert.deepEqual((await f.store.refresh()).failures.map(item => item.stage), ['courses']);
});

test('if both lists fail with no known courses, the result is an error rather than zero tasks', async () => {
  const f = harness({ routes: { 'student/groups': http(500), un_finish: http(500) } });
  assert.equal((await f.store.refresh()).status, 'error');
});

test('remembered courses are read even with no unfinished tasks, so all-done courses appear', async () => {
  const f = harness({ unfinished: [], routes: { queryTaskNotices: ok({ student_tasks: [noticeRow(1, { finish: 2 })] }), queryCourseResources: ok([{ task_id: 1, name: '已交作业' }]) } });
  await f.store.rememberCourses([{ id: '400', name: '英语' }, { id: 'abc', name: '非法' }, { name: '缺编号' }, null]);
  assert.deepEqual(Object.keys(await f.store.knownCourses()), ['400']);
  const result = await f.store.refresh();
  assert.deepEqual(result.tasks.map(task => [task.courseName, task.name]), [['英语', '已交作业']]);
});

test('a course keeps its known name when a later source has none', async () => {
  const f = harness({ unfinished: [unfinishedRow('100', 1, { group_name: '' })] });
  await f.store.rememberCourses([{ id: '100', name: '高数' }]);
  assert.equal((await f.store.refresh()).tasks[0].courseName, '高数');
  await f.store.rememberCourses([{ id: '500' }]);
  assert.equal((await f.store.knownCourses())['500'].name, '未命名课程');
});

test('switching accounts clears the cache and courses but keeps each account\'s pins', async () => {
  const f = harness();
  await f.store.refresh();
  await f.store.rememberCourses([{ id: '900', name: '旧账号的课' }]);
  await f.store.setPins('u1', ['100:1']);
  f.state.token = 'token-b';
  f.state.account = 'u2';
  assert.equal(await f.store.peek(), null, 'the old account\'s tasks must not flash');
  const result = await f.store.refresh();
  assert.equal(result.account, 'u2');
  assert.deepEqual(Object.keys(await f.store.knownCourses()), ['100']);
  assert.deepEqual(await f.store.getPins('u2'), []);
  assert.deepEqual(await f.store.getPins('u1'), ['100:1']);
});

test('a renewed token on the same account keeps the known courses', async () => {
  const f = harness();
  await f.store.rememberCourses([{ id: '900', name: '老课程' }]);
  await f.store.refresh();
  f.state.token = 'token-renewed';
  await f.store.refresh();
  assert.ok('900' in await f.store.knownCourses());
});

test('an unfinished task ignores the finish_time the platform always returns', () => {
  const course = { id: '7', name: '高数' };
  assert.equal(data.normalizeTask({ task_id: 1, finish: 0, finish_time: PAST }, course).finishedAt, null);
  assert.equal(data.normalizeTask({ task_id: 1, finish: 2, finish_time: PAST }, course).finishedAt, Date.parse(PAST));
});

test('with no Xiaoya page open, the cache still shows but nothing is requested', async () => {
  const f = harness();
  await f.store.refresh();
  const count = f.state.calls.length;
  f.state.token = undefined;
  const cached = await f.store.peek();
  assert.equal(cached.tasks.length, 1);
  assert.equal(cached.stale, true);
  assert.equal((await f.store.load()).status, 'site-closed');
  assert.equal(f.state.calls.length, count);
});

test('with a Xiaoya page open but logged out, the cache is hidden', async () => {
  const f = harness();
  await f.store.refresh();
  f.state.token = null;
  assert.equal(await f.store.peek(), null);
  assert.equal((await f.store.load()).status, 'login-required');
});

test('a browser error while reading the login state counts as no Xiaoya page', async () => {
  const store = data.createTaskStore({ fetchImpl: async () => { throw new Error('should not run'); }, storage: storageFake(), getToken: async () => { throw new Error('tabs failed'); } });
  assert.equal(await store.peek(), null);
  assert.equal((await store.refresh()).status, 'site-closed');
});

test('an empty row in the task list does not lose the rest of the course', async () => {
  const f = harness({ routes: { queryTaskNotices: ok({ student_tasks: [null, noticeRow(1)] }) } });
  const result = await f.store.refresh();
  assert.equal(result.status, 'ok');
  assert.equal(result.tasks.length, 1);
});

function withChrome(tabs, executeScript, run) {
  globalThis.chrome = { tabs: { query: async query => { assert.deepEqual(query, { url: `${ORIGIN}/*` }); return tabs; } }, scripting: { executeScript } };
  return run().finally(() => { delete globalThis.chrome; });
}

test('readTabToken reports no page, a logged-out page, and an unreadable page distinctly', async () => {
  await withChrome([], async () => { throw new Error('should not run'); }, async () => assert.equal(await data.readTabToken(), undefined));
  await withChrome([{ id: 1 }], async () => [{ result: null }], async () => assert.equal(await data.readTabToken(), null));
  await withChrome([{ id: 1 }], async () => { throw new Error('discarded'); }, async () => assert.equal(await data.readTabToken(), undefined));
});

test('readTabToken skips an unreadable tab and uses the next one', async () => {
  const seen = [];
  await withChrome([{ id: 1 }, { id: 2 }], async options => {
    seen.push(options.target.tabId);
    if (options.target.tabId === 1) throw new Error('discarded');
    return [{ result: 'abc' }];
  }, async () => assert.equal(await data.readTabToken(), 'abc'));
  assert.deepEqual(seen, [1, 2]);
});

test('readPageToken matches the prefixed cookie name used by the platform and ignores the refresh token', () => {
  globalThis.document = { cookie: 'WT-prd-refresh-token=no; WT-prd-access-token=a=b; other=x' };
  try {
    assert.equal(data.readPageToken(), 'a=b');
    globalThis.document.cookie = 'other=x';
    assert.equal(data.readPageToken(), null);
  } finally {
    delete globalThis.document;
  }
});
const receiptTask = {courseId:'100',nodeId:'1001',taskId:'2001',typeCode:2};
const receiptRow = extra => ({node_id:'1001',task_id:'2001',task_type:2,finish:2,...extra});
test('submission check reads fresh account and exact course task without cached completion or broad refresh',async()=>{
 const f=harness({routes:{queryTaskNotices:ok({student_tasks:[receiptRow()]})}});
 assert.equal(await f.store.checkSubmitted(receiptTask,'u1'),true);
 assert.equal(f.state.calls.length,3);assert.ok(f.state.calls.every(c=>c.init.method==='GET'&&c.init.cache==='no-store'));
 assert.equal(f.state.calls.filter(c=>c.path.includes('queryTaskNotices')).length,1);
});
test('nonempty finish_time, wrong task identity/type or duplicate rows cannot confirm submission',async()=>{
 for(const rows of [[receiptRow({finish:0,finish_time:PAST})],[receiptRow({task_id:'other'})],[receiptRow({node_id:'other'})],[receiptRow({group_id:'999'})],[receiptRow({task_type:1})],[receiptRow(),receiptRow()],[]]){
  const f=harness({routes:{queryTaskNotices:ok({student_tasks:rows})}});assert.equal(await f.store.checkSubmitted(receiptTask,'u1'),false);
 }
});
test('submission check fails on account switch or failed/malformed platform result',async()=>{
 const f=harness({account:'other'});await assert.rejects(f.store.checkSubmitted(receiptTask,'u1'),/账号/);
 const g=harness({routes:{queryTaskNotices:()=>{g.state.token='token-b';return ok({student_tasks:[receiptRow()]});}}});await assert.rejects(g.store.checkSubmitted(receiptTask,'u1'),/登录状态/);
 const h=harness({routes:{queryTaskNotices:http(500)}});await assert.rejects(h.store.checkSubmitted(receiptTask,'u1'),/HTTP/);
 const k=harness({routes:{queryTaskNotices:ok({})}});await assert.rejects(k.store.checkSubmitted(receiptTask,'u1'),/任务状态/);
});
