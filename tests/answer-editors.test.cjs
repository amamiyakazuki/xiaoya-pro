const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
require('../extension/ai-question.js');
require('../extension/answer-dom.js');
const batch = require('../extension/answer-batch.js');
const { createAdapter } = require('../extension/answer-page.js');

const task = batch.canonical({ id: 't', courseId: '1', nodeId: '2', typeCode: 2 });
const editor = '<div class="DraftEditor-root"><span class="public-DraftEditorPlaceholder-root">请输入答案</span><div class="public-DraftEditor-content" contenteditable="true"><div data-block="true"><br></div></div></div>';
function paper(label, body, delay = async () => {}) {
  const { document, window } = parseHTML(`<html><body><div id="survey_page"><span class="score_sub_title">共1题</span><div id="question_content"><div class="question"><div class="exam_question_stem"><div class="stem_title">请作答。</div><span class="score">[${label} 10分]</span></div><div id="question_9">${body}</div></div></div></div></body></html>`);
  // Linkedom does not implement these browser clipboard event constructors.
  window.DataTransfer = class extends Map {
    setData(type, value) { this.set(type, value); }
    getData(type) { return this.get(type); }
  };
  window.ClipboardEvent = class extends window.Event {
    constructor(type, init) { super(type, init); this.clipboardData = init.clipboardData; }
  };
  const adapter = createAdapter({ document, location: new URL(task.url), permit: async () => true, uuid: () => 'page', delay });
  const inspect = () => adapter.inspect(task).questions[0];
  const fill = text => adapter.command({ action: 'fill', task, batchId: 'batch', pageToken: 'page', item: {
    id: 'question_9', fingerprint: inspect().fingerprint, solution: { kind: 'text', text }
  } });
  return { document, inspect, fill };
}

test('Draft.js editor handles plain-text paste, preserving paragraph breaks and passing readback', async () => {
  const p = paper('论述题', editor);
  const field = p.document.querySelector('[contenteditable]');
  const blank = p.inspect();
  assert.equal(blank.state, 'empty');
  assert.equal(blank.writable, true);
  field.addEventListener('paste', event => {
    const paragraphs = event.clipboardData.getData('text/plain').split('\n');
    field.replaceChildren(...paragraphs.map(text => {
      const block = p.document.createElement('div');
      block.setAttribute('data-block', 'true');
      block.textContent = text;
      return block;
    }));
  });
  const text = '第一段\n\n第二段 <保留原文>';
  assert.equal((await p.fill(text)).filled, true);
  assert.equal((await p.fill('替换')).preserved, true);
  const answered = p.inspect();
  assert.equal(answered.state, 'done');
  assert.equal(answered.fingerprint, blank.fingerprint);
  assert.ok(!JSON.stringify(answered).includes('第一段'));
  assert.deepEqual([...field.children].map(block => block.textContent), text.split('\n'));
});

test('an editor that rejects paste stays empty and fails the fill', async () => {
  const p = paper('计算题', editor);
  await assert.rejects(p.fill('计算步骤'), /输入内容未被页面保留/);
  assert.equal(p.inspect().state, 'empty');
});

test('a late editor rerender cannot silently replace an answer with truncated text', async () => {
  const p = paper('论述题', editor, async ms => {
    if (ms === 500) p.document.querySelector('[data-block]').textContent = '仅保留开头';
  });
  const field = p.document.querySelector('[contenteditable]');
  field.addEventListener('paste', event => { field.querySelector('[data-block]').textContent = event.clipboardData.getData('text/plain'); });
  await assert.rejects(p.fill('仅保留开头会丢掉这一段'), /输入内容未被页面保留/);
});

test('an existing image-only rich answer is preserved', async () => {
  const p = paper('简答题', editor);
  const block = p.document.querySelector('[data-block]');
  block.replaceChildren(p.document.createElement('img'));
  assert.equal(p.inspect().state, 'done');
  assert.equal((await p.fill('改写')).preserved, true);
  assert.ok(block.querySelector('img'));
});

test('an open question supports a single text control but leaves mixed or ambiguous inputs for review', async () => {
  const p = paper('案例分析', '<input>');
  assert.equal(p.inspect().question.type, 'open');
  assert.equal((await p.fill('案例说明')).filled, true);
  assert.equal(p.document.querySelector('input').value, '案例说明');
  for (const body of ['<textarea></textarea><input type="checkbox">', '<textarea></textarea><textarea></textarea>']) {
    assert.equal(paper('其他', body).inspect().writable, false);
  }
});
