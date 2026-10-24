/**
 * 设备诊断示例的模拟时间：2026-10-24 06:00 起的秒数，覆盖一小时，采样间隔 1 秒。
 * 历史库每 10 分钟批量入库一次，实时流保留最近 10 分钟。
 */
import { tr } from '../../i18n/runtime';

export const DATE = '2026-10-24';
/** 演示时长（秒）。 */
export const SPAN = 3600;
/** 采样点数（含 07:00:00）。 */
export const SAMPLES = SPAN + 1;
/** 历史库的批量入库间隔（秒）。 */
export const BATCH = 600;
/** 实时流保留的时长（秒）。 */
export const LIVE_RETENTION = 600;

/** 06:mm:ss 对应的秒数。 */
export const m = (minutes: number, seconds = 0) => minutes * 60 + seconds;

/** 截至 now 已入库的最后一个批次的结束时刻。 */
export const lastBatch = (now: number) => Math.floor(now / BATCH) * BATCH;

const pad = (n: number) => String(n).padStart(2, '0');

/** 06:41:03 */
export const formatTime = (t: number) => {
  const s = Math.max(0, Math.round(t));
  return `${pad(6 + Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
};

/** 06:41 */
export const formatMinute = (t: number) => formatTime(t).slice(0, 5);

/** 以秒或分钟表示的时长。 */
export const formatSpan = (seconds: number) => {
  const s = Math.round(seconds);
  if (s < 120) return tr(`${s} 秒`, `${s} s`);
  const minutes = Math.floor(s / 60);
  const rest = s % 60;
  if (!rest) return tr(`${minutes} 分钟`, `${minutes} min`);
  return tr(`${minutes} 分 ${rest} 秒`, `${minutes} min ${rest} s`);
};
