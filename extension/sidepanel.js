'use strict';
const model = globalThis.XiaoyaPanelModel;
const store = globalThis.XiaoyaTaskData.createTaskStore();
const { TABS, VIEWS, CHIPS, TYPE_ORDER } = model;
const HOME = `${model.ORIGIN}/app/jx-web/mycourse`;
const PREFS_KEY = 'xiaoyaPanelPrefs';
const RUN_KEY = 'xiaoyaRun';

const $ = id => document.getElementById(id);
const esc = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const line = paths => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const TYPE_ICONS = {
  作业: { h: 217, icon: line('<path d="M3 13l.7-3L10.5 3.2a1.2 1.2 0 0 1 1.7 0l.6.6a1.2 1.2 0 0 1 0 1.7L6 12.3z"/>') },
  练习: { h: 160, icon: line('<path d="M2.5 4.5 4 6l2.3-2.6M2.5 11 4 12.5l2.3-2.6M9 5h4.5M9 11.5h4.5"/>') },
  测验: { h: 350, icon: line('<circle cx="8" cy="9" r="5"/><path d="M8 6.5V9l1.6 1.2M6.5 2h3"/>') },
  视频课件: { h: 262, icon: line('<rect x="2" y="3" width="12" height="10" rx="2.5"/><path d="m6.8 6 3.2 2-3.2 2z"/>') },
  问卷: { h: 192, icon: line('<rect x="3" y="2.5" width="10" height="11" rx="2"/><path d="M5.5 6h5M5.5 8.5h5M5.5 11h3"/>') },
  讨论: { h: 138, icon: line('<path d="M2.5 4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H7l-3 2.3v-2.3a2 2 0 0 1-1.5-2z"/>') },
  其他: { h: 215, icon: line('<circle cx="8" cy="8" r="5.5"/><path d="M5.5 8h.01M8 8h.01M10.5 8h.01"/>') }
};
const CHEVRON = '<svg class="chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5"/></svg>';
const star = on => `<svg viewBox="0 0 16 16" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="m8 1.8 1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/></svg>`;

const state = {
  tab: 'pending', chip: 'all', query: '', day: null, view: 'course',
  collapsed: {}, pins: new Set(), account: null, opened: null,
  tasks: [], failures: [], hasData: false, fetchedAt: null,
  status: 'loading', message: '', refreshing: false
};
const filters = () => ({ tab: state.tab, chip: state.chip, query: state.query, day: state.day });

async function applyResult(result) {
  state.status = result.status;
  state.message = result.message || '';
  if (result.status === 'ok') {
    state.tasks = result.tasks;
    state.failures = result.failures;
    state.fetchedAt = result.fetchedAt;
    state.hasData = true;
    if (result.account !== state.account) {
      state.account = result.account;
      state.pins = new Set(await store.getPins(result.account));
    }
  } else if (result.status === 'login-required') {
    // 退出登录后不再显示上一个账号的任务。
    Object.assign(state, { tasks: [], failures: [], hasData: false, fetchedAt: null, account: null, pins: new Set() });
  }
}

function row(task, showCourse, now) {
  const display = model.rowDisplay(task, now);
  const look = TYPE_ICONS[task.type] || TYPE_ICONS.其他;
  const on = state.pins.has(task.id);
  return `<li class="row${state.opened === task.id ? ' now' : ''}">
    ${globalThis.XiaoyaPanelAnswer?.checkbox(task) || ''}
    ${globalThis.XiaoyaPanelVideo?.checkbox(task) || ''}
    <button class="open" data-act="open" data-id="${esc(task.id)}" data-key="o-${esc(task.id)}" title="${esc(display.tip)}">
      <span class="ticon" style="--h:${look.h}">${look.icon}</span>
      <span class="name">${esc(task.name)}</span>${showCourse ? `<span class="rcourse">${esc(task.courseName)}</span>` : ''}<span class="when ${display.tone}">${esc(display.time)}</span>
    </button>
    <button class="pin" data-act="pin" data-id="${esc(task.id)}" data-key="p-${esc(task.id)}" aria-pressed="${on}" aria-label="${on ? '取消置顶' : '置顶'}：${esc(task.name)}">${star(on)}</button>
  </li>`;
}
const rows = (items, showCourse, now) => `<ul class="rows">${items.map(task => row(task, showCourse, now)).join('')}</ul>`;

function isCollapsed(courseId, index) {
  const key = `${state.tab}:${courseId}`;
  return key in state.collapsed ? state.collapsed[key] : (state.tab === 'done' && index > 0);
}
const unpinned = now => model.visibleTasks(state.tasks, filters(), now).filter(task => !state.pins.has(task.id));
const courseIds = now => [...model.groupBy(unpinned(now), task => task.courseId).keys()];

function courseCard(courseId, items, index, order, progress, now) {
  const first = items[0];
  const { done, total } = progress.get(courseId);
  const next = state.tab === 'pending' && first.end !== null ? `<span class="cnext ${model.heat(first.end, now)}">${esc(model.formatTime(first.end, now))}</span>` : '';
  let body;
  if (state.view === 'courseType') {
    const byType = model.groupBy(items, task => task.type);
    body = TYPE_ORDER.filter(type => byType.has(type)).map(type => `<div class="sub-head">${esc(type)}</div>${rows(byType.get(type), false, now)}`).join('');
  } else {
    body = rows(items, false, now);
  }
  const closed = isCollapsed(courseId, index);
  // 这门课读取失败时只有部分任务，完成数没有意义。
  const incomplete = state.failures.some(item => item.courseId === courseId && item.stage === 'tasks');
  const count = incomplete ? '<span class="cnt">不完整</span>' : `<span class="cnt" title="已完成 ${done} / 共 ${total} 项">${done}/${total}</span>`;
  return `<article class="card${closed ? ' closed' : ''}" style="--i:${order}" data-course="${esc(courseId)}">
    <button class="chead" data-act="toggle" data-key="g-${esc(courseId)}" aria-expanded="${!closed}">
      ${CHEVRON}<strong>${esc(first.courseName)}</strong>${next}${count}
    </button>
    <div class="cbody"><div class="cbody-inner">${body}</div></div>
  </article>`;
}
const plainCard = (title, items, order, now) => `<article class="card" style="--i:${order}"><div class="bhead">${esc(title)}<span>${items.length} 项</span></div>${rows(items, true, now)}</article>`;

function emptyHtml() {
  if (!state.hasData) return state.status === 'loading' || state.refreshing ? '<div class="loading">正在读取任务…</div>' : '';
  const filtered = state.query || state.chip !== 'all' || state.day !== null;
  return `<div class="empty"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="24" cy="24" r="19"/><path d="m16 25 6 6 11-13"/></svg><strong>${filtered ? '这个筛选下没有任务' : '这里没有任务'}</strong>${filtered ? '<button data-act="clear" data-key="clear">清除筛选</button>' : ''}</div>`;
}

function renderList(animate) {
  const now = Date.now();
  const active = document.activeElement?.dataset?.key;
  const all = model.visibleTasks(state.tasks, filters(), now);
  const pinned = all.filter(task => state.pins.has(task.id));
  const rest = all.filter(task => !state.pins.has(task.id));
  const progress = model.courseProgress(state.tasks, now);
  let html = all.length ? '' : emptyHtml();
  let order = 0;
  if (pinned.length) html += plainCard('置顶', pinned, order++, now);
  if (state.view === 'time') {
    model.groupBy(rest, task => model.timeBucket(task, state.tab, now)).forEach((items, name) => { html += plainCard(name, items, order++, now); });
  } else {
    [...model.groupBy(rest, task => task.courseId)].forEach(([id, items], index) => { html += courseCard(id, items, index, order++, progress, now); });
  }
  const list = $('list');
  list.classList.toggle('animate', Boolean(animate));
  list.innerHTML = html;
  if (active) document.querySelector(`[data-key="${CSS.escape(active)}"]`)?.focus();
  updateFold();
  globalThis.XiaoyaPanelAnswer?.render();
  globalThis.XiaoyaPanelVideo?.render();
}

function updateFold() {
  const groups = state.view === 'time' ? [] : courseIds(Date.now());
  $('fold').hidden = !groups.length;
  if (!groups.length) return;
  const anyOpen = groups.some((id, index) => !isCollapsed(id, index));
  const label = anyOpen ? '全部收起' : '全部展开';
  $('fold').title = label;
  $('fold').setAttribute('aria-label', label);
  $('fold').classList.toggle('flip', !anyOpen);
}

function moveThumb(seg, index) { seg.querySelector('.thumb').style.transform = `translateX(${index * 100}%)`; }
function buildSeg(seg, html, count) { seg.innerHTML = `<span class="thumb" style="width:calc((100% - 4px) / ${count})"></span>${html}`; }

function renderCounts() {
  const counts = model.tabCounts(state.tasks, filters(), Date.now());
  TABS.forEach(([key], index) => {
    const button = document.querySelector(`[data-tab="${key}"]`);
    button.querySelector('span').textContent = state.hasData ? counts[key] : '';
    button.setAttribute('aria-selected', state.tab === key);
    if (state.tab === key) moveThumb($('tabs'), index);
  });
  VIEWS.forEach(([key], index) => {
    document.querySelector(`[data-view="${key}"]`).setAttribute('aria-pressed', state.view === key);
    if (state.view === key) moveThumb($('view'), index);
  });
  CHIPS.forEach(({ key }) => document.querySelector(`[data-chip="${key}"]`).setAttribute('aria-pressed', state.chip === key));
}

function countdownText(end) {
  let seconds = Math.max(0, Math.floor((end - Date.now()) / 1000));
  const days = Math.floor(seconds / 86400); seconds -= days * 86400;
  const hours = Math.floor(seconds / 3600); seconds -= hours * 3600;
  const minutes = Math.floor(seconds / 60); seconds -= minutes * 60;
  return `${days ? `${days} 天 ` : ''}${model.pad(hours)}:${model.pad(minutes)}:${model.pad(seconds)}`;
}
function tick() {
  const el = $('countdown');
  const tip = $('briefTip');
  const next = el && model.brief(state.tasks, Date.now()).next;
  const label = next ? `最近截止：${next.name}` : '';
  if (tip.textContent !== label) tip.textContent = label;
  tip.hidden = !next;
  if (next) el.textContent = countdownText(next.end);
}
function renderBrief() {
  const { today, next } = model.brief(state.tasks, Date.now());
  const text = !state.hasData ? '<span>还没有任务数据</span>' : `<span>今天截止 <b>${today}</b> 项${next ? ' · 最近 <b id="countdown"></b>' : ''}</span>`;
  $('brief').innerHTML = text + CHEVRON;
  tick();
}
function renderWeek() {
  $('week').innerHTML = model.weekDays(state.tasks, Date.now()).map(day => {
    const label = day.count ? `，${day.count} 项截止` : '，没有截止';
    return `<button class="day${day.offset === 0 ? ' today' : ''}" data-day="${day.offset}" aria-pressed="${state.day === day.offset}" aria-label="${day.month} 月 ${day.date} 日${label}"><small>${day.label}</small><b>${day.date}</b><span class="dots">${'<i></i>'.repeat(Math.min(day.count, 3))}</span></button>`;
  }).join('');
}
function renderNotice() {
  const notice = model.noticeFor(state.status, state.message, state.failures);
  $('notice').hidden = !notice;
  if (!notice) return;
  $('notice').innerHTML = `<span>${esc(notice.text)}</span><button data-notice="${notice.action}" ${state.refreshing ? 'disabled' : ''}>${state.refreshing && notice.action === 'retry' ? '重试中…' : esc(notice.label)}</button>`;
}
function renderSync() {
  let text = '';
  if (state.refreshing) text = '正在刷新…';
  else if (state.fetchedAt !== null) {
    const minutes = Math.floor((Date.now() - state.fetchedAt) / 60000);
    text = minutes < 1 ? '刚刚更新' : minutes < 60 ? `${minutes} 分钟前更新` : `${Math.floor(minutes / 60)} 小时前更新`;
  }
  $('sync').textContent = text;
  $('refresh').classList.toggle('spin', state.refreshing);
}
function renderAll(animate) { renderCounts(); renderBrief(); renderWeek(); renderNotice(); renderList(animate); renderSync(); }

async function update(force) {
  if (state.refreshing) return;
  state.refreshing = true;
  renderSync(); renderNotice();
  if (!state.hasData) renderList(false);
  try {
    await applyResult(await store.load({ force }));
  } catch {
    state.status = 'error';
    state.message = '';
  } finally {
    state.refreshing = false;
    renderAll(false);
  }
}

async function openTask(task) {
  state.opened = task.id;
  renderList(false);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const run = (await chrome.storage.session.get(RUN_KEY))[RUN_KEY];
  if (!globalThis.XiaoyaPanelAnswer?.busy() && !globalThis.XiaoyaPanelVideo?.busy() && model.openTarget(tab, run) === 'same') await chrome.tabs.update(tab.id, { url: task.url });
  else await chrome.tabs.create({ url: task.url });
}

function setSearch(on) {
  $('searchBox').hidden = !on;
  $('searchBtn').setAttribute('aria-expanded', on);
  if (on) $('search').focus();
  else if (state.query) { state.query = ''; $('search').value = ''; renderCounts(); renderList(false); }
}
function clearDay() {
  if (state.day === null) return false;
  state.day = null;
  renderWeek();
  return true;
}
function closeSheet() { $('sheet').classList.remove('on'); $('gear').focus(); }

buildSeg($('tabs'), TABS.map(([key, label]) => `<button role="tab" data-tab="${key}">${label}<span></span></button>`).join(''), TABS.length);
buildSeg($('view'), VIEWS.map(([key, label, tip]) => `<button data-view="${key}" title="${tip}">${label}</button>`).join(''), VIEWS.length);
$('chips').innerHTML = CHIPS.map(({ key, label }) => `<button class="chip" data-chip="${key}">${label}</button>`).join('');

$('tabs').addEventListener('click', event => {
  const button = event.target.closest('[data-tab]');
  if (!button) return;
  state.tab = button.dataset.tab;
  clearDay();
  renderCounts(); renderList(true);
  $('scroller').scrollTop = 0;
});
$('view').addEventListener('click', event => {
  const button = event.target.closest('[data-view]');
  if (!button) return;
  state.view = button.dataset.view;
  chrome.storage.local.set({ [PREFS_KEY]: { view: state.view } });
  renderCounts(); renderList(true);
});
$('chips').addEventListener('click', event => {
  const button = event.target.closest('[data-chip]');
  if (!button) return;
  state.chip = button.dataset.chip;
  renderCounts(); renderList(true);
});
$('week').addEventListener('click', event => {
  const button = event.target.closest('[data-day]');
  if (!button) return;
  const day = Number(button.dataset.day);
  state.day = state.day === day ? null : day;
  state.tab = 'pending';
  renderWeek(); renderCounts(); renderList(true);
});
$('briefWrap').addEventListener('pointerenter', () => $('briefWrap').classList.remove('tip-dismissed'));
$('brief').addEventListener('focus', () => $('briefWrap').classList.remove('tip-dismissed'));
$('brief').addEventListener('click', () => {
  $('briefWrap').classList.add('tip-dismissed');
  const on = !$('weekwrap').classList.contains('on');
  $('weekwrap').classList.toggle('on', on);
  $('brief').setAttribute('aria-expanded', on);
  if (!on && clearDay()) { renderCounts(); renderList(true); }
});
$('fold').addEventListener('click', () => {
  const now = Date.now();
  const groups = courseIds(now);
  const close = groups.some((id, index) => !isCollapsed(id, index));
  groups.forEach(id => { state.collapsed[`${state.tab}:${id}`] = close; });
  document.querySelectorAll('#list .card[data-course]').forEach(card => {
    card.classList.toggle('closed', close);
    card.querySelector('.chead').setAttribute('aria-expanded', !close);
  });
  updateFold();
});
$('searchBtn').addEventListener('click', () => setSearch($('searchBox').hidden));
$('search').addEventListener('keydown', event => { if (event.key === 'Escape') { setSearch(false); $('searchBtn').focus(); } });
$('search').addEventListener('input', event => { state.query = event.target.value; renderCounts(); renderList(false); });
$('refresh').addEventListener('click', () => update(true));
$('gear').addEventListener('click', () => { $('sheet').classList.add('on'); $('closeSheet').focus(); });
$('closeSheet').addEventListener('click', closeSheet);
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if ($('sheet').classList.contains('on')) closeSheet();
  else $('briefWrap').classList.add('tip-dismissed');
});
$('notice').addEventListener('click', event => {
  const action = event.target.dataset.notice;
  if (action === 'retry') update(true);
  else if (action === 'open') chrome.tabs.create({ url: HOME });
});
$('list').addEventListener('click', event => {
  const button = event.target.closest('[data-act]');
  if (!button) return;
  const { act, id } = button.dataset;
  if (act === 'toggle') {
    const card = button.closest('.card');
    const close = !card.classList.contains('closed');
    state.collapsed[`${state.tab}:${card.dataset.course}`] = close;
    card.classList.toggle('closed', close);
    button.setAttribute('aria-expanded', !close);
    updateFold();
  } else if (act === 'pin') {
    if (state.pins.has(id)) state.pins.delete(id); else state.pins.add(id);
    if (state.account !== null) store.setPins(state.account, [...state.pins]);
    renderList(false);
  } else if (act === 'open') {
    const task = state.tasks.find(item => item.id === id);
    if (task) openTask(task);
  } else if (act === 'clear') {
    state.query = ''; state.chip = 'all'; state.day = null; $('search').value = '';
    renderWeek(); renderCounts(); renderList(true);
  }
});
// 打开或登录小雅后自动读取，不用再手动刷新。
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' && tab.url?.startsWith(`${model.ORIGIN}/`) && (state.status === 'site-closed' || state.status === 'login-required')) update(false);
});

async function boot() {
  const prefs = (await chrome.storage.local.get(PREFS_KEY))[PREFS_KEY];
  if (VIEWS.some(([key]) => key === prefs?.view)) state.view = prefs.view;
  renderAll(false);
  const cached = await store.peek().catch(() => null);
  if (cached) { await applyResult(cached); renderAll(false); }
  await update(false);
}
boot();
setInterval(tick, 1000);
setInterval(() => renderAll(false), 60000);
