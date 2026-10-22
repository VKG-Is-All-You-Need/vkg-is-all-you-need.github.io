type Init = (signal: AbortSignal) => void;

/**
 * 在每次页面加载（含 ClientRouter 的站内跳转）后执行 init。
 * 传入的 signal 会在离开页面时中止，用于移除事件监听、停止动画循环。
 */
export function onPageLoad(init: Init): void {
  let controller: AbortController | null = null;
  document.addEventListener('astro:page-load', () => {
    controller?.abort();
    controller = new AbortController();
    init(controller.signal);
  });
  document.addEventListener('astro:before-swap', () => {
    controller?.abort();
    controller = null;
  });
}

export const prefersReducedMotion = (): boolean =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 元素进入视口时为 true，离开时为 false。 */
export function watchVisibility(
  element: Element,
  callback: (visible: boolean) => void,
  signal: AbortSignal,
  rootMargin = '0px',
): void {
  const observer = new IntersectionObserver(([entry]) => callback(entry.isIntersecting), {
    rootMargin,
  });
  observer.observe(element);
  signal.addEventListener('abort', () => observer.disconnect());
}
