/**
 * 人行道网络：每个街区四周的人行道连成一圈，相邻街区在路口附近由人行横道相连；
 * 湖滨公园内可以自由步行，但要绕开湖面与园内建筑。行人在有信号灯的路口等绿灯再过街。
 * 路网规模很小，节点之间的最短路径在加载时一次算好。
 */
import { CITY, GRID, city, type Building, type Station } from '../geo/city';
import { pointInPolygon, type Point, type Polygon, type Rect } from '../geo/spatial';
import { SIGNAL_CYCLE, roads, walkGreen, type Axis } from './roads';

/** 人行道中线距街区边缘的距离（米）。 */
export const SIDEWALK = 5.5;
/** 有信号灯的人行横道在选路时折算的额外距离（米）：能少过一次马路就少过一次。 */
const CROSSING_COST = 8;

/** 人行横道所看的信号灯；街区边缘没有路口的街道可以直接通过。 */
export interface Crossing {
  node: number;
  axis: Axis;
}

const park = city.parks[0];
const nodes: Point[] = [];
const links: { to: number; length: number }[][] = [];
const crossings = new Map<number, Crossing>();
const parkNodes: number[] = [];
const pairKey = (a: number, b: number) => (a < b ? a * 4096 + b : b * 4096 + a);

const addNode = (p: Point) => {
  nodes.push({ x: p.x, y: p.y });
  links.push([]);
  return nodes.length - 1;
};
const link = (a: number, b: number, crossing?: Crossing) => {
  const length = Math.hypot(nodes[b].x - nodes[a].x, nodes[b].y - nodes[a].y);
  links[a].push({ to: b, length });
  links[b].push({ to: a, length });
  if (crossing) crossings.set(pairKey(a, b), crossing);
};

// ── 街区人行道：西南、东南、东北、西北四个角 ──
interface Ring {
  rect: Rect;
  corners: [number, number, number, number];
}

/** 街区某一侧的人行道离街区边缘的距离：个别建筑紧贴街区边缘，人行道从建筑与路缘之间穿过。 */
function insets(block: Rect): [number, number, number, number] {
  const inside = city.buildings.filter(({ footprint: f }) => {
    const cx = f.x + f.w / 2;
    const cy = f.y + f.h / 2;
    return cx > block.x && cx < block.x + block.w && cy > block.y && cy < block.y + block.h;
  });
  const side = (gap: (f: Rect) => number) =>
    Math.min(SIDEWALK, ...inside.map(({ footprint }) => Math.max(0.6, gap(footprint) / 2)));
  return [
    side((f) => f.x - block.x),
    side((f) => block.x + block.w - (f.x + f.w)),
    side((f) => f.y - block.y),
    side((f) => block.y + block.h - (f.y + f.h)),
  ];
}

const rings: Ring[] = city.blocks.map((block) => {
  const [west, east, south, north] = insets(block);
  const rect = {
    x: block.x + west,
    y: block.y + south,
    w: block.w - west - east,
    h: block.h - south - north,
  };
  const corners = [
    addNode({ x: rect.x, y: rect.y }),
    addNode({ x: rect.x + rect.w, y: rect.y }),
    addNode({ x: rect.x + rect.w, y: rect.y + rect.h }),
    addNode({ x: rect.x, y: rect.y + rect.h }),
  ] as Ring['corners'];
  for (let i = 0; i < 4; i++) link(corners[i], corners[(i + 1) % 4]);
  return { rect, corners };
});

const ringAt = (col: number, row: number) =>
  rings.find(
    (ring) =>
      Math.floor(ring.rect.x / GRID.width) === col && Math.floor(ring.rect.y / GRID.height) === row,
  );

// ── 湖滨公园：沿园边一圈，另有一条环湖步道；园内各点之间只要不穿过湖面与建筑即可直接走 ──
function insetPolygon(polygon: Polygon, d: number): Polygon {
  const n = polygon.length;
  const area = polygon.reduce((sum, p, i) => {
    const q = polygon[(i + 1) % n];
    return sum + p.x * q.y - q.x * p.y;
  }, 0);
  const sign = area > 0 ? 1 : -1;
  // 每条边向内平移 d，相邻两条平移后的边求交点
  const lines = polygon.map((p, i) => {
    const q = polygon[(i + 1) % n];
    const length = Math.hypot(q.x - p.x, q.y - p.y);
    const nx = (-(q.y - p.y) / length) * sign;
    const ny = ((q.x - p.x) / length) * sign;
    return { p: { x: p.x + nx * d, y: p.y + ny * d }, dx: q.x - p.x, dy: q.y - p.y };
  });
  return lines.map((line, i) => {
    const prev = lines[(i + n - 1) % n];
    const det = prev.dx * line.dy - prev.dy * line.dx;
    const k = ((line.p.x - prev.p.x) * line.dy - (line.p.y - prev.p.y) * line.dx) / det;
    return { x: prev.p.x + prev.dx * k, y: prev.p.y + prev.dy * k };
  });
}

/** 园边人行道（公园轮廓向内收一条人行道的宽度）。 */
export const PARK_RING = insetPolygon(park.area, SIDEWALK);

const parkBuildings = city.buildings.filter((b) => pointInPolygon(rectCenterOf(b), park.area));
function rectCenterOf(b: Building): Point {
  return { x: b.footprint.x + b.footprint.w / 2, y: b.footprint.y + b.footprint.h / 2 };
}

const insideLake = (p: Point, margin: number) =>
  ((p.x - park.lake.center.x) / (park.lake.rx + margin)) ** 2 +
    ((p.y - park.lake.center.y) / (park.lake.ry + margin)) ** 2 <
  1;

/** 园内两点之间能否直接走过去：不穿过湖面与建筑，也不走出公园。 */
function clearInPark(a: Point, b: Point): boolean {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  for (let s = 3; s < length - 3; s += 4) {
    const p = { x: a.x + ((b.x - a.x) * s) / length, y: a.y + ((b.y - a.y) * s) / length };
    if (insideLake(p, 4) || !pointInPolygon(p, park.area) || nearParkBuilding(p, 2)) return false;
  }
  return true;
}

function nearestOnSegment(p: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const k = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return { x: a.x + dx * k, y: a.y + dy * k };
}

function nearestOnPolygon(p: Point, polygon: Polygon): Point {
  let best = polygon[0];
  let distance = Infinity;
  polygon.forEach((a, i) => {
    const q = nearestOnSegment(p, a, polygon[(i + 1) % polygon.length]);
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < distance) {
      distance = d;
      best = q;
    }
  });
  return best;
}

const nearParkBuilding = (p: Point, margin: number) =>
  parkBuildings.some(
    ({ footprint: f }) =>
      p.x > f.x - margin &&
      p.x < f.x + f.w + margin &&
      p.y > f.y - margin &&
      p.y < f.y + f.h + margin,
  );

for (const p of PARK_RING) parkNodes.push(addNode(p));
// 环湖步道：避开湖边的建筑（湖心茶室）
const LAKE_PATH = 16;
for (let i = 0; i < LAKE_PATH; i++) {
  const a = (i / LAKE_PATH) * Math.PI * 2;
  const p = {
    x: park.lake.center.x + Math.cos(a) * (park.lake.rx + 14),
    y: park.lake.center.y + Math.sin(a) * (park.lake.ry + 14),
  };
  if (!nearParkBuilding(p, 4)) parkNodes.push(addNode(p));
}

// ── 人行横道：相邻街区的两个角之间，靠近路口；路口有信号灯时按信号灯通行 ──
const junctionAt = (x: number, y: number) => roads.nodes.find((n) => n.x === x && n.y === y);
const crossingAt = (x: number, y: number, axis: Axis): Crossing | undefined => {
  const node = junctionAt(x, y);
  return node ? { node: node.id, axis } : undefined;
};
const isParkCell = (col: number, row: number) => col >= 4 && row >= 2;

for (const ring of rings) {
  const col = Math.floor(ring.rect.x / GRID.width);
  const row = Math.floor(ring.rect.y / GRID.height);
  const [sw, se, ne, nw] = ring.corners;
  const eastX = (col + 1) * GRID.width;
  const northY = (row + 1) * GRID.height;
  // 东侧：穿过南北向街道（行人东西向通行）
  const east = ringAt(col + 1, row);
  if (east) {
    link(se, east.corners[0], crossingAt(eastX, row * GRID.height, 'ew'));
    link(ne, east.corners[3], crossingAt(eastX, northY, 'ew'));
  } else if (isParkCell(col + 1, row)) {
    const x = eastX + GRID.street / 2 + SIDEWALK;
    for (const [corner, y] of [
      [se, row * GRID.height],
      [ne, northY],
    ] as const) {
      const landing = addNode(nearestOnPolygon({ x, y: nodes[corner].y }, PARK_RING));
      parkNodes.push(landing);
      link(corner, landing, crossingAt(eastX, y, 'ew'));
    }
  }
  // 北侧：穿过东西向街道（行人南北向通行）
  const north = ringAt(col, row + 1);
  if (north) {
    link(nw, north.corners[0], crossingAt(col * GRID.width, northY, 'ns'));
    link(ne, north.corners[1], crossingAt(eastX, northY, 'ns'));
  } else if (isParkCell(col, row + 1)) {
    const y = northY + GRID.street / 2 + SIDEWALK;
    for (const [corner, x] of [
      [nw, col * GRID.width],
      [ne, eastX],
    ] as const) {
      const landing = addNode(nearestOnPolygon({ x: nodes[corner].x, y }, PARK_RING));
      parkNodes.push(landing);
      link(corner, landing, crossingAt(x, northY, 'ns'));
    }
  }
}

for (let i = 0; i < parkNodes.length; i++) {
  for (let j = i + 1; j < parkNodes.length; j++) {
    if (clearInPark(nodes[parkNodes[i]], nodes[parkNodes[j]])) link(parkNodes[i], parkNodes[j]);
  }
}

// ── 所有节点之间的最短路径（Floyd–Warshall） ──
const N = nodes.length;
const dist = new Float64Array(N * N).fill(Infinity);
const hop = new Int16Array(N * N).fill(-1);
for (let i = 0; i < N; i++) {
  dist[i * N + i] = 0;
  hop[i * N + i] = i;
  for (const { to, length } of links[i]) {
    const cost = length + (crossings.has(pairKey(i, to)) ? CROSSING_COST : 0);
    if (cost < dist[i * N + to]) {
      dist[i * N + to] = cost;
      hop[i * N + to] = to;
    }
  }
}
for (let k = 0; k < N; k++) {
  for (let i = 0; i < N; i++) {
    const ik = dist[i * N + k];
    if (ik === Infinity) continue;
    for (let j = 0; j < N; j++) {
      const total = ik + dist[k * N + j];
      if (total < dist[i * N + j]) {
        dist[i * N + j] = total;
        hop[i * N + j] = hop[i * N + k];
      }
    }
  }
}

// ── 任意点接入人行道：街区内的点垂直走到最近的人行道上，园内的点直接走到能看见的节点 ──
interface Anchor {
  /** 接入人行道的位置；园内的点没有。 */
  foot: Point | null;
  ends: { node: number; cost: number }[];
  /** 所在街区人行道的编号与边（西南角起逆时针 0–3）。 */
  ring?: number;
  side?: number;
}

const inPark = (p: Point) => pointInPolygon(p, park.area);

function nearestOnRing(p: Point, rect: Rect): { point: Point; side: number } {
  const x1 = rect.x + rect.w;
  const y1 = rect.y + rect.h;
  const clampX = Math.max(rect.x, Math.min(x1, p.x));
  const clampY = Math.max(rect.y, Math.min(y1, p.y));
  const options = [
    { point: { x: clampX, y: rect.y }, side: 0 },
    { point: { x: x1, y: clampY }, side: 1 },
    { point: { x: clampX, y: y1 }, side: 2 },
    { point: { x: rect.x, y: clampY }, side: 3 },
  ];
  return options.reduce((best, option) =>
    Math.hypot(option.point.x - p.x, option.point.y - p.y) <
    Math.hypot(best.point.x - p.x, best.point.y - p.y)
      ? option
      : best,
  );
}

const anchorCache = new Map<string, Anchor>();

function anchorOf(p: Point): Anchor {
  const key = `${Math.round(p.x * 10)},${Math.round(p.y * 10)}`;
  const cached = anchorCache.get(key);
  if (cached) return cached;
  let anchor: Anchor;
  const exact = nodes.findIndex((n) => Math.abs(n.x - p.x) < 0.05 && Math.abs(n.y - p.y) < 0.05);
  if (exact >= 0) {
    anchor = { foot: null, ends: [{ node: exact, cost: 0 }] };
  } else if (inPark(p)) {
    const ends = parkNodes
      .filter((id) => clearInPark(p, nodes[id]))
      .map((id) => ({ node: id, cost: Math.hypot(nodes[id].x - p.x, nodes[id].y - p.y) }));
    anchor = {
      foot: null,
      ends: ends.length ? ends : [{ node: nearestNode(p, parkNodes), cost: 0 }],
    };
  } else {
    let best = { ring: 0, point: p, side: 0, d: Infinity };
    rings.forEach((ring, index) => {
      const { point, side } = nearestOnRing(p, ring.rect);
      const d = Math.hypot(point.x - p.x, point.y - p.y);
      if (d < best.d) best = { ring: index, point, side, d };
    });
    // 公园外沿的点（如湖滨站出口）可能离园边人行道更近
    const parkFoot = nearestOnPolygon(p, PARK_RING);
    if (Math.hypot(parkFoot.x - p.x, parkFoot.y - p.y) < best.d) {
      const anchorInPark = anchorOf(parkFoot);
      anchor = { foot: parkFoot, ends: anchorInPark.ends };
    } else {
      const corners = rings[best.ring].corners;
      const a = corners[best.side];
      const b = corners[(best.side + 1) % 4];
      const cost = (id: number) =>
        Math.hypot(nodes[id].x - best.point.x, nodes[id].y - best.point.y);
      anchor = {
        foot: best.point,
        ends: [
          { node: a, cost: cost(a) },
          { node: b, cost: cost(b) },
        ],
        ring: best.ring,
        side: best.side,
      };
    }
  }
  anchorCache.set(key, anchor);
  return anchor;
}

function nearestNode(p: Point, ids: number[]): number {
  return ids.reduce((best, id) =>
    Math.hypot(nodes[id].x - p.x, nodes[id].y - p.y) <
    Math.hypot(nodes[best].x - p.x, nodes[best].y - p.y)
      ? id
      : best,
  );
}

// ── 选路 ──
export interface WalkRoute {
  points: Point[];
  /** 第 i 段（points[i] → points[i + 1]）是否为有信号灯的人行横道。 */
  crossings: (Crossing | null)[];
  length: number;
  /** 途经的信号灯数。 */
  signals: number;
}

const routeCache = new Map<string, WalkRoute>();
/** 出入口、站台等固定地点是同一个对象，按对象缓存可以省去拼接键。 */
const routeByObject = new WeakMap<Point, WeakMap<Point, WalkRoute>>();

function build(points: Point[], marks: (Crossing | null)[]): WalkRoute {
  const out: Point[] = [points[0]];
  const outMarks: (Crossing | null)[] = [];
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const last = out.at(-1)!;
    if (Math.hypot(p.x - last.x, p.y - last.y) < 0.01) {
      // 重合的点合并，保留横道标记
      if (marks[i - 1] && outMarks.length) outMarks[outMarks.length - 1] ??= marks[i - 1];
      continue;
    }
    out.push(p);
    outMarks.push(marks[i - 1]);
  }
  let length = 0;
  for (let i = 1; i < out.length; i++) {
    length += Math.hypot(out[i].x - out[i - 1].x, out[i].y - out[i - 1].y);
  }
  return {
    points: out,
    crossings: outMarks,
    length,
    signals: outMarks.filter(Boolean).length,
  };
}

/** 两点之间沿人行道的步行路线。 */
export function walkRoute(from: Point, to: Point): WalkRoute {
  let byTo = routeByObject.get(from);
  const hit = byTo?.get(to);
  if (hit) return hit;
  const route = computeRoute(from, to);
  if (!byTo) {
    byTo = new WeakMap();
    routeByObject.set(from, byTo);
  }
  byTo.set(to, route);
  return route;
}

function computeRoute(from: Point, to: Point): WalkRoute {
  const key = `${Math.round(from.x * 10)},${Math.round(from.y * 10)},${Math.round(to.x * 10)},${Math.round(to.y * 10)}`;
  const cached = routeCache.get(key);
  if (cached) return cached;
  const a = anchorOf(from);
  const b = anchorOf(to);
  let route: WalkRoute;
  if (Math.hypot(to.x - from.x, to.y - from.y) < 0.5) {
    route = build([from, to], [null]);
  } else if (a.ring !== undefined && a.ring === b.ring && a.side === b.side) {
    // 同一段人行道上，直接走过去
    route = build([from, a.foot!, b.foot!, to], [null, null, null]);
  } else if (!a.foot && !b.foot && inPark(from) && inPark(to) && clearInPark(from, to)) {
    route = build([from, to], [null]);
  } else {
    let best = { cost: Infinity, s: 0, e: 0 };
    for (const ea of a.ends) {
      for (const eb of b.ends) {
        const cost = ea.cost + dist[ea.node * N + eb.node] + eb.cost;
        if (cost < best.cost) best = { cost, s: ea.node, e: eb.node };
      }
    }
    if (best.cost === Infinity) throw new Error(`no walking route from ${key}`);
    const path = [best.s];
    while (path.at(-1) !== best.e) path.push(hop[path.at(-1)! * N + best.e]);
    const points = [from, ...(a.foot ? [a.foot] : []), ...path.map((id) => nodes[id])];
    const marks: (Crossing | null)[] = points.map(() => null);
    const offset = a.foot ? 2 : 1;
    for (let i = 1; i < path.length; i++) {
      marks[offset + i - 1] = crossings.get(pairKey(path[i - 1], path[i])) ?? null;
    }
    if (b.foot) points.push(b.foot);
    points.push(to);
    while (marks.length < points.length - 1) marks.push(null);
    route = build(points, marks);
  }
  if (routeCache.size > 40000) routeCache.clear();
  routeCache.set(key, route);
  return route;
}

/** 步行所需时间的上限（秒）：每个信号灯最多等一个周期。 */
export const walkSeconds = (route: WalkRoute, pace: number) =>
  route.length / pace + route.signals * SIGNAL_CYCLE;

export interface TimedPath {
  points: Point[];
  /** 到达每个点的时刻；在路口等灯时同一个点出现两次。 */
  times: number[];
}

/** 从 start 出发、以 pace（米/秒）步行，遇红灯在路口等待。 */
export function timedWalk(route: WalkRoute, start: number, pace: number): TimedPath {
  const points: Point[] = [route.points[0]];
  const times = [start];
  let t = start;
  for (let i = 0; i < route.crossings.length; i++) {
    const a = route.points[i];
    const b = route.points[i + 1];
    const crossing = route.crossings[i];
    if (crossing) {
      const go = walkGreen(crossing.node, crossing.axis, t);
      if (go > t) {
        points.push(a);
        times.push(go);
        t = go;
      }
    }
    t += Math.hypot(b.x - a.x, b.y - a.y) / pace;
    points.push(b);
    times.push(t);
  }
  return { points, times };
}

// ── 地点 ──
const doorCache = new Map<number, Point>();

/** 建筑的出入口：建筑轮廓上面向人行道的一侧的中点。 */
export function doorOf(building: Building): Point {
  const cached = doorCache.get(building.id);
  if (cached) return cached;
  const f = building.footprint;
  const center = rectCenterOf(building);
  let target: Point;
  if (inPark(center)) {
    // 园内建筑朝向最近的步道节点
    target = nodes[nearestNode(center, parkNodes)];
  } else {
    const ring = rings.find(
      (r) =>
        center.x > r.rect.x - SIDEWALK &&
        center.x < r.rect.x + r.rect.w + SIDEWALK &&
        center.y > r.rect.y - SIDEWALK &&
        center.y < r.rect.y + r.rect.h + SIDEWALK,
    )!;
    target = nearestOnRing(center, ring.rect).point;
  }
  const sides = [
    { p: { x: center.x, y: f.y }, d: f.y - target.y },
    { p: { x: f.x + f.w, y: center.y }, d: target.x - (f.x + f.w) },
    { p: { x: center.x, y: f.y + f.h }, d: target.y - (f.y + f.h) },
    { p: { x: f.x, y: center.y }, d: f.x - target.x },
  ];
  const door = sides.reduce((best, side) => (side.d > best.d ? side : best)).p;
  doorCache.set(building.id, door);
  return door;
}

const exitCache = new Map<number, Point[]>();

/** 地铁站的出入口：路口四角的人行道。 */
export function stationExits(station: Station): Point[] {
  let exits = exitCache.get(station.id);
  if (!exits) {
    exits = nodes.filter(
      (n) => Math.hypot(n.x - station.location.x, n.y - station.location.y) < 27,
    );
    exitCache.set(station.id, exits);
  }
  return exits;
}

/** 步行出入口：街区边缘的人行道端点。行人从这里走进、走出街区。 */
export interface WalkGate {
  id: number;
  /** 街区边缘上的点。 */
  at: Point;
  /** 相连的人行道转角。 */
  corner: Point;
}

export const walkGates: WalkGate[] = rings
  .flatMap((ring) => ring.corners.map((id) => nodes[id]))
  .flatMap((corner) => {
    const options: Point[] = [];
    if (corner.x < 20) options.push({ x: 0, y: corner.y });
    if (corner.x > CITY.width - 20) options.push({ x: CITY.width, y: corner.y });
    if (corner.y < 20) options.push({ x: corner.x, y: 0 });
    if (corner.y > CITY.height - 20) options.push({ x: corner.x, y: CITY.height });
    return options.map((at) => ({ at, corner }));
  })
  .map((gate, i) => ({ id: i + 1, ...gate }));

/** 公交站台：车辆进站方向右侧的人行道，停车线之前。 */
export function platformAt(stop: Point, previous: Point): Point {
  const length = Math.hypot(stop.x - previous.x, stop.y - previous.y);
  const dx = (stop.x - previous.x) / length;
  const dy = (stop.y - previous.y) / length;
  const side = GRID.street / 2 + SIDEWALK;
  return { x: stop.x - dx * 24 + dy * side, y: stop.y - dy * 24 - dx * side };
}

/** 路边离 p 最近的人行道（上下车的位置）。 */
export function curbAt(p: Point): Point {
  let best = nearestOnPolygon(p, PARK_RING);
  for (const ring of rings) {
    const { point } = nearestOnRing(p, ring.rect);
    if (Math.hypot(point.x - p.x, point.y - p.y) < Math.hypot(best.x - p.x, best.y - p.y)) {
      best = point;
    }
  }
  return best;
}
