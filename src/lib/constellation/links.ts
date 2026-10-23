// 连线形状：布局只声明样式，路径由 linkPath 计算。构建时与浏览器端（scripts/papers-fx.ts）共用，
// 这样连线再多，也不必把每种布局下的每条路径都写进页面。

export interface Point {
  x: number;
  y: number;
}

export type LinkStyle =
  /** 水平方向的三次曲线，适合横轴为时间的布局。 */
  | { kind: 'horizontal' }
  /**
   * 二次曲线，控制点从两点中点向 (cx, cy) 靠拢：pull 为 1 时是直线，为 0 时经过该点。
   * bend 大于 0 时，两点相对 (cx, cy) 的夹角越大，额外弯曲越多（夹角为 π 时 pull 减去 bend）。
   */
  | { kind: 'toward'; cx: number; cy: number; pull: number; bend?: number }
  /** 二次曲线，控制点沿法向偏移 amount 倍的两点距离；距离超过 far 时改用 farAmount。 */
  | { kind: 'bow'; amount: number; far?: number; farAmount?: number };

const r1 = (n: number) => Math.round(n * 10) / 10;

export function linkPath(style: LinkStyle, a: Point, b: Point): string {
  const start = `M${r1(a.x)} ${r1(a.y)}`;
  const end = `${r1(b.x)} ${r1(b.y)}`;
  if (style.kind === 'horizontal') {
    const dx = Math.max(Math.abs(b.x - a.x), 30) * 0.5;
    return `${start} C${r1(a.x + dx)} ${r1(a.y)} ${r1(b.x - dx)} ${r1(b.y)} ${end}`;
  }
  if (style.kind === 'toward') {
    const { cx, cy } = style;
    let pull = style.pull;
    if (style.bend) {
      const angle = Math.abs(
        Math.atan2(
          (a.x - cx) * (b.y - cy) - (a.y - cy) * (b.x - cx),
          (a.x - cx) * (b.x - cx) + (a.y - cy) * (b.y - cy),
        ),
      );
      pull -= style.bend * Math.min(1, angle / Math.PI);
    }
    const mx = cx + ((a.x + b.x) / 2 - cx) * pull;
    const my = cy + ((a.y + b.y) / 2 - cy) * pull;
    return `${start} Q${r1(mx)} ${r1(my)} ${end}`;
  }
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const amount =
    style.far !== undefined && Math.hypot(dx, dy) > style.far
      ? (style.farAmount ?? style.amount)
      : style.amount;
  return `${start} Q${r1((a.x + b.x) / 2 - dy * amount)} ${r1((a.y + b.y) / 2 + dx * amount)} ${end}`;
}
