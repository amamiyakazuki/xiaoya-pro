(function (root) {
  'use strict';
  const schema = root.XiaoyaQuestion;
  const dom = root.XiaoyaAnswerDOM;
  const { extract } = dom;
  if (root.__xiaoyaAnswerFloat) return;
  root.__xiaoyaAnswerFloat = true;
  const records = new Map();
  let route = location.href, available = false, revision = '', checking = false, lastCheck = 0, scheduled = false, alive = true;
  const send = async message => {
    try { return await chrome.runtime.sendMessage(message); }
    catch { return { ok: false, error: '扩展连接已失效，请刷新页面后重试。' }; }
  };
  function cancel(record) {
    record.stopProgress?.();
    if (!record.requestId) return;
    record.controller?.abort();
    void send({ type: 'ai:query-cancel', requestId: record.requestId });
    record.requestId = null;
  }
  function clear() {
    for (const record of records.values()) { cancel(record); record.host.remove(); }
    records.clear();
  }
  function fingerprint(node) { return dom.fingerprint(node); }
  function fileRows(block) { return [...block.querySelectorAll('.ant-table-tbody tr')]; }
  function rowFor(block, name) { return fileRows(block).find(row => (row.innerText || '').includes(name)); }
  function removeRow(block, name) {
    const link = rowFor(block, name)?.querySelector('a[title="删除"]');
    if (!link) return false;
    link.click();
    return true;
  }
  async function waitUpload(block, name, timeout = 20000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const row = rowFor(block, name);
      if (row) {
        const text = row.innerText || '';
        if (text.includes('上传成功')) return 'ok';
        if (/失败|错误/.test(text)) return 'failed';
      }
      await new Promise(resolve => setTimeout(resolve, 800));
    }
    return 'timeout';
  }
  // 附件题：定位本题的附件控件；不可用时返回原因。
  function uploadTarget(node) {
    const block = node.querySelector('.question_attach_subject') || node;
    const uploader = block.querySelector('.ant-upload');
    const input = block.querySelector('input[type=file]');
    if (!input || !uploader) return { error: '未找到附件上传控件，请手动上传。' };
    if (uploader.classList.contains('ant-upload-disabled')) return { error: '当前附件题不可上传（已截止或不在答题状态），未上传。' };
    return { block, input };
  }
  // 把一个文件写入附件控件并等待平台显示结果；同名的旧附件先删除。只附加、不提交。
  async function uploadOne(target, file) {
    removeRow(target.block, file.fileName);
    try {
      const data = new DataTransfer();
      data.items.add(new File([file.content], file.fileName, { type: 'text/plain' }));
      target.input.files = data.files;
      target.input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (error) { return { state: 'failed', message: error?.message || '浏览器拒绝写入文件' }; }
    return { state: await waitUpload(target.block, file.fileName) };
  }
  function mount(node) {
    const host = document.createElement('div');
    host.className = 'xiaoya-ai-float';
    // The platform's preview listens on the entire question, including descendants.
    for (const type of ['click', 'dblclick', 'pointerdown', 'mousedown', 'keydown', 'keyup', 'input', 'change']) {
      host.addEventListener(type, event => event.stopPropagation());
    }
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = ':host{display:block!important;margin:8px 0!important;text-align:left!important}*{box-sizing:border-box}section{font:14px/1.6 system-ui,sans-serif;color:#203343;max-width:560px}button{font:inherit;border:1px solid #b8d8d0;border-radius:18px;padding:5px 12px;background:#edf8f4;color:#14634f;cursor:pointer}button:focus-visible{outline:3px solid #4c9f8b;outline-offset:2px}button:disabled{opacity:.6;cursor:wait}.panel{margin-top:8px;border:1px solid #cfe1dc;border-radius:12px;padding:14px;background:#fff;box-shadow:0 4px 16px #173f3310}.note{font-size:12px;color:#64746e;margin:8px 0}p{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0}textarea{display:block;width:100%;min-height:70px;resize:vertical;font:inherit;border:1px solid #b8ccc5;border-radius:8px;padding:8px;background:#fff;color:#203343}label{display:block;font-size:13px;margin:10px 0}.actions{display:flex;gap:8px}[hidden]{display:none!important}.steps{display:flex;flex-wrap:wrap;gap:4px 6px;margin:8px 0 2px;padding:0;list-style:none;font-size:12px;color:#8a9a94}.steps li{display:flex;align-items:center;gap:4px}.steps li+li::before{content:"›";color:#c3d1cc;margin-right:2px}.steps li.done{color:#2f7d67}.steps li.active{color:#14634f;font-weight:600}.steps li.active::after{content:"";width:6px;height:6px;border-radius:50%;background:#2f9a7f;animation:pulse 1s ease-in-out infinite}.steps li.failed{color:#b4453a;font-weight:600}@keyframes pulse{50%{opacity:.25}}.live{max-height:200px;overflow:auto;margin:8px 0;padding:8px 10px;border-radius:8px;background:#f5faf8;border:1px solid #e0ece8;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;color:#2c4a42}@media (prefers-reduced-motion:reduce){.steps li.active::after{animation:none}}button.primary{background:#14634f;border-color:#14634f;color:#fff}button.primary:disabled{cursor:not-allowed}.intro{margin:8px 0;padding:10px 12px;border:1px solid #f0dcb4;border-radius:10px;background:#fffaf0;color:#5c4513;font-size:13px}.intro p{margin:0 0 4px}.intro ul{margin:4px 0;padding-left:18px}.intro li{margin:2px 0}.intro .tip{margin-top:6px;color:#8a5a12}.files{list-style:none;margin:8px 0;padding:0;border:1px solid #dfeae6;border-radius:10px;overflow:hidden}.file+.file{border-top:1px solid #e8f0ed}.file.open{background:#f8fbfa}.file-row{display:flex;align-items:center;gap:8px;padding:7px 10px}.file-name{border:0;background:none;padding:0;border-radius:0;color:#14634f;font:600 13px ui-monospace,Menlo,Consolas,monospace;text-decoration:underline;text-underline-offset:3px}.meta{margin-right:auto;font-size:12px;color:#7a8a84}.link{border:0;background:none;padding:2px 6px;border-radius:6px;font-size:12px;color:#7a8a84}.link:hover{color:#b4453a;background:#fbeeec}.editor{padding:0 10px 10px}.editor label{margin:2px 0 4px;font-size:12px;color:#5d6f69}.editor input{display:block;width:100%;margin-top:2px;padding:4px 8px;border:1px solid #b8ccc5;border-radius:6px;font:13px ui-monospace,Menlo,Consolas,monospace;color:#203343}textarea.code{min-height:220px;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre;overflow:auto;tab-size:4}.saved{font-size:12px;color:#2f7d67}.invalid{margin:4px 0;font-size:12px;color:#b4453a}label.check{display:flex;align-items:flex-start;gap:6px;margin:10px 0 6px;font-size:13px}label.check input{margin-top:3px}.results{list-style:none;margin:6px 0;padding:0;font-size:13px}.results .ok{color:#2f7d67}.results .bad{color:#b4453a}.results .wait{color:#64746e}button:disabled.file-name,button:disabled.link{opacity:.5;cursor:default}';
    const section = document.createElement('section');
    const button = document.createElement('button'); button.type = 'button'; button.textContent = '✦ AI 答案'; button.setAttribute('aria-expanded', 'false');
    const recognized = extract(node).question;
    const badge = document.createElement('span'); badge.className = 'note';
    badge.textContent = recognized ? ` 已识别：${recognized.typeLabel || ({single:'单选题',multiple:'多选题',short:'简答题',attachment:'附件题',fill:'填空题',judgment:'判断题',compound:'组合题'}[recognized.type] || '文字题')}${recognized.type === 'fill' ? ` · ${recognized.blankCount} 空` : ''}` : ' 题目结构待检查';
    const panel = document.createElement('div'); panel.className = 'panel'; panel.hidden = true;
    const title = document.createElement('strong'); title.textContent = 'AI 参考答案';
    const steps = document.createElement('ol'); steps.className = 'steps'; steps.hidden = true; steps.setAttribute('aria-hidden', 'true');
    const status = document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    // 生成中的答案正文实时预览；完成后由正式答案取代，失败时保留已收到的部分。
    const live = document.createElement('pre'); live.className = 'live'; live.hidden = true;
    const explanation = document.createElement('p');
    const note = document.createElement('p'); note.className = 'note'; note.textContent = '点击后将本题题干、选项、图片及补充要求发送给你配置的 AI 服务。图片需模型支持识图；答案请自行核对。';
    const isAttachment = recognized?.type === 'attachment';
    const requirementsLabel = document.createElement('label'); requirementsLabel.textContent = isAttachment ? '具体需求（必填）' : '本题补充要求（可选）';
    const requirements = document.createElement('textarea'); requirements.maxLength = 2000;
    requirements.placeholder = isAttachment ? '例如：2 个 .py 文件。main.py 读取 data.csv 并输出统计结果，utils.py 放工具函数；只用 Python 标准库。' : '例如：100 字以内，分三点。修改后点击重新生成。';
    requirementsLabel.append(requirements);
    // 附件题：先说明并要求写清需求，生成后审阅、修改，再确认上传。
    const intro = document.createElement('div'); intro.className = 'intro'; intro.hidden = true;
    const review = document.createElement('div'); review.className = 'review'; review.hidden = true;
    const go = document.createElement('button'); go.type = 'button'; go.className = 'primary'; go.textContent = '确认需求，开始生成'; go.hidden = true;
    if (isAttachment) {
      title.textContent = 'AI 生成附件';
      const lead = document.createElement('p'); lead.textContent = '附件题比较特殊，生成前请先确认需求：';
      const list = document.createElement('ul');
      for (const text of ['在下方写清具体需求：需要几个文件、什么类型（例如「2 个 .py 文件」）、文件名，以及用到的语言或库。',
        '生成完成后会先给你查看，可以点开每个文件修改，修改即时保存。', '你确认无误后才会上传到本题附件；只上传，不会提交作业。']) {
        const item = document.createElement('li'); item.textContent = text; list.append(item);
      }
      const tip = document.createElement('p'); tip.className = 'tip'; tip.textContent = '建议附件题尽量自己完成并上传；AI 生成的内容请务必核对。';
      intro.append(lead, list, tip);
      note.textContent = '生成时会把本题题干、图片和你的需求发送给你配置的 AI 服务。';
    }
    const warning = document.createElement('p'); warning.className = 'note'; warning.textContent = extract(node).warning || '';
    const actions = document.createElement('div'); actions.className = 'actions';
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重新生成'; retry.hidden = true;
    const stop = document.createElement('button'); stop.type = 'button'; stop.textContent = '取消请求'; stop.hidden = true;
    actions.append(go, retry, stop); panel.append(title, intro, steps, status, live, review, explanation, warning, note, requirementsLabel, actions); section.append(button, badge, panel); shadow.append(style, section);
    const record = { host, fingerprint: fingerprint(node), requestId: null, loaded: false };
    records.set(node, record);
    // Outside the stem and answer containers: extraction never includes our UI.
    node.append(host);
    const current = () => alive && records.get(node) === record && node.isConnected && location.href === route && fingerprint(node) === record.fingerprint;
    async function query() {
      if (record.requestId || !current()) return;
      const extracted = extract(node);
      if (extracted.error) {
        status.textContent = extracted.error; requirementsLabel.hidden = true;
        note.textContent = '当前题目未发送给 AI，需后续适配该题型或内容。';
        record.loaded = true; return;
      }
      const id = crypto.randomUUID(); record.requestId = id; record.controller = new AbortController();
      explanation.textContent = ''; live.textContent = ''; live.hidden = true; retry.hidden = true; stop.hidden = false; requirements.disabled = true;
      intro.hidden = true; go.hidden = true; review.hidden = true;
      const startRevision = revision;
      // 进度：本页先整理题目，之后由后台按阶段回报；每秒刷新用时，卡在哪一步一目了然。
      const started = Date.now();
      let stage = 'preparing', counts = { chars: 0, reasoning: 0 };
      const labels = { preparing: extracted.resources?.length ? '正在读取题目图片' : '正在整理题目', waiting: '已发送，等待 AI 服务响应',
        responding: '服务已响应，等待输出', thinking: '模型思考中', writing: '正在生成答案', parsing: '生成完成，正在整理答案' };
      const order = [['preparing', '整理题目'], ['waiting', '等待响应'], ['thinking', '思考'], ['writing', '生成'], ['parsing', '整理答案']];
      const position = key => ({ preparing: 0, waiting: 1, responding: 2, thinking: 2, writing: 3, parsing: 4 })[key];
      const seconds = () => Math.floor((Date.now() - started) / 1000);
      const draw = (failed = false) => {
        const at = position(stage);
        steps.textContent = '';
        steps.append(...order.map(([, text], index) => {
          const item = document.createElement('li'); item.textContent = text;
          item.className = index < at ? 'done' : index === at ? (failed ? 'failed' : 'active') : '';
          return item;
        }));
      };
      const render = () => {
        const extra = stage === 'thinking' ? ` · 已思考 ${counts.reasoning} 字` : stage === 'writing' ? ` · 已收到 ${counts.chars} 字` : '';
        status.textContent = `${labels[stage]}…（${seconds()} 秒${extra}）`;
        draw();
      };
      steps.hidden = false; render();
      let ticker;
      const loop = () => { render(); ticker = setTimeout(loop, 1000); };
      ticker = setTimeout(loop, 1000);
      record.stopProgress = () => { clearTimeout(ticker); record.onProgress = null; record.stopProgress = null; };
      record.onProgress = message => {
        if (message.requestId !== id || !labels[message.stage]) return;
        stage = message.stage; counts = { chars: Number(message.chars) || 0, reasoning: Number(message.reasoning) || 0 };
        if (typeof message.preview === 'string' && message.preview) { live.hidden = false; live.textContent = message.preview; live.scrollTop = live.scrollHeight; }
        render();
      };
      let response, mediaTimer;
      try {
        mediaTimer = setTimeout(() => record.controller.abort(), 15000);
        const question = extracted.resources?.length ? await root.XiaoyaAnswerMedia.prepare(extracted, { signal: record.controller.signal }) : extracted.question;
        clearTimeout(mediaTimer);
        if (!current() || record.requestId !== id || record.controller.signal.aborted) return;
        response = await send({ type: 'ai:query', requestId: id, question, instructions: requirements.value, slow: question.type === 'attachment' });
      } catch (error) {
        response = { ok: false, error: record.controller.signal.aborted ? '图片读取已取消或超过 15 秒，请手动重试。' : error.message };
      } finally { clearTimeout(mediaTimer); }
      record.stopProgress?.();
      if (!current() || record.requestId !== id || revision !== startRevision) return;
      record.requestId = null; requirements.disabled = false; stop.hidden = true; retry.hidden = false; record.loaded = true;
      if (!response?.ok) {
        draw(true);
        status.textContent = `${response?.error || '查询失败，请重试。'}\n（停在「${labels[stage]}」，用时 ${seconds()} 秒${counts.chars ? `，已收到 ${counts.chars} 字` : ''}）`;
        if (isAttachment && record.files?.length) { review.hidden = false; renderReview(); }
        return;
      }
      if (response.revision !== revision) { status.textContent = 'AI 配置已变化，请重新查询。'; return; }
      steps.hidden = true; live.hidden = true;
      status.textContent = response.result.answer;
      explanation.textContent = `解释：${response.result.explanation}`;
      if (isAttachment && Array.isArray(response.result.files)) {
        record.files = response.result.files.map(file => ({ fileName: file.fileName, content: file.content }));
        record.open = record.files.length === 1 ? 0 : -1; record.results = null; record.confirmed = false;
        status.textContent = `${response.result.answer}。请查看、按需修改，核对后再确认上传。`;
        retry.textContent = '按需求重新生成（覆盖当前文件）';
        review.hidden = false; renderReview();
      }
    }
    // ---- 附件文件审阅：查看、修改（即时保存）、删除，确认后上传 ----
    const make = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; };
    const describe = file => `${file.content.split('\n').length - (file.content.endsWith('\n') ? 1 : 0)} 行 · ${file.content.length} 字`;
    function problems() {
      const files = record.files || [];
      if (!files.length) return '没有可上传的文件。';
      for (const file of files) {
        try { schema.fileName(file.fileName); } catch { return `文件名「${file.fileName || '（空）'}」无效：只能用字母、数字和 ._-，并带扩展名。`; }
        if (!file.content.trim()) return `${file.fileName} 的内容为空。`;
      }
      if (new Set(files.map(file => file.fileName.toLowerCase())).size !== files.length) return '有重复的文件名。';
      return '';
    }
    function renderReview() {
      const files = record.files || [];
      const locked = Boolean(record.uploading);
      review.textContent = '';
      const list = make('ul', 'files');
      files.forEach((file, index) => {
        const item = make('li', `file${record.open === index ? ' open' : ''}`);
        const row = make('div', 'file-row');
        const name = make('button', 'file-name', file.fileName); name.type = 'button'; name.disabled = locked;
        name.setAttribute('aria-expanded', String(record.open === index));
        const meta = make('span', 'meta', describe(file));
        const remove = make('button', 'link', '删除'); remove.type = 'button'; remove.disabled = locked;
        name.addEventListener('click', event => { if (!event.isTrusted) return; record.open = record.open === index ? -1 : index; renderReview(); });
        remove.addEventListener('click', event => {
          if (!event.isTrusted) return;
          files.splice(index, 1); record.open = -1; record.confirmed = false; renderReview();
        });
        row.append(name, meta, remove); item.append(row);
        if (record.open === index) {
          const editor = make('div', 'editor');
          const nameLabel = make('label', '', '文件名'); const nameInput = document.createElement('input');
          nameInput.value = file.fileName; nameInput.maxLength = 80; nameInput.spellcheck = false; nameInput.disabled = locked; nameLabel.append(nameInput);
          const contentLabel = make('label', '', '内容'); const content = make('textarea', 'code');
          content.value = file.content; content.spellcheck = false; content.setAttribute('wrap', 'off'); content.disabled = locked;
          const saved = make('span', 'saved', '修改即时保存');
          // 修改直接写回文件数据，不需要另外点保存。
          nameInput.addEventListener('input', () => { file.fileName = nameInput.value.trim(); name.textContent = file.fileName || '（未命名）'; saved.textContent = '已保存'; updateUpload(); });
          content.addEventListener('input', () => { file.content = content.value; meta.textContent = describe(file); saved.textContent = '已保存'; updateUpload(); });
          editor.append(nameLabel, contentLabel, content, saved); contentLabel.append(content);
          item.append(editor);
        }
        list.append(item);
      });
      const head = make('p', 'note', files.length ? `共 ${files.length} 个文件，点文件名查看或修改。` : '文件已全部删除，可以重新生成。');
      const invalid = make('p', 'invalid');
      const confirmLabel = make('label', 'check'); const confirm = document.createElement('input'); confirm.type = 'checkbox';
      confirm.checked = Boolean(record.confirmed); confirm.disabled = locked;
      confirmLabel.append(confirm, document.createTextNode('我已查看并核对以上文件，确认上传到本题附件（不会提交作业）'));
      confirm.addEventListener('change', () => { record.confirmed = confirm.checked; updateUpload(); });
      const upload = make('button', 'primary'); upload.type = 'button';
      upload.addEventListener('click', event => { if (event.isTrusted) void uploadAll(); });
      const results = make('ul', 'results');
      for (const result of record.results || []) {
        const label = { wait: '等待上传', uploading: '正在上传…', ok: '上传成功', failed: '上传失败', timeout: '未确认上传结果' }[result.state] || result.state;
        results.append(make('li', result.state === 'ok' ? 'ok' : ['failed', 'timeout'].includes(result.state) ? 'bad' : 'wait',
          `${result.fileName}：${label}${result.message ? `（${result.message}）` : ''}`));
      }
      review.append(head, list, invalid, confirmLabel, upload, results);
      function updateUpload() {
        const problem = problems();
        invalid.textContent = problem && files.length ? problem : '';
        upload.textContent = locked ? '正在上传…' : `确认上传 ${files.length} 个文件`;
        upload.disabled = locked || Boolean(problem) || !confirm.checked;
      }
      updateUpload();
    }
    async function uploadAll() {
      if (record.uploading || problems() || !record.confirmed || !current()) return;
      const target = uploadTarget(node);
      if (target.error) { status.textContent = target.error; return; }
      const files = record.files.map(file => ({ ...file }));
      record.uploading = true; record.open = -1; retry.disabled = true; requirements.disabled = true;
      record.results = files.map(file => ({ fileName: file.fileName, state: 'wait' }));
      renderReview();
      for (const [index, file] of files.entries()) {
        if (!current()) break;
        record.results[index].state = 'uploading'; renderReview();
        const result = await uploadOne(target, file);
        record.results[index] = { fileName: file.fileName, ...result }; renderReview();
      }
      record.uploading = false; retry.disabled = false; requirements.disabled = false; record.confirmed = false;
      const done = record.results.filter(result => result.state === 'ok').length;
      status.textContent = `已上传 ${done}/${files.length} 个文件（未提交作业；可在本题附件列表删除）。${done < files.length ? '未成功的可以修改后重新确认上传。' : ''}`;
      renderReview();
    }
    button.addEventListener('click', event => {
      if (!event.isTrusted) return;
      panel.hidden = !panel.hidden; button.setAttribute('aria-expanded', String(!panel.hidden));
      if (panel.hidden || record.loaded) return;
      if (isAttachment) {
        record.loaded = true; intro.hidden = false; go.hidden = false; status.textContent = '';
        requirements.focus?.();
        return;
      }
      void query();
    });
    go.addEventListener('click', event => {
      if (!event.isTrusted) return;
      if (requirements.value.trim().length < 4) {
        status.textContent = '请先在下方写清需求：需要几个文件、什么类型（例如「2 个 .py 文件」）。';
        requirements.focus?.(); return;
      }
      void query();
    });
    retry.addEventListener('click', event => { if (event.isTrusted) void query(); });
    stop.addEventListener('click', event => {
      if (!event.isTrusted) return;
      record.stopProgress?.(); steps.hidden = true;
      cancel(record); requirements.disabled = false; status.textContent = '请求已取消，服务商可能已接收并计费。'; stop.hidden = true; retry.hidden = false; record.loaded = true;
      if (isAttachment && record.files?.length) { review.hidden = false; renderReview(); }
    });
  }
  async function check() {
    if (checking || !alive) return;
    checking = true; lastCheck = Date.now();
    const response = await send({ type: 'ai:available' });
    checking = false;
    if (!alive) return;
    if (revision !== response?.revision || available !== Boolean(response?.ok && response.available)) clear();
    revision = response?.revision || ''; available = Boolean(response?.ok && response.available);
    scan();
  }
  function scan() {
    if (!alive) return;
    if (route !== location.href) { clear(); route = location.href; lastCheck = 0; available = false; }
    if (!schema.isPage(location.href)) { clear(); return; }
    const nodes = [...document.querySelectorAll('#question_content .question')].filter(node => !node.parentElement?.closest('.question'));
    for (const [node, record] of records) {
      if (!nodes.includes(node) || !record.host.isConnected || fingerprint(node) !== record.fingerprint) { cancel(record); record.host.remove(); records.delete(node); }
    }
    if (nodes.length && Date.now() - lastCheck > 10000) void check();
    if (available) for (const node of nodes) if (!records.has(node)) mount(node);
  }
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true; setTimeout(() => { scheduled = false; scan(); }, 150);
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['id', 'class', 'src', 'srcset', 'data-src', 'data-tex', 'data-latex'] });
  let interval = setInterval(scan, 1500);
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'ai:changed') { clear(); available = false; lastCheck = 0; if (schema.isPage(location.href)) void check(); }
    if (message?.type === 'ai:progress') for (const record of records.values()) if (record.requestId === message.requestId) record.onProgress?.(message);
  });
  addEventListener('pagehide', () => { alive = false; clear(); clearInterval(interval); observer.disconnect(); });
  addEventListener('pageshow', event => {
    if (!event.persisted) return;
    alive = true; available = false; lastCheck = 0;
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['id', 'class', 'src', 'srcset', 'data-src', 'data-tex', 'data-latex'] });
    interval = setInterval(scan, 1500); scan();
  });
  scan();
})(globalThis);
