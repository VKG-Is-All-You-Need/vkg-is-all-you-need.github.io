/** 平面几何工具。坐标为投影坐标，单位为米，y 轴朝北。 */

export interface Point {
  x: number;
  y: number;
}

/** 轴对齐矩形，(x, y) 为西南角。 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Polygon = Point[];

export const rectCorners = ({ x, y, w, h }: Rect): Polygon => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

export const rectCenter = ({ x, y, w, h }: Rect): Point => ({ x: x + w / 2, y: y + h / 2 });

/** 点到矩形的最短距离，点在矩形内时为 0（与 ST_Distance 的语义一致）。 */
export function distanceRectPoint(rect: Rect, point: Point): number {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.w));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.h));
  return Math.hypot(dx, dy);
}

/** 射线法判断点是否在多边形内。 */
export function pointInPolygon(point: Point, polygon: Polygon): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** 矩形是否完全位于凸多边形内（与 ST_Within 的语义一致）。 */
export const rectWithinPolygon = (rect: Rect, polygon: Polygon): boolean =>
  rectCorners(rect).every((corner) => pointInPolygon(corner, polygon));

export const rectsOverlap = (a: Rect, b: Rect, gap = 0): boolean =>
  a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

const fmt = (n: number) => String(Math.round(n));

export const pointToWkt = ({ x, y }: Point): string => `POINT(${fmt(x)} ${fmt(y)})`;

export const polygonToWkt = (polygon: Polygon): string => {
  const ring = [...polygon, polygon[0]].map(({ x, y }) => `${fmt(x)} ${fmt(y)}`).join(', ');
  return `POLYGON((${ring}))`;
};

export const rectToWkt = (rect: Rect): string => polygonToWkt(rectCorners(rect));

/** 可复现的伪随机数（mulberry32），保证每次构建生成同一座街区。 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
