/**
 * 在横向滚动的画布容器内放置提示卡片，(x, y) 为锚点在容器内容中的坐标（x 含 scrollLeft）。
 * 优先放在锚点下方，其次上方；上下都放不下时放在左侧或右侧，并限制在容器的可见范围内。
 * 卡片不能遮住锚点，否则指针移到卡片上会触发锚点的 pointerleave，卡片随即关闭又重新打开。
 */
export function placeTip(
  tip: HTMLElement,
  scroller: HTMLElement,
  x: number,
  y: number,
  maxWidth: number,
): void {
  tip.style.width = `${Math.min(maxWidth, scroller.clientWidth - 16)}px`;
  const width = tip.offsetWidth;
  const height = tip.offsetHeight;
  const viewLeft = scroller.scrollLeft + 8;
  const viewRight = scroller.scrollLeft + scroller.clientWidth - 8;
  const viewHeight = scroller.clientHeight;
  const gap = 18;
  const clampX = (left: number) => Math.min(Math.max(viewLeft, left), viewRight - width);

  let left: number;
  let top: number;
  if (y + gap + height <= viewHeight - 6) {
    left = clampX(x - 24);
    top = y + gap;
  } else if (y - gap - height >= 6) {
    left = clampX(x - 24);
    top = y - gap - height;
  } else {
    top = Math.min(Math.max(6, y - height / 2), Math.max(6, viewHeight - height - 6));
    left = x + gap + width <= viewRight ? x + gap : Math.max(viewLeft, x - gap - width);
  }
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}
