/**
 * 每个人每天的安排：几点出门、去哪里、怎么去。安排只依赖人物、天气、路网与人行道，不依赖交通模拟；
 * 需要车辆的出行登记为请求（自驾、网约车订单），由交通模拟（traffic.ts）给出实际的上车与到达时刻，
 * 再由 mobility.ts 落实到每个人的行程上。
 * - 居民：上班、午饭、下班顺路买东西、参加社区活动，不上班的日子上午、午后、晚上各可能出门一次；
 * - 外来上班族：坐地铁、步行或开车来街区的写字楼上班；
 * - 访客：去商店、医院、图书馆、博物馆与公园，从地铁站或街区边缘进出，商场的访客有的开车来。
 * 商店的到访次数按客流强度模型（commerce.ts）每 5 分钟抽样一次：居民与上班族先去，其余由访客补足。
 * 具名人物的安排是手写的（mobility.ts），这里只登记他们用车的请求。
 */
import { city, type Building } from '../geo/city';
import { pointInPolygon, rectCenter, seededRandom, type Point } from '../geo/spatial';
import { footfallRate, shops, type Shop, type ShopCategory } from './commerce';
import {
  PLACES,
  carOwners,
  companyById,
  events,
  people,
  personById,
  personaTrips,
  shiftsOf,
  staff,
  type CommunityEvent,
  type Person,
  type WorkShift,
} from './people';
import {
  BUS_LOOP,
  edgeBetween,
  gates,
  loopHops,
  nearestNode,
  nodeById,
  nodePoint,
  previousStop,
  shortestPath,
} from './roads';
import { DAY, DAYS, at, dayOf, hours } from './time';
import { vehicleByDriver, vehicleByOwner } from './vehicles';
import {
  curbAt,
  doorOf,
  platformAt,
  stationExits,
  walkGates,
  walkRoute,
  walkSeconds,
} from './walk';
import { rainAt, windAt } from './weather';

// ── 地点与步骤 ──
/** 地点：建筑（经由出入口进出）、地铁站、街区边缘的步行出入口，或公园中的一点。 */
export type Spot =
  | { kind: 'building'; id: number }
  | { kind: 'station'; id: number }
  | { kind: 'gate'; id: number }
  | { kind: 'point'; at: Point };

export type StayMode = 'home' | 'work' | 'shop' | 'visit' | 'event';

export type Step =
  /** 外来人员出现：走出地铁站，或从街区边缘走进来。 */
  | { type: 'appear'; at: Spot; t: number; via: 'metro' | 'walk' }
  /** 居民：当天 06:00 起在家。 */
  | { type: 'begin'; at: Spot }
  /** 在当前地点停留到 until（迟到时至少停留 minimum 秒）。 */
  | {
      type: 'stay';
      mode: StayMode;
      until: number;
      minimum?: number;
      label: string;
      shop?: number;
      amount?: number;
    }
  | { type: 'walk'; to: Spot; label: string }
  /** 沿湖散步或跑步。 */
  | { type: 'stroll'; until: number; run: boolean; label: string }
  /** 走到站台等车，乘公交到另一站下车。 */
  | { type: 'bus'; from: number; to: number; label: string }
  /** 走到车旁，驾车（drive）或作为同乘者（ride）出行。 */
  | { type: 'drive' | 'ride'; trip: string; label: string }
  /** 走到路边等网约车，上车后到达目的地。 */
  | { type: 'taxi'; trip: string; label: string }
  /** 离开街区：进地铁站、走出街区，或随车驶出。 */
  | { type: 'leave'; via: 'metro' | 'walk' | 'car'; label: string };

/** 自驾：车辆从路口（或出入口）开到另一个路口（或出入口）。 */
export interface DriveRequest {
  id: string;
  vehicle: string;
  person: string;
  /** 同车的其他人。 */
  riders: string[];
  depart: number;
  from: number;
  to: number;
  /** 出发地与目的地（用车记录中的地点）。 */
  origin: Point;
  destination: Point;
}

/** 网约车订单：在 from 附近上车；目的地在街区外时经出入口 exit 驶出。 */
export interface OrderRequest {
  id: string;
  person: string;
  request: number;
  from: Point;
  to: Point;
  exit?: number;
  /** 指定车辆（具名人物的订单由王磊接）。 */
  taxi?: string;
}

export interface DayPlan {
  steps: Map<string, Step[]>;
  drives: DriveRequest[];
  orders: OrderRequest[];
}

const buildingById = new Map(city.buildings.map((b) => [b.id, b]));
const stationById = new Map(city.stations.map((s) => [s.id, s]));
const centers = new Map(city.buildings.map((b) => [b.id, rectCenter(b.footprint)]));
const hospitalId = city.buildings.find((b) => b.kind === '医院')!.id;
const byKind = (kind: Building['kind']) => city.buildings.filter((b) => b.kind === kind);
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const building = (id: number): Spot => ({ kind: 'building', id });

/** 地点的大致位置（选出入口之前）。 */
export function roughPoint(spot: Spot): Point {
  switch (spot.kind) {
    case 'building':
      return centers.get(spot.id)!;
    case 'station':
      return stationById.get(spot.id)!.location;
    case 'gate':
      return walkGates[spot.id - 1].at;
    case 'point':
      return spot.at;
  }
}

/** 地点的步行端点；地铁站取离 toward 最近的出入口。 */
export function spotPoint(spot: Spot, toward: Point): Point {
  switch (spot.kind) {
    case 'building':
      return doorOf(buildingById.get(spot.id)!);
    case 'station':
      return stationExits(stationById.get(spot.id)!).reduce((best, p) =>
        distance(p, toward) < distance(best, toward) ? p : best,
      );
    case 'gate':
      return walkGates[spot.id - 1].at;
    case 'point':
      return spot.at;
  }
}

const platforms = new Map(
  BUS_LOOP.map((stop) => [
    stop,
    platformAt(nodePoint(nodeById.get(stop)!), nodePoint(nodeById.get(previousStop(stop))!)),
  ]),
);

/** 公交站台：环线单向运行，每站只有一个站台。 */
export const platformOf = (stop: number) => platforms.get(stop)!;

/** 车停放处（建筑最近的路口）。 */
export const garageOf = (spot: Spot) => nearestNode(roughPoint(spot)).id;

/** 行车时间的粗略估计（秒），偏保守。 */
function driveSeconds(path: number[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += edgeBetween(path[i - 1], path[i]).length / 6 + 18;
  return total;
}

/**
 * 从 p 走到停在路口 node 附近的车旁所需时间的上限（秒）。车停在哪一侧要等交通模拟算出，
 * 这里多留出一个信号周期与几十米的余量。
 */
const carLead = (p: Point, node: number, person: Person) =>
  walkSeconds(walkRoute(p, curbAt(nodePoint(nodeById.get(node)!))), person.pace) + 160;

const routeNodes = (from: number, to: number) => {
  const gateFrom = gates.find((g) => g.id === from);
  const gateTo = gates.find((g) => g.id === to);
  const path = shortestPath(gateFrom?.junction ?? from, gateTo?.junction ?? to);
  return [...(gateFrom ? [from] : []), ...path, ...(gateTo ? [to] : [])];
};

// ── 商店 ──
const DWELL: Record<ShopCategory, [number, number]> = {
  咖啡: [15, 55],
  商场: [25, 110],
  茶室: [35, 90],
  便利店: [3, 9],
  花店: [5, 14],
  面包店: [3, 10],
};
const SPEND: Record<ShopCategory, [number, number]> = {
  咖啡: [18, 68],
  商场: [60, 600],
  茶室: [40, 160],
  便利店: [8, 60],
  花店: [30, 180],
  面包店: [12, 60],
};

const isOpen = (shop: Shop, t: number, margin = 0) => {
  const s = t - dayOf(t) * DAY;
  return s >= shop.open[0] && s + margin < shop.open[1];
};

const SLOT = 300;

function poisson(mean: number, random: () => number): number {
  if (mean <= 0) return 0;
  const limit = Math.exp(-mean);
  let k = 0;
  let p = random();
  while (p > limit) {
    k++;
    p *= random();
  }
  return k;
}

/** 每家店每 5 分钟的到访人次：按客流强度抽样。 */
function sampleDemand(day: number): Map<number, number[]> {
  const demand = new Map<number, number[]>();
  for (const shop of shops) {
    const random = seededRandom(shop.id * 7919 + day * 104729);
    demand.set(
      shop.id,
      Array.from({ length: DAY / SLOT }, (_, i) =>
        poisson(footfallRate(shop, day * DAY + i * SLOT + SLOT / 2) / (3600 / SLOT), random),
      ),
    );
  }
  return demand;
}

// ── 安排 ──
interface Ctx {
  day: number;
  random: () => number;
  plan: DayPlan;
  demand: Map<number, number[]>;
  serial: number;
}

const between = (ctx: Ctx, a: number, b: number) => a + ctx.random() * (b - a);
const pick = <T>(ctx: Ctx, list: T[]) => list[Math.floor(ctx.random() * list.length)];

/** 认领一次到访：从抽样的到访人次中扣除，相邻时段也可以。 */
function claim(ctx: Ctx, shop: number, t: number) {
  const slots = ctx.demand.get(shop)!;
  const i = Math.floor((t - ctx.day * DAY) / SLOT);
  for (const j of [i, i - 1, i + 1, i - 2, i + 2]) {
    if (slots[j] > 0) {
      slots[j]--;
      return;
    }
  }
}

function purchase(ctx: Ctx, person: Person, shop: Shop): number | undefined {
  if (!person.member || ctx.random() > 0.75) return undefined;
  const [a, b] = SPEND[shop.category];
  return Math.round(between(ctx, a, b));
}

/** 离 near 较近、在 t 时营业的某类商店，随机取前几家之一。 */
function pickShop(
  ctx: Ctx,
  near: Point,
  t: number,
  categories: ShopCategory[],
  spread = 3,
): Shop | undefined {
  const options = shops
    .filter((shop) => categories.includes(shop.category) && isOpen(shop, t, 900))
    .sort(
      (a, b) =>
        distance(doorOf(buildingById.get(a.buildingId)!), near) -
        distance(doorOf(buildingById.get(b.buildingId)!), near),
    )
    .slice(0, spread);
  return options.length ? pick(ctx, options) : undefined;
}

// ── 出行方式 ──
interface Choice {
  mode: 'walk' | 'bus' | 'taxi' | 'car';
  seconds: number;
  /** 步行到车旁或路边的时间上限。 */
  lead: number;
  stops?: [number, number];
  car?: { vehicle: string; from: number; to: number; riders: string[] };
  exit?: number;
}

interface Options {
  bus?: boolean;
  /** 下雨时改乘网约车的概率。 */
  taxi?: number;
  car?: { vehicle: string; from: number; to: number; riders?: string[] };
  /** 乘网约车离开街区，经此出入口驶出。 */
  exit?: number;
}

function choose(ctx: Ctx, person: Person, from: Spot, to: Spot, t: number, options: Options) {
  const pa = spotPoint(from, roughPoint(to));
  const pb = spotPoint(to, pa);
  if (options.car) {
    const { vehicle, from: a, to: b } = options.car;
    const lead = carLead(pa, a, person);
    const tail = walkSeconds(walkRoute(curbAt(nodePoint(nodeById.get(b)!)), pb), person.pace) + 60;
    return {
      mode: 'car',
      seconds: lead + 30 + driveSeconds(routeNodes(a, b)) + tail,
      lead,
      car: { vehicle, from: a, to: b, riders: options.car.riders ?? [] },
    } satisfies Choice;
  }
  const walk = walkSeconds(walkRoute(pa, pb), person.pace);
  const rain = rainAt(t);
  if (options.exit !== undefined) {
    const pickup = curbAt(nodePoint(nearestNode(pa)));
    const lead = walkSeconds(walkRoute(pa, pickup), person.pace);
    return { mode: 'taxi', seconds: lead + 900, lead, exit: options.exit } satisfies Choice;
  }
  // 路远时偶尔打车，夜间与大风天更多，下雨时明显增多
  const s = t - ctx.day * DAY;
  const taxi =
    options.taxi === undefined
      ? 0
      : 0.02 +
        (s > hours(21) ? 0.06 : 0) +
        0.15 * Math.min(1, Math.max(0, (windAt(t) - 6) / 5)) +
        (rain > 0.3 ? options.taxi : 0);
  if (taxi && walk > 420 && ctx.random() < taxi) {
    const pickup = curbAt(nodePoint(nearestNode(pa)));
    const lead = walkSeconds(walkRoute(pa, pickup), person.pace);
    const tail = walkSeconds(walkRoute(curbAt(nodePoint(nearestNode(pb))), pb), person.pace);
    const ride = driveSeconds(shortestPath(nearestNode(pa).id, nearestNode(pb).id));
    return { mode: 'taxi', seconds: lead + 420 + ride + tail, lead } satisfies Choice;
  }
  if (options.bus !== false && walk > 300) {
    const near = nearStops;
    let best: Choice | null = null;
    for (const a of near(pa)) {
      for (const b of near(pb)) {
        if (a === b) continue;
        const seconds =
          walkSeconds(walkRoute(pa, platformOf(a)), person.pace) +
          150 +
          loopHops(a, b) * 45 +
          walkSeconds(walkRoute(platformOf(b), pb), person.pace);
        if (!best || seconds < best.seconds) {
          best = { mode: 'bus', seconds, lead: 0, stops: [a, b] };
        }
      }
    }
    // 居民熟悉线路，路远时更愿意坐车；走得慢的人与去医院的人也更愿意坐车
    const resident = person.kind === 'resident' && walk > 480;
    const slow = person.pace < 1.22 || (to.kind === 'building' && to.id === hospitalId);
    const willing = rain > 0.3 || slow ? 0.9 : resident ? 0.8 : 0.65;
    const tolerance = rain > 0.3 || slow ? 1.3 : resident ? 1.15 : 0.85;
    if (best && best.seconds < walk * tolerance && ctx.random() < willing) {
      return best;
    }
  }
  return { mode: 'walk', seconds: walk, lead: 0 } satisfies Choice;
}

/** 登记一次自驾，返回行程编号。 */
function request(
  ctx: Ctx,
  vehicle: string,
  person: string,
  riders: string[],
  depart: number,
  from: number,
  to: number,
  places: { origin: Point; destination: Point },
): string {
  const id = `D${ctx.day}${String(++ctx.serial).padStart(5, '0')}`;
  ctx.plan.drives.push({ id, vehicle, person, riders, depart, from, to, ...places });
  return id;
}

const stopCache = new WeakMap<Point, number[]>();

/** 离 p 最近的两个公交站。 */
function nearStops(p: Point): number[] {
  let stops = stopCache.get(p);
  if (!stops) {
    stops = BUS_LOOP.map((stop) => ({ stop, d: distance(platformOf(stop), p) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 2)
      .map((option) => option.stop);
    stopCache.set(p, stops);
  }
  return stops;
}

/** 按选定的方式出发：登记用车请求，返回步骤。 */
function commit(
  ctx: Ctx,
  person: Person,
  from: Spot,
  to: Spot,
  depart: number,
  choice: Choice,
  label: string,
): Step[] {
  const pa = spotPoint(from, roughPoint(to));
  const pb = spotPoint(to, pa);
  switch (choice.mode) {
    case 'walk':
      return [{ type: 'walk', to, label }];
    case 'bus': {
      const [a, b] = choice.stops!;
      return [
        { type: 'bus', from: a, to: b, label: `乘公交至${nodeById.get(b)!.name}` },
        { type: 'walk', to, label },
      ];
    }
    case 'taxi': {
      const id = `T${ctx.day}${String(++ctx.serial).padStart(5, '0')}`;
      const gate = choice.exit === undefined ? undefined : gates.find((g) => g.id === choice.exit)!;
      ctx.plan.orders.push({
        id,
        person: person.id,
        request: depart + choice.lead,
        from: pa,
        to: gate ? nodePoint(gate.node) : pb,
        exit: choice.exit,
      });
      if (gate) return [{ type: 'taxi', trip: id, label: '乘网约车离开' }];
      return [
        { type: 'taxi', trip: id, label: '乘网约车' },
        { type: 'walk', to, label: '下车后步行' },
      ];
    }
    case 'car': {
      const car = choice.car!;
      const id = request(ctx, car.vehicle, person.id, [], depart + choice.lead, car.from, car.to, {
        origin: roughPoint(from),
        destination: roughPoint(to),
      });
      return [
        { type: 'drive', trip: id, label },
        { type: 'walk', to, label: '停车后步行' },
      ];
    }
  }
}

/** 一个人一天的步骤：按时间顺序停留与出行。 */
function builder(ctx: Ctx, person: Person, start: Spot, t: number) {
  const steps: Step[] = [];
  let here = start;
  let now = t;
  let last: Extract<Step, { type: 'stay' }> | null = null;
  return {
    steps,
    get now() {
      return now;
    },
    get here() {
      return here;
    },
    stay(mode: StayMode, until: number, label: string, extra: Partial<Step> = {}) {
      if (last && last.mode === mode && last.label === label) {
        last.until = Math.max(last.until, until);
      } else {
        last = { type: 'stay', mode, until: Math.max(until, now), label, ...extra } as typeof last;
        steps.push(last!);
      }
      now = Math.max(now, until);
    },
    /** 去 to，尽量在 arriveBy 之前到；arriveBy 为 null 时立即出发。返回预计到达时刻。 */
    go(to: Spot, arriveBy: number | null, options: Options, label: string) {
      const guess = arriveBy === null ? now : Math.max(now, arriveBy - 600);
      const choice = choose(ctx, person, here, to, guess, options);
      const depart = arriveBy === null ? now : Math.max(now, arriveBy - choice.seconds);
      // 出发前在原地多待一会儿
      if (last && depart > now) last.until = depart;
      now = depart;
      return this.goWith(to, choice, label);
    },
    /** 按已选定的方式立即出发。 */
    goWith(to: Spot, choice: Choice, label: string) {
      steps.push(...commit(ctx, person, here, to, now, choice, label));
      last = null;
      here = to;
      now += choice.seconds;
      return now;
    },
    push(step: Step) {
      steps.push(step);
      last = null;
    },
    /** 沿湖散步或跑步到 until。 */
    stroll(until: number, run: boolean, label: string) {
      steps.push({ type: 'stroll', until, run, label });
      last = null;
      now = Math.max(now, until);
    },
  };
}

// ── 居民 ──
interface Activity {
  spot: Spot;
  start: number;
  end: number;
  mode: StayMode;
  label: string;
  shop?: Shop;
  run?: boolean;
  /** 上班开车往返。 */
  car?: boolean;
}

function eventSpot(event: CommunityEvent): Spot {
  if (event.venue.kind === 'building') return building(event.venue.id);
  return { kind: 'point', at: event.title === '夜跑' ? PLACES.parkGate : PLACES.market };
}

const park = city.parks[0];
const parkSpot = (ctx: Ctx): Spot => {
  for (;;) {
    const p = {
      x: park.lake.center.x + between(ctx, -130, 90),
      y: park.lake.center.y + between(ctx, -150, 120),
    };
    const lake =
      ((p.x - park.lake.center.x) / (park.lake.rx + 12)) ** 2 +
      ((p.y - park.lake.center.y) / (park.lake.ry + 12)) ** 2;
    const clear = !city.buildings.some(
      ({ footprint: f }) =>
        p.x > f.x - 4 && p.x < f.x + f.w + 4 && p.y > f.y - 4 && p.y < f.y + f.h + 4,
    );
    if (lake > 1 && clear && pointInPolygon(p, park.area)) return { kind: 'point', at: p };
  }
};

/** 不上班时的一次外出：按时段选去处。 */
function outing(ctx: Ctx, home: Point, t: number, weekend: boolean): Activity | null {
  const s = t - ctx.day * DAY;
  const roll = ctx.random();
  if (s < hours(12)) {
    if (roll < 0.55) {
      const shop = pickShop(ctx, home, t, ['面包店', '便利店', '花店', '咖啡']);
      if (shop) return shopActivity(ctx, shop, t);
    }
    return stroll(ctx, t, between(ctx, 1500, 3000));
  }
  if (s < hours(18)) {
    if (roll < (weekend ? 0.5 : 0.35)) {
      const mall = shops.find((shop) => shop.category === '商场')!;
      if (isOpen(mall, t, 1800)) return shopActivity(ctx, mall, t);
    }
    if (roll < 0.8) {
      const shop = pickShop(ctx, home, t, ['咖啡', '茶室', '花店'], 4);
      if (shop) return shopActivity(ctx, shop, t);
    }
    const place = pick(ctx, [...byKind('图书馆'), ...byKind('博物馆')]);
    return {
      spot: building(place.id),
      start: t,
      end: t + between(ctx, 2400, 5400),
      mode: 'visit',
      label: `在${place.name}`,
    };
  }
  if (roll < 0.6) {
    const shop = pickShop(ctx, home, t, ['便利店', '面包店', '咖啡']);
    if (shop) return shopActivity(ctx, shop, t);
  }
  return stroll(ctx, t, between(ctx, 1200, 2400));
}

const stroll = (ctx: Ctx, t: number, seconds: number): Activity => ({
  spot: parkSpot(ctx),
  start: t,
  end: t + seconds,
  mode: 'visit',
  label: '在湖滨公园散步',
  run: false,
});

function shopActivity(ctx: Ctx, shop: Shop, t: number): Activity {
  const [a, b] = DWELL[shop.category];
  return {
    spot: building(shop.buildingId),
    start: t,
    end: t + between(ctx, a, b) * 60,
    mode: 'shop',
    label: `在${shop.name}`,
    shop,
  };
}

function residentDay(ctx: Ctx, person: Person, shift: WorkShift | undefined): Step[] {
  const day = ctx.day;
  const home = building(person.homeId!);
  const homePoint = roughPoint(home);
  const weekend = DAYS[day].weekend;
  const owner = carOwners.some((c) => c.person === person.id);
  const acts: Activity[] = [];
  const mine = events.filter((e) => dayOf(e.start) === day && e.attendees.includes(person.id));
  if (shift) {
    const company = companyById.get(shift.companyId)!;
    const work: Activity = {
      spot: building(company.buildingId),
      start: shift.start,
      end: shift.end,
      mode: 'work',
      label: `在${company.name}工作`,
      car: owner,
    };
    // 社区活动与班次冲突时提前下班或晚到
    for (const event of mine) {
      if (event.start < work.end && event.end > work.start) {
        if (event.start - work.start > hours(2)) work.end = event.start - 1500;
        else work.start = event.end + 1500;
      }
    }
    const lunch =
      (shift.companyId === 1 || shift.companyId === 2) &&
      work.start < at(day, 11, 30) &&
      work.end > at(day, 14) &&
      ctx.random() < 0.3;
    if (lunch) {
      const t = at(day, 12) + between(ctx, 0, 2400);
      const shop = pickShop(ctx, roughPoint(work.spot), t, ['咖啡', '面包店', '便利店']);
      if (shop) {
        const meal = shopActivity(ctx, shop, t + 300);
        meal.end = Math.min(meal.end, meal.start + 2400);
        acts.push({ ...work, end: t, car: owner }, meal, {
          ...work,
          start: meal.end + 300,
          car: false,
        });
      } else acts.push(work);
    } else acts.push(work);
    // 下班顺路买东西
    if (!owner && work.end < at(day, 21) && !mine.length && ctx.random() < 0.2) {
      const shop = pickShop(ctx, homePoint, work.end + 600, ['便利店', '面包店', '花店']);
      if (shop) acts.push(shopActivity(ctx, shop, work.end + 600));
    }
  }
  for (const event of mine) {
    acts.push({
      spot: eventSpot(event),
      start: event.start,
      end: event.end,
      mode: 'event',
      label: event.title,
      run: event.title === '夜跑' ? true : undefined,
    });
  }
  if (!shift) {
    const rain = (t: number) => 1 - 0.6 * rainAt(t);
    const slots: [number, number, number][] = [
      [hours(8), hours(10, 30), weekend ? 0.5 : 0.45],
      [hours(13, 30), hours(16, 30), weekend ? 0.6 : 0.4],
      [hours(19), hours(20, 30), 0.3],
    ];
    for (const [a, b, p] of slots) {
      const t = day * DAY + between(ctx, a, b);
      if (ctx.random() > p * rain(t)) continue;
      const act = outing(ctx, homePoint, t, weekend);
      if (!act) continue;
      const busy = acts.some((x) => act.start < x.end + 1800 && act.end + 1800 > x.start);
      if (!busy) acts.push(act);
    }
  }
  acts.sort((a, b) => a.start - b.start);

  const p = builder(ctx, person, home, at(day, 6));
  p.push({ type: 'begin', at: home });
  p.stay('home', at(day, 6), '在家');
  let carAt: 'home' | 'work' = 'home';
  for (const [i, act] of acts.entries()) {
    const previous = acts[i - 1];
    // 当天不再回公司：先把车开回家
    const done = !acts.slice(i).some((a) => a.mode === 'work');
    if (carAt === 'work' && done) {
      p.go(home, null, { car: carRoute(person, previous.spot, home) }, '开车回家');
      p.stay('home', p.now + 300, '在家');
      carAt = 'home';
    } else if (previous && act.start - previous.end > hours(1, 15) && p.here !== home) {
      p.go(home, null, { taxi: 0.2 }, '回家');
      p.stay('home', p.now, '在家');
    }
    const byCar = act.mode === 'work' && act.car && carAt === 'home';
    const arrive = p.go(
      act.spot,
      act.start,
      byCar ? { car: carRoute(person, p.here, act.spot) } : { taxi: 0.25 },
      act.mode === 'work' ? '去上班' : `去${act.label.replace(/^在/, '')}`,
    );
    if (byCar) carAt = 'work';
    if (act.shop) {
      claim(ctx, act.shop.id, arrive);
      p.stay('shop', act.end, act.label, {
        minimum: 120,
        shop: act.shop.id,
        amount: purchase(ctx, person, act.shop),
      });
    } else if (act.run !== undefined && act.spot.kind === 'point') {
      p.stroll(act.end, act.run, act.label);
    } else {
      p.stay(act.mode, act.end, act.label);
    }
  }
  if (p.now < at(day, 23, 50)) {
    if (carAt === 'work') {
      const previous = acts.at(-1)!;
      p.go(home, null, { car: carRoute(person, previous.spot, home) }, '开车回家');
    } else if (p.here !== home) {
      p.go(home, null, { taxi: 0.25 }, '回家');
    }
    p.stay('home', at(day, 24), '在家');
  }
  return p.steps;
}

/** 员工开车：家附近的路口与公司车库之间。 */
function carRoute(person: Person, from: Spot, to: Spot) {
  return {
    vehicle: vehicleByOwner.get(person.id)!.id,
    from: garageOf(from),
    to: garageOf(to),
  };
}

// ── 外来人员 ──
interface Origin {
  spot: Spot;
  via: 'metro' | 'walk';
}

const originCache = new WeakMap<Point, { origin: Origin; weight: number }[]>();

/** 外来人员从哪里进出街区：离目的地近的地铁站更常用。 */
function pickOrigin(ctx: Ctx, target: Point): Origin {
  let options = originCache.get(target);
  if (!options) {
    options = originsNear(target);
    originCache.set(target, options);
  }
  let roll = ctx.random() * options.at(-1)!.weight;
  for (const option of options) if (roll <= option.weight) return option.origin;
  return options[0].origin;
}

/** 各进出地点及累计权重。 */
function originsNear(target: Point): { origin: Origin; weight: number }[] {
  const options: { origin: Origin; weight: number }[] = [
    ...city.stations.map((station) => ({
      origin: { spot: { kind: 'station', id: station.id } as Spot, via: 'metro' as const },
      weight: 3 * Math.exp(-distance(station.location, target) / 300),
    })),
    ...walkGates.map((gate) => ({
      origin: { spot: { kind: 'gate', id: gate.id } as Spot, via: 'walk' as const },
      weight: 0.22 * Math.exp(-distance(gate.at, target) / 300),
    })),
  ];
  let total = 0;
  return options.map((option) => ({ origin: option.origin, weight: (total += option.weight) }));
}

/** 车辆出入口：随机取一个。 */
const pickGate = (ctx: Ctx) => pick(ctx, gates).id;

/**
 * 外来人员的一次来访：从地铁站或街区边缘进入，在 arriveBy 前后到达 target，
 * 由 stay 写入在那里的安排，再离开。
 */
function visit(
  ctx: Ctx,
  person: Person,
  target: Spot,
  arriveBy: number,
  stay: (p: ReturnType<typeof builder>) => void,
  taxiOut = 0,
): void {
  const targetPoint = roughPoint(target);
  const origin = pickOrigin(ctx, targetPoint);
  const there = choose(ctx, person, origin.spot, target, arriveBy, {});
  const appear = arriveBy - there.seconds;
  const p = builder(ctx, person, origin.spot, appear);
  p.push({ type: 'appear', at: origin.spot, t: appear, via: origin.via });
  p.goWith(target, there, `去${buildingName(target)}`);
  stay(p);
  if (taxiOut && ctx.random() < (rainAt(p.now) > 0.3 ? taxiOut : taxiOut / 10)) {
    p.go(target, null, { exit: pickGate(ctx) }, '乘网约车离开');
    p.push({ type: 'leave', via: 'car', label: '驶出街区' });
  } else {
    // 多数从原路返回
    const exit = ctx.random() < 0.8 ? origin : pickOrigin(ctx, targetPoint);
    p.go(exit.spot, null, {}, exit.via === 'metro' ? '步行至地铁站' : '步行离开');
    p.push({ type: 'leave', via: exit.via, label: exit.via === 'metro' ? '进站' : '走出街区' });
  }
  ctx.plan.steps.set(person.id, p.steps);
}

/**
 * 开车来访：从出入口 gate 驶入，车停在目的地附近的路口，同车的人一起下车、一起离开。
 */
function carVisit(
  ctx: Ctx,
  driver: Person,
  riders: Person[],
  target: Spot,
  arriveBy: number,
  gate: number,
  stay: (p: ReturnType<typeof builder>, person: Person) => void,
): void {
  const vehicle = vehicleByDriver.get(driver.id)!.id;
  const garage = garageOf(target);
  const door = spotPoint(target, roughPoint(target));
  const curb = curbAt(nodePoint(nodeById.get(garage)!));
  const slowest = Math.min(driver.pace, ...riders.map((r) => r.pace));
  const tail = walkSeconds(walkRoute(curb, door), slowest) + 60;
  const depart = arriveBy - tail - driveSeconds(routeNodes(gate, garage));
  const ids = riders.map((r) => r.id);
  const places = { origin: nodePoint(nodeById.get(gate)!), destination: roughPoint(target) };
  const inbound = request(ctx, vehicle, driver.id, ids, depart, gate, garage, places);
  const p = builder(ctx, driver, target, arriveBy);
  stay(p, driver);
  const leave = p.now + carLead(door, garage, { ...driver, pace: slowest }) + 30;
  const outbound = request(ctx, vehicle, driver.id, ids, leave, garage, gate, {
    origin: places.destination,
    destination: places.origin,
  });
  for (const person of [driver, ...riders]) {
    const type = person === driver ? 'drive' : 'ride';
    const q = builder(ctx, person, target, arriveBy);
    if (person === driver) q.steps.push(...p.steps);
    else stay(q, person);
    ctx.plan.steps.set(person.id, [
      { type, trip: inbound, label: `开车去${buildingName(target)}` },
      { type: 'walk', to: target, label: '停车后步行' },
      ...q.steps,
      { type, trip: outbound, label: '开车离开' },
      { type: 'leave', via: 'car', label: '驶出街区' },
    ]);
  }
}

const buildingName = (spot: Spot) =>
  spot.kind === 'building' ? buildingById.get(spot.id)!.name : '湖滨公园';

function shopStay(ctx: Ctx, shop: Shop, dwell: number) {
  return (p: ReturnType<typeof builder>, person: Person) => {
    p.stay('shop', p.now + dwell, `在${shop.name}`, {
      minimum: 120,
      shop: shop.id,
      amount: purchase(ctx, person, shop),
    });
  };
}

function officeDay(ctx: Ctx, person: Person): void {
  const day = ctx.day;
  const presence = DAYS[day].weekend ? (day === 5 ? 0.08 : 0.03) : 0.93;
  if (ctx.random() > presence) return;
  const office: Spot = building(person.workplace!);
  const officePoint = roughPoint(office);
  const start = at(day, 8, 50) + (DAYS[day].weekend ? 1800 : 0) + between(ctx, -1, 1) * 1800;
  const end = start + between(ctx, hours(8, 20), hours(10));
  const label = `在${buildingById.get(person.workplace!)!.name}上班`;
  const work = (p: ReturnType<typeof builder>) => {
    const lunch = ctx.random() < 0.3 && p.now < at(day, 11, 30);
    if (lunch) {
      const t = at(day, 11, 50) + between(ctx, 0, 2700);
      const shop = pickShop(ctx, officePoint, t, ['咖啡', '面包店', '便利店']);
      if (shop) {
        p.stay('work', t, label);
        const reach = p.go(building(shop.buildingId), null, { bus: false }, `去${shop.name}`);
        claim(ctx, shop.id, reach);
        const [a, b] = DWELL[shop.category];
        p.stay('shop', reach + Math.min(between(ctx, a, b), 40) * 60, `在${shop.name}`, {
          minimum: 120,
          shop: shop.id,
          amount: purchase(ctx, person, shop),
        });
        p.go(office, null, { bus: false }, '回办公室');
      }
    }
    p.stay('work', Math.max(end, p.now + 1800), label);
    if (!person.drives && ctx.random() < 0.12) {
      const shop = pickShop(ctx, officePoint, p.now + 300, ['咖啡', '便利店', '面包店', '商场']);
      if (shop) {
        const reach = p.go(building(shop.buildingId), null, {}, `去${shop.name}`);
        claim(ctx, shop.id, reach);
        const [a, b] = DWELL[shop.category];
        p.stay('shop', reach + between(ctx, a, b) * 60, `在${shop.name}`, {
          minimum: 120,
          shop: shop.id,
          amount: purchase(ctx, person, shop),
        });
      }
    }
  };
  if (person.drives) carVisit(ctx, person, [], office, start, pickGate(ctx), work);
  else visit(ctx, person, office, start, work);
}

// ── 公园与公共设施的访客 ──
interface Facility {
  building?: Building;
  /** 每小时来访人数：[开始, 结束, 工作日, 周末]。 */
  hours: [number, number, number, number];
  dwell: [number, number];
  label: string;
}

const FACILITIES: Facility[] = [
  {
    building: byKind('医院')[0],
    hours: [8, 17, 28, 12],
    dwell: [40, 150],
    label: '在市立医院看病',
  },
  { building: byKind('图书馆')[0], hours: [9, 20, 10, 18], dwell: [40, 150], label: '在市图书馆' },
  {
    building: byKind('博物馆')[0],
    hours: [9, 17, 8, 25],
    dwell: [50, 120],
    label: '在城市博物馆参观',
  },
  { building: byKind('游客中心')[0], hours: [9, 18, 5, 14], dwell: [10, 25], label: '在游客中心' },
  { hours: [7, 20, 6, 20], dwell: [25, 60], label: '在湖滨公园散步' },
];

// ── 一天的安排 ──
function buildPlan(day: number): DayPlan {
  const ctx: Ctx = {
    day,
    random: seededRandom(4000 + day * 977),
    plan: { steps: new Map(), drives: [], orders: [] },
    demand: sampleDemand(day),
    serial: 0,
  };
  const weekend = DAYS[day].weekend;

  // 具名人物用车（行程由 mobility.ts 手写）
  const taxi = vehicleByDriver.get('P05')!.id;
  for (const trip of personaTrips(day)) {
    if (trip.mode === 'drive') {
      ctx.plan.drives.push({
        id: trip.id,
        vehicle: vehicleByOwner.get(trip.person)!.id,
        person: trip.person,
        riders: [],
        depart: trip.depart,
        from: nearestNode(trip.from).id,
        to: nearestNode(trip.to).id,
        origin: trip.from,
        destination: trip.to,
      });
    } else {
      ctx.plan.orders.push({
        id: trip.id,
        person: trip.person,
        request: trip.depart,
        from: trip.from,
        to: trip.to,
        taxi,
      });
    }
  }

  // 居民与外来上班族
  const shifts = new Map(shiftsOf(day).map((s) => [s.personId, s]));
  for (const person of people) {
    if (person.persona) continue;
    ctx.plan.steps.set(person.id, residentDay(ctx, person, shifts.get(person.id)));
  }
  for (const id of staff.office) officeDay(ctx, personOf(id));

  // 访客：每天从外来人员中随机抽取，每人当天来一次
  const order = seededRandom(9000 + day * 31);
  const shuffle = <T>(list: T[]) => {
    const copy = list.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(order() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };
  const visitors = shuffle(staff.visitors.map(personOf));
  const drivers = visitors.filter((v) => v.drives);
  const walkers = visitors.filter((v) => !v.drives);
  let next = 0;
  const nextVisitor = () => walkers[next++ % walkers.length];

  for (const shop of shops) {
    const slots = ctx.demand.get(shop.id)!;
    for (let i = 0; i < slots.length; i++) {
      while (slots[i] > 0) {
        const te = day * DAY + i * SLOT + ctx.random() * SLOT;
        const [a, b] = DWELL[shop.category];
        const dwell = Math.min(between(ctx, a, b) * 60, shop.open[1] + day * DAY - te + 300);
        const target = building(shop.buildingId);
        if (shop.category === '商场' && drivers.length && ctx.random() < 0.07) {
          // 开车来的一家人：同车者也各算一次到访
          const company = Math.min(Math.floor(ctx.random() * 3), slots[i] - 1);
          const riders = Array.from({ length: company }, nextVisitor);
          slots[i] -= 1 + company;
          carVisit(
            ctx,
            drivers.pop()!,
            riders,
            target,
            te,
            pickGate(ctx),
            shopStay(ctx, shop, dwell),
          );
          continue;
        }
        slots[i]--;
        const person = nextVisitor();
        visit(
          ctx,
          person,
          target,
          te,
          (p) => shopStay(ctx, shop, dwell)(p, person),
          shop.category === '商场' ? 0.03 : 0.01,
        );
      }
    }
  }

  for (const facility of FACILITIES) {
    const [h0, h1, weekday, weekendRate] = facility.hours;
    const rate = weekend ? weekendRate : weekday;
    for (let s = hours(h0); s < hours(h1); s += SLOT) {
      const t = day * DAY + s;
      for (let n = poisson((rate * SLOT) / 3600, ctx.random); n > 0; n--) {
        const person = nextVisitor();
        const te = t + ctx.random() * SLOT;
        const dwell = between(ctx, facility.dwell[0], facility.dwell[1]) * 60;
        const target: Spot = facility.building ? building(facility.building.id) : parkSpot(ctx);
        visit(ctx, person, target, te, (p) => {
          if (facility.building) p.stay('visit', p.now + dwell, facility.label);
          else p.stroll(p.now + dwell, false, facility.label);
        });
      }
    }
  }
  return ctx.plan;
}

const personOf = (id: string) => personById.get(id)!;

const planCache = new Map<number, DayPlan>();

/** 某一天所有人的安排与用车请求。 */
export function dayPlan(day: number): DayPlan {
  let plan = planCache.get(day);
  if (!plan) {
    plan = buildPlan(day);
    planCache.set(day, plan);
    if (planCache.size > 3) planCache.delete(planCache.keys().next().value!);
  }
  return plan;
}
