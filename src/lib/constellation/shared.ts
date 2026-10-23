import type { Point, SkyContext, SkyStar } from './types';

export const round = (n: number): number => Math.round(n * 10) / 10;

export const polar = (cx: number, cy: number, r: number, a: number): Point => ({
  x: cx + r * Math.cos(a),
  y: cy + r * Math.sin(a),
});

export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const PATTERNS: [number, number][][] = [
  [[0, 0]],
  [
    [-0.5, 0],
    [0.5, 0],
  ],
  [
    [0, -0.5],
    [-0.58, 0.42],
    [0.58, 0.42],
  ],
  [
    [-0.5, -0.5],
    [0.5, -0.5],
    [-0.5, 0.5],
    [0.5, 0.5],
  ],
];

/** 一簇中第 index 颗星相对簇中心的偏移：四颗以内用固定图案，更多时按向日葵排布。 */
export function packOffset(index: number, size: number, spacing = 12): Point {
  if (size <= PATTERNS.length) {
    const [x, y] = PATTERNS[size - 1][index];
    return { x: x * spacing, y: y * spacing };
  }
  const r = spacing * 0.62 * Math.sqrt(index + 0.5);
  const a = index * GOLDEN_ANGLE;
  return { x: r * Math.cos(a), y: r * Math.sin(a) };
}

/** 一簇所占的半径（不含星点自身）。 */
export const packRadius = (size: number, spacing = 12): number =>
  size <= 1 ? 0 : size <= PATTERNS.length ? spacing * 0.75 : spacing * 0.62 * Math.sqrt(size);

export const pathOf = (points: Point[]): string =>
  points.map((p, i) => `${i ? 'L' : 'M'}${round(p.x)} ${round(p.y)}`).join(' ');

/** 年份在 [from, to] 中的位置（0–1）；年份范围只有一年时返回 0.5。 */
export const yearRatio = (ctx: SkyContext, year: number): number =>
  ctx.to === ctx.from ? 0.5 : (year - ctx.from) / (ctx.to - ctx.from);

/** 按年份的点亮进度：同一年内的论文再按序号稍微错开。 */
export const yearProgress = (ctx: SkyContext, star: SkyStar): number =>
  (star.year - ctx.from + (star.yearIndex + 0.5) / star.yearSize) / (ctx.to - ctx.from + 1);

export const years = (ctx: SkyContext): number[] =>
  Array.from({ length: ctx.to - ctx.from + 1 }, (_, i) => ctx.from + i);

/** 刻度年份：能被 step 整除的年份，加上首尾两年（与相邻刻度相差不到两年时省略）。 */
export const markYears = (ctx: SkyContext, step = 5): number[] => {
  const marks = years(ctx).filter((y) => y % step === 0);
  if (!marks.length || marks[0] - ctx.from >= 2) marks.unshift(ctx.from);
  if (ctx.to - marks[marks.length - 1] >= 2) marks.push(ctx.to);
  return marks;
};

export const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩';
