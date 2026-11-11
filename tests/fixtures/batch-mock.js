// Browser-only integration fixture. All platform, AI, and extension APIs are local mocks.
const FIXTURE_STATE_KEY = 'xiaoya-batch-fixture-state';
const savedFixtureState = readFixtureState();
const mockChanges = [];
const mockData = savedFixtureState.extensionStorage || {};
let mockAccount = savedFixtureState.account === 'B' ? 'B' : 'A';
let mockFinishedByAccount = savedFixtureState.finishedByAccount || {};
let mockReceiptsByAccount = savedFixtureState.receiptsByAccount || {};
let mockCalls = savedFixtureState.aiRequests || 0;
let mockOpened = savedFixtureState.openedTasks || [];
let mockEngine;
let mockAdapter;
let mockCurrent;
let mockPage;
let mockTabId = 0;
const mockDraftPages = new Map();

const taskDefinitions = [
  { id: 't1', nodeId: '1', typeCode: 2, type: '作业', name: '普通作业一' },
  { id: 't2', nodeId: '2', typeCode: 3, type: '练习', name: '普通练习二' },
  { id: 't3', nodeId: '3', typeCode: 2, type: '作业', name: '附件作业三' },
  { id: 't4', nodeId: '4', typeCode: 2, type: '作业', name: '未选作业四' }
];

const mockTasks = taskDefinitions.map(task => ({
  ...task,
  courseId: '11',
  courseName: '模拟课程',
  finished: (mockFinishedByAccount[mockAccount] || []).includes(task.id),
  start: Date.now() - 1000,
  end: Date.now() + 86400000,
  finishedAt: null,
  url: `https://whut.ai-augmented.com/app/jx-web/mycourse/11/resource/_/${task.nodeId}`
}));

function readFixtureState() {
  try {
    return JSON.parse(sessionStorage.getItem(FIXTURE_STATE_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveFixtureState() {
  try {
    sessionStorage.setItem(FIXTURE_STATE_KEY, JSON.stringify({
      account: mockAccount,
      extensionStorage: mockData,
      finishedByAccount: mockFinishedByAccount,
      receiptsByAccount: mockReceiptsByAccount,
      aiRequests: mockCalls,
      openedTasks: mockOpened
    }));
  } catch {
    // The fixture remains usable when session storage is unavailable.
  }
}

function setAccountTasks() {
  const finished = new Set(mockFinishedByAccount[mockAccount] || []);
  mockTasks.forEach(task => {
    task.finished = finished.has(task.id);
    task.finishedAt = task.finished ? Date.now() : null;
  });
}

function renderMockStats() {
  const receipts = mockReceiptsByAccount[mockAccount] || [];
  const ordinaryReceipts = receipts.filter(id => id === 't1' || id === 't2').length;
  const attachmentReceipts = receipts.filter(id => id === 't3').length;
  const boundarySelected = Boolean(document.querySelector('[data-answer-id="t4"]:checked'));
  const boundaryOpens = mockOpened.filter(id => id === 't4').length;
  document.getElementById('mockStats').textContent =
    `模拟账号 ${mockAccount} · 普通任务提交回执 ${ordinaryReceipts}/2 · 附件任务提交 ${attachmentReceipts} 次 · 边界任务未选 ${boundarySelected ? 0 : 1}/1 · 边界任务处理 ${boundaryOpens} 次 · 模拟 AI 请求 ${mockCalls} 次`;
  saveFixtureState();
}

const mockStorage = {
  async get() {
    return structuredClone(mockData);
  },
  async set(values) {
    for (const [key, value] of Object.entries(values)) {
      const oldValue = mockData[key];
      mockData[key] = structuredClone(value);
      mockChanges.forEach(listener => listener({
        [key]: { oldValue, newValue: structuredClone(value) }
      }, 'local'));
    }
    saveFixtureState();
  }
};

window.chrome = {
  storage: {
    local: mockStorage,
    onChanged: { addListener(listener) { mockChanges.push(listener); } },
    session: { async get() { return {}; } }
  },
  runtime: {
    id: 'fixture',
    onMessage: { addListener() {} },
    async sendMessage(message) {
      if (message.type === 'auto:start') {
        return mockEngine.start({
          account: message.account,
          tasks: mockTasks.filter(task => message.ids.includes(task.id))
        });
      }
      if (message.type === 'auto:get') return { ok: true, batch: await mockEngine.get() };
      if (message.type === 'auto:stop') return mockEngine.stop();
      if (message.type === 'auto:verify') return mockEngine.verify();
      if (message.type === 'auto:open-draft') {
        const batch = await mockEngine.get();
        const index = batch?.tasks.findIndex(task => task.id === message.taskId);
        const result = batch?.results[index];
        const page = mockDraftPages.get(result?.draftPage?.tabId);
        if (!batch || batch.id !== message.batchId || batch.account !== mockAccount || batch.enabled || result?.status !== 'draft' ||
            !page?.frame.isConnected || page.pageToken !== result.draftPage.pageToken) {
          return { ok: false, error: '原模拟答题页已关闭或批次已变化。' };
        }
        const active = document.getElementById('mockPaper');
        if (active !== page.frame) {
          active.hidden = true;
          active.removeAttribute('id');
          page.frame.id = 'mockPaper';
          page.frame.hidden = false;
        }
        return { ok: true };
      }
      return { ok: true };
    }
  },
  tabs: {
    onUpdated: { addListener() {} },
    async query() { return [{ id: 1, url: location.href }]; },
    async update(id, changes) { return { id, url: location.href, ...changes }; },
    async create() { return { id: 2, url: location.href }; }
  }
};

const mockStore = {
  async peek() { return null; },
  async load() {
    return {
      status: 'ok',
      tasks: mockTasks,
      account: mockAccount,
      failures: [],
      fetchedAt: Date.now()
    };
  },
  async getPins() { return []; },
  async setPins() {}
};

window.XiaoyaTaskData = {
  ...window.XiaoyaTaskData,
  createTaskStore: () => mockStore
};

function configureMockControls() {
  const accountSelect = document.getElementById('mockAccount');
  accountSelect.value = mockAccount;
  accountSelect.addEventListener('change', () => {
    mockAccount = accountSelect.value;
    setAccountTasks();
    renderMockStats();
    document.getElementById('refresh').click();
  });

  document.getElementById('mockReload').addEventListener('click', () => window.location.reload());
}

function mockInit() {
  configureMockControls();
  setAccountTasks();
  document.getElementById('list').addEventListener('change', renderMockStats);

  const command = (action, extra = {}) => mockAdapter.command({
    action,
    task: mockCurrent,
    batchId: mockEngine.getId(),
    pageToken: mockPage?.pageToken,
    ...extra
  });

  const driver = {
    async open(task) {
      if (location.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(location.hostname)) {
        throw Error('本地验收 fixture 仅允许从 localhost 或 127.0.0.1 打开。');
      }
      mockCurrent = task;
      mockOpened.push(task.id);
      renderMockStats();

      const oldFrame = document.getElementById('mockPaper');
      const frame = document.createElement('iframe');
      frame.id = 'mockPaper';
      frame.title = task.name;
      if ([...mockDraftPages.values()].some(page => page.frame === oldFrame)) {
        oldFrame.hidden = true;
        oldFrame.removeAttribute('id');
        oldFrame.after(frame);
      } else oldFrame.replaceWith(frame);
      mockPage = { frame, tabId: ++mockTabId, pageToken: crypto.randomUUID() };

      const response = await fetch('batch-paper.html');
      if (!response.ok) throw Error('无法读取本地模拟题页。');
      const html = await response.text();
      const paper = html.replace(
        'const taskId = "__FIXTURE_TASK_ID__";',
        `const taskId = ${JSON.stringify(task.nodeId)};`
      );
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('模拟题页加载超时。')), 10000);
        frame.onload = () => { clearTimeout(timer); resolve(); };
        frame.srcdoc = paper;
      });

      mockAdapter = XiaoyaAnswerPage.createAdapter({
        document: frame.contentDocument,
        location: new URL(task.url),
        uuid: () => mockPage.pageToken,
        permit: message => mockEngine.permit(message)
      });
      return (await command('inspect')).snapshot;
    },
    async inspect() { return (await command('inspect')).snapshot; },
    async fill(task, item) { return command('fill', { item }); },
    async submit(task, fingerprint) { return command('submit', { fingerprint }); },
    draftReference() {
      const { tabId, pageToken } = mockPage;
      mockDraftPages.set(tabId, mockPage);
      return { tabId, pageToken };
    },
    async verify() {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        if ((await command('inspect')).snapshot.submitted) {
          mockFinishedByAccount[mockAccount] ||= [];
          if (!mockFinishedByAccount[mockAccount].includes(mockCurrent.id)) {
            mockFinishedByAccount[mockAccount].push(mockCurrent.id);
          }
          mockReceiptsByAccount[mockAccount] ||= [];
          if (!mockReceiptsByAccount[mockAccount].includes(mockCurrent.id)) {
            mockReceiptsByAccount[mockAccount].push(mockCurrent.id);
          }
          setAccountTasks();
          renderMockStats();
          return true;
        }
        await command('confirm');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return false;
    },
    halt() { if (mockAdapter) void command('halt'); },
    async recheck() { return (await command('inspect')).snapshot.submitted; }
  };

  mockEngine = XiaoyaAnswerBatch.createEngine({
    storage: mockStorage,
    driver,
    getAccount: async () => mockAccount,
    query: async question => {
      mockCalls += 1;
      renderMockStats();
      await new Promise(resolve => setTimeout(resolve, 300));
      const answer = question.type === 'fill'
        ? ['2', '4']
        : question.type === 'multiple' ? ['A', 'C'] : ['A'];
      return XiaoyaQuestion.answer(JSON.stringify({
        answer,
        explanation: '本地固定样题模拟答案'
      }), question);
    }
  });

  renderMockStats();
}
