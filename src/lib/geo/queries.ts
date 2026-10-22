/** 示例中的 GeoSPARQL 查询、对应的 PostGIS SQL（简化形式）以及在示例数据上的求值。 */
import { FACILITY_CLASS, type Building, type City } from './city';
import {
  distanceRectPoint,
  pointInPolygon,
  rectCorners,
  rectWithinPolygon,
  type Point,
  type Polygon,
} from './spatial';

export type Focus =
  { type: 'buffer'; centers: Point[]; radius: number } | { type: 'area'; polygon: Polygon };

export interface Hit {
  id: number;
  detail: string;
}

export interface QueryResult {
  hits: Hit[];
  /** 接近条件但未命中的对象，用于对比。 */
  misses: Hit[];
  focus: Focus;
}

export interface GeoQuery {
  id: 'cafes' | 'park' | 'facilities';
  title: string;
  feature: string;
  description: string;
  sparql: string;
  sql: string;
  run(city: City): QueryResult;
}

const metres = (value: number) => `${Math.round(value)} 米`;

/** 点到线段的距离，用于计算建筑到公园边界的距离。 */
function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function distanceToBoundary(building: Building, polygon: Polygon): number {
  return Math.min(
    ...rectCorners(building.footprint)
      .filter((corner) => !pointInPolygon(corner, polygon))
      .flatMap((corner) =>
        polygon.map((a, i) => distanceToSegment(corner, a, polygon[(i + 1) % polygon.length])),
      ),
  );
}

export const queries: GeoQuery[] = [
  {
    id: 'cafes',
    title: '中心站 300 米内的咖啡馆',
    feature: 'geof:distance → ST_Distance',
    description: '计算每家咖啡馆与中心站的距离，保留 300 米以内的结果并按距离排序。',
    sparql: `SELECT ?name ?dist WHERE {
  ?s a :Station ; :name "中心站" ;
     geo:hasGeometry/geo:asWKT ?sWkt .
  ?c a :Building ; :kind "咖啡馆" ; :name ?name ;
     geo:hasGeometry/geo:asWKT ?cWkt .
  BIND (geof:distance(?cWkt, ?sWkt, uom:metre) AS ?dist)
  FILTER (?dist < 300)
}
ORDER BY ?dist`,
    sql: `SELECT b.name,
       ST_Distance(b.footprint, s.location) AS dist
FROM   buildings b, stations s
WHERE  s.name = '中心站'
  AND  b.kind = '咖啡馆'
  AND  ST_Distance(b.footprint, s.location) < 300
ORDER  BY dist`,
    run(city) {
      const station = city.stations.find((s) => s.name === '中心站')!;
      const cafes = city.buildings
        .filter((b) => b.kind === '咖啡馆')
        .map((b) => ({ b, d: distanceRectPoint(b.footprint, station.location) }))
        .sort((a, z) => a.d - z.d);
      return {
        hits: cafes.filter(({ d }) => d < 300).map(({ b, d }) => ({ id: b.id, detail: metres(d) })),
        misses: cafes
          .filter(({ d }) => d >= 300)
          .map(({ b, d }) => ({ id: b.id, detail: metres(d) })),
        focus: { type: 'buffer', centers: [station.location], radius: 300 },
      };
    },
  },
  {
    id: 'park',
    title: '湖滨公园内的建筑',
    feature: 'geof:sfWithin → ST_Within',
    description: '判断建筑轮廓是否完全位于公园范围内，属于拓扑关系查询。',
    sparql: `SELECT ?name WHERE {
  ?p a :Park ; :name "湖滨公园" ;
     geo:hasGeometry/geo:asWKT ?pWkt .
  ?b a :Building ; :name ?name ;
     geo:hasGeometry/geo:asWKT ?bWkt .
  FILTER (geof:sfWithin(?bWkt, ?pWkt))
}`,
    sql: `SELECT b.name
FROM   buildings b, parks p
WHERE  p.name = '湖滨公园'
  AND  ST_Within(b.footprint, p.area)`,
    run(city) {
      const park = city.parks.find((p) => p.name === '湖滨公园')!;
      const inside = city.buildings.filter((b) => rectWithinPolygon(b.footprint, park.area));
      const near = city.buildings
        .filter((b) => !inside.includes(b))
        .map((b) => ({ b, d: distanceToBoundary(b, park.area) }))
        .filter(({ d }) => d < 40)
        .sort((a, z) => a.d - z.d)
        .slice(0, 3);
      return {
        hits: inside.map((b) => ({ id: b.id, detail: '位于公园内' })),
        misses: near.map(({ b, d }) => ({ id: b.id, detail: `距公园边界 ${metres(d)}` })),
        focus: { type: 'area', polygon: park.area },
      };
    },
  },
  {
    id: 'facilities',
    title: '地铁站 250 米内的公共设施',
    feature: '本体推理 + geof:distance',
    description:
      '数据库中没有“公共设施”这一类别。本体将学校、医院、图书馆与博物馆归入 :PublicFacility，再与距离条件组合。',
    sparql: `SELECT DISTINCT ?name WHERE {
  ?f a :PublicFacility ; :name ?name ;
     geo:hasGeometry/geo:asWKT ?fWkt .
  ?s a :Station ;
     geo:hasGeometry/geo:asWKT ?sWkt .
  FILTER (geof:distance(?fWkt, ?sWkt, uom:metre) < 250)
}`,
    sql: `-- :PublicFacility 经本体展开为 4 个类
SELECT DISTINCT b.name
FROM   buildings b, stations s
WHERE  b.kind IN ('学校', '医院', '图书馆', '博物馆')
  AND  ST_Distance(b.footprint, s.location) < 250`,
    run(city) {
      const facilities = city.buildings
        .filter((b) => b.kind in FACILITY_CLASS)
        .map((b) => {
          const nearest = city.stations
            .map((s) => ({ s, d: distanceRectPoint(b.footprint, s.location) }))
            .sort((a, z) => a.d - z.d)[0];
          return { b, ...nearest };
        })
        .sort((a, z) => a.d - z.d);
      const describe = ({ b, s, d }: (typeof facilities)[number]) => ({
        id: b.id,
        detail: `${b.kind} · 距${s.name} ${metres(d)}`,
      });
      return {
        hits: facilities.filter(({ d }) => d < 250).map(describe),
        misses: facilities.filter(({ d }) => d >= 250).map(describe),
        focus: { type: 'buffer', centers: city.stations.map((s) => s.location), radius: 250 },
      };
    },
  },
];

export const MAPPING = `mappingId  building
target     :building/{id} a :Building ; :name {name} ; :kind {kind} ;
               geo:hasGeometry :building/{id}/geom .
           :building/{id}/geom geo:asWKT {wkt}^^geo:wktLiteral .
source     SELECT id, name, kind, ST_AsText(footprint) AS wkt
           FROM buildings

mappingId  school
target     :building/{id} a :School .
source     SELECT id FROM buildings WHERE kind = '学校'

mappingId  station
target     :station/{id} a :Station ; :name {name} ;
               geo:hasGeometry :station/{id}/geom .
           :station/{id}/geom geo:asWKT {wkt}^^geo:wktLiteral .
source     SELECT id, name, ST_AsText(location) AS wkt FROM stations

mappingId  park
target     :park/{id} a :Park ; :name {name} ;
               geo:hasGeometry :park/{id}/geom .
           :park/{id}/geom geo:asWKT {wkt}^^geo:wktLiteral .
source     SELECT id, name, ST_AsText(area) AS wkt FROM parks`;

export const ONTOLOGY = `:School   rdfs:subClassOf :PublicFacility .
:Hospital rdfs:subClassOf :PublicFacility .
:Library  rdfs:subClassOf :PublicFacility .
:Museum   rdfs:subClassOf :PublicFacility .`;
