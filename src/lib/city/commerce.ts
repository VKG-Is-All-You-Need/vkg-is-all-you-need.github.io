/**
 * 商店与客流。
 * - 物联网平台中的客流计数器只知道设备编号与所在建筑；
 * - 商户系统知道店名、类别与营业时间。
 * 两者通过 building_id 关联，这正是融合的意义所在。
 * 客流随工作日与周末、降雨、高温与大风变化。
 */
import { city, type Building } from '../geo/city';
import { seededRandom } from '../geo/spatial';
import { bell, hours, isWeekend, timeOfDay } from './time';
import { fogAt, rainAt, temperatureAt, windAt } from './weather';

export type ShopCategory = '咖啡' | '商场' | '茶室' | '便利店' | '花店' | '面包店';

export interface Shop {
  id: number;
  /** 客流传感器编号。 */
  sensor: string;
  buildingId: number;
  name: string;
  category: ShopCategory;
  open: [number, number];
  /** 每小时基础客流。 */
  base: number;
  /** 降雨对客流的影响：-0.75 表示大雨时下降 75%。临街、临水的店受影响大，也更怕大风。 */
  rainEffect: number;
  owner?: string;
}

const PROFILES: Record<ShopCategory, [number, number, number][]> = {
  咖啡: [
    [8.5, 1, 1],
    [15, 1.4, 0.7],
    [19.5, 1.2, 0.8],
  ],
  商场: [
    [13, 2.5, 0.8],
    [19.5, 1.8, 1],
  ],
  茶室: [
    [10.5, 1.5, 0.8],
    [16, 1.8, 1],
  ],
  便利店: [
    [8, 1, 0.9],
    [12.5, 1.2, 0.7],
    [19, 2, 1],
  ],
  花店: [
    [11, 2, 0.8],
    [17.5, 1.5, 1],
  ],
  面包店: [
    [7.8, 1, 1],
    [17.8, 1.4, 0.8],
  ],
};

function buildShops(): Shop[] {
  const shops: Shop[] = [];
  const add = (building: Building, partial: Omit<Shop, 'id' | 'sensor' | 'buildingId'>) =>
    shops.push({
      id: shops.length + 1,
      sensor: `S${String(shops.length + 1).padStart(2, '0')}`,
      buildingId: building.id,
      ...partial,
    });

  const effects: Record<string, number> = {
    拾光咖啡: 0.12,
    街角咖啡: 0.08,
    梧桐咖啡: 0.1,
    云朵咖啡: 0.05,
    北窗咖啡: -0.15,
    河岸咖啡: -0.45,
    码头咖啡: -0.55,
  };
  for (const building of city.buildings) {
    if (building.kind === '咖啡馆') {
      add(building, {
        name: building.name,
        category: '咖啡',
        open: [hours(7), hours(22)],
        base: 55,
        rainEffect: effects[building.name] ?? 0,
        owner: building.name === '街角咖啡' ? '赵敏' : undefined,
      });
    } else if (building.kind === '商场') {
      add(building, {
        name: building.name,
        category: '商场',
        open: [hours(10), hours(22)],
        base: 210,
        rainEffect: 0.22,
      });
    } else if (building.kind === '茶室') {
      add(building, {
        name: building.name,
        category: '茶室',
        open: [hours(9), hours(21)],
        base: 26,
        rainEffect: -0.75,
      });
    }
  }
  const extras: [ShopCategory, string, number, number, [number, number]][] = [
    ['便利店', '便利店', 75, 0.05, [hours(6), hours(24)]],
    ['花店', '花店', 22, -0.6, [hours(9), hours(20)]],
    ['面包店', '面包房', 40, -0.2, [hours(7), hours(21)]],
  ];
  city.buildings
    .filter((b) => b.kind === '商店')
    .forEach((building, i) => {
      const [category, suffix, base, rainEffect, open] = extras[i % extras.length];
      add(building, {
        name: `${building.name.replace('商铺', '')}${suffix}`,
        category,
        open,
        base,
        rainEffect,
      });
    });
  return shops;
}

export const shops = buildShops();
export const shopById = new Map(shops.map((shop) => [shop.id, shop]));
export const shopByBuilding = new Map(shops.map((shop) => [shop.buildingId, shop]));

/** 周末客流倍数。 */
const WEEKEND: Record<ShopCategory, number> = {
  咖啡: 1.15,
  商场: 1.8,
  茶室: 1.6,
  便利店: 0.85,
  花店: 1.4,
  面包店: 1.1,
};

/** 高温（30°C 左右）时的客流变化：商场有空调，客流上升；街边店下降。 */
const HEAT: Record<ShopCategory, number> = {
  咖啡: -0.15,
  商场: 0.3,
  茶室: -0.3,
  便利店: 0.05,
  花店: -0.3,
  面包店: -0.15,
};

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

const noise = (shop: Shop, slot: number) => 0.9 + seededRandom(shop.id * 7919 + slot * 31)() * 0.2;

/** 时刻 t 的客流强度（人/小时）。 */
export function footfallRate(shop: Shop, t: number): number {
  const seconds = timeOfDay(t);
  if (seconds < shop.open[0] || seconds >= shop.open[1]) return 0;
  const weekend = isWeekend(t);
  // 周末上午的高峰推迟一个半小时
  const shift = weekend ? hours(1, 30) : 0;
  const profile = PROFILES[shop.category].reduce(
    (sum, [center, width, weight], i) =>
      sum + weight * bell(seconds, hours(center) + (i === 0 ? shift : 0), hours(width)),
    0.15,
  );
  const heat = clamp01((temperatureAt(t) - 24) / 6);
  const gale = clamp01((windAt(t) - 5) / 6);
  const weather =
    (1 + shop.rainEffect * rainAt(t)) *
    (1 + HEAT[shop.category] * heat) *
    (1 + Math.min(0, shop.rainEffect) * 0.6 * gale) *
    (1 - 0.1 * fogAt(t));
  return (
    shop.base *
    profile *
    (weekend ? WEEKEND[shop.category] : 1) *
    weather *
    noise(shop, Math.floor(t / 300))
  );
}

/** 区间内的客流计数（按 5 分钟计数记录累加）。 */
export function footfallCount(shop: Shop, from: number, to: number): number {
  let total = 0;
  for (let t = from; t < to; t += 300) total += footfallRate(shop, t + 150) / 12;
  return Math.round(total);
}
