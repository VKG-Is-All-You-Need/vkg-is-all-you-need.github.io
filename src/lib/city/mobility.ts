/**
 * 人的出行与消费（出行服务与商户系统中的记录，全部为虚构数据）：
 * - 具名人物每天的行程：步行、骑车、地铁、自驾、公交、打车、在店里购物；
 * - 公交刷卡：乘客上下车的站点与时刻，由公交进站记录生成，车上人数随之变化；
 * - 会员消费：一部分来自下车后到附近商店购物的乘客，其余为日常消费。
 * 自驾、打车与公交的时刻取自交通模拟（traffic.ts），人物与所乘车辆的位置因此始终一致。
 */
import { city } from '../geo/city';
import { pointInPolygon, rectCenter, seededRandom, type Point } from '../geo/spatial';
import { footfallRate, shops, type Shop } from './commerce';
import { PLACES, homeOf, people, personaShift, personaTrips, stationAt } from './people';
import { nearestNode, nodeById } from './roads';
import { DAYS, at, bell, dayOf, hours, timeOfDay } from './time';
import {
  rushAt,
  stopVisits,
  tripsOf,
  vehicleAt,
  vehicleById,
  vehicles,
  type Trip,
} from './traffic';
import { rainAt } from './weather';

export type LegMode =
  | 'home'
  | 'walk'
  | 'metro'
  | 'bike'
  | 'work'
  | 'event'
  | 'run'
  | 'drive'
  | 'bus'
  | 'taxi'
  | 'wait'
  | 'shop';

export interface Leg {
  start: number;
  end: number;
  mode: LegMode;
  path: Point[];
  label: string;
  /** 驾驶或乘坐的车辆。 */
  vehicle?: string;
  /** 购物：商店与消费金额。 */
  shop?: number;
  amount?: number;
}

/** 沿道路行走的路径：先走到最近的街道，沿街道到达目的地附近，再进入建筑。 */
function streetPath(from: Point, to: Point): Point[] {
  const snapX = (x: number) => Math.min(800, Math.max(160, Math.round(x / 160) * 160));
  const snapY = (y: number) => Math.min(540, Math.max(180, Math.round(y / 180) * 180));
  const sx = snapX(from.x);
  const tx = snapX(to.x);
  const sy = snapY(to.y);
  return [from, { x: sx, y: from.y }, { x: sx, y: sy }, { x: tx, y: sy }, { x: tx, y: to.y }, to];
}

/** 夜跑：绕湖一圈的路径。 */
const lakeLoop: Point[] = Array.from({ length: 25 }, (_, i) => {
  const a = (i / 24) * Math.PI * 2;
  const lake = city.parks[0].lake;
  return {
    x: lake.center.x + Math.cos(a) * (lake.rx + 22),
    y: lake.center.y + Math.sin(a) * (lake.ry + 22),
  };
});

const nodeAt = (x: number, y: number) =>
  [...nodeById.values()].find((n) => n.x === x && n.y === y)!;
const pointOf = (node: { x: number; y: number }): Point => ({ x: node.x, y: node.y });
const shopNamed = (name: string) => shops.find((s) => s.name === name)!;
const shopCenter = (shop: Shop) =>
  rectCenter(city.buildings.find((b) => b.id === shop.buildingId)!.footprint);
const nearestShop = (p: Point, category: Shop['category']) =>
  shops
    .filter((s) => s.category === category)
    .sort((a, b) => {
      const ca = shopCenter(a);
      const cb = shopCenter(b);
      return Math.hypot(ca.x - p.x, ca.y - p.y) - Math.hypot(cb.x - p.x, cb.y - p.y);
    })[0];

/** 按当天的时刻依次排列行程：每段的起点为上一段的结束。 */
function schedule(day: number) {
  const legs: Leg[] = [];
  let cursor = at(day, 6);
  const add = (leg: Omit<Leg, 'start'>) => {
    legs.push({ start: cursor, ...leg });
    cursor = Math.max(cursor, leg.end);
  };
  const trip = (id: string): Trip | undefined => tripsOf(day).find((t) => t.id === id);
  const plan = (id: string) => personaTrips(day).find((t) => t.id === id)!;
  const time = (h: number, m = 0) => at(day, h, m);
  return {
    legs,
    time,
    /** 停留到某个时刻。 */
    stay: (mode: LegMode, until: number, place: Point, label: string) =>
      add({ end: Math.max(until, cursor), mode, path: [place], label }),
    /** 移动若干分钟。 */
    move: (mode: LegMode, minutes: number, path: Point[], label: string) =>
      add({ end: cursor + minutes * 60, mode, path, label }),
    /** 待到当天结束。 */
    rest: (place: Point, label = '在家') =>
      add({ end: time(24), mode: 'home', path: [place], label }),
    /** 计划中的出发时刻。 */
    departure: (id: string) => plan(id).depart,
    /** 自驾：按交通模拟的到达时刻下车，再步行进入目的地。 */
    drive: (id: string, label: string) => {
      const t = trip(id);
      const planned = plan(id);
      if (!t) {
        add({
          end: cursor + 600,
          mode: 'walk',
          path: streetPath(planned.from, planned.to),
          label: '步行',
        });
        return;
      }
      const park = pointOf(nearestNode(planned.to));
      add({ end: t.arrive, mode: 'drive', path: [planned.from, park], label, vehicle: t.vehicle });
      add({ end: cursor + 120, mode: 'walk', path: [park, planned.to], label: '停车后步行' });
    },
    /** 打车：在路边等车，上车后随车行驶，下车后步行进入目的地。 */
    taxi: (id: string, label: string) => {
      const t = trip(id)!;
      const pickup = pointOf(nearestNode(t.from));
      const dropoff = pointOf(nearestNode(t.to));
      add({ end: t.pickup, mode: 'wait', path: [t.from, pickup], label: '等候网约车' });
      add({ end: t.arrive, mode: 'taxi', path: [pickup, dropoff], label, vehicle: t.vehicle });
      add({ end: cursor + 60, mode: 'walk', path: [dropoff, t.to], label: '下车后步行' });
    },
    /** 公交：在站台等第一班车，到站下车。 */
    bus: (from: number, to: number, label: string) => {
      const visits = stopVisits(day);
      const board = visits.find((v) => v.node === from && v.depart >= cursor + 20)!;
      const alight = visits.find(
        (v) => v.bus === board.bus && v.node === to && v.arrive > board.depart,
      )!;
      const a = pointOf(nodeById.get(from)!);
      const b = pointOf(nodeById.get(to)!);
      add({ end: board.depart, mode: 'wait', path: [a], label: '等公交' });
      add({ end: alight.arrive + 10, mode: 'bus', path: [a, b], label, vehicle: board.bus });
    },
    /** 在店里购物若干分钟。 */
    shop: (shop: Shop, minutes: number, amount: number, label = `在${shop.name}购物`) =>
      add({
        end: cursor + minutes * 60,
        mode: 'shop',
        path: [shopCenter(shop)],
        label,
        shop: shop.id,
        amount,
      }),
    get cursor() {
      return cursor;
    },
  };
}

type Plan = (day: number) => Leg[];

// 公交站：中心区西侧（梧桐路 × 人民路）、星河商场旁（中央大道 × 文华街）、湖畔公寓旁（中央大道 × 北园街）
const STOP_WEST = nodeAt(320, 360).id;
const STOP_MALL = nodeAt(480, 180).id;
const STOP_SOUTH = nodeAt(480, 540).id;

const PLANS: Record<string, Plan> = {
  // 林晓：住在北站附近，乘地铁通勤；周二下班去读书会，周三坐公交去商场购物，周六去周末市集
  P01: (day) => {
    const p = schedule(day);
    const home = homeOf('P01');
    const S = stationAt;
    if (day === 6) {
      p.rest(home);
      return p.legs;
    }
    if (day === 5) {
      p.stay('home', p.time(9, 30), home, '在家');
      p.move('walk', 12, streetPath(home, S('北站')), '步行至北站');
      p.move('metro', 26, [S('北站'), S('中心站'), S('湖滨站')], '地铁 1 号线换 2 号线');
      p.move('walk', 8, streetPath(S('湖滨站'), PLACES.market), '步行至周末市集');
      p.stay('event', p.time(12), PLACES.market, '周末市集');
      p.move('walk', 8, streetPath(PLACES.market, S('湖滨站')), '步行至湖滨站');
      p.move('metro', 26, [S('湖滨站'), S('中心站'), S('北站')], '地铁 2 号线换 1 号线');
      p.move('walk', 12, streetPath(S('北站'), home), '步行回家');
      p.rest(home);
      return p.legs;
    }
    const [, off] = personaShift('P01', day)!;
    p.stay('home', p.time(7, 50), home, '在家');
    p.move('walk', 12, streetPath(home, S('北站')), '步行至北站');
    p.move('metro', 18, [S('北站'), S('中心站')], '地铁 1 号线');
    p.move('walk', 8, streetPath(S('中心站'), PLACES.office), '步行至中央大厦');
    p.stay('work', off, PLACES.office, day === 3 ? '在星河科技工作（加班）' : '在星河科技工作');
    if (day === 1) {
      p.move('walk', 10, streetPath(PLACES.office, PLACES.cafe), '步行至拾光咖啡');
      p.stay('event', p.time(20, 10), PLACES.cafe, '读书会');
      p.move('walk', 6, streetPath(PLACES.cafe, S('中心站')), '步行至中心站');
    } else if (day === 2) {
      const mall = shopNamed('星河商场');
      p.move(
        'walk',
        4,
        streetPath(PLACES.office, pointOf(nodeById.get(STOP_WEST)!)),
        '步行至公交站',
      );
      p.bus(STOP_WEST, STOP_MALL, '乘公交至中央大道 × 文华街');
      p.move(
        'walk',
        3,
        streetPath(pointOf(nodeById.get(STOP_MALL)!), PLACES.mall),
        '步行至星河商场',
      );
      p.shop(mall, 35, 268);
      p.move('walk', 6, streetPath(PLACES.mall, S('中心站')), '步行至中心站');
    } else {
      p.move('walk', 8, streetPath(PLACES.office, S('中心站')), '步行至中心站');
    }
    p.move('metro', 18, [S('中心站'), S('北站')], '地铁 1 号线');
    p.move('walk', 12, streetPath(S('北站'), home), '步行回家');
    p.rest(home);
    return p.legs;
  },
  // 周宁：住湖畔公寓，开车上下班；周二读书会，周二、周四夜跑，周六逛市集，周日开车去商场
  P02: (day) => {
    const p = schedule(day);
    const home = homeOf('P02');
    const garage = pointOf(nearestNode(PLACES.office));
    if (day === 5) {
      p.stay('home', p.time(10, 40), home, '在家');
      p.move('walk', 12, streetPath(home, PLACES.market), '步行至周末市集');
      p.stay('event', p.time(13), PLACES.market, '周末市集');
      p.move('walk', 12, streetPath(PLACES.market, home), '步行回家');
      p.rest(home);
      return p.legs;
    }
    if (day === 6) {
      p.stay('home', p.departure('P02-6-out'), home, '在家');
      p.drive('P02-6-out', '开车去星河商场');
      p.shop(
        shopNamed('星河商场'),
        Math.max(10, (p.departure('P02-6-back') - p.cursor) / 60 - 3),
        412,
      );
      p.move('walk', 3, [PLACES.mall, pointOf(nearestNode(PLACES.mall))], '步行至停车场');
      p.drive('P02-6-back', '开车回家');
      p.rest(home);
      return p.legs;
    }
    p.stay('home', p.departure(`P02-${day}-am`), home, '在家');
    p.drive(`P02-${day}-am`, '开车上班');
    p.stay('work', p.time(18, 35), PLACES.office, '在星河科技工作');
    if (day === 1) {
      p.move('walk', 10, streetPath(PLACES.office, PLACES.cafe), '步行至拾光咖啡');
      p.stay('event', p.time(20, 10), PLACES.cafe, '读书会');
      p.move('walk', 8, streetPath(PLACES.cafe, garage), '步行至车库');
    } else {
      p.move('walk', 5, [PLACES.office, garage], '步行至车库');
    }
    p.drive(`P02-${day}-pm`, '开车回家');
    if (day === 1 || day === 3) {
      p.stay('home', p.time(20, 50), home, '在家');
      p.move('walk', 10, streetPath(home, PLACES.parkGate), '步行至湖滨公园');
      p.move('run', 40, lakeLoop, '夜跑');
      p.move('walk', 12, streetPath(PLACES.parkGate, home), '步行回家');
    }
    p.rest(home);
    return p.legs;
  },
  // 孙浩：步行通勤，常加班；周二、周四下班后夜跑，周四跑完去便利店；周日下雨，打车去商场，坐公交回家
  P03: (day) => {
    const p = schedule(day);
    const home = homeOf('P03');
    if (day === 6) {
      p.stay('home', p.departure('P03-6-taxi'), home, '在家');
      p.taxi('P03-6-taxi', '乘网约车去星河商场');
      p.shop(shopNamed('星河商场'), 70, 189);
      p.move('walk', 3, streetPath(PLACES.mall, pointOf(nodeById.get(STOP_MALL)!)), '步行至公交站');
      p.bus(STOP_MALL, STOP_SOUTH, '乘公交回家');
      p.move('walk', 6, streetPath(pointOf(nodeById.get(STOP_SOUTH)!), home), '步行回家');
      p.rest(home);
      return p.legs;
    }
    if (DAYS[day].weekend) {
      p.rest(home);
      return p.legs;
    }
    p.stay('home', p.time(8, 50), home, '在家');
    p.move('walk', 20, streetPath(home, PLACES.office), '步行上班');
    p.stay('work', p.time(20, 40), PLACES.office, '在星河科技工作（加班）');
    if (day === 1 || day === 3) {
      p.move('walk', 20, streetPath(PLACES.office, PLACES.parkGate), '步行至湖滨公园');
      p.move('run', 40, lakeLoop, '夜跑');
      if (day === 3) {
        const store = nearestShop(home, '便利店');
        p.move('walk', 12, streetPath(PLACES.parkGate, shopCenter(store)), `步行至${store.name}`);
        p.shop(store, 8, 36);
        p.move('walk', 6, streetPath(shopCenter(store), home), '步行回家');
      } else {
        p.move('walk', 15, streetPath(PLACES.parkGate, home), '步行回家');
      }
    } else {
      p.move('walk', 20, streetPath(PLACES.office, home), '步行回家');
    }
    p.rest(home);
    return p.legs;
  },
  // 陈雨：市立医院护士，周日上班、周六休息；周二下班时下雨，打车去读书会
  P04: (day) => {
    const p = schedule(day);
    const home = homeOf('P04');
    if (day === 5) {
      p.stay('home', p.time(10, 45), home, '在家');
      p.move('walk', 25, streetPath(home, PLACES.market), '步行至周末市集');
      p.stay('event', p.time(12, 30), PLACES.market, '周末市集');
      p.move('walk', 25, streetPath(PLACES.market, home), '步行回家');
      p.rest(home);
      return p.legs;
    }
    p.stay('home', p.time(7, 12), home, '在家');
    p.move('walk', 13, streetPath(home, PLACES.clinic), '步行上班');
    if (day === 1) {
      p.stay('work', p.departure('P04-1-taxi'), PLACES.clinic, '在市立医院值班');
      p.taxi('P04-1-taxi', '乘网约车去拾光咖啡');
      p.stay('event', p.time(20, 10), PLACES.cafe, '读书会');
      p.move('walk', 14, streetPath(PLACES.cafe, home), '步行回家');
    } else {
      p.stay('work', p.time(18, 5), PLACES.clinic, '在市立医院值班');
      p.move('walk', 13, streetPath(PLACES.clinic, home), '步行回家');
    }
    p.rest(home);
    return p.legs;
  },
  // 赵敏：街角咖啡店主，每天开店；周三在店里主持市集筹备会，周六在市集摆摊
  P06: (day) => {
    const p = schedule(day);
    const home = homeOf('P06');
    p.stay('home', day === 5 ? p.time(8, 15) : p.time(6, 40), home, '在家');
    if (day === 5) {
      p.move('walk', 25, streetPath(home, PLACES.market), '步行至周末市集');
      p.stay('event', p.time(16, 30), PLACES.market, '周末市集（摆摊）');
      p.move('walk', 20, streetPath(PLACES.market, PLACES.corner), '步行回店里');
    } else {
      p.move('walk', 15, streetPath(home, PLACES.corner), '步行至店里');
    }
    if (day === 2) {
      p.stay('work', p.time(15), PLACES.corner, '经营街角咖啡');
      p.stay('event', p.time(16), PLACES.corner, '周末市集筹备会');
    }
    p.stay('work', p.time(21, 10), PLACES.corner, '经营街角咖啡');
    p.move('walk', 15, streetPath(PLACES.corner, home), '步行回家');
    p.rest(home);
    return p.legs;
  },
};

export const PERSONA_IDS = Object.keys(PLANS);
export const hasItinerary = (id: string) => id in PLANS;

const legCache = new Map<string, Leg[]>();

/** 具名人物某一天的行程。 */
export function itinerary(id: string, day: number): Leg[] {
  const key = `${id}:${day}`;
  let legs = legCache.get(key);
  if (!legs) {
    legs = PLANS[id]?.(day) ?? [];
    legCache.set(key, legs);
  }
  return legs;
}

const RIDES: LegMode[] = ['drive', 'bus', 'taxi'];
export const isRide = (mode: LegMode) => RIDES.includes(mode);

const pathLength = (path: Point[]) =>
  path.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - path[i].x, p.y - path[i].y), 0);

function along(path: Point[], k: number): Point {
  if (path.length === 1) return path[0];
  let remaining = pathLength(path) * k;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (remaining <= length || i === path.length - 1) {
      const f = length ? Math.min(1, remaining / length) : 0;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
    remaining -= length;
  }
  return path.at(-1)!;
}

export interface PersonaState {
  x: number;
  y: number;
  leg: Leg;
}

/** 具名人物在 t 时的位置；乘车时取所乘车辆的位置。 */
export function personaAt(id: string, t: number): PersonaState | null {
  if (!hasItinerary(id)) return null;
  const legs = itinerary(id, dayOf(t));
  const current = legs.find((l) => t >= l.start && t < l.end) ?? legs.at(-1)!;
  if (current.vehicle && isRide(current.mode)) {
    const state = vehicleAt(vehicleById.get(current.vehicle)!, t);
    if (state) return { x: state.x, y: state.y, leg: current };
  }
  const k = current.end > current.start ? (t - current.start) / (current.end - current.start) : 0;
  return { ...along(current.path, Math.min(1, Math.max(0, k))), leg: current };
}

// ── 公交刷卡（出行服务） ──
export interface Tap {
  /** 持卡人（居民编号）。 */
  card: string;
  bus: string;
  node: number;
  time: number;
  kind: 'board' | 'alight';
}

interface BusDay {
  taps: Tap[];
  /** 每辆车离站时的车上人数。 */
  load: Map<string, { t: number; n: number }[]>;
}

function simulateRiders(day: number): BusDay {
  const random = seededRandom(5000 + day * 31);
  const residents = people.filter((p) => !p.persona);
  const weekend = DAYS[day].weekend;
  // 具名人物的乘车记录
  const personaRides = PERSONA_IDS.flatMap((id) =>
    itinerary(id, day)
      .filter((leg) => leg.mode === 'bus')
      .map((leg) => ({
        card: id,
        bus: leg.vehicle!,
        from: nearestNode(leg.path[0]).id,
        to: nearestNode(leg.path[1]).id,
        board: leg.start,
        alight: leg.end,
      })),
  );
  const taps: Tap[] = [];
  const load = new Map<string, { t: number; n: number }[]>();
  for (const bus of vehicles.filter((v) => v.kind === 'bus')) {
    const visits = stopVisits(day).filter((v) => v.bus === bus.id);
    const onboard: { card: string; stops: number }[] = [];
    const series: { t: number; n: number }[] = [];
    for (const visit of visits) {
      // 下车
      for (let i = onboard.length - 1; i >= 0; i--) {
        if (--onboard[i].stops > 0) continue;
        taps.push({
          card: onboard[i].card,
          bus: bus.id,
          node: visit.node,
          time: visit.arrive + 5,
          kind: 'alight',
        });
        onboard.splice(i, 1);
      }
      for (const ride of personaRides) {
        if (
          ride.bus === bus.id &&
          ride.to === visit.node &&
          Math.abs(ride.alight - visit.arrive) < 30
        ) {
          taps.push({
            card: ride.card,
            bus: bus.id,
            node: visit.node,
            time: visit.arrive + 5,
            kind: 'alight',
          });
        }
      }
      // 上车：高峰、降雨与周末午后人多。多数乘客不是本街区登记的居民，只有卡号
      const s = timeOfDay(visit.arrive);
      const rate =
        0.25 +
        1.6 * rushAt(visit.arrive) +
        1.2 * rainAt(visit.arrive) +
        0.3 * bell(s, hours(12, 30), hours(1, 30)) +
        (weekend ? 0.7 * bell(s, hours(14), hours(3)) : 0);
      for (let expected = rate; random() < expected; expected -= 1) {
        const card =
          random() < 0.35
            ? residents[Math.floor(random() * residents.length)].id
            : `C${10000 + Math.floor(random() * 90000)}`;
        onboard.push({ card, stops: 1 + Math.floor(random() * 5) });
        taps.push({ card, bus: bus.id, node: visit.node, time: visit.depart - 5, kind: 'board' });
      }
      for (const ride of personaRides) {
        if (
          ride.bus === bus.id &&
          ride.from === visit.node &&
          Math.abs(ride.board - visit.depart) < 30
        ) {
          taps.push({
            card: ride.card,
            bus: bus.id,
            node: visit.node,
            time: visit.depart - 5,
            kind: 'board',
          });
        }
      }
      const riding = personaRides.filter(
        (ride) => ride.bus === bus.id && ride.board <= visit.depart && ride.alight > visit.depart,
      ).length;
      series.push({ t: visit.depart, n: onboard.length + riding });
    }
    load.set(bus.id, series);
  }
  taps.sort((a, b) => a.time - b.time);
  return { taps, load };
}

const riderCache = new Map<number, BusDay>();
function ridersOf(day: number): BusDay {
  let riders = riderCache.get(day);
  if (!riders) {
    riders = simulateRiders(day);
    riderCache.set(day, riders);
  }
  return riders;
}

/** 某一天的公交刷卡记录。 */
export const tapsOf = (day: number) => ridersOf(day).taps;

/** 公交车在 t 时的车上人数。 */
export function busLoad(busId: string, t: number): number {
  const series = ridersOf(dayOf(t)).load.get(busId) ?? [];
  let n = 0;
  for (const point of series) {
    if (point.t > t) break;
    n = point.n;
  }
  return n;
}

// ── 会员消费（商户系统） ──
export interface Purchase {
  member: string;
  shop: number;
  time: number;
  amount: number;
}

const isOpen = (shop: Shop, t: number) => {
  const s = timeOfDay(t);
  return s >= shop.open[0] && s < shop.open[1];
};

function simulatePurchases(day: number): Purchase[] {
  const random = seededRandom(8000 + day * 17);
  const residents = people.filter((p) => !p.persona);
  const purchases: Purchase[] = [];
  // 下车后到附近商店消费
  for (const tap of tapsOf(day)) {
    // 只有登记为居民的持卡人才能与会员号对应；其中约二十分之一在附近消费
    if (tap.kind !== 'alight' || !tap.card.startsWith('R') || random() > 0.05) continue;
    const stop = nodeById.get(tap.node)!;
    const time = tap.time + 240 + random() * 1320;
    const nearby = shops.filter((shop) => {
      const c = shopCenter(shop);
      return Math.hypot(c.x - stop.x, c.y - stop.y) < 260 && isOpen(shop, time);
    });
    if (!nearby.length) continue;
    const shop = nearby[Math.floor(random() * nearby.length)];
    purchases.push({
      member: tap.card,
      shop: shop.id,
      time,
      amount: Math.round(18 + random() * 300),
    });
  }
  // 日常会员消费：约 4% 的进店顾客为会员，其中四成是本街区居民
  for (const shop of shops) {
    for (let s = shop.open[0]; s < shop.open[1]; s += 1800) {
      const t = at(day, 0) + s;
      for (
        let expected = footfallRate(shop, t + 900) * 0.5 * 0.04;
        random() < expected;
        expected -= 1
      ) {
        purchases.push({
          member:
            random() < 0.4
              ? residents[Math.floor(random() * residents.length)].id
              : `M${10000 + Math.floor(random() * 90000)}`,
          shop: shop.id,
          time: t + random() * 1800,
          amount: Math.round(12 + random() * 200),
        });
      }
    }
  }
  // 具名人物的购物
  for (const id of PERSONA_IDS) {
    for (const leg of itinerary(id, day)) {
      // 逛到一半在收银台结账
      if (leg.mode === 'shop') {
        const time = Math.min(leg.end - 60, leg.start + 900);
        purchases.push({ member: id, shop: leg.shop!, time, amount: leg.amount! });
      }
    }
  }
  return purchases.sort((a, b) => a.time - b.time);
}

const purchaseCache = new Map<number, Purchase[]>();

/** 某一天的会员消费记录。 */
export function purchasesOf(day: number): Purchase[] {
  let purchases = purchaseCache.get(day);
  if (!purchases) {
    purchases = simulatePurchases(day);
    purchaseCache.set(day, purchases);
  }
  return purchases;
}

/** 点所在的建筑或公园名称（城市基础数据）。 */
export function placeName(p: Point): string {
  const building = city.buildings.find(
    ({ footprint: f }) =>
      p.x >= f.x - 2 && p.x <= f.x + f.w + 2 && p.y >= f.y - 2 && p.y <= f.y + f.h + 2,
  );
  if (building) return building.name;
  if (pointInPolygon(p, city.parks[0].area)) return city.parks[0].name;
  return nearestNode(p).name;
}
