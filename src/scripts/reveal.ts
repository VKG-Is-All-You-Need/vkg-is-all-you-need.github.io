import { onPageLoad, prefersReducedMotion } from './lifecycle';

onPageLoad((signal) => {
  const items = document.querySelectorAll<HTMLElement>('[data-reveal]:not(.is-revealed)');
  if (items.length === 0) return;

  if (prefersReducedMotion()) {
    items.forEach((item) => item.classList.add('is-revealed'));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-revealed');
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -6% 0px', threshold: 0.06 },
  );
  items.forEach((item) => observer.observe(item));
  signal.addEventListener('abort', () => observer.disconnect());
});
