'use strict';
// 列表栏全选、底栏留白和几处轻量动效。
// 只负责界面：勾选和清空都通过原有按钮触发，选择规则仍由 panel-answer / panel-queue 决定。
(function () {
  const get = id => document.getElementById(id);
  const list = get('list');
  const box = get('selectAll');
  const menu = get('selectMenu');
  const dock = get('dock');
  const scroller = get('scroller');
  const number = text => Number(/\d+/.exec(text || '')?.[0] || 0);
  const selectedCount = id => number(get(id)?.textContent);
  const clickIf = id => { const button = get(id); if (button && !button.disabled) button.click(); };
  const usable = selector => [...list.querySelectorAll(selector)].filter(input => !input.disabled);

  function setMenu(open) {
    menu.hidden = !open;
    box.setAttribute('aria-expanded', String(open));
  }

  // 全选的三种状态只看当前列表里能勾的行；折叠的课程卡片里的行也在列表中。
  function render() {
    const answer = usable('.answer-check');
    const video = usable('.video-check');
    const all = [...answer, ...video];
    const checked = all.filter(input => input.checked).length;
    box.disabled = !all.length;
    box.setAttribute('aria-checked', !checked ? 'false' : checked === all.length ? 'true' : 'mixed');
    box.classList.toggle('has-menu', answer.length > 0 && video.length > 0);
    get('selectNone').disabled = !selectedCount('answerSelected') && !selectedCount('videoSelected');
    if (box.disabled) setMenu(false);
  }

  box.addEventListener('click', event => {
    event.stopPropagation();
    const answer = usable('.answer-check');
    const video = usable('.video-check');
    // 作答会直接提交，混合类型时让用户明确选一类，不提供一键全选所有类型。
    if (answer.length && video.length) { setMenu(menu.hidden); return; }
    const isAnswer = answer.length > 0;
    if (box.getAttribute('aria-checked') === 'true') clickIf(isAnswer ? 'answerClear' : 'videoClear');
    else clickIf(isAnswer ? 'answerAll' : 'videoAll');
  });
  get('selectNone').addEventListener('click', () => {
    if (selectedCount('answerSelected')) clickIf('answerClear');
    if (selectedCount('videoSelected')) clickIf('videoClear');
  });
  menu.addEventListener('click', event => { if (event.target.closest('button')) setMenu(false); });
  document.addEventListener('click', event => { if (!menu.hidden && !event.target.closest('.select-wrap')) setMenu(false); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !menu.hidden) { setMenu(false); box.focus(); }
  });

  // 底栏浮在列表上方，列表底部留出同样高度，最后几行不会被挡住。
  function layoutDock() {
    const on = [...dock.children].some(row => !row.hidden);
    dock.classList.toggle('on', on);
    scroller.style.paddingBottom = on ? `${dock.offsetHeight + 20}px` : '';
  }
  new ResizeObserver(layoutDock).observe(dock);
  new MutationObserver(layoutDock).observe(dock, { subtree: true, attributes: true, attributeFilter: ['hidden'] });

  // 文字真的变了才播放动画；各模块每次渲染都会重写同样的文字。
  function onTextChange(element, callback) {
    let last = element.textContent;
    new MutationObserver(() => {
      const next = element.textContent;
      if (next === last) return;
      const previous = last;
      last = next;
      callback(previous, next);
    }).observe(element, { childList: true, characterData: true, subtree: true });
  }
  const replay = (element, name) => { element.classList.remove('up', 'down', 'swap'); void element.offsetWidth; element.classList.add(name); };
  for (const id of ['answerSelected', 'videoSelected']) {
    const label = get(id);
    label.title = label.textContent;
    onTextChange(label, (before, after) => {
      label.title = after;
      if (number(before) !== number(after)) replay(label, number(after) > number(before) ? 'up' : 'down');
    });
  }
  dock.querySelectorAll('[data-queue-start]').forEach(button => onTextChange(button, () => replay(button, 'swap')));

  // 运行进度：读取「已完成 x/y 项」画底边进度线。
  const queueCount = dock.querySelector('[data-queue-count]');
  onTextChange(queueCount, () => {
    const match = /(\d+)\s*\/\s*(\d+)/.exec(queueCount.textContent);
    get('videoActions').style.setProperty('--progress', match && Number(match[2]) ? (match[1] / match[2]).toFixed(3) : '0');
  });

  // 筛选标签：选中底色滑到新标签下。
  const chips = get('chips');
  const pill = document.createElement('span');
  pill.className = 'chip-pill';
  pill.setAttribute('aria-hidden', 'true');
  chips.prepend(pill);
  let placed = false;
  function movePill() {
    const chip = chips.querySelector('.chip[aria-pressed="true"]');
    if (!chip || !chip.offsetWidth) return;
    if (!placed) pill.style.transition = 'none';
    pill.style.width = `${chip.offsetWidth}px`;
    pill.style.height = `${chip.offsetHeight}px`;
    pill.style.transform = `translate(${chip.offsetLeft}px, ${chip.offsetTop}px)`;
    if (!placed) { void pill.offsetWidth; pill.style.transition = ''; placed = true; }
  }
  new MutationObserver(movePill).observe(chips, { subtree: true, attributes: true, attributeFilter: ['aria-pressed'] });
  new ResizeObserver(movePill).observe(chips);
  chips.addEventListener('click', event => event.target.closest('.chip')?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' }));

  globalThis.XiaoyaPanelSelect = { render };
  render();
  layoutDock();
  movePill();
})();
