import { onPageLoad, prefersReducedMotion } from './lifecycle';

// 首页主视觉：指针光晕与轻微的 3D 倾斜。
onPageLoad((signal) => {
  const hero = document.querySelector<HTMLElement>('[data-hero]');
  if (!hero) return;
  const tilt = hero.querySelector<HTMLElement>('[data-tilt]');
  const reduced = prefersReducedMotion();

  hero.addEventListener(
    'pointermove',
    (event) => {
      const rect = hero.getBoundingClientRect();
      hero.style.setProperty('--px', `${event.clientX - rect.left}px`);
      hero.style.setProperty('--py', `${event.clientY - rect.top}px`);

      if (!tilt || reduced || event.pointerType !== 'mouse') return;
      const box = tilt.getBoundingClientRect();
      const x = (event.clientX - box.left) / box.width - 0.5;
      const y = (event.clientY - box.top) / box.height - 0.5;
      tilt.style.setProperty('--rx', `${(-y * 5).toFixed(2)}deg`);
      tilt.style.setProperty('--ry', `${(x * 6).toFixed(2)}deg`);
    },
    { passive: true, signal },
  );

  hero.addEventListener(
    'pointerleave',
    () => {
      tilt?.style.setProperty('--rx', '0deg');
      tilt?.style.setProperty('--ry', '0deg');
    },
    { signal },
  );
});
