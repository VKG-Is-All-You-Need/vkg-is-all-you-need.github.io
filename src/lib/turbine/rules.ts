/**
 * 信号处理算子，对应 sigRL / SDRL 中的表达式：
 * 聚合（avg、min、max）、取值过滤 value(op, α)、持续时间 duration(>, t)、先后关系 after[t]，
 * 以及 STARQL 演示中的窗口内单调上升。信号是 1 Hz 的采样数组，读不到的采样点为 NaN。
 */

export interface Interval {
  /** 第一个满足条件的采样点。 */
  from: number;
  /** 最后一个满足条件的采样点。 */
  to: number;
  /** 截至 now 仍在持续，尚未结束。 */
  open: boolean;
}

export const length = (interval: Interval) => interval.to - interval.from;

type Reduce = (values: number[]) => number;

function combine(signals: Float32Array[], reduce: Reduce): Float32Array {
  const out = new Float32Array(signals[0]?.length ?? 0).fill(NaN);
  for (let t = 0; t < out.length; t++) {
    const values: number[] = [];
    for (const s of signals) if (!Number.isNaN(s[t])) values.push(s[t]);
    if (values.length) out[t] = reduce(values);
  }
  return out;
}

export const avg = (signals: Float32Array[]) =>
  combine(signals, (v) => v.reduce((a, b) => a + b, 0) / v.length);
export const min = (signals: Float32Array[]) => combine(signals, (v) => Math.min(...v));
export const max = (signals: Float32Array[]) => combine(signals, (v) => Math.max(...v));

/** value(op, α)：截至 now 满足条件的时段。NaN 视为不满足。 */
export function where(signal: Float32Array, now: number, test: (v: number) => boolean): Interval[] {
  const out: Interval[] = [];
  let start = -1;
  const last = Math.min(now, signal.length - 1);
  for (let t = 0; t <= last; t++) {
    const ok = !Number.isNaN(signal[t]) && test(signal[t]);
    if (ok && start < 0) start = t;
    if (!ok && start >= 0) {
      out.push({ from: start, to: t - 1, open: false });
      start = -1;
    }
  }
  if (start >= 0) out.push({ from: start, to: last, open: true });
  return out;
}

/** duration(>, t)：持续时间超过 t 秒的时段。 */
export const longer = (intervals: Interval[], seconds: number) =>
  intervals.filter((i) => length(i) > seconds);

export interface Pair {
  first: Interval;
  second: Interval;
}

/** C1 : after[t] C2：C2 的时段在某个已结束的 C1 时段之后 t 秒内开始。 */
export function after(first: Interval[], second: Interval[], within: number): Pair[] {
  const out: Pair[] = [];
  for (const b of second) {
    const a = first.find((a) => !a.open && b.from > a.to && b.from - a.to <= within);
    if (a) out.push({ first: a, second: b });
  }
  return out;
}

/** [from, to] 内的采样是否严格单调上升（含 NaN 时不成立）。 */
export function rising(signal: Float32Array, from: number, to: number): boolean {
  if (from < 0) return false;
  for (let t = from + 1; t <= to; t++) {
    if (Number.isNaN(signal[t]) || Number.isNaN(signal[t - 1]) || signal[t] <= signal[t - 1]) {
      return false;
    }
  }
  return true;
}

/** [from, to] 内可读的采样点。 */
export function samples(signal: Float32Array, from: number, to: number): number[] {
  const out: number[] = [];
  for (let t = Math.max(0, from); t <= Math.min(to, signal.length - 1); t++) {
    if (!Number.isNaN(signal[t])) out.push(signal[t]);
  }
  return out;
}

export const mean = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;

export const median = (values: number[]) => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** 截至 t 的最后一个可读采样点。 */
export function latest(signal: Float32Array, t: number): { t: number; value: number } | null {
  for (let i = Math.min(t, signal.length - 1); i >= 0; i--) {
    if (!Number.isNaN(signal[i])) return { t: i, value: signal[i] };
  }
  return null;
}
