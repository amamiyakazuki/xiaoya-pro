(function (root) {
  'use strict';
  const schema = root.XiaoyaQuestion;
  const fail = message => { throw new Error(message); };
  const subjectSelector = '[id^="question_"]';
  const direct = (node, selector) => [...node.querySelectorAll(selector)].filter(el => el.closest('.question') === node);
  function ownStem(node) { return direct(node, '.exam_question_stem .stem_title')[0]; }
  function richText(node, resources) {
    let visited = 0;
    function walk(el) {
      if (++visited > 8000) fail('题目结构过大，请缩小材料范围后重试。');
      if (el.nodeType === 3) return el.textContent;
      if (el.nodeType !== 1) return '';
      if (el.matches('script,style,button,input,textarea,select,.xiaoya-ai-float,.ext_question_operate')) return '';
      const latex = el.getAttribute('data-tex') || el.getAttribute('data-latex') || el.querySelector(':scope > annotation[encoding="application/x-tex"]')?.textContent;
      if (latex) return ` \\(${latex}\\) `;
      if (el.matches('.katex,.MathJax,.mathjax')) {
        const source = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
        if (source) return ` \\(${source}\\) `;
      }
      if (el.matches('math')) {
        const serialize = n => n.nodeType === 3 ? n.textContent : `<${n.localName}>${[...n.childNodes].map(serialize).join('')}</${n.localName}>`;
        return ` ${serialize(el)} `;
      }
      if (el.matches('img,svg,canvas')) {
        let kind = 'url', source;
        if (el.matches('svg')) { kind = 'svg'; source = el.outerHTML; }
        else if (el.matches('canvas')) { kind = 'canvas'; source = `${el.width}x${el.height}`; }
        else source = el.currentSrc || el.getAttribute('src') || el.getAttribute('data-src');
        if (!source) fail('题目图片尚未加载，请等待图片显示后重试。');
        if (resources.length >= schema.LIMITS.images) fail('单题图片超过 8 张，请拆分材料后查询。');
        resources.push({ kind, source, node: el });
        return ` [图片 ${resources.length}] `;
      }
      if (el.matches('video,audio,iframe,object,embed')) fail('题干包含音视频或嵌入文件，请将需要的材料转为图片或文字后再查询。');
      if (el.matches('a[href]')) {
        // Never send potentially credentialed download links to the AI provider.
        const href = el.getAttribute('href');
        if (href && !href.startsWith('#')) fail('题干包含尚未适配的外部材料文件，需要核对文件格式后接入读取；未向 AI 发送不完整题目。');
      }
      const text = [...el.childNodes].map(walk).join('');
      return el.matches('br,p,div,li,tr,h1,h2,h3,h4,pre') ? `${text}\n` : el.matches('td,th') ? `${text}\t` : text;
    }
    return walk(node).replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  function classify(subject, typeLabel, children) {
    if (children.length) return 'compound';
    if (/判断|是非/.test(typeLabel)) return 'judgment';
    if (subject.classList.contains('question_gap_subject') || /填空/.test(typeLabel)) return 'fill';
    if (subject.classList.contains('question_multiple_subject') || /多选|不定项/.test(typeLabel)) return 'multiple';
    if (subject.classList.contains('question_single_subject') || /单选/.test(typeLabel)) return 'single';
    if (subject.classList.contains('question_attach_subject') || /附件|上传/.test(typeLabel)) return 'attachment';
    if (/论述|作文|写作/.test(typeLabel)) return 'essay';
    if (/计算|证明|推导/.test(typeLabel)) return 'calculation';
    if (subject.classList.contains('question_subjective_subject') || /简答|问答|名词解释/.test(typeLabel)) return 'short';
    if (typeLabel) return 'open';
    fail('题型标记和结构不完整，请等待页面加载后重试。');
  }
  function extract(node) {
    const resources = [], warnings = [];
    try {
      function parse(current, depth = 0) {
        const stemNode = ownStem(current);
        const subjects = direct(current, subjectSelector).filter(el => /^question_\d+$/.test(el.id));
        const children = [...current.querySelectorAll('.question')].filter(child => child.parentElement?.closest('.question') === current);
        if (!stemNode || subjects.length !== 1 || (depth && children.length)) fail('题目或子题结构不完整，请等待加载完成后重试。');
        const subject = subjects[0];
        const typeLabel = (direct(current, '.exam_question_stem .score')[0]?.textContent || '').replace(/[\[\]［］]/g, '').replace(/\s*[\d.]+\s*分\s*$/, '').trim();
        const type = classify(subject, typeLabel, children);
        const stem = richText(stemNode, resources);
        const question = { id: subject.id, type, stem, options: [] };
        if (typeLabel) question.typeLabel = typeLabel;
        if (type === 'open') warnings.push(`“${typeLabel}”将按通用文字题解析，此题型尚未专项验证。`);
        if (type === 'attachment') warnings.push('附件题仅生成可复制正文，不生成或上传文件；引用材料需完整提供。');
        if (['single', 'multiple', 'judgment'].includes(type)) {
          const labels = [...subject.querySelectorAll(type === 'multiple' ? 'label.ant-checkbox-wrapper' : 'label.ant-radio-wrapper')].filter(el => el.closest('.question') === current);
          question.options = labels.map((label, i) => {
            const textNode = label.querySelector('.xy_rich_text_base');
            let sequence = label.querySelector('.exam_answer_item_sequence')?.textContent.trim().replace(/[.．、]$/, '');
            // Judgment controls often show only 对/错, without A/B markers.
            if (type === 'judgment' && !sequence) sequence = String.fromCharCode(65 + i);
            if (!textNode && type !== 'judgment') fail('选项文字或图片读取不完整。');
            return { label: sequence, text: richText(textNode || label, resources) };
          });
        }
        if (type === 'fill') {
          const markers = [...stemNode.querySelectorAll('.xy_richtext_blank_number_warp')].map(el => el.textContent.match(/\d+/)?.[0]);
          const labels = [...subject.querySelectorAll('._label')].map(el => el.textContent.trim().match(/^填空\s*(\d+)\s*[:：]?$/)?.[1]);
          const numbers = labels.length ? labels : markers;
          if (!numbers.length || numbers.some((n, i) => Number(n) !== i + 1) || (markers.length && (markers.length !== numbers.length || markers.some((n, i) => Number(n) !== i + 1)))) fail('空位数量或编号不一致，未发送题目。');
          question.blankCount = numbers.length;
        }
        if (type === 'compound') question.parts = children.map(child => parse(child, depth + 1));
        return question;
      }
      const question = schema.validate(parse(node));
      return { question, resources, warning: warnings.join('\n') };
    } catch (error) { return { error: error.message }; }
  }
  function fingerprint(node) {
    const value = extract(node);
    return JSON.stringify({ ...value, resources: value.resources?.map(({ kind, source }) => ({ kind, source })) });
  }
  root.XiaoyaAnswerDOM = { extract, fingerprint, richText };
  if (typeof module !== 'undefined') module.exports = root.XiaoyaAnswerDOM;
})(globalThis);
