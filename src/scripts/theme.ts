import { onPageLoad, prefersReducedMotion } from './lifecycle';

type Theme = 'light' | 'dark';

const root = document.documentElement;
const current = (): Theme => (root.dataset.theme === 'light' ? 'light' : 'dark');

function apply(theme: Theme): void {
  root.dataset.theme = theme;
  try {
    localStorage.setItem('theme', theme);
  } catch {
    // 隐私模式下 localStorage 可能不可用，忽略即可。
  }
}

function toggle(button: HTMLElement): void {
  const next: Theme = current() === 'dark' ? 'light' : 'dark';
  if (!('startViewTransition' in document) || prefersReducedMotion()) {
    apply(next);
    return;
  }

  // 以按钮为圆心，圆形扩散切换主题。
  const rect = button.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));

  root.classList.add('theme-transition');
  const transition = document.startViewTransition(() => apply(next));
  transition.ready.then(() => {
    root.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      {
        duration: 600,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        pseudoElement: '::view-transition-new(root)',
      },
    );
  });
  transition.finished.finally(() => root.classList.remove('theme-transition'));
}

onPageLoad((signal) => {
  document.querySelectorAll<HTMLElement>('[data-theme-toggle]').forEach((button) => {
    button.addEventListener('click', () => toggle(button), { signal });
  });
});
