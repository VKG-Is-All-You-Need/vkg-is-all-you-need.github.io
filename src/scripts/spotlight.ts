import { onPageLoad } from './lifecycle';

// 记录指针在 .spotlight 元素内的位置，供 CSS 径向渐变使用。
onPageLoad((signal) => {
  document.addEventListener(
    'pointermove',
    (event) => {
      const card = (event.target as Element | null)?.closest<HTMLElement>('.spotlight');
      if (!card) return;
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${event.clientX - rect.left}px`);
      card.style.setProperty('--my', `${event.clientY - rect.top}px`);
    },
    { passive: true, signal },
  );
});
