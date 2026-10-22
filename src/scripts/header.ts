import { onPageLoad } from './lifecycle';

const isApple = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

onPageLoad((signal) => {
  document.querySelectorAll('[data-mod-key]').forEach((element) => {
    element.textContent = isApple ? '⌘' : 'Ctrl';
  });

  // 记住读者选择的语言，供站外进入首页时使用（见 BaseLayout）。
  document.querySelectorAll<HTMLElement>('[data-lang-switch]').forEach((link) => {
    link.addEventListener(
      'click',
      () => {
        try {
          localStorage.setItem('lang', link.dataset.langSwitch!);
        } catch {
          // 隐私模式下 localStorage 可能不可用，忽略即可。
        }
      },
      { signal },
    );
  });

  const header = document.querySelector<HTMLElement>('[data-header]');
  if (!header) return;
  const en = document.documentElement.lang === 'en';

  const syncScrolled = () => header.toggleAttribute('data-scrolled', window.scrollY > 8);
  syncScrolled();
  window.addEventListener('scroll', syncScrolled, { passive: true, signal });

  const button = header.querySelector<HTMLButtonElement>('[data-menu-toggle]');
  const menu = document.getElementById('mobile-nav');
  if (!button || !menu) return;

  const setOpen = (open: boolean) => {
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute(
      'aria-label',
      en ? (open ? 'Close menu' : 'Open menu') : open ? '关闭菜单' : '打开菜单',
    );
    header.toggleAttribute('data-menu-open', open);
    menu.hidden = !open;
  };

  button.addEventListener('click', () => setOpen(menu.hidden), { signal });
  menu.addEventListener(
    'click',
    (event) => {
      if ((event.target as Element).closest('a')) setOpen(false);
    },
    { signal },
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && !menu.hidden) {
        setOpen(false);
        button.focus();
      }
    },
    { signal },
  );
});
