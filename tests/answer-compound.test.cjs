const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const schema = require('../extension/ai-question.js');
const dom = require('../extension/answer-dom.js');
const batch = require('../extension/answer-batch.js');
const { createAdapter } = require('../extension/answer-page.js');
const { createDriver } = require('../extension/answer-driver.js');

function question(id, type, stem, subject) {
  return `<div class="question"><div class="exam_question_stem"><div class="stem_title">${stem}</div>
    <span class="score">${type} 10 分</span></div><div id="question_${id}">${subject}</div></div>`;
}
const material = question(1, '材料题', '共用材料：三个苹果。', [
  question(2, '判断题', '苹果共有三个。', '<label class="ant-radio-wrapper">错</label><label class="ant-radio-wrapper">对</label>'),
  question(3, '填空题', '加一个后有几个？', '<div class="_label">填空1:</div><textarea>我的答案</textarea>')
].join(''));

test('compound batch solution keeps answers paired by child ID when the AI reverses their order', () => {
  const node = parseHTML(material).document.querySelector('.question');
  const { question } = dom.extract(node);
  assert.deepEqual(dom.childQuestions(node).map(child => dom.extract(child).question.id), ['question_2', 'question_3']);
  const sent = schema.messages(question)[1].content;
  assert.match(sent, /共用材料：三个苹果。/);
  assert.doesNotMatch(sent, /我的答案/);
  const result = schema.answer(JSON.stringify({
    answer: [
      { id: 'question_3', answer: ['4'], explanation: '加一' },
      { id: 'question_2', answer: true, explanation: '见材料' }
    ],
    explanation: '按材料回答'
  }), question);
  assert.deepEqual(result.solution, { kind: 'compound', parts: [
    { id: 'question_2', solution: { kind: 'judgment', value: true } },
    { id: 'question_3', solution: { kind: 'fill', values: ['4'] } }
  ] });
  assert.equal(result.answer, '第 1 小题\n正确\n解释：见材料\n\n第 2 小题\n第 1 空：4\n解释：加一');
  const duplicate = { id: 'question_2', answer: true, explanation: '见材料' };
  assert.throws(() => schema.answer(JSON.stringify({ answer: [duplicate, duplicate], explanation: '重复' }), question), /answer/);
});

test('reading pending children includes common material and renumbers only their images', () => {
  const markup = question(10, '材料题', '共用图<img src="all.png">', [
    question(11, '简答题', '已答题的图<img src="skip.png">', '<textarea>草稿</textarea>'),
    question(12, '附件题', '人工附件题', '<input type="file">'),
    question(13, '简答题', '待答题的图<img src="answer.png">', '<textarea></textarea>')
  ].join(''));
  const node = parseHTML(markup).document.querySelector('.question');
  const full = dom.extract(node);
  assert.deepEqual(full.question.parts.map(part => part.id), ['question_11', 'question_12', 'question_13']);
  assert.deepEqual(full.resources.map(resource => resource.source), ['all.png', 'skip.png', 'answer.png']);
  const { question: selected, resources } = dom.extract(node, ['question_13']);
  assert.match(selected.stem, /共用图 \[图片 1\]/);
  assert.equal(selected.parts.length, 1);
  assert.match(selected.parts[0].stem, /待答题的图 \[图片 2\]/);
  assert.deepEqual(resources.map(resource => resource.source), ['all.png', 'answer.png']);
  assert.match(dom.extract(node, ['question_13', 'question_99']).error, /子题已变化/);
});

async function runCompoundPaper({ total = 3, cards = [2, 3, 4], attachment = false, disabled = false, unfinishedCard } = {}) {
  const task = batch.canonical({ id: 'quiz', typeCode: 4, courseId: '11', nodeId: '12' });
  const location = new URL('https://whut.ai-augmented.com/app/jx-web/course_paper/mycourse/11/12/13/14');
  const questions = question(1, '材料题', '共用材料：观察记录有三天。', [
    question(2, '简答题', '已答子题', '<textarea>人工保留</textarea>'),
    question(3, '填空题', '再加一天共有几天？', '<div class="_label">填空1:</div><textarea></textarea>'),
    question(4, '简答题', '用一句话说明原因。', disabled ? '<textarea disabled></textarea>' : '<textarea></textarea>'),
    attachment ? question(5, '附件题', '上传观察表', '<input type="file">') : ''
  ].join(''));
  const cardList = cards.map(id => `<li><a id="#${id}">${id}</a></li>`).join('');
  const { document } = parseHTML(`<html><body><div id="survey_page"><div class="score_sub_title">共${total}题</div>
    <div id="question_content">${questions}</div><div class="answer_info_card"><ul class="sheet_list">${cardList}</ul></div>
    <button type="submit">交卷</button></div></body></html>`);
  function syncCards() {
    for (const entry of document.querySelectorAll('.sheet_list li')) {
      const id = Number(entry.querySelector('a').id.slice(1));
      const fields = [...document.querySelectorAll(`#question_${id} textarea`)];
      const done = id !== unfinishedCard && fields.every(field => field.value);
      entry.title = done ? '已答题' : '未答题';
      entry.className = done ? 'finish' : '';
    }
  }
  syncCards();
  document.addEventListener('input', syncCards);
  let clicks = 0;
  const submit = document.querySelector('button');
  submit.addEventListener('click', () => {
    clicks++;
    submit.disabled = true;
    submit.textContent = '已提交';
  });
  const adapter = createAdapter({ document, location, permit: message => engine.permit(message), uuid: () => 'page', delay: async () => {} });
  let clock = 0;
  const driver = createDriver({
    chrome: { tabs: {
      async create() { return { id: 1 }; },
      async get() { return { id: 1, url: location.href }; },
      async sendMessage(id, message) { return adapter.command(message); }
    } },
    getBatchId: () => 'batch', now: () => clock, delay: async ms => { clock += ms; }
  });
  const queries = [];
  const engine = batch.createEngine({
    storage: { async get() { return {}; }, async set() {} }, driver, getAccount: async () => 'account', uuid: () => 'batch',
    query: async prompt => {
      queries.push(prompt);
      return schema.answer(JSON.stringify({ answer: [
        { id: 'question_4', answer: '三天再加一天。', explanation: '合并' },
        { id: 'question_3', answer: ['四'], explanation: '加法' }
      ], explanation: '按材料' }), prompt);
    }
  });
  await engine.start({ account: 'account', tasks: [task] });
  for (let attempt = 0; engine.busy() && attempt < 100; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(engine.busy(), false);
  return { result: (await engine.get()).results[0], queries, clicks, texts: [...document.querySelectorAll('textarea')].map(field => field.value) };
}

test('compound paper collects only unanswered children, fills by ID, then submits once with matching root or child cards', async () => {
  for (const layout of [{ total: 1, cards: [1] }, { total: 1, cards: [2, 3, 4] }, { total: 3, cards: [2, 3, 4] }]) {
    const { result, queries, clicks, texts } = await runCompoundPaper(layout);
    assert.equal(result.status, 'done', result.message);
    assert.equal(clicks, 1);
    assert.equal(queries.length, 1);
    assert.deepEqual(queries[0].parts.map(part => part.id), ['question_3', 'question_4']);
    assert.match(queries[0].stem, /共用材料：观察记录有三天/);
    assert.doesNotMatch(JSON.stringify(queries), /人工保留|已答子题/);
    assert.deepEqual(texts, ['人工保留', '四', '三天再加一天。']);
  }
});

test('compound attachment child leaves a draft and the batch completes its other children', async () => {
  const { result, queries, clicks, texts } = await runCompoundPaper({ total: 4, cards: [2, 3, 4, 5], attachment: true });
  assert.equal(result.status, 'draft', result.message);
  assert.match(result.message, /第 4 小题/);
  assert.equal(clicks, 0);
  assert.deepEqual(queries[0].parts.map(part => part.id), ['question_3', 'question_4']);
  assert.deepEqual(texts, ['人工保留', '四', '三天再加一天。']);
});

test('an unreadable compound remains a draft, and unmatched or unfinished cards prevent submission', async () => {
  const blocked = await runCompoundPaper({ disabled: true });
  assert.equal(blocked.result.status, 'draft');
  assert.match(blocked.result.message, /第 3 小题.*禁用/);
  assert.deepEqual(blocked.queries, []);
  assert.deepEqual(blocked.texts, ['人工保留', '', '']);
  assert.equal(blocked.clicks, 0);
  for (const cards of [[1], [2, 3, 99]]) {
    const { result, clicks, queries, texts } = await runCompoundPaper({ total: 3, cards });
    assert.equal(result.status, 'pending');
    assert.match(result.message, /试卷题目未完整读取/);
    assert.equal(clicks, 0);
    assert.deepEqual(queries, []);
    assert.deepEqual(texts, ['人工保留', '', '']);
  }
  for (const layout of [
    { total: 1, cards: [2, 3, 99] },
    { total: 3, cards: [2, 3, 4], unfinishedCard: 4 }
  ]) {
    const { result, clicks, texts } = await runCompoundPaper(layout);
    assert.equal(result.status, 'pending', JSON.stringify(layout));
    assert.match(result.message, /答题卡/);
    assert.equal(clicks, 0);
    assert.deepEqual(texts, ['人工保留', '四', '三天再加一天。']);
  }
});
