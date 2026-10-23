import { GOLDEN_ANGLE, round, yearProgress, yearRatio } from '../shared';
import type { LayoutDef, Point, Shape } from '../types';

const WIDTH = 1068;
const HEIGHT = 680;
const PAD = 30;
const ITERATIONS = 300;

/**
 * 网络：按论文之间的关系做力导向布局（构建时计算，结果固定），算法与 d3-force 相同：
 * 所有论文相互排斥，有关系的论文由弹簧相连（弹簧强度按两端的连接数归一，避免被引很多的论文
 * 把整片拖成一团），另有指向中心的弱引力留住孤立的论文，以及按年份的弱横向引力，使早期论文偏左。
 */
export const network: LayoutDef = {
  id: 'network',
  label: { zh: '网络', en: 'Network' },
  icon: '<circle cx="3.5" cy="4" r="1.8"/><circle cx="12.5" cy="5" r="1.8"/><circle cx="7" cy="12" r="1.8"/><path d="M5.2 4.3 10.7 4.8M4.4 5.6 6.2 10.4M11.4 6.5 8.2 10.6"/>',
  build(ctx) {
    const n = ctx.stars.length;
    const index = new Map(ctx.stars.map((star, i) => [star.id, i]));
    const edges = ctx.links
      .map((link) => ({ a: index.get(link.from), b: index.get(link.to), kind: link.kind }))
      .filter(
        (e): e is { a: number; b: number; kind: typeof e.kind } =>
          e.a !== undefined && e.b !== undefined,
      );
    const degree = new Array<number>(n).fill(0);
    for (const { a, b } of edges) {
      degree[a]++;
      degree[b]++;
    }
    const spread = Math.sqrt(n) * 18;
    const timeX = (year: number) => (yearRatio(ctx, year) - 0.5) * spread * 2.2;

    // 初始位置：按序号排成向日葵，结果确定且不重叠
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    const vx = new Float64Array(n);
    const vy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const r = 10 * Math.sqrt(i + 0.5);
      x[i] = r * Math.cos(i * GOLDEN_ANGLE);
      y[i] = r * Math.sin(i * GOLDEN_ANGLE);
    }

    let alpha = 1;
    const alphaDecay = 1 - Math.pow(0.001, 1 / ITERATIONS);
    for (let iter = 0; iter < ITERATIONS; iter++) {
      alpha += (0 - alpha) * alphaDecay;
      // 弹簧：目标长度随连接数略增，强度为 1 / min(两端连接数)
      for (const { a, b, kind } of edges) {
        const ddx = x[b] + vx[b] - x[a] - vx[a] || 1e-6;
        const ddy = y[b] + vy[b] - y[a] - vy[a] || 1e-6;
        const d = Math.hypot(ddx, ddy);
        const target = kind === 'citation' ? 34 : 26;
        const strength = (kind === 'citation' ? 1 : 1.5) / Math.min(degree[a], degree[b]);
        const f = ((d - target) / d) * alpha * strength;
        const bias = degree[a] / (degree[a] + degree[b]);
        vx[b] -= ddx * f * bias;
        vy[b] -= ddy * f * bias;
        vx[a] += ddx * f * (1 - bias);
        vy[a] += ddy * f * (1 - bias);
      }
      // 相互排斥
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const ddx = x[j] - x[i] || 1e-6;
          const ddy = y[j] - y[i] || 1e-6;
          const d2 = Math.max(ddx * ddx + ddy * ddy, 4);
          if (d2 > 160000) continue;
          const f = (-60 * alpha) / d2;
          vx[j] -= ddx * f;
          vy[j] -= ddy * f;
          vx[i] += ddx * f;
          vy[i] += ddy * f;
        }
      }
      for (let i = 0; i < n; i++) {
        // 指向中心的弱引力，以及按年份的横向引力
        // 没有任何关系的论文引力更强，避免它们漂到远处、把主体压小
        const pull = degree[i] ? 0.06 : 0.3;
        vx[i] += (timeX(ctx.stars[i].year) - x[i]) * (pull / 2) * alpha;
        vy[i] += -y[i] * pull * alpha;
        vx[i] *= 0.6;
        vy[i] *= 0.6;
        x[i] += vx[i];
        y[i] += vy[i];
      }
    }

    // 等比缩放到画布内
    const minX = Math.min(...x);
    const maxX = Math.max(...x);
    const minY = Math.min(...y);
    const maxY = Math.max(...y);
    const innerW = WIDTH - PAD * 2;
    const innerH = HEIGHT - PAD * 2 - 16;
    const scale = Math.min(innerW / Math.max(1, maxX - minX), innerH / Math.max(1, maxY - minY));
    const ox = WIDTH / 2 - ((minX + maxX) / 2) * scale;
    const oy = PAD + 16 + innerH / 2 - ((minY + maxY) / 2) * scale;

    const positions: Record<string, Point> = {};
    const progress: Record<string, number> = {};
    ctx.stars.forEach((star, i) => {
      positions[star.id] = { x: round(ox + x[i] * scale), y: round(oy + y[i] * scale) };
      progress[star.id] = round(yearProgress(ctx, star) * 1000) / 1000;
    });

    const shapes: Shape[] = [
      {
        tag: 'text',
        class: 'network-note',
        x: WIDTH - 20,
        y: 18,
        text:
          ctx.lang === 'zh'
            ? '关系越紧密的论文距离越近 · 早期论文偏左'
            : 'Closely related papers sit together · Earlier papers lean left',
      },
    ];

    return {
      width: WIDTH,
      height: HEIGHT,
      fit: true,
      positions,
      progress,
      link: { kind: 'bow', amount: 0.08 },
      sweep: { kind: 'none' },
      shapes,
    };
  },
};
