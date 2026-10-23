import { markYears, packOffset, polar, round, years, yearRatio } from '../shared';
import type { LayoutDef, Point, Shape } from '../types';

const WIDTH = 1068;
const HEIGHT = 720;
const CX = WIDTH / 2;
const CY = HEIGHT / 2;
const R0 = 34;
const R1 = 318;
/** 每年旋转的角度，使扇区呈旋臂状。 */
const TWIST = (Math.PI / 180) * 1.1;

/** 放射：圆心为最早的年份，向外渐晚；每个主题一个扇区，扇区随年份略微旋转。 */
export const radial: LayoutDef = {
  id: 'radial',
  label: { zh: '放射', en: 'Radial' },
  icon: '<circle cx="8" cy="8" r="1.6"/><circle cx="8" cy="8" r="4.2"/><circle cx="8" cy="8" r="6.6"/>',
  build(ctx) {
    const sector = (Math.PI * 2) / ctx.topics.length;
    const rOf = (year: number) => R0 + yearRatio(ctx, year) * (R1 - R0);
    const angleOf = (edge: number, year: number) =>
      -Math.PI / 2 + edge * sector + (year - ctx.from) * TWIST;
    // 簇的大小随相邻两年之间的径向距离缩放
    const spacing = Math.min(12, ((R1 - R0) / Math.max(1, ctx.to - ctx.from)) * 1.1);

    const positions: Record<string, Point> = {};
    const progress: Record<string, number> = {};
    for (const star of ctx.stars) {
      // 扇区内按年份错开角度，避免同一主题的星点排成一条射线；簇内偏移沿切向与径向展开
      const a =
        angleOf(star.topic + 0.5, star.year) +
        Math.sin(star.year * 2.3 + star.topic * 1.7) * sector * 0.28;
      const base = polar(CX, CY, rOf(star.year), a);
      const o = packOffset(star.cellIndex, star.cellSize, spacing);
      const x = base.x - o.x * Math.sin(a) + o.y * Math.cos(a);
      const y = base.y + o.x * Math.cos(a) + o.y * Math.sin(a);
      positions[star.id] = { x: round(x), y: round(y) };
      progress[star.id] = round((Math.hypot(x - CX, y - CY) / (R1 + 10)) * 1000) / 1000;
    }

    const shapes: Shape[] = [];
    const half = (R1 - R0) / Math.max(1, ctx.to - ctx.from) / 2;
    ctx.eras.forEach((era, i) => {
      const inner = rOf(era.from) - half;
      const outer = rOf(era.to) + half;
      shapes.push({
        tag: 'circle',
        class: i % 2 ? 'ring-era ring-era-alt' : 'ring-era',
        cx: CX,
        cy: CY,
        r: round((inner + outer) / 2),
        'stroke-width': round(outer - inner),
      });
    });
    for (const year of markYears(ctx).filter((y) => y !== ctx.from)) {
      // 年份刻度标在第一条扇区分界线上，那里离星点最远
      const at = polar(CX, CY, rOf(year), angleOf(0, year));
      shapes.push(
        { tag: 'circle', class: 'ring-year', cx: CX, cy: CY, r: round(rOf(year)) },
        {
          tag: 'text',
          class: 'ring-year-label',
          x: round(at.x),
          y: round(at.y + 3.5),
          text: String(year),
        },
      );
    }
    ctx.topics.forEach((topic, i) => {
      const points = years(ctx).map((year) => polar(CX, CY, rOf(year), angleOf(i, year)));
      const start = polar(CX, CY, R0 - 12, angleOf(i, ctx.from));
      shapes.push({
        tag: 'path',
        class: 'spoke',
        d: [start, ...points]
          .map((p, j) => `${j ? 'L' : 'M'}${round(p.x)} ${round(p.y)}`)
          .join(' '),
      });
      const a = angleOf(i + 0.5, ctx.to);
      const at = polar(CX, CY, R1 + 26, a);
      const cos = Math.cos(a);
      shapes.push({
        tag: 'text',
        class: 'rim-label',
        x: round(at.x),
        y: round(at.y + 4),
        'text-anchor': cos > 0.25 ? 'start' : cos < -0.25 ? 'end' : 'middle',
        style: `--c:${topic.color}`,
        text: topic.short,
      });
    });
    shapes.push(
      { tag: 'circle', class: 'core', cx: CX, cy: CY, r: R0 - 6, fill: 'url(#core-glow)' },
      { tag: 'text', class: 'core-label', x: CX, y: CY + 4, text: String(ctx.from) },
    );

    return {
      width: WIDTH,
      height: HEIGHT,
      fit: true,
      positions,
      progress,
      // 跨扇区的连线向圆心弯曲，夹角越大弯得越多；相邻的星点之间接近直线
      link: { kind: 'toward', cx: CX, cy: CY, pull: 1, bend: 0.5 },
      sweep: { kind: 'ripple', cx: CX, cy: CY, r: R1 + 10 },
      shapes,
    };
  },
};
