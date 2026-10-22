/** 路网与信号灯：街区之间的道路中线构成路网，每个路口一组信号灯。 */
import { GRID } from '../geo/city';
import { seededRandom, type Point } from '../geo/spatial';
import { bell, hours, isWeekend, timeOfDay } from './time';
import { fogAt, rainAt } from './weather';

export type Axis = 'ns' | 'ew';

export interface RoadNode {
  id: number;
  x: number;
  y: number;
  name: string;
}

export interface RoadEdge {
  id: number;
  a: number;
  b: number;
  axis: Axis;
  length: number;
  name: string;
  /** 路段通行能力系数，越小越容易拥堵。 */
  factor: number;
}

/** 南北向街道（自西向东）与东西向街道（自南向北）。 */
export const NS_STREETS = ['银杏路', '梧桐路', '中央大道', '星河路', '湖滨路'];
export const EW_STREETS = ['文华街', '人民路', '北园街'];

/** 公园内部没有道路。 */
const inPark = (x: number, y: number) => x > 640 && y > 360;

function buildRoads() {
  const nodes: RoadNode[] = [];
  const at = new Map<string, RoadNode>();
  for (let m = 1; m < GRID.rows; m++) {
    for (let k = 1; k < GRID.cols; k++) {
      const x = k * GRID.width;
      const y = m * GRID.height;
      if (inPark(x, y)) continue;
      const node = {
        id: nodes.length + 1,
        x,
        y,
        name: `${NS_STREETS[k - 1]} × ${EW_STREETS[m - 1]}`,
      };
      nodes.push(node);
      at.set(`${x},${y}`, node);
    }
  }

  const random = seededRandom(11);
  const edges: RoadEdge[] = [];
  const addEdge = (a: RoadNode, b: RoadNode, axis: Axis, street: string) => {
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    // 中心站与星河商场周边更拥堵
    const nearCenter = Math.hypot(midX - 480, midY - 360) < 120;
    const nearMall = midX > 480 && midX < 640 && midY > 170 && midY < 370;
    const factor = nearCenter ? 0.7 : nearMall ? 0.8 : 0.9 + random() * 0.15;
    const cross = (node: RoadNode) => node.name.split(' × ')[axis === 'ns' ? 1 : 0];
    edges.push({
      id: edges.length + 1,
      a: a.id,
      b: b.id,
      axis,
      length: Math.hypot(b.x - a.x, b.y - a.y),
      name: `${street}（${cross(a)}—${cross(b)}）`,
      factor,
    });
  };
  for (let m = 1; m < GRID.rows; m++) {
    for (let k = 1; k < GRID.cols - 1; k++) {
      const a = at.get(`${k * GRID.width},${m * GRID.height}`);
      const b = at.get(`${(k + 1) * GRID.width},${m * GRID.height}`);
      if (a && b && !inPark((a.x + b.x) / 2, a.y)) addEdge(a, b, 'ew', EW_STREETS[m - 1]);
    }
  }
  for (let k = 1; k < GRID.cols; k++) {
    for (let m = 1; m < GRID.rows - 1; m++) {
      const a = at.get(`${k * GRID.width},${m * GRID.height}`);
      const b = at.get(`${k * GRID.width},${(m + 1) * GRID.height}`);
      if (a && b && !inPark(a.x, (a.y + b.y) / 2)) addEdge(a, b, 'ns', NS_STREETS[k - 1]);
    }
  }

  const adjacency = new Map<number, { edge: RoadEdge; to: number }[]>();
  for (const edge of edges) {
    adjacency.set(edge.a, [...(adjacency.get(edge.a) ?? []), { edge, to: edge.b }]);
    adjacency.set(edge.b, [...(adjacency.get(edge.b) ?? []), { edge, to: edge.a }]);
  }
  return { nodes, edges, adjacency };
}

export const roads = buildRoads();
export const nodeById = new Map(roads.nodes.map((node) => [node.id, node]));
export const edgeById = new Map(roads.edges.map((edge) => [edge.id, edge]));

// ── 街区出入口：街道延伸到街区边缘，外来车辆从这里驶入、驶出 ──
// 出入口与相连的路段不设信号灯，也不计入路网（roads.nodes / roads.edges），只供车辆进出。
export interface Gate {
  id: number;
  /** 街区边缘上的端点。 */
  node: RoadNode;
  /** 相连的路口。 */
  junction: number;
  /** 路口到街区边缘的路段。 */
  edge: RoadEdge;
}

const GATE_BASE = 100;

function buildGates(): Gate[] {
  const gates: Gate[] = [];
  const junction = (x: number, y: number) => roads.nodes.find((n) => n.x === x && n.y === y);
  const add = (street: string, end: string, from: RoadNode | undefined, x: number, y: number) => {
    if (!from) return;
    const id = GATE_BASE + gates.length + 1;
    const axis: Axis = x === from.x ? 'ns' : 'ew';
    const node = { id, x, y, name: `${street}${end}` };
    const cross = from.name.split(' × ')[axis === 'ns' ? 1 : 0];
    const edge: RoadEdge = {
      id,
      a: from.id,
      b: id,
      axis,
      length: Math.hypot(x - from.x, y - from.y),
      name: `${street}（${cross}—${end}）`,
      factor: 0.95,
    };
    gates.push({ id, node, junction: from.id, edge });
  };
  const top = (GRID.rows - 1) * GRID.height;
  const right = (GRID.cols - 1) * GRID.width;
  NS_STREETS.forEach((street, k) => {
    const x = (k + 1) * GRID.width;
    add(street, '南口', junction(x, GRID.height), x, 0);
    if (!inPark(x, top + 1)) add(street, '北口', junction(x, top), x, GRID.rows * GRID.height);
  });
  EW_STREETS.forEach((street, m) => {
    const y = (m + 1) * GRID.height;
    add(street, '西口', junction(GRID.width, y), 0, y);
    if (!inPark(right + 1, y)) add(street, '东口', junction(right, y), GRID.cols * GRID.width, y);
  });
  return gates;
}

export const gates = buildGates();
export const gateById = new Map(gates.map((gate) => [gate.id, gate]));
for (const gate of gates) {
  nodeById.set(gate.node.id, gate.node);
  edgeById.set(gate.edge.id, gate.edge);
}
export const isGate = (nodeId: number) => gateById.has(nodeId);

/** 两个相邻路口（或路口与出入口）之间的路段。 */
export function edgeBetween(a: number, b: number): RoadEdge {
  const gate = gateById.get(a) ?? gateById.get(b);
  if (gate) return gate.edge;
  return roads.adjacency.get(a)!.find((option) => option.to === b)!.edge;
}

// ── 信号灯：周期 60 秒，南北向与东西向交替放行 ──
export const SIGNAL_CYCLE = 60;
export type SignalState = 'green' | 'yellow' | 'red';

const offset = (node: RoadNode) => (node.x / 160) * 13 + (node.y / 180) * 7;

/** 该方向在信号周期中的相位（秒）：0–25 为绿灯，25–28 为黄灯，其余为红灯。 */
function phaseOf(nodeId: number, axis: Axis, t: number): number {
  const node = nodeById.get(nodeId)!;
  const local = (((t + offset(node)) % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE;
  return axis === 'ns' ? local : (local + 30) % SIGNAL_CYCLE;
}

export function signalState(nodeId: number, axis: Axis, t: number): SignalState {
  const phase = phaseOf(nodeId, axis, t);
  return phase < 25 ? 'green' : phase < 28 ? 'yellow' : 'red';
}

/** 从 t 起，该方向下一次变为绿灯的时刻（当前为绿灯则返回 t）。 */
export function nextGreen(nodeId: number, axis: Axis, t: number): number {
  const phase = phaseOf(nodeId, axis, t);
  return phase < 25 ? t : t + (SIGNAL_CYCLE - phase);
}

/**
 * 行人过街：沿 axis 方向过街的行人与同向车流一起放行。绿灯剩余不足 8 秒时不再起步，等下一个绿灯。
 */
export function walkGreen(nodeId: number, axis: Axis, t: number): number {
  const phase = phaseOf(nodeId, axis, t);
  return phase < 17 ? t : t + (SIGNAL_CYCLE - phase);
}

// ── 通行速度 ──
/** 时段拥堵程度 0–1：工作日早晚高峰最高，周末午后略有拥堵。 */
export const rushAt = (t: number) => {
  const s = timeOfDay(t);
  if (isWeekend(t)) return 0.25 * bell(s, hours(15), hours(2));
  return Math.min(1, bell(s, hours(8, 30), hours(0, 45)) + bell(s, hours(18, 15), hours(0, 50)));
};

/** 路段在时刻 t 的通行速度（米/秒）：高峰、降雨与大雾都会降低车速。 */
export const speedAt = (edge: RoadEdge, t: number) =>
  11.5 * edge.factor * (1 - 0.45 * rushAt(t)) * (1 - 0.32 * rainAt(t)) * (1 - 0.22 * fogAt(t));

export const nodePoint = (node: RoadNode): Point => ({ x: node.x, y: node.y });

/** 离某点最近的路口（车辆从这里进出路网）。 */
export function nearestNode(p: Point): RoadNode {
  return roads.nodes.reduce((best, node) =>
    Math.hypot(node.x - p.x, node.y - p.y) < Math.hypot(best.x - p.x, best.y - p.y) ? node : best,
  );
}

const pathCache = new Map<string, number[]>();

/** 两个路口之间的最短路径（按路段长度与通行能力加权），返回途经的路口编号。 */
export function shortestPath(from: number, to: number): number[] {
  const key = `${from}>${to}`;
  const cached = pathCache.get(key);
  if (cached) return cached;
  const cost = new Map<number, number>([[from, 0]]);
  const previous = new Map<number, number>();
  const open = new Set([from]);
  while (open.size) {
    let current = -1;
    for (const id of open) if (current < 0 || cost.get(id)! < cost.get(current)!) current = id;
    open.delete(current);
    if (current === to) break;
    for (const { edge, to: next } of roads.adjacency.get(current) ?? []) {
      const total = cost.get(current)! + edge.length / edge.factor;
      if (total < (cost.get(next) ?? Infinity)) {
        cost.set(next, total);
        previous.set(next, current);
        open.add(next);
      }
    }
  }
  const path = [to];
  while (path[0] !== from) path.unshift(previous.get(path[0])!);
  pathCache.set(key, path);
  return path;
}

// 公交环线（文华街—星河路—北园街—梧桐路），每个路口设站，车辆沿此方向单向运行。
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

/** 环线上从站点 a 到站点 b 要经过的路段数。 */
export const loopHops = (a: number, b: number) =>
  (BUS_LOOP.indexOf(b) - BUS_LOOP.indexOf(a) + BUS_LOOP.length) % BUS_LOOP.length;

/** 环线上站点的上一站（车辆从这里驶来）。 */
export const previousStop = (stop: number) =>
  BUS_LOOP[(BUS_LOOP.indexOf(stop) + BUS_LOOP.length - 1) % BUS_LOOP.length];
