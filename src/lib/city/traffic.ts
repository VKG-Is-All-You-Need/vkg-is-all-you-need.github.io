/**
 * 车辆轨迹：每辆车在活动时段内沿路网随机行驶（公交车按固定线路），
 * 遇红灯在停车线前等待。轨迹按天推演为分段，任意时刻的位置可直接求得；
 * 工作日有通勤车流，周末只有少量出行。某一天的轨迹在首次用到时计算并缓存。
 */
import { seededRandom, type Point } from '../geo/spatial';
import { fogAt, rainAt } from './weather';
import { DAY, DAYS, bell, dayOf, hours, isWeekend, timeOfDay } from './time';
import { edgeById, nextGreen, nodeById, roads, type Axis, type RoadEdge } from './roads';

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
}

type Role = 'allday' | 'commuter' | 'taxi' | 'bus';

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

function simulate(
  start: number,
  end: number,
  startNode: number,
  next: (current: number, previous: number | null) => { edge: RoadEdge; to: number },
  /** 到达路口后的停靠时长（秒），如公交进站。 */
  dwell?: (node: number) => number,
): Segment[] {
  const segments: Segment[] = [];
  let t = start;
  let node = startNode;
  let previous: number | null = null;
  while (t < end) {
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

// ── 车辆登记信息：一周内不变 ──
const ROLES: { role: Role; count: number }[] = [
  { role: 'allday', count: 16 },
  { role: 'commuter', count: 64 },
  { role: 'taxi', count: 1 },
];

function buildVehicles(): { vehicle: Vehicle; role: Role }[] {
  const random = seededRandom(31);
  const list: { vehicle: Vehicle; role: Role }[] = [];
  let index = 1;
  for (const { role, count } of ROLES) {
    for (let i = 0; i < count; i++) {
      const taxi = role === 'taxi';
      list.push({
        role,
        vehicle: {
          id: `V${String(index++).padStart(3, '0')}`,
          kind: taxi ? 'taxi' : 'car',
          plate: `沪A·${String(10000 + Math.floor(random() * 89999))}`,
          color: taxi ? '#e6c07b' : COLORS[Math.floor(random() * COLORS.length)],
          // 网约车司机为虚构人物王磊
          driver: taxi ? '王磊' : undefined,
        },
      });
    }
  }
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

// 公交：环线（文华街—星河路—北园街—梧桐路），四辆车错峰发车。
// 信号灯会让同一路口等灯的车辆同时放行，若不考虑进站停靠，几圈之后四辆车就会聚到一起；
// 每次进站的停靠时长不同，车辆之间保持分散。
const BUS_LOOP = [
  [320, 180],
  [480, 180],
  [640, 180],
  [640, 360],
  [640, 540],
  [480, 540],
  [320, 540],
  [320, 360],
].map(([x, y]) => roads.nodes.find((n) => n.x === x && n.y === y)!.id);
const BUS_STOPS = new Set(BUS_LOOP.filter((_, i) => i % 2 === 1));

/** 推演某一天所有车辆的轨迹。 */
function simulateDay(day: number): Map<string, Segment[]> {
  const random = seededRandom(1000 + day * 7919);
  const weekend = DAYS[day].weekend;
  const base = day * DAY;
  const nodeIds = roads.nodes.map((n) => n.id);
  const result = new Map<string, Segment[]>();

  // 随机游走，略偏向中心区域（通勤车流更集中在中心站一带）
  const randomWalk = (current: number, previous: number | null) => {
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
  const drive = (windows: [number, number][]) =>
    windows.flatMap(([start, end]) =>
      simulate(
        base + start,
        base + end,
        nodeIds[Math.floor(random() * nodeIds.length)],
        randomWalk,
      ),
    );

  let busIndex = 0;
  for (const { vehicle, role } of registry) {
    let segments: Segment[] = [];
    if (role === 'allday') {
      segments = drive([[hours(6) + random() * hours(1), hours(24)]]);
    } else if (role === 'commuter') {
      if (!weekend) {
        const morning = hours(7) + random() * hours(1, 30);
        const evening = hours(17) + random() * hours(1, 45);
        segments = drive([
          [morning, morning + hours(0, 50) + random() * hours(0, 40)],
          [evening, evening + hours(0, 50) + random() * hours(0, 50)],
        ]);
      } else if (random() < 0.35) {
        // 周末：约三分之一的车辆有一次外出
        const start = hours(9, 30) + random() * hours(9);
        segments = drive([[start, start + hours(0, 50) + random() * hours(1, 10)]]);
      }
    } else if (role === 'taxi') {
      segments = drive([[hours(7), hours(23)]]);
    } else {
      const b = busIndex++;
      let position = (b * 2) % BUS_LOOP.length;
      const next = (current: number) => {
        position = (BUS_LOOP.indexOf(current) + 1) % BUS_LOOP.length;
        const to = BUS_LOOP[position];
        const edge = roads.adjacency.get(current)!.find((option) => option.to === to)!.edge;
        return { edge, to };
      };
      const dwellRandom = seededRandom(101 + b + day * 13);
      const dwell = (node: number) => (BUS_STOPS.has(node) ? 12 + dwellRandom() * 50 : 0);
      const first = base + (weekend ? hours(7) : hours(6)) + b * hours(0, 4);
      segments = simulate(first, base + hours(24), BUS_LOOP[position], next, dwell);
    }
    result.set(vehicle.id, segments);
  }
  return result;
}

/** 最近用到的几天的轨迹。 */
const dayCache = new Map<number, Map<string, Segment[]>>();

function segmentsOf(vehicle: Vehicle, day: number): Segment[] {
  let segments = dayCache.get(day);
  if (!segments) {
    segments = simulateDay(day);
    dayCache.set(day, segments);
    if (dayCache.size > 3) dayCache.delete(dayCache.keys().next().value!);
  }
  return segments.get(vehicle.id)!;
}

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
      // 等灯与进站停靠都不计入行驶速度
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
