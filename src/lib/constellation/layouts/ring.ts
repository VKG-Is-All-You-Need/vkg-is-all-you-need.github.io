import { polar, round, yearProgress, yearRatio } from '../shared';
import type { LayoutDef, Point, Shape } from '../types';

const WIDTH = 1068;
const HEIGHT = 720;
const CX = WIDTH / 2;
const CY = HEIGHT / 2;
const R = 262;
/** 星点所在环带的宽度：环内侧最早，外侧最晚。 */
const BAND = 44;
const GAP = 0.05;

/** 环形：论文按主题围成一圈，同一主题内按年份排列；传承关系画成穿过圆心的弦。 */
export const ring: LayoutDef = {
  id: 'ring',
  label: { zh: '环形', en: 'Ring' },
  icon: '<circle cx="8" cy="8" r="6"/><path d="M3.6 5.2Q8 8 12.4 10.8M4.2 11.6Q8 8 11.6 4"/>',
  build(ctx) {
    const n = ctx.stars.length;
    const step = (Math.PI * 2 - GAP * ctx.topics.length) / Math.max(1, n);
    // 按主题排序后依次占位，每个主题之后留一段空隙
    const ordered = [...ctx.stars].sort((a, b) => a.topic - b.topic || a.topicIndex - b.topicIndex);
    const angle = new Map<string, number>();
    const spans: { from: number; to: number }[] = ctx.topics.map(() => ({ from: 0, to: 0 }));
    let a = -Math.PI / 2 + GAP / 2;
    let current = -1;
    for (const star of ordered) {
      if (star.topic !== current) {
        if (current >= 0) a += GAP;
        current = star.topic;
        spans[current].from = a;
      }
      angle.set(star.id, a + step / 2);
      a += step;
      spans[current].to = a;
    }

    const positions: Record<string, Point> = {};
    const progress: Record<string, number> = {};
    for (const star of ctx.stars) {
      const r = R - BAND / 2 + yearRatio(ctx, star.year) * BAND;
      const p = polar(CX, CY, r, angle.get(star.id)!);
      positions[star.id] = { x: round(p.x), y: round(p.y) };
      progress[star.id] = round(yearProgress(ctx, star) * 1000) / 1000;
    }

    const shapes: Shape[] = [
      { tag: 'circle', class: 'ring-band', cx: CX, cy: CY, r: R, 'stroke-width': BAND + 14 },
      { tag: 'circle', class: 'ring-edge', cx: CX, cy: CY, r: R - BAND / 2 - 7 },
      { tag: 'circle', class: 'ring-edge', cx: CX, cy: CY, r: R + BAND / 2 + 7 },
      {
        tag: 'text',
        class: 'ring-note',
        x: CX,
        y: CY - 6,
        text: ctx.lang === 'zh' ? '内侧较早 · 外侧较晚' : 'Inner: earlier · Outer: later',
      },
      {
        tag: 'text',
        class: 'ring-note ring-note-years',
        x: CX,
        y: CY + 12,
        text: `${ctx.from}–${ctx.to}`,
      },
    ];
    ctx.topics.forEach((topic, i) => {
      const span = spans[i];
      if (span.to <= span.from) return;
      const r = R + BAND / 2 + 16;
      const p0 = polar(CX, CY, r, span.from);
      const p1 = polar(CX, CY, r, span.to);
      const large = span.to - span.from > Math.PI ? 1 : 0;
      shapes.push({
        tag: 'path',
        class: 'ring-arc',
        d: `M${round(p0.x)} ${round(p0.y)} A${r} ${r} 0 ${large} 1 ${round(p1.x)} ${round(p1.y)}`,
        style: `--c:${topic.color}`,
      });
      const mid = (span.from + span.to) / 2;
      const at = polar(CX, CY, r + 16, mid);
      const cos = Math.cos(mid);
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

    return {
      width: WIDTH,
      height: HEIGHT,
      fit: true,
      positions,
      progress,
      link: { kind: 'toward', cx: CX, cy: CY, pull: 0.12 },
      sweep: { kind: 'none' },
      shapes,
    };
  },
};
