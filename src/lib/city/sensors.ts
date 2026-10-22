/**
 * 物联网平台中的温湿度传感器：装在路灯杆、屋顶与公园中，每分钟上报一次。
 * 读数以官方气象站为基准，叠加各自位置的小气候差异：中心区与屋顶在日照下更热，公园更凉、更湿，
 * 临水处湿度偏高。个别传感器在某些时段出现故障（离线、湿度卡死、温度漂移），用于演示数据质量校验。
 */
import { city } from '../geo/city';
import { rectCenter, seededRandom, type Point } from '../geo/spatial';
import { EW_STREETS, NS_STREETS } from './roads';
import { at } from './time';
import { humidityAt, sunAt, temperatureAt } from './weather';

export type Mount = '路灯杆' | '屋顶' | '公园';

export interface EnvSensor {
  id: string;
  at: Point;
  mount: Mount;
  /** 屋顶传感器所在的建筑。 */
  buildingId?: number;
  /** 城市热岛强度 0–1：日照下比气象站热多少。 */
  urban: number;
  /** 绿地降温 0–1。 */
  green: number;
  /** 临水，湿度偏高。 */
  water?: boolean;
}

/** 官方气象站，位于湖滨公园东南的开阔草地。 */
export const STATION = { id: 'WX01', name: '湖滨公园气象站', at: { x: 905, y: 675 } };

const building = (name: string) => city.buildings.find((b) => b.name === name)!;
const nearestHome = (p: Point) =>
  city.buildings
    .filter((b) => b.kind === '住宅')
    .map((b) => ({
      b,
      d: Math.hypot(rectCenter(b.footprint).x - p.x, rectCenter(b.footprint).y - p.y),
    }))
    .sort((a, b) => a.d - b.d)[0].b;
const roof = (b: (typeof city.buildings)[number]) => ({
  at: rectCenter(b.footprint),
  buildingId: b.id,
});

const mall = building('星河商场');
const housing = nearestHome({ x: 300, y: 620 });

export const ENV_SENSORS: EnvSensor[] = [
  { id: 'E01', at: { x: 493, y: 373 }, mount: '路灯杆', urban: 1, green: 0 },
  { id: 'E02', ...roof(mall), mount: '屋顶', urban: 1, green: 0 },
  { id: 'E03', at: { x: 467, y: 430 }, mount: '路灯杆', urban: 0.9, green: 0 },
  { id: 'E04', at: { x: 560, y: 373 }, mount: '路灯杆', urban: 0.85, green: 0 },
  { id: 'E05', at: { x: 333, y: 230 }, mount: '路灯杆', urban: 0.7, green: 0 },
  { id: 'E06', at: { x: 147, y: 193 }, mount: '路灯杆', urban: 0.4, green: 0 },
  { id: 'E07', at: { x: 173, y: 527 }, mount: '路灯杆', urban: 0.5, green: 0 },
  { id: 'E08', ...roof(housing), mount: '屋顶', urban: 0.45, green: 0 },
  { id: 'E09', at: { x: 905, y: 450 }, mount: '公园', urban: 0, green: 1 },
  { id: 'E10', at: { x: 780, y: 650 }, mount: '公园', urban: 0, green: 1, water: true },
  { id: 'E11', at: { x: 672, y: 470 }, mount: '公园', urban: 0, green: 0.8 },
  { id: 'E12', at: { x: 653, y: 300 }, mount: '路灯杆', urban: 0.6, green: 0 },
  { id: 'E13', at: { x: 653, y: 90 }, mount: '路灯杆', urban: 0.3, green: 0 },
  { id: 'E14', at: { x: 867, y: 167 }, mount: '路灯杆', urban: 0.2, green: 0, water: true },
  { id: 'E15', at: { x: 147, y: 300 }, mount: '路灯杆', urban: 0.35, green: 0 },
  { id: 'E16', at: { x: 100, y: 167 }, mount: '路灯杆', urban: 0.2, green: 0, water: true },
];

export const sensorById = new Map(ENV_SENSORS.map((sensor) => [sensor.id, sensor]));

export type FaultKind = 'offline' | 'stuck' | 'drift';

/** 故障时段：E13 电池耗尽离线；E09 在雷阵雨后进水，湿度卡在 100%；E05 外壳破损，温度偏高。 */
export const FAULTS: { sensor: string; kind: FaultKind; from: number; to: number }[] = [
  { sensor: 'E13', kind: 'offline', from: at(2, 5), to: at(2, 11, 30) },
  { sensor: 'E09', kind: 'stuck', from: at(4, 15, 10), to: Infinity },
  { sensor: 'E05', kind: 'drift', from: at(5, 12), to: Infinity },
];

const faultAt = (sensor: EnvSensor, t: number) =>
  FAULTS.find((f) => f.sensor === sensor.id && t >= f.from && t < f.to)?.kind;

export interface Reading {
  ts: number;
  temperature: number;
  humidity: number;
}

const noise = (sensor: EnvSensor, minute: number) =>
  seededRandom(Number(sensor.id.slice(1)) * 7919 + minute)() * 2 - 1;

/** 传感器在 t 所在分钟的读数；离线时为 null。 */
export function readingAt(sensor: EnvSensor, t: number): Reading | null {
  const ts = Math.floor(t / 60) * 60;
  const fault = faultAt(sensor, ts);
  if (fault === 'offline') return null;
  const sun = sunAt(ts);
  const n = noise(sensor, ts / 60);
  let temperature =
    temperatureAt(ts) +
    sensor.urban * (0.6 + 2.4 * sun) +
    (sensor.mount === '屋顶' ? 1.4 * sun - 0.4 : 0) -
    sensor.green * (0.4 + 1.3 * sun) +
    n * 0.25;
  let humidity =
    humidityAt(ts) -
    sensor.urban * (2 + 7 * sun) +
    sensor.green * 5 +
    (sensor.water ? 6 : 0) +
    n * 1.5;
  if (fault === 'drift') {
    temperature += 4.6;
    humidity -= 8;
  }
  if (fault === 'stuck') humidity = 100;
  return {
    ts,
    temperature: Math.round(temperature * 10) / 10,
    humidity: Math.round(Math.min(100, Math.max(10, humidity))),
  };
}

/** 设备离线的起始时刻（若 t 时离线）。 */
export const offlineSince = (sensor: EnvSensor, t: number) =>
  FAULTS.find((f) => f.sensor === sensor.id && f.kind === 'offline' && t >= f.from && t < f.to)
    ?.from;

/** 湿度连续卡在 100% 的起始时刻（若 t 时如此）。 */
export const stuckSince = (sensor: EnvSensor, t: number) =>
  FAULTS.find((f) => f.sensor === sensor.id && f.kind === 'stuck' && t >= f.from && t < f.to)?.from;

/** 半径内的其他传感器。 */
export const neighborsOf = (sensor: EnvSensor, radius = 340) =>
  ENV_SENSORS.filter(
    (other) =>
      other !== sensor && Math.hypot(other.at.x - sensor.at.x, other.at.y - sensor.at.y) <= radius,
  );

/** 安装位置的描述（来自城市基础数据：最近的路口或所在建筑）。 */
export function placeOf(sensor: EnvSensor): string {
  if (sensor.buildingId) {
    return `${city.buildings.find((b) => b.id === sensor.buildingId)!.name}屋顶`;
  }
  if (sensor.mount === '公园') return `${city.parks[0].name}${sensor.water ? '湖边' : ''}`;
  // 路灯杆在街道边：按坐标找到所在的南北向或东西向街道
  const { x, y } = sensor.at;
  const k = Math.round(x / 160);
  const m = Math.round(y / 180);
  const ns = Math.abs(x - k * 160) <= 20 ? NS_STREETS[k - 1] : undefined;
  const ew = Math.abs(y - m * 180) <= 20 ? EW_STREETS[m - 1] : undefined;
  if (ns && ew) return `${ns} × ${ew} 路口`;
  return ns ?? ew ?? '街道';
}
