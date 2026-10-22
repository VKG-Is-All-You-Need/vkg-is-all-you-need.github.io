import { onPageLoad, prefersReducedMotion, watchVisibility } from './lifecycle';

// 首页“工作原理”演示：步骤切换、自动播放与本体开关。
onPageLoad((signal) => {
  const demo = document.querySelector<HTMLElement>('[data-demo]');
  if (!demo) return;

  const tabs = [...demo.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const panels = tabs.map((tab) => document.getElementById(tab.getAttribute('aria-controls')!)!);
  const fileLabel = demo.querySelector('[data-demo-file]');
  const ontology = demo.querySelector<HTMLInputElement>('[data-ontology]');
  const reduced = prefersReducedMotion();

  let current = 0;
  let interacted = false;
  let inView = false;

  const select = (index: number, focus = false) => {
    current = (index + tabs.length) % tabs.length;
    tabs.forEach((tab, i) => {
      const selected = i === current;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      panels[i].classList.toggle('is-active', selected);
    });
    if (fileLabel) fileLabel.textContent = tabs[current].dataset.file ?? '';
    if (focus) tabs[current].focus();
  };

  const syncPlaying = () => demo.toggleAttribute('data-playing', inView && !interacted && !reduced);

  const stopAutoplay = () => {
    interacted = true;
    syncPlaying();
  };

  demo.setAttribute('data-ready', '');
  select(0);

  watchVisibility(
    demo,
    (visible) => {
      inView = visible;
      syncPlaying();
    },
    signal,
    '-25% 0px',
  );

  // 进度条走完后进入下一步。
  demo.addEventListener(
    'animationend',
    (event) => {
      if ((event.target as Element).classList.contains('step-progress')) select(current + 1);
    },
    { signal },
  );

  tabs.forEach((tab, i) => {
    tab.addEventListener(
      'click',
      () => {
        stopAutoplay();
        select(i);
      },
      { signal },
    );
    tab.addEventListener(
      'keydown',
      (event) => {
        const moves: Record<string, number> = {
          ArrowDown: current + 1,
          ArrowRight: current + 1,
          ArrowUp: current - 1,
          ArrowLeft: current - 1,
          Home: 0,
          End: tabs.length - 1,
        };
        if (!(event.key in moves)) return;
        event.preventDefault();
        stopAutoplay();
        select(moves[event.key], true);
      },
      { signal },
    );
  });

  // 切换本体时跳到能看出差异的步骤。
  ontology?.addEventListener(
    'change',
    () => {
      stopAutoplay();
      if (current !== 2 && current !== 4) select(4);
    },
    { signal },
  );
});
