const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const schema = require('../extension/ai-question.js');
require('../extension/answer-dom.js');
const batch = require('../extension/answer-batch.js');
const { createAdapter } = require('../extension/answer-page.js');
const { createDriver } = require('../extension/answer-driver.js');

function paper(questions, permit = async () => true, delay = async () => {}) {
  const task = batch.canonical({ id: 'test', typeCode: 4, courseId: '11', nodeId: '12' });
  const location = new URL('https://whut.ai-augmented.com/app/jx-web/course_paper/mycourse/11/12/13/14');
  const body = questions.map(({ number, type, labels }) => {
    const judgment = type === 'judgment';
    const options = labels.map((text, index) => {
      const label = judgment ? text : `<span class="exam_answer_item_sequence">${'AB'[index]}.</span><span class="xy_rich_text_base">${text}</span>`;
      return `<label class="ant-radio-wrapper"><input type="radio" name="q${number}" ${judgment ? '' : `value="${index + 1}"`}>${label}</label>`;
    });
    return `<div class="question"><div class="exam_question_stem"><span class="sequence">${number}.</span><span class="score">${judgment ? '判断题' : '单选题'}</span><div class="stem_title">模拟题 ${number}</div></div>
      <div id="question_${number}">${options.join('')}</div></div>`;
  });
  const cards = questions.map(({ number }) => `<li><a id="#${number}">${number}</a></li>`);
  const { document } = parseHTML(`<html><body><div id="survey_page"><span class="score_sub_title">共${questions.length}题</span>
    <div id="question_content">${body.join('')}</div><div class="answer_info_card"><ul class="sheet_list">${cards.join('')}</ul></div>
    <button type="submit">交卷</button></div></body></html>`);
  const rows = document.querySelectorAll('.sheet_list li');
  for (const [index, node] of document.querySelectorAll('.question').entries()) {
    const group = [...node.querySelectorAll('input')];
    for (const field of group) {
      field.checked = false;
      field.addEventListener('click', () => {
        // Linkedom dispatches the click but does not update radio groups as a browser would.
        group.forEach(other => { other.checked = other === field; });
        rows[index].title = '已答题';
        rows[index].className = 'finish';
      });
    }
  }
  const adapter = createAdapter({ document, location, uuid: () => 'page', permit, delay });
  const command = (action, options = {}) => adapter.command({ action, task, batchId: 'batch', pageToken: 'page', ...options });
  return { document, fields: [...document.querySelectorAll('input')], task, location, adapter, command, inspect: () => adapter.inspect(task) };
}
const judgmentPaper = labels => paper([{ number: 2, type: 'judgment', labels }]);

test('whole-paper judgments use visible meanings and submit after the answer card syncs', async () => {
  for (const [labels, answer, index] of [
    [['错误', '正确'], true, 1], [['对', '错'], false, 1],
    [['<span class="exam_answer_item_sequence">A.</span> ×', '<span class="exam_answer_item_sequence">B.</span> √'], false, 0]
  ]) {
    const p = judgmentPaper(labels), snapshot = p.inspect(), item = snapshot.questions[0];
    assert.equal(batch.questionProblems(snapshot.questions), '');
    assert.deepEqual([item.state, item.writable], ['empty', true]);
    const { solution } = schema.answer(JSON.stringify({ answer, explanation: '测试' }), item.question);
    await p.command('fill', { item: { id: item.question.id, fingerprint: item.fingerprint, solution } });
    assert.equal(p.fields[index].checked, true);
    assert.equal(p.inspect().questions[0].state, 'done');
    let submits = 0;
    p.document.querySelector('button').addEventListener('click', () => submits++);
    await p.command('submit', { fingerprint: snapshot.fingerprint });
    assert.equal(submits, 1);
  }
});

test('judgments keep manual answers and leave ambiguous unchecked radios untouched', async () => {
  const p = judgmentPaper(['正确', '错误']), item = p.inspect().questions[0];
  p.fields[1].click();
  const response = await p.command('fill', { item: { id: item.question.id, fingerprint: item.fingerprint, solution: { kind: 'judgment', value: true } } });
  assert.equal(response.preserved, true);
  assert.equal(p.fields[1].checked, true);
  const ambiguous = judgmentPaper(['正确', '是']);
  assert.match(batch.questionProblems(ambiguous.inspect().questions), /第 2 题（判断题）.*无法.*区分正误/);
  assert.ok(ambiguous.fields.every(field => !field.checked));
});

test('judgment recognizes unambiguous wrapped and punctuated visible meanings', async () => {
  for (const [labels, value, index] of [
    [['（正确）', '（错误）'], true, 0],
    [['正确。', '错误。'], false, 1],
    [['<span class="exam_answer_item_sequence">A.</span> [错误]', '<span class="exam_answer_item_sequence">B.</span> [正确]'], true, 1],
    [['［×］', '【√】'], false, 0],
    [['“true”', '(false。)'], false, 1]
  ]) {
    const p = judgmentPaper(labels), item = p.inspect().questions[0];
    assert.equal(item.writable, true, `拒绝了明确的判断选项 ${JSON.stringify(labels)}：${item.reason}`);
    const { solution } = schema.answer(JSON.stringify({ answer: value, explanation: '测试' }), item.question);
    await p.command('fill', { item: { id: item.question.id, fingerprint: item.fingerprint, solution } });
    assert.equal(p.fields[index].checked, true);
    assert.equal(p.inspect().questions[0].state, 'done');
  }
});

test('judgment refuses ambiguous, malformed or conflicting meanings instead of guessing', () => {
  for (const labels of [
    ['正确？', '错误'], ['（正确', '错误）'], ['正确或错误', '错误'],
    ['不是正确', '正确'], ['（正确）', '[是]'], ['A.', 'B.']
  ]) {
    const p = judgmentPaper(labels), item = p.inspect().questions[0];
    assert.equal(item.writable, false, `不能猜测判断选项 ${JSON.stringify(labels)}`);
    assert.ok(p.fields.every(field => !field.checked));
  }
});

test('the batch queries and fills 28 objective questions, including all ten reported judgment positions, then confirms submission once', async () => {
  const judgments = [2, 3, 7, 9, 10, 17, 18, 20, 23, 28];
  const questions = Array.from({ length: 28 }, (_, i) => {
    const number = i + 1, positive = number % 2 === 0;
    if (judgments.includes(number)) {
      const labels = number % 3 ? ['错误', '正确'] : ['正确', '错误'];
      return { number, type: 'judgment', labels, answer: positive, expected: labels.indexOf(positive ? '正确' : '错误') };
    }
    return { number, type: 'single', labels: ['甲', '乙'], answer: [positive ? 'A' : 'B'], expected: positive ? 0 : 1 };
  });
  const p = paper(questions, action => engine.permit(action));
  const submitted = [];
  const button = p.document.querySelector('button[type=submit]');
  button.addEventListener('click', () => {
    submitted.push('submit');
    const modal = p.document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.innerHTML = '<p>是否确定提交？</p><button>确定</button>';
    p.document.body.append(modal);
    modal.querySelector('button').addEventListener('click', () => {
      submitted.push('confirm');
      modal.remove();
      button.disabled = true;
      button.textContent = '已提交';
    });
  });
  let clock = 0;
  const driver = createDriver({
    chrome: { tabs: {
      create: async () => ({ id: 1 }),
      get: async () => ({ id: 1, url: p.location.href }),
      sendMessage: async (_id, message) => p.adapter.command(message)
    } },
    getBatchId: () => 'batch', now: () => clock, delay: async ms => { clock += ms; }
  });
  const queries = [];
  const engine = batch.createEngine({
    driver, storage: { get: async () => ({}), set: async () => {} },
    getAccount: async () => 'account', uuid: () => 'batch',
    query: async question => {
      const number = Number(question.id.slice('question_'.length));
      queries.push([number, question.type]);
      return schema.answer(JSON.stringify({ answer: questions[number - 1].answer, explanation: '模拟解析' }), question);
    }
  });
  await engine.start({ account: 'account', tasks: [p.task] });
  await new Promise(resolve => setImmediate(resolve));
  const state = await engine.get();
  assert.equal(state.results[0].status, 'done', state.results[0].message);
  assert.equal(state.stage, 'finished');
  assert.deepEqual(queries, questions.map(({ number, type }) => [number, type]));
  for (const { number, expected } of questions) {
    const fields = [...p.document.getElementById(`question_${number}`).querySelectorAll('input')];
    assert.deepEqual(fields.map(field => field.checked), [expected === 0, expected === 1], `第 ${number} 题`);
  }
  assert.deepEqual(submitted, ['submit', 'confirm']);
});

test('judgment refuses radio/label mismatch and extra radios without touching answers', async () => {
  for (const setup of [p => {
    const labels = [...p.document.querySelectorAll('label.ant-radio-wrapper')];
    labels[0].append(p.fields[1]);
  }, p => {
    const extra = p.document.createElement('input'); extra.type = 'radio'; extra.name = 'q2'; extra.checked = true;
    p.document.querySelector('#question_2').append(extra);
  }, p => {
    const extra = p.document.createElement('input'); extra.type = 'radio'; extra.name = 'q2'; extra.checked = true;
    p.document.body.append(extra);
  }]) {
    const p = judgmentPaper(['正确', '错误']); setup(p);
    const all = [...p.document.querySelectorAll('input[type=radio]')], checked = all.map(field => field.checked);
    const item = p.inspect().questions[0];
    assert.equal(item.state, 'unknown'); assert.equal(item.writable, false); assert.ok(item.reason);
    await assert.rejects(p.command('fill', { item: { id: item.question.id, fingerprint: item.fingerprint, solution: { kind: 'judgment', value: false } } }), /该题无法可靠填写/);
    assert.deepEqual(all.map(field => field.checked), checked);
  }
});

test('judgment preserves two manually checked radios but never treats the conflict as done', async () => {
  const p = judgmentPaper(['正确', '错误']);
  p.fields[0].name = 'a'; p.fields[1].name = 'b';
  p.fields[0].checked = true; p.fields[1].checked = true;
  const item = p.inspect().questions[0];
  assert.equal(item.state, 'unknown'); assert.equal(item.writable, false); assert.match(item.reason, /多个.*已选/);
  await assert.rejects(p.command('fill', { item: { id: item.question.id, fingerprint: item.fingerprint, solution: { kind: 'judgment', value: false } } }));
  assert.deepEqual(p.fields.map(field => field.checked), [true, true]);
});

test('judgment aborts without writing when permission wait swaps mapped radio nodes', async () => {
  let p, calls = 0;
  p = paper([{ number: 2, type: 'judgment', labels: ['正确', '错误'] }], async () => {
    if (++calls === 1) { const labels = [...p.document.querySelectorAll('label.ant-radio-wrapper')]; labels[0].append(p.fields[1]); labels[1].append(p.fields[0]); }
    return true;
  });
  const item = p.inspect().questions[0];
  await assert.rejects(p.command('fill', { item: { id: item.question.id, fingerprint: item.fingerprint, solution: { kind: 'judgment', value: false } } }), error => error.fillBeforeWrite === true);
  assert.deepEqual(p.fields.map(field => field.checked), [false, false]);
});

test('judgment stops after a write if radios change while awaiting the page', async () => {
  let p, delays = 0;
  p = paper([{ number: 2, type: 'judgment', labels: ['正确', '错误'] }], async () => true, async () => {
    if (++delays === 1) { const labels = [...p.document.querySelectorAll('label.ant-radio-wrapper')]; labels[0].append(p.fields[1]); labels[1].append(p.fields[0]); }
  });
  const item = p.inspect().questions[0];
  await assert.rejects(p.command('fill', { item: { id: item.question.id, fingerprint: item.fingerprint, solution: { kind: 'judgment', value: false } } }), error => error.fillBeforeWrite === false);
});

test('judgment does not submit if controls swap after fill', async () => {
  const p = judgmentPaper(['正确', '错误']);
  const item = p.inspect().questions[0];
  await p.command('fill', { item: { id: item.question.id, fingerprint: item.fingerprint, solution: { kind: 'judgment', value: false } } });
  const labels = [...p.document.querySelectorAll('label.ant-radio-wrapper')];
  labels[0].append(p.fields[1]); labels[1].append(p.fields[0]);
  assert.notEqual(p.inspect().questions[0].fingerprint, item.fingerprint);
  const result = await p.command('submit', { fingerprint: item.fingerprint });
  assert.equal(result.blocked, true);
});

test('judgment keeps an answer manually selected during permission wait', async () => {
  let p, calls = 0;
  p = paper([{ number: 2, type: 'judgment', labels: ['正确', '错误'] }], async () => {
    if (++calls === 1) p.fields[0].click(); return true;
  });
  const item = p.inspect().questions[0];
  const result = await p.command('fill', { item: { id: item.question.id, fingerprint: item.fingerprint, solution: { kind: 'judgment', value: false } } });
  assert.equal(result.preserved, true);
  assert.deepEqual(p.fields.map(field => field.checked), [true, false]);
});
