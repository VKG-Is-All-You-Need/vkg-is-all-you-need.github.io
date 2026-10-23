/**
 * 模拟时间：自周一 00:00 起的秒数，覆盖一周。每天的演示范围为 06:00–24:00，
 * 播放到 24:00 时直接进入下一天的 06:00。
 */
import { term } from '../geo/names';

export const HOUR = 3600;
export const DAY = 24 * HOUR;
export const DAY_COUNT = 7;
/** 每天演示范围的起止（当天的秒数）。 */
export const DAY_START = 6 * HOUR;
export const DAY_END = 24 * HOUR;

export interface DayInfo {
  index: number;
  label: string;
  weekend: boolean;
}

export const DAYS: DayInfo[] = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map(
  (label, index) => ({ index, label, weekend: index >= 5 }),
);

export const hours = (h: number, m = 0) => h * HOUR + m * 60;

/** 某天某时刻的模拟时间。 */
export const at = (day: number, h: number, m = 0) => day * DAY + hours(h, m);

export const dayOf = (t: number) => Math.min(DAY_COUNT - 1, Math.max(0, Math.floor(t / DAY)));

/** 当天的秒数。 */
export const timeOfDay = (t: number) => t - dayOf(t) * DAY;

export const startOfDay = (day: number) => day * DAY + DAY_START;

/** 当天演示范围的最后一刻（23:59:59）。 */
export const endOfDay = (day: number) => day * DAY + DAY_END - 1;

export const isWeekend = (t: number) => DAYS[dayOf(t)].weekend;

export const formatTime = (t: number) => {
  const seconds = timeOfDay(t);
  const h = Math.floor(seconds / HOUR);
  const m = Math.floor((seconds % HOUR) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

export const formatDayTime = (t: number) => `${term(DAYS[dayOf(t)].label)} ${formatTime(t)}`;

/** 以 center 为峰值、width 为标准差（秒）的高斯曲线，峰值为 1。 */
export const bell = (t: number, center: number, width: number) =>
  Math.exp(-(((t - center) / width) ** 2));
