/**
 * 示例街区：一座虚构的小城，数据结构对应 PostGIS 中的三张表
 * buildings(id, name, kind, floors, footprint)、stations(id, name, line, location)、parks(id, name, area)。
 * 坐标为投影坐标，单位为米，范围 960 × 720。
 */
import { rectsOverlap, seededRandom, type Point, type Polygon, type Rect } from './spatial';

export const CITY = { width: 960, height: 720 } as const;
export const GRID = { cols: 6, rows: 4, width: 160, height: 180, street: 24 } as const;
export const FLOOR_HEIGHT = 3.2;

export type BuildingKind =
  | '住宅'
  | '办公'
  | '商店'
  | '商场'
  | '咖啡馆'
  | '学校'
  | '医院'
  | '图书馆'
  | '博物馆'
  | '茶室'
  | '游客中心';

/** 有专门映射生成 rdf:type 的种类，本体将它们归入 :PublicFacility。 */
export const FACILITY_CLASS: Partial<Record<BuildingKind, string>> = {
  学校: ':School',
  医院: ':Hospital',
  图书馆: ':Library',
  博物馆: ':Museum',
};

export interface Building {
  id: number;
  name: string;
  kind: BuildingKind;
  floors: number;
  footprint: Rect;
}

export interface Station {
  id: number;
  name: string;
  line: string;
  location: Point;
}

export interface Park {
  id: number;
  name: string;
  area: Polygon;
  lake: { center: Point; rx: number; ry: number };
}

export interface City {
  buildings: Building[];
  stations: Station[];
  parks: Park[];
  /** 非公园街区的地块范围，用于绘制人行道。 */
  blocks: Rect[];
}

const stations: Station[] = [
  { id: 1, name: '中心站', line: '1 号线、2 号线', location: { x: 480, y: 360 } },
  { id: 2, name: '湖滨站', line: '2 号线', location: { x: 640, y: 540 } },
  { id: 3, name: '北站', line: '1 号线', location: { x: 160, y: 540 } },
];

const parks: Park[] = [
  {
    id: 1,
    name: '湖滨公园',
    area: [
      { x: 692, y: 372 },
      { x: 908, y: 372 },
      { x: 948, y: 412 },
      { x: 948, y: 668 },
      { x: 908, y: 708 },
      { x: 692, y: 708 },
      { x: 652, y: 668 },
      { x: 652, y: 412 },
    ],
    lake: { center: { x: 840, y: 560 }, rx: 64, ry: 48 },
  },
];

type Named = Omit<Building, 'id'>;

const named: Named[] = [
  { name: '拾光咖啡', kind: '咖啡馆', floors: 2, footprint: { x: 420, y: 300, w: 30, h: 30 } },
  { name: '街角咖啡', kind: '咖啡馆', floors: 2, footprint: { x: 540, y: 470, w: 30, h: 30 } },
  { name: '梧桐咖啡', kind: '咖啡馆', floors: 3, footprint: { x: 250, y: 420, w: 30, h: 30 } },
  { name: '云朵咖啡', kind: '咖啡馆', floors: 2, footprint: { x: 596, y: 40, w: 30, h: 30 } },
  { name: '北窗咖啡', kind: '咖啡馆', floors: 2, footprint: { x: 200, y: 640, w: 30, h: 30 } },
  { name: '河岸咖啡', kind: '咖啡馆', floors: 2, footprint: { x: 60, y: 60, w: 30, h: 30 } },
  { name: '码头咖啡', kind: '咖啡馆', floors: 2, footprint: { x: 860, y: 80, w: 30, h: 30 } },
  { name: '第一中学', kind: '学校', floors: 4, footprint: { x: 40, y: 600, w: 90, h: 80 } },
  { name: '实验小学', kind: '学校', floors: 3, footprint: { x: 670, y: 40, w: 90, h: 80 } },
  { name: '市立医院', kind: '医院', floors: 8, footprint: { x: 340, y: 200, w: 70, h: 80 } },
  { name: '市图书馆', kind: '图书馆', floors: 5, footprint: { x: 190, y: 40, w: 90, h: 80 } },
  { name: '城市博物馆', kind: '博物馆', floors: 3, footprint: { x: 680, y: 600, w: 70, h: 70 } },
  { name: '湖心茶室', kind: '茶室', floors: 1, footprint: { x: 825, y: 616, w: 30, h: 22 } },
  { name: '游客中心', kind: '游客中心', floors: 1, footprint: { x: 700, y: 390, w: 40, h: 30 } },
  { name: '星河商场', kind: '商场', floors: 6, footprint: { x: 510, y: 200, w: 100, h: 100 } },
  { name: '中央大厦', kind: '办公', floors: 28, footprint: { x: 400, y: 400, w: 50, h: 60 } },
  { name: '湖畔公寓', kind: '住宅', floors: 12, footprint: { x: 592, y: 600, w: 30, h: 40 } },
];

const ESTATES = [
  '梧桐里',
  '云杉苑',
  '银杏坊',
  '枫林居',
  '青檀苑',
  '松风里',
  '竹溪坊',
  '桂园',
  '柳岸居',
  '槐荫里',
  '樱花苑',
  '杏林坊',
  '榆园',
  '楠溪里',
  '枫桥苑',
  '柏庐',
  '海棠里',
  '丁香苑',
  '玉兰坊',
  '紫藤居',
  '芙蓉里',
  '蔷薇苑',
  '茉莉坊',
  '栀子居',
];

const isParkBlock = (col: number, row: number) => col >= 4 && row >= 2;

function buildCity(): City {
  const random = seededRandom(20261022);
  const between = (min: number, max: number) => min + random() * (max - min);
  const blocks: Rect[] = [];
  const fill: Named[] = [];
  const inset = GRID.street / 2;

  for (let row = 0; row < GRID.rows; row++) {
    for (let col = 0; col < GRID.cols; col++) {
      if (isParkBlock(col, row)) continue;
      const block: Rect = {
        x: col * GRID.width + inset,
        y: row * GRID.height + inset,
        w: GRID.width - GRID.street,
        h: GRID.height - GRID.street,
      };
      blocks.push(block);

      const estate = ESTATES[row * GRID.cols + col];
      let homes = 0;
      let offices = 0;
      const lotW = block.w / 2;
      const lotH = block.h / 2;
      for (let ly = 0; ly < 2; ly++) {
        for (let lx = 0; lx < 2; lx++) {
          const w = Math.round(between(30, 52));
          const h = Math.round(between(34, 62));
          const footprint: Rect = {
            x: Math.round(block.x + lx * lotW + 8 + random() * (lotW - 16 - w)),
            y: Math.round(block.y + ly * lotH + 8 + random() * (lotH - 16 - h)),
            w,
            h,
          };
          const roll = random();
          const floors = random();
          if (named.some((building) => rectsOverlap(building.footprint, footprint, 8))) continue;

          if (roll < 0.68) {
            homes += 1;
            fill.push({
              name: `${estate}${homes}号楼`,
              kind: '住宅',
              floors: 6 + Math.round(floors * 12),
              footprint,
            });
          } else if (roll < 0.88) {
            offices += 1;
            fill.push({
              name: `${estate}办公楼${'ABCD'[offices - 1]}座`,
              kind: '办公',
              floors: 10 + Math.round(floors * 14),
              footprint,
            });
          } else {
            fill.push({
              name: `${estate}商铺`,
              kind: '商店',
              floors: 2 + Math.round(floors * 2),
              footprint,
            });
          }
        }
      }
    }
  }

  const buildings = [...named, ...fill].map((building, i) => ({ id: i + 1, ...building }));
  return { buildings, stations, parks, blocks };
}

export const city: City = buildCity();
