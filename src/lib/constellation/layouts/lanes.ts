import { CIRCLED, packOffset, packRadius, round, years } from '../shared';
import type { LayoutDef, Point, Shape } from '../types';

const PX_PER_YEAR = 42;
const PAD_X = 30;
const AXIS_H = 44;
const HIST_H = 46;

/** 泳道：横轴为年份，每个主题一条泳道；底部是每年论文数的柱状条。 */
export const lanes: LayoutDef = {
  id: 'lanes',
  label: { zh: '泳道', en: 'Lanes' },
  icon: '<path d="M2 4h12M2 8h12M2 12h12"/>',
  build(ctx) {
    const xOf = (year: number) => PAD_X + (year - ctx.from) * PX_PER_YEAR;
    const width = xOf(ctx.to) + PAD_X;
    // 泳道高度随最大的一簇增长
    const maxCell = Math.max(...ctx.stars.map((s) => s.cellSize));
    const laneH = Math.max(38, Math.ceil(packRadius(maxCell) * 2 + 20));
    const lanesBottom = AXIS_H + ctx.topics.length * laneH;
    const height = lanesBottom + HIST_H;

    const positions: Record<string, Point> = {};
    const progress: Record<string, number> = {};
    for (const star of ctx.stars) {
      const offset = packOffset(star.cellIndex, star.cellSize);
      const x = xOf(star.year) + offset.x;
      positions[star.id] = {
        x: round(x),
        y: round(AXIS_H + (star.topic + 0.5) * laneH + offset.y),
      };
      progress[star.id] = round((x / width) * 1000) / 1000;
    }

    const shapes: Shape[] = [];
    ctx.eras.forEach((era, i) => {
      const x0 = xOf(era.from) - PX_PER_YEAR / 2;
      const x1 = xOf(era.to) + PX_PER_YEAR / 2;
      shapes.push(
        {
          tag: 'rect',
          class: i % 2 ? 'era era-alt' : 'era',
          x: x0,
          y: 0,
          width: x1 - x0,
          height: lanesBottom,
        },
        {
          tag: 'text',
          class: 'era-label',
          x: x0 + 8,
          y: 15,
          text: `${CIRCLED[i] ?? ''} ${era.label}`,
        },
      );
    });
    ctx.topics.forEach((_, i) => {
      const y = AXIS_H + (i + 1) * laneH;
      shapes.push({ tag: 'line', class: 'grid', x1: 0, x2: width, y1: y, y2: y });
    });
    for (const year of years(ctx)) {
      const major = year % 5 === 0;
      const x = xOf(year);
      shapes.push(
        {
          tag: 'line',
          class: major ? 'tick tick-major' : 'tick',
          x1: x,
          x2: x,
          y1: AXIS_H - 6,
          y2: lanesBottom,
        },
        {
          tag: 'text',
          class: major ? 'tick-label tick-major' : 'tick-label',
          x,
          y: AXIS_H - 12,
          text: major || year === ctx.to ? String(year) : `'${String(year).slice(2)}`,
        },
      );
    }
    const maxPerYear = Math.max(...ctx.perYear);
    ctx.perYear.forEach((count, i) => {
      if (!count) return;
      const x = xOf(ctx.from + i);
      const h = 4 + (count / maxPerYear) * (HIST_H - 18);
      const p = round((x / width) * 1000) / 1000;
      shapes.push(
        {
          tag: 'rect',
          class: 'bar',
          x: x - 7,
          y: height - 8 - h,
          width: 14,
          height: round(h),
          rx: 2,
          'data-p': p,
        },
        {
          tag: 'text',
          class: 'bar-count',
          x,
          y: round(height - 12 - h),
          'data-p': p,
          text: String(count),
        },
      );
    });

    return {
      width,
      height,
      fit: false,
      positions,
      progress,
      link(a, b) {
        const dx = Math.max(Math.abs(b.x - a.x), 30) * 0.5;
        return `M${a.x} ${a.y} C${round(a.x + dx)} ${a.y} ${round(b.x - dx)} ${b.y} ${b.x} ${b.y}`;
      },
      sweep: { kind: 'line' },
      shapes,
      rows: ctx.topics.map((_, i) => ({ top: AXIS_H + i * laneH, height: laneH })),
      notes: [
        {
          top: lanesBottom,
          height: HIST_H,
          text: ctx.lang === 'zh' ? '每年论文数' : 'Papers per year',
        },
      ],
    };
  },
};
