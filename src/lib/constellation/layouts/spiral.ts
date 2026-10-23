import { curveToward, markYears, pathOf, polar, round } from '../shared';
import type { LayoutDef, Point, Shape } from '../types';

const WIDTH = 1068;
const HEIGHT = 720;
const CX = WIDTH / 2;
const CY = HEIGHT / 2;
const R0 = 30;
const R1 = 318;
const TURNS = 3;
const START = -Math.PI / 2;

/**
 * 螺旋：一条时间线从圆心盘旋向外，每年占相同的角度，外圈越长、能容纳的论文越多。
 * 同一年的论文沿螺线均匀排开，主题决定相对螺线的少许偏移。
 */
export const spiral: LayoutDef = {
  id: 'spiral',
  label: { zh: '螺旋', en: 'Spiral' },
  icon: '<path d="M8 8.6a.9.9 0 1 1 .9-.9 1.9 1.9 0 0 1-1.9 1.9A2.9 2.9 0 0 1 4.1 6.7a3.9 3.9 0 0 1 3.9-3.9 4.9 4.9 0 0 1 4.9 4.9 5.9 5.9 0 0 1-5.9 5.9"/>',
  build(ctx) {
    // t 为时间在 [from, to + 1) 中的位置，螺线上的角度与半径都随 t 线性增长
    const span = ctx.to + 1 - ctx.from;
    const at = (t: number, offset = 0): Point => {
      const a = START + t * TURNS * Math.PI * 2;
      return polar(CX, CY, R0 + t * (R1 - R0) + offset, a);
    };
    const tOf = (time: number) => (time - ctx.from) / span;
    const spread = Math.min(8, ((R1 - R0) / TURNS) * 0.08);
    const mid = (ctx.topics.length - 1) / 2;

    const positions: Record<string, Point> = {};
    const progress: Record<string, number> = {};
    for (const star of ctx.stars) {
      const t = tOf(star.year + (star.yearIndex + 0.5) / star.yearSize);
      const p = at(t, ((star.topic - mid) / Math.max(1, mid)) * spread);
      positions[star.id] = { x: round(p.x), y: round(p.y) };
      progress[star.id] = round(t * 1000) / 1000;
    }

    const samples = Array.from({ length: 481 }, (_, i) => at(i / 480));
    const d = pathOf(samples);
    const shapes: Shape[] = [{ tag: 'path', class: 'spiral', d }];
    // 每个时期在螺线上的一段用略亮的线标出
    ctx.eras.forEach((era, i) => {
      const t0 = tOf(era.from);
      const t1 = tOf(era.to + 1);
      const n = Math.max(2, Math.ceil((t1 - t0) * 160));
      const seg = Array.from({ length: n + 1 }, (_, j) => at(t0 + ((t1 - t0) * j) / n));
      shapes.push({
        tag: 'path',
        class: i % 2 ? 'spiral-era spiral-era-alt' : 'spiral-era',
        d: pathOf(seg),
      });
      const label = at((t0 + t1) / 2, -18);
      shapes.push({
        tag: 'text',
        class: 'spiral-era-label',
        x: round(label.x),
        y: round(label.y + 3),
        text: era.label,
      });
    });
    for (const year of markYears(ctx)) {
      const t = tOf(year);
      const dot = at(t);
      const label = at(t, 16);
      shapes.push(
        { tag: 'circle', class: 'spiral-mark', cx: round(dot.x), cy: round(dot.y), r: 2 },
        {
          tag: 'text',
          class: 'spiral-year',
          x: round(label.x),
          y: round(label.y + 3.5),
          text: String(year),
        },
      );
    }

    return {
      width: WIDTH,
      height: HEIGHT,
      fit: true,
      positions,
      progress,
      link: (a, b) => curveToward(a, b, CX, CY, 0.8),
      sweep: { kind: 'trace', d },
      shapes,
    };
  },
};
