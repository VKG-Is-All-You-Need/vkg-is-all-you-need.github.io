/**
 * 城市示例中的查询。每条查询声明所需的数据源，并按当前接入的数据源求值：
 * 数据源齐全时给出完整结果，缺少部分数据源时给出能算出的部分并说明缺失的影响。
 * 时间为一周内的模拟时间（见 time.ts），查询只使用截至此刻的数据。
 */
import { city } from '../geo/city';
import { rectCenter, type Point } from '../geo/spatial';
import { footfallCount, shops, type Shop } from './commerce';
import {
  hasItinerary,
  isRide,
  itinerary,
  placeName,
  purchasesOf,
  tapsOf,
  type Leg,
} from './mobility';
import {
  carOwners,
  companies,
  companyById,
  events,
  personById,
  personas,
  presence,
  type CommunityEvent,
  type Person,
} from './people';
import { edgeById, nodeById, roads, signalState } from './roads';
import {
  ENV_SENSORS,
  STATION,
  neighborsOf,
  offlineSince,
  placeOf,
  readingAt,
  stuckSince,
  type EnvSensor,
} from './sensors';
import { sourceById, type SourceId } from './sources';
import { DAY, DAYS, at, dayOf, formatDayTime, formatTime, hours, startOfDay } from './time';
import {
  edgeSpeeds,
  queuesAt,
  statesAt,
  trajectory,
  tripsOf,
  vehicleAt,
  vehicleById,
  vehicleByOwner,
  vehicles,
} from './traffic';
import { adverseWindows, badWeatherWindows, observationAt, rainWindows } from './weather';

export type QueryGroup = 'dynamic' | 'fusion' | 'life';

export interface CityContext {
  t: number;
  sources: Set<SourceId>;
  /** 人物相关查询是否展示虚构人物明细（默认聚合）。 */
  detail: boolean;
}

export interface ResultRow {
  key: string;
  title: string;
  detail: string;
  hit: boolean;
}

export type Highlight =
  | { type: 'node'; id: number; label: string }
  | { type: 'vehicle'; id: string; trail?: Point[]; label?: string }
  | { type: 'edge'; id: number; kmh: number; hit: boolean; label: string }
  | { type: 'shop'; id: number; today: number; baseline: number; hit: boolean; label: string }
  | { type: 'persona'; id: string; path: Point[]; label: string }
  | { type: 'place'; at: Point; label: string }
  | { type: 'buffer'; center: Point; radius: number }
  | { type: 'sensor'; id: string; hit: boolean; label: string }
  | { type: 'station'; label: string }
  /** 由传感器读数插值的地面温度场。 */
  | { type: 'heat' };

export type EntityKind =
  | 'intersection'
  | 'vehicle'
  | 'station'
  | 'shop'
  | 'weather'
  | 'road'
  | 'person'
  | 'company'
  | 'event'
  | 'building'
  | 'sensor'
  | 'order'
  | 'stop';

/** 分层视图中的实体：同一个实体可能由多个数据源共同描述。 */
export interface FusionEntity {
  key: string;
  kind: EntityKind;
  ref: string | number;
  label: string;
  cls: string;
  sources: SourceId[];
  hit: boolean;
}

export interface FusionRelation {
  from: string;
  to: string;
  label: string;
}

export interface CityResult {
  /** 完整、部分可用（缺少数据源）或无法回答。 */
  status: 'ok' | 'partial' | 'unavailable';
  missing: SourceId[];
  notes: string[];
  summary: string;
  rows: ResultRow[];
  highlights: Highlight[];
  entities: FusionEntity[];
  relations: FusionRelation[];
  classes: string[];
  subclass: [string, string][];
}

export interface QueryText {
  sparql: string;
  sql: string;
}

export interface CityQuery {
  id:
    | 'queues'
    | 'trails'
    | 'sensorAnomaly'
    | 'rainFootfall'
    | 'weatherSpeed'
    | 'heatIsland'
    | 'persona'
    | 'afterwork'
    | 'commuteCars'
    | 'weatherTaxi'
    | 'busShopping';
  group: QueryGroup;
  title: string;
  description: string;
  sources: SourceId[];
  /** 是否涉及人物数据（支持聚合与明细两种视图）。 */
  personal?: boolean;
  /** 选中查询时跳转到的建议时刻。 */
  suggest: number;
  text: QueryText;
  detailText?: QueryText;
  run(ctx: CityContext): CityResult;
}

const KMH = 3.6;
const names = (ids: SourceId[]) => ids.map((id) => sourceById.get(id)!.name).join('、');

function base(query: Pick<CityQuery, 'sources'>, ctx: CityContext): CityResult {
  const missing = query.sources.filter((id) => !ctx.sources.has(id));
  return {
    status: missing.length ? 'partial' : 'ok',
    missing,
    notes: [],
    summary: '',
    rows: [],
    highlights: [],
    entities: [],
    relations: [],
    classes: [],
    subclass: [],
  };
}

const unavailable = (result: CityResult, note: string): CityResult => ({
  ...result,
  status: 'unavailable',
  notes: [note, ...result.notes],
  summary: '无法回答',
});

const centralStation = city.stations.find((s) => s.name === '中心站')!;
const buildingName = (id: number) => city.buildings.find((b) => b.id === id)?.name ?? `建筑 #${id}`;
const span = (windows: [number, number][]) =>
  windows.map(([a, b]) => `${formatTime(a)}–${formatTime(b)}`).join('、');
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const signed = (value: number, digits = 1) =>
  `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(digits)}`;
const duration = (seconds: number) => {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  return h >= 3 || minutes % 60 === 0 ? `${h} 小时` : `${h} 小时 ${minutes % 60} 分`;
};

// ─────────────────────────── 动态数据 ───────────────────────────

const queues: CityQuery = {
  id: 'queues',
  group: 'dynamic',
  title: '此刻红灯前排队 3 辆车以上的路口',
  description: '结合信号相位与车辆实时位置。拖动时间轴，结果随源数据变化。',
  sources: ['traffic', 'gis'],
  suggest: at(0, 8, 30),
  text: {
    sparql: `SELECT ?name (COUNT(?v) AS ?queued) WHERE {
  ?light a :TrafficLight ; :controls ?i ;
         :phaseAt [ :time ?now ; :phase :Red ] .
  ?i a :Intersection ; :name ?name .
  ?v a :Vehicle ; :waitingAt ?i ; :observedAt ?now .
}
GROUP BY ?name
HAVING (COUNT(?v) >= 3)`,
    sql: `-- 联邦查询：traffic 与 gis 两个 catalog
SELECT i.name, COUNT(*) AS queued
FROM   traffic.public.vehicle_positions v
JOIN   traffic.public.signal_phases s
       ON s.intersection_id = v.next_intersection AND s.ts = v.ts
JOIN   gis.public.intersections i ON i.id = s.intersection_id
WHERE  v.ts = :now AND v.speed < 0.5 AND s.state = 'red'
GROUP  BY i.name
HAVING COUNT(*) >= 3`,
  },
  run(ctx) {
    const result = base(this, ctx);
    if (!ctx.sources.has('traffic')) {
      return unavailable(result, '交通时序未接入：没有信号相位与车辆位置。');
    }
    const gis = ctx.sources.has('gis');
    const states = statesAt(ctx.t);
    const byNode = new Map<number, { size: number; vehicles: string[]; edge: number }>();
    for (const queue of queuesAt(ctx.t, states)) {
      const current = byNode.get(queue.node);
      if (!current || queue.vehicles.length > current.size) {
        byNode.set(queue.node, {
          size: queue.vehicles.length,
          vehicles: queue.vehicles,
          edge: queue.edge,
        });
      }
    }
    const ranked = [...byNode.entries()].sort((a, b) => b[1].size - a[1].size);
    const label = (id: number) => (gis ? nodeById.get(id)!.name : `路口 #${id}`);
    for (const [id, queue] of ranked.slice(0, 8)) {
      const hit = queue.size >= 3;
      const axis = edgeById.get(queue.edge)!.axis;
      result.rows.push({
        key: `n${id}`,
        title: label(id),
        detail: `${queue.size} 辆 · ${axis === 'ns' ? '南北向' : '东西向'}红灯`,
        hit,
      });
      if (!hit) continue;
      if (gis) {
        result.highlights.push({ type: 'node', id, label: `${label(id)} · ${queue.size} 辆` });
      }
      queue.vehicles.forEach((v) => result.highlights.push({ type: 'vehicle', id: v }));
      result.entities.push({
        key: `i${id}`,
        kind: 'intersection',
        ref: id,
        label: label(id),
        cls: ':Intersection',
        sources: gis ? ['gis', 'traffic'] : ['traffic'],
        hit: true,
      });
      for (const v of queue.vehicles) {
        const vehicle = vehicleById.get(v)!;
        result.entities.push({
          key: `v${v}`,
          kind: 'vehicle',
          ref: v,
          label: vehicle.plate,
          cls: vehicle.kind === 'bus' ? ':Bus' : vehicle.kind === 'taxi' ? ':Taxi' : ':Vehicle',
          sources: ['traffic'],
          hit: true,
        });
        result.relations.push({ from: `v${v}`, to: `i${id}`, label: 'waitingAt' });
      }
    }
    const count = result.rows.filter((r) => r.hit).length;
    result.summary = count ? `${count} 个路口` : '暂无';
    if (!gis) {
      result.notes.push('城市基础数据未接入：只知道信号机上的路口编号，无法给出路口名称与位置。');
    }
    result.notes.push(`结果基于${formatDayTime(ctx.t)} 的信号相位与车辆位置。`);
    if (DAYS[dayOf(ctx.t)].weekend) result.notes.push('周末没有通勤高峰，排队明显少于工作日。');
    result.classes = [':TrafficLight', ':Intersection', ':Vehicle', ':Bus', ':Taxi'];
    result.subclass = [
      [':Bus', ':Vehicle'],
      [':Taxi', ':Vehicle'],
    ];
    return result;
  },
};

const trails: CityQuery = {
  id: 'trails',
  group: 'dynamic',
  title: '过去 10 分钟途经中心站的运营车辆',
  description: '数据库中只有公交与网约车两种类型；本体把两者归入 :ServiceVehicle，再做时空过滤。',
  sources: ['traffic', 'gis'],
  suggest: at(0, 8, 40),
  text: {
    sparql: `SELECT DISTINCT ?plate WHERE {
  ?st a :Station ; :name "中心站" ;
      geo:hasGeometry/geo:asWKT ?sWkt .
  ?v a :ServiceVehicle ; :plate ?plate ;
     :hasPosition ?p .
  ?p :time ?ts ; geo:asWKT ?pWkt .
  FILTER (?ts > ?now - "PT10M"^^xsd:duration)
  FILTER (geof:distance(?pWkt, ?sWkt, uom:metre) < 200)
}`,
    sql: `-- :ServiceVehicle 经本体展开为公交与网约车
SELECT DISTINCT v.plate
FROM   traffic.public.vehicle_positions p
JOIN   traffic.public.vehicles v ON v.id = p.vehicle_id
JOIN   gis.public.stations s     ON s.name = '中心站'
WHERE  v.type IN ('bus', 'taxi')
  AND  p.ts > :now - INTERVAL '10' MINUTE
  AND  ST_Distance(p.geom, s.location) < 200`,
  },
  run(ctx) {
    const result = base(this, ctx);
    if (!ctx.sources.has('traffic')) return unavailable(result, '交通时序未接入：没有车辆轨迹。');
    if (!ctx.sources.has('gis')) {
      return unavailable(result, '城市基础数据未接入：车辆有 GPS 坐标，但不知道“中心站”在哪里。');
    }
    const from = Math.max(startOfDay(dayOf(ctx.t)), ctx.t - 600);
    const c = centralStation.location;
    result.highlights.push({ type: 'buffer', center: c, radius: 200 });
    result.entities.push({
      key: 'st',
      kind: 'station',
      ref: centralStation.id,
      label: '中心站',
      cls: ':Station',
      sources: ['gis'],
      hit: true,
    });
    for (const vehicle of vehicles.filter((v) => v.kind !== 'car')) {
      const path = trajectory(vehicle, from, ctx.t);
      if (!path.some((p) => Math.hypot(p.x - c.x, p.y - c.y) < 200)) continue;
      const kind = vehicle.kind === 'bus' ? '公交' : '网约车';
      result.rows.push({ key: vehicle.id, title: vehicle.plate, detail: kind, hit: true });
      result.highlights.push({
        type: 'vehicle',
        id: vehicle.id,
        trail: path,
        label: vehicle.plate,
      });
      result.entities.push({
        key: `v${vehicle.id}`,
        kind: 'vehicle',
        ref: vehicle.id,
        label: vehicle.plate,
        cls: vehicle.kind === 'bus' ? ':Bus' : ':Taxi',
        sources: ['traffic'],
        hit: true,
      });
      result.relations.push({ from: `v${vehicle.id}`, to: 'st', label: 'passedNear' });
    }
    result.summary = `${result.rows.length} 辆`;
    result.notes.push(
      `时间窗：${formatTime(from)}–${formatTime(ctx.t)}。普通小汽车不属于 :ServiceVehicle，不在结果中。`,
    );
    result.classes = [':ServiceVehicle', ':Bus', ':Taxi', ':Station'];
    result.subclass = [
      [':Bus', ':ServiceVehicle'],
      [':Taxi', ':ServiceVehicle'],
    ];
    return result;
  },
};

const sensorLabel = (sensor: EnvSensor, ctx: CityContext) =>
  ctx.sources.has('gis') ? `${sensor.id} · ${placeOf(sensor)}` : `传感器 ${sensor.id}`;
const sensorSources = (ctx: CityContext): SourceId[] =>
  (['iot', 'gis'] as SourceId[]).filter((id) => ctx.sources.has(id));

const sensorAnomaly: CityQuery = {
  id: 'sensorAnomaly',
  group: 'dynamic',
  title: '此刻读数异常的温湿度传感器',
  description: '把每个传感器与相邻传感器、官方气象站逐一比对，找出离线、读数卡死或明显偏离的设备。',
  sources: ['iot', 'weather', 'gis'],
  suggest: at(5, 14),
  text: {
    sparql: `SELECT ?sensor ?temp ?rh ?last WHERE {
  ?sensor a :EnvSensor .
  OPTIONAL {
    ?o sosa:madeBySensor ?sensor ; sosa:resultTime ?last ;
       :temperature ?temp ; :humidity ?rh .
    FILTER NOT EXISTS {
      ?newer sosa:madeBySensor ?sensor ; sosa:resultTime ?t2 .
      FILTER (?t2 > ?last)
    }
  }
}
# 再与 340 米内的传感器及气象站比较：
# 超过 10 分钟无数据、湿度卡在 100%、温度偏离超过 3.5°C`,
    sql: `WITH latest AS (
  SELECT device, max(ts) AS last_seen,
         max_by(temp_c, ts) AS temp, max_by(rh, ts) AS rh
  FROM   iot.public.env_readings
  WHERE  ts > :now - INTERVAL '1' DAY
  GROUP  BY device)
SELECT d.id, l.last_seen, l.temp, l.rh,
       w.temperature, w.humidity
FROM   iot.public.devices d
LEFT JOIN latest l ON l.device = d.id
CROSS JOIN weather.obs.observations w
WHERE  d.kind = 'env' AND w.ts = :now_10min`,
  },
  run(ctx) {
    const result = base(this, ctx);
    if (!ctx.sources.has('iot')) return unavailable(result, '物联网平台未接入：没有传感器读数。');
    const weather = ctx.sources.has('weather');
    const station = weather ? observationAt(ctx.t) : null;
    const readings = new Map(ENV_SENSORS.map((sensor) => [sensor.id, readingAt(sensor, ctx.t)]));
    const normal: ResultRow[] = [];
    for (const sensor of ENV_SENSORS) {
      const reading = readings.get(sensor.id);
      const label = sensorLabel(sensor, ctx);
      let issue = '';
      const offline = offlineSince(sensor, ctx.t);
      const stuck = stuckSince(sensor, ctx.t);
      if (offline !== undefined) {
        issue = `离线 ${duration(ctx.t - offline)}`;
      } else if (stuck !== undefined && (!station || station.humidity < 95)) {
        issue = `湿度卡在 100%，已 ${duration(ctx.t - stuck)}`;
      } else if (reading) {
        const around = neighborsOf(sensor)
          .map((other) => readings.get(other.id)?.temperature)
          .filter((v): v is number => v !== undefined);
        const diff = around.length ? reading.temperature - median(around) : 0;
        if (Math.abs(diff) > 3.5)
          issue = `比相邻传感器${diff > 0 ? '高' : '低'} ${Math.abs(diff).toFixed(1)}°C`;
      }
      const values = reading
        ? `${reading.temperature.toFixed(1)}°C · ${reading.humidity}%`
        : '无数据';
      if (!issue) {
        normal.push({ key: sensor.id, title: label, detail: values, hit: false });
        continue;
      }
      result.rows.push({ key: sensor.id, title: label, detail: issue, hit: true });
      result.highlights.push({
        type: 'sensor',
        id: sensor.id,
        hit: true,
        label: `${sensor.id} · ${issue}`,
      });
      result.entities.push({
        key: `s${sensor.id}`,
        kind: 'sensor',
        ref: sensor.id,
        label: sensor.id,
        cls: ':EnvSensor',
        sources: sensorSources(ctx),
        hit: true,
      });
      if (station)
        result.relations.push({ from: `s${sensor.id}`, to: 'weather', label: 'comparedTo' });
    }
    const count = result.rows.length;
    result.rows.push(...normal.slice(0, Math.max(0, 6 - count)));
    result.summary = count ? `${count} 个异常` : '全部正常';
    if (station) {
      result.highlights.push({
        type: 'station',
        label: `气象站 · ${station.temperature.toFixed(1)}°C · ${station.humidity}%`,
      });
      result.entities.push({
        key: 'weather',
        kind: 'weather',
        ref: 0,
        label: STATION.name,
        cls: ':WeatherObservation',
        sources: ['weather'],
        hit: true,
      });
      result.notes.push(
        `气象站 ${formatTime(station.ts)}：${station.temperature.toFixed(1)}°C，湿度 ${station.humidity}%。`,
      );
    } else {
      result.notes.push('气象观测未接入：只能与相邻传感器比较，无法判断湿度读数是否合理。');
    }
    if (!ctx.sources.has('gis')) {
      result.notes.push('城市基础数据未接入：设备只有坐标，无法给出安装位置的名称。');
    }
    result.notes.push(
      `共 ${ENV_SENSORS.length} 个传感器，${ENV_SENSORS.length - count} 个读数正常。`,
    );
    result.classes = [':EnvSensor', 'sosa:Sensor', ':WeatherObservation', 'sosa:Observation'];
    result.subclass = [
      [':EnvSensor', 'sosa:Sensor'],
      [':WeatherObservation', 'sosa:Observation'],
    ];
    return result;
  },
};

// ─────────────────────────── 数据融合 ───────────────────────────

const shopLabel = (shop: Shop, ctx: CityContext) =>
  ctx.sources.has('commerce') ? shop.name : `计数器 ${shop.sensor}`;

/** 此前与当天同类（工作日或周末）、且在给定时段内没有降水的日子。 */
function baselineDays(t: number, windows: [number, number][], weather: boolean): number[] {
  const day = dayOf(t);
  const weekend = DAYS[day].weekend;
  return DAYS.filter((d) => d.index < day && d.weekend === weekend)
    .map((d) => d.index)
    .filter(
      (d) =>
        !weather ||
        windows.every(([a, b]) => {
          for (let ts = a; ts < b; ts += 600) {
            if (observationAt(ts - (day - d) * DAY).precipitation > 0) return false;
          }
          return true;
        }),
    );
}

const rainFootfall: CityQuery = {
  id: 'rainFootfall',
  group: 'fusion',
  title: '下雨时客流下降最多的商店',
  description:
    '客流计数器只有设备编号，店名来自商户系统，降雨时段来自气象观测；与此前同类日的无雨日同时段比较。',
  sources: ['iot', 'weather', 'commerce', 'gis'],
  suggest: at(1, 18, 40),
  text: {
    sparql: `SELECT ?shop (SUM(?n) AS ?today) WHERE {
  ?w a :WeatherObservation ; :precipitation ?mm ; :hour ?h .
  FILTER (?mm > 0)
  ?c a :FootfallCount ; :atShop ?s ; :hour ?h ; :count ?n .
  ?s a :Shop ; :name ?shop .
}
GROUP BY ?shop
# 再与此前同类日无雨时的同时段比较`,
    sql: `SELECT p.name, SUM(f.count) AS today
FROM   weather.obs.observations w
JOIN   iot.public.footfall f
       ON date_trunc('hour', f.ts) = date_trunc('hour', w.ts)
JOIN   pos.shop.shops p ON p.building_id = f.building_id
WHERE  w.precipitation > 0 AND CAST(w.ts AS date) = :today
GROUP  BY p.name`,
  },
  run(ctx) {
    const result = base(this, ctx);
    if (!ctx.sources.has('iot')) return unavailable(result, '物联网平台未接入：没有客流数据。');
    const day = dayOf(ctx.t);
    const weather = ctx.sources.has('weather');
    const windows: [number, number][] = weather ? rainWindows(ctx.t) : [[startOfDay(day), ctx.t]];
    if (!ctx.sources.has('commerce')) {
      result.notes.push('商户系统未接入：只能看到计数器编号，不知道对应哪家店、什么类别。');
    }
    if (weather && !windows.length) {
      result.summary = '尚未降雨';
      result.notes.push(
        `${DAYS[day].label}截至 ${formatTime(ctx.t)} 没有降水记录。本周周二 16:00、周五 14:20 与周日上午有降水。`,
      );
      return result;
    }
    const days = baselineDays(ctx.t, windows, weather);
    if (!days.length) {
      result.summary = '没有可比较的日子';
      result.notes.push(
        `${DAYS[day].label}之前没有同类日${weather ? '在同一时段无雨' : ''}，无法比较。`,
      );
      return result;
    }
    const shift = (d: number) => (day - d) * DAY;
    const changes = shops
      .map((shop) => {
        const today = windows.reduce((sum, [a, b]) => sum + footfallCount(shop, a, b), 0);
        const baseline = Math.round(
          days.reduce(
            (sum, d) =>
              sum +
              windows.reduce((s, [a, b]) => s + footfallCount(shop, a - shift(d), b - shift(d)), 0),
            0,
          ) / days.length,
        );
        return { shop, today, baseline, change: baseline ? (today - baseline) / baseline : 0 };
      })
      .filter((c) => c.baseline > 0)
      .sort((a, b) => a.change - b.change);

    changes.forEach(({ shop, today, baseline, change }, i) => {
      const hit = weather && i < 3 && change < -0.2;
      const pct = `${change > 0 ? '+' : ''}${Math.round(change * 100)}%`;
      result.rows.push({
        key: `shop${shop.id}`,
        title: shopLabel(shop, ctx),
        detail: `${today} 人 · 往常 ${baseline} 人 · ${pct}`,
        hit,
      });
      if (ctx.sources.has('gis')) {
        result.highlights.push({
          type: 'shop',
          id: shop.id,
          today,
          baseline,
          hit,
          label: `${shopLabel(shop, ctx)} ${pct}`,
        });
      }
      if (hit || i < 5) {
        result.entities.push({
          key: `shop${shop.id}`,
          kind: 'shop',
          ref: shop.id,
          label: shopLabel(shop, ctx),
          cls: ctx.sources.has('commerce') && shop.category === '咖啡' ? ':Cafe' : ':Shop',
          sources: (['iot', 'commerce', 'gis'] as SourceId[]).filter((id) => ctx.sources.has(id)),
          hit,
        });
        if (weather)
          result.relations.push({ from: `shop${shop.id}`, to: 'weather', label: 'during' });
      }
    });
    const compared = days.map((d) => DAYS[d].label).join('、');
    if (weather) {
      result.entities.push({
        key: 'weather',
        kind: 'weather',
        ref: 0,
        label: '降雨观测',
        cls: ':WeatherObservation',
        sources: ['weather'],
        hit: true,
      });
      result.notes.push(`降雨时段：${span(windows)}；与${compared}同时段的平均值比较。`);
      result.summary = `${result.rows.filter((r) => r.hit).length} 家下降明显`;
    } else {
      result.notes.push(
        `气象观测未接入：无法确定降雨时段，改为比较今天截至此刻与${compared}同时段的客流。`,
      );
      result.summary = `${result.rows.length} 家（未区分晴雨）`;
    }
    result.classes = [
      ':Shop',
      ':Cafe',
      ':FootfallCount',
      ':WeatherObservation',
      'sosa:Observation',
    ];
    result.subclass = [
      [':Cafe', ':Shop'],
      [':FootfallCount', 'sosa:Observation'],
      [':WeatherObservation', 'sosa:Observation'],
    ];
    return result;
  },
};

const weatherSpeed: CityQuery = {
  id: 'weatherSpeed',
  group: 'fusion',
  title: '降雨或大雾期间平均车速低于 20 km/h 的路段',
  description: '把车辆轨迹匹配到路段，再按气象观测筛出有降水或能见度不足 1000 米的时段。',
  sources: ['traffic', 'weather', 'gis'],
  suggest: at(2, 9, 40),
  text: {
    sparql: `SELECT ?road (AVG(?kmh) AS ?speed) WHERE {
  ?w a :WeatherObservation ; :interval ?iv ;
     :precipitation ?mm ; :visibility ?vis .
  FILTER (?mm > 0 || ?vis < 1000)
  ?p a :Position ; :onSegment ?seg ;
     :speedKmh ?kmh ; :during ?iv .
  ?seg a :RoadSegment ; :name ?road .
}
GROUP BY ?road
HAVING (AVG(?kmh) < 20)`,
    sql: `SELECT r.name, AVG(p.speed_kmh) AS speed
FROM   traffic.public.vehicle_positions p
JOIN   weather.obs.observations w
       ON p.ts >= w.ts AND p.ts < w.ts + INTERVAL '10' MINUTE
JOIN   gis.public.roads r ON r.id = p.road_id
WHERE  w.precipitation > 0 OR w.visibility < 1000
GROUP  BY r.name
HAVING AVG(p.speed_kmh) < 20`,
  },
  run(ctx) {
    const result = base(this, ctx);
    if (!ctx.sources.has('traffic')) return unavailable(result, '交通时序未接入：没有车辆轨迹。');
    if (!ctx.sources.has('gis')) {
      return unavailable(result, '城市基础数据未接入：没有路网，无法把轨迹匹配到路段。');
    }
    const weather = ctx.sources.has('weather');
    // 轨迹按分钟聚合即可，时间窗取整到分钟，便于复用计算结果
    const until = Math.floor(ctx.t / 60) * 60;
    const day = dayOf(ctx.t);
    const windows: [number, number][] = weather
      ? adverseWindows(until)
      : [[startOfDay(day), until]];
    if (!weather) {
      result.notes.push('气象观测未接入：无法区分天气，下面是今天截至此刻的全天平均车速。');
    } else if (!windows.length) {
      result.summary = '尚无不利天气';
      result.notes.push(
        `${DAYS[day].label}截至 ${formatTime(ctx.t)} 没有降水或大雾记录。本周周二傍晚有雨，周三早晨有雾，周五午后有雷阵雨。`,
      );
      return result;
    }
    const speeds = [...edgeSpeeds(windows).entries()]
      .map(([id, speed]) => ({ edge: edgeById.get(id)!, kmh: speed * KMH }))
      .sort((a, b) => a.kmh - b.kmh);
    speeds.forEach(({ edge, kmh }) => {
      const hit = weather && kmh < 20;
      result.highlights.push({
        type: 'edge',
        id: edge.id,
        kmh,
        hit,
        label: `${Math.round(kmh)} km/h`,
      });
      if (result.rows.length < 10) {
        result.rows.push({
          key: `e${edge.id}`,
          title: edge.name,
          detail: `${kmh.toFixed(1)} km/h`,
          hit,
        });
      }
      if (hit) {
        result.entities.push({
          key: `e${edge.id}`,
          kind: 'road',
          ref: edge.id,
          label: edge.name,
          cls: ':RoadSegment',
          sources: ['gis', 'traffic'],
          hit,
        });
        result.relations.push({ from: `e${edge.id}`, to: 'weather', label: 'during' });
      }
    });
    if (weather) {
      result.entities.push({
        key: 'weather',
        kind: 'weather',
        ref: 0,
        label: '不利天气观测',
        cls: ':WeatherObservation',
        sources: ['weather'],
        hit: true,
      });
      result.summary = `${speeds.filter((s) => s.kmh < 20).length} 条路段`;
      const described = windows
        .map(([a, b]) => `${observationAt(a).condition} ${formatTime(a)}–${formatTime(b)}`)
        .join('、');
      result.notes.push(`不利天气时段：${described}。不含等灯与进站停靠时间。`);
    } else {
      result.summary = '未区分天气';
    }
    result.classes = [':RoadSegment', ':Vehicle', ':WeatherObservation', 'sosa:Observation'];
    result.subclass = [[':WeatherObservation', 'sosa:Observation']];
    return result;
  },
};

/** 半径内各类建筑的数量，如“办公 3、商场 1”。 */
function landUse(p: Point, radius = 150): string {
  const counts = new Map<string, number>();
  for (const building of city.buildings) {
    const c = rectCenter(building.footprint);
    if (Math.hypot(c.x - p.x, c.y - p.y) <= radius) {
      counts.set(building.kind, (counts.get(building.kind) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([kind, n]) => `${kind} ${n}`)
    .join('、');
}

const heatIsland: CityQuery = {
  id: 'heatIsland',
  group: 'fusion',
  title: '城市热岛：比气象站高 2°C 以上的传感器',
  description:
    '传感器读数来自物联网平台，基准来自公园里的官方气象站，周边建筑类型来自城市基础数据。',
  sources: ['iot', 'weather', 'gis'],
  suggest: at(3, 14, 30),
  text: {
    sparql: `SELECT ?sensor ?diff (COUNT(?b) AS ?buildings) WHERE {
  ?o a :TemperatureObservation ; sosa:madeBySensor ?sensor ;
     sosa:hasSimpleResult ?t ; sosa:resultTime ?now .
  ?w a :WeatherObservation ; :temperature ?ref ; :at ?slot .
  FILTER (?now >= ?slot && ?now < ?slot + "PT10M"^^xsd:duration)
  BIND (?t - ?ref AS ?diff)
  FILTER (?diff >= 2)
  ?sensor geo:hasGeometry/geo:asWKT ?p .
  ?b a :Building ; geo:hasGeometry/geo:asWKT ?g .
  FILTER (geof:distance(?p, ?g, uom:metre) < 150)
}
GROUP BY ?sensor ?diff`,
    sql: `SELECT r.device, r.temp_c - w.temperature AS diff,
       COUNT(b.id) AS buildings
FROM   iot.public.env_readings r
JOIN   iot.public.devices d ON d.id = r.device
JOIN   weather.obs.observations w
       ON r.ts >= w.ts AND r.ts < w.ts + INTERVAL '10' MINUTE
JOIN   gis.public.buildings b
       ON ST_DWithin(b.footprint, d.location, 150)
WHERE  r.ts = :now AND r.temp_c - w.temperature >= 2
GROUP  BY r.device, r.temp_c, w.temperature`,
  },
  run(ctx) {
    const result = base(this, ctx);
    if (!ctx.sources.has('iot')) return unavailable(result, '物联网平台未接入：没有传感器读数。');
    const weather = ctx.sources.has('weather');
    const gis = ctx.sources.has('gis');
    const readings = ENV_SENSORS.map((sensor) => ({ sensor, reading: readingAt(sensor, ctx.t) }))
      .filter((x) => x.reading !== null)
      .map((x) => ({ sensor: x.sensor, temperature: x.reading!.temperature }));
    const station = weather ? observationAt(ctx.t) : null;
    const reference = station ? station.temperature : median(readings.map((r) => r.temperature));
    if (station) {
      result.notes.push(
        `气象站 ${formatTime(station.ts)} 观测：${station.temperature.toFixed(1)}°C（${station.condition}）。`,
      );
    } else {
      result.notes.push('气象观测未接入：没有官方基准，改为与全部传感器读数的中位数比较。');
    }
    result.highlights.push({ type: 'heat' });
    const ranked = readings
      .map((r) => ({ ...r, diff: r.temperature - reference }))
      .sort((a, b) => b.diff - a.diff);
    const hits = ranked.filter((r) => r.diff >= 2);
    for (const { sensor, temperature, diff } of ranked.slice(0, 8)) {
      const hit = diff >= 2;
      result.rows.push({
        key: sensor.id,
        title: sensorLabel(sensor, ctx),
        detail: `${temperature.toFixed(1)}°C · ${signed(diff)}°C`,
        hit,
      });
      if (!hit) continue;
      result.highlights.push({
        type: 'sensor',
        id: sensor.id,
        hit: true,
        label: `${sensor.id} · ${signed(diff)}°C`,
      });
      result.entities.push({
        key: `s${sensor.id}`,
        kind: 'sensor',
        ref: sensor.id,
        label: sensor.id,
        cls: ':EnvSensor',
        sources: sensorSources(ctx),
        hit: true,
      });
      if (station)
        result.relations.push({ from: `s${sensor.id}`, to: 'weather', label: 'comparedTo' });
    }
    if (station) {
      result.highlights.push({
        type: 'station',
        label: `气象站 · ${station.temperature.toFixed(1)}°C`,
      });
      result.entities.push({
        key: 'weather',
        kind: 'weather',
        ref: 0,
        label: STATION.name,
        cls: ':WeatherObservation',
        sources: ['weather'],
        hit: true,
      });
    }
    if (gis && hits.length) {
      const context = hits.map(({ sensor }) => `${sensor.id}：${landUse(sensor.at) || '无建筑'}`);
      result.notes.push(`周边 150 米内的建筑：${context.join('；')}。`);
    } else if (!gis) {
      result.notes.push('城市基础数据未接入：只有设备坐标，无法得知周边是什么建筑。');
    }
    const coolest = ranked.at(-1);
    if (coolest && coolest.diff < 0) {
      result.notes.push(
        `最凉的是 ${sensorLabel(coolest.sensor, ctx)}，${signed(coolest.diff)}°C。`,
      );
    }
    result.summary = hits.length ? `${hits.length} 个传感器` : '无明显热岛';
    if (!hits.length) result.notes.push('阴雨或夜间日照弱，热岛效应不明显。周四午后最明显。');
    result.classes = [
      ':EnvSensor',
      'sosa:Sensor',
      ':TemperatureObservation',
      ':WeatherObservation',
      'sosa:Observation',
    ];
    result.subclass = [
      [':EnvSensor', 'sosa:Sensor'],
      [':TemperatureObservation', 'sosa:Observation'],
      [':WeatherObservation', 'sosa:Observation'],
    ];
    return result;
  },
};

// ─────────────────────────── 工作与生活 ───────────────────────────

const personLabel = (person: Person, ctx: CityContext) =>
  ctx.detail && person.persona ? person.name! : `居民 ${person.id}`;
const labelOf = (id: string, ctx: CityContext) => personLabel(personById.get(id)!, ctx);

/** 某段行程能否由已接入的数据源得知。 */
function knows(leg: Leg, ctx: CityContext): boolean {
  const has = (id: SourceId) => ctx.sources.has(id);
  switch (leg.mode) {
    case 'home':
    case 'event':
      return has('community');
    case 'work':
      return has('hr');
    case 'drive':
      // 停车许可把车牌对应到人，车辆轨迹给出行驶过程
      return has('hr') && has('traffic');
    case 'bus':
    case 'taxi':
    case 'wait':
      return has('mobility');
    case 'shop':
      return has('commerce');
    default:
      // 步行与地铁没有直接记录，由前后两段记录推断
      return has('hr') && has('community');
  }
}

const persona: CityQuery = {
  id: 'persona',
  group: 'life',
  title: '林晓的一天',
  description:
    '住址与活动来自社区应用，上下班来自门禁，乘车来自出行服务，消费来自商户系统，车辆位置来自交通时序。',
  sources: ['community', 'hr', 'mobility', 'commerce', 'traffic', 'gis'],
  suggest: at(2, 19, 40),
  personal: true,
  text: {
    sparql: `# 聚合视图：楼宇在岗人数与当天的活动参与
SELECT ?company ?hour (COUNT(?s) AS ?present) WHERE {
  ?s a :WorkSession ; :company ?c ; :covers ?hour .
  ?c :name ?company .
}
GROUP BY ?company ?hour`,
    sql: `SELECT c.name, a.hour, a.present
FROM   hr.public.access_hourly a
JOIN   hr.public.companies c ON c.building_id = a.building_id
WHERE  CAST(a.hour AS date) = :today
ORDER  BY a.hour`,
  },
  detailText: {
    sparql: `SELECT ?time ?what ?where WHERE {
  ?p a :Person ; :name "林晓" .
  { ?p :livesIn ?where . BIND ("住址" AS ?what) }
  UNION { ?s a :WorkSession ; :of ?p ;
          :start ?time ; :at ?where . BIND ("上班" AS ?what) }
  UNION { ?p :attended ?e . ?e :start ?time ;
          :heldAt ?where . BIND ("活动" AS ?what) }
  FILTER (?time >= ?today)
}
ORDER BY ?time`,
    sql: `SELECT 'work' AS what, s.start_ts, c.name AS place
FROM   hr.public.work_sessions s
JOIN   hr.public.companies c ON c.id = s.company_id
WHERE  s.person_id = 'P01' AND CAST(s.start_ts AS date) = :today
UNION ALL
SELECT 'event', e.start_ts, p.name
FROM   community.public.event_attendance a
JOIN   community.public.events e ON e.id = a.event_id
LEFT JOIN pos.shop.shops p ON p.building_id = e.building_id
WHERE  a.person_id = 'P01' AND CAST(e.start_ts AS date) = :today
ORDER  BY 2`,
  },
  run(ctx) {
    const result = base(this, ctx);
    const hr = ctx.sources.has('hr');
    const community = ctx.sources.has('community');
    const commerce = ctx.sources.has('commerce');
    if (!hr && !community) {
      return unavailable(result, '企业与门禁、社区应用都未接入：没有任何与人相关的数据。');
    }
    const day = dayOf(ctx.t);
    const today = events.filter((e) => dayOf(e.start) === day && e.start <= ctx.t);
    result.classes = [':Person', ':Employee', ':Company', ':SocialEvent', ':Shop', ':Vehicle'];
    result.subclass = [[':Employee', ':Person']];

    if (!ctx.detail) {
      // 聚合视图：不涉及具体个人
      if (hr) {
        for (const company of companies.filter((c) => c.buildingId)) {
          const now = presence(company.id, ctx.t);
          let peak = 0;
          for (let h = 6; h < 24; h++) peak = Math.max(peak, presence(company.id, at(day, h, 30)));
          result.rows.push({
            key: `c${company.id}`,
            title: `${company.name}在岗`,
            detail: `此刻 ${now} 人 · 峰值 ${peak} 人`,
            hit: now > 0,
          });
          result.entities.push({
            key: `c${company.id}`,
            kind: 'company',
            ref: company.id,
            label: company.name,
            cls: ':Company',
            sources: ['hr'],
            hit: now > 0,
          });
          if (ctx.sources.has('gis')) {
            result.highlights.push({
              type: 'place',
              at: buildingCenter(company.buildingId),
              label: `${company.name} · ${now} 人`,
            });
          }
        }
      } else {
        result.notes.push('企业与门禁未接入：没有在岗人数。');
      }
      if (community) {
        for (const event of today) {
          const venue = venueLabel(event, ctx);
          result.rows.push({
            key: `e${event.id}`,
            title: `${event.title}（${venue}）`,
            detail: `${event.attendees.length} 人参加 · ${formatTime(event.start)}`,
            hit: true,
          });
          result.entities.push({
            key: `ev${event.id}`,
            kind: 'event',
            ref: event.id,
            label: event.title,
            cls: ':SocialEvent',
            sources: ['community'],
            hit: true,
          });
        }
      } else {
        result.notes.push('社区应用未接入：没有活动数据。');
      }
      result.summary = '聚合统计';
      if (DAYS[day].weekend) result.notes.push('周末写字楼基本无人，医院照常轮班。');
      result.notes.push('当前为聚合视图：只展示楼宇在岗人数与活动参与人数，不涉及具体个人。');
      return result;
    }

    // 明细视图：虚构人物林晓
    const mobility = ctx.sources.has('mobility');
    const traffic = ctx.sources.has('traffic');
    const legs = itinerary('P01', day).filter((leg) => leg.start <= ctx.t);
    const known = legs.filter((leg) => knows(leg, ctx));
    const attended = today.filter((e) => e.attendees.includes('P01'));
    for (const leg of known) {
      let label = leg.label;
      const event = leg.mode === 'event' ? attended.find((e) => e.title === leg.label) : undefined;
      if (event && !commerce && event.venue.kind === 'building') {
        label = `${leg.label}（场所：建筑 #${event.venue.id}）`;
      }
      if (leg.vehicle && isRide(leg.mode) && traffic) {
        label = `${label}（${vehicleById.get(leg.vehicle)!.plate}）`;
      }
      if (leg.mode === 'shop' && leg.amount) label = `${label} · ${leg.amount} 元`;
      result.rows.push({
        key: `l${leg.start}`,
        title: label,
        detail: `${formatTime(leg.start)}–${formatTime(Math.min(leg.end, at(day, 23, 59)))}`,
        hit: ctx.t < leg.end,
      });
    }
    const path = known.flatMap((leg) => (leg.mode === 'metro' ? [] : leg.path));
    if (ctx.sources.has('gis') && path.length) {
      result.highlights.push({ type: 'persona', id: 'P01', path, label: '林晓' });
    }
    const sources: SourceId[] = (['community', 'hr'] as SourceId[]).filter((id) =>
      ctx.sources.has(id),
    );
    result.entities.push({
      key: 'pP01',
      kind: 'person',
      ref: 'P01',
      label: '林晓',
      cls: hr ? ':Employee' : ':Person',
      sources,
      hit: true,
    });
    if (hr && known.some((leg) => leg.mode === 'work')) {
      result.entities.push({
        key: 'c1',
        kind: 'company',
        ref: 1,
        label: '星河科技',
        cls: ':Company',
        sources: ['hr'],
        hit: true,
      });
      result.relations.push({ from: 'pP01', to: 'c1', label: 'worksFor' });
    } else if (!hr) {
      result.notes.push('企业与门禁未接入：不知道林晓在哪里工作、几点上下班。');
    }
    if (community) {
      result.entities.push({
        key: 'home',
        kind: 'building',
        ref: personById.get('P01')!.homeId,
        label: '住址',
        cls: ':Building',
        sources: ['community', 'gis'].filter((id) => ctx.sources.has(id as SourceId)) as SourceId[],
        hit: true,
      });
      result.relations.push({ from: 'pP01', to: 'home', label: 'livesIn' });
      for (const event of attended) {
        result.entities.push({
          key: `ev${event.id}`,
          kind: 'event',
          ref: event.id,
          label: event.title,
          cls: ':SocialEvent',
          sources: ['community'],
          hit: true,
        });
        result.relations.push({ from: 'pP01', to: `ev${event.id}`, label: 'attended' });
        const shop = shops.find(
          (s) => event.venue.kind === 'building' && s.buildingId === event.venue.id,
        );
        if (shop && commerce) {
          result.entities.push({
            key: `shop${shop.id}`,
            kind: 'shop',
            ref: shop.id,
            label: shop.name,
            cls: ':Cafe',
            sources: ['commerce', 'gis'].filter((id) =>
              ctx.sources.has(id as SourceId),
            ) as SourceId[],
            hit: true,
          });
          result.relations.push({ from: `ev${event.id}`, to: `shop${shop.id}`, label: 'heldAt' });
        }
      }
    } else {
      result.notes.push('社区应用未接入：不知道林晓住在哪里、下班后参加了什么活动。');
    }
    for (const leg of known.filter((l) => l.vehicle && isRide(l.mode))) {
      const vehicle = vehicleById.get(leg.vehicle!)!;
      const key = `v${vehicle.id}`;
      if (result.entities.some((e) => e.key === key)) continue;
      const by: SourceId = leg.mode === 'drive' ? 'hr' : 'mobility';
      result.entities.push({
        key,
        kind: 'vehicle',
        ref: vehicle.id,
        label: vehicle.plate,
        cls: vehicle.kind === 'bus' ? ':Bus' : vehicle.kind === 'taxi' ? ':Taxi' : ':Vehicle',
        sources: ([by, 'traffic'] as SourceId[]).filter((id) => ctx.sources.has(id)),
        hit: true,
      });
      result.relations.push({
        from: 'pP01',
        to: key,
        label: leg.mode === 'drive' ? 'drives' : 'rode',
      });
    }
    for (const leg of known.filter((l) => l.mode === 'shop')) {
      const key = `shop${leg.shop}`;
      if (result.entities.some((e) => e.key === key)) continue;
      result.entities.push({
        key,
        kind: 'shop',
        ref: leg.shop!,
        label: shops.find((s) => s.id === leg.shop)!.name,
        cls: ':Shop',
        sources: (['commerce', 'gis'] as SourceId[]).filter((id) => ctx.sources.has(id)),
        hit: true,
      });
      result.relations.push({ from: 'pP01', to: key, label: 'boughtAt' });
    }
    if (!mobility && legs.some((l) => l.mode === 'bus' || l.mode === 'taxi')) {
      result.notes.push('出行服务未接入：没有公交刷卡与网约车订单，乘车的行程缺失。');
    }
    if (!commerce && legs.some((l) => l.mode === 'shop')) {
      result.notes.push('商户系统未接入：没有会员消费记录。');
    }
    if (!commerce && attended.some((e) => e.venue.kind === 'building')) {
      result.notes.push('商户系统未接入：活动场所只能显示为建筑编号。');
    }
    result.notes.push(
      '人物为虚构。门禁与社区应用以统一的居民编号关联，映射为同一个 IRI :person/P01。',
    );
    result.summary = `${result.rows.length} 条记录`;
    return result;
  },
};

const afterwork: CityQuery = {
  id: 'afterwork',
  group: 'life',
  title: '本周下班后一起参加活动的同事',
  description: '同事关系来自企业系统，活动报名来自社区应用。两个系统各自都回答不了这个问题。',
  sources: ['hr', 'community'],
  suggest: at(1, 21, 45),
  personal: true,
  text: {
    sparql: `SELECT ?event ?company (COUNT(DISTINCT ?p) AS ?n) WHERE {
  ?p :attended ?e ; :worksFor ?c .
  ?e :title ?event ; :start ?start . ?c :name ?company .
  FILTER (HOURS(?start) >= 17)
}
GROUP BY ?event ?company
HAVING (COUNT(DISTINCT ?p) >= 2)`,
    sql: `SELECT e.title, c.name, COUNT(DISTINCT a.person_id) AS n
FROM   community.public.event_attendance a
JOIN   community.public.events e ON e.id = a.event_id
JOIN   hr.public.employment m    ON m.person_id = a.person_id
JOIN   hr.public.companies c     ON c.id = m.company_id
WHERE  hour(e.start_ts) >= 17
GROUP  BY e.title, c.name
HAVING COUNT(DISTINCT a.person_id) >= 2`,
  },
  detailText: {
    sparql: `SELECT ?event ?a ?b ?company WHERE {
  ?a :worksFor ?c . ?b :worksFor ?c .
  ?a :attended ?e . ?b :attended ?e .
  ?e :title ?event ; :start ?start . ?c :name ?company .
  FILTER (HOURS(?start) >= 17 && STR(?a) < STR(?b))
}`,
    sql: `SELECT e.title, x.person_id, y.person_id, c.name
FROM   community.public.event_attendance x
JOIN   community.public.event_attendance y
       ON y.event_id = x.event_id AND x.person_id < y.person_id
JOIN   hr.public.employment mx ON mx.person_id = x.person_id
JOIN   hr.public.employment my
       ON my.person_id = y.person_id AND my.company_id = mx.company_id
JOIN   hr.public.companies c   ON c.id = mx.company_id
JOIN   community.public.events e ON e.id = x.event_id
WHERE  hour(e.start_ts) >= 17`,
  },
  run(ctx) {
    const result = base(this, ctx);
    if (!ctx.sources.has('community')) {
      return unavailable(result, '社区应用未接入：没有活动报名记录。');
    }
    const hr = ctx.sources.has('hr');
    result.classes = [':Person', ':Employee', ':Company', ':SocialEvent'];
    result.subclass = [[':Employee', ':Person']];
    // 工作日 17:00 之后开始的活动
    const happened = events.filter(
      (e) =>
        e.start <= ctx.t &&
        !DAYS[dayOf(e.start)].weekend &&
        e.start - dayOf(e.start) * DAY >= hours(17),
    );
    if (!happened.length) {
      result.summary = '暂无活动';
      result.notes.push(
        `截至${formatDayTime(ctx.t)}，本周还没有下班后的活动。第一场是周二晚上的读书会。`,
      );
      return result;
    }
    for (const event of happened) {
      const when = DAYS[dayOf(event.start)].label;
      result.entities.push({
        key: `ev${event.id}`,
        kind: 'event',
        ref: event.id,
        label: `${when}${event.title}`,
        cls: ':SocialEvent',
        sources: ['community'],
        hit: true,
      });
      const attendees = event.attendees.map((id) => personById.get(id)!);
      if (!hr) {
        result.rows.push({
          key: `e${event.id}`,
          title: `${when}${event.title}`,
          detail: `${attendees.length} 人参加（不知道谁是同事）`,
          hit: false,
        });
        continue;
      }
      const byCompany = new Map<number, Person[]>();
      for (const person of attendees) {
        if (!person.companyId) continue;
        byCompany.set(person.companyId, [...(byCompany.get(person.companyId) ?? []), person]);
      }
      for (const [companyId, group] of byCompany) {
        if (group.length < 2) continue;
        const company = companyById.get(companyId)!;
        const who = ctx.detail
          ? group.map((p) => personLabel(p, ctx)).join('、')
          : `${group.length} 人`;
        result.rows.push({
          key: `e${event.id}c${companyId}`,
          title: `${when}${event.title} · ${company.name}`,
          detail: who,
          hit: true,
        });
        if (!result.entities.some((e) => e.key === `c${companyId}`)) {
          result.entities.push({
            key: `c${companyId}`,
            kind: 'company',
            ref: companyId,
            label: company.name,
            cls: ':Company',
            sources: ['hr'],
            hit: true,
          });
        }
        if (ctx.detail) {
          for (const person of group) {
            const key = `p${person.id}`;
            if (!result.entities.some((e) => e.key === key)) {
              result.entities.push({
                key,
                kind: 'person',
                ref: person.id,
                label: personLabel(person, ctx),
                cls: ':Employee',
                sources: ['community', 'hr'],
                hit: true,
              });
            }
            if (!result.relations.some((r) => r.from === key && r.to === `c${companyId}`)) {
              result.relations.push({ from: key, to: `c${companyId}`, label: 'worksFor' });
            }
            result.relations.push({ from: key, to: `ev${event.id}`, label: 'attended' });
            if (person.persona && hasItinerary(person.id) && ctx.sources.has('gis')) {
              result.highlights.push({
                type: 'persona',
                id: person.id,
                path: [],
                label: person.name!,
              });
            }
          }
        } else {
          result.relations.push({
            from: `c${companyId}`,
            to: `ev${event.id}`,
            label: `${group.length} 人`,
          });
        }
      }
    }
    if (!hr) result.notes.push('企业与门禁未接入：知道谁参加了活动，但不知道他们是否同事。');
    result.notes.push(
      ctx.detail ? '人物为虚构。' : '当前为聚合视图：只给出每场活动中同一公司的人数。',
    );
    const count = result.rows.filter((r) => r.hit).length;
    result.summary = hr ? `${count} 组同事` : '无法判断同事关系';
    return result;
  },
};

const commuteCars: CityQuery = {
  id: 'commuteCars',
  group: 'life',
  title: '开车上班的员工今天几点到、车在哪里',
  description: '停车许可与车库进出记录来自企业系统，车辆位置来自交通时序；车牌把两者连在一起。',
  sources: ['hr', 'traffic', 'gis'],
  suggest: at(0, 9, 30),
  personal: true,
  text: {
    sparql: `SELECT ?company ?status (COUNT(?permit) AS ?n) WHERE {
  ?p :worksFor ?c ; :hasParkingPermit ?permit .
  ?c :name ?company .
  ?permit :plate ?plate .
  OPTIONAL { ?entry a :GarageEntry ; :plate ?plate ;
                    :enteredAt ?in . FILTER NOT EXISTS { ?entry :leftAt ?out } }
  OPTIONAL { ?car :plate ?plate ; :hasPosition [ :time ?now ] .
             BIND (true AS ?moving) }
  BIND (IF(BOUND(?in), "车库", IF(BOUND(?moving), "路上", "未到")) AS ?status)
}
GROUP BY ?company ?status`,
    sql: `SELECT c.name,
       COUNT(g.plate)  FILTER (WHERE g.left_at IS NULL) AS parked,
       COUNT(v.plate)  AS driving
FROM   hr.public.parking_permits p
JOIN   hr.public.companies c ON c.id = p.company_id
LEFT JOIN hr.public.garage_entries g
       ON g.plate = p.plate AND CAST(g.entered_at AS date) = :today
LEFT JOIN traffic.public.vehicle_positions v
       ON v.plate = p.plate AND v.ts = :now
GROUP  BY c.name`,
  },
  detailText: {
    sparql: `SELECT ?name ?plate ?in ?road WHERE {
  ?p :name ?name ; :hasParkingPermit/:plate ?plate .
  OPTIONAL { ?e a :GarageEntry ; :plate ?plate ; :enteredAt ?in }
  OPTIONAL { ?car :plate ?plate ;
                  :hasPosition [ :time ?now ; :onSegment/:name ?road ] }
}`,
    sql: `SELECT r.id, p.plate, g.entered_at, s.name AS road
FROM   hr.public.parking_permits p
JOIN   community.public.residents r ON r.id = p.person_id
LEFT JOIN hr.public.garage_entries g
       ON g.plate = p.plate AND CAST(g.entered_at AS date) = :today
LEFT JOIN traffic.public.vehicle_positions v
       ON v.plate = p.plate AND v.ts = :now
LEFT JOIN gis.public.roads s ON s.id = v.road_id`,
  },
  run(ctx) {
    const result = base(this, ctx);
    if (!ctx.sources.has('hr')) {
      return unavailable(result, '企业与门禁未接入：不知道哪些车属于员工。');
    }
    const traffic = ctx.sources.has('traffic');
    const gis = ctx.sources.has('gis');
    const day = dayOf(ctx.t);
    const trips = tripsOf(day).filter((trip) => trip.kind === 'drive');
    const near = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) < 5;
    // 车库进出：开到公司的行程到达即入库，从公司出发即驶出
    const status = carOwners.map((owner) => {
      const work = buildingCenter(companyById.get(owner.companyId)!.buildingId);
      const mine = trips.filter((trip) => trip.person === owner.person);
      const moving = mine.find((trip) => trip.pickup <= ctx.t && ctx.t < trip.arrive);
      const entered = mine.find((trip) => near(trip.to, work) && trip.arrive <= ctx.t)?.arrive;
      const left = mine.find((trip) => near(trip.from, work) && trip.pickup <= ctx.t)?.pickup;
      const parked = entered !== undefined && left === undefined && !moving;
      return { owner, moving, entered, left, parked };
    });
    for (const company of companies.filter((c) => c.buildingId)) {
      const staff = status.filter((s) => s.owner.companyId === company.id);
      const parked = staff.filter((s) => s.parked).length;
      const arrived = staff.filter((s) => s.entered !== undefined).length;
      const driving = staff.filter((s) => s.moving).length;
      result.rows.push({
        key: `c${company.id}`,
        title: `${company.name} · ${staff.length} 张停车许可`,
        detail: `今日入库 ${arrived} · 在库 ${parked}${traffic ? ` · 路上 ${driving}` : ''}`,
        hit: arrived > 0,
      });
      result.entities.push({
        key: `c${company.id}`,
        kind: 'company',
        ref: company.id,
        label: company.name,
        cls: ':Company',
        sources: ['hr'],
        hit: true,
      });
      if (gis) {
        result.highlights.push({
          type: 'place',
          at: buildingCenter(company.buildingId),
          label: `${company.name}车库 · ${parked} 辆`,
        });
      }
    }
    if (traffic) {
      for (const { owner } of status.filter((s) => s.moving)) {
        const vehicle = vehicleByOwner.get(owner.person)!;
        result.highlights.push({
          type: 'vehicle',
          id: vehicle.id,
          label: ctx.detail ? `${labelOf(owner.person, ctx)} · ${vehicle.plate}` : vehicle.plate,
        });
        result.entities.push({
          key: `v${vehicle.id}`,
          kind: 'vehicle',
          ref: vehicle.id,
          label: vehicle.plate,
          cls: ':Vehicle',
          sources: ['hr', 'traffic'],
          hit: true,
        });
        result.relations.push({
          from: `v${vehicle.id}`,
          to: `c${owner.companyId}`,
          label: 'permitFor',
        });
      }
    } else {
      result.notes.push('交通时序未接入：只知道车库进出记录，不知道车辆是否在路上、在哪条路上。');
    }
    if (ctx.detail) {
      const recent = status
        .filter((s) => s.moving || s.entered !== undefined || s.left !== undefined)
        .sort(
          (a, b) =>
            (b.left ?? b.entered ?? b.moving!.pickup) - (a.left ?? a.entered ?? a.moving!.pickup),
        )
        .sort(
          (a, b) => Number(hasItinerary(b.owner.person)) - Number(hasItinerary(a.owner.person)),
        );
      for (const { owner, moving, entered, left } of recent.slice(0, 8)) {
        const vehicle = vehicleByOwner.get(owner.person)!;
        let detail: string;
        if (moving && traffic) {
          const state = vehicleAt(vehicle, ctx.t);
          detail = `行驶中 · ${state && gis ? edgeById.get(state.edge)!.name : vehicle.plate}`;
        } else if (left !== undefined) {
          detail = `${formatTime(left)} 驶出车库`;
        } else if (entered !== undefined) {
          detail = `${formatTime(entered)} 入库`;
        } else {
          detail = '已出发';
        }
        result.rows.push({
          key: `d${owner.person}`,
          title: labelOf(owner.person, ctx),
          detail,
          hit: Boolean(moving),
        });
        result.entities.push({
          key: `p${owner.person}`,
          kind: 'person',
          ref: owner.person,
          label: labelOf(owner.person, ctx),
          cls: ':Employee',
          sources: ['hr'],
          hit: true,
        });
        result.relations.push({
          from: `p${owner.person}`,
          to: `c${owner.companyId}`,
          label: 'worksFor',
        });
        if (hasItinerary(owner.person) && gis) {
          result.highlights.push({
            type: 'persona',
            id: owner.person,
            path: [],
            label: labelOf(owner.person, ctx),
          });
        }
      }
      result.notes.push(
        '人物为虚构。停车许可登记了车牌与员工编号，车牌出现在交通时序中，即可得知是谁的车。',
      );
    } else {
      result.notes.push('当前为聚合视图：只给出各公司车库与路上的车辆数。');
    }
    const arrived = status.filter((s) => s.entered !== undefined).length;
    result.summary = `${arrived} 辆已入库`;
    result.notes.push('街区不大，开车上班通常只需一两分钟，同一时刻在路上的员工车辆很少。');
    if (DAYS[day].weekend) result.notes.push('周末不上班，车库基本是空的。');
    result.classes = [':Employee', ':Person', ':Company', ':Vehicle', ':ParkingPermit'];
    result.subclass = [[':Employee', ':Person']];
    return result;
  },
};

/** 某人此前（本周、早于 day）是否叫过网约车。 */
const orderedBefore = (person: string, day: number) =>
  Array.from({ length: day }, (_, d) => tripsOf(d)).some((trips) =>
    trips.some((trip) => trip.kind === 'taxi' && trip.person === person),
  );

const weatherTaxi: CityQuery = {
  id: 'weatherTaxi',
  group: 'life',
  title: '恶劣天气时改乘网约车的居民',
  description:
    '订单来自出行服务，天气来自气象观测，住址来自社区应用；与此前同类日同时段的订单量比较。',
  sources: ['mobility', 'weather', 'community'],
  suggest: at(1, 18, 40),
  personal: true,
  text: {
    sparql: `SELECT (COUNT(?o) AS ?orders) WHERE {
  ?o a :RideOrder ; :requestedAt ?t .
  ?w a :WeatherObservation ; :interval ?iv ;
     :precipitation ?mm ; :visibility ?vis ; :windSpeed ?wind .
  FILTER (?t >= ?iv_start && ?t < ?iv_end)
  FILTER (?mm > 0 || ?vis < 1000 || ?wind >= 8)
}`,
    sql: `SELECT COUNT(*) AS orders
FROM   mobility.public.ride_orders o
JOIN   weather.obs.observations w
       ON o.requested_at >= w.ts
      AND o.requested_at < w.ts + INTERVAL '10' MINUTE
WHERE  w.precipitation > 0 OR w.visibility < 1000 OR w.wind >= 8`,
  },
  detailText: {
    sparql: `SELECT ?person ?from ?to WHERE {
  ?o a :RideOrder ; :passenger ?person ; :requestedAt ?t ;
     :pickup ?from ; :dropoff ?to ; :duringBadWeather true .
  FILTER NOT EXISTS {
    ?earlier a :RideOrder ; :passenger ?person ; :requestedAt ?t0 .
    FILTER (?t0 < ?weekStart || ?t0 < ?today)
  }
}`,
    sql: `SELECT o.passenger_id, o.pickup, o.dropoff
FROM   mobility.public.ride_orders o
WHERE  o.during_bad_weather
  AND  NOT EXISTS (
         SELECT 1 FROM mobility.public.ride_orders e
         WHERE  e.passenger_id = o.passenger_id
           AND  e.requested_at < :today)`,
  },
  run(ctx) {
    const result = base(this, ctx);
    if (!ctx.sources.has('mobility'))
      return unavailable(result, '出行服务未接入：没有网约车订单。');
    const weather = ctx.sources.has('weather');
    const gis = ctx.sources.has('gis');
    const day = dayOf(ctx.t);
    const windows: [number, number][] = weather
      ? badWeatherWindows(ctx.t)
      : [[startOfDay(day), ctx.t]];
    if (weather && !windows.length) {
      result.summary = '尚无恶劣天气';
      result.notes.push(
        `${DAYS[day].label}截至 ${formatTime(ctx.t)} 没有恶劣天气。本周周二傍晚降雨、周三早晨大雾、周五午后雷阵雨、周日大风降温。`,
      );
      return result;
    }
    const inside = (t: number, shift = 0) =>
      windows.some(([a, b]) => t >= a - shift && t < Math.min(b, ctx.t) - shift);
    const orders = tripsOf(day).filter(
      (trip) => trip.kind === 'taxi' && trip.request <= ctx.t && inside(trip.request),
    );
    const days = baselineDays(ctx.t, windows, weather);
    const baseline = days.length
      ? days.reduce(
          (sum, d) =>
            sum +
            tripsOf(d).filter(
              (trip) => trip.kind === 'taxi' && inside(trip.request, (day - d) * DAY),
            ).length,
          0,
        ) / days.length
      : null;

    for (const [a, b] of windows) {
      const end = Math.min(b, ctx.t);
      const n = orders.filter((o) => o.request >= a && o.request < end).length;
      result.rows.push({
        key: `w${a}`,
        title: `${weather ? observationAt((a + end) / 2).condition : '今天'} ${formatTime(a)}–${formatTime(end)}`,
        detail: `${n} 单`,
        hit: true,
      });
    }
    if (baseline !== null) {
      result.notes.push(
        `同时段共 ${orders.length} 单，此前同类日（${days.map((d) => DAYS[d].label).join('、')}）平均 ${baseline.toFixed(1)} 单。`,
      );
    }
    if (!weather) result.notes.push('气象观测未接入：无法区分天气，下面是今天截至此刻的全部订单。');
    result.summary = `${orders.length} 单`;

    if (ctx.detail) {
      // 具名人物排在前面，其余按时间倒序
      const firstTime = orders
        .filter((o) => !orderedBefore(o.person, day))
        .reverse()
        .sort((a, b) => Number(hasItinerary(b.person)) - Number(hasItinerary(a.person)));
      for (const order of firstTime.slice(0, 8)) {
        const who = ctx.sources.has('community')
          ? labelOf(order.person, ctx)
          : `乘客 ${order.person}`;
        const route = gis
          ? `${placeName(order.from)} → ${placeName(order.to)}`
          : `订单 ${order.id}`;
        result.rows.push({
          key: `o${order.id}`,
          title: who,
          detail: `${formatTime(order.request)} · ${route}`,
          hit: true,
        });
        result.entities.push({
          key: `p${order.person}`,
          kind: 'person',
          ref: order.person,
          label: who,
          cls: ':Person',
          sources: (['mobility', 'community'] as SourceId[]).filter((id) => ctx.sources.has(id)),
          hit: true,
        });
        result.relations.push({ from: `p${order.person}`, to: `o${order.id}`, label: 'requested' });
        if (hasItinerary(order.person) && gis) {
          result.highlights.push({ type: 'persona', id: order.person, path: [], label: who });
        }
      }
      result.notes.push('明细只列出本周此前没有叫过车的乘客。人物为虚构。');
    } else {
      result.notes.push('当前为聚合视图：只给出订单数量，不涉及具体乘客。');
    }
    for (const order of orders.slice(-8)) {
      result.entities.push({
        key: `o${order.id}`,
        kind: 'order',
        ref: order.id,
        label: `订单 ${order.id}`,
        cls: ':RideOrder',
        sources: ['mobility'],
        hit: true,
      });
      if (weather) result.relations.push({ from: `o${order.id}`, to: 'weather', label: 'during' });
      if (order.pickup <= ctx.t && ctx.t < order.arrive) {
        // 明细视图中具名人物自带标签，不再重复标注车辆
        const named = ctx.detail && hasItinerary(order.person);
        result.highlights.push({
          type: 'vehicle',
          id: order.vehicle,
          label: named
            ? undefined
            : ctx.detail
              ? `${labelOf(order.person, ctx)} · 乘车中`
              : '载客中',
        });
      }
    }
    if (weather) {
      result.entities.push({
        key: 'weather',
        kind: 'weather',
        ref: 0,
        label: '恶劣天气观测',
        cls: ':WeatherObservation',
        sources: ['weather'],
        hit: true,
      });
    }
    result.classes = [
      ':RideOrder',
      ':TravelRecord',
      ':WeatherObservation',
      'sosa:Observation',
      ':Person',
    ];
    result.subclass = [
      [':RideOrder', ':TravelRecord'],
      [':WeatherObservation', 'sosa:Observation'],
    ];
    return result;
  },
};

const busShopping: CityQuery = {
  id: 'busShopping',
  group: 'life',
  title: '下公交后 30 分钟内在附近消费的乘客',
  description: '刷卡记录来自出行服务，会员消费来自商户系统，站点与商店的距离来自城市基础数据。',
  sources: ['mobility', 'commerce', 'gis'],
  suggest: at(2, 19, 30),
  personal: true,
  text: {
    sparql: `SELECT ?shop (COUNT(DISTINCT ?p) AS ?riders) WHERE {
  ?tap a :TransitTap ; :holder ?p ; :alightAt ?stop ; :time ?t1 .
  ?buy a :Purchase ; :member ?p ; :atShop ?s ; :time ?t2 .
  FILTER (?t2 > ?t1 && ?t2 < ?t1 + "PT30M"^^xsd:duration)
  ?stop geo:hasGeometry/geo:asWKT ?a .
  ?s geo:hasGeometry/geo:asWKT ?b ; :name ?shop .
  FILTER (geof:distance(?a, ?b, uom:metre) < 300)
}
GROUP BY ?shop`,
    sql: `SELECT p.name, COUNT(DISTINCT t.card_holder) AS riders
FROM   mobility.public.transit_taps t
JOIN   pos.shop.member_purchases m
       ON m.member_id = t.card_holder
      AND m.ts BETWEEN t.ts AND t.ts + INTERVAL '30' MINUTE
JOIN   pos.shop.shops p     ON p.building_id = m.building_id
JOIN   gis.public.stops s   ON s.id = t.stop_id
JOIN   gis.public.buildings b ON b.id = p.building_id
WHERE  t.kind = 'alight'
  AND  ST_DWithin(s.location, b.footprint, 300)
GROUP  BY p.name`,
  },
  detailText: {
    sparql: `SELECT ?p ?stop ?t1 ?shop ?t2 WHERE {
  ?tap a :TransitTap ; :holder ?p ; :alightAt ?stop ; :time ?t1 .
  ?buy a :Purchase ; :member ?p ; :atShop/:name ?shop ; :time ?t2 .
  FILTER (?t2 > ?t1 && ?t2 < ?t1 + "PT30M"^^xsd:duration)
}`,
    sql: `SELECT t.card_holder, t.stop_id, t.ts, m.building_id, m.ts
FROM   mobility.public.transit_taps t
JOIN   pos.shop.member_purchases m
       ON m.member_id = t.card_holder
      AND m.ts BETWEEN t.ts AND t.ts + INTERVAL '30' MINUTE
WHERE  t.kind = 'alight'`,
  },
  run(ctx) {
    const result = base(this, ctx);
    if (!ctx.sources.has('mobility'))
      return unavailable(result, '出行服务未接入：没有公交刷卡记录。');
    if (!ctx.sources.has('commerce'))
      return unavailable(result, '商户系统未接入：没有会员消费记录。');
    const gis = ctx.sources.has('gis');
    const day = dayOf(ctx.t);
    const alights = tapsOf(day).filter((tap) => tap.kind === 'alight' && tap.time <= ctx.t);
    const matches = purchasesOf(day)
      .filter((p) => p.time <= ctx.t)
      .flatMap((purchase) => {
        const tap = alights.find((a) => {
          if (
            a.card !== purchase.member ||
            purchase.time <= a.time ||
            purchase.time > a.time + 1800
          )
            return false;
          if (!gis) return true;
          const stop = nodeById.get(a.node)!;
          const c = buildingCenter(shops.find((s) => s.id === purchase.shop)!.buildingId);
          return Math.hypot(c.x - stop.x, c.y - stop.y) < 300;
        });
        return tap ? [{ purchase, tap }] : [];
      });
    const byShop = new Map<number, typeof matches>();
    for (const match of matches) {
      byShop.set(match.purchase.shop, [...(byShop.get(match.purchase.shop) ?? []), match]);
    }
    const ranked = [...byShop.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [index, [shopId, list]] of ranked.entries()) {
      const shop = shops.find((s) => s.id === shopId)!;
      const riders = new Set(list.map((m) => m.purchase.member)).size;
      if (!ctx.detail) {
        result.rows.push({
          key: `shop${shopId}`,
          title: shop.name,
          detail: `${riders} 人`,
          hit: true,
        });
      }
      if (gis) {
        result.highlights.push({
          type: 'place',
          at: buildingCenter(shop.buildingId),
          label: `${shop.name} · ${riders} 人`,
        });
      }
      // 分层视图只展示人数最多的五家店及对应站点
      if (index >= 5) continue;
      result.entities.push({
        key: `shop${shopId}`,
        kind: 'shop',
        ref: shopId,
        label: shop.name,
        cls: shop.category === '咖啡' ? ':Cafe' : ':Shop',
        sources: (['commerce', 'gis'] as SourceId[]).filter((id) => ctx.sources.has(id)),
        hit: true,
      });
      // 每家店只连到下车人数最多的站点
      const counts = new Map<number, number>();
      for (const m of list) counts.set(m.tap.node, (counts.get(m.tap.node) ?? 0) + 1);
      const busiest = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      for (const node of [busiest]) {
        const key = `stop${node}`;
        if (!result.entities.some((e) => e.key === key)) {
          result.entities.push({
            key,
            kind: 'stop',
            ref: node,
            label: gis ? `${nodeById.get(node)!.name} 站` : `站点 #${node}`,
            cls: ':BusStop',
            sources: (['mobility', 'gis'] as SourceId[]).filter((id) => ctx.sources.has(id)),
            hit: true,
          });
        }
        result.relations.push({ from: key, to: `shop${shopId}`, label: 'nearby' });
      }
    }
    if (ctx.detail) {
      // 每人每店一行；具名人物排在前面，其余按时间倒序
      const seen = new Set<string>();
      const listed = matches
        .slice()
        .reverse()
        .filter(({ purchase }) => {
          const key = `${purchase.member}:${purchase.shop}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort(
          (a, b) =>
            Number(hasItinerary(b.purchase.member)) - Number(hasItinerary(a.purchase.member)),
        );
      for (const { purchase, tap } of listed.slice(0, 10)) {
        const shop = shops.find((s) => s.id === purchase.shop)!;
        const stop = gis ? nodeById.get(tap.node)!.name : `站点 #${tap.node}`;
        result.rows.push({
          key: `m${purchase.shop}:${purchase.member}:${Math.round(purchase.time)}`,
          title: labelOf(purchase.member, ctx),
          detail: `${formatTime(tap.time)} ${stop} 下车 → ${formatTime(purchase.time)} ${shop.name}`,
          hit: true,
        });
        if (hasItinerary(purchase.member) && gis) {
          result.highlights.push({
            type: 'persona',
            id: purchase.member,
            path: [],
            label: labelOf(purchase.member, ctx),
          });
        }
      }
      result.notes.push(
        '人物为虚构。刷卡卡号与会员号都登记为居民编号，映射为同一个 IRI :person/{id}。',
      );
    } else {
      result.notes.push('当前为聚合视图：按商店统计人数，不涉及具体乘客。');
    }
    result.summary = `${new Set(matches.map((m) => m.purchase.member)).size} 人`;
    result.notes.push(
      gis
        ? `${DAYS[day].label}截至 ${formatTime(ctx.t)}：下车后 30 分钟内、在站点 300 米内的商店消费。`
        : '城市基础数据未接入：无法计算站点与商店的距离，结果包含远处的消费。',
    );
    result.classes = [':TransitTap', ':TravelRecord', ':Purchase', ':Shop', ':Cafe', ':Person'];
    result.subclass = [
      [':TransitTap', ':TravelRecord'],
      [':Cafe', ':Shop'],
    ];
    return result;
  },
};

function buildingCenter(id: number): Point {
  const b = city.buildings.find((x) => x.id === id)!;
  return { x: b.footprint.x + b.footprint.w / 2, y: b.footprint.y + b.footprint.h / 2 };
}

function venueLabel(event: CommunityEvent, ctx: CityContext) {
  if (event.venue.kind === 'park') {
    return ctx.sources.has('gis') ? city.parks[0].name : `公园 #${event.venue.id}`;
  }
  const venueId = event.venue.id;
  const shop = shops.find((s) => s.buildingId === venueId);
  if (shop && ctx.sources.has('commerce')) return shop.name;
  return ctx.sources.has('gis') ? buildingName(venueId) : `建筑 #${venueId}`;
}

export const cityQueries: CityQuery[] = [
  queues,
  trails,
  sensorAnomaly,
  rainFootfall,
  weatherSpeed,
  heatIsland,
  persona,
  afterwork,
  commuteCars,
  weatherTaxi,
  busShopping,
];

export const QUERY_GROUPS: { id: QueryGroup; label: string }[] = [
  { id: 'dynamic', label: '动态数据' },
  { id: 'fusion', label: '数据融合' },
  { id: 'life', label: '工作与生活' },
];

export { names as sourceNames, personas, roads, signalState };

export const CITY_MAPPING = `mappingId  resident
target     :person/{id} a :Person ; :livesIn :building/{home_building} .
source     SELECT id, home_building FROM community.public.residents

mappingId  employment
target     :person/{person_id} :worksFor :company/{company_id} .
source     SELECT person_id, company_id FROM hr.public.employment

mappingId  footfall
target     :count/{device}/{ts} a :FootfallCount ;
               :atShop :shop/{building_id} ; :count {n} ; :hour {hour} .
source     SELECT device, building_id, ts, n, date_trunc('hour', ts) AS hour
           FROM iot.public.footfall

mappingId  env_reading
target     :obs/{device}/{ts} a :TemperatureObservation ;
               sosa:madeBySensor :sensor/{device} ;
               sosa:hasSimpleResult {temp_c} ; sosa:resultTime {ts} .
source     SELECT device, ts, temp_c FROM iot.public.env_readings

mappingId  shop
target     :shop/{building_id} a :Shop ; :name {name} ; :category {category} .
source     SELECT building_id, name, category FROM pos.shop.shops

mappingId  parking_permit
target     :person/{person_id} :hasParkingPermit :permit/{plate} .
           :permit/{plate} a :ParkingPermit ; :plate {plate} .
source     SELECT person_id, plate FROM hr.public.parking_permits

mappingId  ride_order
target     :order/{id} a :RideOrder ; :passenger :person/{passenger_id} ;
               :requestedAt {requested_at} ; :vehicle :vehicle/{plate} .
source     SELECT id, passenger_id, requested_at, plate
           FROM mobility.public.ride_orders`;

export const CITY_ONTOLOGY = `:Cafe                   rdfs:subClassOf :Shop .
:Bus                    rdfs:subClassOf :ServiceVehicle .
:Taxi                   rdfs:subClassOf :ServiceVehicle .
:ServiceVehicle         rdfs:subClassOf :Vehicle .
:EnvSensor              rdfs:subClassOf sosa:Sensor .
:FootfallCount          rdfs:subClassOf sosa:Observation .
:TemperatureObservation rdfs:subClassOf sosa:Observation .
:WeatherObservation     rdfs:subClassOf sosa:Observation .
:RideOrder              rdfs:subClassOf :TravelRecord .
:TransitTap             rdfs:subClassOf :TravelRecord .
:Employee               rdfs:subClassOf :Person .
:worksFor               rdfs:domain     :Employee .
:hasParkingPermit       rdfs:domain     :Employee .`;
