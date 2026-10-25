import { onPageLoad } from './lifecycle';

const phrases = [
  'Things, connected',
  'Knowledge, linked',
  'Data, in context',
  'Connections matter',
];

onPageLoad((signal) => {
  const text = document.querySelector<HTMLElement>('[data-brand-typewriter]');
  const brand = text?.closest('.brand');
  if (!text || !brand) return;

  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let phrase = 0;
  let position = phrases[0].length;
  let deleting = true;
  let timer: ReturnType<typeof setTimeout>;

  const schedule = (delay: number) => {
    timer = setTimeout(tick, delay);
  };
  const tick = () => {
    if (signal.aborted || motion.matches) return;
    // Keep the current phrase readable while the link is being used or the tab is hidden.
    if (
      document.hidden ||
      text.getClientRects().length === 0 ||
      brand.matches(':hover, :focus-within')
    ) {
      schedule(500);
      return;
    }
    text.dataset.typing = 'true';
    position += deleting ? -1 : 1;
    text.textContent = phrases[phrase].slice(0, position);
    if (deleting && position === 0) {
      deleting = false;
      phrase = (phrase + 1) % phrases.length;
      schedule(600);
    } else if (!deleting && position === phrases[phrase].length) {
      deleting = true;
      delete text.dataset.typing;
      schedule(20000);
    } else {
      schedule(deleting ? 80 : 140);
    }
  };

  const reset = () => {
    clearTimeout(timer);
    phrase = 0;
    position = phrases[0].length;
    deleting = true;
    text.textContent = phrases[0];
    delete text.dataset.typing;
    if (!motion.matches) schedule(20000);
  };
  motion.addEventListener('change', reset, { signal });
  signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  reset();
});
