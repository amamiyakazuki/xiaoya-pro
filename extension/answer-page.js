(function (root) {
  'use strict';
  const choiceTypes = ['single', 'multiple', 'judgment'];
  function judgmentWord(text) {
    let word = text.replace(/^[A-B][.．、]\s*/i, '').trim();
    const wrappers = { '(': ')', '（': '）', '[': ']', '［': '］', '【': '】', '"': '"', '“': '”' };
    word = word.replace(/[。.!！]$/, '').trim();
    while (word.length > 1 && wrappers[word[0]] === word[word.length - 1]) word = word.slice(1, -1).trim();
    return word.replace(/[。.!！]$/, '').trim();
  }
  function judgmentMeanings(question) {
    const meanings = question.options.map(({ text }) => {
      const word = judgmentWord(text);
      if (/^(正确|对|是|√|✓|✔|true|t)$/i.test(word)) return true;
      if (/^(错误|错|否|×|✗|✘|false|f)$/i.test(word)) return false;
    });
    return meanings.includes(true) && meanings.includes(false) ? meanings : [];
  }
  function choiceIndices(question, solution) {
    if (question.type === 'judgment') {
      if (solution?.kind !== 'judgment' || typeof solution.value !== 'boolean') throw Error('判断题答案格式不符。');
      return [judgmentMeanings(question).indexOf(solution.value)];
    }
    if (solution?.kind !== 'choice' || !Array.isArray(solution.labels) || !solution.labels.length || new Set(solution.labels).size !== solution.labels.length || question.type === 'single' && solution.labels.length !== 1) throw Error('选择题答案格式不符。');
    return solution.labels.map(label => question.options.findIndex(option => option.label === label));
  }
  function createAdapter({ document, location, permit, uuid = () => crypto.randomUUID(), delay = ms => new Promise(r => setTimeout(r, ms)) }) {
    const batch = root.XiaoyaAnswerBatch, dom = root.XiaoyaAnswerDOM;
    const pageToken = uuid(); let halted = false, batchId = null, submittedHere = false, submittedFingerprint = null;
    const judgmentControlIds = new WeakMap(); let nextJudgmentControlId = 0;
    function judgmentControlId(control) {
      if (!judgmentControlIds.has(control)) judgmentControlIds.set(control, ++nextJudgmentControlId);
      return judgmentControlIds.get(control);
    }
    let entryAttempted = false, entryFallbackUsed = false;
    let receiptTaskId = null, receiptArmed = false;
    let mediaRead = null, mediaVersion = 0, skippedVersion = 0;
    const mediaByQuestion = new Map();
    const queriedCanvases = new Map();
    const skippedContent = new WeakMap();
    function skippedFingerprint(node) {
      // Unsupported content and existing answers remain in this page only.  The worker
      // receives an opaque version and can still detect a change before another write.
      const fields = [...node.querySelectorAll('input,textarea,select')].map(field => ({
        value: field.value, checked: field.checked, selectedIndex: field.selectedIndex
      }));
      const source = JSON.stringify([node.outerHTML, fields]);
      let entry = skippedContent.get(node);
      if (!entry || entry.source !== source) {
        entry = { source, version: ++skippedVersion };
        skippedContent.set(node, entry);
      }
      return JSON.stringify(['skipped', pageToken, entry.version]);
    }
    function pageContentFingerprint(node, parsed = dom.extract(node)) {
      if (!parsed.resources?.length) return JSON.stringify(parsed.question || parsed.error);
      // Keep signed URLs and inline image bytes on the page. Snapshots only need to detect changes.
      const sources = parsed.resources.map(resource => resource.source);
      let entry = mediaByQuestion.get(parsed.question.id);
      if (!entry || sources.length !== entry.sources.length || sources.some((source, i) => source !== entry.sources[i])) {
        entry = { sources, version: ++mediaVersion };
        mediaByQuestion.set(parsed.question.id, entry);
      }
      return JSON.stringify([parsed.question, pageToken, entry.version]);
    }
    const visible = element => Boolean(element && !element.hidden && !element.closest('[hidden]') && (typeof element.getClientRects !== 'function' || element.getClientRects().length));
    const compactText = element => (element.textContent || '').replace(/\s+/g, '');
    const nativeButtons = () => [...document.querySelectorAll('#survey_page button')].filter(visible);
    const subjectsFor = node => [...node.querySelectorAll('[id^="question_"]')].filter(e => /^question_\d+$/.test(e.id) && e.closest('.question') === node);
    const subjectFor = node => {
      const subjects = subjectsFor(node);
      return subjects.length === 1 ? subjects[0] : null;
    };
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
    function cardMatches(entries, questionIds) {
      const ids = new Set(entries.map(entry => entry.querySelector('a')?.id));
      return entries.length === questionIds.length && questionIds.every(id => id && ids.has('#' + id.slice('question_'.length)));
    }
    function answerCard(state, required = false) {
      const lists = [...document.querySelectorAll('#survey_page .answer_info_card .sheet_list')];
      if (!lists.length) return required ? '无法读取平台答题卡，不能确认作答状态。' : '';
      if (lists.length !== 1) return '平台答题卡结构不唯一，请人工核对。';
      const entries = [...lists[0].children];
      const byQuestion = state.questions.map(item => item.question.id);
      const byPart = state.questions.flatMap(item => item.partIds || [item.question.id]);
      if (!(state.total === byQuestion.length && cardMatches(entries, byQuestion)) && !cardMatches(entries, byPart)) return '平台答题卡尚未完整同步。';
      const unfinished = entries.filter(e => e.title !== '已答题' || !e.classList.contains('finish'));
      return unfinished.length ? `平台答题卡尚未确认已答：第 ${unfinished.map(e => e.querySelector('a')?.textContent.trim()).join('、')} 题。` : '';
    }
    function answerValues() {
      // Used only within this page operation; never sent to the worker or stored.
      const leaves = nodes().flatMap(node => {
        const parts = dom.childQuestions(node);
        return parts.length ? parts : [node];
      });
      return JSON.stringify(leaves.map(node => controls(node, dom.extract(node).question).map(e => ['radio', 'checkbox'].includes(e.type) ? e.checked : textValue(e))));
    }
    async function stablePaper(message) {
      let previous = null, reason = '';
      for (let attempt = 0; attempt < 12; attempt++) {
        await authorize(message, 'submit');
        const state = inspect(message.task);
        if (!state.complete || state.fingerprint !== message.fingerprint || state.questions.some(q => q.skipReason || q.state !== 'done')) return '提交前题目或答案已变化，请核对整卷。';
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
    const ENTRY_BUFFER_MS = 700;
    const entryEnabled = element => Boolean(visible(element) && !element.disabled && element.getAttribute?.('aria-disabled') !== 'true');
    function entryFallbackMatch() {
      if (!entryAttempted || entryFallbackUsed || !location.pathname.includes('/resource/')) return null;
      const dialogs = [...document.querySelectorAll('.ant-modal,.ant-modal-confirm,[role="dialog"]')].filter(visible);
      const matches = new Map();
      for (const dialog of dialogs) {
        const text = dialog.textContent.replace(/\s+/g, '');
        if (!text.includes('窗口被浏览器拦截') || !text.includes('无法正常打开新的页面') || !text.includes('当前页直接跳转')) continue;
        for (const button of dialog.querySelectorAll('button')) {
          if (entryEnabled(button) && button.textContent.replace(/\s+/g, '') === '在当前页面跳转' && !matches.has(button)) {
            matches.set(button, dialog);
          }
        }
      }
      if (matches.size !== 1) return null;
      const [[button, dialog]] = matches;
      return { button, dialog };
    }
    const entryFallback = () => entryFallbackMatch()?.button || null;
    const textTypes = ['short', 'essay', 'calculation', 'open'];
    const draftEditor = '.public-DraftEditor-content[contenteditable]';
    const nonTextInteraction = 'select,input[type]:not([type=text]):not([type=hidden]),[draggable="true"],[role="listbox"],[role="option"],[role="radio"],[role="combobox"],[role="checkbox"],[role="slider"],[role="tree"],[role="grid"]';
    const unsupportedControl = `[contenteditable],.DraftEditor-root,iframe,input:not([type=hidden]),[role="textbox"],${nonTextInteraction}`;
    function textValue(field) {
      if (!field.matches(draftEditor)) return field.value;
      // Draft represents each paragraph, including empty paragraphs, with a block.
      const blocks = [...field.querySelectorAll('[data-block="true"]')];
      const text = blocks.length ? blocks.map(block => block.textContent).join('\n') : field.textContent;
      if (!text.trim() && field.querySelector('img,svg,canvas,video,audio,[data-block-type="atomic"]')) return '\uFFFC';
      return text;
    }
    function writableText(field) {
      return field.matches(draftEditor) ? field.getAttribute('contenteditable') === 'true' : !field.disabled && !field.readOnly;
    }
    function writeText(field, value, noteWrite) {
      const view = document.defaultView;
      if (field.matches(draftEditor)) {
        const clipboardData = new view.DataTransfer();
        clipboardData.setData('text/plain', value);
        field.focus();
        noteWrite();
        field.dispatchEvent(new view.ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      } else {
        const prototype = field.tagName === 'TEXTAREA' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (!setter) throw Error('无法使用原生输入控件。');
        noteWrite(); setter.call(field, value);
        field.dispatchEvent(new view.Event('input', { bubbles: true }));
        field.dispatchEvent(new view.Event('change', { bubbles: true }));
      }
      field.blur();
    }
    function controls(node, question) {
      const subject = subjectFor(node); if (!subject) return [];
      if (choiceTypes.includes(question?.type)) return [...subject.querySelectorAll(question.type === 'multiple' ? 'label.ant-checkbox-wrapper input[type=checkbox]' : 'label.ant-radio-wrapper input[type=radio]')];
      if (question?.type === 'open' && subject.querySelector(nonTextInteraction)) return [];
      if (question?.type === 'fill' || textTypes.includes(question?.type)) return [...subject.querySelectorAll(`textarea,input[type=text],input:not([type]),${draftEditor}`)];
      return [];
    }
    function judgmentControlsMatch(node, question, fields) {
      const subject = subjectFor(node); if (!subject || question.options.length !== 2 || fields.length !== 2) return false;
      const labels = [...subject.querySelectorAll('label.ant-radio-wrapper')].filter(label => label.closest('.question') === node);
      const radios = [...subject.querySelectorAll('input[type=radio]')].filter(field => field.closest('.question') === node);
      if (labels.length !== 2 || radios.length !== 2) return false;
      return labels.every((label, i) => {
        const own = radios.filter(field => field.closest('label.ant-radio-wrapper') === label);
        return own.length === 1 && own[0] === fields[i];
      });
    }
    function judgmentExternalChecked(fields) {
      return [...document.querySelectorAll('input[type=radio]')].some(other => !fields.includes(other) && other.checked && fields.some(field =>
        field.name && field.name === other.name && field.form === other.form && field.getRootNode() === other.getRootNode()));
    }
    function inspectCompound(node, parsed) {
      const parts = dom.childQuestions(node).map(inspectQuestion);
      if (parts.some(part => !part.question?.id)) return {
        question: undefined, state: 'unknown', writable: false, partIds: parts.map(part => part.question?.id), attachmentParts: [],
        fingerprint: JSON.stringify([pageContentFingerprint(node, parsed), ...parts.map(part => part.fingerprint)]),
        reason: '组合题子题身份或结构尚未完整读取，请人工核对。'
      };
      const pending = parts.filter(part => part.question?.type !== 'attachment' && part.state !== 'done');
      const blocked = pending.filter(part => !part.writable || part.state === 'unknown');
      const attachmentParts = parts.flatMap((part, i) => part.question?.type === 'attachment' ? [i + 1] : []);
      // Send the shared material and only the subquestions that still need answers.
      const prompt = pending.length && pending.length < parts.length ? dom.extract(node, pending.map(part => part.question.id)) : parsed;
      const state = blocked.length ? 'unknown' : pending.length ? 'partial' : attachmentParts.length ? 'draft' : 'done';
      const reason = blocked.map(part => `第 ${parts.indexOf(part) + 1} 小题（${part.typeName}）：${part.reason}`).join('\n');
      const skipReason = blocked.length && blocked.every(part => part.skipReason) ? reason : '';
      return {
        question: prompt.question, hasImages: Boolean(prompt.resources?.length), state, writable: pending.length > 0 && !blocked.length,
        partIds: parts.map(part => part.question?.id), attachmentParts,
        fingerprint: skipReason ? skippedFingerprint(node) : JSON.stringify([pageContentFingerprint(node, parsed), ...parts.map(part => part.fingerprint)]),
        reason, ...(skipReason ? { skipReason } : {})
      };
    }
    function inspectQuestion(node, index = nodes().indexOf(node)) {
      const parsed = dom.extract(node);
      const subject = subjectFor(node);
      const children = dom.childQuestions(node);
      const childSubjects = children.map(subjectFor);
      const stem = [...node.querySelectorAll('.exam_question_stem .stem_title')].find(e => e.closest('.question') === node);
      // Only explicit, terminal parser failures qualify. Missing stems, options or
      // inconsistent blank counts may be a still-loading paper and remain blocking.
      const terminalError = /^(题目结构过大|单题图片超过 8 张|题干包含音视频或嵌入文件|题干包含尚未适配的外部材料文件)/.test(parsed.error || '');
      const ids = [subject?.id, ...childSubjects.map(child => child?.id)];
      const recoverable = terminalError && subject && stem && (stem.textContent.trim() || stem.querySelector('img,svg,canvas,video,audio,iframe,object,embed')) &&
        childSubjects.every(Boolean) && children.every(child => !dom.childQuestions(child).length) && new Set(ids).size === ids.length;
      const question = parsed.question || (recoverable ? { id: subject.id } : undefined);
      const fields = controls(node, question);
      const sequence = [...node.querySelectorAll('.exam_question_stem .sequence')].find(e => e.closest('.question') === node)?.textContent.trim();
      const declaredNumber = Number(sequence?.match(/^(\d+)\s*[.．、]?$/)?.[1]);
      const hasNumber = Number.isSafeInteger(declaredNumber) && declaredNumber > 0;
      const number = hasNumber ? declaredNumber : index + 1;
      const typeNames = { single: '单选题', multiple: '多选题', fill: '填空题', short: '简答题', essay: '论述题', calculation: '计算题', attachment: '附件题', judgment: '判断题', compound: '组合题', open: '其他题型' };
      const scoreLabel = [...node.querySelectorAll('.exam_question_stem .score')].find(e => e.closest('.question') === node)?.textContent || '';
      const visibleType = scoreLabel.match(/单选题|多选题|填空题|简答题|论述题|计算题|附件题|判断题|组合题/);
      const openLabel = question?.type === 'open' && typeof question.typeLabel === 'string' && question.typeLabel.length <= 24 && /^[\u4e00-\u9fffA-Za-z0-9（）()、/·\s-]+$/.test(question.typeLabel) ? question.typeLabel : '';
      const typeName = openLabel || typeNames[question?.type] || visibleType?.[0] || '题型未识别';
      if (question?.type === 'compound') return { ...inspectCompound(node, parsed), number, numberSource: hasNumber ? 'page' : 'order', typeName };
      if (recoverable && !parsed.question) return {
        question, state: 'unknown', writable: false, fingerprint: skippedFingerprint(node), hasImages: false,
        ...(children.length ? { partIds: childSubjects.map(child => child.id) } : {}),
        number, numberSource: hasNumber ? 'page' : 'order', typeName, reason: parsed.error, skipReason: parsed.error
      };
      let state = 'unknown', writable = false;
      if (question?.type === 'judgment' && judgmentControlsMatch(node, question, fields) && !judgmentExternalChecked(fields) && fields.filter(e => e.checked).length <= 1) {
        state = fields.some(e => e.checked) ? 'done' : 'empty';
        writable = fields.every(e => !e.disabled) && judgmentMeanings(question).length === 2;
      } else if (question && ['single', 'multiple'].includes(question.type) && fields.length === question.options.length && fields.every(e => e.value) && new Set(fields.map(e => e.value)).size === fields.length) {
        state = fields.some(e => e.checked) ? 'done' : 'empty'; writable = fields.every(e => !e.disabled);
      } else if (question?.type === 'fill' && fields.length === question.blankCount || textTypes.includes(question?.type) && fields.length === 1) {
        const emptyFields = fields.filter(field => !textValue(field).trim());
        state = emptyFields.length === 0 ? 'done' : emptyFields.length === fields.length ? 'empty' : 'partial';
        writable = (emptyFields.length ? emptyFields : fields).every(writableText);
      }
      let reason = '';
      if (state === 'unknown' || state !== 'done' && !writable) {
        if (parsed.error) reason = parsed.error === 'question' ? '题干、题型或选项格式未通过校验，无法完整读取题目' : parsed.error;
        else if (question?.type === 'attachment') reason = '需要上传文件；可用题旁浮标生成并附加，一键批次不处理附件题';
        else if (question?.type === 'judgment') {
          reason = fields.length !== 2 ? `判断题需要两个单选控件，当前匹配到 ${fields.length} 个` :
            !judgmentControlsMatch(node, question, fields) ? '判断题选项与单选控件无法一一对应，或题内存在额外单选控件' :
            fields.filter(field => field.checked).length > 1 ? '判断题检测到多个已选控件，请人工核对' :
            judgmentExternalChecked(fields) ? '判断题单选组的其他位置存在已选答案，请人工核对' :
            !judgmentMeanings(question).length ? '无法根据两个判断选项的文字区分正误' : '选择控件被禁用，当前页面不能修改答案';
        } else if (['single', 'multiple'].includes(question?.type)) {
          reason = fields.length !== question.options.length ? `读取到 ${question.options.length} 个选项，但匹配到 ${fields.length} 个选择控件` :
            fields.some(e => !e.value) || new Set(fields.map(e => e.value)).size !== fields.length ? '选项标识缺失或重复，无法可靠匹配答案' : '选择控件被禁用，当前页面不能修改答案';
        } else if (fields.some(field => !writableText(field) && !textValue(field).trim())) reason = '输入框被禁用或只读，当前页面不能修改答案';
        else if (!fields.length && subject?.querySelector('[contenteditable],.DraftEditor-root,iframe')) reason = '使用特殊文本编辑器，当前未适配自动填写或作答状态核对';
        else if (question?.type === 'fill' && fields.length !== question.blankCount) reason = `应有 ${question.blankCount} 个空位，但匹配到 ${fields.length} 个输入框`;
        else if (fields.length !== 1 && textTypes.includes(question?.type)) reason = `未找到唯一可填写的文本框（匹配到 ${fields.length} 个）`;
        else reason = '无法确认作答状态或填写方式';
      }
      const fingerprint = JSON.stringify({ content: pageContentFingerprint(node, parsed), fields: fields.map(e => ({ type: e.type, value: ['radio', 'checkbox'].includes(e.type) ? e.value : null, ...(question?.type === 'judgment' ? { controlId: judgmentControlId(e) } : {}) })) });
      const hasUnsupportedControl = [...(subject?.querySelectorAll(unsupportedControl) || [])].some(element => visible(element) && !element.closest('[aria-hidden="true"]'));
      const possiblyLoading = choiceTypes.includes(question?.type) && fields.length !== question.options.length ||
        question?.type === 'fill' && fields.length !== question.blankCount ||
        textTypes.includes(question?.type) && !fields.length && !hasUnsupportedControl;
      const skipReason = question && question.type !== 'attachment' && state !== 'done' && (state === 'unknown' || !writable) && !possiblyLoading && subject?.children.length ? reason : '';
      return { question, state, writable, fingerprint: skipReason ? skippedFingerprint(node) : fingerprint, hasImages: Boolean(parsed.resources?.length), number, numberSource: hasNumber ? 'page' : 'order', typeName, reason, ...(skipReason ? { skipReason } : {}) };
    }
    function inspect(task) {
      if (!batch.matches(location.href, task)) throw Error('当前页面不属于已确认任务。');
      const buttons = nativeButtons();
      const resultHeader = document.querySelector('#survey_page .exam_paper_sub_title');
      const submittedAt = resultHeader && [...resultHeader.querySelectorAll('span')].some(e => !e.children.length && /^提交时间[:：]\s*\d{4}[/-]\d{1,2}[/-]\d{1,2}\s+\d{1,2}:\d{2}/.test(e.textContent.trim()));
      const resultMark = resultHeader && (resultHeader.querySelector('img[alt="check_status"]') || [...resultHeader.querySelectorAll('.strong_label')].some(e => compactText(e) === '最终成绩'));
      const submitControls = buttons.filter(e => e.type === 'submit' && /^(提交|提交作业|交卷|补交)$/.test(compactText(e)));
      const canResubmit = submitControls.some(e => !e.disabled);
      const submitted = buttons.some(e => e.disabled && compactText(e) === '已提交') || Boolean(submittedAt && resultMark && !canResubmit && !buttons.some(e => compactText(e) === '提交中'));
      const page = document.querySelector('#survey_page');
      // Xiaoya renders an empty score subtitle before the actual question count.
      const totals = [...new Set([...document.querySelectorAll('#survey_page .score_sub_title')]
        .map(element => Number(element.textContent.trim().match(/^共\s*(\d+)\s*题/)?.[1]))
        .filter(value => Number.isSafeInteger(value) && value > 0))];
      const total = totals.length === 1 ? totals[0] : 0;
      const items = nodes().map(inspectQuestion);
      const questionIds = items.map(q => q.question?.id).filter(Boolean);
      const allIds = items.flatMap(item => [item.question?.id, ...(item.partIds || [])]).filter(Boolean);
      const duplicateIds = new Set(allIds).size !== allIds.length;
      const byPart = items.flatMap(item => item.partIds || [item.question?.id]);
      let countMatches = total === items.length;
      if (!countMatches && total === byPart.length) {
        const entries = [...document.querySelectorAll('#survey_page .answer_info_card .sheet_list > *')];
        countMatches = cardMatches(entries, byPart);
      }
      const complete = total > 0 && countMatches && questionIds.length === items.length && !duplicateIds;
      const entry = document.querySelector('.entry_task_btn');
      const begin = [...document.querySelectorAll('#survey_page button,#survey_page .xy_link_click')].find(e => visible(e) && /^(立即开始答题|开始答题)$/.test(e.textContent.trim()) && !e.disabled);
      // A supported-looking preview or a disabled paper is never permission to
      // write around unknown questions. Complete describes identity/count only.
      const partialSafe = Boolean(complete && location.pathname.includes('/course_paper/') && !submitted && !begin &&
        submitControls.filter(element => !element.disabled).length === 1 && !loading(page) && !activeDialogs().length);
      let reason = '';
      if (!page) reason = '作业页面尚未加载。';
      else if (totals.length > 1) reason = '卷面总题数信息不一致，请核对页面。';
      else if (!total) reason = '无法读取卷面总题数。';
      else if (!complete) {
        const details = ['试卷题目未完整读取，整份未提交。'];
        if (!countMatches) details.push(total === byPart.length
          ? `按子题计共 ${total} 题，平台答题卡尚未与子题完整对应。`
          : `当前页面读取到 ${items.length} 题，卷面共 ${total} 题。请检查是否还在加载或需要切页。`);
        if (duplicateIds) details.push('页面出现重复题目，请人工核对整卷。');
        const problems = batch.questionProblems(items);
        if (problems) details.push(problems);
        reason = details.join('\n');
      }
      return { pageToken, url: location.href, pageKind: location.pathname.includes('/course_paper/') ? 'paper' : 'resource',
        canEnterCurrent: Boolean(entryFallback()), submitted, submissionSucceeded: receiptArmed && receiptTaskId === task.id && successDialogs().length === 1, complete, partialSafe, total, questions: items, fingerprint: JSON.stringify(items.map(q => q.fingerprint)),
        canEnter: location.pathname.includes('/resource/') && entryEnabled(entry), canBegin: Boolean(begin), hasSubmitControl: submitControls.length > 0, reason };
    }
    async function authorize(message, action) {
      if (batchId !== message.batchId) { batchId = message.batchId; halted = false; submittedHere = false; receiptArmed = false; receiptTaskId = null; entryAttempted = false; entryFallbackUsed = false; queriedCanvases.clear(); }
      if (halted || !batch.matches(location.href, message.task)) throw Error('任务已停止或页面身份变化。');
      const allowed = await permit({ batchId, taskId: message.task.id, action, pageToken });
      if (!allowed || halted || !batch.matches(location.href, message.task)) throw Error('当前操作未获本批授权或已停止。');
    }
    async function fill(message, noteWrite) {
      const item = message.item;
      const node = nodes().find(node => subjectFor(node)?.id === item.id);
      if (!node) throw Error('找不到对应题目。');
      const before = inspectQuestion(node);
      if (before.fingerprint !== item.fingerprint) throw Error('题目或选项已变化。');
      const paperUnchanged = () => {
        if (!item.paperFingerprint) return;
        const current = inspect(message.task);
        if (!current.complete || !current.partialSafe || current.fingerprint !== item.paperFingerprint || !current.questions.some(q => q.skipReason)) throw Error('填写前整卷或跳过题已变化，请人工核对。');
      };
      paperUnchanged();
      if (before.state === 'done' || before.state === 'draft') return { preserved: true };
      if (before.skipReason || !before.writable || before.state === 'unknown') throw Error('该题无法可靠填写。');
      const unchanged = () => {
        if (!node.isConnected || inspectQuestion(node).fingerprint !== before.fingerprint) throw Error('等待期间题目发生变化，已停止填写。');
        paperUnchanged();
      };
      if (before.question.type !== 'compound') return fillLeaf(node, before, item.solution, message, noteWrite, unchanged);
      const answers = item.solution?.parts;
      if (item.solution?.kind !== 'compound' || !Array.isArray(answers)) throw Error('组合题答案格式不符。');
      const solutions = new Map(answers.map(part => [part.id, part.solution]));
      if (solutions.size !== answers.length || before.question.parts.some(part => !solutions.has(part.id))) throw Error('组合题答案与待答子题不一致。');
      let preserved = true;
      for (const child of dom.childQuestions(node)) {
        const part = inspectQuestion(child);
        if (part.question?.type === 'attachment' || part.state === 'done') continue;
        if (!part.writable || !solutions.has(part.question?.id)) throw Error('组合题子题已变化。');
        const result = await fillLeaf(child, part, solutions.get(part.question.id), message, noteWrite, unchanged);
        if (!result.preserved) preserved = false;
      }
      unchanged();
      if (!['done', 'draft'].includes(inspectQuestion(node).state)) throw Error('写入后未能确认所有待答子题已答。');
      return preserved ? { preserved: true } : { filled: true };
    }
    async function fillLeaf(node, before, solution, message, noteWrite, unchanged) {
      const fields = controls(node, before.question);
      const expected = new Map();
      function checkJudgmentControls() {
        if (before.question.type !== 'judgment') return;
        const current = controls(node, before.question);
        if (current.length !== fields.length || current.some((field, i) => field !== fields[i]) ||
            !judgmentControlsMatch(node, before.question, current) || judgmentExternalChecked(current) || current.filter(field => field.checked).length > 1) {
          throw Error('判断题控件或已有答案已变化，请人工核对。');
        }
      }
      if (choiceTypes.includes(before.question.type)) {
        const indices = choiceIndices(before.question, solution);
        if (indices.some(i => i < 0)) throw Error('选项无法匹配。');
        await authorize(message, 'fill'); unchanged(); checkJudgmentControls();
        if (fields.some(e => e.checked)) return { preserved: true };
        for (const i of indices) {
          await authorize(message, 'fill'); unchanged(); checkJudgmentControls();
          // Check fields not written by us to preserve changes made during awaits.
          if (fields.some((e, j) => e.checked && !expected.has(j))) throw Error('填写过程中出现人工选项，已停止该份提交。');
          if (!fields[i].isConnected || fields[i].disabled) throw Error('选项已改变。');
          noteWrite(); fields[i].click(); expected.set(i, true); await delay(80); checkJudgmentControls();
        }
        if (fields.some((e, i) => e.checked !== expected.has(i))) throw Error('选项填写后回读不一致。');
      } else {
        const values = before.question.type === 'fill' ? solution?.kind === 'fill' && solution.values : solution?.kind === 'text' && [solution.text];
        if (!Array.isArray(values) || values.length !== fields.length || values.some(v => typeof v !== 'string' || !v.trim())) throw Error('空位或文本答案格式不符。');
        for (let i = 0; i < fields.length; i++) {
          await authorize(message, 'fill'); unchanged();
          const field = fields[i]; if (textValue(field).trim()) continue;
          if (!field.isConnected || !writableText(field)) throw Error('输入框状态已变化。');
          const value = values[i].replace(/\r\n?/g, '\n');
          writeText(field, value, noteWrite);
          expected.set(i, value);
          await delay(100);
          if (textValue(field) !== value) throw Error('输入内容未被页面保留。');
        }
      }
      await delay(500);
      checkJudgmentControls();
      if (!node.isConnected || !node.closest('#question_content')) throw Error('题目已重新渲染，请核对草稿。');
      const after = inspectQuestion(node);
      if (after.fingerprint !== before.fingerprint || after.state !== 'done') throw Error('写入后未能确认整题已答。');
      if (!choiceTypes.includes(before.question.type)) {
        const current = controls(node, after.question);
        for (const [i, value] of expected) if (textValue(current[i]) !== value) throw Error('输入内容未被页面保留。');
      }
      return expected.size ? { filled: true } : { preserved: true };
    }
    async function command(message) {
      const blockedBeforeClick = reason => ({ ok: true, blocked: true, reason });
      if (message.action === 'halt') { halted = true; mediaRead?.abort(); queriedCanvases.clear(); return { ok: true }; }
      if (!batch.matches(location.href, message.task)) {
        if (message.action === 'submit') return blockedBeforeClick('页面不属于已确认任务。');
        throw Error('页面不属于已确认任务。');
      }
      if (message.action === 'inspect') {
        // Expanding the answer sheet changes no answers or task participation.
        const toggle = document.querySelector('#survey_page .anticon-left-circle[title="展开"]');
        if (toggle && visible(toggle)) { toggle.click(); await delay(150); }
        const snapshot = inspect(message.task);
        if (message.batchId !== batchId) snapshot.submissionSucceeded = false;
        return { ok: true, snapshot };
      }
      if (message.pageToken !== pageToken) {
        if (message.action === 'submit') return blockedBeforeClick('页面已重新加载，旧交卷指令已失效。');
        throw Error('页面已重新加载，旧指令已失效。');
      }
      if (message.action === 'locate-draft') return { ok: true, pageToken };
      if (message.action === 'prepare-images') {
        await authorize(message, 'prepare-images');
        const node = nodes().find(node => subjectFor(node)?.id === message.id);
        if (!node || inspectQuestion(node).fingerprint !== message.fingerprint) throw Error('读取图片前题目已变化。');
        const extracted = dom.extract(node, message.partIds);
        if (!extracted.resources?.length) throw Error(extracted.error || '未找到本题图片。');
        const controller = new AbortController();
        mediaRead = controller;
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          const { images } = await root.XiaoyaAnswerMedia.prepare(extracted, { signal: controller.signal, base: location.href, document });
          if (controller.signal.aborted || !node.isConnected || inspectQuestion(node).fingerprint !== message.fingerprint) throw Error('读取图片期间题目已变化。');
          const canvases = extracted.resources.flatMap((resource, i) => resource.kind === 'canvas' ? [{ node: resource.node, data: images[i] }] : []);
          if (canvases.length) queriedCanvases.set(message.id, canvases);
          return { ok: true, images };
        } catch (error) {
          if (controller.signal.aborted) throw Error('图片读取已取消或超过 15 秒。');
          throw error;
        } finally {
          clearTimeout(timer);
          mediaRead = null;
        }
      }
      if (message.action === 'enter') {
        await authorize(message, 'enter');
        const state = inspect(message.task);
        if (state.canEnter) {
          const entry = document.querySelector('.entry_task_btn');
          if (!entryEnabled(entry)) throw Error('没有可用的开始入口，可能尚未开放或已截止。');
          // Give the SPA a short buffer to bind click handlers after rendering the preview entry.
          await delay(ENTRY_BUFFER_MS);
          await authorize(message, 'enter');
          const next = inspect(message.task);
          const current = next.canEnter ? document.querySelector('.entry_task_btn') : null;
          if (current !== entry || !entry.isConnected || !entryEnabled(entry)) throw Error('进入任务入口已变化或不可用，未点击。');
          entryAttempted = true; entry.click(); return { ok: true };
        }
        const target = [...document.querySelectorAll('#survey_page button,#survey_page .xy_link_click')].find(e => visible(e) && /^(立即开始答题|开始答题)$/.test(e.textContent.trim()) && !e.disabled);
        if (!target) throw Error('没有可用的开始入口，可能尚未开放或已截止。');
        entryAttempted = true; target.click(); return { ok: true };
      }
      if (message.action === 'enter-current') {
        await authorize(message, 'enter');
        const before = entryFallbackMatch();
        if (!before) throw Error('未找到本次进入任务的明确跳转提示，请在平台核对。');
        await delay(ENTRY_BUFFER_MS);
        await authorize(message, 'enter');
        const after = entryFallbackMatch();
        if (!after || after.button !== before.button || after.dialog !== before.dialog || !after.button.isConnected || !entryEnabled(after.button)) {
          throw Error('跳转提示弹窗已变化或不可用，未点击。');
        }
        // Mark before clicking: losing the navigation reply must never repeat the action.
        entryFallbackUsed = true; after.button.click(); return { ok: true };
      }
      if (message.action === 'fill') {
        let writeAttempted = false;
        try { return { ok: true, ...await fill(message, () => {
          // Canvas pixels can change without a DOM change. Compare once, immediately before the first write.
          if (!writeAttempted && queriedCanvases.get(message.item.id)?.some(({ node, data }) =>
            !node.isConnected || root.XiaoyaAnswerMedia.canvasData(node) !== data)) throw Error('题目画布已重绘，请重新读取该题。');
          writeAttempted = true;
        }) }; }
        catch (error) { throw Object.assign(Error(error?.message || '填写未完成。'), { fillBeforeWrite: !writeAttempted }); }
        finally { queriedCanvases.delete(message.item.id); }
      }
      if (message.action === 'submit') {
        let button;
        try {
          await authorize(message, 'submit');
          const state = inspect(message.task);
          if (state.questions.some(item => item.question?.type === 'attachment' || item.attachmentParts?.length)) return blockedBeforeClick('含附件题的任务仅保留草稿，不自动提交。');
          if (state.questions.some(item => item.skipReason)) return blockedBeforeClick('含跳过题的任务仅保留草稿，不自动提交。');
          if (state.submitted || !state.complete || state.fingerprint !== message.fingerprint || state.questions.some(q => q.state !== 'done')) return blockedBeforeClick('提交前整卷核对未通过。');
          const unsettled = await stablePaper(message);
          if (unsettled) return blockedBeforeClick(unsettled);
          if (activeDialogs().length) return blockedBeforeClick('页面已有弹窗，请先人工核对，未再次点击交卷。');
          const buttons = nativeButtons().filter(e => e.type === 'submit' && !e.disabled && /^(提交|提交作业|交卷|补交)$/.test(compactText(e)));
          if (buttons.length !== 1) return blockedBeforeClick('不能唯一确定真实交卷按钮。');
          button = buttons[0];
        } catch (error) { return blockedBeforeClick(error?.message || '提交前检查未能完成。'); }
        // A pre-existing success dialog must never become this attempt's receipt.
        receiptArmed = successDialogs().length === 0; receiptTaskId = message.task.id;
        submittedHere = true; submittedFingerprint = message.fingerprint; button.click(); return { ok: true };
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
          if (!current.complete || current.fingerprint !== submittedFingerprint || current.questions.some(q => q.skipReason || q.state !== 'done')) throw Error('交卷确认前题目或答案已变化，请人工核对。');
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
    adapter.command(message).then(reply, error => reply({ ok: false, error: error.message, fillBeforeWrite: error.fillBeforeWrite === true })); return true;
  });
})(globalThis);
