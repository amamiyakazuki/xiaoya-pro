'use strict';
(function () {
  const batchModel = globalThis.XiaoyaAnswerBatch;
  let selected = new Set(), selectionAccount = state.account, batch = null, starting = false, confirmed = null, lastEnded = null, openingDraft = null;
  const chosen = () => state.tasks.filter(task => selected.has(task.id) && batchModel.eligible(task));
  const visible = () => model.visibleTasks(state.tasks, filters(), Date.now()).filter(batchModel.eligible);
  const locked = () => starting || Boolean(batch?.enabled || batch?.inFlight);
  const openingCurrentDraft = () => Boolean(openingDraft && openingDraft.batchId === batch?.id);
  const draftLocked = () => starting || Boolean(batch?.enabled) || openingCurrentDraft();
  async function send(type, extra = {}) {
    const reply = await chrome.runtime.sendMessage({ type: `auto:${type}`, ...extra });
    if (!reply?.ok) throw Error(reply?.error || '后台未响应，请重新加载扩展。');
    return reply;
  }
  function syncSelection() {
    selected = new Set(batchModel.selection(state.tasks, [...selected], state.account, selectionAccount));
    if (state.account !== selectionAccount && confirmed) { $('answerConfirm').close(); confirmed = null; }
    selectionAccount = state.account;
  }
  function render() {
    syncSelection();
    const count = chosen().length, visibleIds = new Set(visible().map(task => task.id));
    const hidden = [...selected].filter(id => !visibleIds.has(id)).length;
    $('answerSelected').textContent = `已选 ${count} 份${hidden ? `（筛选外 ${hidden} 份）` : ''}`;
    $('answerAll').disabled = locked() || !visibleIds.size;
    $('answerClear').disabled = locked() || !count;
    $('answerReview').disabled = locked() || !count || !state.account;
    $('answerStop').hidden = !starting && !batch?.enabled;
    $('answerVerify').hidden = !batch?.inFlight || Boolean(batch?.enabled);
    const same = batch && batch.account === state.account;
    const keepToolbar = count > 0 || starting || Boolean(batch?.enabled || batch?.inFlight) || openingCurrentDraft();
    $('answerToolbar').hidden = state.chip === 'media' && !keepToolbar;
    $('answerProgress').hidden = !same;
    if (same) {
      $('answerStage').textContent = batch.stage === 'finished' ? '本批答题处理结束，可以开始下一批。' : batch.message;
      $('answerResults').innerHTML = batch.tasks.map((task, index) => {
        const result = batch.results[index];
        const label = ({ waiting: '等待', done: '已提交', draft: '待补附件', pending: '待处理', uncertain: '待核对' })[result.status] || '等待';
        const draftButton = result.status === 'draft' && result.draftPage
          ? `<button type="button" data-draft-index="${index}" ${draftLocked() ? 'disabled' : ''}>${openingCurrentDraft() && openingDraft.index === index ? '正在定位原页面…' : '返回原答题页（可选）'}</button>`
          : result.status === 'draft' ? '<span>原页面无法定位，可稍后从小雅课程手动打开。</span>' : '';
        return `<li><strong>${esc(task.courseName)} · ${esc(task.name)}</strong><span>${label}：${esc(result.message)}</span>${draftButton}</li>`;
      }).join('');
    }
    document.querySelectorAll('[data-answer-id]').forEach(input => { input.checked = selected.has(input.dataset.answerId); input.disabled = locked(); });
  }
  globalThis.XiaoyaPanelAnswer = {
    checkbox(task) { syncSelection(); return batchModel.eligible(task) ? `<input class="answer-check" type="checkbox" data-answer-id="${esc(task.id)}" data-key="a-${esc(task.id)}" aria-label="选择整份任务：${esc(task.name)}" ${selected.has(task.id) ? 'checked' : ''} ${locked() ? 'disabled' : ''}>` : ''; },
    render,
    busy: locked
  };
  $('list').addEventListener('change', event => {
    const id = event.target.dataset.answerId; if (!id || locked()) return;
    if (event.target.checked) selected.add(id); else selected.delete(id);
    render();
  });
  $('answerAll').addEventListener('click', () => { if (!locked()) visible().forEach(task => selected.add(task.id)); renderList(false); });
  $('answerClear').addEventListener('click', () => { if (!locked()) selected.clear(); renderList(false); });
  $('answerReview').addEventListener('click', () => {
    syncSelection(); if (locked() || !chosen().length) return;
    confirmed = { account: state.account, ids: chosen().map(task => task.id) };
    $('answerConfirmList').innerHTML = chosen().map(task => `<li><strong>${esc(task.name)}</strong><span>${esc(task.courseName)} · ${esc(task.type)}</span></li>`).join('');
    $('answerConfirmTitle').textContent = `确认自动作答并提交 ${confirmed.ids.length} 份任务`;
    $('answerConfirm').showModal();
  });
  $('answerBack').addEventListener('click', () => { $('answerConfirm').close(); confirmed = null; });
  $('answerGo').addEventListener('click', async () => {
    if (!confirmed || locked()) return;
    const input = confirmed; confirmed = null; $('answerConfirm').close(); starting = true;
    $('answerMessage').textContent = '正在重新核对账号和所选任务…'; render();
    try {
      const result = await send('start', input); batch = result.batch; selected.clear(); $('answerMessage').textContent = '';
    } catch (error) { $('answerMessage').textContent = error.message; }
    finally { starting = false; renderList(false); }
  });
  $('answerStop').addEventListener('click', async () => {
    try { await send('stop'); $('answerMessage').textContent = '已发送停止指令。'; await read(); }
    catch (error) { $('answerMessage').textContent = error.message; }
  });
  $('answerVerify').addEventListener('click', async () => {
    $('answerVerify').disabled = true; $('answerVerify').textContent = '正在核对平台状态…';
    try { const result = await send('verify'); $('answerMessage').textContent = result.confirmed ? '平台已确认提交成功。' : '平台最新状态尚未确认完成。请稍后再次核对；不会重新提交。'; await read(); }
    catch (error) { $('answerMessage').textContent = error.message; }
    finally { $('answerVerify').disabled = false; $('answerVerify').textContent = '核对提交结果'; }
  });
  $('answerResults').addEventListener('click', async event => {
    const button = event.target.closest('[data-draft-index]');
    if (!button || draftLocked() || !batch) return;
    const index = Number(button.dataset.draftIndex);
    const task = batch.tasks[index], result = batch.results[index], batchId = batch.id;
    if (!task || result?.status !== 'draft' || !result.draftPage) return;
    const request = { batchId, index };
    openingDraft = request;
    const showStatus = message => { if (batch?.id === batchId && !starting) $('answerMessage').textContent = message; };
    showStatus('正在定位原答题页…');
    render();
    try {
      await send('open-draft', { batchId, taskId: task.id });
      showStatus('已返回原答题页。');
    } catch (error) {
      showStatus(error.message);
    } finally {
      if (openingDraft === request) openingDraft = null;
      render();
    }
  });
  async function read() { try { batch = (await send('get')).batch; render(); } catch (error) { $('answerMessage').textContent = error.message; } }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[batchModel.KEY]) return;
    batch = changes[batchModel.KEY].newValue || null; render();
    if (batch && !batch.enabled && lastEnded !== batch.id && batch.results.some(result => result.status === 'done')) { lastEnded = batch.id; update(true); }
  });
  renderList(false); read();
})();
