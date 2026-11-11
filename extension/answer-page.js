(function (root) {
  'use strict';
  function createAdapter({ document, location, permit, uuid = () => crypto.randomUUID(), delay = ms => new Promise(r => setTimeout(r, ms)) }) {
    const batch = root.XiaoyaAnswerBatch, dom = root.XiaoyaAnswerDOM;
    const pageToken = uuid(); let halted = false, batchId = null, submittedHere = false, submittedFingerprint = null;
    let entryAttempted = false, entryFallbackUsed = false;
    let receiptTaskId = null, receiptArmed = false;
    const visible = element => Boolean(element && !element.hidden && !element.closest('[hidden]') && (typeof element.getClientRects !== 'function' || element.getClientRects().length));
    const compactText = element => (element.textContent || '').replace(/\s+/g, '');
    const nativeButtons = () => [...document.querySelectorAll('#survey_page button')].filter(visible);
    const subjectFor = node => [...node.querySelectorAll('[id^="question_"]')].find(e => /^question_\d+$/.test(e.id) && e.closest('.question') === node);
    const nodes = () => [...document.querySelectorAll('#question_content .question')].filter(node => !node.parentElement?.closest('.question'));
    const isSuccessDialog = element => /^(成功)?提交成功确定$/.test(compactText(element));
    function successDialogs() {
      const dialogs = [...document.querySelectorAll('.ant-modal,.ant-modal-confirm,[role="dialog"]')].filter(visible);
      const matches = dialogs.filter(isSuccessDialog);
      return matches.filter(e => !matches.some(other => other !== e && e.contains(other)));
    }
    const activeDialogs = () => {
      const all = [...document.querySelectorAll('.ant-modal,.ant-modal-confirm,[role="dialog"]')].filter(visible);
      return all.filter(e => !all.some(other => other !== e && e.contains(other)));
    };
    const loading = element => Boolean(element && (element.matches('[aria-busy="true"],.ant-spin-spinning,.ant-btn-loading') || [...element.querySelectorAll('[aria-busy="true"],.ant-spin-spinning,.ant-btn-loading')].some(visible)));
    function answerCard(state, required = false) {
      const lists = [...document.querySelectorAll('#survey_page .answer_info_card .sheet_list')];
      if (!lists.length) return required ? '无法读取平台答题卡，不能确认作答状态。' : '';
      if (lists.length !== 1) return '平台答题卡结构不唯一，请人工核对。';
      const entries = [...lists[0].children];
      const ids = entries.map(e => e.querySelector('a')?.id);
      if (entries.length !== state.total || new Set(ids).size !== state.total ||
          state.questions.some(q => !ids.includes('#' + q.question?.id.replace(/^question_/, '')))) return '平台答题卡尚未完整同步。';
      const unfinished = entries.filter(e => e.title !== '已答题' || !e.classList.contains('finish'));
      return unfinished.length ? `平台答题卡尚未确认已答：第 ${unfinished.map(e => e.querySelector('a')?.textContent.trim()).join('、')} 题。` : '';
    }
    function answerValues() {
      // Used only within this page operation; never sent to the worker or stored.
      return JSON.stringify(nodes().map(node => controls(node, dom.extract(node).question).map(e => ['radio', 'checkbox'].includes(e.type) ? e.checked : e.value)));
    }
    async function stablePaper(message) {
      let previous = null, reason = '';
      for (let attempt = 0; attempt < 12; attempt++) {
        await authorize(message, 'submit');
        const state = inspect(message.task);
        if (!state.complete || state.fingerprint !== message.fingerprint || state.questions.some(q => q.state !== 'done')) return '提交前题目或答案已变化，请核对整卷。';
        reason = answerCard(state, true) || (loading(document.querySelector('#survey_page')) ? '平台仍在同步作答状态。' : '');
        const values = answerValues();
        if (!reason && previous === values) return '';
        previous = reason ? null : values;
        if (attempt < 11) await delay(250);
      }
      return reason || '答案状态未稳定，请人工核对。';
    }
    function confirmationState() {
      const dialogs = activeDialogs();
      if (!dialogs.length) return { kind: 'none' };
      if (dialogs.length !== 1) return { kind: 'blocked', reason: '存在多个弹窗，无法确定交卷确认窗口。' };
      const modal = dialogs[0], text = compactText(modal);
      if (isSuccessDialog(modal)) return { kind: 'none' };
      if (loading(modal)) return { kind: 'loading', modal, reason: '提交检查窗口仍在加载。' };
      const lists = [...modal.querySelectorAll('.NoAnswerModal_container .no_answer_sheet_list')];
      const special = modal.matches('.NoAnswerModal') && lists.length === 1 &&
        compactText(modal.querySelector('.ant-modal-title') || modal) === '提交' &&
        compactText(modal.querySelector('.sub_caption') || modal) === '未完成的题目：';
      if (special) {
        const list = lists[0];
        if (list.children.length || compactText(list)) {
          const numbers = [...list.querySelectorAll('a')].map(e => compactText(e)).filter(v => /^\d+$/.test(v));
          return { kind: 'blocked', reason: numbers.length ? `平台提示未完成：第 ${[...new Set(numbers)].join('、')} 题，请核对答案。` : '平台提示有未完成题目，但无法可靠读取题号，请查看弹窗。' };
        }
        // Match the observed empty-list dialog, not any text containing “提交”.
        const tip = modal.querySelector('.tip');
        if (!tip || text !== '提交未完成的题目：*可在屏幕右侧答题卡内查看各试题的作答状态提交取消') return { kind: 'blocked', reason: '提交检查窗口结构已变化，请人工核对。' };
      } else if (!/提交|交卷/.test(text) || /成功|失败|未答|漏答|未完成|空题|未作答/.test(text)) {
        return { kind: 'blocked', reason: /未答|漏答|未完成|空题|未作答/.test(text) ? '平台提示存在未完成题目，请核对弹窗与答题卡。' : '遇到无法识别的提交弹窗，请人工处理。' };
      }
      const buttons = [...modal.querySelectorAll('button')].filter(e => visible(e) && !e.disabled && /^(确定|确认|提交|确定提交|确认提交|交卷)$/.test(compactText(e)));
      if (buttons.length !== 1) return { kind: 'blocked', reason: '提交确认按钮不可用或不唯一，请人工处理。' };
      return { kind: 'ready', modal, button: buttons[0], special };
    }
    function entryFallback() {
      if (!entryAttempted || entryFallbackUsed || !location.pathname.includes('/resource/')) return null;
      const dialogs = [...document.querySelectorAll('.ant-modal,.ant-modal-confirm,[role="dialog"]')].filter(visible);
      const buttons = new Set();
      for (const dialog of dialogs) {
        const text = dialog.textContent.replace(/\s+/g, '');
        if (!text.includes('窗口被浏览器拦截') || !text.includes('无法正常打开新的页面') || !text.includes('当前页直接跳转')) continue;
        for (const button of dialog.querySelectorAll('button')) {
          if (visible(button) && !button.disabled && button.textContent.replace(/\s+/g, '') === '在当前页面跳转') buttons.add(button);
        }
      }
      return buttons.size === 1 ? [...buttons][0] : null;
    }
    function controls(node, question) {
      const subject = subjectFor(node); if (!subject) return [];
      if (['single', 'multiple'].includes(question?.type)) return [...subject.querySelectorAll(question.type === 'single' ? 'label.ant-radio-wrapper input[type=radio]' : 'label.ant-checkbox-wrapper input[type=checkbox]')];
      if (question?.type === 'fill') return [...subject.querySelectorAll('textarea,input[type=text]')];
      if (['short', 'essay', 'calculation'].includes(question?.type)) return [...subject.querySelectorAll('textarea,input[type=text]')];
      return [];
    }
    function inspectQuestion(node, index = nodes().indexOf(node)) {
      const parsed = dom.extract(node), question = parsed.question;
      const fields = controls(node, question);
      const subject = subjectFor(node);
      const sequence = [...node.querySelectorAll('.exam_question_stem .sequence')].find(e => e.closest('.question') === node)?.textContent.trim();
      const declaredNumber = Number(sequence?.match(/^(\d+)\s*[.．、]?$/)?.[1]);
      const hasNumber = Number.isSafeInteger(declaredNumber) && declaredNumber > 0;
      const number = hasNumber ? declaredNumber : index + 1;
      const typeNames = { single: '单选题', multiple: '多选题', fill: '填空题', short: '简答题', essay: '论述题', calculation: '计算题', attachment: '附件题', judgment: '判断题', compound: '组合题', open: '其他题型' };
      const scoreLabel = [...node.querySelectorAll('.exam_question_stem .score')].find(e => e.closest('.question') === node)?.textContent || '';
      const visibleType = scoreLabel.match(/单选题|多选题|填空题|简答题|论述题|计算题|附件题|判断题|组合题/);
      const typeName = typeNames[question?.type] || visibleType?.[0] || '题型未识别';
      let state = 'unknown', writable = false;
      if (question && ['single', 'multiple'].includes(question.type) && fields.length === question.options.length && fields.every(e => e.value) && new Set(fields.map(e => e.value)).size === fields.length) {
        state = fields.some(e => e.checked) ? 'done' : 'empty'; writable = fields.every(e => !e.disabled);
      } else if (question?.type === 'fill' && fields.length === question.blankCount || question && ['short', 'essay', 'calculation'].includes(question.type) && fields.length === 1) {
        const filled = fields.filter(e => e.value.trim()).length;
        state = filled === fields.length ? 'done' : filled ? 'partial' : 'empty'; writable = fields.every(e => !e.disabled && !e.readOnly);
      }
      if (parsed.resources?.length) writable = false;
      let reason = '';
      if (state === 'unknown' || state !== 'done' && !writable) {
        if (parsed.error) reason = parsed.error === 'question' ? '题干、题型或选项格式未通过校验，无法完整读取题目' : parsed.error;
        else if (question?.type === 'attachment') reason = '需要上传文件；当前不支持自动上传，也无法自动确认已有附件是否满足要求';
        else if (question?.type === 'judgment') reason = '判断题的自动填写尚未适配';
        else if (question?.type === 'compound') reason = '组合题的子题自动填写尚未适配';
        else if (question?.type === 'open') reason = '该题型的自动填写尚未适配';
        else if (parsed.resources?.length) reason = '题干或选项含图片，批量自动作答暂未接入识图';
        else if (['single', 'multiple'].includes(question?.type)) {
          reason = fields.length !== question.options.length ? `读取到 ${question.options.length} 个选项，但匹配到 ${fields.length} 个选择控件` :
            fields.some(e => !e.value) || new Set(fields.map(e => e.value)).size !== fields.length ? '选项标识缺失或重复，无法可靠匹配答案' : '选择控件被禁用，当前页面不能修改答案';
        } else if (subject?.querySelector('[contenteditable],.DraftEditor-root,iframe')) reason = '使用特殊文本编辑器，当前未适配自动填写或作答状态核对';
        else if (question?.type === 'fill' && fields.length !== question.blankCount) reason = `应有 ${question.blankCount} 个空位，但匹配到 ${fields.length} 个输入框`;
        else if (fields.length !== 1 && ['short', 'essay', 'calculation'].includes(question?.type)) reason = `未找到唯一可填写的文本框（匹配到 ${fields.length} 个）`;
        else if (fields.some(e => e.disabled || e.readOnly)) reason = '输入框被禁用或只读，当前页面不能修改答案';
        else reason = '无法确认作答状态或填写方式';
      }
      const fingerprint = JSON.stringify({ content: dom.fingerprint(node), fields: fields.map(e => ({ type: e.type, value: ['radio', 'checkbox'].includes(e.type) ? e.value : null })) });
      return { question, state, writable, fingerprint, number, numberSource: hasNumber ? 'page' : 'order', typeName, reason };
    }
    function inspect(task) {
      if (!batch.matches(location.href, task)) throw Error('当前页面不属于已确认任务。');
      const buttons = nativeButtons();
      const resultHeader = document.querySelector('#survey_page .exam_paper_sub_title');
      const submittedAt = resultHeader && [...resultHeader.querySelectorAll('span')].some(e => !e.children.length && /^提交时间[:：]\s*\d{4}[/-]\d{1,2}[/-]\d{1,2}\s+\d{1,2}:\d{2}/.test(e.textContent.trim()));
      const resultMark = resultHeader && (resultHeader.querySelector('img[alt="check_status"]') || [...resultHeader.querySelectorAll('.strong_label')].some(e => compactText(e) === '最终成绩'));
      const canResubmit = buttons.some(e => !e.disabled && e.type === 'submit' && /^(提交|提交作业|交卷|补交)$/.test(compactText(e)));
      const submitted = buttons.some(e => e.disabled && compactText(e) === '已提交') || Boolean(submittedAt && resultMark && !canResubmit && !buttons.some(e => compactText(e) === '提交中'));
      const page = document.querySelector('#survey_page');
      // Xiaoya renders an empty score subtitle before the actual question count.
      const totals = [...new Set([...document.querySelectorAll('#survey_page .score_sub_title')]
        .map(element => Number(element.textContent.trim().match(/^共\s*(\d+)\s*题/)?.[1]))
        .filter(value => Number.isSafeInteger(value) && value > 0))];
      const total = totals.length === 1 ? totals[0] : 0;
      const items = nodes().map(inspectQuestion);
      const complete = total > 0 && total === items.length && items.every(q => q.question) && new Set(items.map(q => q.question?.id)).size === items.length;
      const entry = document.querySelector('.entry_task_btn');
      const begin = [...document.querySelectorAll('#survey_page button,#survey_page .xy_link_click')].find(e => visible(e) && /^(立即开始答题|开始答题)$/.test(e.textContent.trim()) && !e.disabled);
      return { pageToken, url: location.href, pageKind: location.pathname.includes('/course_paper/') ? 'paper' : 'resource',
        canEnterCurrent: Boolean(entryFallback()), submitted, submissionSucceeded: receiptArmed && receiptTaskId === task.id && successDialogs().length === 1, complete, total, questions: items, fingerprint: JSON.stringify(items.map(q => q.fingerprint)),
        canEnter: location.pathname.includes('/resource/') && visible(entry), canBegin: Boolean(begin),
        reason: !page ? '作业页面尚未加载。' : totals.length > 1 ? '卷面总题数信息不一致，请核对页面。' : !total ? '无法读取卷面总题数。' : !complete ? `试卷题目未完整读取，整份未提交。${batch.questionProblems(items) ? `\n${batch.questionProblems(items)}` : '\n可能存在分页、重复题目或未适配结构。'}` : '' };
    }
    async function authorize(message, action) {
      if (batchId !== message.batchId) { batchId = message.batchId; halted = false; submittedHere = false; receiptArmed = false; receiptTaskId = null; entryAttempted = false; entryFallbackUsed = false; }
      if (halted || !batch.matches(location.href, message.task)) throw Error('任务已停止或页面身份变化。');
      const allowed = await permit({ batchId, taskId: message.task.id, action, pageToken });
      if (!allowed || halted || !batch.matches(location.href, message.task)) throw Error('当前操作未获本批授权或已停止。');
    }
    async function fill(message) {
      const item = message.item;
      const node = nodes().find(node => subjectFor(node)?.id === item.id);
      if (!node) throw Error('找不到对应题目。');
      const before = inspectQuestion(node);
      if (before.fingerprint !== item.fingerprint) throw Error('题目或选项已变化。');
      if (before.state === 'done') return { preserved: true };
      if (!before.writable || before.state === 'unknown') throw Error('该题无法可靠填写。');
      const fields = controls(node, before.question), solution = item.solution;
      const expected = new Map();
      const unchanged = () => { if (!node.isConnected || inspectQuestion(node).fingerprint !== before.fingerprint) throw Error('等待期间题目发生变化，已停止填写。'); };
      if (['single', 'multiple'].includes(before.question.type)) {
        if (solution?.kind !== 'choice' || !Array.isArray(solution.labels) || !solution.labels.length || new Set(solution.labels).size !== solution.labels.length || before.question.type === 'single' && solution.labels.length !== 1) throw Error('选择题答案格式不符。');
        const indices = solution.labels.map(label => before.question.options.findIndex(option => option.label === label));
        if (indices.some(i => i < 0)) throw Error('选项无法匹配。');
        await authorize(message, 'fill'); unchanged();
        if (fields.some(e => e.checked)) return { preserved: true };
        for (const i of indices) {
          await authorize(message, 'fill'); unchanged();
          // Check fields not written by us to preserve changes made during awaits.
          if (fields.some((e, j) => e.checked && !expected.has(j))) throw Error('填写过程中出现人工选项，已停止该份提交。');
          if (!fields[i].isConnected || fields[i].disabled) throw Error('选项已改变。');
          fields[i].click(); expected.set(i, true); await delay(80);
        }
        if (fields.some((e, i) => e.checked !== expected.has(i))) throw Error('选项填写后回读不一致。');
      } else {
        const values = before.question.type === 'fill' ? solution?.kind === 'fill' && solution.values : solution?.kind === 'text' && [solution.text];
        if (!Array.isArray(values) || values.length !== fields.length || values.some(v => typeof v !== 'string' || !v.trim())) throw Error('空位或文本答案格式不符。');
        for (let i = 0; i < fields.length; i++) {
          await authorize(message, 'fill'); unchanged();
          const field = fields[i]; if (field.value.trim()) continue;
          if (!field.isConnected || field.disabled || field.readOnly) throw Error('输入框状态已变化。');
          const view = document.defaultView;
          const prototype = field.tagName === 'TEXTAREA' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
          if (!setter) throw Error('无法使用原生输入控件。');
          setter.call(field, values[i]);
          field.dispatchEvent(new view.Event('input', { bubbles: true })); field.dispatchEvent(new view.Event('change', { bubbles: true })); field.blur();
          expected.set(i, values[i]); await delay(100);
          if (field.value !== values[i]) throw Error('输入内容未被页面保留。');
        }
      }
      await delay(500);
      if (!node.isConnected || !nodes().includes(node)) throw Error('题目已重新渲染，请核对草稿。');
      const after = inspectQuestion(node);
      if (after.fingerprint !== before.fingerprint || after.state !== 'done') throw Error('写入后未能确认整题已答。');
      return { filled: true };
    }
    async function command(message) {
      if (message.action === 'halt') { halted = true; return { ok: true }; }
      if (!batch.matches(location.href, message.task)) throw Error('页面不属于已确认任务。');
      if (message.action === 'inspect') {
        // Expanding the answer sheet changes no answers or task participation.
        const toggle = document.querySelector('#survey_page .anticon-left-circle[title="展开"]');
        if (toggle && visible(toggle)) { toggle.click(); await delay(150); }
        const snapshot = inspect(message.task);
        if (message.batchId !== batchId) snapshot.submissionSucceeded = false;
        return { ok: true, snapshot };
      }
      if (message.pageToken !== pageToken) throw Error('页面已重新加载，旧指令已失效。');
      if (message.action === 'enter') {
        await authorize(message, 'enter');
        const state = inspect(message.task);
        const target = state.canEnter ? document.querySelector('.entry_task_btn') : [...document.querySelectorAll('#survey_page button,#survey_page .xy_link_click')].find(e => visible(e) && /^(立即开始答题|开始答题)$/.test(e.textContent.trim()) && !e.disabled);
        if (!target) throw Error('没有可用的开始入口，可能尚未开放或已截止。');
        entryAttempted = true; target.click(); return { ok: true };
      }
      if (message.action === 'enter-current') {
        await authorize(message, 'enter');
        const button = entryFallback();
        if (!button) throw Error('未找到本次进入任务的明确跳转提示，请在平台核对。');
        // Mark before clicking: losing the navigation reply must never repeat the action.
        entryFallbackUsed = true; button.click(); return { ok: true };
      }
      if (message.action === 'fill') return { ok: true, ...await fill(message) };
      if (message.action === 'submit') {
        await authorize(message, 'submit');
        const state = inspect(message.task);
        if (state.questions.some(item => item.question?.type === 'attachment')) throw Error('含附件题的任务仅保留草稿，不自动提交。');
        if (state.submitted || !state.complete || state.fingerprint !== message.fingerprint || state.questions.some(q => q.state !== 'done')) throw Error('提交前整卷核对未通过。');
        const unsettled = await stablePaper(message);
        if (unsettled) return { ok: true, blocked: true, reason: unsettled };
        if (activeDialogs().length) return { ok: true, blocked: true, reason: '页面已有弹窗，请先人工核对，未再次点击交卷。' };
        const buttons = nativeButtons().filter(e => e.type === 'submit' && !e.disabled && /^(提交|提交作业|交卷|补交)$/.test(compactText(e)));
        if (buttons.length !== 1) throw Error('不能唯一确定真实交卷按钮。');
        // A pre-existing success dialog must never become this attempt's receipt.
        receiptArmed = successDialogs().length === 0; receiptTaskId = message.task.id;
        submittedHere = true; submittedFingerprint = state.fingerprint; buttons[0].click(); return { ok: true };
      }
      if (message.action === 'confirm') {
        if (!submittedHere) return { ok: true };
        let previous = null;
        for (let attempt = 0; attempt < 12; attempt++) {
          await authorize(message, 'confirm');
          const candidate = confirmationState();
          if (candidate.kind === 'none') return { ok: true };
          if (candidate.kind === 'blocked') return { ok: true, blocked: true, reason: candidate.reason };
          const current = inspect(message.task);
          if (!current.complete || current.fingerprint !== submittedFingerprint || current.questions.some(q => q.state !== 'done')) throw Error('交卷确认前题目或答案已变化，请人工核对。');
          const reason = candidate.kind === 'loading' ? candidate.reason : answerCard(current, true);
          const values = answerValues();
          if (!reason && previous?.modal === candidate.modal && previous?.button === candidate.button && previous?.values === values) {
            // No awaits between the final fresh checks and this single click.
            submittedHere = false; candidate.button.click(); return { ok: true };
          }
          previous = reason ? null : { modal: candidate.modal, button: candidate.button, values };
          if (attempt === 11) return { ok: true, blocked: true, reason: reason || '提交确认窗口或答案持续变化，请人工核对。' };
          await delay(250);
        }
      }
      throw Error('未知作答指令。');
    }
    return { command, inspect, inspectQuestion };
  }
  root.XiaoyaAnswerPage = { createAdapter };
  if (typeof module !== 'undefined') { module.exports = root.XiaoyaAnswerPage; return; }
  if (root.__xiaoyaAnswerPage) return;
  root.__xiaoyaAnswerPage = true;
  const adapter = createAdapter({ document, location, permit: async message => (await chrome.runtime.sendMessage({ type: 'auto:permit', ...message }))?.allowed === true });
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type !== 'auto:page' || sender.id !== chrome.runtime.id || sender.tab) return;
    adapter.command(message).then(reply, error => reply({ ok: false, error: error.message })); return true;
  });
})(globalThis);
