const { test } = require('node:test');
const assert = require('node:assert/strict');
const model = require('../extension/panel-model.js');

// 2026-11-09 是周一，所有时间按本地时区构造。
const at = (day, h = 23, m = 59) => new Date(2026, 10, day, h, m).getTime();
const NOW = at(9, 12, 0);
let seq = 0;
const task = (extra = {}) => ({ id: `c:${seq += 1}`, courseId: '1', courseName: '高等数学', name: '习题', type: '作业', typeCode: 2, finished: false, start: at(1, 8, 0), end: at(20), finishedAt: null, ...extra });
const filters = (extra = {}) => ({ tab: 'pending', chip: 'all', query: '', day: null, ...extra });
const names = list => list.map(item => item.name);

test('formatTime uses relative words near today and dates further away', () => {
  assert.equal(model.formatTime(at(9), NOW), '今天 23:59');
  assert.equal(model.formatTime(at(10, 18, 0), NOW), '明天 18:00');
  assert.equal(model.formatTime(at(8, 9, 5), NOW), '昨天 09:05');
  assert.equal(model.formatTime(at(11, 18, 0), NOW), '周三 18:00');
  assert.equal(model.formatTime(at(16), NOW), '11/16 23:59');
  assert.equal(model.formatTime(null, NOW), '未知');
});

test('heat marks under a day as hot and under three days as warm', () => {
  assert.equal(model.heat(NOW + 23 * 36e5, NOW), 'hot');
  assert.equal(model.heat(NOW + 71 * 36e5, NOW), 'warm');
  assert.equal(model.heat(NOW + 73 * 36e5, NOW), '');
  assert.equal(model.heat(null, NOW), '');
});

test('remaining describes the time left', () => {
  assert.equal(model.remaining(NOW + 30 * 60000, NOW), '不到 1 小时');
  assert.equal(model.remaining(NOW + 5.5 * 36e5, NOW), '还剩 5 小时');
  assert.equal(model.remaining(NOW + 50 * 36e5, NOW), '还剩 2 天');
  assert.equal(model.remaining(null, NOW), '无截止信息');
});

test('each tab shows only its status and sorts the most useful task first', () => {
  const tasks = [
    task({ name: '晚截止', end: at(25) }), task({ name: '无截止', end: null }), task({ name: '早截止', end: at(10) }),
    task({ name: '旧完成', finished: true, end: at(1), finishedAt: at(1) }), task({ name: '新完成', finished: true, end: at(8), finishedAt: at(8) }), task({ name: '无完成时间', finished: true, end: at(2) }),
    task({ name: '旧逾期', end: at(2) }), task({ name: '新逾期', end: at(8) })
  ];
  assert.deepEqual(names(model.visibleTasks(tasks, filters(), NOW)), ['早截止', '晚截止', '无截止']);
  assert.deepEqual(names(model.visibleTasks(tasks, filters({ tab: 'done' }), NOW)), ['新完成', '旧完成', '无完成时间']);
  assert.deepEqual(names(model.visibleTasks(tasks, filters({ tab: 'overdue' }), NOW)), ['新逾期', '旧逾期']);
});

test('chips filter by task type and put unknown types under other', () => {
  const tasks = [task({ name: 'a', type: '作业' }), task({ name: 'b', type: '视频课件' }), task({ name: 'c', type: '问卷' }), task({ name: 'd', type: '讨论' }), task({ name: 'e', type: '其他' })];
  assert.deepEqual(names(model.visibleTasks(tasks, filters({ chip: 'media' }), NOW)), ['b']);
  assert.deepEqual(names(model.visibleTasks(tasks, filters({ chip: 'other' }), NOW)), ['c', 'd', 'e']);
});

test('search matches task and course names without case sensitivity', () => {
  const tasks = [task({ name: 'Unit 5', courseName: '英语' }), task({ name: '矩阵', courseName: '线性代数' })];
  assert.deepEqual(names(model.visibleTasks(tasks, filters({ query: ' unit ' }), NOW)), ['Unit 5']);
  assert.deepEqual(names(model.visibleTasks(tasks, filters({ query: '线性' }), NOW)), ['矩阵']);
});

test('a calendar day filters pending tasks only', () => {
  const tasks = [task({ name: '今天', end: at(9) }), task({ name: '明天', end: at(10) }), task({ name: '无截止', end: null }), task({ name: '完成', finished: true, finishedAt: at(1) })];
  assert.deepEqual(names(model.visibleTasks(tasks, filters({ day: 1 }), NOW)), ['明天']);
  assert.deepEqual(model.tabCounts(tasks, filters({ day: 1 }), NOW), { pending: 1, done: 1, overdue: 0 });
});

test('tab counts respect the active filters', () => {
  const tasks = [task({ type: '作业' }), task({ type: '测验' }), task({ type: '作业', end: at(1) })];
  assert.deepEqual(model.tabCounts(tasks, filters({ chip: 'homework' }), NOW), { pending: 1, done: 0, overdue: 1 });
});

test('brief counts today and finds the nearest deadline, ignoring overdue and undated tasks', () => {
  const tasks = [task({ name: '今天一', end: at(9, 18, 0) }), task({ name: '今天二', end: at(9) }), task({ name: '逾期', end: at(9, 8, 0) }), task({ name: '无截止', end: null })];
  const result = model.brief(tasks, NOW);
  assert.equal(result.today, 2);
  assert.equal(result.next.name, '今天一');
  assert.deepEqual(model.brief([], NOW), { today: 0, next: null });
});

test('weekDays returns seven days starting today with deadline counts, across a month end', () => {
  const end = new Date(2026, 10, 28, 12, 0).getTime();
  const days = model.weekDays([task({ end: new Date(2026, 11, 2, 18, 0).getTime() })], end);
  assert.equal(days.length, 7);
  assert.equal(days[0].label, '今');
  assert.deepEqual(days.map(day => day.date), [28, 29, 30, 1, 2, 3, 4]);
  assert.deepEqual(days.map(day => day.count), [0, 0, 0, 0, 1, 0, 0]);
});

test('courseProgress counts finished tasks per course', () => {
  const progress = model.courseProgress([task({ finished: true, finishedAt: at(1) }), task(), task({ courseId: '2' })], NOW);
  assert.deepEqual(progress.get('1'), { done: 1, total: 2 });
  assert.deepEqual(progress.get('2'), { done: 0, total: 1 });
});

test('timeBucket groups by urgency for pending tasks and by recency otherwise', () => {
  assert.equal(model.timeBucket(task({ end: at(9) }), 'pending', NOW), '今天');
  assert.equal(model.timeBucket(task({ end: at(10) }), 'pending', NOW), '明天');
  assert.equal(model.timeBucket(task({ end: at(16) }), 'pending', NOW), '7 天内');
  assert.equal(model.timeBucket(task({ end: at(17) }), 'pending', NOW), '更晚');
  assert.equal(model.timeBucket(task({ end: null }), 'pending', NOW), '时间未知');
  assert.equal(model.timeBucket(task({ finishedAt: at(2) }), 'done', NOW), '近 7 天');
  assert.equal(model.timeBucket(task({ finishedAt: at(1) }), 'done', NOW), '更早');
  assert.equal(model.timeBucket(task({ finishedAt: null }), 'done', NOW), '时间未知');
  assert.equal(model.timeBucket(task({ end: at(1) }), 'overdue', NOW), '更早');
});

test('rowDisplay shows the relevant time and keeps the details for hovering', () => {
  const pending = model.rowDisplay(task({ end: at(9) }), NOW);
  assert.deepEqual([pending.time, pending.tone], ['今天 23:59', 'hot']);
  assert.match(pending.tip, /习题\n高等数学 · 作业 · 11\/1 开始\n还剩 11 小时/);
  assert.match(model.rowDisplay(task({ start: at(12, 8, 0) }), NOW).tip, /未开始/);
  const done = model.rowDisplay(task({ finished: true, finishedAt: at(1, 20, 0), end: at(2) }), NOW);
  assert.deepEqual([done.time, done.tone], ['11/1 20:00', 'good']);
  const overdue = model.rowDisplay(task({ end: at(1) }), NOW);
  assert.deepEqual([overdue.time, overdue.tone], ['11/1 23:59', 'hot']);
  assert.match(model.rowDisplay(task({ start: null }), NOW).tip, /开始时间未知/);
});

test('noticeFor explains every incomplete state instead of showing zero tasks', () => {
  assert.equal(model.noticeFor('ok', '', []), null);
  assert.equal(model.noticeFor('loading', '', []), null);
  assert.equal(model.noticeFor('site-closed', '', []).action, 'open');
  assert.equal(model.noticeFor('login-required', '', []).action, 'open');
  assert.equal(model.noticeFor('error', '读取失败', []).text, '读取失败');
  const stage = (s, name) => ({ courseId: '1', courseName: name, stage: s });
  assert.equal(model.noticeFor('ok', '', [stage('tasks', '高数'), stage('tasks', '物理'), stage('names', '英语')]).text, '高数、物理读取失败，数量可能不完整');
  assert.match(model.noticeFor('ok', '', [stage('unfinished', null)]).text, /可能未读取到/);
  assert.equal(model.noticeFor('ok', '', [stage('names', '英语')]).text, '部分任务名称读取失败');
});

test('openTarget navigates an idle Xiaoya tab and never a tab running the queue', () => {
  const site = { id: 5, url: `${model.ORIGIN}/app/jx-web/mycourse` };
  assert.equal(model.openTarget(site, null), 'same');
  assert.equal(model.openTarget(site, { tabId: 9, enabled: true }), 'same');
  assert.equal(model.openTarget(site, { tabId: 5, enabled: true }), 'new');
  assert.equal(model.openTarget(site, { tabId: 5, enabled: false }), 'same');
  assert.equal(model.openTarget({ id: 5, url: 'https://example.com/' }, null), 'new');
  assert.equal(model.openTarget({ id: 5 }, null), 'new');
  assert.equal(model.openTarget(undefined, null), 'new');
});
