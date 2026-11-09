'use strict';
// 任务面板的显示逻辑：筛选、排序、分组和时间文案。不依赖页面。
(function (root) {
  const taskData = root.XiaoyaTaskData || require('./task-data.js');
  const { taskStatus } = taskData;
  const ORIGIN = 'https://whut.ai-augmented.com';
  const WEEK = '日一二三四五六';
  const DAY_MS = 864e5;
  const TABS = [['pending', '待完成'], ['done', '已完成'], ['overdue', '已截止']];
  const VIEWS = [['course', '课程', '按课程分组'], ['courseType', '分类', '课程内再按类型分组'], ['time', '时间', '按时间排列']];
  const CHIPS = [
    { key: 'all', label: '全部', types: null },
    { key: 'homework', label: '作业', types: ['作业'] },
    { key: 'practice', label: '练习', types: ['练习'] },
    { key: 'quiz', label: '测验', types: ['测验'] },
    { key: 'media', label: '视频课件', types: ['视频课件'] },
    { key: 'other', label: '其他', types: ['问卷', '讨论', '其他'] }
  ];
  const TYPE_ORDER = ['作业', '练习', '测验', '视频课件', '问卷', '讨论', '其他'];

  const pad = n => String(n).padStart(2, '0');
  const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const dayDiff = (t, now) => Math.round((startOfDay(t) - startOfDay(now)) / DAY_MS);
  const clock = t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const monthDay = t => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };

  function formatTime(t, now) {
    if (t === null || t === undefined) return '未知';
    const n = dayDiff(t, now);
    if (n === 0) return `今天 ${clock(t)}`;
    if (n === 1) return `明天 ${clock(t)}`;
    if (n === -1) return `昨天 ${clock(t)}`;
    if (n > 1 && n < 7) return `周${WEEK[new Date(t).getDay()]} ${clock(t)}`;
    return `${monthDay(t)} ${clock(t)}`;
  }

  function heat(t, now) {
    if (t === null || t === undefined) return '';
    const hours = (t - now) / 36e5;
    return hours < 24 ? 'hot' : hours < 72 ? 'warm' : '';
  }

  function remaining(t, now) {
    if (t === null || t === undefined) return '无截止信息';
    const hours = (t - now) / 36e5;
    if (hours < 1) return '不到 1 小时';
    if (hours < 24) return `还剩 ${Math.floor(hours)} 小时`;
    return `还剩 ${Math.floor(hours / 24)} 天`;
  }

  function matches(task, filters, now, chipKey = filters.chip) {
    const chip = CHIPS.find(item => item.key === chipKey);
    if (chip.types && !chip.types.includes(task.type)) return false;
    if (filters.day !== null && taskStatus(task, now) === 'pending' && (task.end === null || dayDiff(task.end, now) !== filters.day)) return false;
    const query = filters.query.trim().toLowerCase();
    return !query || `${task.name} ${task.courseName}`.toLowerCase().includes(query);
  }

  const sortValue = {
    pending: task => (task.end === null ? Infinity : task.end),
    done: task => (task.finishedAt === null ? Infinity : -task.finishedAt),
    overdue: task => -task.end
  };

  function visibleTasks(tasks, filters, now) {
    const value = sortValue[filters.tab];
    return tasks.filter(task => taskStatus(task, now) === filters.tab && matches(task, filters, now)).sort((a, b) => {
      const av = value(a), bv = value(b);
      return av === bv ? 0 : av < bv ? -1 : 1;
    });
  }

  function tabCounts(tasks, filters, now) {
    const counts = { pending: 0, done: 0, overdue: 0 };
    for (const task of tasks) if (matches(task, filters, now)) counts[taskStatus(task, now)] += 1;
    return counts;
  }

  function groupBy(items, keyOf) {
    const groups = new Map();
    for (const item of items) {
      const key = keyOf(item);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    return groups;
  }

  function pendingWithDeadline(tasks, now) {
    return tasks.filter(task => taskStatus(task, now) === 'pending' && task.end !== null).sort((a, b) => a.end - b.end);
  }

  function brief(tasks, now) {
    const pending = pendingWithDeadline(tasks, now);
    return { today: pending.filter(task => dayDiff(task.end, now) === 0).length, next: pending[0] || null };
  }

  function weekDays(tasks, now) {
    const pending = pendingWithDeadline(tasks, now);
    return Array.from({ length: 7 }, (_, offset) => {
      const date = new Date(now);
      date.setDate(date.getDate() + offset);
      return {
        offset,
        label: offset === 0 ? '今' : WEEK[date.getDay()],
        month: date.getMonth() + 1,
        date: date.getDate(),
        count: pending.filter(task => dayDiff(task.end, now) === offset).length
      };
    });
  }

  function courseProgress(tasks, now) {
    const progress = new Map();
    for (const task of tasks) {
      if (!progress.has(task.courseId)) progress.set(task.courseId, { done: 0, total: 0 });
      const row = progress.get(task.courseId);
      row.total += 1;
      if (taskStatus(task, now) === 'done') row.done += 1;
    }
    return progress;
  }

  function timeBucket(task, tab, now) {
    if (tab === 'pending') {
      if (task.end === null) return '时间未知';
      const n = dayDiff(task.end, now);
      return n === 0 ? '今天' : n === 1 ? '明天' : n <= 7 ? '7 天内' : '更晚';
    }
    const reference = tab === 'done' ? task.finishedAt : task.end;
    if (reference === null) return '时间未知';
    return dayDiff(reference, now) >= -7 ? '近 7 天' : '更早';
  }

  function rowDisplay(task, now) {
    const status = taskStatus(task, now);
    const period = `${task.courseName} · ${task.type} · ${task.start === null ? '开始时间未知' : `${monthDay(task.start)} 开始`}`;
    if (status === 'done') return { time: formatTime(task.finishedAt, now), tone: 'good', tip: `${task.name}\n${period}\n已完成 · 截止 ${formatTime(task.end, now)}` };
    if (status === 'overdue') return { time: formatTime(task.end, now), tone: 'hot', tip: `${task.name}\n${period}\n未完成 · 已截止` };
    const notStarted = task.start !== null && task.start > now ? '未开始 · ' : '';
    return { time: formatTime(task.end, now), tone: heat(task.end, now), tip: `${task.name}\n${period}\n${notStarted}${remaining(task.end, now)}` };
  }

  // 没有数据或读取不完整时显示的提示；不把失败显示成零任务。
  function noticeFor(status, message, failures) {
    if (status === 'site-closed') return { text: '打开小雅页面后才能刷新', action: 'open', label: '打开小雅' };
    if (status === 'login-required') return { text: '请先登录小雅', action: 'open', label: '前往登录' };
    if (status === 'error') return { text: message || '任务读取失败，请稍后重试', action: 'retry', label: '重试' };
    if (status !== 'ok' || !failures.length) return null;
    const courses = [...new Set(failures.filter(item => item.stage === 'tasks').map(item => item.courseName))];
    if (courses.length) return { text: `${courses.join('、')}读取失败，数量可能不完整`, action: 'retry', label: '重试' };
    if (failures.some(item => item.stage === 'unfinished' || item.stage === 'courses')) return { text: '部分课程可能未读取到，数量可能不完整', action: 'retry', label: '重试' };
    return { text: '部分任务名称读取失败', action: 'retry', label: '重试' };
  }

  // 正在运行队列的标签页绝不跳转。
  function openTarget(tab, run) {
    const isSite = typeof tab?.url === 'string' && tab.url.startsWith(`${ORIGIN}/`);
    const busy = Boolean(run) && run.enabled !== false && run.tabId === tab?.id;
    return isSite && !busy ? 'same' : 'new';
  }

  const api = { ORIGIN, TABS, VIEWS, CHIPS, TYPE_ORDER, pad, formatTime, heat, remaining, visibleTasks, tabCounts, groupBy, brief, weekDays, courseProgress, timeBucket, rowDisplay, noticeFor, openTarget };
  root.XiaoyaPanelModel = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
