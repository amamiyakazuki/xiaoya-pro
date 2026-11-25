const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
require('../extension/ai-question.js');
require('../extension/answer-dom.js');
const batch = require('../extension/answer-batch.js');
const { createAdapter } = require('../extension/answer-page.js');
const { createDriver } = require('../extension/answer-driver.js');

const question = (id, label, content, stem = '独立的样题') => `<div class="question"><div class="exam_question_stem"><span class="sequence">${id}.</span><div class="stem_title">${stem}</div><span class="score">[${label} 10 分]</span></div><div id="question_${id}">${content}</div></div>`;
function paper(items, options = {}) {
  const task = batch.canonical({ id: 'test', typeCode: 4, courseId: '11', nodeId: '12' });
  const location = new URL(options.preview ? task.url : 'https://whut.ai-augmented.com/app/jx-web/course_paper/mycourse/11/12/13/14');
  const cards = (options.cards || items.map((_, i) => i + 1)).map(id => `<li title="已答题" class="finish"><a id="#${id}">${id}</a></li>`).join('');
  const { document } = parseHTML(`<html><body><div id="survey_page"><span class="score_sub_title">共${options.total || items.length}题</span><div id="question_content">${items.join('')}</div><div class="answer_info_card"><ul class="sheet_list">${cards}</ul></div><button type="submit">交卷</button></div></body></html>`);
  const adapter = createAdapter({ document, location, permit: options.permit || (async () => true), uuid: () => 'page', delay: async () => {} });
  const command = (action, extra = {}) => adapter.command({ action, task, batchId: 'batch', pageToken: 'page', ...extra });
  return { task, location, document, adapter, command, inspect: () => adapter.inspect(task) };
}
const knownUnknown = () => question(2, '特殊题', '<select><option>秘密选项</option></select>');
const unsupportedMedia = () => question(4, '简答题', '<textarea>不得覆盖的人工答案</textarea>', '题干含媒体<video src="secret.mp4"></video>');
const compound = () => question(5, '材料题', [question(6, '简答题', '<textarea disabled></textarea>'), question(7, '简答题', '<textarea></textarea>')].join(''));

test('mixed paper exposes safely located skipped items without exposing unsupported content', () => {
  const p = paper([question(1, '简答题', '<textarea>人工答案</textarea>'), knownUnknown(), question(3, '简答题', '<textarea></textarea>'), unsupportedMedia()]);
  const s = p.inspect();
  assert.equal(s.complete, true);
  assert.equal(s.partialSafe, true);
  assert.deepEqual(s.questions.map(item => item.question.id), ['question_1', 'question_2', 'question_3', 'question_4']);
  assert.equal(s.questions[0].state, 'done');
  assert.equal(s.questions[0].skipReason, undefined);
  assert.equal(s.questions[2].writable, true);
  for (const i of [1, 3]) assert.ok(s.questions[i].skipReason, `missing skipped reason for ${i}`);
  assert.deepEqual(s.questions[3].question, { id: 'question_4' });
  assert.ok(!JSON.stringify(s).includes('秘密选项'));
  assert.ok(!JSON.stringify(s).includes('不得覆盖的人工答案'));
  assert.ok(!JSON.stringify(s).includes('secret.mp4'));
});

test('a blocked combination is one skipped root; attachment handling is not altered', () => {
  const p = paper([question(1, '简答题', '<textarea></textarea>'), compound()], { total: 2, cards: [1, 5] });
  const s = p.inspect(), item = s.questions[1];
  assert.equal(s.complete, true);
  assert.equal(item.question.id, 'question_5');
  assert.deepEqual(item.partIds, ['question_6', 'question_7']);
  assert.match(item.skipReason, /小题/);
  assert.equal(item.writable, false);
  assert.equal(s.questions[0].writable, true);
});

test('visible unsupported drag and ARIA controls are skipped, while an empty shell stays blocking', () => {
  for (const markup of ['<div draggable="true">甲</div>', '<div role="listbox"><div role="option">乙</div></div>', '<div role="combobox">选择</div>']) {
    const p = paper([question(1, '排序题', markup)]);
    const s = p.inspect();
    assert.equal(s.complete, true);
    assert.ok(s.questions[0].skipReason);
    assert.equal(s.questions[0].writable, false);
  }
  const empty = paper([question(1, '排序题', '<input type="hidden">')]);
  assert.equal(empty.inspect().questions[0].skipReason, undefined);
  assert.match(batch.questionProblems(empty.inspect().questions), /无法|未找到/);
  const hidden = paper([question(1, '排序题', '<div aria-hidden="true"><div draggable="true">未加载</div></div>')]);
  assert.equal(hidden.inspect().questions[0].skipReason, undefined);
  const search = paper([question(1, '匹配题', '<div role="listbox"><div role="option">选择</div><input type="text" value="已有搜索词"></div>')]);
  const entry = search.inspect().questions[0];
  assert.equal(entry.typeName, '匹配题');
  assert.equal(entry.state, 'unknown');
  assert.equal(entry.writable, false);
  assert.ok(entry.skipReason);
});

test('a media parsing failure in a compound may be skipped only when each child ID is unique and counted', () => {
  const content = question(6, '简答题', '<textarea>已有子题答案</textarea>', '无法读取<video></video>') + question(7, '简答题', '<textarea></textarea>');
  const p = paper([question(5, '材料题', content)], { total: 2, cards: [6, 7] });
  const s = p.inspect();
  assert.equal(s.complete, true);
  assert.equal(s.questions[0].question.id, 'question_5');
  assert.deepEqual(s.questions[0].partIds, ['question_6', 'question_7']);
  assert.ok(s.questions[0].skipReason);
  assert.ok(!JSON.stringify(s).includes('已有子题答案'));
  p.document.querySelector('#question_7').id = 'question_6';
  assert.equal(p.inspect().complete, false);
});

test('skipped fingerprint remains stable across other writes and detects live changes without leaking their values', async () => {
  const p = paper([question(1, '简答题', '<textarea></textarea>'), knownUnknown(), unsupportedMedia()]);
  const before = p.inspect(), first = before.questions[0];
  const filled = await p.command('fill', { item: { id: first.question.id, fingerprint: first.fingerprint, paperFingerprint: before.fingerprint, solution: { kind: 'text', text: '新答案' } } });
  assert.ok(filled.filled);
  assert.equal(p.inspect().fingerprint, before.fingerprint);
  const skipped = p.document.querySelector('#question_4 textarea');
  skipped.value = '刚刚人工修改，不可泄漏';
  const after = p.inspect();
  assert.notEqual(after.fingerprint, before.fingerprint);
  assert.ok(!JSON.stringify(after).includes('刚刚人工修改，不可泄漏'));
  await assert.rejects(p.command('fill', { item: { id: first.question.id, fingerprint: first.fingerprint, paperFingerprint: before.fingerprint, solution: { kind: 'text', text: '不应填写' } } }), /变化|核对/);
});

test('unknown identity, loading, preview and disabled paper never become safe to fill partially', () => {
  const invalid = paper([question(1, '简答题', '<textarea></textarea>'), knownUnknown()]);
  invalid.document.querySelector('#question_2').insertAdjacentHTML('afterend', '<div id="question_222"></div>');
  assert.equal(invalid.inspect().complete, false);
  const duplicate = paper([question(1, '简答题', '<textarea></textarea>'), knownUnknown()]);
  duplicate.document.querySelector('#question_2').id = 'question_1';
  assert.equal(duplicate.inspect().complete, false);
  const loading = paper([question(1, '简答题', '<textarea></textarea>'), question(2, '简答题', '<textarea></textarea>', '<img>')]);
  assert.equal(loading.inspect().complete, false);
  const preview = paper([knownUnknown()], { preview: true });
  assert.equal(preview.inspect().partialSafe, false);
  const readonly = paper([knownUnknown()]);
  readonly.document.querySelector('button[type=submit]').disabled = true;
  assert.equal(readonly.inspect().partialSafe, false);
  const spinner = paper([knownUnknown()]);
  spinner.document.querySelector('#survey_page').setAttribute('aria-busy', 'true');
  assert.equal(spinner.inspect().partialSafe, false);
  const blocked = paper([knownUnknown()]);
  const modal = blocked.document.createElement('div');
  modal.setAttribute('role', 'dialog');
  blocked.document.body.append(modal);
  assert.equal(blocked.inspect().partialSafe, false);
});

test('a partially skipped paper cannot be submitted by a direct page command', async () => {
  const p = paper([question(1, '简答题', '<textarea>已答</textarea>'), knownUnknown()]);
  let clicks = 0;
  p.document.querySelector('button').addEventListener('click', () => clicks++);
  const s = p.inspect();
  const result = await p.command('submit', { fingerprint: s.fingerprint });
  assert.equal(result.blocked, true);
  assert.equal(clicks, 0);
});

test('known answered disabled fields are preserved as done, not skipped', () => {
  const p = paper([question(1, '简答题', '<textarea disabled>人工答案</textarea>'), knownUnknown()]);
  const first = p.inspect().questions[0];
  assert.equal(first.state, 'done');
  assert.equal(first.skipReason, undefined);
});

test('a skipped question changing while authorization is pending prevents the write', async () => {
  let p, mutated = false;
  p = paper([question(1, '简答题', '<textarea></textarea>'), unsupportedMedia()], {
    permit: async action => {
      if (action.action === 'fill' && !mutated) {
        mutated = true;
        p.document.querySelector('#question_4 textarea').value = '人工更新';
      }
      return true;
    }
  });
  const s = p.inspect(), item = s.questions[0];
  await assert.rejects(p.command('fill', { item: { id: item.question.id, fingerprint: item.fingerprint, paperFingerprint: s.fingerprint, solution: { kind: 'text', text: '禁止填写' } } }), /变化|核对/);
  assert.equal(p.document.querySelector('#question_1 textarea').value, '');
  assert.equal(p.document.querySelector('#question_4 textarea').value, '人工更新');
});

test('a paper that becomes skipped after the first submit click cannot be confirmed', async () => {
  const p = paper([question(1, '简答题', '<textarea>已答</textarea>')]);
  const s = p.inspect();
  let confirms = 0;
  await p.command('submit', { fingerprint: s.fingerprint });
  const subject = p.document.querySelector('#question_1');
  subject.innerHTML = '<select><option>不再可自动读取</option></select>';
  p.document.querySelector('.score').textContent = '[特殊题 10 分]';
  const modal = p.document.createElement('div');
  modal.setAttribute('role', 'dialog');
  modal.innerHTML = '<p>是否确定提交？</p><button>确定</button>';
  p.document.body.append(modal);
  modal.querySelector('button').addEventListener('click', () => confirms++);
  await assert.rejects(p.command('confirm'), /变化|核对/);
  assert.equal(confirms, 0);
});

test('real page, driver and batch fill supported questions around skipped items and leave a draft', async () => {
  let engine, data = {}, clicks = 0;
  const p = paper([
    question(1, '简答题', '<textarea>已有人工答案</textarea>'), knownUnknown(),
    question(3, '简答题', '<textarea></textarea>'), unsupportedMedia(),
    question(5, '简答题', '<textarea></textarea>')
  ], { permit: action => engine.permit(action) });
  p.document.querySelector('button[type=submit]').addEventListener('click', () => clicks++);
  let clock = 0;
  const driver = createDriver({ chrome: { tabs: {
    create: async () => ({ id: 8 }), get: async () => ({ id: 8, url: p.location.href }),
    sendMessage: async (_id, message) => p.adapter.command(message)
  } }, getBatchId: () => 'batch', now: () => clock, delay: async ms => { clock += ms; } });
  const queries = [];
  engine = batch.createEngine({ driver, storage: {
    get: async () => data, set: async value => { data = structuredClone(value); }
  }, getAccount: async () => 'account', uuid: () => 'batch',
  query: async question => { queries.push(question.id); return { solution: { kind: 'text', text: `答复 ${question.id}` } }; } });
  await engine.start({ account: 'account', tasks: [p.task] });
  for (let i = 0; engine.busy() && i < 100; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(engine.busy(), false);
  const result = (await engine.get()).results[0];
  assert.equal(result.status, 'draft', result.message);
  assert.match(result.message, /第 2 题/);
  assert.match(result.message, /第 4 题/);
  assert.deepEqual(queries, ['question_3', 'question_5']);
  assert.equal(p.document.querySelector('#question_1 textarea').value, '已有人工答案');
  assert.equal(p.document.querySelector('#question_3 textarea').value, '答复 question_3');
  assert.equal(p.document.querySelector('#question_4 textarea').value, '不得覆盖的人工答案');
  assert.equal(p.document.querySelector('#question_5 textarea').value, '答复 question_5');
  assert.equal(clicks, 0);
  assert.deepEqual(result.draftPage, { tabId: 8, pageToken: 'page' });
  for (const secret of ['已有人工答案', '不得覆盖的人工答案', 'secret.mp4', '答复 question_3']) assert.ok(!JSON.stringify(data).includes(secret));
});
