/**
 * 信号轨道：在 canvas 上按时间对齐绘制若干轨道，标出阈值、规则命中的时段、时段之间的先后关系、
 * 控制系统事件、此刻与最近一次入库的位置，以及每个时刻的数据来自哪个数据源。
 */
import type { ChartSpec, Series, Track } from '../../lib/turbine/queries';
import { formatMinute, formatTime } from '../../lib/turbine/time';

export interface OriginSpan {
  from: number;
  to: number;
  color: string | null;
}

export interface ChartInput {
  spec: ChartSpec;
  window: [number, number];
  now: number;
  /** 最近一次入库的时刻；为 null 时不标出。 */
  batch: number | null;
  origins: OriginSpan[];
  labels: { now: string; batch: string };
}

interface Palette {
  ink: string;
  muted: string;
  faint: string;
  line: string;
  lineStrong: string;
  accent: string;
  warn: string;
  surface: string;
  font: string;
  mono: string;
}

const PAD = { left: 44, right: 14, top: 34, bottom: 34 };
const GAP = 22;
const ORIGIN_H = 5;

function palette(el: HTMLElement): Palette {
  const css = getComputedStyle(el);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    ink: v('--ink'),
    muted: v('--muted'),
    faint: v('--faint'),
    line: v('--line'),
    lineStrong: v('--line-strong'),
    accent: v('--accent'),
    warn: v('--warn'),
    surface: v('--surface'),
    font: v('--font-sans') || 'sans-serif',
    mono: v('--font-mono') || 'monospace',
  };
}

/** 十六进制颜色的半透明写法。 */
function alpha(color: string, a: number): string {
  const hex = color.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(hex)) return color;
  const n = parseInt(hex, 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export function seriesColor(series: Series, p: Palette): string {
  return { main: p.ink, muted: p.muted, hit: p.warn, plan: p.accent }[series.tone];
}

interface Layout {
  track: Track;
  top: number;
  height: number;
  min: number;
  max: number;
}

export class SignalChart {
  private ctx: CanvasRenderingContext2D;
  private p: Palette;
  private width = 0;
  private height = 0;
  private input: ChartInput | null = null;
  private layouts: Layout[] = [];
  private hover: number | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private tip: HTMLElement,
    signal: AbortSignal,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.p = palette(canvas);
    const resize = new ResizeObserver(() => this.resize());
    resize.observe(canvas.parentElement!);
    signal.addEventListener('abort', () => resize.disconnect());
    const theme = new MutationObserver(() => {
      this.p = palette(canvas);
      this.draw();
    });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    signal.addEventListener('abort', () => theme.disconnect());
    canvas.addEventListener('pointermove', (e) => this.move(e), { signal });
    canvas.addEventListener('pointerleave', () => this.leave(), { signal });
    this.resize();
  }

  get palette(): Palette {
    return this.p;
  }

  update(input: ChartInput) {
    this.input = input;
    this.draw();
    if (this.hover !== null) this.showTip(this.hover);
  }

  private resize() {
    const rect = this.canvas.parentElement!.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  private x(t: number) {
    const [a, b] = this.input!.window;
    return PAD.left + ((t - a) / (b - a)) * (this.width - PAD.left - PAD.right);
  }

  private t(x: number) {
    const [a, b] = this.input!.window;
    return a + ((x - PAD.left) / (this.width - PAD.left - PAD.right)) * (b - a);
  }

  private layout(): Layout[] {
    const { spec, window } = this.input!;
    const weights = spec.tracks.map((t) => (t.step ? 0.32 : 1));
    const total = weights.reduce((a, b) => a + b, 0);
    const usable = this.height - PAD.top - PAD.bottom - GAP * (spec.tracks.length - 1);
    let top = PAD.top;
    return spec.tracks.map((track, i) => {
      const height = (usable * weights[i]) / total;
      let min = Infinity;
      let max = -Infinity;
      if (track.step) {
        min = 0;
        max = 1;
      } else if (track.fixed) {
        [min, max] = track.fixed;
      } else {
        const from = Math.max(0, Math.floor(window[0]));
        const to = Math.ceil(window[1]);
        for (const s of track.series) {
          for (let t = from; t <= to && t < s.values.length; t++) {
            const v = s.values[t];
            if (Number.isNaN(v)) continue;
            if (v < min) min = v;
            if (v > max) max = v;
          }
        }
        for (const th of track.thresholds) {
          min = Math.min(min, th.value);
          max = Math.max(max, th.value);
        }
        if (!Number.isFinite(min)) {
          min = 0;
          max = 1;
        }
        const pad = Math.max(0, (track.minSpan ?? 0) - (max - min)) / 2;
        [min, max] = niceRange(min - pad, max + pad, min >= 0);
      }
      const layout = { track, top, height, min, max };
      top += height + GAP;
      return layout;
    });
  }

  private y(l: Layout, v: number) {
    return l.top + l.height - ((v - l.min) / (l.max - l.min)) * l.height;
  }

  draw() {
    const { ctx, p } = this;
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.input || this.width < 50 || this.height < 50) return;
    const { spec, window, now, batch, origins, labels } = this.input;
    this.layouts = this.layout();
    const left = PAD.left;
    const right = this.width - PAD.right;
    const bottom = this.height - PAD.bottom;
    ctx.font = `11px ${p.font}`;
    ctx.textBaseline = 'alphabetic';

    // 尚未到达的时段
    const nowX = this.x(now);
    if (nowX < right) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(
        Math.max(left, nowX),
        PAD.top - 4,
        right - Math.max(left, nowX),
        bottom - PAD.top + 4,
      );
      ctx.clip();
      ctx.strokeStyle = p.line;
      ctx.lineWidth = 1;
      for (let x = Math.max(left, nowX) - this.height; x < right; x += 7) {
        ctx.beginPath();
        ctx.moveTo(x, bottom);
        ctx.lineTo(x + this.height, bottom - this.height);
        ctx.stroke();
      }
      ctx.restore();
    }

    for (const l of this.layouts) this.drawTrack(l);

    // 控制系统事件
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = p.lineStrong;
    ctx.fillStyle = p.muted;
    ctx.font = `10.5px ${p.font}`;
    let lastLabel = -Infinity;
    for (const e of spec.events) {
      if (e.t < window[0] || e.t > window[1]) continue;
      const x = this.x(e.t);
      ctx.beginPath();
      ctx.moveTo(x, 14);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      if (x - lastLabel > 70) {
        ctx.textAlign = x > right - 60 ? 'right' : 'left';
        ctx.fillText(e.label, x + (x > right - 60 ? -3 : 3), 11);
        lastLabel = x;
      }
    }
    ctx.setLineDash([]);

    // 最近一次入库
    if (batch !== null && batch > window[0] && batch < window[1]) {
      const x = this.x(batch);
      ctx.strokeStyle = p.faint;
      ctx.setLineDash([1, 3]);
      ctx.beginPath();
      ctx.moveTo(x, PAD.top);
      ctx.lineTo(x, bottom + ORIGIN_H + 4);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 数据来源色带
    const bandY = bottom + 4;
    for (const o of origins) {
      const a = Math.max(o.from, window[0]);
      const b = Math.min(o.to, window[1]);
      if (b <= a) continue;
      const x0 = this.x(a);
      const x1 = this.x(b);
      if (o.color) {
        ctx.fillStyle = alpha(o.color, 0.7);
        ctx.fillRect(x0, bandY, Math.max(1, x1 - x0), ORIGIN_H);
      } else {
        ctx.strokeStyle = p.lineStrong;
        ctx.strokeRect(x0 + 0.5, bandY + 0.5, Math.max(1, x1 - x0 - 1), ORIGIN_H - 1);
      }
    }

    // 时间轴
    ctx.fillStyle = p.faint;
    ctx.font = `10.5px ${p.mono}`;
    ctx.textAlign = 'center';
    const span = window[1] - window[0];
    const step = [10, 30, 60, 120, 300, 600, 900].find((s) => span / s <= 8) ?? 900;
    for (let t = Math.ceil(window[0] / step) * step; t <= window[1]; t += step) {
      const x = this.x(t);
      ctx.fillText(step >= 60 ? formatMinute(t) : formatTime(t), x, this.height - 6);
    }

    // 此刻
    if (nowX >= left && nowX <= right) {
      ctx.strokeStyle = p.accent;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(nowX, PAD.top - 4);
      ctx.lineTo(nowX, bottom + ORIGIN_H + 4);
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = p.accent;
      ctx.font = `600 10.5px ${p.font}`;
      ctx.textAlign = nowX > right - 50 ? 'right' : 'left';
      ctx.fillText(labels.now, nowX + (nowX > right - 50 ? -4 : 4), bottom - 4);
    }

    if (this.hover !== null) this.drawHover(this.hover);
  }

  private drawTrack(l: Layout) {
    const { ctx, p } = this;
    const { track } = l;
    const left = PAD.left;
    const right = this.width - PAD.right;
    const [w0, w1] = this.input!.window;

    // 底线与标签
    ctx.strokeStyle = p.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, l.top + l.height + 0.5);
    ctx.lineTo(right, l.top + l.height + 0.5);
    ctx.stroke();
    ctx.fillStyle = p.muted;
    ctx.font = `600 11px ${p.font}`;
    ctx.textAlign = 'left';
    ctx.fillText(track.unit ? `${track.label} · ${track.unit}` : track.label, left, l.top - 6);
    if (!track.step) {
      ctx.fillStyle = p.faint;
      ctx.font = `10px ${p.mono}`;
      ctx.textAlign = 'right';
      ctx.fillText(axisValue(l.max), left - 6, l.top + 9);
      ctx.fillText(axisValue(l.min), left - 6, l.top + l.height - 1);
    }

    // 命中时段
    for (const m of track.marks) {
      const a = Math.max(m.from, w0);
      const b = Math.min(m.to, w1);
      if (b < a) continue;
      const x0 = this.x(a);
      const x1 = Math.max(this.x(b), x0 + 2);
      const color = m.tone === 'hit' ? p.warn : m.tone === 'miss' ? p.faint : p.accent;
      ctx.fillStyle = alpha(color, 0.14);
      ctx.fillRect(x0, l.top, x1 - x0, l.height);
      ctx.fillStyle = alpha(color, 0.9);
      ctx.fillRect(x0, l.top, x1 - x0, 2);
      ctx.font = `10.5px ${p.mono}`;
      ctx.textAlign = 'left';
      ctx.fillStyle = m.tone === 'hit' ? p.warn : p.muted;
      const text = m.label;
      const tw = ctx.measureText(text).width;
      const tx = Math.min(Math.max(x0 + 3, left + 2), right - tw - 2);
      ctx.fillText(text, tx, l.top + 13);
    }

    // 阈值
    ctx.setLineDash([4, 4]);
    for (const th of track.thresholds) {
      const y = this.y(l, th.value);
      ctx.strokeStyle = p.faint;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      ctx.fillStyle = p.faint;
      ctx.font = `10px ${p.font}`;
      ctx.textAlign = 'right';
      ctx.fillText(`${th.label} ${axisValue(th.value)}`, right - 2, y - 3);
    }
    ctx.setLineDash([]);

    // 曲线：次要曲线在下，命中曲线在上
    const order = { plan: 0, muted: 1, main: 2, hit: 3 } as const;
    const series = [...track.series].sort((a, b) => order[a.tone] - order[b.tone]);
    const from = Math.max(0, Math.floor(w0));
    const to = Math.ceil(w1);
    const px = (this.width - PAD.left - PAD.right) / Math.max(1, to - from);
    // 每个像素多于一个采样时取平均，避免噪声连成色块；阶梯信号保留原值
    const bucket = track.step ? 1 : Math.max(1, Math.floor(1 / px));
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, l.top - 2, right - left, l.height + 4);
    ctx.clip();
    for (const s of series) {
      ctx.strokeStyle = seriesColor(s, p);
      ctx.lineWidth = s.tone === 'muted' ? 1 : s.tone === 'plan' ? 1.4 : 1.7;
      ctx.globalAlpha = s.tone === 'muted' ? 0.75 : 1;
      if (s.tone === 'plan') ctx.setLineDash([5, 4]);
      ctx.beginPath();
      let pen = false;
      let prevY = 0;
      for (let t = from; t <= to && t < s.values.length; t += bucket) {
        let sum = 0;
        let n = 0;
        for (let k = t; k < t + bucket && k < s.values.length; k++) {
          if (!Number.isNaN(s.values[k])) {
            sum += s.values[k];
            n++;
          }
        }
        if (!n) {
          pen = false;
          continue;
        }
        const x = this.x(t + (bucket - 1) / 2);
        const y = this.y(l, sum / n);
        if (!pen) {
          ctx.moveTo(x, y);
          pen = true;
        } else if (track.step) {
          ctx.lineTo(x, prevY);
          ctx.lineTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        prevY = y;
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      if (track.step) {
        // 有火焰的时段填充
        ctx.fillStyle = alpha(seriesColor(s, p), 0.12);
        for (let t = from; t <= to && t < s.values.length; t++) {
          if (s.values[t] > 0.5)
            ctx.fillRect(this.x(t), this.y(l, 1), Math.max(px, 0.6), this.y(l, 0) - this.y(l, 1));
        }
      }
    }

    ctx.restore();

    // 时段之间的先后关系
    for (const link of track.links) {
      const x0 = this.x(Math.max(link.from, w0));
      const x1 = this.x(Math.min(link.to, w1));
      const y = l.top + l.height * 0.62;
      ctx.strokeStyle = link.ok ? p.ink : p.warn;
      ctx.fillStyle = link.ok ? p.ink : p.warn;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x0, y - 5);
      ctx.lineTo(x0, y + 5);
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.moveTo(x1, y - 5);
      ctx.lineTo(x1, y + 5);
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.font = `10.5px ${p.mono}`;
      const tw = ctx.measureText(link.label).width;
      const mid = (x0 + x1) / 2;
      const tx = Math.min(Math.max(mid - tw / 2, left + 2), right - tw - 2);
      ctx.fillStyle = alpha(p.surface, 0.85);
      ctx.fillRect(tx - 3, y - 17, tw + 6, 13);
      ctx.fillStyle = link.ok ? p.ink : p.warn;
      ctx.textAlign = 'left';
      ctx.fillText(link.label, tx, y - 7);
    }
  }

  private move(e: PointerEvent) {
    if (!this.input) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < PAD.left || x > this.width - PAD.right) return this.leave();
    this.hover = Math.round(this.t(x));
    this.draw();
    this.showTip(this.hover);
  }

  private leave() {
    this.hover = null;
    this.tip.hidden = true;
    this.draw();
  }

  private drawHover(t: number) {
    const { ctx, p } = this;
    const x = this.x(t);
    ctx.strokeStyle = p.lineStrong;
    ctx.beginPath();
    ctx.moveTo(x, PAD.top - 4);
    ctx.lineTo(x, this.height - PAD.bottom);
    ctx.stroke();
  }

  private showTip(t: number) {
    const rows: string[] = [];
    for (const l of this.layouts) {
      for (const s of l.track.series) {
        const v = s.values[t];
        if (v === undefined || Number.isNaN(v)) continue;
        const text = l.track.step ? (v > 0.5 ? 'ON' : 'OFF') : `${axisValue(v)} ${l.track.unit}`;
        rows.push(`<span>${escape(s.label)}</span> ${text}`);
      }
    }
    this.tip.innerHTML = `<b>${formatTime(t)}</b>${rows.length ? rows.join('<br>') : '—'}`;
    this.tip.hidden = false;
    const x = this.x(t);
    const w = this.tip.offsetWidth;
    this.tip.style.left = `${x + 12 + w > this.width ? x - w - 12 : x + 12}px`;
    this.tip.style.top = `${PAD.top}px`;
  }
}

const escape = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** 把纵轴范围扩展到整齐的刻度。 */
function niceRange(min: number, max: number, positive: boolean): [number, number] {
  const span = Math.max(max - min, Math.abs(max) * 0.02, 1);
  const raw = span / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const floor = Math.floor((min - span * 0.05) / step) * step;
  const lo = positive ? Math.max(0, floor) : floor;
  return [lo, Math.ceil((max + span * 0.1) / step) * step];
}

function axisValue(v: number) {
  const a = Math.abs(v);
  const digits = a >= 100 ? 0 : a >= 10 ? 1 : 2;
  return v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}
