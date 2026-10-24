/**
 * 合成的传感器信号：每台机组按预设的运行过程（转速、火焰、出力的关键帧）生成 1 Hz 信号，
 * 叠加由固定种子决定的噪声。温度经一阶滞后逼近目标值，故障时在指定喷嘴上叠加单调升温。
 *
 * 预设过程对应论文中的诊断任务：
 * A1 点火失败后清吹并重新点火；A2 清吹后转速停在 760 rpm，清吹未完成，启动中止；
 * A3 与 B1 喷嘴温度在 10 秒内单调上升后报故障；A3 的 2 号转速传感器自 06:20 起读数不变；
 * B2 加速中火焰丢失跳闸，停转后重新启动；B3 按调度计划停机，2 号轴承检修后振动偏高。
 */
import {
  MODELS,
  sensorByTag,
  sensorsOf,
  turbineById,
  type PlantId,
  type Sensor,
  type TurbineId,
} from './fleet';
import { LIVE_RETENTION, SAMPLES, lastBatch } from './time';

type Keyframes = [number, number][];

interface Scenario {
  speed: Keyframes;
  /** 有火焰的时段 [起, 止)。 */
  flame: [number, number][];
  power: Keyframes;
  tipFault?: { tip: number; start: number; end: number; rate: number };
  /** 某个转速传感器自 from 起读数不变。 */
  stuck?: { index: number; from: number };
  /** 排气温度相对参考曲线的固定偏差（°C），模拟压气机结垢。 */
  exhaustOffset?: number;
  /** 某个轴承的振动基值与一小时内的增量（mm/s）。 */
  vibration?: { bearing: number; base: number; drift: number };
}

const END = SAMPLES;

export const SCENARIOS: Record<TurbineId, Scenario> = {
  A1: {
    speed: [
      [0, 0],
      [240, 0],
      [290, 600],
      [318, 600],
      [333, 1420],
      [430, 1420],
      [444, 760],
      [460, 600],
      [490, 600],
      [840, 3000],
    ],
    flame: [
      [300, 318],
      [480, END],
    ],
    power: [
      [0, 0],
      [900, 0],
      [901, 2],
      [2100, 55],
    ],
  },
  A2: {
    speed: [
      [0, 0],
      [600, 0],
      [645, 550],
      [674, 550],
      [684, 1120],
      [760, 1120],
      [775, 760],
      [930, 760],
      [1050, 0],
    ],
    flame: [[660, 674]],
    power: [[0, 0]],
  },
  A3: {
    speed: [[0, 3000]],
    flame: [[0, END]],
    power: [
      [0, 52],
      [2465, 52],
      [2550, 30],
    ],
    tipFault: { tip: 4, start: 2450, end: 2463, rate: 9 },
    stuck: { index: 2, from: 1200 },
  },
  B1: {
    speed: [[0, 3000]],
    flame: [[0, END]],
    power: [
      [0, 50],
      [1405, 50],
      [1500, 35],
    ],
    tipFault: { tip: 3, start: 1390, end: 1403, rate: 8 },
    exhaustOffset: 22,
  },
  B2: {
    speed: [
      [0, 0],
      [600, 0],
      [640, 1120],
      [720, 1120],
      [750, 550],
      [765, 550],
      [870, 1850],
      [910, 1300],
      [967, 55],
      [975, 0],
      [1800, 0],
      [1840, 1120],
      [1920, 1120],
      [1950, 550],
      [1965, 550],
      [2310, 3000],
    ],
    flame: [
      [765, 870],
      [1965, END],
    ],
    power: [
      [0, 0],
      [2400, 0],
      [2401, 2],
      [3360, 35],
    ],
  },
  B3: {
    speed: [
      [0, 3000],
      [3000, 3000],
      [3060, 2600],
      [3150, 1800],
      [3240, 1000],
      [3360, 400],
      [3510, 60],
      [3570, 0],
    ],
    flame: [[0, 3000]],
    power: [
      [0, 45],
      [2700, 45],
      [3000, 0],
    ],
    vibration: { bearing: 2, base: 4.2, drift: 0.8 },
  },
};

/** 关键帧之间线性插值，两端取端点值。 */
export function interpolate(frames: Keyframes, t: number): number {
  if (t <= frames[0][0]) return frames[0][1];
  for (let i = 1; i < frames.length; i++) {
    const [t1, v1] = frames[i];
    if (t <= t1) {
      const [t0, v0] = frames[i - 1];
      return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
    }
  }
  return frames[frames.length - 1][1];
}

/** 由种子决定的 [-1, 1] 噪声。 */
function noise(seed: number, t: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(t + 1, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

export const flameOn = (turbine: TurbineId, t: number) =>
  SCENARIOS[turbine].flame.some(([from, to]) => t >= from && t < to);

/** 电厂的环境温度（°C）与相对湿度（%）。 */
export function ambientAt(plant: PlantId, t: number) {
  const x = t / 3600;
  return plant === 'A'
    ? { temp: 3 + 2.2 * x + 0.15 * Math.sin(t / 700), humidity: 82 - 6 * x }
    : { temp: 16 + 5 * x + 0.2 * Math.sin(t / 650), humidity: 55 - 7 * x };
}

const TIP_OFFSETS = [-6, 3, -2, 5, -4, 1];

/** 一阶滞后：升温与降温的时间常数不同。 */
function lag(target: (t: number) => number, rise: number, fall: number, start: number) {
  const out = new Float32Array(SAMPLES);
  let value = start;
  for (let t = 0; t < SAMPLES; t++) {
    const goal = target(t);
    const tau = goal > value ? rise : fall;
    value += (goal - value) * (1 - Math.exp(-1 / tau));
    out[t] = value;
  }
  return out;
}

function generate(sensor: Sensor): Float32Array {
  const turbine = turbineById.get(sensor.turbine)!;
  const model = MODELS[turbine.model];
  const scenario = SCENARIOS[turbine.id];
  const seed = sensor.dbId * 7919;
  const speed = (t: number) => interpolate(scenario.speed, t);
  const power = (t: number) => interpolate(scenario.power, t);
  const ambient = (t: number) => ambientAt(turbine.plant, t).temp;
  const out = new Float32Array(SAMPLES);

  switch (sensor.kind) {
    case 'speed': {
      for (let t = 0; t < SAMPLES; t++) {
        const base = speed(t);
        out[t] = base > 5 ? base + (sensor.index - 2) * 0.6 + noise(seed, t) * 1.5 : 0;
      }
      const stuck = scenario.stuck;
      if (stuck && stuck.index === sensor.index) {
        const frozen = Math.round(out[stuck.from] * 10) / 10;
        out.fill(frozen, stuck.from);
      }
      return out;
    }
    case 'flame':
      for (let t = 0; t < SAMPLES; t++) out[t] = flameOn(turbine.id, t) ? 1 : 0;
      return out;
    case 'power':
      for (let t = 0; t < SAMPLES; t++) {
        const base = power(t);
        out[t] = base > 1 ? base + noise(seed, t) * 0.25 : 0;
      }
      return out;
    case 'tip': {
      const offset = TIP_OFFSETS[sensor.index - 1];
      const target = (t: number) =>
        flameOn(turbine.id, t)
          ? 420 + 60 * (speed(t) / 3000) + 100 * (power(t) / model.capacity) + offset
          : ambient(t);
      const lagged = lag(target, 25, 150, target(0));
      const fault = scenario.tipFault?.tip === sensor.index ? scenario.tipFault : undefined;
      for (let t = 0; t < SAMPLES; t++) {
        let extra = 0;
        if (fault && t >= fault.start) {
          const peak = fault.rate * (fault.end - fault.start);
          extra =
            t <= fault.end
              ? fault.rate * (t - fault.start)
              : 35 + (peak - 35) * Math.exp(-(t - fault.end) / 60);
        }
        out[t] = lagged[t] + extra + noise(seed, t) * 0.8;
      }
      return out;
    }
    case 'exhaust': {
      const offset = scenario.exhaustOffset ?? 0;
      const target = (t: number) => {
        const amb = ambient(t);
        if (!flameOn(turbine.id, t)) return amb;
        const spin = 0.5 + 0.5 * (speed(t) / 3000);
        return (
          amb +
          (model.exhaustBase - amb) * spin +
          model.exhaustSlope * (power(t) / model.capacity) +
          model.ambientCoef * (amb - 15) +
          offset
        );
      };
      const lagged = lag(target, 40, 200, target(0));
      for (let t = 0; t < SAMPLES; t++) out[t] = lagged[t] + noise(seed, t) * 1;
      return out;
    }
    case 'vibration': {
      const special = scenario.vibration?.bearing === sensor.index ? scenario.vibration : undefined;
      const base = 1.7 + 0.25 * (sensor.index - 1) + 0.15 * noise(seed, -1);
      for (let t = 0; t < SAMPLES; t++) {
        const level = special ? special.base + (special.drift * t) / 3600 : base;
        const spin = Math.min(1, speed(t) / 3000) ** 1.5;
        out[t] = spin > 0.001 ? Math.max(0, level * spin + noise(seed, t) * 0.06) : 0;
      }
      return out;
    }
  }
}

const cache = new Map<string, Float32Array>();

/** 传感器在整个时段内的完整信号。 */
export function signal(tag: string): Float32Array {
  let values = cache.get(tag);
  if (!values) {
    values = generate(sensorByTag.get(tag)!);
    cache.set(tag, values);
  }
  return values;
}

export type SourceKey = 'hist_a' | 'hist_b' | 'live';

/**
 * 某一采样点在 now 时刻能否读到，以及来自哪个数据源：
 * 截至最近一次入库的数据在历史库中，最近 10 分钟的数据在实时流中。
 */
export function originOf(
  plant: PlantId,
  t: number,
  now: number,
  sources: ReadonlySet<string>,
): SourceKey | null {
  if (t > now) return null;
  const historian = plant === 'A' ? 'hist_a' : 'hist_b';
  if (sources.has(historian) && t <= lastBatch(now)) return historian;
  if (sources.has('live') && t > now - LIVE_RETENTION) return 'live';
  return null;
}

let observedKey = '';
const observedCache = new Map<string, Float32Array>();

/** now 时刻、在当前接入的数据源下可以读到的信号；读不到的采样点为 NaN。 */
export function observed(tag: string, now: number, sources: ReadonlySet<string>): Float32Array {
  const key = `${now}|${[...sources].sort().join(',')}`;
  if (key !== observedKey) {
    observedKey = key;
    observedCache.clear();
  }
  let values = observedCache.get(tag);
  if (values) return values;
  const full = signal(tag);
  const plant = turbineById.get(sensorByTag.get(tag)!.turbine)!.plant;
  values = new Float32Array(SAMPLES).fill(NaN);
  for (let t = 0; t <= Math.min(now, SAMPLES - 1); t++) {
    if (originOf(plant, t, now, sources)) values[t] = full[t];
  }
  observedCache.set(tag, values);
  return values;
}

/** 历史库 B 以华氏度存储温度。 */
export const toFahrenheit = (celsius: number) => (celsius * 9) / 5 + 32;

/** 某机组某类传感器的标签。 */
export const tagsOf = (turbine: TurbineId, kind: Sensor['kind']) =>
  sensorsOf(turbine, kind).map((s) => s.tag);
