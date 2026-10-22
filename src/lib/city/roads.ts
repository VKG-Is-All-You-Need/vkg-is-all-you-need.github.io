/** 路网与信号灯：街区之间的道路中线构成路网，每个路口一组信号灯。 */
import { GRID } from '../geo/city';
import { seededRandom, type Point } from '../geo/spatial';

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

// ── 信号灯：周期 60 秒，南北向与东西向交替放行 ──
export const SIGNAL_CYCLE = 60;
export type SignalState = 'green' | 'yellow' | 'red';

const offset = (node: RoadNode) => (node.x / 160) * 13 + (node.y / 180) * 7;

export function signalState(nodeId: number, axis: Axis, t: number): SignalState {
  const node = nodeById.get(nodeId)!;
  const local = (((t + offset(node)) % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE;
  const phase = axis === 'ns' ? local : (local + 30) % SIGNAL_CYCLE;
  return phase < 25 ? 'green' : phase < 28 ? 'yellow' : 'red';
}

/** 从 t 起，该方向下一次变为绿灯的时刻（当前为绿灯则返回 t）。 */
export function nextGreen(nodeId: number, axis: Axis, t: number): number {
  const node = nodeById.get(nodeId)!;
  const local = (((t + offset(node)) % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE;
  const phase = axis === 'ns' ? local : (local + 30) % SIGNAL_CYCLE;
  return phase < 25 ? t : t + (SIGNAL_CYCLE - phase);
}

export const nodePoint = (node: RoadNode): Point => ({ x: node.x, y: node.y });
