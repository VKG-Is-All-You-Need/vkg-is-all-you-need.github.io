import { bow, CIRCLED, round, years } from '../shared';
import type { LayoutDef, Point, Shape } from '../types';

const PX_PER_YEAR = 42;
const PAD_X = 30;
const TOP = 46;
const BOTTOM = 34;
const PITCH = 13;
/** 一列最多堆叠的星点数，超过时在同一年内并排多列。 */
const MAX_ROWS = 18;

/** 堆叠：每年一列，论文按主题自下而上堆叠，形如点阵柱状图。 */
export const stack: LayoutDef = {
  id: 'stack',
  label: { zh: '堆叠', en: 'Stacked' },
  icon: '<path d="M3 13.5v-3M6.3 13.5v-7M9.6 13.5v-5M12.9 13.5v-10"/>',
  build(ctx) {
    const xOf = (year: number) => PAD_X + (year - ctx.from) * PX_PER_YEAR;
    const width = xOf(ctx.to) + PAD_X;
    const maxCount = Math.max(...ctx.perYear);
    const rows = Math.min(MAX_ROWS, maxCount);
    const base = TOP + rows * PITCH + 4;
    const height = base + BOTTOM;

    const positions: Record<string, Point> = {};
    const progress: Record<string, number> = {};
    for (const star of ctx.stars) {
      const columns = Math.ceil(star.yearSize / MAX_ROWS);
      const column = Math.floor(star.yearIndex / MAX_ROWS);
      const row = star.yearIndex % MAX_ROWS;
      const x = xOf(star.year) + (column - (columns - 1) / 2) * 12;
      positions[star.id] = { x: round(x), y: round(base - PITCH / 2 - row * PITCH) };
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
          height: base,
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
    shapes.push({ tag: 'line', class: 'baseline', x1: 0, x2: width, y1: base, y2: base });
    for (const year of years(ctx)) {
      const major = year % 5 === 0;
      const x = xOf(year);
      const count = ctx.perYear[year - ctx.from];
      shapes.push({
        tag: 'text',
        class: major ? 'tick-label tick-major' : 'tick-label',
        x,
        y: base + 18,
        text: major || year === ctx.to ? String(year) : `'${String(year).slice(2)}`,
      });
      if (count) {
        const top = base - Math.min(count, MAX_ROWS) * PITCH;
        shapes.push({
          tag: 'text',
          class: 'bar-count',
          x,
          y: top - 6,
          'data-p': round((x / width) * 1000) / 1000,
          text: String(count),
        });
      }
    }

    return {
      width,
      height,
      fit: false,
      positions,
      progress,
      link: (a, b) => bow(a, b, -0.22),
      sweep: { kind: 'line' },
      shapes,
    };
  },
};
