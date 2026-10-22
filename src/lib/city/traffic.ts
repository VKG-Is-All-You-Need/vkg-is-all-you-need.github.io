/**
 * 车辆轨迹：信号灯控制下的道路交通，按天推演为分段，任意时刻的位置可直接求得。车辆之间互不影响，
 * 车速只取决于路段、时段与天气。
 * - 过境车辆从街区边缘的出入口驶入，穿过街区后驶出；工作日早晚高峰更多；
 * - 员工与外来访客按 plans.ts 中的请求开车往返，车停进车库后不再出现在道路上；
 * - 配送车上午与午后各跑一轮，在商店门口停靠卸货；
 * - 网约车在接单之间巡游，接单后经最短路径去接乘客，再送到目的地或驶出街区；
 * - 公交车从车场驶入后沿环线运行，每个路口设站，午后在湖滨站换班。
 * 某一天的轨迹在首次用到时计算并缓存。
 */
import { city } from '../geo/city';
import { seededRandom, type Point } from '../geo/spatial';
import { shops } from './commerce';
import { homeOf } from './people';
import { dayPlan, type OrderRequest } from './plans';
import {
  BUS_LOOP,
  edgeBetween,
  edgeById,
  gateById,
  gates,
  isGate,
  nearestNode,
  nextGreen,
  nodeById,
  roads,
  shortestPath,
  speedAt,
  type Axis,
} from './roads';
import { DAY, DAYS, dayOf, hours } from './time';
import { busCrews, vehicleById, vehicles, vehiclesOf, type Vehicle } from './vehicles';
import { curbAt, doorOf, walkRoute, walkSeconds } from './walk';

export interface Segment {
  t0: number;
  t1: number;
  /** 起点与终点（已含车道偏移与停车线）。 */
  from: Point;
  to: Point;
  edge: number;
  /** 行驶方向的终点路口；等待时为所在路口。 */
  node: number;
  axis: Axis;
  waiting: boolean;
}

/** 一次用车：自驾或网约车订单。 */
export interface Trip {
  id: string;
  vehicle: string;
  kind: 'drive' | 'taxi';
  person: string;
  /** 同车的其他人。 */
  riders: string[];
  /** 自驾为出发时刻，打车为下单时刻。 */
  request: number;
  /** 乘客上车的时刻（自驾等于出发时刻）。 */
  pickup: number;
  /** 到达目的地的时刻；驶出街区时为驶出的时刻。 */
  arrive: number;
  from: Point;
  to: Point;
  /** 驶出街区的出入口。 */
  exit?: number;
}

/** 公交进站：到站与离站时刻。 */
export interface StopVisit {
  bus: string;
  node: number;
  arrive: number;
  depart: number;
}

/** 驾驶人在车上的时段；passengers 为同乘者（过境车辆）。 */
export interface Stint {
  vehicle: string;
  person: string;
  start: number;
  end: number;
  passengers: string[];
}

/** 配送车停在商店附近卸货：司机下车把货送进店里。 */
export interface Delivery {
  vehicle: string;
  shop: number;
  start: number;
  end: number;
  /** 停车位置。 */
  at: Point;
}

/** 公交换班：早班司机在 node 站下车，晚班司机上车。 */
export interface Handover {
  bus: string;
  node: number;
  arrive: number;
  depart: number;
}

const LANE_OFFSET = 4;
/** 停车线离路口中心的距离（米）：停在人行横道之后，与公交站台对齐。 */
const STOP_LINE = 24;

/** 在路段上从 a 驶向 b 时的车道位置（靠右行驶，并留出停车线；出入口一端不留）。 */
function laneEnds(aId: number, bId: number): [Point, Point] {
  const a = nodeById.get(aId)!;
  const b = nodeById.get(bId)!;
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const dx = (b.x - a.x) / length;
  const dy = (b.y - a.y) / length;
  // 平面坐标 y 轴朝北，行驶方向右侧的法向为 (dy, -dx)
  const ox = dy * LANE_OFFSET;
  const oy = -dx * LANE_OFFSET;
  const head = isGate(aId) ? 0 : STOP_LINE;
  const tail = isGate(bId) ? 0 : STOP_LINE;
  return [
    { x: a.x + dx * head + ox, y: a.y + dy * head + oy },
    { x: b.x - dx * tail + ox, y: b.y - dy * tail + oy },
  ];
}

type Next = (current: number, previous: number | null) => { to: number };

/** 逐段推演：直到时刻 end 或驶过 maxEdges 个路段为止。 */
function simulate(
  start: number,
  end: number,
  startNode: number,
  next: Next,
  /** 到达路口后的停靠时长（秒），如公交进站。 */
  dwell?: (node: number, t: number) => number,
  maxEdges = Infinity,
): Segment[] {
  const segments: Segment[] = [];
  let t = start;
  let node = startNode;
  let previous: number | null = null;
  for (let count = 0; t < end && count < maxEdges; count++) {
    const { to } = next(node, previous);
    const edge = edgeBetween(node, to);
    const [from, stop] = laneEnds(node, to);
    const duration = Math.hypot(stop.x - from.x, stop.y - from.y) / speedAt(edge, t);
    segments.push({
      t0: t,
      t1: t + duration,
      from,
      to: stop,
      edge: edge.id,
      node: to,
      axis: edge.axis,
      waiting: false,
    });
    t += duration;
    const stay = dwell?.(to, t) ?? 0;
    if (stay > 0) {
      segments.push({
        t0: t,
        t1: t + stay,
        from: stop,
        to: stop,
        edge: edge.id,
        node: to,
        axis: edge.axis,
        waiting: false,
      });
      t += stay;
    }
    // 驶出街区的一段终点没有信号灯；路径的最后一个路口也不必等灯
    const green = isGate(to) || count === maxEdges - 1 ? t : nextGreen(to, edge.axis, t);
    if (green > t) {
      segments.push({
        t0: t,
        t1: green,
        from: stop,
        to: stop,
        edge: edge.id,
        node: to,
        axis: edge.axis,
        waiting: true,
      });
      t = green;
    }
    previous = node;
    node = to;
  }
  return segments;
}

/** 沿给定路口序列行驶（可以以出入口开头或结尾）。 */
function route(start: number, path: number[]): Segment[] {
  if (path.length < 2) return [];
  let i = 0;
  return simulate(start, Infinity, path[0], () => ({ to: path[++i] }), undefined, path.length - 1);
}

/** 从路口（或出入口）到路口（或出入口）的路径。 */
function pathBetween(from: number, to: number): number[] {
  const a = gateById.get(from);
  const b = gateById.get(to);
  const path = shortestPath(a?.junction ?? from, b?.junction ?? to);
  return [...(a ? [from] : []), ...path, ...(b ? [to] : [])];
}

/** 原地停靠（上下客、卸货）。 */
function stopover(t: number, seconds: number, node: number, last?: Segment): Segment {
  if (last) {
    return { ...last, t0: t, t1: t + seconds, from: last.to, waiting: false };
  }
  const { edge, to } = roads.adjacency.get(node)![0];
  const [from] = laneEnds(node, to);
  return {
    t0: t,
    t1: t + seconds,
    from,
    to: from,
    edge: edge.id,
    node: to,
    axis: edge.axis,
    waiting: false,
  };
}

/** 去掉路径中的原路折返（a → b → a）。 */
function straighten(path: number[]): number[] {
  const out: number[] = [];
  for (const node of path) {
    if (out.at(-1) === node) continue;
    if (out.length >= 2 && out.at(-2) === node) {
      out.pop();
      continue;
    }
    out.push(node);
  }
  return out;
}

const gateSide = (id: number) => {
  const { x, y } = gateById.get(id)!.node;
  return x === 0 ? 'w' : y === 0 ? 's' : x > 900 ? 'e' : 'n';
};

interface DayTraffic {
  segments: Map<string, Segment[]>;
  trips: Trip[];
  visits: StopVisit[];
  stints: Stint[];
  deliveries: Delivery[];
  handovers: Handover[];
}

/** 推演某一天所有车辆的轨迹。 */
function simulateDay(day: number): DayTraffic {
  const random = seededRandom(1000 + day * 7919);
  const between = (a: number, b: number) => a + random() * (b - a);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  const weekend = DAYS[day].weekend;
  const base = day * DAY;
  const plan = dayPlan(day);
  const segments = new Map<string, Segment[]>();
  const trips: Trip[] = [];
  const stints: Stint[] = [];
  const deliveries: Delivery[] = [];
  const handovers: Handover[] = [];
  const nodeIds = roads.nodes.map((n) => n.id);
  const append = (vehicle: Vehicle, more: Segment[]) => {
    const list = segments.get(vehicle.id) ?? [];
    list.push(...more);
    segments.set(vehicle.id, list);
  };

  // 随机游走，略偏向中心区域（车流更集中在中心站一带）
  const centerWeight = (id: number) => {
    const node = nodeById.get(id)!;
    return 1 + 2.2 * Math.exp(-Math.hypot(node.x - 480, node.y - 360) / 180);
  };
  const randomWalk: Next = (current, previous) => {
    const options = roads.adjacency.get(current)!;
    const forward = options.filter((option) => option.to !== previous);
    const pool = forward.length ? forward : options;
    const weights = pool.map(({ to }) => centerWeight(to));
    let pick = random() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < pool.length; i++) {
      pick -= weights[i];
      if (pick <= 0) return pool[i];
    }
    return pool.at(-1)!;
  };
  const centerNode = () => {
    let pick = random() * nodeIds.reduce((sum, id) => sum + centerWeight(id), 0);
    for (const id of nodeIds) {
      pick -= centerWeight(id);
      if (pick <= 0) return id;
    }
    return nodeIds.at(-1)!;
  };
  // 过境车流多走中央大道与人民路两条主干道
  const gateWeight = (id: number) =>
    /^(中央大道|人民路)/.test(gateById.get(id)!.node.name) ? 4 : 1;
  const weighted = (pool: typeof gates) => {
    let pick = random() * pool.reduce((sum, g) => sum + gateWeight(g.id), 0);
    for (const g of pool) {
      pick -= gateWeight(g.id);
      if (pick <= 0) return g.id;
    }
    return pool.at(-1)!.id;
  };
  const otherGate = (from: number) => {
    const options = gates.filter((g) => g.id !== from);
    const across = options.filter((g) => gateSide(g.id) !== gateSide(from));
    return weighted(random() < 0.8 ? across : options);
  };
  const anyGate = () => weighted(gates);
  const nearestGate = (node: number) => {
    const p = nodeById.get(node)!;
    return gates.reduce((best, g) =>
      Math.hypot(g.node.x - p.x, g.node.y - p.y) < Math.hypot(best.node.x - p.x, best.node.y - p.y)
        ? g
        : best,
    ).id;
  };

  // ── 过境车辆：工作日约一半的车早晚各穿过一次，其余随机穿过一到三次 ──
  for (const [index, vehicle] of vehiclesOf('through').entries()) {
    const departs: number[] = [];
    const commuter = !weekend && index % 20 < 9;
    if (commuter) {
      if (random() < 0.92) {
        departs.push(base + hours(8, 25) + gauss() * 1200, base + hours(18, 10) + gauss() * 1500);
      }
    } else if (random() < (weekend ? 0.7 : 0.8)) {
      const n = 1 + Math.floor(random() * 3.5);
      for (let i = 0; i < n; i++) {
        departs.push(
          base + (weekend ? between(hours(8), hours(22)) : between(hours(6, 30), hours(23))),
        );
      }
      departs.sort((a, b) => a - b);
    }
    // 通勤车早上从 home 一侧驶入、从 work 一侧驶出，晚上反过来
    const home = anyGate();
    const work = otherGate(home);
    let free = 0;
    departs.forEach((depart, i) => {
      const start = Math.max(depart, free);
      if (start > base + hours(23, 40)) return;
      const entry = commuter ? (i === 0 ? home : work) : anyGate();
      const exit = commuter ? (i === 0 ? work : home) : otherGate(entry);
      const via = random() < 0.8 ? centerNode() : null;
      const a = gateById.get(entry)!.junction;
      const b = gateById.get(exit)!.junction;
      const middle = via
        ? [...shortestPath(a, via), ...shortestPath(via, b).slice(1)]
        : shortestPath(a, b);
      const list = route(start, [entry, ...straighten(middle), exit]);
      append(vehicle, list);
      const end = list.at(-1)!.t1;
      stints.push({
        vehicle: vehicle.id,
        person: vehicle.driver!,
        start,
        end,
        passengers: vehicle.companion && random() < 0.6 ? [vehicle.companion] : [],
      });
      free = end + 2400;
    });
  }

  // ── 配送车：上午一轮，工作日午后部分车辆再跑一轮 ──
  vehiclesOf('van').forEach((vehicle, v) => {
    const rounds: number[] = [];
    if (!weekend || v % 2 === 0) rounds.push(base + hours(7) + between(0, hours(2, 30)));
    if (!weekend && random() < 0.6) rounds.push(base + hours(13, 30) + between(0, hours(2)));
    for (const start of rounds) {
      const entry = anyGate();
      let t = start;
      let node = entry;
      const list: Segment[] = [];
      const stops = shops
        .slice()
        .sort(() => random() - 0.5)
        .slice(0, 3 + Math.floor(random() * 3));
      for (const shop of stops) {
        const target = nearestNode(doorOf(city.buildings.find((b) => b.id === shop.buildingId)!));
        const leg = route(t, pathBetween(node, target.id));
        list.push(...leg);
        if (leg.length) {
          t = leg.at(-1)!.t1;
          node = target.id;
        }
        const last = list.at(-1);
        const at = last ? last.to : nodeById.get(node)!;
        const curb = curbAt(at);
        const door = doorOf(city.buildings.find((b) => b.id === shop.buildingId)!);
        const walk =
          walkSeconds(walkRoute(curb, door), 1.3) + walkSeconds(walkRoute(door, curb), 1.3);
        const stay = walk + between(120, 240);
        list.push(stopover(t, stay, node, last));
        deliveries.push({
          vehicle: vehicle.id,
          shop: shop.id,
          start: t,
          end: t + stay,
          at: { ...at },
        });
        t += stay;
      }
      const exit = nearestGate(node);
      list.push(...route(t, pathBetween(node, exit)));
      append(vehicle, list);
      stints.push({
        vehicle: vehicle.id,
        person: vehicle.driver!,
        start,
        end: list.at(-1)!.t1,
        passengers: [],
      });
    }
  });

  // ── 自驾：员工上下班、外来车辆进出（按 plans.ts 的请求） ──
  const freeAt = new Map<string, number>();
  for (const drive of plan.drives.slice().sort((a, b) => a.depart - b.depart)) {
    const vehicle = vehicleById.get(drive.vehicle)!;
    // 同一辆车的上一段还没开完时顺延
    const start = Math.max(drive.depart, freeAt.get(vehicle.id) ?? -Infinity);
    const list = route(start, pathBetween(drive.from, drive.to));
    if (!list.length) continue;
    append(vehicle, list);
    const end = list.at(-1)!.t1;
    freeAt.set(vehicle.id, end + 60);
    trips.push({
      id: drive.id,
      vehicle: vehicle.id,
      kind: 'drive',
      person: drive.person,
      riders: drive.riders,
      request: drive.depart,
      pickup: start,
      arrive: end,
      from: drive.origin,
      to: drive.destination,
    });
  }

  // ── 网约车：订单分给预计最早空闲的车（具名人物的订单由王磊接；王磊不接出街区的单） ──
  const taxis = vehiclesOf('taxi');
  const orders = plan.orders.slice().sort((a, b) => a.request - b.request);
  const free = new Map(taxis.map((taxi) => [taxi.id, base + hours(7)]));
  const assigned = new Map<string, OrderRequest[]>(taxis.map((taxi) => [taxi.id, []]));
  for (const order of orders) {
    if (order.request < base + hours(7) || order.request > base + hours(22, 30)) continue;
    const pool = [...free.entries()].filter(
      ([id]) => !order.exit || vehicleById.get(id)!.driver !== 'P05',
    );
    const taxi = order.taxi ?? pool.sort((a, b) => a[1] - b[1])[0][0];
    // 预计要等 15 分钟以上的订单没有车接（具名人物的订单除外）
    if (!order.taxi && free.get(taxi)! > order.request + 900) continue;
    free.set(taxi, Math.max(free.get(taxi)!, order.request) + (order.exit ? 2400 : 720));
    assigned.get(taxi)!.push(order);
  }
  const homeNode = nearestNode(homeOf('P05')).id;
  taxis.forEach((taxi, i) => {
    const list: Segment[] = [];
    const ownCar = taxi.driver === 'P05';
    const shiftStart = base + hours(7) + i * 240;
    let t = shiftStart;
    let node: number;
    let stintStart = t;
    let inside = true;
    const push = (more: Segment[]) => {
      list.push(...more);
      if (more.length) {
        t = more.at(-1)!.t1;
        node = more.at(-1)!.node;
      }
    };
    if (ownCar) {
      // 王磊的车停在家附近，上车后出发
      node = homeNode;
      push([stopover(t, 60, node)]);
    } else {
      node = anyGate();
      push(route(t, pathBetween(node, gateById.get(node)!.junction)));
    }
    for (const order of assigned.get(taxi.id)!) {
      if (t < order.request) push(simulate(t, order.request, node!, randomWalk));
      push(route(t, shortestPath(node!, nearestNode(order.from).id)));
      // 停在路边等乘客：乘客按下单时估计的时间走到路边，最多再等两分半
      push([stopover(t, Math.max(40, order.request + 150 - t), node!, list.at(-1))]);
      const pickup = t;
      if (order.exit) {
        push(route(t, pathBetween(node!, order.exit)));
        trips.push({
          id: order.id,
          vehicle: taxi.id,
          kind: 'taxi',
          person: order.person,
          riders: [],
          request: order.request,
          pickup,
          arrive: t,
          from: order.from,
          to: order.to,
          exit: order.exit,
        });
        stints.push({
          vehicle: taxi.id,
          person: taxi.driver!,
          start: stintStart,
          end: t,
          passengers: [],
        });
        // 在街区外送完乘客后再驶回；临近收车时不再回来
        t += between(900, 1800);
        if (t > base + hours(22, 40)) {
          inside = false;
          break;
        }
        const back = anyGate();
        stintStart = t;
        node = back;
        push(route(t, [back, gateById.get(back)!.junction]));
        continue;
      }
      push(route(t, shortestPath(node!, nearestNode(order.to).id)));
      push([stopover(t, 30, node!, list.at(-1))]);
      trips.push({
        id: order.id,
        vehicle: taxi.id,
        kind: 'taxi',
        person: order.person,
        riders: [],
        request: order.request,
        pickup,
        arrive: t,
        from: order.from,
        to: order.to,
      });
    }
    if (inside) {
      if (t < base + hours(23)) push(simulate(t, base + hours(23), node!, randomWalk));
      if (ownCar) {
        push(route(t, shortestPath(node!, homeNode)));
        push([stopover(t, 60, node!, list.at(-1))]);
      } else {
        push(route(t, pathBetween(node!, nearestGate(node!))));
      }
      stints.push({
        vehicle: taxi.id,
        person: taxi.driver!,
        start: stintStart,
        end: t,
        passengers: [],
      });
    }
    segments.set(taxi.id, list);
  });

  // ── 公交：从车场驶入，沿环线运行，午后在湖滨站换班 ──
  // 信号灯会让同一路口等灯的车辆同时放行，不加控制时四辆车很快就会聚到一起。
  // 公交按时刻表运行：四辆车在环线上均匀分布、同时发车，每站按计划时刻离站，早到就多停一会儿。
  const change = nearestNode(city.stations.find((s) => s.name === '湖滨站')!.location).id;
  const HOP = 75;
  busCrews.forEach((crew, b) => {
    const vehicle = vehicleById.get(crew.bus)!;
    let position = (b * 2) % BUS_LOOP.length;
    const first = base + (weekend ? hours(7) : hours(6));
    // 从车场经环线的上一站驶入首站，停在站台一侧
    const previous = BUS_LOOP[(position + BUS_LOOP.length - 1) % BUS_LOOP.length];
    const depot = nearestGate(previous);
    const deadhead = route(
      first - 300,
      straighten([...pathBetween(depot, previous), BUS_LOOP[position]]),
    );
    // 首站上客，按时发车
    const arrive = deadhead.length ? deadhead.at(-1)!.t1 : first - 30;
    deadhead.push(
      stopover(arrive, Math.max(30, first - arrive), BUS_LOOP[position], deadhead.at(-1)),
    );
    const start = Math.max(first, arrive + 30);
    const next: Next = (current) => {
      position = (BUS_LOOP.indexOf(current) + 1) % BUS_LOOP.length;
      return { to: BUS_LOOP[position] };
    };
    const dwellRandom = seededRandom(101 + b + day * 13);
    const changeAt = base + hours(14, 30) + b * 360;
    let handover: Handover | null = null;
    let stop = 0;
    const dwell = (node: number, t: number) => {
      const scheduled = start + ++stop * HOP;
      const seconds = Math.max(8 + dwellRandom() * 14, scheduled - t);
      if (!handover && node === change && t >= changeAt) {
        handover = { bus: vehicle.id, node, arrive: t, depart: t + Math.max(90, seconds) };
        return Math.max(90, seconds);
      }
      return seconds;
    };
    const service = simulate(start, base + hours(24), BUS_LOOP[position], next, dwell);
    segments.set(vehicle.id, [...deadhead, ...service]);
    const end = service.at(-1)!.t1;
    const h = handover as Handover | null;
    if (h) {
      handovers.push(h);
      stints.push(
        {
          vehicle: vehicle.id,
          person: crew.early,
          start: first - 300,
          end: h.arrive + 20,
          passengers: [],
        },
        { vehicle: vehicle.id, person: crew.late, start: h.depart - 30, end, passengers: [] },
      );
    } else {
      stints.push({
        vehicle: vehicle.id,
        person: crew.early,
        start: first - 300,
        end,
        passengers: [],
      });
    }
  });

  const visits: StopVisit[] = [];
  for (const vehicle of vehiclesOf('bus')) {
    for (const s of segments.get(vehicle.id)!) {
      if (!s.waiting && s.from.x === s.to.x && s.from.y === s.to.y) {
        visits.push({ bus: vehicle.id, node: s.node, arrive: s.t0, depart: s.t1 });
      }
    }
  }
  for (const list of segments.values()) list.sort((a, b) => a.t0 - b.t0);
  visits.sort((a, b) => a.arrive - b.arrive);
  trips.sort((a, b) => a.request - b.request);
  return { segments, trips, visits, stints, deliveries, handovers };
}

/** 最近用到的几天的轨迹。 */
const dayCache = new Map<number, DayTraffic>();

function trafficOf(day: number): DayTraffic {
  let traffic = dayCache.get(day);
  if (!traffic) {
    traffic = simulateDay(day);
    dayCache.set(day, traffic);
    if (dayCache.size > 3) dayCache.delete(dayCache.keys().next().value!);
  }
  return traffic;
}

const NONE: Segment[] = [];
const segmentsOf = (vehicle: Vehicle, day: number) =>
  trafficOf(day).segments.get(vehicle.id) ?? NONE;

/** 某一天的用车记录（自驾与网约车）。 */
export const tripsOf = (day: number) => trafficOf(day).trips;

/** 某一天的公交进站记录。 */
export const stopVisits = (day: number) => trafficOf(day).visits;

/** 某一天驾驶人在车上的时段。 */
export const stintsOf = (day: number) => trafficOf(day).stints;

/** 某一天配送车的卸货停靠。 */
export const deliveriesOf = (day: number) => trafficOf(day).deliveries;

/** 某一天的公交换班。 */
export const handoversOf = (day: number) => trafficOf(day).handovers;

function segmentAt(vehicle: Vehicle, t: number): Segment | null {
  const segments = segmentsOf(vehicle, dayOf(t));
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segments[mid];
    if (t < s.t0) hi = mid - 1;
    else if (t >= s.t1) lo = mid + 1;
    else return s;
  }
  return null;
}

export interface VehicleState {
  x: number;
  y: number;
  /** 行驶方向（平面坐标，弧度，0 为东）。 */
  heading: number;
  waiting: boolean;
  node: number;
  edge: number;
  axis: Axis;
  speed: number;
  /** 等待时的排队序号，由 queuesAt 填充。 */
  queueIndex?: number;
}

export function vehicleAt(vehicle: Vehicle, t: number): VehicleState | null {
  const s = segmentAt(vehicle, t);
  if (!s) return null;
  const edge = edgeById.get(s.edge)!;
  const a = nodeById.get(edge.a)!;
  const b = nodeById.get(edge.b)!;
  const towardsB = s.node === b.id;
  const heading = towardsB ? Math.atan2(b.y - a.y, b.x - a.x) : Math.atan2(a.y - b.y, a.x - b.x);
  const k = s.waiting ? 1 : (t - s.t0) / (s.t1 - s.t0);
  return {
    x: s.from.x + (s.to.x - s.from.x) * k,
    y: s.from.y + (s.to.y - s.from.y) * k,
    heading,
    waiting: s.waiting,
    node: s.node,
    edge: s.edge,
    axis: s.axis,
    speed: s.waiting ? 0 : Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y) / (s.t1 - s.t0),
  };
}

export interface Queue {
  node: number;
  edge: number;
  vehicles: string[];
}

/** 时刻 t 各进口道上的排队车辆（按到达先后排序），并为等待车辆填写排队序号。 */
export function queuesAt(t: number, states: Map<string, VehicleState>): Queue[] {
  const groups = new Map<
    string,
    { node: number; edge: number; items: { id: string; since: number }[] }
  >();
  for (const vehicle of vehicles) {
    const state = states.get(vehicle.id);
    if (!state?.waiting) continue;
    const since = segmentAt(vehicle, t)!.t0;
    const key = `${state.node}:${state.edge}`;
    const group = groups.get(key) ?? { node: state.node, edge: state.edge, items: [] };
    group.items.push({ id: vehicle.id, since });
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    group.items.sort((a, b) => a.since - b.since);
    group.items.forEach((item, i) => (states.get(item.id)!.queueIndex = i));
    return { node: group.node, edge: group.edge, vehicles: group.items.map((item) => item.id) };
  });
}

export function statesAt(t: number): Map<string, VehicleState> {
  const states = new Map<string, VehicleState>();
  for (const vehicle of vehicles) {
    const state = vehicleAt(vehicle, t);
    if (state) states.set(vehicle.id, state);
  }
  return states;
}

/** 按 5 秒采样的轨迹（vehicle_positions）。 */
export function trajectory(vehicle: Vehicle, from: number, to: number, step = 5): Point[] {
  const points: Point[] = [];
  for (let t = from; t <= to; t += step) {
    const state = vehicleAt(vehicle, t);
    if (state) points.push({ x: state.x, y: state.y });
  }
  return points;
}

let lastSpeeds: { key: string; value: Map<number, number> } | null = null;

/** 时间窗（同一天内）各路段的平均行驶速度（米/秒），按行驶时长加权；不含等灯时间。 */
export function edgeSpeeds(windows: [number, number][]): Map<number, number> {
  // 播放时同一时间窗会被反复查询，缓存最近一次的结果
  const key = windows.map(([a, b]) => `${a}-${b}`).join(',');
  if (lastSpeeds?.key !== key) lastSpeeds = { key, value: computeEdgeSpeeds(windows) };
  return lastSpeeds.value;
}

function computeEdgeSpeeds(windows: [number, number][]): Map<number, number> {
  const distance = new Map<number, number>();
  const time = new Map<number, number>();
  if (!windows.length) return new Map();
  const day = dayOf(windows[0][0]);
  for (const vehicle of vehicles) {
    for (const s of segmentsOf(vehicle, day)) {
      // 等灯、进站与上下客停靠都不计入行驶速度；街区边缘的进出路段不在路网中
      if (s.waiting || (s.from.x === s.to.x && s.from.y === s.to.y) || gateById.has(s.edge)) {
        continue;
      }
      for (const [w0, w1] of windows) {
        const overlap = Math.min(s.t1, w1) - Math.max(s.t0, w0);
        if (overlap <= 0) continue;
        const speed = Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y) / (s.t1 - s.t0);
        distance.set(s.edge, (distance.get(s.edge) ?? 0) + speed * overlap);
        time.set(s.edge, (time.get(s.edge) ?? 0) + overlap);
      }
    }
  }
  return new Map([...time].map(([edge, total]) => [edge, distance.get(edge)! / total]));
}
