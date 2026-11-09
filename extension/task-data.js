'use strict';
// 任务数据层：只读请求小雅接口，整理字段，控制并发并维护缓存。不依赖界面。
(function (root) {
  const ORIGIN = 'https://whut.ai-augmented.com';
  const PATHS = {
    account: '/api/jx-auth/oauth2/info',
    unfinished: '/api/jx-stat/group/task/un_finish',
    courses: '/api/jx-iresource/group/student/groups?time_flag=1',
    notices: id => `/api/jx-stat/group/task/queryTaskNotices?group_id=${encodeURIComponent(id)}&role=1`,
    resources: id => `/api/jx-iresource/resource/queryCourseResources?group_id=${encodeURIComponent(id)}`
  };
  const CACHE_TTL_MS = 5 * 60 * 1000;
  const MAX_CONCURRENT_REQUESTS = 3;
  const REQUEST_TIMEOUT_MS = 15000;
  const CACHE_KEY = 'xiaoyaTaskCache';
  const COURSES_KEY = 'xiaoyaTaskCourses';
  const PINS_PREFIX = 'xiaoyaTaskPins:';
  const TYPE_LABELS = { 1: '视频课件', 2: '作业', 3: '练习', 4: '测验', 5: '问卷', 6: '讨论' };
  const UNKNOWN_TASK_NAME = '未知任务名称';
  const UNKNOWN_COURSE_NAME = '未命名课程';

  class AuthRequiredError extends Error {}

  function parseTime(value) {
    if (value === null || value === undefined || value === '') return null;
    const time = new Date(value).getTime();
    return Number.isNaN(time) ? null : time;
  }

  function taskStatus(task, now) {
    if (task.finished) return 'done';
    return task.end !== null && task.end <= now ? 'overdue' : 'pending';
  }

  function taskUrl(courseId, resourceId, nodeId) {
    const course = encodeURIComponent(courseId);
    if (nodeId === null || nodeId === undefined || nodeId === '') return `${ORIGIN}/app/jx-web/mycourse/${course}`;
    return `${ORIGIN}/app/jx-web/mycourse/${course}/resource/${encodeURIComponent(resourceId || '_')}/${encodeURIComponent(nodeId)}`;
  }

  function normalizeTask(raw, course, names) {
    const taskId = raw.task_id ?? null;
    const nodeId = raw.node_id ?? null;
    const resourceId = raw.resource_id ?? null;
    const typeCode = Number(raw.task_type);
    const name = (taskId !== null && names?.get(String(taskId))) || (nodeId !== null && names?.get(`node:${nodeId}`)) || raw.name || UNKNOWN_TASK_NAME;
    const end = parseTime(raw.end_time);
    const finished = Number(raw.finish) === 2;
    return {
      id: `${course.id}:${taskId ?? nodeId ?? resourceId ?? `${name}:${end}`}`,
      taskId, nodeId, resourceId,
      courseId: course.id,
      courseName: course.name,
      name,
      typeCode,
      type: TYPE_LABELS[typeCode] || '其他',
      finished,
      start: parseTime(raw.start_time),
      end,
      // 平台对未完成的任务也会返回 finish_time，只有已完成时才有意义。
      finishedAt: finished ? parseTime(raw.finish_time) : null,
      url: taskUrl(course.id, resourceId, nodeId)
    };
  }

  // 只用来比较登录状态是否变化，缓存里不保存 Token 本身。
  function fingerprint(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16);
  }

  function createLimiter(max) {
    const waiting = [];
    let active = 0;
    const next = () => {
      if (active >= max || !waiting.length) return;
      active += 1;
      const { job, resolve, reject } = waiting.shift();
      Promise.resolve().then(job).then(resolve, reject).finally(() => { active -= 1; next(); });
    };
    return job => new Promise((resolve, reject) => { waiting.push({ job, resolve, reject }); next(); });
  }

  // 在小雅页面内执行，不能引用外部变量。
  function readPageToken() {
    const item = document.cookie.split('; ').find(entry => entry.slice(0, entry.indexOf('=')).includes('prd-access-token'));
    return item ? item.slice(item.indexOf('=') + 1) : null;
  }

  // 实测 chrome.cookies 读不到登录 Cookie，只能从已打开的小雅页面读取。
  // 返回值：字符串为登录凭据；null 为页面已打开但未登录；undefined 为没有可读取的小雅页面。
  async function readTabToken() {
    const tabs = await chrome.tabs.query({ url: `${ORIGIN}/*` });
    let answered = false;
    for (const tab of tabs) {
      const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPageToken }).catch(() => null);
      if (!results) continue;
      answered = true;
      if (results[0]?.result) return results[0].result;
    }
    return answered ? null : undefined;
  }

  function createTaskStore(options = {}) {
    const fetchImpl = options.fetchImpl || ((...args) => root.fetch(...args));
    const storage = options.storage || chrome.storage.local;
    const tokenReader = options.getToken || readTabToken;
    // 浏览器接口报错时按“读不到小雅页面”处理，不让异常传到界面。
    const getToken = () => Promise.resolve().then(tokenReader).catch(() => undefined);
    const now = options.now || (() => Date.now());
    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const limit = createLimiter(MAX_CONCURRENT_REQUESTS);
    const inflight = new Map();
    let refreshing = null;

    function request(path, token) {
      if (inflight.has(path)) return inflight.get(path);
      const job = limit(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetchImpl(ORIGIN + path, {
            method: 'GET',
            credentials: 'include',
            signal: controller.signal,
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' }
          });
          if (response.status === 401 || response.status === 403) throw new AuthRequiredError('登录已失效');
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = await response.json();
          if (body?.success !== true) throw new Error('接口返回失败');
          return body.data;
        } finally {
          clearTimeout(timer);
        }
      }).finally(() => inflight.delete(path));
      inflight.set(path, job);
      return job;
    }

    const readKey = async key => (await storage.get(key))[key];

    async function readCourses() {
      return (await readKey(COURSES_KEY))?.courses || {};
    }

    async function mergeCourses(account, found) {
      const stored = await readKey(COURSES_KEY);
      const courses = { ...(stored?.courses || {}) };
      for (const course of found) {
        const id = String(course?.id ?? '');
        if (!/^\d+$/.test(id)) continue;
        courses[id] = { id, name: course.name || courses[id]?.name || UNKNOWN_COURSE_NAME };
      }
      await storage.set({ [COURSES_KEY]: { account: account ?? stored?.account ?? null, courses } });
      return courses;
    }

    async function clearOtherAccount(account) {
      const [cache, courses] = await Promise.all([readKey(CACHE_KEY), readKey(COURSES_KEY)]);
      const previous = cache?.account ?? courses?.account;
      if (previous !== undefined && previous !== null && previous !== account) await storage.remove([CACHE_KEY, COURSES_KEY]);
    }

    function isAuthFailure(result) {
      return result.status === 'rejected' && result.reason instanceof AuthRequiredError;
    }

    async function readCourse(course, token, unfinishedRows) {
      const [notices, resources] = await Promise.allSettled([
        request(PATHS.notices(course.id), token),
        request(PATHS.resources(course.id), token)
      ]);
      if (isAuthFailure(notices) || isAuthFailure(resources)) throw new AuthRequiredError('登录已失效');

      const names = new Map();
      for (const row of unfinishedRows) if (row.node_id != null && row.name) names.set(`node:${row.node_id}`, row.name);
      const namesLoaded = resources.status === 'fulfilled' && Array.isArray(resources.value);
      if (namesLoaded) for (const row of resources.value) if (row?.task_id != null && row.name) names.set(String(row.task_id), row.name);

      const list = notices.status === 'fulfilled' ? notices.value?.student_tasks : null;
      if (!Array.isArray(list)) {
        // 这门课读取失败时，先显示跨课程接口已有的未完成任务，并如实标记为不完整。
        return { tasks: unfinishedRows.map(row => normalizeTask(row, course, names)), failure: { courseId: course.id, courseName: course.name, stage: 'tasks' } };
      }
      return {
        tasks: list.filter(Boolean).map(row => normalizeTask(row, course, names)),
        failure: namesLoaded ? null : { courseId: course.id, courseName: course.name, stage: 'names' }
      };
    }

    async function runRefresh() {
      const token = await getToken();
      if (token === undefined) return { status: 'site-closed', tasks: [], failures: [] };
      if (!token) return { status: 'login-required', tasks: [], failures: [] };
      try {
        const info = await request(PATHS.account, token);
        if (info?.info?.id === undefined || info?.info?.id === null) throw new Error('账号信息不完整');
        const account = String(info.info.id);
        await clearOtherAccount(account);

        const [unfinishedResult, courseListResult] = await Promise.allSettled([request(PATHS.unfinished, token), request(PATHS.courses, token)]);
        if (isAuthFailure(unfinishedResult) || isAuthFailure(courseListResult)) throw new AuthRequiredError('登录已失效');
        const listOf = result => (result.status === 'fulfilled' && Array.isArray(result.value) ? result.value : null);
        const unfinished = listOf(unfinishedResult) || [];
        const courseList = listOf(courseListResult) || [];
        const failures = [];
        if (!listOf(unfinishedResult)) failures.push({ courseId: null, courseName: null, stage: 'unfinished' });
        if (!listOf(courseListResult)) failures.push({ courseId: null, courseName: null, stage: 'courses' });

        const found = [
          ...courseList.map(row => ({ id: row?.id, name: row?.name })),
          ...unfinished.map(row => ({ id: row?.group_id, name: row?.group_name }))
        ];
        const courses = Object.values(await mergeCourses(account, found));
        if (failures.length && !courses.length) return { status: 'error', message: '任务读取失败，请稍后重试', tasks: [], failures };

        const rowsByCourse = new Map();
        for (const row of unfinished) {
          const id = String(row?.group_id ?? '');
          if (!rowsByCourse.has(id)) rowsByCourse.set(id, []);
          rowsByCourse.get(id).push(row);
        }
        const results = await Promise.all(courses.map(course => readCourse(course, token, rowsByCourse.get(course.id) || [])));
        const snapshot = {
          status: 'ok',
          account,
          tokenMark: fingerprint(token),
          fetchedAt: now(),
          tasks: results.flatMap(result => result.tasks),
          failures: [...failures, ...results.map(result => result.failure).filter(Boolean)]
        };
        await storage.set({ [CACHE_KEY]: snapshot });
        return { ...snapshot, fromCache: false, stale: false };
      } catch (error) {
        if (error instanceof AuthRequiredError) return { status: 'login-required', tasks: [], failures: [] };
        return { status: 'error', message: '任务读取失败，请稍后重试', tasks: [], failures: [] };
      }
    }

    function refresh() {
      if (!refreshing) refreshing = runRefresh().finally(() => { refreshing = null; });
      return refreshing;
    }

    function isStale(snapshot) {
      const age = now() - snapshot.fetchedAt;
      return age < 0 || age >= CACHE_TTL_MS || snapshot.failures.length > 0;
    }

    // 只读本地缓存，不发请求，用于打开面板时立即显示。
    async function peek() {
      const token = await getToken();
      if (token === null || token === '') return null;
      const cached = await readKey(CACHE_KEY);
      if (!cached) return null;
      // 没有打开小雅页面时无法确认账号，仍显示上次的缓存，并标记为过期。
      if (token === undefined) return { ...cached, fromCache: true, stale: true };
      if (cached.tokenMark !== fingerprint(token)) return null;
      return { ...cached, fromCache: true, stale: isStale(cached) };
    }

    async function load({ force = false } = {}) {
      if (!force) {
        const cached = await peek();
        if (cached && !cached.stale) return cached;
      }
      return refresh();
    }

    return {
      peek, load, refresh,
      rememberCourses: found => mergeCourses(null, found),
      knownCourses: readCourses,
      getPins: async account => (await readKey(PINS_PREFIX + account)) || [],
      setPins: (account, ids) => storage.set({ [PINS_PREFIX + account]: ids })
    };
  }

  const api = { createTaskStore, normalizeTask, taskStatus, taskUrl, readTabToken, readPageToken, CACHE_TTL_MS, MAX_CONCURRENT_REQUESTS };
  root.XiaoyaTaskData = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
