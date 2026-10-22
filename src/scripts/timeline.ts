import { onPageLoad } from './lifecycle';

// 学习路径：时间线随滚动填充，经过的阶段点亮。
onPageLoad((signal) => {
  const timeline = document.querySelector<HTMLElement>('[data-timeline]');
  if (!timeline) return;
  const stages = [...timeline.querySelectorAll<HTMLElement>('[data-stage]')];

  const update = () => {
    const anchor = window.innerHeight * 0.55;
    const rect = timeline.getBoundingClientRect();
    const progress = Math.min(1, Math.max(0, (anchor - rect.top) / rect.height));
    timeline.style.setProperty('--progress', progress.toFixed(4));
    stages.forEach((stage) =>
      stage.classList.toggle('is-active', stage.getBoundingClientRect().top < anchor),
    );
  };

  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      update();
    });
  };

  update();
  window.addEventListener('scroll', schedule, { passive: true, signal });
  window.addEventListener('resize', schedule, { signal });
});
