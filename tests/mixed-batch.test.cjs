const { test } = require('node:test');
const assert = require('node:assert/strict');
const B = require('../extension/answer-batch.js');
const task = n => ({ id: `t${n}`, courseId: '11', nodeId: String(n), typeCode: 2, name: `任务${n}`, finished: false });
const pause = () => new Promise(resolve => setImmediate(resolve));
async function settled(engine) { for (let i = 0; i < 100 && engine.busy(); i++) await pause(); assert.equal(engine.busy(), false); return engine.get(); }
const supported = (n, state = 'empty') => ({ question: { id: `question_${n}`, type: 'short', stem: `支持${n}`, options: [] }, number: n, typeName: '简答题', state, writable: state !== 'done', fingerprint: `f${n}` });
const unsupported = n => ({ question: { id: `question_${n}` }, number: n, typeName: '未识别', state: 'unknown', writable: false, fingerprint: `f${n}`, skipReason: '暂不支持此控件', reason: '暂不支持此控件' });
const attachment = n => ({ question: { id: `question_${n}`, type: 'attachment' }, number: n, typeName: '附件题', state: 'unknown', writable: false, fingerprint: `f${n}`, reason: '需要上传文件' });
function setup(first, options = {}) {
  const calls = [], data = {}, originals = structuredClone(first); let active, inspected = 0;
  const questions = new Map();
  const current = () => ({ complete: true, partialSafe: true, fingerprint: active === 't1' ? 'first' : 'second', questions: structuredClone(questions.get(active)) });
  const driver = {
    async open(t) { active = t.id; calls.push(['open', t.id]); questions.set(active, structuredClone(active === 't1' ? originals : [supported(21)])); const snap = current(); options.onOpen?.(snap); return snap; },
    async inspect() { inspected++; const snap = current(); options.onInspect?.(snap, inspected); return snap; },
    async fill(t, answer) { calls.push(['fill', t.id, answer.id, answer.paperFingerprint]); const item = questions.get(t.id).find(q => q.question.id === answer.id); assert.ok(item && item.writable); item.state = 'done'; return { filled: true }; },
    async submit(t) { calls.push(['submit', t.id]); },
    async verify() { calls.push(['verify']); return true; },
    draftReference: () => ({ tabId: 12, pageToken: 'test-page' })
  };
  const engine = B.createEngine({ storage: { async get() { return {}; }, async set(values) { Object.assign(data, structuredClone(values)); } }, driver, getAccount: async () => 'account', uuid: () => 'batch',
    query: async q => { calls.push(['query', q.id]); if (options.queryFails) throw Error('模拟AI故障'); return { solution: { kind: 'text', text: '答案' } }; }
  });
  return { engine, calls, data, questions, start: tasks => engine.start({ account: 'account', tasks }) };
}
test('mixed unsupported, attachment, manual and supported questions retain a draft, then the next task submits', async () => {
  const f = setup([supported(11), unsupported(12), supported(13), supported(14, 'done'), attachment(15)]);
  await f.start([task(1), task(2)]); const state = await settled(f.engine);
  assert.deepEqual(state.results.map(r => r.status), ['draft', 'done']);
  assert.equal(state.results[0].needsReview, true);
  assert.deepEqual(state.results[0].draftPage, { tabId: 12, pageToken: 'test-page' });
  assert.match(state.results[0].message, /第 12 题.*暂不支持此控件/s);
  assert.match(state.results[0].message, /第 15 题/);
  assert.match(state.results[0].message, /未提交/);
  assert.deepEqual(f.calls.filter(x => x[0] === 'query').map(x => x[1]), ['question_11', 'question_13', 'question_21']);
  assert.deepEqual(f.calls.filter(x => x[0] === 'fill').map(x => x[2]), ['question_11', 'question_13', 'question_21']);
  assert.deepEqual(f.calls.filter(x => x[0] === 'fill').map(x => x[3]), ['first', 'first', undefined]);
  assert.deepEqual(f.calls.filter(x => x[0] === 'submit').map(x => x[1]), ['t2']);
  assert.equal(f.questions.get('t1')[3].state, 'done');
});
test('all unsupported questions are listed as a draft without AI, writes or submission', async () => {
  const f = setup([unsupported(11), unsupported(12)]); await f.start([task(1)]); const state = await settled(f.engine);
  assert.equal(state.results[0].status, 'draft');
  assert.match(state.results[0].message, /第 11 题/); assert.match(state.results[0].message, /第 12 题/);
  assert.deepEqual(state.results[0].draftPage, { tabId: 12, pageToken: 'test-page' });
  assert.ok(!f.calls.some(x => ['query', 'fill', 'submit', 'verify'].includes(x[0])));
});
test('changed skipped classification before writing blocks all writes and submission', async () => {
  for (const change of [s => delete s.questions[1].skipReason, s => { s.questions[1].skipReason = '新的不可支持原因'; }, s => { s.questions[1].question.id = 'question_99'; }]) {
    const f = setup([supported(11), unsupported(12)], { onInspect(s, n) { if (n === 1) change(s); } });
    await f.start([task(1)]); const state = await settled(f.engine);
    assert.equal(state.results[0].status, 'pending'); assert.ok(!f.calls.some(x => ['fill', 'submit'].includes(x[0])));
  }
});
test('changed skipped classification after a write pauses without submitting or advancing', async () => {
  const f = setup([supported(11), unsupported(12)], { onInspect(s, n) { if (n === 2) delete s.questions[1].skipReason; } });
  await f.start([task(1), task(2)]); const state = await settled(f.engine);
  assert.equal(state.stage, 'paused'); assert.equal(state.results[0].status, 'pending'); assert.equal(state.results[1].status, 'waiting');
  assert.ok(!f.calls.some(x => x[0] === 'submit' || x[1] === 't2'));
});
test('partial safety is required before any query, before writes and after writes', async () => {
  for (const when of ['open', 'before', 'after']) {
    const f = setup([supported(11), unsupported(12)], {
      onOpen(s) { if (when === 'open') s.partialSafe = false; },
      onInspect(s, n) { if (when === 'before' && n === 1 || when === 'after' && n === 2) s.partialSafe = false; }
    });
    await f.start([task(1), task(2)]); const state = await settled(f.engine);
    assert.equal(state.results[0].status, 'pending');
    assert.ok(!f.calls.some(x => x[0] === 'submit' && x[1] === 't1'));
    if (when === 'open') assert.ok(!f.calls.some(x => x[0] === 'query' && x[1] === 'question_11'));
    if (when !== 'after') assert.ok(!f.calls.some(x => x[0] === 'fill' && x[1] === 't1'));
    if (when === 'after') { assert.equal(state.stage, 'paused'); assert.equal(state.results[1].status, 'waiting'); }
  }
});
test('unknown failure without explicit skippable classification and malformed skippable identity remain blocked', async () => {
  for (const item of [{...unsupported(12), skipReason: undefined}, {...unsupported(12), question: {}}, {...unsupported(12), fingerprint: ''}]) {
    const f = setup([supported(11), item]); await f.start([task(1)]); const state = await settled(f.engine);
    assert.equal(state.results[0].status, 'pending'); assert.ok(!f.calls.some(x => ['query', 'fill', 'submit'].includes(x[0])));
  }
});
test('AI failure on a supported question still blocks all writes even with a skipped question', async () => {
  const f = setup([supported(11), unsupported(12)], { queryFails: true }); await f.start([task(1)]); const state = await settled(f.engine);
  assert.equal(state.results[0].status, 'pending'); assert.match(state.results[0].message, /模拟AI故障/); assert.ok(!f.calls.some(x => ['fill', 'submit'].includes(x[0])));
});
