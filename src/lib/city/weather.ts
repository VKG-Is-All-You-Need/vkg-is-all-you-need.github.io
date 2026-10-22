/**
 * 气象：一周七天，每天一种主导天气。官方气象站每 10 分钟发布一条观测，包括气温、相对湿度、
 * 降水、能见度与风速。街区中的温湿度传感器以此为基准，再叠加各自位置的小气候差异（见 sensors.ts）。
 */
import {
  DAY,
  DAY_COUNT,
  DAY_START,
  HOUR,
  dayOf,
  endOfDay,
  hours,
  startOfDay,
  timeOfDay,
} from './time';

export type WeatherKind = 'sunny' | 'rain' | 'fog' | 'hot' | 'storm' | 'cloudy' | 'cold';

type EpisodeKind = 'rain' | 'storm' | 'drizzle' | 'fog';

interface Episode {
  kind: EpisodeKind;
  /** 起止为当天的秒数。 */
  start: number;
  end: number;
  peak: number;
  /** 渐强与渐弱的时长（秒）。 */
  ramp: number;
}

interface DayProfile {
  kind: WeatherKind;
  summary: string;
  low: number;
  high: number;
  /** 相对湿度的日变化范围（%）：午后最低，清晨与夜间最高。 */
  humidity: [number, number];
  /** 云量 0–1，随当天的小时变化。 */
  cloud: (h: number) => number;
  wind: number;
  episodes: Episode[];
  /** 冷空气过境：气温随时间持续下降（°C/小时）。 */
  trend?: number;
}

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const smooth = (x: number) => x * x * (3 - 2 * x);
const episode = (
  kind: EpisodeKind,
  from: [number, number],
  to: [number, number],
  peak: number,
  rampMinutes: number,
): Episode => ({ kind, start: hours(...from), end: hours(...to), peak, ramp: rampMinutes * 60 });

const PROFILES: DayProfile[] = [
  {
    kind: 'sunny',
    summary: '晴',
    low: 13,
    high: 23,
    humidity: [40, 78],
    cloud: () => 0.1,
    wind: 2.2,
    episodes: [],
  },
  {
    kind: 'rain',
    summary: '多云转中雨',
    low: 14,
    high: 21,
    humidity: [55, 86],
    cloud: (h) => clamp(0.4 + (h - 11) * 0.12, 0.4, 0.95),
    wind: 3.4,
    episodes: [episode('rain', [16, 0], [18, 30], 0.95, 20)],
  },
  {
    kind: 'fog',
    summary: '晨雾转多云',
    low: 12,
    high: 20,
    humidity: [62, 97],
    cloud: () => 0.55,
    wind: 1.1,
    episodes: [episode('fog', [3, 0], [9, 40], 1, 70)],
  },
  {
    kind: 'hot',
    summary: '晴热',
    low: 18,
    high: 29,
    humidity: [30, 66],
    cloud: () => 0.05,
    wind: 1.8,
    episodes: [],
  },
  {
    kind: 'storm',
    summary: '午后雷阵雨',
    low: 19,
    high: 27,
    humidity: [45, 88],
    cloud: (h) => clamp(0.15 + (h - 10.5) * 0.3, 0.15, 1) * (h > 17 ? 0.7 : 1),
    wind: 3,
    episodes: [episode('storm', [14, 20], [15, 40], 1, 12)],
  },
  {
    kind: 'cloudy',
    summary: '多云',
    low: 15,
    high: 22,
    humidity: [50, 80],
    cloud: () => 0.6,
    wind: 2.6,
    episodes: [],
  },
  {
    kind: 'cold',
    summary: '大风降温',
    low: 7,
    high: 14,
    humidity: [62, 90],
    cloud: () => 0.88,
    wind: 9,
    episodes: [episode('drizzle', [10, 0], [13, 0], 0.35, 25)],
    trend: -0.4,
  },
];

const profileOf = (t: number) => PROFILES[dayOf(t)];

function episodeIntensity(e: Episode, seconds: number): number {
  if (seconds <= e.start || seconds >= e.end) return 0;
  const k = Math.min(1, (seconds - e.start) / e.ramp, (e.end - seconds) / e.ramp);
  return e.peak * smooth(k);
}

const intensity = (t: number, kinds: EpisodeKind[]) => {
  const seconds = timeOfDay(t);
  return profileOf(t)
    .episodes.filter((e) => kinds.includes(e.kind))
    .reduce((max, e) => Math.max(max, episodeIntensity(e, seconds)), 0);
};

/** 降水强度 0–1（含雷阵雨与毛毛雨）。 */
export const rainAt = (t: number) => intensity(t, ['rain', 'storm', 'drizzle']);
/** 雷阵雨强度 0–1。 */
export const stormAt = (t: number) => intensity(t, ['storm']);
/** 雾的浓度 0–1。 */
export const fogAt = (t: number) => intensity(t, ['fog']);

/** 降雨结束后逐渐消退的影响：降温、湿度偏高。 */
function afterRain(t: number): number {
  const seconds = timeOfDay(t);
  return profileOf(t)
    .episodes.filter((e) => e.kind === 'rain' || e.kind === 'storm')
    .reduce(
      (max, e) =>
        seconds >= e.end ? Math.max(max, e.peak * Math.exp(-(seconds - e.end) / (2 * HOUR))) : max,
      0,
    );
}

/** 日变化曲线：06:00 为 0，14:30 达到 1，之后逐渐回落。 */
function diurnal(t: number): number {
  const h = timeOfDay(t) / HOUR;
  return h <= 14.5
    ? Math.sin(clamp((h - 6) / 8.5, 0, 1) * (Math.PI / 2))
    : 1 - 0.7 * ((h - 14.5) / 9.5);
}

/** 日照强度 0–1：白天且无云时为 1。 */
export function sunAt(t: number): number {
  const h = timeOfDay(t) / HOUR;
  const daylight = Math.max(0, Math.sin((Math.PI * (h - 6.3)) / 12.4));
  return daylight * (1 - cloudAt(t));
}

export function cloudAt(t: number): number {
  const profile = profileOf(t);
  return clamp(
    Math.max(profile.cloud(timeOfDay(t) / HOUR), 0.95 * rainAt(t), 0.7 * fogAt(t)),
    0,
    1,
  );
}

export function windAt(t: number): number {
  const profile = profileOf(t);
  const seconds = timeOfDay(t);
  const gust = profile.trend ? 0.3 * Math.sin(seconds / 700) : 0;
  const wind =
    profile.wind * (1 + 0.25 * Math.sin(seconds / 2400 + dayOf(t)) + gust) + 11 * stormAt(t);
  return Math.max(0, wind);
}

export function temperatureAt(t: number): number {
  const profile = profileOf(t);
  const h = timeOfDay(t) / HOUR;
  const base = profile.trend
    ? profile.high + profile.trend * (h - 6) + Math.sin(clamp((h - 6) / 12, 0, 1) * Math.PI)
    : profile.low + (profile.high - profile.low) * diurnal(t);
  return base - 4 * rainAt(t) - 1.5 * fogAt(t) - 3.5 * afterRain(t);
}

export function humidityAt(t: number): number {
  const [low, high] = profileOf(t).humidity;
  let rh = high - (high - low) * diurnal(t);
  rh += (96 - rh) * rainAt(t);
  rh += (99 - rh) * fogAt(t);
  rh += (92 - rh) * 0.6 * afterRain(t);
  return clamp(rh, 10, 100);
}

export function visibilityAt(t: number): number {
  const clear = 15000 * (1 - 0.6 * rainAt(t) - 0.15 * stormAt(t));
  const fog = fogAt(t);
  // 按对数插值：浓雾时能见度降到百米左右
  return Math.exp(Math.log(clear) * (1 - fog) + Math.log(110) * fog);
}

export type Condition =
  '晴' | '多云' | '阴' | '小雨' | '中雨' | '大雨' | '雷阵雨' | '雾' | '大雾' | '大风';

export interface Observation {
  ts: number;
  temperature: number;
  /** 相对湿度（%）。 */
  humidity: number;
  /** 10 分钟降水量（毫米）。 */
  precipitation: number;
  /** 能见度（米）。 */
  visibility: number;
  /** 平均风速（米/秒）。 */
  wind: number;
  condition: Condition;
}

function conditionOf(o: Omit<Observation, 'condition'>, storm: number, cloud: number): Condition {
  if (storm > 0.2) return '雷阵雨';
  if (o.precipitation >= 3) return '大雨';
  if (o.precipitation >= 1.2) return '中雨';
  if (o.precipitation > 0) return '小雨';
  if (o.visibility < 500) return '大雾';
  if (o.visibility < 1000) return '雾';
  if (o.wind >= 8) return '大风';
  if (cloud >= 0.8) return '阴';
  return cloud >= 0.35 ? '多云' : '晴';
}

/** 官方气象站在 t 所在 10 分钟内的观测记录。 */
export function observationAt(t: number): Observation {
  const ts = Math.floor(t / 600) * 600;
  const mid = ts + 300;
  const storm = stormAt(mid);
  const rain = rainAt(mid);
  const visibility = visibilityAt(mid);
  const record = {
    ts,
    temperature: Math.round(temperatureAt(mid) * 10) / 10,
    humidity: Math.round(humidityAt(mid)),
    precipitation: Math.round(rain * (storm > 0 ? 5 : 2.4) * 10) / 10,
    visibility:
      visibility < 2000 ? Math.round(visibility / 10) * 10 : Math.round(visibility / 100) * 100,
    wind: Math.round(windAt(mid) * 10) / 10,
  };
  return { ...record, condition: conditionOf(record, storm, cloudAt(mid)) };
}

/** 当天截至 until、满足条件的观测时段（按 10 分钟观测记录判定）。 */
function windowsWhere(until: number, test: (o: Observation) => boolean): [number, number][] {
  const day = dayOf(until);
  const windows: [number, number][] = [];
  for (let ts = startOfDay(day); ts < Math.min(until, endOfDay(day)); ts += 600) {
    if (!test(observationAt(ts))) continue;
    const end = Math.min(ts + 600, until);
    const last = windows.at(-1);
    if (last && last[1] === ts) last[1] = end;
    else windows.push([ts, end]);
  }
  return windows;
}

/** 当天截至 until 的降水时段。 */
export const rainWindows = (until: number) => windowsWhere(until, (o) => o.precipitation > 0);

/** 当天截至 until 的恶劣天气时段：有降水、能见度不足 1000 米或风速达到 8 米/秒。 */
export const badWeatherWindows = (until: number) =>
  windowsWhere(until, (o) => o.precipitation > 0 || o.visibility < 1000 || o.wind >= 8);

/** 当天截至 until 的不利天气时段：有降水或能见度不足 1000 米。 */
export const adverseWindows = (until: number) =>
  windowsWhere(until, (o) => o.precipitation > 0 || o.visibility < 1000);

export interface DayWeather {
  kind: WeatherKind;
  summary: string;
  low: number;
  high: number;
}

/** 每天的天气概况：按 06:00–24:00 的逐时气温取最低与最高值。 */
export const DAY_WEATHER: DayWeather[] = Array.from({ length: DAY_COUNT }, (_, day) => {
  const temps: number[] = [];
  for (let t = startOfDay(day); t <= endOfDay(day); t += HOUR / 2) temps.push(temperatureAt(t));
  const profile = PROFILES[day];
  return {
    kind: profile.kind,
    summary: profile.summary,
    low: Math.round(Math.min(...temps)),
    high: Math.round(Math.max(...temps)),
  };
});

/** 当天的天气时段，用于时间轴标记。 */
export function weatherEpisodes(day: number): { kind: EpisodeKind; start: number; end: number }[] {
  return PROFILES[day].episodes.map((e) => ({
    kind: e.kind,
    start: day * DAY + Math.max(e.start, DAY_START),
    end: day * DAY + e.end,
  }));
}
