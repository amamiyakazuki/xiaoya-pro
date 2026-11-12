(function (root) {
  'use strict';
  const KEY = 'xiaoyaAnswerBatch';
  const ORIGIN = 'https://whut.ai-augmented.com';
  const id = value => typeof value === 'string' && /^\d+$/.test(value);
  function eligible(task) {
    return Boolean(task && [2, 3, 4].includes(task.typeCode) && !task.finished && id(String(task.courseId || '')) && id(String(task.nodeId || '')) && (!task.taskId || id(String(task.taskId))));
  }
  function canonical(task) {
    if (!eligible(task)) throw Error('任务类型或身份不完整，不能开始。');
    return { id: String(task.id), courseId: String(task.courseId), nodeId: String(task.nodeId), taskId: task.taskId ? String(task.taskId) : null,
      name: String(task.name || '未命名任务').slice(0, 300), courseName: String(task.courseName || '未命名课程').slice(0, 200), typeCode: task.typeCode,
      url: `${ORIGIN}/app/jx-web/mycourse/${task.courseId}/resource/_/${task.nodeId}` };
  }
  function matches(url, task) {
    try {
      const u = new URL(url); if (u.origin !== ORIGIN) return false;
      const path = u.pathname.split('/').filter(Boolean);
      return path[0] === 'app' && path[1] === 'jx-web' && (
        path[2] === 'mycourse' && path[3] === task.courseId && path[4] === 'resource' && path.length === 7 && path[6] === task.nodeId ||
        path[2] === 'course_paper' && path[3] === 'mycourse' && path.length === 8 && path[4] === task.courseId && path[5] === task.nodeId);
    } catch { return false; }
  }
  function selection(tasks, selected, account, previousAccount) {
    if (account !== previousAccount) return [];
    return [...new Set(selected)].filter(key => tasks.some(task => task.id === key && eligible(task)));
  }
  function questionLabel(item, index) {
    const number = Number.isSafeInteger(item.number) && item.number > 0 ? item.number : index + 1;
    return `第 ${number} 题${item.numberSource === 'order' ? '（页面顺序）' : ''}`;
  }
  function questionProblems(questions) {
    return questions.map((item, index) => {
      if (item.state !== 'unknown' && (item.state === 'done' || item.writable)) return '';
      return `${questionLabel(item, index)}（${item.typeName || '题型未识别'}）：${item.reason || '无法确认作答状态或填写方式'}`;
    }).filter(Boolean).join('\n');
  }
  function createEngine({ storage, driver, getAccount, query, aiReady = async () => true, now = Date.now, uuid = () => crypto.randomUUID() }) {
    let state = null, job = null, reserved = false, epoch = 0, writes = Promise.resolve();
    const save = () => {
      const snapshot = structuredClone(state);
      const result = writes.then(() => storage.set({ [KEY]: snapshot }));
      writes = result.catch(() => {}); return result;
    };
    function noteInterruptedFill() {
      if (state.stage !== 'filling' || state.results?.[state.index]?.status !== 'waiting') return;
      state.results[state.index] = { status: 'pending', message: '填写已中断，可能已写入部分答案。请在原答题页核对。', at: now() };
    }
    const ready = (async () => {
      state = (await storage.get(KEY))[KEY] || null;
      if (state?.enabled) {
        noteInterruptedFill();
        state.enabled = false;
        state.stage = state.inFlight ? 'uncertain' : 'paused';
        state.message = state.inFlight ? '后台中断，提交结果待核对；不会自动重交。' : '后台中断，批次已暂停；请重新核对清单后开始。';
        await save();
      }
    })();
    const current = run => job === run && !run.controller.signal.aborted && state?.enabled;
    const guard = run => { if (!current(run)) throw Error('已停止'); };
    async function identity(run) {
      guard(run);
      try { const account = await getAccount(); guard(run); if (account !== state.account) throw Error('小雅账号已变化，请重新选择任务。'); }
      catch (error) { error.fatal = true; throw error; }
    }
    async function stage(run, value, message) { guard(run); state.stage = value; state.message = message; await save(); guard(run); }
    async function blockBeforeSubmit(run, reason) {
      const stopped = !current(run);
      state.inFlight = false;
      state.enabled = false;
      state.stage = stopped ? 'stopped' : 'paused';
      state.message = stopped ? '已停止，未点击交卷。' : `提交前检查未通过，批次已暂停：${reason}`;
      state.results[state.index] = { status: 'pending', message: reason, at: now() };
      await save();
    }
    async function resolveSubmission(run, task) {
      let submitted = false, problem = '';
      try { submitted = await driver.verify(task); } catch (error) { problem = error.message || '核对提交时发生异常。'; }
      if (job !== run) return false;
      state.inFlight = false;
      if (submitted) {
        state.results[state.index] = { status: 'done', message: '平台已确认提交', at: now() };
        state.index += 1;
        if (!current(run)) { state.enabled = false; state.stage = 'stopped'; state.message = '已停止；在途提交已核对成功。'; }
        await save(); return true;
      }
      state.enabled = false; state.inFlight = true; state.stage = 'uncertain'; state.message = problem ? `批次已暂停：${problem} 请在原页面处理后核对提交结果，不会自动重交。` : '提交结果不明，批次已暂停。请在平台核对后点击“核对提交结果”，不会自动重交。';
      state.results[state.index] = { status: 'uncertain', message: problem || '提交结果待核对', at: now() }; await save(); return false;
    }
    async function execute(run) {
      try {
        while (current(run) && state.index < state.tasks.length) {
          const task = state.tasks[state.index];
          let mayHaveWritten = false;
          try {
            await identity(run);
            await stage(run, 'opening', `正在打开：${task.name}`);
            let snapshot = await driver.open(task, run.controller.signal); guard(run);
            if (snapshot.submitted) { state.results[state.index++] = { status: 'done', message: '平台已提交，跳过', at: now() }; await save(); continue; }
            if (snapshot.canEnter || snapshot.canBegin) {
              await stage(run, 'entering', `正在进入：${task.name}`);
              snapshot = await driver.enter(task, run.controller.signal); guard(run);
            }
            if (snapshot.submitted) { state.results[state.index++] = { status: 'done', message: '平台已提交，跳过', at: now() }; await save(); continue; }
            if (!snapshot.complete || !snapshot.questions.length) throw Error(snapshot.reason || '未读取到完整试卷，整份未提交。');
            const attachments = new Set(snapshot.questions.filter(item => item.question?.type === 'attachment').map(item => item.question.id));
            const problems = questionProblems(snapshot.questions);
            if (questionProblems(snapshot.questions.filter(item => !attachments.has(item.question?.id)))) throw Error(`整份未提交。\n${problems}`);
            const solutions = [];
            for (const [index, item] of snapshot.questions.entries()) {
              if (item.state === 'done' || attachments.has(item.question?.id)) continue;
              const label = questionLabel(item, index);
              await stage(run, 'querying', `正在查询${label}：${task.name}`);
              let answer;
              try { answer = await query(item.question, run.controller.signal); }
              catch (error) { throw Error(`${label}：${error?.message || 'AI 查询失败，请手动核对。'}`); }
              guard(run);
              if (!answer?.solution) throw Error(`${label}：AI 未返回可填写的结构化答案。`);
              solutions.push({ id: item.question.id, fingerprint: item.fingerprint, solution: answer.solution });
            }
            await identity(run);
            await stage(run, 'filling', `正在补齐空题：${task.name}`);
            const latest = await driver.inspect(task); guard(run);
            if (!latest.complete || latest.fingerprint !== snapshot.fingerprint) throw Error('题目或选项发生变化，整份未提交。');
            for (const solution of solutions) {
              guard(run);
              const result = await driver.fill(task, solution, run.controller.signal);
              mayHaveWritten ||= !result?.preserved;
              guard(run);
            }
            const filled = await driver.inspect(task); guard(run);
            if (!filled.complete || filled.fingerprint !== snapshot.fingerprint || filled.questions.some(q => !attachments.has(q.question?.id) && q.state !== 'done')) throw Error('填写后未确认应答题目全部已答，整份未提交；请在原答题页核对草稿。');
            await identity(run);
            if (attachments.size) {
              const skipped = snapshot.questions.map((item, index) => attachments.has(item.question?.id) ? questionLabel(item, index) : '').filter(Boolean).join('、');
              const answered = filled.questions.length - attachments.size;
              state.results[state.index++] = { status: 'draft', message: `已跳过附件题：${skipped}。\n${answered ? `页面已确认其余 ${answered} 题已答，已有答案保留。` : '本份仅含附件题，未填写。'}\n未提交，可稍后补附件。`, draftPage: driver.draftReference?.() || null, at: now() };
              await save();
              continue;
            }
            await stage(run, 'submitting', `正在提交：${task.name}`);
            state.inFlight = true; await save();
            if (!current(run)) { await blockBeforeSubmit(run, '提交指令发出前已停止。'); return; }
            let result;
            try {
              result = await driver.submit(task, filled.fingerprint, run.controller.signal);
            } catch { /* A lost acknowledgement is not permission to retry. */ }
            if (result?.blocked) { await blockBeforeSubmit(run, result.reason); return; }
            if (job !== run) return;
            if (!await resolveSubmission(run, task)) return;
          } catch (error) {
            if (state?.inFlight) { await resolveSubmission(run, task); return; }
            if (!current(run)) break;
            if (error.fatal || (state.stage === 'filling' && mayHaveWritten)) {
              noteInterruptedFill(); state.enabled = false; state.stage = 'paused'; state.message = error.message; await save(); break;
            }
            state.results[state.index++] = { status: 'pending', message: error.message || '该任务需要人工处理', at: now() }; await save();
          }
        }
        if (current(run)) { state.enabled = false; state.stage = 'finished'; state.message = '本批处理结束，请查看逐份结果。'; await save(); }
      } catch {
        if (state && job === run) { state.enabled = false; state.stage = state.inFlight ? 'uncertain' : 'paused'; state.message = '执行中断，已停止后续操作，请核对当前任务。'; await save().catch(() => {}); }
      } finally { if (job === run) job = null; }
    }
    async function start(input) {
      if (reserved || job) throw Error('已有批次正在处理。'); reserved = true; const ticket = epoch;
      try {
        await ready;
        if (state?.inFlight) throw Error('上一份提交结果待核对，不能开始新批次。');
        if (!await aiReady()) throw Error('请先保存可用的 AI 配置并授权服务域名。');
        if (!input?.account || await getAccount() !== input.account) throw Error('账号已变化，请刷新并重新选择。');
        if (!Array.isArray(input.tasks) || !input.tasks.length || input.tasks.length > 200) throw Error('请选择 1–200 份任务。');
        const tasks = input.tasks.map(canonical);
        if (new Set(tasks.map(t => `${t.courseId}:${t.nodeId}`)).size !== tasks.length) throw Error('清单包含重复任务。');
        if (ticket !== epoch) throw Error('启动已取消。');
        const run = { controller: new AbortController() }; job = run;
        state = { id: uuid(), account: input.account, tasks, results: tasks.map(() => ({ status: 'waiting', message: '等待处理' })), index: 0, enabled: true, inFlight: false, stage: 'starting', message: '正在准备执行', created: now() };
        try { await save(); } catch (error) { run.controller.abort(); job = null; state.enabled = false; throw error; }
        if (ticket !== epoch) { run.controller.abort(); job = null; state.enabled = false; await save(); throw Error('启动已取消。'); }
        void execute(run); return { ok: true, batch: structuredClone(state) };
      } finally { reserved = false; }
    }
    async function stop() {
      epoch += 1; job?.controller.abort(); driver.halt?.(); await ready;
      if (state?.enabled) { noteInterruptedFill(); state.enabled = false; state.stage = state.inFlight ? 'uncertain' : 'stopped'; state.message = state.inFlight ? '已停止后续动作，正在核对在途提交。' : '已停止，不再启动新操作。请在原答题页核对已有答案。'; await save(); }
      return { ok: true };
    }
    async function permit(action) {
      await ready;
      const run = job; if (!run || !current(run) || action.batchId !== state.id || action.taskId !== state.tasks[state.index]?.id) return false;
      const allowed = { enter: ['entering'], fill: ['filling'], submit: ['submitting'], confirm: ['submitting'] };
      if (!allowed[action.action]?.includes(state.stage)) return false;
      try { await identity(run); return current(run) && allowed[action.action].includes(state.stage); } catch { await stop(); return false; }
    }
    async function verify() {
      await ready; if (!state?.inFlight || job || reserved) throw Error('当前没有可手动核对的提交结果，或仍在处理中。');
      reserved = true;
      try {
      if (await getAccount() !== state.account) throw Error('请切回该批次的小雅账号再核对。');
      const confirmed = await driver.recheck(state.tasks[state.index]);
      if (await getAccount() !== state.account) throw Error('核对期间账号发生变化，请切回原账号再核对。');
      if (confirmed) {
        state.results[state.index++] = { status: 'done', message: '已核对平台提交成功', at: now() }; state.inFlight = false;
        const finished = state.index >= state.tasks.length;
        state.stage = finished ? 'finished' : 'paused';
        state.message = finished ? '本批提交结果已全部核对，请查看逐份结果。' : '已核对成功。其余任务请重新选择确认后执行。'; await save();
      }
      return { ok: true, confirmed };
      } finally { reserved = false; }
    }
    return { start, stop, permit, verify, get: async () => { await ready; return structuredClone(state); }, busy: () => reserved || Boolean(job) || Boolean(state?.enabled), getTask: () => state?.tasks[state.index], getId: () => state?.id };
  }
  root.XiaoyaAnswerBatch = { KEY, eligible, canonical, matches, selection, questionProblems, createEngine };
  if (typeof module !== 'undefined') module.exports = root.XiaoyaAnswerBatch;
})(globalThis);
