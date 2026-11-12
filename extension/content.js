(() => {
  'use strict';
  const protocol = 6;
  if (globalThis.__xiaoyaContentProtocol === protocol) return;
  globalThis.__xiaoyaContentProtocol = protocol;
  let run = null;
  let busy = false;
  let lastUrl = '';
  let arrived = Date.now();
  let lastAttempt = 0;
  let transition = null;
  let lastPlay = 0;
  let lastStatus = '';
  let taskTiming = null;
  let timingProbeAt = 0;
  let homeSignature = '';
  let homeStableSince = 0;
  let homeActionAt = 0;
  let selectedHalted = false;
  let selectedBackground = false;
  let selectedVideo = null;
  let selectedAggressiveAttempt = null;
  const selectedAggressiveAckTimeout = 15000;
  const homePath = '/app/jx-web/mycourse';
  const supported = /\.(mp4|webm|m4v|mov|pptx?|pdf|docx?)$/i;
  const route = () => {
    const match = location.pathname.match(/\/mycourse\/([^/]+)\/resource\/([^/]+)(?:\/([^/]+))?\/?$/);
    return match ? { course: match[1], folder: match[2], file: match[3] || null } : null;
  };
  const background = enabled => window.dispatchEvent(new CustomEvent('xiaoya-helper-background', { detail: enabled }));
  const normalizeName = value => (value || '').normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  // Use platform IDs when a task exposes a real resource link. Names alone
  // cannot distinguish two resources with the same filename.
  function resourceTarget(link) {
    const href = link?.getAttribute?.('href');
    if (!href) return null;
    try {
      const url = new URL(href, location.href);
      if (url.origin !== location.origin) return null;
      const match = url.pathname.match(/^\/app\/jx-web\/mycourse\/([^/]+)\/resource\/([^/]+)\/([^/]+)\/?$/);
      return match ? { course: match[1], file: match[3] } : null;
    } catch { return null; }
  }
  function waitForPage(now, text) {
    if (now - arrived < 30000) { log(`等待页面加载：${text}`); return; }
    stop(`页面加载超时：${text}，已暂停，请检查页面或网络后重新开始。`);
  }
  function resourceName() {
    const heading = document.querySelector('h5.title');
    const candidates = [
      heading?.getAttribute('title'),
      heading?.textContent,
      document.querySelector('.group-resource-node.node-selected .node-inner')?.textContent,
      document.title.split(' | ')[0]
    ].map(value => value?.trim()).filter(Boolean);
    // The platform truncates long heading text and puts the full filename in
    // title. Short headings may have no attribute at all. Only accept a full
    // supported filename; never match an ellipsis by a loose prefix.
    return candidates.find(value => supported.test(normalizeName(value))) || candidates[0] || '';
  }
  const save = () => chrome.runtime.sendMessage({ type: 'save', run }).catch(() => {});
  function log(text) {
    if (!run || text === lastStatus) return;
    lastStatus = text;
    run.status = text;
    run.logs = [...run.logs.slice(-39), { time: Date.now(), text }];
    void save();
  }
  function clearSelectedEffects() {
    if (selectedBackground) background(false);
    selectedBackground = false;
    selectedVideo?.pause();
    selectedVideo = null;
  }
  function stop(text) {
    run.enabled = false;
    if (run.mode === 'selected') clearSelectedEffects();
    else {
      background(false);
      document.querySelectorAll('video').forEach(video => video.pause());
    }
    if (text === lastStatus) void save();
    else log(text);
  }

  function matchesSelectedName(name, expectedName) {
    const actual = normalizeName(name), expected = normalizeName(expectedName);
    return supported.test(actual) && (actual === expected || (!supported.test(expected) && actual.replace(supported, '') === expected));
  }

  async function completeSelected(active) {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'selected-advance', runId: active.id, index: active.selectionIndex });
      if (run !== active || !active.enabled) return;
      if (!result?.ok) return stop(result?.error || '无法确认所选任务的完成状态，队列已暂停。');
      active.enabled = false;
      clearSelectedEffects();
    } catch {
      if (run === active && active.enabled) stop('无法连接视频课件队列，已暂停。');
    }
  }
  function visibleElement(element) {
    if (!element || element.hidden === true || element.getAttribute?.('aria-hidden') === 'true') return false;
    if (typeof element.getClientRects === 'function' && element.getClientRects().length === 0) return false;
    const visibility = window.getComputedStyle?.(element).visibility;
    return visibility !== 'hidden' && visibility !== 'collapse';
  }
  function hasVisibleDialog() {
    return [...document.querySelectorAll('.ant-modal, dialog[open], [role="dialog"][aria-modal="true"]')]
      .some(visibleElement);
  }
  function tryAggressiveSelectedCompletion(active, now) {
    const attempt = selectedAggressiveAttempt;
    if (attempt?.runId === active.id && attempt.index === active.selectionIndex) {
      if (now - attempt.at >= selectedAggressiveAckTimeout) {
        return stop('平台尚未确认完成，队列已暂停，请核对当前页面。');
      }
      return log('已请求平台完成，等待页面确认；未确认前不会切换。');
    }

    const controls = [...document.querySelectorAll('.ta_icon_btn')].filter(element =>
      element.textContent.trim() === '点我完成任务'
      && visibleElement(element)
      && element.disabled !== true
      && element.getAttribute?.('aria-disabled') !== 'true'
      && !element.closest?.('[inert], [aria-hidden="true"], [aria-disabled="true"]')
      && !element.classList?.contains('disabled')
      && !element.classList?.contains('is-disabled'));
    if (controls.length !== 1 || hasVisibleDialog()) return waitForPage(now, '平台完成按钮尚未显示或暂不可用');

    selectedAggressiveAttempt = { runId: active.id, index: active.selectionIndex, at: now };
    controls[0].click();
    log('已请求平台完成，等待页面确认；未确认前不会切换。');
  }
  function rows() {
    return [...document.querySelectorAll('.group-resource-node')].map(row => {
      const element = row.querySelector('.node-inner');
      const name = element?.textContent.trim();
      const folder = [...row.querySelectorAll('use')].some(icon =>
        (icon.getAttribute('xlink:href') || icon.getAttribute('href') || '').includes('resource-folder'));
      return { element, name, folder };
    }).filter(row => row.name);
  }
  function finished() {
    return !!document.querySelector('.ta_icon_btn .xy_btn_task_finish') ||
      [...document.querySelectorAll('.ta_icon_btn .btn_content')].some(e => /^已完成$/.test(e.textContent.trim()));
  }
  function openRow(row, folder) {
    transition = { url: location.href, at: Date.now() };
    row.element.click();
    if (folder) {
      row.element.click();
      row.element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
    }
  }
  async function readHome(now) {
    if (transition) {
      if (now - transition.at > 15000) stop('待办任务未成功打开，请检查页面后重新开始。');
      return;
    }
    const all = [...document.querySelectorAll('.ant-radio-wrapper')].find(e => e.textContent.trim() === '显示全部任务');
    const available = [...document.querySelectorAll('.ant-checkbox-wrapper')].find(e => e.textContent.trim() === '仅显示可完成任务');
    if (!all) {
      const entry = document.querySelector('[title="点击查看/刷新待完成学习任务"]');
      if (!entry) return waitForPage(now, '未识别到登录后的待办入口');
      if (!homeActionAt) { homeActionAt = now; entry.click(); log('正在打开首页待完成任务…'); }
      else if (now - homeActionAt > 15000) stop('首页待办列表未打开，请刷新后重试。');
      return;
    }
    if (!available) return waitForPage(now, '未识别到“仅显示可完成任务”筛选');
    if (!all.querySelector('input') || !available.querySelector('input')) return waitForPage(now, '任务筛选控件尚未就绪');
    if (!all.querySelector('input')?.checked) {
      if (now - arrived > 30000) return stop('“显示全部任务”筛选未生效，已暂停。');
      all.click(); homeStableSince = 0; return;
    }
    if (!available.querySelector('input')?.checked && now - arrived > 30000) return stop('“仅显示可完成任务”筛选未生效，已暂停。');
    if (!available.querySelector('input')?.checked) { available.click(); homeStableSince = 0; return; }
    const cards = [...document.querySelectorAll('.task_card .gutter-row')];
    const eligible = cards.filter(card => card.classList.contains('ta_watch')).map(card => {
      const link = card.querySelector('a.group-resource-link');
      const name = link?.textContent.trim();
      const course = card.querySelector('a.group_link')?.textContent.trim();
      const target = resourceTarget(link);
      return { link, name, course, target, key: target ? JSON.stringify([target.course, target.file]) : JSON.stringify([normalizeName(course), normalizeName(name)]) };
    }).filter(task => task.name && task.course && supported.test(normalizeName(task.name)));
    const signature = JSON.stringify(cards.map(card => card.textContent));
    if (now - arrived > 60000 && signature !== homeSignature) return stop('待办列表持续变化，无法稳定读取，已暂停，请检查网络后重试。');
    if (signature !== homeSignature || !homeStableSince) {
      homeSignature = signature; homeStableSince = now; return;
    }
    if (now - homeStableSince < 2000) return;
    if (!cards.length) {
      const empty = [...document.querySelectorAll('.ant-modal')].some(e => /暂无任务/.test(e.textContent));
      if (!empty) {
        if (now - arrived > 20000) stop('待办列表加载异常，未将未加载的任务视为零。');
        return;
      }
    }
    run.tasks = eligible.map(({ name, course, key }) => ({ name, course, key }));
    run.skippedTasks = cards.length - eligible.length;
    await save();
    if (run.scanOnly) return stop(`已获取 ${eligible.length} 项可处理待办，另有 ${run.skippedTasks} 项其他类型；点击“开始队列”运行。`);
    const pending = eligible.find(task => !run.homeFinished.includes(task.key));
    if (!pending) return stop(`首页待办队列结束，已确认 ${run.completed.length} 项；其他类型未处理。`);
    if (eligible.filter(task => task.key === pending.key).length !== 1) {
      return stop('发现同课程同名待办，无法唯一识别，请进入课程后处理。');
    }
    run.homeTask = { key: pending.key, name: pending.name, course: pending.course, target: pending.target };
    await save();
    log(`打开待办：${pending.course} / ${pending.name}`);
    transition = { url: location.href, at: now };
    pending.link.click();
  }
  async function next(info) {
    const items = rows();
    if (!items.length) return waitForPage(Date.now(), '未识别到课程任务列表');
    const currentTitle = resourceName();
    const pending = items.find(row => !row.folder && supported.test(normalizeName(row.name)) &&
      !run.visited.some(key => normalizeName(key) === normalizeName(`${info.folder}/${row.name}`)));
    if (pending) {
      log(`打开：${pending.name}`);
      if (info.file && normalizeName(pending.name) === normalizeName(currentTitle)) return;
      openRow(pending, false);
      return;
    }
    if (run.options.recursive) {
      const folder = items.find(row => row.folder && !run.visited.includes(`${info.folder}/${row.name}`));
      if (folder) {
        run.visited.push(`${info.folder}/${folder.name}`);
        run.stack.push(`${location.origin}/app/jx-web/mycourse/${info.course}/resource/${info.folder}`);
        await save();
        openRow(folder, true);
        return;
      }
      if (run.stack.length) {
        const parent = run.stack.pop();
        await save();
        location.assign(parent);
        return;
      }
    }
    stop(`队列结束，已确认 ${run.completed.length} 项完成；测验及不支持的类型未处理。`);
  }
  async function tick() {
    if (busy || !run?.enabled) return;
    const active = run;
    const selected = active.mode === 'selected';
    const selectedTarget = selected ? active.selection[active.selectionIndex] : null;
    busy = true;
    try {
      const now = Date.now();
      const info = route();
      const atHome = location.pathname.replace(/\/$/, '') === homePath;
      if (selected && (!selectedTarget || info?.course !== selectedTarget.courseId || info?.file !== selectedTarget.nodeId)) {
        return stop(`当前页面与清单中的「${selectedTarget?.name || '所选任务'}」地址不一致，队列已暂停。`);
      }
      if (!info && !(run.mode === 'home' && atHome)) return stop('已离开课程资源或首页，队列停止。');
      if (!selected && run.mode !== 'home' && run.course && run.course !== info.course) return stop('课程已切换，队列停止。');
      if (info && !selected) run.course = info.course;
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        arrived = now;
        lastAttempt = 0;
        transition = null;
        lastPlay = 0;
        taskTiming = null;
        timingProbeAt = 0;
        homeSignature = '';
        homeStableSince = 0;
        homeActionAt = 0;
        const stored = await save();
        if (selected && run === active && active.enabled && !stored?.accepted) {
          active.enabled = false;
          clearSelectedEffects();
        }
        if (run !== active || !active.enabled) return;
      }
      if (transition && !atHome) {
        if (now - transition.at > 15000) stop('页面未成功切换，请手动打开目标任务后重新开始。');
        return;
      }
      // SPA route changes render a temporary unfinished state. Never act on it.
      if (now - arrived < 5000) return;
      const text = document.body.innerText;
      if (/验证码|人机验证|登录已过期|登录失效|重新登录/.test(text)) return stop('需要验证或重新登录，请手动处理。');
      if (run.mode === 'home' && atHome) return await readHome(now);
      if (run.mode === 'home' && !info.file) return waitForPage(now, '首页待办尚未打开到具体资源');
      if (!selected && !info.file) return await next(info);
      const name = resourceName();
      if (selected && !matchesSelectedName(name, selectedTarget.name)) {
        return waitForPage(now, `未识别到清单中的资源「${selectedTarget.name}」或该类型不受支持`);
      }
      const target = run.homeTask?.target;
      if (run.mode === 'home' && target && (target.course !== info.course || target.file !== info.file)) {
        return stop(`资源地址与选中待办不一致，已暂停。预期课程/资源：${target.course}/${target.file}；实际：${info.course}/${info.file}`);
      }
      if (run.mode === 'home' && normalizeName(name) !== normalizeName(run.homeTask?.name)) {
        if (now - arrived < 20000) return log('正在等待目标资源标题加载…');
        return stop(`当前资源与选中的首页待办不一致，已暂停。待办：${JSON.stringify(run.homeTask?.name)}；页面：${JSON.stringify(name)}`);
      }
      if (!supported.test(normalizeName(name))) return waitForPage(now, `无法识别资源标题或类型：${JSON.stringify(name)}`);
      if (finished()) {
        if (selected) return await completeSelected(active);
        if (!run.completed.includes(location.pathname)) run.completed.push(location.pathname);
        if (!run.visited.includes(`${info.folder}/${name}`)) run.visited.push(`${info.folder}/${name}`);
        log(`平台已确认完成：${name}`);
        await save();
        if (run.options.autoNext === false) return stop(`当前任务已完成：${name}；自动下一任务未开启。`);
        log(`当前任务已完成，正在自动打开下一任务：${name}`);
        if (run.mode === 'home') {
          if (!run.homeFinished.includes(run.homeTask.key)) run.homeFinished.push(run.homeTask.key);
          run.homeTask = null;
          await save();
          location.assign(`${location.origin}${homePath}`);
          return;
        }
        return await next(info);
      }
      if (selected && active.options.aggressive === true) {
        return tryAggressiveSelectedCompletion(active, now);
      }
      if (selected && active.options.background && !selectedBackground) {
        selectedBackground = true;
        background(true);
      }
      const timingHint = document.querySelector('.ant-modal .finish_task_info');
      if (timingHint) {
        const timing = globalThis.xiaoyaTaskTiming(timingHint.textContent);
        if (!timing) return stop('无法识别平台的任务时长要求，请手动查看提示后重新开始。');
        taskTiming = { ...timing, due: now + timing.remainingSeconds * 1000 };
        const modal = timingHint.closest('.ant-modal');
        const acknowledge = [...modal.querySelectorAll('button')].find(button => button.textContent.trim() === '知道了');
        if (!acknowledge) return stop('已读取时长要求，但无法关闭平台提示，请手动处理。');
        acknowledge.click();
        log(`平台要求 ${timing.requiredSeconds} 秒，已学习 ${timing.learnedSeconds ?? '未知'} 秒，剩余 ${Math.ceil(timing.remainingSeconds)} 秒`);
        return;
      }
      // File-preview confirmation is scoped; never accept arbitrary course dialogs.
      for (const button of document.querySelectorAll('button')) {
        if (button.textContent.trim() === '确定' && /文件预览确认/.test(button.parentElement?.textContent || '')) button.click();
      }
      const video = document.querySelector('video');
      let ready = false;
      if (video) {
        if (selected) selectedVideo = video;
        video.playbackRate = run.options.rate;
        if (run.options.muted) video.muted = true;
        if (video.error) return stop('视频加载失败，请检查网络后重新开始。');
        if (!video.ended && video.paused && now - lastPlay > 5000) {
          lastPlay = now;
          try { await video.play(); }
          catch { if (active.enabled) log('浏览器阻止自动播放，请手动点击播放，或启用静音自动播放。'); return; }
          if (run !== active || !active.enabled) {
            if (selected) video.pause();
            return;
          }
          if (selected && location.href !== lastUrl) return stop('播放时资源页面已切换，队列已暂停。');
        }
        ready = video.ended || (Number.isFinite(video.duration) && video.duration > 0 && video.currentTime >= video.duration - 0.5);
        if (!ready) log(`播放中：${name} · ${run.options.rate} 倍速`);
      } else if (!/\.(mp4|webm|m4v|mov)$/i.test(normalizeName(name))) {
        if (!taskTiming) {
          if (timingProbeAt && now - timingProbeAt > 15000) {
            return stop('平台未返回可识别的课件时长要求，已暂停，请手动查看任务条件。');
          }
          // One normal completion attempt reveals this resource's actual rule.
          // It may also succeed immediately for a resource with no time limit.
          ready = !timingProbeAt;
        } else {
          ready = now >= taskTiming.due;
          if (!ready) log(`阅读等待：${name} · 平台要求 ${taskTiming.requiredSeconds} 秒`);
        }
      } else {
        return waitForPage(now, '播放器尚未加载');
      }
      if (taskTiming && now < taskTiming.due) return;
      const maxWait = Math.max(1800000,
        video && Number.isFinite(video.duration) ? video.duration * 2000 + 600000 : 0,
        taskTiming ? taskTiming.due - arrived + 600000 : 0);
      if (now - arrived > maxWait) return stop('长时间未获得完成状态，已暂停，请检查任务要求或网络。');
      if (!ready || now - lastAttempt < 30000) return;
      const complete = [...document.querySelectorAll('.ta_icon_btn')].find(e => e.textContent.trim() === '点我完成任务');
      if (!complete) return log('等待平台显示完成按钮…');
      lastAttempt = now;
      if (!video && !taskTiming) timingProbeAt = now;
      complete.click();
      log(timingProbeAt && !taskTiming ? '正在读取当前课件的实际时长要求…' : '已请求完成，等待平台确认；未确认前不会切换。');
    } catch (error) {
      if (run === active && active.enabled) stop(`运行暂停：${error.message}`);
    } finally { busy = false; }
  }
  function start(value) {
    run = value;
    if (run.mode === 'selected') {
      selectedHalted = false;
      selectedAggressiveAttempt = null;
    }
    arrived = Date.now();
    lastUrl = '';
    lastStatus = '';
    transition = null;
    if (run.mode !== 'selected') {
      background(run.enabled && run.options.background);
      log(run.mode === 'home' ? '正在读取首页跨课程待办…' : '队列已启动，正在读取当前目录…');
    }
    void tick();
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message.type === 'health') reply({ ok: true, protocol,
      loggedInHome: location.pathname.replace(/\/$/, '') === homePath && !!document.querySelector('[title="点击查看/刷新待完成学习任务"]') });
    if (message.type === 'run' && message.run?.mode !== 'selected') { start(message.run); reply({ ok: true }); }
    if (message.type === 'halt' && run && run.mode !== 'selected') { stop('已手动停止。'); reply({ ok: true }); }
    if (message.type === 'tick' && run?.mode !== 'selected') void tick();
    if (message.type === 'selected-halt') {
      selectedHalted = true;
      if (run?.mode === 'selected' && run.enabled) stop('已手动停止。');
      reply({ ok: true });
    }
    if (message.type === 'selected-tick' && run?.mode === 'selected') void tick();
  });
  chrome.runtime.sendMessage({ type: 'get', selectedProtocol: 1 }).then(result => {
    if (result?.run?.enabled && !(selectedHalted && result.run.mode === 'selected')) start(result.run);
  }).catch(() => {});
  setInterval(() => void tick(), 1000);
  setInterval(() => {
    if (!run?.enabled && location.pathname.replace(/\/$/, '') === homePath &&
        document.querySelector('[title="点击查看/刷新待完成学习任务"]')) {
      chrome.runtime.sendMessage({ type: 'login-ready' }).catch(() => {});
    }
  }, 5000);
})();
