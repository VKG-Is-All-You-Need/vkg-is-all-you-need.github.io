import { bow, GOLDEN_ANGLE, round, yearProgress } from '../shared';
import type { LayoutDef, Point, Shape } from '../types';

const WIDTH = 1068;
const SPACING = 15;
const PAD_Y = 24;

/**
 * 星团：每个主题聚成一团，团内按向日葵排布，最早的论文在中心、越晚越靠外。
 * 星团排成网格，大小随论文数增长；最后一行不满时居中。
 */
export const clusters: LayoutDef = {
  id: 'clusters',
  label: { zh: '星团', en: 'Clusters' },
  icon: '<circle cx="5" cy="5.5" r="2.4"/><circle cx="11.2" cy="6" r="2.8"/><circle cx="7.4" cy="11.6" r="2.6"/>',
  build(ctx) {
    const n = ctx.topics.length;
    const cols = Math.min(n, Math.ceil(Math.sqrt(n)));
    const rowsCount = Math.ceil(n / cols);
    const sizes = ctx.topics.map((_, i) => ctx.stars.filter((s) => s.topic === i).length);
    const radiusOf = (count: number) => SPACING * 0.62 * Math.sqrt(Math.max(1, count)) + 14;
    const maxR = Math.max(...sizes.map(radiusOf));
    const cellW = WIDTH / cols;
    const cellH = maxR * 2 + 64;
    const height = Math.ceil(PAD_Y * 2 + rowsCount * cellH);

    const centers = ctx.topics.map((_, i) => {
      const row = Math.floor(i / cols);
      const inRow = Math.min(cols, n - row * cols);
      const col = i - row * cols;
      return {
        x: WIDTH / 2 + (col - (inRow - 1) / 2) * cellW,
        y: PAD_Y + row * cellH + cellH / 2 - 10,
      };
    });

    const positions: Record<string, Point> = {};
    const progress: Record<string, number> = {};
    for (const star of ctx.stars) {
      const c = centers[star.topic];
      const r = SPACING * 0.62 * Math.sqrt(star.topicIndex + 0.5);
      const a = star.topicIndex * GOLDEN_ANGLE + star.topic;
      positions[star.id] = { x: round(c.x + r * Math.cos(a)), y: round(c.y + r * Math.sin(a)) };
      progress[star.id] = round(yearProgress(ctx, star) * 1000) / 1000;
    }

    const shapes: Shape[] = [];
    ctx.topics.forEach((topic, i) => {
      const c = centers[i];
      const r = radiusOf(sizes[i]);
      const topicStars = ctx.stars.filter((s) => s.topic === i);
      const first = Math.min(...topicStars.map((s) => s.year));
      const last = Math.max(...topicStars.map((s) => s.year));
      shapes.push(
        {
          tag: 'circle',
          class: 'cluster-halo',
          cx: round(c.x),
          cy: round(c.y),
          r: round(r),
          style: `--c:${topic.color}`,
        },
        {
          tag: 'circle',
          class: 'cluster-orbit',
          cx: round(c.x),
          cy: round(c.y),
          r: round(r + 8),
          style: `--c:${topic.color}`,
        },
        {
          tag: 'text',
          class: 'cluster-label',
          x: round(c.x),
          y: round(c.y + r + 26),
          style: `--c:${topic.color}`,
          text: topic.short,
        },
        {
          tag: 'text',
          class: 'cluster-meta',
          x: round(c.x),
          y: round(c.y + r + 41),
          text: topicStars.length
            ? `${topicStars.length} · ${first === last ? first : `${first}–${last}`}`
            : '0',
        },
      );
    });

    return {
      width: WIDTH,
      height,
      fit: true,
      positions,
      progress,
      // 跨星团的连线画成弧线，同一星团内接近直线
      link: (a, b) => bow(a, b, Math.hypot(b.x - a.x, b.y - a.y) > 120 ? 0.18 : 0.08),
      sweep: { kind: 'none' },
      shapes,
    };
  },
};
