/**
 * 人的行程：把每个人一天的安排落实为连续的行程段。具名人物的安排是手写的剧本，其余的人来自 plans.ts，
 * 司机、配送员的行程来自交通模拟中各车辆的班次。
 * 步行沿人行道，在路口等灯；乘车时人的位置就是车的位置，自驾、打车与公交的时刻都取自交通模拟（traffic.ts），
 * 人与所乘车辆因此始终一致。各数据源的记录（records.ts）都从这里派生。
 */
import { city, type Building } from '../geo/city';
import { pointInPolygon, rectCenter, type Point } from '../geo/spatial';
import { shopById, shops, type Shop } from './commerce';
import {
  PLACES,
  homeOf,
  personById,
  personaShift,
  personaTrips,
  stationAt,
  type Person,
} from './people';
import { dayPlan, platformOf, roughPoint, spotPoint, type Spot, type Step } from './plans';
import { nearestNode, nodeById } from './roads';
import { DAY, DAYS, at, dayOf } from './time';
import {
  deliveriesOf,
  handoversOf,
  stintsOf,
  stopVisits,
  tripsOf,
  vehicleAt,
  type Stint,
  type StopVisit,
  type Trip,
} from './traffic';
import { vehicleById } from './vehicles';
import {
  curbAt,
  doorOf,
  stationExits,
  timedWalk,
  walkRoute,
  walkSeconds,
  type TimedPath,
} from './walk';

export type LegMode =
  | 'home'
  | 'walk'
  | 'metro'
  | 'work'
  | 'event'
  | 'run'
  | 'stroll'
  | 'drive'
  | 'ride'
  | 'bus'
  | 'taxi'
  | 'wait'
  | 'shop'
  | 'visit'
  | 'deliver';

export interface Leg {
  start: number;
  end: number;
  mode: LegMode;
  path: Point[];
  /** 与 path 对应的时刻（步行时含路口等灯）；没有时按匀速插值。 */
  times?: number[];
  label: string;
  /** 驾驶或乘坐的车辆。 */
  vehicle?: string;
  /** 室内停留所在的建筑。 */
  building?: number;
  /** 步行的目的地建筑。 */
  destination?: number;
  /** 购物：商店与消费金额。 */
  shop?: number;
  amount?: number;
  /** 公交：上车与下车的站点（路口编号）。 */
  stops?: [number, number];
}

const RIDES: LegMode[] = ['drive', 'ride', 'bus', 'taxi'];
export const isRide = (mode: LegMode) => RIDES.includes(mode);
/** 在室外、看得见的行程段。 */
export const isOutdoor = (leg: Leg) =>
  ['walk', 'wait', 'run', 'stroll'].includes(leg.mode) ||
  (leg.mode === 'event' && leg.building === undefined);

const buildingById = new Map(city.buildings.map((b) => [b.id, b]));
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** 点所在的建筑。 */
function buildingAt(p: Point): Building | undefined {
  return city.buildings.find(
    ({ footprint: f }) =>
      p.x >= f.x - 0.5 && p.x <= f.x + f.w + 0.5 && p.y >= f.y - 0.5 && p.y <= f.y + f.h + 0.5,
  );
}

/** 步行端点：建筑内的点从出入口进出，地铁站取离另一端最近的出入口。 */
function endpoint(p: Point, other: Point): Point {
  const building = buildingAt(p);
  if (building) return doorOf(building);
  const station = city.stations.find((s) => s.location.x === p.x && s.location.y === p.y);
  if (station) {
    return stationExits(station).reduce((best, q) =>
      distance(q, other) < distance(best, other) ? q : best,
    );
  }
  return p;
}

/** 沿人行道的步行路线。 */
function walkPoints(from: Point, to: Point): Point[] {
  const a = endpoint(from, to);
  return walkRoute(a, endpoint(to, a)).points;
}

/** 夜跑与散步：绕湖一圈的路径，在湖心茶室处从北侧绕过。 */
const teaHouse = city.buildings.find((b) => b.name === '湖心茶室')!.footprint;
const lakeLoop: Point[] = Array.from({ length: 25 }, (_, i) => {
  const a = (i / 24) * Math.PI * 2;
  const lake = city.parks[0].lake;
  const p = {
    x: lake.center.x + Math.cos(a) * (lake.rx + 22),
    y: lake.center.y + Math.sin(a) * (lake.ry + 22),
  };
  const near = p.x > teaHouse.x - 10 && p.x < teaHouse.x + teaHouse.w + 10 && p.y > teaHouse.y - 6;
  return near ? { x: p.x, y: Math.max(p.y, teaHouse.y + teaHouse.h + 5) } : p;
});

/** 从 p 出发绕湖一圈再回到 p。 */
function loopFrom(p: Point): Point[] {
  const start = lakeLoop.reduce(
    (best, q, i) => (distance(q, p) < distance(lakeLoop[best], p) ? i : best),
    0,
  );
  const ring = [...lakeLoop.slice(start, -1), ...lakeLoop.slice(0, start + 1)];
  return [p, ...ring, p];
}

const nodeAt = (x: number, y: number) =>
  [...nodeById.values()].find((n) => n.x === x && n.y === y)!;
const shopNamed = (name: string) => shops.find((s) => s.name === name)!;
const shopCenter = (shop: Shop) => rectCenter(buildingById.get(shop.buildingId)!.footprint);
const nearestShop = (p: Point, category: Shop['category']) =>
  shops
    .filter((s) => s.category === category)
    .sort((a, b) => distance(shopCenter(a), p) - distance(shopCenter(b), p))[0];

// ── 交通模拟结果的索引 ──
interface DayIndex {
  trips: Map<string, Trip>;
  /** 每个站点的进站记录，按离站时刻排序。 */
  visits: Map<number, StopVisit[]>;
}

const indexCache = new Map<number, DayIndex>();
function indexOf(day: number): DayIndex {
  let index = indexCache.get(day);
  if (!index) {
    const visits = new Map<number, StopVisit[]>();
    for (const visit of stopVisits(day)) {
      visits.set(visit.node, [...(visits.get(visit.node) ?? []), visit]);
    }
    for (const list of visits.values()) list.sort((a, b) => a.depart - b.depart);
    index = { trips: new Map(tripsOf(day).map((trip) => [trip.id, trip])), visits };
    indexCache.set(day, index);
    if (indexCache.size > 3) indexCache.delete(indexCache.keys().next().value!);
  }
  return index;
}

/** 在 stop 站、earliest 之后离站的第一班车，以及它到达 to 站的那一次进站。 */
function catchBus(day: number, stop: number, to: number, earliest: number) {
  const { visits } = indexOf(day);
  const list = visits.get(stop) ?? [];
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].depart < earliest) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < list.length; i++) {
    const board = list[i];
    const alight = (visits.get(to) ?? []).find(
      (v) => v.bus === board.bus && v.arrive > board.depart,
    );
    if (alight) return { board, alight };
  }
  return null;
}

/** 车辆在 t 时的位置旁的人行道（上下车处）。 */
function curbOf(vehicle: string, t: number): Point | null {
  const state = vehicleAt(vehicleById.get(vehicle)!, t);
  return state ? curbAt(state) : null;
}

/** 上车处：网约车停在路边等乘客；自驾的车上车时才驶出车库。 */
const boardingCurb = (trip: Trip) =>
  curbOf(trip.vehicle, trip.pickup - 1) ?? curbOf(trip.vehicle, trip.pickup + 0.5);

/** 公交到站后乘客下车的时刻：停站时间很短时在离站前下完。 */
const alightTime = (visit: StopVisit) =>
  visit.arrive + Math.min(10, (visit.depart - visit.arrive) * 0.6);

const walkLeg = (path: TimedPath, label: string): Leg => ({
  start: path.times[0],
  end: path.times.at(-1)!,
  mode: 'walk',
  path: path.points,
  times: path.times,
  label,
  destination: buildingAt(path.points.at(-1)!)?.id,
});

/** 沿人行道走到 to 的步行段（具名人物的手写行程按给定时长走完）。 */
const scriptedWalk = (from: Point, to: Point, end: number, label: string): Omit<Leg, 'start'> => {
  const path = walkPoints(from, to);
  return { end, mode: 'walk', path, label, destination: buildingAt(path.at(-1)!)?.id };
};

// ── 按安排落实行程 ──
/** 不一致之处（应当为 0），供校验脚本检查。 */
export const realizeIssues: string[] = [];

function realize(person: Person, steps: Step[], day: number): Leg[] {
  const legs: Leg[] = [];
  let t = day * DAY;
  let pos: Point | null = null;
  let here: Spot | null = null;
  const walkTo = (target: Point, label: string) => {
    if (!pos) return;
    const path = timedWalk(walkRoute(pos, target), t, person.pace);
    if (path.points.length > 1) legs.push(walkLeg(path, label));
    t = path.times.at(-1)!;
    pos = target;
  };
  /** 走到车旁等车，上车后随车行驶。 */
  const board = (trip: Trip | undefined, mode: LegMode, label: string, waiting: string) => {
    if (!trip) return false;
    const curb = pos ? boardingCurb(trip) : null;
    if (pos && curb) {
      walkTo(curb, mode === 'taxi' ? '步行至上车点' : '步行至车旁');
      if (t > trip.pickup + 1) {
        realizeIssues.push(`${person.id} 晚到 ${Math.round(t - trip.pickup)} 秒：${trip.id}`);
      }
      if (trip.pickup > t) {
        legs.push({ start: t, end: trip.pickup, mode: 'wait', path: [curb], label: waiting });
      }
    }
    legs.push({
      start: trip.pickup,
      end: trip.arrive,
      mode,
      path: [trip.from, trip.to],
      label,
      vehicle: trip.vehicle,
    });
    t = trip.arrive;
    pos = trip.exit !== undefined ? null : curbOf(trip.vehicle, trip.arrive - 0.5);
    return true;
  };
  const destinationAfter = (i: number): Spot | null => {
    for (let j = i + 1; j < steps.length; j++) {
      const step = steps[j];
      if (step.type === 'walk') return step.to;
      if (step.type === 'stay' || step.type === 'leave') return null;
    }
    return null;
  };
  steps.forEach((step, i) => {
    switch (step.type) {
      case 'begin':
        here = step.at;
        pos = spotPoint(step.at, roughPoint(step.at));
        break;
      case 'appear': {
        t = step.t;
        here = step.at;
        const next = destinationAfter(i);
        pos = spotPoint(step.at, next ? roughPoint(next) : roughPoint(step.at));
        break;
      }
      case 'stay': {
        const end = Math.max(step.until, t + (step.minimum ?? 0));
        if (end <= t) break;
        const indoor = here?.kind === 'building';
        legs.push({
          start: t,
          end,
          mode: step.mode,
          path: [indoor ? roughPoint(here!) : pos!],
          label: step.label,
          building: indoor ? (here as { id: number }).id : undefined,
          shop: step.shop,
          amount: step.amount,
        });
        t = end;
        break;
      }
      case 'walk': {
        if (!pos) {
          realizeIssues.push(`${person.id} 不在街区内却要步行`);
          break;
        }
        walkTo(spotPoint(step.to, pos), step.label);
        here = step.to;
        break;
      }
      case 'stroll': {
        if (!pos || step.until <= t) break;
        legs.push({
          start: t,
          end: step.until,
          mode: step.run ? 'run' : 'stroll',
          path: loopFrom(pos),
          label: step.label,
        });
        t = step.until;
        break;
      }
      case 'bus': {
        const platform = platformOf(step.from);
        walkTo(platform, '步行至公交站');
        const ride = catchBus(day, step.from, step.to, t + 15);
        if (!ride) {
          // 末班车已过：步行
          pos = platform;
          break;
        }
        legs.push({
          start: t,
          end: ride.board.depart,
          mode: 'wait',
          path: [platform],
          label: '等公交',
        });
        legs.push({
          start: ride.board.depart,
          end: alightTime(ride.alight),
          mode: 'bus',
          path: [platform, platformOf(step.to)],
          label: step.label,
          vehicle: ride.board.bus,
          stops: [step.from, step.to],
        });
        t = alightTime(ride.alight);
        pos = platformOf(step.to);
        break;
      }
      case 'drive':
      case 'ride': {
        const trip = indexOf(day).trips.get(step.trip);
        const label = step.type === 'drive' ? step.label : '同车';
        board(trip, step.type, label, '上车');
        break;
      }
      case 'taxi': {
        const trip = indexOf(day).trips.get(step.trip);
        if (board(trip, 'taxi', step.label, '等候网约车')) break;
        // 没有叫到车：留在街区内的步行前往目的地，要离开的走去最近的地铁站
        const next = steps[i + 1];
        if (pos && next?.type === 'leave') {
          const exits = city.stations.flatMap((station) => stationExits(station));
          const from = pos;
          walkTo(
            exits.reduce((a, b) => (distance(a, from) < distance(b, from) ? a : b)),
            '改乘地铁',
          );
        }
        break;
      }
      case 'leave':
        pos = null;
        here = null;
        break;
    }
  });
  return legs;
}

// ── 司机与配送员：按车辆的班次 ──
function crewLegs(person: Person, stints: Stint[], day: number): Leg[] {
  const legs: Leg[] = [];
  const resident = person.kind === 'resident';
  const home = resident ? homeOf(person.id) : null;
  let t = day * DAY;
  let pos: Point | null = home ? doorOf(buildingAt(home)!) : null;
  if (home)
    legs.push({
      start: t,
      end: t,
      mode: 'home',
      path: [home],
      label: '在家',
      building: buildingAt(home)!.id,
    });
  const walk = (target: Point, start: number, label: string) => {
    const path = timedWalk(walkRoute(pos!, target), start, person.pace);
    if (path.points.length > 1) legs.push(walkLeg(path, label));
    pos = target;
    return path.times.at(-1)!;
  };
  for (const stint of stints) {
    const vehicle = vehicleById.get(stint.vehicle)!;
    const driving = stint.person === person.id;
    const handover = handoversOf(day).find((h) => h.bus === vehicle.id);
    // 晚班公交司机：坐地铁到换班的站点，在站台等车
    if (vehicle.kind === 'bus' && handover && driving && stint.start > handover.arrive) {
      const platform = platformOf(handover.node);
      const station = city.stations.find((s) => nearestNode(s.location).id === handover.node)!;
      const exit = stationExits(station).reduce((best, q) =>
        distance(q, platform) < distance(best, platform) ? q : best,
      );
      pos = exit;
      const lead = walkSeconds(walkRoute(exit, platform), person.pace);
      t = walk(platform, stint.start - lead - 120, '步行至公交站');
      legs.push({ start: t, end: stint.start, mode: 'wait', path: [platform], label: '等候接班' });
    } else if (pos && home) {
      // 王磊：从家走到车旁
      const curb = curbOf(vehicle.id, stint.start + 0.5)!;
      const lead = walkSeconds(walkRoute(pos, curb), person.pace);
      legs[legs.length - 1].end = stint.start - lead;
      t = walk(curb, stint.start - lead, '步行至车旁');
      if (stint.start > t) {
        legs.push({ start: t, end: stint.start, mode: 'wait', path: [curb], label: '上车' });
      }
    }
    // 配送：停车后把货送进店里再回到车上
    const drops = deliveriesOf(day).filter(
      (d) => d.vehicle === vehicle.id && d.start >= stint.start && d.end <= stint.end,
    );
    t = stint.start;
    const mode: LegMode = driving ? 'drive' : 'ride';
    const label = driving
      ? vehicle.kind === 'bus'
        ? `驾驶${vehicle.plate}`
        : vehicle.kind === 'van'
          ? '驾驶配送车'
          : vehicle.kind === 'taxi'
            ? '开网约车'
            : '驾车路过'
      : '同车路过';
    for (const drop of drops) {
      legs.push({ start: t, end: drop.start, mode, path: [], label, vehicle: vehicle.id });
      const shop = shopById.get(drop.shop)!;
      const door = doorOf(buildingById.get(shop.buildingId)!);
      const curb = curbAt(drop.at);
      pos = curb;
      const arrive = walk(door, drop.start, `送货到${shop.name}`);
      const back = walkSeconds(walkRoute(door, curb), person.pace);
      const leave = Math.max(arrive, drop.end - back);
      legs.push({
        start: arrive,
        end: leave,
        mode: 'deliver',
        path: [shopCenter(shop)],
        label: `在${shop.name}卸货`,
        building: shop.buildingId,
        shop: shop.id,
      });
      const returned = walk(curb, leave, '回到车上');
      if (drop.end > returned) {
        legs.push({
          start: returned,
          end: drop.end,
          mode: 'wait',
          path: [curb],
          label: '回到车上',
        });
      }
      t = drop.end;
    }
    legs.push({ start: t, end: stint.end, mode, path: [], label, vehicle: vehicle.id });
    t = stint.end;
    pos = null;
    // 早班公交司机：在换班的站点下车，坐地铁离开
    if (vehicle.kind === 'bus' && handover && driving && stint.end <= handover.depart) {
      const platform = platformOf(handover.node);
      const station = city.stations.find((s) => nearestNode(s.location).id === handover.node)!;
      const exit = stationExits(station).reduce((best, q) =>
        distance(q, platform) < distance(best, platform) ? q : best,
      );
      pos = platform;
      walk(exit, t, '步行至湖滨站');
      pos = null;
    }
    if (home && stint === stints.at(-1)) {
      pos = curbOf(vehicle.id, stint.end - 0.5)!;
      t = walk(doorOf(buildingAt(home)!), t, '步行回家');
      legs.push({
        start: t,
        end: (day + 1) * DAY,
        mode: 'home',
        path: [home],
        label: '在家',
        building: buildingAt(home)!.id,
      });
    }
  }
  return legs;
}

// ── 具名人物：手写的安排 ──
/** 按当天的时刻依次排列行程：每段的起点为上一段的结束。 */
function schedule(id: string, day: number) {
  const person = personById.get(id)!;
  const legs: Leg[] = [];
  let cursor = at(day, 6);
  let pos: Point = homeOf(id);
  const add = (leg: Omit<Leg, 'start'>) => {
    legs.push({ start: cursor, ...leg });
    cursor = Math.max(cursor, leg.end);
    pos = leg.path.at(-1) ?? pos;
  };
  const trip = (tripId: string): Trip | undefined => indexOf(day).trips.get(tripId);
  const time = (h: number, m = 0) => at(day, h, m);
  const inside = (place: Point) => buildingAt(place)?.id;
  /** 走到车旁：缩短上一段停留，按时上车。 */
  const reach = (curb: Point, by: number, label: string) => {
    const from = endpoint(pos, curb);
    const lead = walkSeconds(walkRoute(from, curb), person.pace);
    const last = legs.at(-1);
    const leave = Math.max(last ? last.start : cursor, Math.min(cursor, by - lead));
    if (last && last.end > leave) last.end = leave;
    cursor = leave;
    const path = timedWalk(walkRoute(from, curb), leave, person.pace);
    legs.push(walkLeg(path, label));
    cursor = path.times.at(-1)!;
    pos = curb;
  };
  return {
    legs,
    time,
    /** 停留到某个时刻。 */
    stay: (mode: LegMode, until: number, place: Point, label: string) =>
      add({ end: Math.max(until, cursor), mode, path: [place], label, building: inside(place) }),
    /** 步行或乘地铁若干分钟。 */
    move: (mode: LegMode, minutes: number, path: Point[], label: string) =>
      add({ end: cursor + minutes * 60, mode, path, label }),
    /** 沿人行道步行若干分钟。 */
    walk: (minutes: number, to: Point, label: string) =>
      add(scriptedWalk(pos, to, cursor + minutes * 60, label)),
    /** 待到当天结束。 */
    rest: (place: Point, label = '在家') =>
      add({ end: time(24), mode: 'home', path: [place], label, building: inside(place) }),
    /** 计划中的出发（自驾）或下单（打车）时刻。 */
    departure: (tripId: string) => personaTrips(day).find((t) => t.id === tripId)!.depart,
    /** 自驾：走到车旁，按交通模拟的到达时刻下车，再步行进入目的地。 */
    drive: (tripId: string, label: string, to: Point) => {
      const t = trip(tripId);
      if (!t) return;
      reach(boardingCurb(t)!, t.pickup, '步行至车旁');
      if (t.pickup > cursor) add({ end: t.pickup, mode: 'wait', path: [pos], label: '上车' });
      add({ end: t.arrive, mode: 'drive', path: [t.from, t.to], label, vehicle: t.vehicle });
      pos = curbOf(t.vehicle, t.arrive - 0.5)!;
      add(scriptedWalk(pos, to, cursor + 120, '停车后步行'));
    },
    /** 打车：在路边等车，上车后随车行驶，下车后步行进入目的地。 */
    taxi: (tripId: string, label: string) => {
      const t = trip(tripId)!;
      const pickup = boardingCurb(t)!;
      add({ end: cursor + 90, mode: 'walk', path: walkPoints(pos, pickup), label: '步行至路边' });
      add({ end: t.pickup, mode: 'wait', path: [pickup], label: '等候网约车' });
      add({ end: t.arrive, mode: 'taxi', path: [t.from, t.to], label, vehicle: t.vehicle });
      pos = curbOf(t.vehicle, t.arrive - 0.5)!;
      add(scriptedWalk(pos, t.to, cursor + 60, '下车后步行'));
    },
    /** 公交：在站台等第一班车，到站下车。 */
    bus: (from: number, to: number, label: string) => {
      const ride = catchBus(day, from, to, cursor + 20)!;
      add({ end: ride.board.depart, mode: 'wait', path: [platformOf(from)], label: '等公交' });
      add({
        end: alightTime(ride.alight),
        mode: 'bus',
        path: [platformOf(from), platformOf(to)],
        label,
        vehicle: ride.board.bus,
        stops: [from, to],
      });
    },
    /** 在店里购物若干分钟。 */
    shop: (shop: Shop, minutes: number, amount: number, label = `在${shop.name}购物`) =>
      add({
        end: cursor + minutes * 60,
        mode: 'shop',
        path: [shopCenter(shop)],
        label,
        building: shop.buildingId,
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
    const p = schedule('P01', day);
    const home = homeOf('P01');
    const S = stationAt;
    if (day === 6) {
      p.rest(home);
      return p.legs;
    }
    if (day === 5) {
      p.stay('home', p.time(9, 30), home, '在家');
      p.walk(12, S('北站'), '步行至北站');
      p.move('metro', 26, [S('北站'), S('中心站'), S('湖滨站')], '地铁 1 号线换 2 号线');
      p.walk(8, PLACES.market, '步行至周末市集');
      p.stay('event', p.time(12), PLACES.market, '周末市集');
      p.walk(8, S('湖滨站'), '步行至湖滨站');
      p.move('metro', 26, [S('湖滨站'), S('中心站'), S('北站')], '地铁 2 号线换 1 号线');
      p.walk(12, home, '步行回家');
      p.rest(home);
      return p.legs;
    }
    const [, off] = personaShift('P01', day)!;
    p.stay('home', p.time(7, 50), home, '在家');
    p.walk(12, S('北站'), '步行至北站');
    p.move('metro', 18, [S('北站'), S('中心站')], '地铁 1 号线');
    p.walk(8, PLACES.office, '步行至中央大厦');
    p.stay('work', off, PLACES.office, day === 3 ? '在星河科技工作（加班）' : '在星河科技工作');
    if (day === 1) {
      p.walk(10, PLACES.cafe, '步行至拾光咖啡');
      p.stay('event', p.time(20, 10), PLACES.cafe, '读书会');
      p.walk(6, S('中心站'), '步行至中心站');
    } else if (day === 2) {
      const mall = shopNamed('星河商场');
      p.walk(4, platformOf(STOP_WEST), '步行至公交站');
      p.bus(STOP_WEST, STOP_MALL, '乘公交至中央大道 × 文华街');
      p.walk(3, PLACES.mall, '步行至星河商场');
      p.shop(mall, 35, 268);
      p.walk(6, S('中心站'), '步行至中心站');
    } else {
      p.walk(8, S('中心站'), '步行至中心站');
    }
    p.move('metro', 18, [S('中心站'), S('北站')], '地铁 1 号线');
    p.walk(12, home, '步行回家');
    p.rest(home);
    return p.legs;
  },
  // 周宁：住湖畔公寓，开车上下班；周二读书会，周二、周四夜跑，周六逛市集，周日开车去商场
  P02: (day) => {
    const p = schedule('P02', day);
    const home = homeOf('P02');
    if (day === 5) {
      p.stay('home', p.time(10, 40), home, '在家');
      p.walk(12, PLACES.market, '步行至周末市集');
      p.stay('event', p.time(13), PLACES.market, '周末市集');
      p.walk(12, home, '步行回家');
      p.rest(home);
      return p.legs;
    }
    if (day === 6) {
      p.stay('home', p.departure('P02-6-out'), home, '在家');
      p.drive('P02-6-out', '开车去星河商场', PLACES.mall);
      p.shop(
        shopNamed('星河商场'),
        Math.max(10, (p.departure('P02-6-back') - p.cursor) / 60 - 5),
        412,
      );
      p.drive('P02-6-back', '开车回家', home);
      p.rest(home);
      return p.legs;
    }
    p.stay('home', p.departure(`P02-${day}-am`), home, '在家');
    p.drive(`P02-${day}-am`, '开车上班', PLACES.office);
    p.stay('work', p.time(18, 35), PLACES.office, '在星河科技工作');
    if (day === 1) {
      p.walk(10, PLACES.cafe, '步行至拾光咖啡');
      p.stay('event', p.time(20, 10), PLACES.cafe, '读书会');
    }
    p.drive(`P02-${day}-pm`, '开车回家', home);
    if (day === 1 || day === 3) {
      p.stay('home', p.time(20, 50), home, '在家');
      p.walk(10, PLACES.parkGate, '步行至湖滨公园');
      p.move('run', 40, loopFrom(PLACES.parkGate), '夜跑');
      p.walk(12, home, '步行回家');
    }
    p.rest(home);
    return p.legs;
  },
  // 孙浩：步行通勤，常加班；周二、周四下班后夜跑，周四跑完去便利店；周日下雨，打车去商场，坐公交回家
  P03: (day) => {
    const p = schedule('P03', day);
    const home = homeOf('P03');
    if (day === 6) {
      p.stay('home', p.departure('P03-6-taxi') - 90, home, '在家');
      p.taxi('P03-6-taxi', '乘网约车去星河商场');
      p.shop(shopNamed('星河商场'), 70, 189);
      p.walk(3, platformOf(STOP_MALL), '步行至公交站');
      p.bus(STOP_MALL, STOP_SOUTH, '乘公交回家');
      p.walk(6, home, '步行回家');
      p.rest(home);
      return p.legs;
    }
    if (DAYS[day].weekend) {
      p.rest(home);
      return p.legs;
    }
    p.stay('home', p.time(8, 50), home, '在家');
    p.walk(20, PLACES.office, '步行上班');
    p.stay('work', p.time(20, 40), PLACES.office, '在星河科技工作（加班）');
    if (day === 1 || day === 3) {
      p.walk(20, PLACES.parkGate, '步行至湖滨公园');
      p.move('run', 40, loopFrom(PLACES.parkGate), '夜跑');
      if (day === 3) {
        const store = nearestShop(home, '便利店');
        p.walk(12, shopCenter(store), `步行至${store.name}`);
        p.shop(store, 8, 36);
        p.walk(6, home, '步行回家');
      } else {
        p.walk(15, home, '步行回家');
      }
    } else {
      p.walk(20, home, '步行回家');
    }
    p.rest(home);
    return p.legs;
  },
  // 陈雨：市立医院护士，周日上班、周六休息；周二下班时下雨，打车去读书会
  P04: (day) => {
    const p = schedule('P04', day);
    const home = homeOf('P04');
    if (day === 5) {
      p.stay('home', p.time(10, 45), home, '在家');
      p.walk(25, PLACES.market, '步行至周末市集');
      p.stay('event', p.time(12, 30), PLACES.market, '周末市集');
      p.walk(25, home, '步行回家');
      p.rest(home);
      return p.legs;
    }
    p.stay('home', p.time(7, 12), home, '在家');
    p.walk(13, PLACES.clinic, '步行上班');
    if (day === 1) {
      p.stay('work', p.departure('P04-1-taxi') - 90, PLACES.clinic, '在市立医院值班');
      p.taxi('P04-1-taxi', '乘网约车去拾光咖啡');
      p.stay('event', p.time(20, 10), PLACES.cafe, '读书会');
      p.walk(14, home, '步行回家');
    } else {
      p.stay('work', p.time(18, 5), PLACES.clinic, '在市立医院值班');
      p.walk(13, home, '步行回家');
    }
    p.rest(home);
    return p.legs;
  },
  // 赵敏：街角咖啡店主，每天开店；周三在店里主持市集筹备会，周六在市集摆摊
  P06: (day) => {
    const p = schedule('P06', day);
    const home = homeOf('P06');
    p.stay('home', day === 5 ? p.time(8, 15) : p.time(6, 40), home, '在家');
    if (day === 5) {
      p.walk(25, PLACES.market, '步行至周末市集');
      p.stay('event', p.time(16, 30), PLACES.market, '周末市集（摆摊）');
      p.walk(20, PLACES.corner, '步行回店里');
    } else {
      p.walk(15, PLACES.corner, '步行至店里');
    }
    if (day === 2) {
      p.stay('work', p.time(15), PLACES.corner, '经营街角咖啡');
      p.stay('event', p.time(16), PLACES.corner, '周末市集筹备会');
    }
    p.stay('work', p.time(21, 10), PLACES.corner, '经营街角咖啡');
    p.walk(15, home, '步行回家');
    p.rest(home);
    return p.legs;
  },
};

/** 有手写安排的具名人物（王磊的行程按网约车的班次生成）。 */
export const PERSONA_IDS = [...Object.keys(PLANS), 'P05'].sort();
export const hasItinerary = (id: string) => PERSONA_IDS.includes(id);

// ── 一天中所有人的行程 ──
interface DayPeople {
  legs: Map<string, Leg[]>;
  /** 室外行程段，按开始时刻排序，并按 5 分钟分桶，便于查找某一时刻街上的人。 */
  outdoor: { person: string; leg: Leg }[];
  buckets: number[][];
}

const BUCKET = 300;
const peopleCache = new Map<number, DayPeople>();

function buildDay(day: number): DayPeople {
  const legs = new Map<string, Leg[]>();
  for (const [id, plan] of Object.entries(PLANS)) legs.set(id, plan(day));
  for (const [id, steps] of dayPlan(day).steps) {
    legs.set(id, realize(personById.get(id)!, steps, day));
  }
  const crew = new Map<string, Stint[]>();
  for (const stint of stintsOf(day)) {
    for (const id of [stint.person, ...stint.passengers]) {
      crew.set(id, [...(crew.get(id) ?? []), stint]);
    }
  }
  for (const [id, stints] of crew) legs.set(id, crewLegs(personById.get(id)!, stints, day));
  const outdoor: DayPeople['outdoor'] = [];
  for (const [person, list] of legs) {
    for (const leg of list)
      if (isOutdoor(leg) && leg.end > leg.start) outdoor.push({ person, leg });
  }
  outdoor.sort((a, b) => a.leg.start - b.leg.start);
  const buckets: number[][] = Array.from({ length: DAY / BUCKET }, () => []);
  outdoor.forEach(({ leg }, i) => {
    const a = Math.max(0, Math.floor((leg.start - day * DAY) / BUCKET));
    const b = Math.min(buckets.length - 1, Math.floor((leg.end - day * DAY) / BUCKET));
    for (let k = a; k <= b; k++) buckets[k].push(i);
  });
  return { legs, outdoor, buckets };
}

export function dayPeople(day: number): DayPeople {
  let entry = peopleCache.get(day);
  if (!entry) {
    entry = buildDay(day);
    peopleCache.set(day, entry);
    if (peopleCache.size > 3) peopleCache.delete(peopleCache.keys().next().value!);
  }
  return entry;
}

const EMPTY: Leg[] = [];

/** 某人某一天的行程；当天不在街区的外来人员为空。 */
export function itinerary(id: string, day: number): Leg[] {
  return dayPeople(day).legs.get(id) ?? EMPTY;
}

function along(path: Point[], k: number): Point {
  if (path.length === 1) return path[0];
  const lengths = path.slice(1).map((p, i) => distance(p, path[i]));
  let remaining = lengths.reduce((a, b) => a + b, 0) * k;
  for (let i = 1; i < path.length; i++) {
    if (remaining <= lengths[i - 1] || i === path.length - 1) {
      const f = lengths[i - 1] ? Math.min(1, remaining / lengths[i - 1]) : 0;
      return {
        x: path[i - 1].x + (path[i].x - path[i - 1].x) * f,
        y: path[i - 1].y + (path[i].y - path[i - 1].y) * f,
      };
    }
    remaining -= lengths[i - 1];
  }
  return path.at(-1)!;
}

/** 行程段在 t 时的位置（不含乘车）。 */
export function legPosition(leg: Leg, t: number): Point {
  if (leg.times) {
    const times = leg.times;
    if (t <= times[0]) return leg.path[0];
    for (let i = 1; i < times.length; i++) {
      if (t < times[i]) {
        const span = times[i] - times[i - 1];
        const f = span > 0 ? (t - times[i - 1]) / span : 1;
        const a = leg.path[i - 1];
        const b = leg.path[i];
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
      }
    }
    return leg.path.at(-1)!;
  }
  if (!leg.path.length) return { x: 0, y: 0 };
  const k = leg.end > leg.start ? (t - leg.start) / (leg.end - leg.start) : 0;
  return along(leg.path, Math.min(1, Math.max(0, k)));
}

export interface PersonState {
  x: number;
  y: number;
  leg: Leg;
}

function legAt(legs: Leg[], t: number): Leg | undefined {
  let lo = 0;
  let hi = legs.length - 1;
  let found: Leg | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (legs[mid].start <= t) {
      found = legs[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found && t < found.end ? found : undefined;
}

/** 某人在 t 时的位置；乘车时取所乘车辆的位置。不在街区时为 null。 */
export function personAt(id: string, t: number): PersonState | null {
  const legs = itinerary(id, dayOf(t));
  if (!legs.length) return null;
  const resident = personById.get(id)!.kind === 'resident';
  // 居民在 06:00 之前与 24:00 之后都在家
  const current =
    legAt(legs, t) ?? (resident ? (t < legs[0].start ? legs[0] : legs.at(-1)) : undefined);
  if (!current) return null;
  if (current.vehicle && isRide(current.mode)) {
    const state = vehicleAt(vehicleById.get(current.vehicle)!, t);
    if (state) return { x: state.x, y: state.y, leg: current };
    // 车辆刚驶出或尚未驶入街区
    if (!resident) return null;
  }
  if (!current.path.length) return null;
  return { ...legPosition(current, t), leg: current };
}

/** t 时在某栋建筑里的人。 */
export function peopleInside(building: number, t: number): string[] {
  const inside: string[] = [];
  for (const [id, legs] of dayPeople(dayOf(t)).legs) {
    if (legAt(legs, t)?.building === building) inside.push(id);
  }
  return inside;
}

export interface Pedestrian {
  person: string;
  x: number;
  y: number;
  leg: Leg;
}

/** t 时街上的人：步行、候车、散步与在公园活动的人。 */
export function pedestriansAt(t: number): Pedestrian[] {
  const day = dayOf(t);
  const { outdoor, buckets } = dayPeople(day);
  const bucket =
    buckets[Math.min(buckets.length - 1, Math.max(0, Math.floor((t - day * DAY) / BUCKET)))];
  const out: Pedestrian[] = [];
  for (const i of bucket) {
    const { person, leg } = outdoor[i];
    if (t < leg.start || t >= leg.end) continue;
    out.push({ person, ...legPosition(leg, t), leg });
  }
  return out;
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
