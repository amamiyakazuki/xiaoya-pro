const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const schema = require('../extension/ai-question.js');
const dom = require('../extension/answer-dom.js');
const media = require('../extension/answer-media.js');
const client = require('../extension/ai-client.js');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
function node({ label = '填空题', stem = '甲依赖 <span class="xy_richtext_blank_number_warp">(1) ____</span> 和 <span class="xy_richtext_blank_number_warp">(2) ____</span>', subject = 'gap', body = '<div class="_label">填空1:</div><textarea>人工答案不可读取</textarea><div class="_label">填空2:</div><textarea>人工草稿</textarea>', extra = '' } = {}) {
  return parseHTML(`<html><body><div class="question"><div class="exam_question_stem"><div class="stem_title">${stem}</div><span class="score">[ ${label} 20 分 ]</span></div><div id="question_123" class="question_${subject}_subject">${body}</div>${extra}</div></body></html>`).document.querySelector('.question');
}
const q = () => dom.extract(node()).question;
const output = answer => JSON.stringify({ answer, explanation: '解释' });
test('real observed two-blank markup preserves order without reading student input', () => {
  const result = dom.extract(node());
  assert.equal(result.question.type, 'fill'); assert.equal(result.question.blankCount, 2);
  assert.ok(!JSON.stringify(result).includes('人工答案')); assert.ok(!JSON.stringify(result).includes('人工草稿'));
  assert.equal(schema.answer(output(['甲', '乙']), result.question).answer, '第 1 空：甲\n第 2 空：乙');
  for (const bad of [['甲'], ['甲', '乙', '丙'], ['甲', ''], '甲、乙']) assert.throws(() => schema.answer(output(bad), result.question));
});
test('single blank and readonly marker fallback work; contradictory numbering fails closed', () => {
  const stem = '<span class="xy_richtext_blank_number_warp">(1) ____</span>';
  assert.equal(dom.extract(node({ stem, body: '<div class="_label">填空1:</div>' })).question.blankCount, 1);
  assert.equal(dom.extract(node({ body: '' })).question.blankCount, 2);
  assert.ok(dom.extract(node({ body: '<div class="_label">填空1:</div>' })).error);
  assert.ok(dom.extract(node({ body: '<div class="_label">填空2:</div><div class="_label">填空1:</div>' })).error);
});
test('judgment uses visible type and boolean response, independent of option order', () => {
  const question = dom.extract(node({ label: '判断题', stem: '一加一等于二。', subject: 'single', body: '<label class="ant-radio-wrapper"><input type="radio">错误</label><label class="ant-radio-wrapper"><input type="radio">正确</label>' })).question;
  assert.equal(question.type, 'judgment'); assert.equal(question.options[0].text, '错误');
  assert.equal(schema.answer(output(true), question).answer, '正确'); assert.equal(schema.answer(output(false), question).answer, '错误');
  assert.throws(() => schema.answer(output('true'), question));
});
test('essay/calculation/attachment outputs retain paragraphs and do not read uploaded answer names', () => {
  for (const [label, type] of [['论述题', 'essay'], ['计算题', 'calculation'], ['证明题', 'calculation'], ['附件题', 'attachment'], ['名词解释题', 'short']]) {
    const value = dom.extract(node({ label, subject: label === '附件题' ? 'attach' : 'subjective', stem: '回答本题。', body: '<a href="https://secret.test/answer">人工已上传答卷.docx</a><textarea>人工答案</textarea>' }));
    assert.equal(value.question.type, type); assert.ok(!JSON.stringify(value).includes('人工'));
    const payload = answer => JSON.stringify({ answer, explanation: '解释', ...(type === 'attachment' ? { fileName: 'answer.txt' } : {}) });
    const parsed = schema.answer(payload('第一段\n\n第二段'), value.question);
    if (type === 'attachment') {
      // 旧格式（单个内容 + fileName）兼容为一个文件，段落保留。
      assert.deepEqual(parsed.files, [{ fileName: 'answer.txt', content: '第一段\n\n第二段\n' }], '附件题返回可上传的文件');
      assert.throws(() => schema.answer(output('内容'), value.question), '缺少文件名时拒绝，避免上传无名文件');
      assert.throws(() => schema.answer(JSON.stringify({ answer: '内容', explanation: '解释', fileName: '../evil.py' }), value.question));
    } else assert.equal(parsed.answer, '第一段\n\n第二段');
  }
});
test('unfamiliar named text types display a specific unverified generic warning', () => {
  const result = dom.extract(node({ label: '排序题', subject: 'unknown', stem: '给出排序结果。', body: '' }));
  assert.equal(result.question.type, 'open'); assert.match(result.warning, /尚未专项验证/);
});
test('formulas preserve LaTeX and MathML; paragraphs remain separated', () => {
  const result = dom.extract(node({ label: '计算题', subject: 'subjective', stem: '<p>求解</p><p><span class="katex"><span>错误视觉副本</span><annotation encoding="application/x-tex">x^2+1</annotation></span><math><mfrac><mn>1</mn><mi>x</mi></mfrac></math></p>', body: '' }));
  assert.match(result.question.stem, /求解\n/); assert.match(result.question.stem, /x\^2\+1/); assert.match(result.question.stem, /<mfrac>/);
  assert.ok(!result.question.stem.includes('错误视觉副本')); assert.equal(result.resources.length, 0);
});
test('images retain positions in stem and options and prompts use only embedded image data', async () => {
  const value = dom.extract(node({ label: '单选题', subject: 'single', stem: `图中是什么？<img src="${png}">`, body: `<label class="ant-radio-wrapper"><span class="exam_answer_item_sequence">A.</span><div class="xy_rich_text_base"><img src="${png}"></div></label><label class="ant-radio-wrapper"><span class="exam_answer_item_sequence">B.</span><div class="xy_rich_text_base">其他</div></label>` }));
  assert.match(value.question.stem, /图片 1/); assert.match(value.question.options[0].text, /图片 2/);
  const clean = schema.validate(await media.prepare(value, { base: 'https://whut.ai-augmented.com/app/jx-web/test', fetchImpl: () => { throw Error('must not fetch data URLs'); } }));
  const messages = schema.messages(clean, '简洁一点');
  assert.equal(messages[1].content.filter(part => part.type === 'image_url').length, 2);
  assert.ok(!messages[1].content[0].text.includes('data:image')); assert.ok(messages[1].content[0].text.includes('简洁一点'));
});
test('image URL and size restrictions reject credentials and unsupported data', () => {
  for (const url of ['http://example.com/a.png', 'https://u:p@example.com/a.png', 'javascript:alert(1)', 'file:///tmp/a.png', 'blob:https://evil.test/a', 'data:text/html;base64,aGVsbG8=']) assert.throws(() => media.safeURL(url, 'https://whut.ai-augmented.com/app/jx-web/'));
  assert.throws(() => schema.validate({ ...q(), images: Array(9).fill(png) }));
  assert.throws(() => schema.validate({ ...q(), images: ['https://example.com/a.png?token=secret'] }));
});
test('image download includes credentials only same-origin, never in provider content; redirects are blocked', async () => {
  for (const origin of ['https://whut.ai-augmented.com', 'https://cdn.example.com']) {
    let called;
    const result = await media.prepare({ question: q(), resources: [{ kind: 'url', source: `${origin}/image.png?signature=private` }] }, { base: 'https://whut.ai-augmented.com/app/jx-web/', fetchImpl: async (url, init) => { called = init; return new Response(Buffer.from(png.split(',')[1], 'base64'), { headers: { 'content-type': 'image/png' } }); } });
    assert.equal(called.credentials, origin.includes('cdn.') ? 'omit' : 'same-origin'); assert.equal(called.redirect, 'error'); assert.equal(called.referrerPolicy, 'no-referrer');
    assert.ok(!JSON.stringify(schema.messages(result)).includes('signature'));
  }
});
test('failed/oversize/cancelled image loads never produce a partial question', async () => {
  const extracted = { question: q(), resources: [{ kind: 'url', source: 'https://whut.ai-augmented.com/img' }] };
  await assert.rejects(() => media.prepare(extracted, { base: 'https://whut.ai-augmented.com/', fetchImpl: async () => new Response('login', { headers: { 'content-type': 'text/html' } }) }));
  await assert.rejects(() => media.readImage(new Response(new Uint8Array(schema.LIMITS.imageBytes + 1), { headers: { 'content-type': 'image/png' } })));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => media.prepare(extracted, { signal: controller.signal, fetchImpl: () => { throw Error('should not fetch'); } }));
});
test('compound questions retain public material, require every child and correct identity', () => {
  const child = '<div class="question"><div class="exam_question_stem"><div class="stem_title">子题：1+1</div><span class="score">简答题 10 分</span></div><div class="question_subjective_subject" id="question_456"></div></div>';
  const result = dom.extract(node({ label: '材料题', subject: 'composite', stem: '公共材料：测试。', body: child }));
  assert.equal(result.question.type, 'compound'); assert.equal(result.question.parts.length, 1);
  assert.match(schema.messages(result.question)[1].content, /公共材料/);
  assert.match(schema.answer(output([{ id: 'question_456', answer: '2', explanation: '相加' }]), result.question).answer, /第 1 小题\n2/);
  assert.throws(() => schema.answer(output([{ id: 'question_999', answer: '2', explanation: '相加' }]), result.question));
  assert.throws(() => schema.answer(output([]), result.question));
});
test('images rejected by API get actionable model-capability message without provider body', async () => {
  await assert.rejects(() => client.query(client.config({ address: 'https://api.example.com', key: 'private', model: 'text-only' }), { ...q(), images: [png] }, { fetchImpl: async () => new Response('private provider body', { status: 400 }) }), { code: 'vision' });
});

test('attachment answers are a validated list of files', () => {
  const question = dom.extract(node({ label: '附件题', subject: 'attach', stem: '编写程序并上传。', body: '' })).question;
  const files = [{ fileName: 'main.py', content: 'from utils import f\nprint(f())' }, { fileName: 'utils.py', content: 'def f():\n    return 1' }];
  const parsed = schema.answer(JSON.stringify({ answer: files, explanation: '两个文件' }), question);
  assert.deepEqual(parsed.files.map(file => file.fileName), ['main.py', 'utils.py']);
  assert.equal(parsed.files[1].content, 'def f():\n    return 1\n', '内容原样保留并以换行结尾');
  assert.equal(parsed.solution.kind, 'files');
  assert.match(parsed.answer, /2 个文件/);
  const bad = list => () => schema.answer(JSON.stringify({ answer: list, explanation: 'x' }), question);
  assert.throws(bad([]), '至少一个文件');
  assert.throws(bad(Array.from({ length: 6 }, (_, i) => ({ fileName: `f${i}.py`, content: 'x' }))), '最多 5 个文件');
  assert.throws(bad([{ fileName: 'a.py', content: 'x' }, { fileName: 'A.py', content: 'y' }]), '文件名不能重复（不区分大小写）');
  assert.throws(bad([{ fileName: 'dir/a.py', content: 'x' }]), '不允许路径');
  assert.throws(bad([{ fileName: 'noext', content: 'x' }]), '必须带扩展名');
  assert.throws(bad([{ fileName: 'a.py', content: '   ' }]), '内容不能为空');
  assert.throws(bad([{ fileName: 'a.py', content: 'x'.repeat(60001) }]), '单个文件大小受限');
});
