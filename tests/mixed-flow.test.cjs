const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const schema = require('../extension/ai-question.js');
require('../extension/answer-dom.js');
const batch = require('../extension/answer-batch.js');
const { createAdapter } = require('../extension/answer-page.js');
const { createDriver } = require('../extension/answer-driver.js');

test('a mixed paper fills judgments on either side of an unsupported item, keeps manual input and never submits', async () => {
  const row = (n, type, stem, controls) => '<div class="question"><div class="exam_question_stem"><span class="sequence">' + n + '.</span><span class="score">' + type + '</span><div class="stem_title">' + stem + '</div></div><div id="question_' + n + '">' + controls + '</div></div>';
  const tf = (n, labels) => row(n, '判断题', '模拟判断 ' + n, labels.map(text => '<label class="ant-radio-wrapper"><input type="radio" name="q' + n + '">' + text + '</label>').join(''));
  const { document } = parseHTML('<div id="survey_page"><div class="score_sub_title">共4题</div><div id="question_content">' +
    tf(1, ['（错误）', '（正确）']) + row(2, '匹配题', '保留人工匹配', '<select><option>甲</option><option selected>乙</option></select>') +
    tf(3, ['√', '×']) + tf(4, ['对', '错']) + '</div><div class="answer_info_card"><ul class="sheet_list">' +
    [1, 2, 3, 4].map(i => '<li><a id="#' + i + '">' + i + '</a></li>').join('') +
    '</ul></div><button type="submit">交卷</button></div>');
  const hits = [], submitted = [], queried = [];
  for (const n of [1, 3, 4]) {
    const radios = [...document.querySelectorAll('#question_' + n + ' input')];
    for (const [i, radio] of radios.entries()) {
      radio.checked = n === 4 && i === 0;
      radio.addEventListener('click', () => {
        hits.push([n, i]); radios.forEach(other => { other.checked = other === radio; });
      });
    }
  }
  document.querySelector('button').addEventListener('click', () => submitted.push('submit'));
  const original = document.querySelector('select').outerHTML;
  const task = batch.canonical({ id: 'mixed', typeCode: 4, courseId: '11', nodeId: '12' });
  const location = new URL('https://whut.ai-augmented.com/app/jx-web/course_paper/mycourse/11/12/13/14');
  const adapter = createAdapter({ document, location, permit: action => engine.permit(action), uuid: () => 'local-paper', delay: async () => {} });
  let now = 0;
  const driver = createDriver({ chrome: { tabs: {
    create: async () => ({id: 1}), get: async () => ({id: 1, url: location.href}),
    sendMessage: async (_, message) => adapter.command(message)
  } }, getBatchId: () => 'local-batch', now: () => now, delay: async ms => { now += ms; } });
  const engine = batch.createEngine({ driver, uuid: () => 'local-batch', storage: {get: async () => ({}), set: async () => {}},
    getAccount: async () => 'local-account',
    query: async question => {
      queried.push(question.id);
      return schema.answer(JSON.stringify({answer: question.id === 'question_1', explanation: '模拟'}), question);
    }
  });
  await engine.start({ account: 'local-account', tasks: [task] });
  for (let i = 0; i < 100 && engine.busy(); i++) await new Promise(resolve => setImmediate(resolve));
  const state = await engine.get(), result = state.results[0];
  assert.equal(state.stage, 'finished');
  assert.equal(result.status, 'draft', result.message);
  assert.equal(result.needsReview, true);
  assert.match(result.message, /第 2 题/);
  assert.equal(result.draftPage.pageToken, 'local-paper');
  assert.deepEqual(queried, ['question_1', 'question_3']);
  assert.deepEqual(hits, [[1, 1], [3, 1]]);
  assert.deepEqual(submitted, []);
  assert.equal(document.querySelector('select').outerHTML, original);
  assert.equal(document.querySelector('#question_4 input').checked, true);
});
