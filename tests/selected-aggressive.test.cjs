const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function fixture({ aggressive = true, done = false, buttonVisible = true, buttonDisabled = false, dialogVisible = false, timingAfterClick = false } = {}) {
  let now = 100000;
  let interval;
  let listener;
  let finished = done;
  let dialogOnPage = dialogVisible;
  const sent = [];
  const events = [];
  let clicks = 0;
  let plays = 0;
  let completePresent = true;
  let completeVisible = buttonVisible;
  let disabled = buttonDisabled;
  let timingText = null;
  let timingAcknowledgements = 0;

  const selection = [{ id: '42:11', courseId: '42', nodeId: '11', name: 'lesson.mp4' }];
  const run = { id: 'run-1', enabled: true, mode: 'selected', selection, selectionIndex: 0,
    options: { rate: 2, muted: false, background: false, autoNext: true, aggressive }, completed: [], logs: [] };
  const video = { ended: false, paused: true, duration: 100, currentTime: 0,
    play() { plays += 1; this.paused = false; return Promise.resolve(); }, pause() {} };
  const control = {
    textContent: '点我完成任务', disabled: false,
    classList: { contains(name) { return name === 'disabled' && disabled; } },
    getAttribute(name) { return name === 'aria-disabled' && disabled ? 'true' : null; },
    getClientRects() { return completeVisible && !disabled ? [{}] : []; },
    click() { clicks += 1; if (timingAfterClick) { timingText = '至少观看 2 分钟'; dialogOnPage = true; } }
  };
  const dialog = { hidden: false, getAttribute() { return null; }, getClientRects() { return dialogOnPage ? [{}] : []; } };
  const timingHint = { textContent: '至少观看 2 分钟', closest() { return { querySelectorAll() {
    return [{ textContent: '知道了', click() { timingAcknowledgements += 1; timingText = null; } }];
  } }; } };
  const location = { origin: 'https://whut.ai-augmented.com', pathname: '/app/jx-web/mycourse/42/resource/r11/11',
    get href() { return this.origin + this.pathname; }, assign() {} };
  const document = {
    title: 'lesson.mp4 | 理工智课', body: { innerText: '' },
    querySelector(selector) {
      if (selector === 'h5.title') return { textContent: 'lesson.mp4', getAttribute() { return 'lesson.mp4'; } };
      if (selector === '.group-resource-node.node-selected .node-inner') return null;
      if (selector === '.ta_icon_btn .xy_btn_task_finish') return finished ? {} : null;
      if (selector === '.ant-modal .finish_task_info' && timingText) return timingHint;
      if (selector === 'video') return video;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '.ta_icon_btn') return completePresent ? [control] : [];
      if (selector === 'video') return [video];
      if (selector === '.ant-modal, dialog[open], [role="dialog"][aria-modal="true"]') return dialogOnPage ? [dialog] : [];
      return [];
    }
  };

  class FakeDate extends Date { static now() { return now; } }
  const context = vm.createContext({ URL, Date: FakeDate, structuredClone,
    CustomEvent: class { constructor(type, data) { this.type = type; this.detail = data.detail; } },
    window: { dispatchEvent(event) { events.push(event); } }, document, location,
    setInterval(callback, delay) { if (delay === 1000) interval = callback; },
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } }, async sendMessage(message) {
      sent.push(structuredClone(message));
      if (message.type === 'get') return { run };
      if (message.type === 'selected-advance') return { ok: true, accepted: true };
      if (message.type === 'save') return { ok: true, accepted: true };
      return { ok: true };
    } } }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'extension/task-timing.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'extension/content.js'), 'utf8'), context);

  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  return {
    sent, events, video,
    get clicks() { return clicks; }, get plays() { return plays; }, get timingAcknowledgements() { return timingAcknowledgements; },
    setDone(value) { finished = value; },
    setButton({ present = completePresent, visible = completeVisible, isDisabled = disabled } = {}) {
      completePresent = present; completeVisible = visible; disabled = isDisabled;
    },
    setDialog(value) { dialogOnPage = value; },
    async settle() { await flush(); },
    async tick(ms = 1000) { now += ms; interval(); await flush(); },
    halt() { listener({ type: 'selected-halt' }, {}, () => {}); }
  };
}

test('aggressive selected mode clicks the visible platform control once and advances only after the real done marker', async () => {
  const f = fixture();
  await f.settle();
  assert.deepEqual(f.sent[0], { type: 'get', selectedProtocol: 1 });

  await f.tick(5000);
  assert.equal(f.clicks, 1);
  assert.equal(f.plays, 0);
  assert.equal(f.video.playbackRate, undefined);
  assert.equal(f.sent.filter(message => message.type === 'selected-advance').length, 0);

  await f.tick(2000);
  assert.equal(f.clicks, 1, 'a page run never retries an unacknowledged direct attempt');
  assert.equal(f.sent.filter(message => message.type === 'selected-advance').length, 0);

  f.setDone(true);
  await f.tick(); await f.tick();
  assert.deepEqual(f.sent.filter(message => message.type === 'selected-advance'), [
    { type: 'selected-advance', runId: 'run-1', index: 0 }
  ]);
});

test('a missing, hidden, disabled, or dialog-covered control waits without clicking', async () => {
  const f = fixture({ buttonVisible: false, buttonDisabled: true, dialogVisible: true });
  await f.settle(); await f.tick(5000);
  assert.equal(f.clicks, 0);

  f.setButton({ present: false });
  await f.tick();
  assert.equal(f.clicks, 0, 'a missing control keeps waiting');

  f.setButton({ present: true, visible: false, isDisabled: false });
  await f.tick();
  assert.equal(f.clicks, 0, 'a hidden control is not activated');

  f.setButton({ visible: true, isDisabled: true });
  await f.tick();
  assert.equal(f.clicks, 0);

  f.setButton({ visible: true, isDisabled: false });
  await f.tick();
  assert.equal(f.clicks, 0, 'an active visible dialog blocks the platform control');

  f.setDialog(false);
  await f.tick();
  assert.equal(f.clicks, 1);
  assert.equal(f.plays, 0);
});

test('no acknowledgement pauses neutrally without retrying or advancing', async () => {
  const f = fixture();
  await f.settle(); await f.tick(5000);
  assert.equal(f.clicks, 1);

  await f.tick(14999);
  assert.equal(f.clicks, 1);
  assert.equal(f.sent.filter(message => message.type === 'selected-advance').length, 0);
  await f.tick(1);

  const stopped = f.sent.filter(message => message.type === 'save').at(-1)?.run;
  assert.equal(stopped.enabled, false);
  assert.equal(stopped.status, '平台尚未确认完成，队列已暂停，请核对当前页面。');
  assert.doesNotMatch(stopped.status, /拒绝|时长|时间/);
  assert.equal(f.clicks, 1);
  assert.equal(f.sent.filter(message => message.type === 'selected-advance').length, 0);
});

test('a platform timing prompt stays visible and is not dismissed or retried in aggressive mode', async () => {
  const f = fixture({ timingAfterClick: true });
  await f.settle(); await f.tick(5000);
  assert.equal(f.clicks, 1);

  await f.tick(1000); await f.tick(14000);
  assert.equal(f.clicks, 1);
  assert.equal(f.timingAcknowledgements, 0);
  assert.equal(f.sent.filter(message => message.type === 'selected-advance').length, 0);
  const stopped = f.sent.filter(message => message.type === 'save').at(-1)?.run;
  assert.match(stopped.status, /平台尚未确认完成/);
});

test('normal selected mode keeps the existing playback-and-wait behavior', async () => {
  const f = fixture({ aggressive: false });
  await f.settle(); await f.tick(5000);
  assert.equal(f.clicks, 0);
  assert.equal(f.plays, 1);
  assert.equal(f.video.playbackRate, 2);
  assert.equal(f.sent.filter(message => message.type === 'selected-advance').length, 0);
});

test('an already visible done marker advances without a direct click', async () => {
  const f = fixture({ done: true });
  await f.settle(); await f.tick(5000);
  assert.equal(f.clicks, 0);
  assert.deepEqual(f.sent.filter(message => message.type === 'selected-advance'), [
    { type: 'selected-advance', runId: 'run-1', index: 0 }
  ]);
});

test('stop while waiting for acknowledgement prevents selected advancement', async () => {
  const f = fixture();
  await f.settle(); await f.tick(5000);
  assert.equal(f.clicks, 1);
  f.halt(); await f.settle();
  f.setDone(true);
  await f.tick();
  assert.equal(f.sent.filter(message => message.type === 'selected-advance').length, 0);
});
