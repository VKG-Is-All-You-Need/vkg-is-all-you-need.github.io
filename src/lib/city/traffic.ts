/**
 * 车辆轨迹：信号灯控制下的道路交通，按天推演为分段，任意时刻的位置可直接求得。
 * - 过境与配送车辆在路网中随机行驶，工作日高峰时段更多；
 * - 有停车许可的员工按上下班时间开车往返家与公司车库，车入库后不再出现在道路上；
 * - 网约车在接单之间巡游，接单后经最短路径去接乘客，再送到目的地；
 * - 公交车沿环线运行，每个路口设站，停靠时长各不相同。
 * 某一天的轨迹在首次用到时计算并缓存。
 */
import { city } from '../geo/city';
import { rectCenter, seededRandom, type Point } from '../geo/spatial';
import { carOwners, companyById, homeOf, people, personaTrips, sessionsOf } from './people';
import {
  edgeById,
  nearestNode,
  nextGreen,
  nodeById,
  roads,
  shortestPath,
  type Axis,
  type RoadEdge,
} from './roads';
import { DAY, DAYS, bell, dayOf, hours, isWeekend, timeOfDay } from './time';
import { fogAt, rainAt, windAt } from './weather';

export type VehicleKind = 'car' | 'bus' | 'taxi';

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

export interface Vehicle {
  id: string;
  kind: VehicleKind;
  plate: string;
  color: string;
  driver?: string;
  /** 有停车许可的车主（居民编号）。 */
  owner?: string;
}

type Role = 'cruise' | 'rush' | 'commuter' | 'taxi' | 'bus';

/** 一次用车：自驾或网约车订单。 */
export interface Trip {
  id: string;
  vehicle: string;
  kind: 'drive' | 'taxi';
  person: string;
  /** 自驾为出发时刻，打车为下单时刻。 */
  request: number;
  /** 乘客上车的时刻（自驾等于出发时刻）。 */
  pickup: number;
  /** 到达目的地的时刻。 */
  arrive: number;
  from: Point;
  to: Point;
}

/** 公交进站：到站与离站时刻。 */
export interface StopVisit {
  bus: string;
  node: number;
  arrive: number;
  depart: number;
}

const LANE_OFFSET = 4;
const STOP_LINE = 11;
const COLORS = ['#e8e4dc', '#3a3f46', '#b8c2cc', '#8e2f2f', '#2f5d8e', '#c9b27a', '#556b4f'];

/** 时段拥堵程度 0–1：工作日早晚高峰最高，周末午后略有拥堵。 */
export const rushAt = (t: number) => {
  const s = timeOfDay(t);
  if (isWeekend(t)) return 0.25 * bell(s, hours(15), hours(2));
  return Math.min(1, bell(s, hours(8, 30), hours(0, 45)) + bell(s, hours(18, 15), hours(0, 50)));
};

/** 路段在时刻 t 的通行速度（米/秒）：高峰、降雨与大雾都会降低车速。 */
export const speedAt = (edge: RoadEdge, t: number) =>
  11.5 * edge.factor * (1 - 0.45 * rushAt(t)) * (1 - 0.32 * rainAt(t)) * (1 - 0.22 * fogAt(t));

/** 在路段上从 a 驶向 b 时的车道位置（靠右行驶，并留出停车线）。 */
function laneEnds(aId: number, bId: number): [Point, Point] {
  const a = nodeById.get(aId)!;
  const b = nodeById.get(bId)!;
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const dx = (b.x - a.x) / length;
  const dy = (b.y - a.y) / length;
  // 平面坐标 y 轴朝北，行驶方向右侧的法向为 (dy, -dx)
  const ox = dy * LANE_OFFSET;
  const oy = -dx * LANE_OFFSET;
  return [
    { x: a.x + dx * STOP_LINE + ox, y: a.y + dy * STOP_LINE + oy },
    { x: b.x - dx * STOP_LINE + ox, y: b.y - dy * STOP_LINE + oy },
  ];
}

type Next = (current: number, previous: number | null) => { edge: RoadEdge; to: number };

/** 逐段推演：直到时刻 end 或驶过 maxEdges 个路段为止。 */
function simulate(
  start: number,
  end: number,
  startNode: number,
  next: Next,
  /** 到达路口后的停靠时长（秒），如公交进站。 */
  dwell?: (node: number) => number,
  maxEdges = Infinity,
): Segment[] {
  const segments: Segment[] = [];
  let t = start;
  let node = startNode;
  let previous: number | null = null;
  for (let count = 0; t < end && count < maxEdges; count++) {
    const { edge, to } = next(node, previous);
    const [from, stop] = laneEnds(node, to);
    const duration = (edge.length - STOP_LINE * 2) / speedAt(edge, t);
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
    const stay = dwell?.(to) ?? 0;
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
    const green = nextGreen(to, edge.axis, t);
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

/** 沿给定路口序列行驶。 */
function route(start: number, path: number[]): Segment[] {
  if (path.length < 2) return [];
  let i = 0;
  const next: Next = (current) => {
    const to = path[++i];
    const edge = roads.adjacency.get(current)!.find((option) => option.to === to)!.edge;
    return { edge, to };
  };
  return simulate(start, Infinity, path[0], next, undefined, path.length - 1);
}

/** 原地停靠（上下客）。 */
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

/** 粗略估计两点之间的行车时间（秒）。 */
const estimate = (path: number[]) =>
  path.slice(1).reduce((sum, to, i) => {
    const edge = roads.adjacency.get(path[i])!.find((option) => option.to === to)!.edge;
    return sum + edge.length / (11.5 * edge.factor * 0.7) + 15;
  }, 0);

// ── 车辆登记信息：一周内不变 ──
function buildVehicles(): { vehicle: Vehicle; role: Role }[] {
  const random = seededRandom(31);
  const list: { vehicle: Vehicle; role: Role }[] = [];
  let index = 1;
  const add = (role: Role, kind: VehicleKind, extra: Partial<Vehicle> = {}) =>
    list.push({
      role,
      vehicle: {
        id: `V${String(index++).padStart(3, '0')}`,
        kind,
        plate: `沪A·${String(10000 + Math.floor(random() * 89999))}`,
        color: kind === 'taxi' ? '#e6c07b' : COLORS[Math.floor(random() * COLORS.length)],
        ...extra,
      },
    });
  for (let i = 0; i < 16; i++) add('cruise', 'car');
  for (let i = 0; i < 64; i++) add('rush', 'car');
  // 网约车：三辆，其中一辆的司机为虚构人物王磊
  add('taxi', 'taxi', { driver: '王磊' });
  add('taxi', 'taxi');
  add('taxi', 'taxi');
  for (const owner of carOwners) add('commuter', 'car', { owner: owner.person });
  for (let b = 0; b < 4; b++) {
    list.push({
      role: 'bus',
      vehicle: { id: `B${b + 1}`, kind: 'bus', plate: `公交 ${b + 1}`, color: '#3f8f6a' },
    });
  }
  return list;
}

const registry = buildVehicles();
export const vehicles = registry.map((entry) => entry.vehicle);
export const vehicleById = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));
/** 车主（居民编号）到车辆。 */
export const vehicleByOwner = new Map(
  vehicles.filter((v) => v.owner).map((vehicle) => [vehicle.owner!, vehicle]),
);

// 公交：环线（文华街—星河路—北园街—梧桐路），四辆车错峰发车，每个路口设站。
// 信号灯会让同一路口等灯的车辆同时放行，若不考虑进站停靠，几圈之后四辆车就会聚到一起；
// 每次进站的停靠时长不同，车辆之间保持分散。
export const BUS_LOOP = [
  [320, 180],
  [480, 180],
  [640, 180],
  [640, 360],
  [640, 540],
  [480, 540],
  [320, 540],
  [320, 360],
].map(([x, y]) => roads.nodes.find((n) => n.x === x && n.y === y)!.id);

interface Order {
  id: string;
  person: string;
  request: number;
  from: Point;
  to: Point;
  taxi?: string;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** 网约车订单：平时较少，下雨、大风与晚间增多。 */
function taxiOrders(day: number, random: () => number): Order[] {
  const residents = people.filter((p) => !p.persona);
  const places = city.buildings.filter((b) =>
    ['住宅', '办公', '医院', '商场', '学校', '咖啡馆'].includes(b.kind),
  );
  const pickPlace = () => rectCenter(places[Math.floor(random() * places.length)].footprint);
  const orders: Order[] = [];
  for (let s = hours(7); s < hours(22, 30); s += 900) {
    const t = day * DAY + s;
    const rate =
      1 +
      7 * rainAt(t) +
      2.5 * clamp01((windAt(t) - 6) / 5) +
      1.5 * bell(s, hours(18, 30), hours(1, 30)) +
      (DAYS[day].weekend ? bell(s, hours(21), hours(1)) : 0);
    for (let expected = rate / 4; random() < expected; expected -= 1) {
      const from = pickPlace();
      let to = pickPlace();
      while (Math.hypot(to.x - from.x, to.y - from.y) < 250) to = pickPlace();
      orders.push({
        id: `R${day}${String(orders.length + 1).padStart(3, '0')}`,
        person: residents[Math.floor(random() * residents.length)].id,
        request: t + random() * 900,
        from,
        to,
      });
    }
  }
  for (const trip of personaTrips(day).filter((trip) => trip.mode === 'taxi')) {
    orders.push({
      id: trip.id,
      person: trip.person,
      request: trip.depart,
      from: trip.from,
      to: trip.to,
      taxi: 'V081',
    });
  }
  return orders.sort((a, b) => a.request - b.request);
}

interface DayTraffic {
  segments: Map<string, Segment[]>;
  trips: Trip[];
  visits: StopVisit[];
}

/** 推演某一天所有车辆的轨迹。 */
function simulateDay(day: number): DayTraffic {
  const random = seededRandom(1000 + day * 7919);
  const weekend = DAYS[day].weekend;
  const base = day * DAY;
  const nodeIds = roads.nodes.map((n) => n.id);
  const segments = new Map<string, Segment[]>();
  const trips: Trip[] = [];

  // 随机游走，略偏向中心区域（车流更集中在中心站一带）
  const randomWalk: Next = (current, previous) => {
    const options = roads.adjacency.get(current)!;
    const forward = options.filter((option) => option.to !== previous);
    const pool = forward.length ? forward : options;
    const weights = pool.map(({ to }) => {
      const node = nodeById.get(to)!;
      return 1 + 2.2 * Math.exp(-Math.hypot(node.x - 480, node.y - 360) / 180);
    });
    let pick = random() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < pool.length; i++) {
      pick -= weights[i];
      if (pick <= 0) return pool[i];
    }
    return pool.at(-1)!;
  };
  const cruise = (windows: [number, number][]) =>
    windows.flatMap(([start, end]) =>
      simulate(
        base + start,
        base + end,
        nodeIds[Math.floor(random() * nodeIds.length)],
        randomWalk,
      ),
    );

  // 网约车：订单分给预计最早空闲的车（具名人物的订单由王磊接）
  const orders = taxiOrders(day, random);
  const taxis = registry.filter((entry) => entry.role === 'taxi').map((entry) => entry.vehicle);
  const free = new Map(taxis.map((taxi) => [taxi.id, base + hours(7)]));
  const assigned = new Map<string, Order[]>(taxis.map((taxi) => [taxi.id, []]));
  for (const order of orders) {
    const taxi = order.taxi ?? [...free.entries()].sort((a, b) => a[1] - b[1])[0][0];
    free.set(taxi, Math.max(free.get(taxi)!, order.request) + 600);
    assigned.get(taxi)!.push(order);
  }
  taxis.forEach((taxi, i) => {
    const list: Segment[] = [];
    let t = base + hours(7) + i * 240;
    let node = nodeIds[Math.floor(random() * nodeIds.length)];
    const push = (more: Segment[]) => {
      list.push(...more);
      if (more.length) {
        t = more.at(-1)!.t1;
        node = more.at(-1)!.node;
      }
    };
    for (const order of assigned.get(taxi.id)!) {
      if (t < order.request) push(simulate(t, order.request, node, randomWalk));
      push(route(t, shortestPath(node, nearestNode(order.from).id)));
      push([stopover(t, 40, node, list.at(-1))]);
      const pickup = t;
      push(route(t, shortestPath(node, nearestNode(order.to).id)));
      push([stopover(t, 30, node, list.at(-1))]);
      trips.push({
        id: order.id,
        vehicle: taxi.id,
        kind: 'taxi',
        person: order.person,
        request: order.request,
        pickup,
        arrive: t,
        from: order.from,
        to: order.to,
      });
    }
    if (t < base + hours(23)) push(simulate(t, base + hours(23), node, randomWalk));
    segments.set(taxi.id, list);
  });

  // 员工开车上下班：家附近的路口 ↔ 公司车库所在的路口
  const sessions = new Map(sessionsOf(day).map((s) => [s.personId, s]));
  const drive = (
    vehicle: Vehicle,
    id: string,
    person: string,
    depart: number,
    from: Point,
    to: Point,
  ) => {
    const path = shortestPath(nearestNode(from).id, nearestNode(to).id);
    const list = route(depart, path);
    if (!list.length) return [];
    trips.push({
      id,
      vehicle: vehicle.id,
      kind: 'drive',
      person,
      request: depart,
      pickup: depart,
      arrive: list.at(-1)!.t1,
      from,
      to,
    });
    return list;
  };

  let busIndex = 0;
  for (const { vehicle, role } of registry) {
    let list: Segment[] = [];
    if (role === 'cruise') {
      list = cruise([[hours(6) + random() * hours(1), hours(24)]]);
    } else if (role === 'rush') {
      if (!weekend) {
        const morning = hours(7) + random() * hours(1, 30);
        const evening = hours(17) + random() * hours(1, 45);
        list = cruise([
          [morning, morning + hours(0, 50) + random() * hours(0, 40)],
          [evening, evening + hours(0, 50) + random() * hours(0, 50)],
        ]);
      } else if (random() < 0.35) {
        // 周末：约三分之一的车辆有一次外出
        const start = hours(9, 30) + random() * hours(9);
        list = cruise([[start, start + hours(0, 50) + random() * hours(1, 10)]]);
      }
    } else if (role === 'commuter') {
      const owner = vehicle.owner!;
      const planned = personaTrips(day).filter(
        (trip) => trip.person === owner && trip.mode === 'drive',
      );
      if (planned.length) {
        list = planned.flatMap((trip) =>
          drive(vehicle, trip.id, owner, trip.depart, trip.from, trip.to),
        );
      } else {
        const session = sessions.get(owner);
        const company = companyById.get(carOwners.find((c) => c.person === owner)!.companyId)!;
        const work = rectCenter(city.buildings.find((b) => b.id === company.buildingId)!.footprint);
        const home = homeOf(owner);
        if (session) {
          const there = estimate(shortestPath(nearestNode(home).id, nearestNode(work).id));
          list = drive(
            vehicle,
            `${vehicle.id}-${day}-am`,
            owner,
            session.start - there - 120,
            home,
            work,
          );
          if (session.end < base + hours(23, 45)) {
            list = list.concat(
              drive(vehicle, `${vehicle.id}-${day}-pm`, owner, session.end + 180, work, home),
            );
          }
        }
      }
    } else if (role === 'bus') {
      const b = busIndex++;
      let position = (b * 2) % BUS_LOOP.length;
      const next: Next = (current) => {
        position = (BUS_LOOP.indexOf(current) + 1) % BUS_LOOP.length;
        const to = BUS_LOOP[position];
        const edge = roads.adjacency.get(current)!.find((option) => option.to === to)!.edge;
        return { edge, to };
      };
      const dwellRandom = seededRandom(101 + b + day * 13);
      const dwell = () => 8 + dwellRandom() * 26;
      const first = base + (weekend ? hours(7) : hours(6)) + b * hours(0, 4);
      list = simulate(first, base + hours(24), BUS_LOOP[position], next, dwell);
    }
    if (role !== 'taxi') segments.set(vehicle.id, list);
  }

  const visits: StopVisit[] = [];
  for (const vehicle of vehicles.filter((v) => v.kind === 'bus')) {
    for (const s of segments.get(vehicle.id)!) {
      if (!s.waiting && s.from.x === s.to.x && s.from.y === s.to.y) {
        visits.push({ bus: vehicle.id, node: s.node, arrive: s.t0, depart: s.t1 });
      }
    }
  }
  visits.sort((a, b) => a.arrive - b.arrive);
  trips.sort((a, b) => a.request - b.request);
  return { segments, trips, visits };
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

const segmentsOf = (vehicle: Vehicle, day: number) => trafficOf(day).segments.get(vehicle.id)!;

/** 某一天的用车记录（自驾与网约车）。 */
export const tripsOf = (day: number) => trafficOf(day).trips;

/** 某一天的公交进站记录。 */
export const stopVisits = (day: number) => trafficOf(day).visits;

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
      // 等灯、进站与上下客停靠都不计入行驶速度
      if (s.waiting || (s.from.x === s.to.x && s.from.y === s.to.y)) continue;
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
