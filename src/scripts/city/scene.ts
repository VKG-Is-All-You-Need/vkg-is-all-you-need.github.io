/**
 * “VKG × 城市数据融合”示例的三维场景。
 * 由 scripts/city/controller.ts 在场景进入视口后按需加载；渲染基础设施见 scripts/three。
 *
 * 两种视图：
 * - 城市：按模拟时间呈现信号灯、车辆、行人、温湿度传感器、天气（雨、雾、阴天、雷电）与昼夜。各数据源贡献的内容以该数据源的颜色标识，
 *   关闭数据源后相应内容淡出。行人是模拟中的实况，不属于任何数据源，始终显示；点击行人可查看各数据源中关于此人的记录。
 * - 分层：底部是八个独立的数据源，向上依次为映射、虚拟知识图谱与本体。查询结果中的每个实体都连到
 *   描述它的数据源；连到多个数据源的实体，就是融合的结果。
 */
import { tr } from '../../i18n/runtime';
import { term } from '../../lib/geo/names';
import * as THREE from 'three';
import type { Line2 } from 'three/addons/lines/Line2.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CITY, GRID, city, type Building } from '../../lib/geo/city';
import { pointInPolygon, rectCenter, seededRandom, type Point } from '../../lib/geo/spatial';
import { shopById, shops, type Shop } from '../../lib/city/commerce';
import { hasItinerary, isRide, pedestriansAt, personAt } from '../../lib/city/mobility';
import { platformOf } from '../../lib/city/plans';
import { companies, companyById, events, personById, personas } from '../../lib/city/people';
import { busLoad, presence } from '../../lib/city/records';
import type { CityResult, FusionEntity, FusionRelation, Highlight } from '../../lib/city/queries';
import {
  BUS_LOOP,
  edgeById,
  nodeById,
  previousStop,
  roads,
  signalState,
  type Axis,
  type SignalState,
} from '../../lib/city/roads';
import { SOURCES, sourceById, type DataSource, type SourceId } from '../../lib/city/sources';
import { ENV_SENSORS, STATION, readingAt, sensorById } from '../../lib/city/sensors';
import { at, dayOf, hours, timeOfDay } from '../../lib/city/time';
import { queuesAt, statesAt, tripsOf, type VehicleState } from '../../lib/city/traffic';
import { vehicles, type Vehicle } from '../../lib/city/vehicles';
import { crosswalks } from '../../lib/city/walk';
import { cloudAt, fogAt, observationAt, rainAt, stormAt, windAt } from '../../lib/city/weather';
import { createStage, type Pin } from '../three/stage';
import {
  ACCENT,
  AMBER,
  BLOCK_HEIGHT,
  PALETTE,
  createWorld,
  heightOf,
  toWorld,
  type Mode,
} from '../three/world';
import { clamp01, damp, easeOut, escapeHtml, rectOutline } from '../three/util';

export type { Mode } from '../three/world';
export type View = 'city' | 'layers';

export type Selection =
  | { type: 'building'; id: number }
  | { type: 'vehicle'; id: string }
  | { type: 'person'; id: string }
  | { type: 'sensor'; id: string }
  | { type: 'node'; id: number }
  | { type: 'edge'; id: number };

/** 选中对象在分层视图中的表示：标签、类，以及提供了记录的数据源。 */
export interface SelectionInfo {
  selection: Selection;
  label: string;
  cls: string;
  sources: SourceId[];
}

export type FocusTarget =
  | { type: 'node'; id: number }
  | { type: 'edge'; id: number }
  | { type: 'building'; id: number }
  | { type: 'vehicle'; id: string }
  | { type: 'persona'; id: string }
  | { type: 'sensor'; id: string }
  | { type: 'point'; at: Point };

/** 分层视图中可以点击查看介绍的对象：数据源、各层与本体中的类。 */
export type InfoTarget =
  | { type: 'source'; id: SourceId }
  | { type: 'layer'; id: LayerKey }
  | { type: 'class'; name: string };

export type LayerKey = 'data' | 'mapping' | 'graph' | 'ontology';

/** 导览中的一步：镜头飞向街区中的对象或分层视图中的某一层，并在该处标出提示点。 */
export interface CityTourStep {
  focus?: FocusTarget;
  layer?: LayerKey | 'overview';
  marker?: string;
}

export interface SceneCallbacks {
  onSelect(selection: Selection | null): void;
  onInfo(target: InfoTarget): void;
}

export interface CityScene {
  setTime(t: number, playing: boolean, speed: number): void;
  setSources(sources: ReadonlySet<SourceId>): void;
  setDetail(detail: boolean): void;
  /** 夜景显示：不论模拟时间，场景都按夜间光照呈现（天气照常）。 */
  setNightView(night: boolean): void;
  /** fresh 为 true 表示切换了查询：新出现的元素播放入场动画，城市视图中镜头移向结果。 */
  showResult(result: CityResult, fresh: boolean): void;
  select(info: SelectionInfo | null): void;
  focus(target: FocusTarget): void;
  setView(view: View): void;
  resetView(): void;
  /** 导览：传入 null 时移除提示点。 */
  tour(step: CityTourStep | null): void;
  /** 场景上方浮层面板占用的边距（像素），取景时只使用剩余区域。 */
  setInsets(insets: Insets): void;
  dispose(): void;
}

export interface Insets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** 分层视图中各层的高度（米）与建筑压缩比例，与地理示例一致。 */
const LAYER = { mapping: 190, graph: 380, ontology: 570 } as const;
const FLAT = 0.3;
const ONTOLOGY_HALF = { w: 500, d: 210 };
const PILLAR_TOP = 40;
const HALF_W = CITY.width / 2 + 30;
const HALF_D = CITY.height / 2 + 30;
/** 图谱层中节点中心的活动范围：距平面边缘留出光圈的宽度。 */
const GRAPH_LIMIT = { x: HALF_W - 24, z: HALF_D - 24 };

const SOURCE_COLOR = Object.fromEntries(
  SOURCES.map((source) => [source.id, new THREE.Color(source.color)]),
) as Record<SourceId, THREE.Color>;
const SIGNAL_COLOR: Record<SignalState, THREE.Color> = {
  green: new THREE.Color(0.15, 1, 0.45),
  yellow: new THREE.Color(1, 0.7, 0.1),
  red: new THREE.Color(1, 0.12, 0.08),
};
const SIGNAL_UNKNOWN = new THREE.Color(0.3, 0.33, 0.36);
const SIGNAL_BLUR = new THREE.Color(0.6, 0.52, 0.3);
const TAIL = new THREE.Color(1, 0.1, 0.07);
const BRAKE = new THREE.Color(2.2, 0.16, 0.1);
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const OVERCAST_NIGHT = new THREE.Color(0x161b21);
const FLASH = new THREE.Color(0xdfe6ff);
const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);
const WALKER_COLORS = ['#d9d4c7', '#5b6b7a', '#9b5d4f', '#3f5f8f', '#c7a65a', '#6f8f6a', '#8a6fa8'];
const UMBRELLA_COLORS = ['#2f3640', '#9a3b3b', '#2d5d8a', '#c8a64b', '#4c7a5a'];

const smoothstep = (a: number, b: number, x: number) => {
  const k = clamp01((x - a) / (b - a));
  return k * k * (3 - 2 * k);
};
/** 昼夜程度：0 为白天，1 为夜晚。 */
const nightAt = (t: number) => {
  const s = timeOfDay(t);
  return Math.max(
    1 - smoothstep(hours(5, 30), hours(7, 15), s),
    smoothstep(hours(17, 40), hours(19, 30), s),
  );
};
/** 路面湿度：取过去 4 小时的降水，雨停后逐渐变干。 */
const wetnessAt = (t: number) => {
  let wet = 0;
  for (let k = 0; k <= 24; k++) {
    wet = Math.max(wet, rainAt(t - k * 600) * Math.exp(-(k * 600) / 2700));
  }
  return Math.min(1, wet * 1.4);
};
/** 温度色带：低温蓝、适中绿、高温橙红。 */
const TEMPERATURE_STOPS: [number, THREE.Color][] = [
  [0, new THREE.Color('#3b6fd8')],
  [10, new THREE.Color('#3fb6d8')],
  [18, new THREE.Color('#5fd38a')],
  [24, new THREE.Color('#e8d36a')],
  [30, new THREE.Color('#ff7a3d')],
  [36, new THREE.Color('#e8364a')],
];
function temperatureColor(celsius: number, out: THREE.Color): THREE.Color {
  const stops = TEMPERATURE_STOPS;
  if (celsius <= stops[0][0]) return out.copy(stops[0][1]);
  for (let i = 1; i < stops.length; i++) {
    if (celsius <= stops[i][0]) {
      const k = (celsius - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]);
      return out.copy(stops[i - 1][1]).lerp(stops[i][1], k);
    }
  }
  return out.copy(stops.at(-1)![1]);
}
const speedColor = (kmh: number) =>
  new THREE.Color(kmh < 15 ? '#ff5f57' : kmh < 20 ? '#ffa24c' : kmh < 28 ? '#e8d36a' : '#5fd38a');
const planOf = (v: THREE.Vector3): Point => ({ x: v.x + CITY.width / 2, y: CITY.height / 2 - v.z });

/** 标签文本“名称 · 说明”拆成两部分显示。 */
const labelHtml = (label: string) => {
  const [head, ...rest] = label.split(' · ');
  return `<b>${escapeHtml(head)}</b>${rest.length ? `<span>${escapeHtml(rest.join(' · '))}</span>` : ''}`;
};
const sourceDots = (ids: SourceId[]) =>
  `<span class="dots">${ids.map((id) => `<i style="--c:${sourceById.get(id)!.color}"></i>`).join('')}</span>`;
/** 数据源标签显示联邦查询引擎中的 catalog 名，与查询改写中的表名前缀一致。 */
const sourcePin = (source: DataSource, on: boolean) =>
  `<b>${escapeHtml(source.catalog)}</b>${on ? '' : `<span>${tr('未接入', 'not connected')}</span>`}`;

function flatRing(inner: number, outer: number, color: THREE.ColorRepresentation, opacity: number) {
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(inner, outer, 64),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 2;
  return mesh;
}

export function createCityScene(
  container: HTMLElement,
  pinLayer: HTMLElement,
  callbacks: SceneCallbacks,
  options: {
    view: View;
    reducedMotion: boolean;
    t: number;
    sources: ReadonlySet<SourceId>;
    detail: boolean;
    nightView: boolean;
  },
): CityScene {
  const stage = createStage(container, pinLayer, { reducedMotion: options.reducedMotion });
  const { scene, camera, controls, reduced } = stage;
  controls.minDistance = 80;
  const world = createWorld(stage, city);
  const { entries } = world;
  const park = city.parks[0];

  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const scaleVector = new THREE.Vector3();
  const scratch = new THREE.Vector3();
  const color = new THREE.Color();

  // 两种视图都按模拟时间呈现昼夜；分层视图中线条与节点的配色随场景明暗切换，与页面主题无关
  let nightView = options.nightView;
  /** 夜景显示时固定为接近全黑的夜间光照，留一点余光便于辨认。 */
  const darkness = (t: number) => (nightView ? 0.92 : nightAt(t));
  let mode: Mode = darkness(options.t) > 0.5 ? 'night' : 'day';
  let view: View = options.view;
  stage.mix = view === 'layers' ? 1 : 0;
  let simT = options.t;
  let playing = false;
  let speed = 1;
  let detail = options.detail;
  let enabled = new Set(options.sources);
  const fade = Object.fromEntries(
    SOURCES.map((source) => [source.id, enabled.has(source.id) ? 1 : 0]),
  ) as Record<SourceId, number>;
  let blend = -1;
  /** applyBlend 给出的基础光照；云量、雾与闪电在此基础上逐帧调整。 */
  const lighting = { sun: 1, hemi: 1, bloom: 0, background: new THREE.Color() };
  const lightning = { flash: 0, echo: 0, next: 0 };
  let wet = -1;
  let rainVisual = 0;
  let buildingScale = 1;

  const buildingOf = (id: number) => entries.get(id)!.building;
  const centerOf = (id: number) => rectCenter(buildingOf(id).footprint);
  const roofOf = (building: Building) => BLOCK_HEIGHT + heightOf(building) * buildingScale;
  const buildingAt = (p: Point) =>
    city.buildings.find(
      ({ footprint: f }) => p.x >= f.x && p.x <= f.x + f.w && p.y >= f.y && p.y <= f.y + f.h,
    );

  const makeInstanced = (
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    count: number,
  ) => {
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    // 实例位置每帧变化：关闭视锥剔除，并给出覆盖整个街区的包围球供拾取使用
    mesh.frustumCulled = false;
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2000);
    for (let i = 0; i < count; i++) {
      mesh.setMatrixAt(i, HIDDEN);
      mesh.setColorAt(i, color.set(0xffffff));
    }
    return mesh;
  };

  // ─────────────────────────── 城市基础数据 ───────────────────────────

  const basePins = [
    ...city.stations.map((station) =>
      stage.addPin(
        `<b>M</b>${escapeHtml(term(station.name))}`,
        toWorld(station.location, 34),
        'pin-station',
        'city',
      ),
    ),
    stage.addPin(escapeHtml(term(park.name)), toWorld({ x: 800, y: 470 }, 14), 'pin-park', 'city'),
  ];

  // 路灯：沿路段两侧
  const lampSpots: THREE.Vector3[] = [];
  for (const edge of roads.edges) {
    const a = nodeById.get(edge.a)!;
    const b = nodeById.get(edge.b)!;
    const steps = Math.round(edge.length / 40);
    for (let i = 1; i < steps; i++) {
      const x = a.x + ((b.x - a.x) * i) / steps;
      const y = a.y + ((b.y - a.y) * i) / steps;
      for (const side of [-1, 1]) {
        lampSpots.push(
          edge.axis === 'ew'
            ? toWorld({ x, y: y + side * 13.5 })
            : toWorld({ x: x + side * 13.5, y }),
        );
      }
    }
  }
  const lampMaterial = new THREE.MeshBasicMaterial({ transparent: true });
  const lamps = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 8, 6),
    lampMaterial,
    lampSpots.length,
  );
  const poleMaterial = new THREE.MeshStandardMaterial({
    color: 0x59636c,
    roughness: 0.6,
    transparent: true,
  });
  const lampPoles = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.22, 0.28, 8, 5),
    poleMaterial,
    lampSpots.length,
  );
  lampSpots.forEach((p, i) => {
    lamps.setMatrixAt(i, matrix.makeTranslation(p.x, BLOCK_HEIGHT + 8.4, p.z));
    lampPoles.setMatrixAt(i, matrix.makeTranslation(p.x, BLOCK_HEIGHT + 4, p.z));
  });
  scene.add(lamps, lampPoles);

  // ─────────────────────────── 信号灯（交通时序） ───────────────────────────

  // 每个路口四个进口道各一组灯，位于驾驶员右前方的路口转角
  const CORNERS: [number, number, Axis][] = [
    [-1, 1, 'ns'],
    [1, -1, 'ns'],
    [1, 1, 'ew'],
    [-1, -1, 'ew'],
  ];
  const signalHeads: { node: number; axis: Axis }[] = [];
  const signalCount = roads.nodes.length * CORNERS.length;
  const signalMaterial = new THREE.MeshBasicMaterial({ transparent: true });
  const stopMaterial = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false });
  const signalLamps = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1.8, 3.6, 1.8),
    signalMaterial,
    signalCount,
  );
  const signalPoles = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.3, 0.3, 7, 6),
    poleMaterial,
    signalCount,
  );
  const stopBars = new THREE.InstancedMesh(
    new THREE.BoxGeometry(10, 0.2, 1.4),
    stopMaterial,
    signalCount,
  );
  for (const node of roads.nodes) {
    for (const [dx, dy, axis] of CORNERS) {
      const i = signalHeads.length;
      signalHeads.push({ node: node.id, axis });
      const corner = toWorld({ x: node.x + dx * 13, y: node.y + dy * 13 });
      signalPoles.setMatrixAt(i, matrix.makeTranslation(corner.x, BLOCK_HEIGHT + 3.5, corner.z));
      signalLamps.setMatrixAt(i, matrix.makeTranslation(corner.x, BLOCK_HEIGHT + 8.4, corner.z));
      const bar =
        axis === 'ns'
          ? toWorld({ x: node.x + dx * 6, y: node.y + dy * 21 }, 0.15)
          : toWorld({ x: node.x + dx * 21, y: node.y + dy * 6 }, 0.15);
      stopBars.setMatrixAt(
        i,
        matrix.makeRotationY(axis === 'ns' ? 0 : Math.PI / 2).setPosition(bar),
      );
      signalLamps.setColorAt(i, SIGNAL_UNKNOWN);
      stopBars.setColorAt(i, SIGNAL_UNKNOWN);
    }
  }
  scene.add(signalLamps, signalPoles, stopBars);

  // ─────────────────────────── 商户、客流、企业与社区的标识 ───────────────────────────

  // 商户系统：屋顶边缘的招牌
  const signMaterial = new THREE.MeshStandardMaterial({
    color: SOURCE_COLOR.commerce,
    emissive: SOURCE_COLOR.commerce,
    roughness: 0.5,
    transparent: true,
  });
  const signs = makeInstanced(new THREE.BoxGeometry(1, 2.6, 1.2), signMaterial, shops.length);
  // 客流传感器：门前的计数器
  const sensorMaterial = new THREE.MeshBasicMaterial({ transparent: true });
  const sensors = makeInstanced(
    new THREE.CylinderGeometry(1.5, 1.5, 0.7, 16),
    sensorMaterial,
    shops.length,
  );
  shops.forEach((shop, i) => {
    const f = buildingOf(shop.buildingId).footprint;
    const p = toWorld({ x: f.x + f.w / 2, y: f.y - 3.5 }, BLOCK_HEIGHT + 0.4);
    sensors.setMatrixAt(i, matrix.makeTranslation(p.x, p.y, p.z));
  });
  scene.add(signs, sensors);

  // 企业与门禁：办公楼周围的轮廓，亮度表示在岗人数
  const offices = companies
    .filter((company) => company.buildingId)
    .map((company) => {
      const building = buildingOf(company.buildingId);
      const center = toWorld(rectCenter(building.footprint), BLOCK_HEIGHT + 0.5);
      const line = stage.makeLine(
        rectOutline(building.footprint.w / 2 + 5, building.footprint.h / 2 + 5).map((p) =>
          p.add(center),
        ),
        SOURCE_COLOR.hr,
        2.6,
        0.9,
      );
      scene.add(line);
      let peak = 1;
      for (let h = 6; h < 24; h++) peak = Math.max(peak, presence(company.id, at(0, h, 30)));
      return { company, line, peak };
    });

  // 社区应用：活动进行时，会场周围的光环
  const eventMarks = events.map((event) => {
    const atPark = event.venue.kind === 'park';
    const at = atPark ? park.lake.center : centerOf(event.venue.id);
    const ring = flatRing(0.9, 1, SOURCE_COLOR.community, 0);
    ring.position.copy(toWorld(at, BLOCK_HEIGHT + 0.6));
    if (atPark) ring.scale.set(park.lake.rx + 30, park.lake.ry + 30, 1);
    else {
      const f = buildingOf(event.venue.id).footprint;
      ring.scale.setScalar(Math.max(f.w, f.h) / 2 + 14);
    }
    scene.add(ring);
    const roof = atPark ? BLOCK_HEIGHT : roofOf(buildingOf(event.venue.id));
    const pin = stage.addPin(
      `<b>${escapeHtml(term(event.title))}</b><span>${tr(`${event.attendees.length} 人报名`, `${event.attendees.length} signed up`)}</span>`,
      toWorld(at, roof + 16),
      'pin-event',
      'city',
      false,
    );
    return { event, ring, pin };
  });

  // ─────────────────────────── 温湿度传感器（物联网平台）与气象站 ───────────────────────────

  const POLE_HEIGHT: Record<string, number> = { 路灯杆: 9, 屋顶: 4, 公园: 3.5 };
  const envPoleMaterial = new THREE.MeshStandardMaterial({
    color: 0x8a949c,
    roughness: 0.5,
    transparent: true,
  });
  const envHeadMaterial = new THREE.MeshBasicMaterial({ transparent: true });
  const envPoles = makeInstanced(
    new THREE.CylinderGeometry(0.5, 0.5, 1, 6).translate(0, 0.5, 0),
    envPoleMaterial,
    ENV_SENSORS.length,
  );
  const envHeads = makeInstanced(
    new THREE.SphereGeometry(3, 16, 12),
    envHeadMaterial,
    ENV_SENSORS.length,
  );
  scene.add(envPoles, envHeads);
  /** 各传感器探头的当前位置（世界坐标），供标注与分层视图使用。 */
  const sensorHeads = new Map(ENV_SENSORS.map((sensor) => [sensor.id, new THREE.Vector3()]));
  const sensorBase = (sensor: (typeof ENV_SENSORS)[number]) =>
    sensor.buildingId ? roofOf(buildingOf(sensor.buildingId)) : BLOCK_HEIGHT;
  let readings = new Map<string, ReturnType<typeof readingAt>>();
  let readingMinute = Number.NaN;

  // 官方气象站：白色桅杆、百叶箱与风杯
  const stationMaterial = new THREE.MeshStandardMaterial({
    color: 0xf2f4f5,
    roughness: 0.5,
    transparent: true,
  });
  const stationGroup = new THREE.Group();
  stationGroup.position.copy(toWorld(STATION.at, BLOCK_HEIGHT));
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, 24, 8), stationMaterial);
  mast.position.y = 12;
  const shelter = new THREE.Mesh(new THREE.BoxGeometry(3.2, 3.2, 3.2), stationMaterial);
  shelter.position.y = 6;
  const cups = new THREE.Group();
  cups.position.y = 24.5;
  for (const angle of [0, Math.PI / 2]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(7, 0.3, 0.3), stationMaterial);
    arm.rotation.y = angle;
    cups.add(arm);
  }
  stationGroup.add(mast, shelter, cups);
  mast.castShadow = shelter.castShadow = true;
  scene.add(stationGroup);
  const stationPin = stage.addPin(
    `<b>${tr('气象站', 'Weather station')}</b><span>${escapeHtml(STATION.id)}</span>`,
    toWorld(STATION.at, BLOCK_HEIGHT + 34),
    'pin-weather',
    'city',
  );

  // 热力图：由传感器读数插值的地面温度场，只在热岛查询时显示
  const HEAT_W = 96;
  const HEAT_H = 72;
  const heatCanvas = document.createElement('canvas');
  heatCanvas.width = HEAT_W;
  heatCanvas.height = HEAT_H;
  const heatContext = heatCanvas.getContext('2d')!;
  const heatImage = heatContext.createImageData(HEAT_W, HEAT_H);
  const heatTexture = new THREE.CanvasTexture(heatCanvas);
  heatTexture.colorSpace = THREE.SRGBColorSpace;
  const heatMaterial = new THREE.MeshBasicMaterial({
    map: heatTexture,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const heatPlane = new THREE.Mesh(new THREE.PlaneGeometry(CITY.width, CITY.height), heatMaterial);
  heatPlane.rotation.x = -Math.PI / 2;
  heatPlane.position.y = BLOCK_HEIGHT + 0.9;
  heatPlane.renderOrder = 2;
  heatPlane.visible = false;
  scene.add(heatPlane);
  let heatOn = false;
  let heatMinute = Number.NaN;
  const HOT = new THREE.Color('#ff5a2e');
  const COOL = new THREE.Color('#3f8fff');

  /** 反距离加权插值：相对基准（气象站或传感器中位数）偏热为橙红，偏凉为蓝。 */
  const drawHeat = () => {
    const points = ENV_SENSORS.flatMap((sensor) => {
      const reading = readings.get(sensor.id);
      return reading ? [{ x: sensor.at.x, y: sensor.at.y, v: reading.temperature }] : [];
    });
    if (!points.length) return;
    const sorted = points.map((p) => p.v).sort((a, b) => a - b);
    const reference =
      fade.weather > 0.5 ? observationAt(simT).temperature : sorted[sorted.length >> 1];
    const data = heatImage.data;
    for (let j = 0; j < HEAT_H; j++) {
      const y = CITY.height - ((j + 0.5) / HEAT_H) * CITY.height;
      for (let i = 0; i < HEAT_W; i++) {
        const x = ((i + 0.5) / HEAT_W) * CITY.width;
        let sum = 0;
        let weight = 0;
        for (const p of points) {
          const w = 1 / ((p.x - x) ** 2 + (p.y - y) ** 2 + 900);
          sum += w * p.v;
          weight += w;
        }
        const diff = sum / weight - reference;
        const tint = diff >= 0 ? HOT : COOL;
        const alpha =
          diff >= 0 ? Math.min(0.62, (diff / 3.5) * 0.62) : Math.min(0.5, (-diff / 2) * 0.5);
        const o = (j * HEAT_W + i) * 4;
        data[o] = tint.r * 255;
        data[o + 1] = tint.g * 255;
        data[o + 2] = tint.b * 255;
        data[o + 3] = alpha * 255;
      }
    }
    heatContext.putImageData(heatImage, 0, 0);
    heatTexture.needsUpdate = true;
  };

  // ─────────────────────────── 车辆（交通时序） ───────────────────────────

  const carGeometry = mergeGeometries([
    new THREE.BoxGeometry(7.2, 2, 3.4).translate(0, 1.4, 0),
    new THREE.BoxGeometry(3.6, 1.4, 3).translate(-0.5, 3.1, 0),
  ]);
  const busGeometry = mergeGeometries([
    new THREE.BoxGeometry(13, 3.6, 3.8).translate(0, 2.3, 0),
    new THREE.BoxGeometry(12, 0.5, 3.4).translate(0, 4.35, 0),
  ]);
  // 配送车：车头在前，后面是厢体
  const vanGeometry = mergeGeometries([
    new THREE.BoxGeometry(5.4, 3.4, 3.6).translate(-1, 2.1, 0),
    new THREE.BoxGeometry(2.4, 2.3, 3.4).translate(2.7, 1.55, 0),
  ]);
  const vehicleMaterial = new THREE.MeshStandardMaterial({
    roughness: 0.42,
    metalness: 0.3,
    transparent: true,
  });
  const carList = vehicles.filter((v) => v.kind === 'car' || v.kind === 'taxi');
  const vanList = vehicles.filter((v) => v.kind === 'van');
  const busList = vehicles.filter((v) => v.kind === 'bus');
  const cars = makeInstanced(carGeometry, vehicleMaterial, carList.length);
  const vans = makeInstanced(vanGeometry, vehicleMaterial, vanList.length);
  const buses = makeInstanced(busGeometry, vehicleMaterial, busList.length);
  cars.castShadow = vans.castShadow = buses.castShadow = true;
  const lightGeometry = new THREE.BoxGeometry(0.6, 0.8, 3);
  const headMaterial = new THREE.MeshBasicMaterial({ transparent: true });
  const tailMaterial = new THREE.MeshBasicMaterial({ transparent: true });
  const headLights = makeInstanced(lightGeometry, headMaterial, vehicles.length);
  const tailLights = makeInstanced(lightGeometry, tailMaterial, vehicles.length);
  scene.add(cars, vans, buses, headLights, tailLights);

  interface VehicleView {
    vehicle: Vehicle;
    mesh: THREE.InstancedMesh;
    index: number;
    slot: number;
    half: number;
    base: THREE.Color;
    position: THREE.Vector3;
    direction: THREE.Vector3;
    active: boolean;
    stretch: number;
  }
  const vehicleViews: VehicleView[] = vehicles.map((vehicle, slot) => ({
    vehicle,
    mesh: vehicle.kind === 'bus' ? buses : vehicle.kind === 'van' ? vans : cars,
    index:
      vehicle.kind === 'bus'
        ? busList.indexOf(vehicle)
        : vehicle.kind === 'van'
          ? vanList.indexOf(vehicle)
          : carList.indexOf(vehicle),
    slot,
    half: vehicle.kind === 'bus' ? 6.5 : vehicle.kind === 'van' ? 3.8 : 3.6,
    base: new THREE.Color(vehicle.color),
    position: new THREE.Vector3(),
    direction: new THREE.Vector3(1, 0, 0),
    active: false,
    stretch: 0,
  }));
  const vehicleViewById = new Map(vehicleViews.map((v) => [v.vehicle.id, v]));
  let states = new Map<string, VehicleState>();
  let statesAtT = Number.NaN;

  // ─────────────────────────── 行人（模拟实况） ───────────────────────────
  // 街上的每个人都是一个实体：步行、候车、散步。行人不属于任何数据源，始终显示。

  const PEDESTRIANS = 1600;
  const pedestrianMaterial = new THREE.MeshStandardMaterial({ roughness: 0.8 });
  const pedestrianMesh = makeInstanced(
    new THREE.CapsuleGeometry(0.85, 1.9, 2, 6).translate(0, 1.8, 0),
    pedestrianMaterial,
    PEDESTRIANS,
  );
  const umbrellaMaterial = new THREE.MeshStandardMaterial({
    roughness: 0.6,
    side: THREE.DoubleSide,
  });
  const umbrellas = makeInstanced(
    new THREE.ConeGeometry(2.4, 1, 10, 1, true).translate(0, 4.7, 0),
    umbrellaMaterial,
    PEDESTRIANS,
  );
  pedestrianMesh.castShadow = true;
  scene.add(pedestrianMesh, umbrellas);

  interface Traits {
    color: THREE.Color;
    umbrellaColor: THREE.Color;
    /** 在人行道上相对路线的固定偏移，避免同路的人重叠。 */
    dx: number;
    dy: number;
    umbrella: number;
  }
  const traits = new Map<string, Traits>();
  const traitsOf = (id: string): Traits => {
    let entry = traits.get(id);
    if (!entry) {
      let h = 2166136261;
      for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
      const random = seededRandom(h >>> 0);
      const angle = random() * Math.PI * 2;
      const radius = Math.sqrt(random());
      entry = {
        color: new THREE.Color(WALKER_COLORS[Math.floor(random() * WALKER_COLORS.length)]),
        umbrellaColor: new THREE.Color(
          UMBRELLA_COLORS[Math.floor(random() * UMBRELLA_COLORS.length)],
        ),
        dx: Math.cos(angle) * radius,
        dy: Math.sin(angle) * radius,
        umbrella: random(),
      };
      traits.set(id, entry);
    }
    return entry;
  };
  /** 地面高度：街区与公园高出路面，人行横道在路面上。 */
  const groundAt = (p: Point) => {
    const lx = p.x - Math.floor(p.x / GRID.width) * GRID.width;
    const ly = p.y - Math.floor(p.y / GRID.height) * GRID.height;
    const inset = GRID.street / 2;
    const onBlock =
      lx >= inset && lx <= GRID.width - inset && ly >= inset && ly <= GRID.height - inset;
    return onBlock || pointInPolygon(p, park.area) ? BLOCK_HEIGHT : 0.05;
  };
  /** 本帧画出的行人：实例序号对应的人与位置，供拾取使用。 */
  const shownPeople: { id: string; position: THREE.Vector3 }[] = [];
  let shownCount = 0;
  /** 明细视图中另有标识的具名人物，不再画成普通行人。 */
  const avatarShown = new Set<string>();

  // 人行横道：路面上的斑马线
  const stripeMatrices: THREE.Matrix4[] = [];
  for (const { a, b } of crosswalks) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (Math.abs(dx) > 0.5 && Math.abs(dy) > 0.5) continue;
    const length = Math.hypot(dx, dy);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const along = Math.abs(dx) > Math.abs(dy);
    for (let k = -GRID.street / 2 + 1.5; k <= GRID.street / 2 - 1.5; k += 2) {
      const p = { x: mid.x + (dx / length) * k, y: mid.y + (dy / length) * k };
      stripeMatrices.push(
        new THREE.Matrix4().compose(
          toWorld(p, 0.06),
          new THREE.Quaternion(),
          along ? new THREE.Vector3(1, 1, 4) : new THREE.Vector3(4, 1, 1),
        ),
      );
    }
  }
  const stripeMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    depthWrite: false,
  });
  const stripes = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 0.04, 1),
    stripeMaterial,
    stripeMatrices.length,
  );
  stripeMatrices.forEach((m, i) => stripes.setMatrixAt(i, m));
  stripes.renderOrder = 1;
  scene.add(stripes);

  // 公交站牌：站台上的立杆与站牌
  const stopSignMaterial = new THREE.MeshStandardMaterial({
    color: SOURCE_COLOR.mobility,
    emissive: SOURCE_COLOR.mobility,
    emissiveIntensity: 0.3,
    transparent: true,
  });
  const stopSigns = new THREE.Group();
  for (const stop of BUS_LOOP) {
    const p = platformOf(stop);
    const base = toWorld(p, BLOCK_HEIGHT);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 5, 6), poleMaterial);
    pole.position.copy(base).setY(BLOCK_HEIGHT + 2.5);
    const sign = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.4, 0.3), stopSignMaterial);
    sign.position.copy(base).setY(BLOCK_HEIGHT + 5.2);
    const shelter = new THREE.Mesh(new THREE.BoxGeometry(6, 0.3, 2.4), stopSignMaterial);
    shelter.position.copy(base).setY(BLOCK_HEIGHT + 3.4);
    // 顺着街道方向
    const from = nodeById.get(previousStop(stop))!;
    const to = nodeById.get(stop)!;
    shelter.rotation.y = sign.rotation.y = Math.atan2(to.y - from.y, to.x - from.x);
    stopSigns.add(pole, sign, shelter);
  }
  scene.add(stopSigns);

  // ─────────────────────────── 具名人物（仅明细视图） ───────────────────────────

  const avatarBody = new THREE.CapsuleGeometry(1.5, 3.2, 3, 10).translate(0, 3.2, 0);
  stage.markShared(avatarBody);
  const avatars = personas
    .filter((person) => hasItinerary(person.id))
    .map((person) => {
      const tint = new THREE.Color(person.color);
      const body = new THREE.Mesh(
        avatarBody,
        new THREE.MeshStandardMaterial({ color: tint, emissive: tint, emissiveIntensity: 0.6 }),
      );
      const ring = flatRing(4.5, 6, tint, 0.9);
      scene.add(body, ring);
      const pin = stage.addPin('', new THREE.Vector3(), 'pin-persona', 'city', false);
      pin.element.style.setProperty('--c', person.color!);
      return { person, body, ring, pin, label: '' };
    });

  // 公交车上人数（出行服务的刷卡记录）
  const busPins = vehicles
    .filter((vehicle) => vehicle.kind === 'bus')
    .map((vehicle) => ({
      vehicle,
      pin: stage.addPin('', new THREE.Vector3(), 'pin-bus', 'city', false),
      text: '',
    }));

  // ─────────────────────────── 降雨（气象观测） ───────────────────────────

  const RAIN = 4200;
  const rainPositions = new Float32Array(RAIN * 6);
  const rainTips = new Float32Array(RAIN * 2);
  const rainRandom = seededRandom(3);
  for (let i = 0; i < RAIN; i++) {
    const x = rainRandom() * 1600 - 800;
    const y = rainRandom() * 420;
    const z = rainRandom() * 1400 - 700;
    rainPositions.set([x, y, z, x, y, z], i * 6);
    rainTips.set([0, 1], i * 2);
  }
  const rainGeometry = new THREE.BufferGeometry();
  rainGeometry.setAttribute('position', new THREE.BufferAttribute(rainPositions, 3));
  rainGeometry.setAttribute('tip', new THREE.BufferAttribute(rainTips, 1));
  const rainMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uWind: { value: 0 },
      uOpacity: { value: 0 },
      uColor: { value: new THREE.Color() },
      uCenter: { value: new THREE.Vector3() },
    },
    // 雨丝在相机目标周围循环下落，不随相机移动而重新生成
    vertexShader: /* glsl */ `
      attribute float tip;
      uniform float uTime;
      uniform float uWind;
      uniform vec3 uCenter;
      varying float vTip;
      void main() {
        vec3 p = position;
        p.y = mod(position.y - uTime * 240.0, 420.0) + tip * 13.0;
        // 风越大，雨丝越斜
        p.x = uCenter.x + mod(position.x - uCenter.x + 800.0, 1600.0) - 800.0
            + (420.0 - p.y) * (0.04 + uWind * 0.03);
        p.z = uCenter.z + mod(position.z - uCenter.z + 700.0, 1400.0) - 700.0;
        vTip = tip;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vTip;
      void main() {
        gl_FragColor = vec4(uColor, uOpacity * (1.0 - 0.75 * vTip));
      }
    `,
    transparent: true,
    depthWrite: false,
  });
  const rain = new THREE.LineSegments(rainGeometry, rainMaterial);
  rain.frustumCulled = false;
  rain.visible = false;
  scene.add(rain);

  // ─────────────────────────── 查询结果的城市标注 ───────────────────────────

  interface Mark {
    highlight: Highlight;
    signature: string;
    group: THREE.Group;
    pins: Pin[];
    /** 该标注所有标签共用的类名，用于移除。 */
    pinClass: string;
    born: number;
    pulse?: THREE.Mesh;
    halo?: THREE.Mesh;
    trail?: Line2;
    bars?: { today: THREE.Mesh; baseline: THREE.Mesh; shop: Shop; target: [number, number] };
  }
  const markRoot = new THREE.Group();
  scene.add(markRoot);
  const marks = new Map<string, Mark>();
  let pinSerial = 0;
  /** 客流柱的最大高度（米）：每家店今天与昨日对比，按两者中较大值归一。 */
  const BAR_HEIGHT = 36;
  /** 被查询结果强调的建筑及颜色。 */
  const emphasis = new Map<number, { color: THREE.Color; amount: number }>();
  const markedVehicles = new Set<string>();
  const markedPersonas = new Set<string>();

  const markKey = (h: Highlight) => {
    switch (h.type) {
      case 'node':
      case 'vehicle':
      case 'edge':
      case 'shop':
      case 'persona':
        return `${h.type}:${h.id}`;
      case 'place':
        return `place:${h.at.x},${h.at.y}`;
      case 'buffer':
        return `buffer:${h.center.x},${h.center.y}`;
      case 'sensor':
        return `sensor:${h.id}`;
      case 'station':
      case 'heat':
        return h.type;
    }
  };
  const markSignature = (h: Highlight) => {
    switch (h.type) {
      case 'node':
      case 'place':
        return h.label;
      case 'vehicle':
        return `${Boolean(h.trail)}`;
      case 'edge':
        return `${Math.round(h.kmh)}|${h.hit}`;
      case 'shop':
        return `${h.hit}`;
      case 'persona':
        return `${h.path.length}`;
      case 'buffer':
        return `${h.radius}`;
      case 'sensor':
        return `${h.hit}`;
      case 'station':
      case 'heat':
        return '';
    }
  };
  const addMarkPin = (mark: Mark, html: string, anchor: THREE.Vector3, className: string) => {
    const pin = stage.addPin(html, anchor, `${className} ${mark.pinClass}`, 'city');
    mark.pins.push(pin);
    return pin;
  };

  const buildMark = (h: Highlight, born: number): Mark => {
    const mark: Mark = {
      highlight: h,
      signature: markSignature(h),
      group: new THREE.Group(),
      pins: [],
      pinClass: `pin-mark-${++pinSerial}`,
      born,
    };
    switch (h.type) {
      case 'node': {
        const node = nodeById.get(h.id)!;
        const p = toWorld(node, 0.4);
        const ring = flatRing(14, 17.5, ACCENT, 0.95);
        const pulse = flatRing(16, 17.5, ACCENT, 0.6);
        ring.position.copy(p);
        pulse.position.copy(p);
        mark.group.add(ring, pulse);
        mark.pulse = pulse;
        addMarkPin(mark, labelHtml(h.label), p.clone().setY(24), 'pin-hit');
        break;
      }
      case 'vehicle': {
        const halo = flatRing(6.5, 8, ACCENT, 0.95);
        mark.group.add(halo);
        mark.halo = halo;
        if (h.trail && h.trail.length > 1) {
          mark.trail = stage.makeLine(
            h.trail.map((p) => toWorld(p, 1.2)),
            ACCENT,
            3,
            0.85,
          );
          mark.group.add(mark.trail);
        }
        if (h.label) addMarkPin(mark, labelHtml(h.label), new THREE.Vector3(), 'pin-hit');
        markedVehicles.add(h.id);
        break;
      }
      case 'edge': {
        const edge = edgeById.get(h.id)!;
        const a = nodeById.get(edge.a)!;
        const b = nodeById.get(edge.b)!;
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        const ux = (b.x - a.x) / length;
        const uy = (b.y - a.y) / length;
        const line = stage.makeLine(
          [
            toWorld({ x: a.x + ux * 13, y: a.y + uy * 13 }, 0.6),
            toWorld({ x: b.x - ux * 13, y: b.y - uy * 13 }, 0.6),
          ],
          speedColor(h.kmh),
          h.hit ? 7 : 3.5,
          h.hit ? 0.95 : 0.6,
        );
        mark.group.add(line);
        if (h.hit) {
          addMarkPin(
            mark,
            `<b>${escapeHtml(h.label)}</b>`,
            toWorld({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, 16),
            'pin-hit pin-speed',
          );
        }
        break;
      }
      case 'shop': {
        const shop = shopById.get(h.id)!;
        const bar = (tint: THREE.ColorRepresentation, opacity: number) => {
          const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(5, 1, 5).translate(0, 0.5, 0),
            new THREE.MeshStandardMaterial({
              color: tint,
              emissive: tint,
              emissiveIntensity: 0.35,
              transparent: true,
              opacity,
            }),
          );
          mesh.scale.y = 0.001;
          mark.group.add(mesh);
          return mesh;
        };
        mark.bars = {
          today: bar(h.hit ? ACCENT : 0xb9c4cc, 0.95),
          baseline: bar(0x6c7680, 0.7),
          shop,
          target: [h.today, h.baseline],
        };
        addMarkPin(mark, labelHtml(h.label), new THREE.Vector3(), h.hit ? 'pin-hit' : 'pin-shop');
        if (h.hit) emphasis.set(shop.buildingId, { color: ACCENT, amount: 0.4 });
        break;
      }
      case 'persona': {
        if (h.path.length > 1) {
          const person = personById.get(h.id)!;
          mark.group.add(
            stage.makeLine(
              h.path.map((p) => toWorld(p, 0.8)),
              person.color ?? ACCENT,
              2.6,
              0.85,
              true,
            ),
          );
        }
        markedPersonas.add(h.id);
        break;
      }
      case 'place': {
        const building = buildingAt(h.at);
        const anchor = toWorld(h.at, building ? roofOf(building) + 14 : 20);
        addMarkPin(mark, labelHtml(h.label), anchor, 'pin-place');
        if (building) emphasis.set(building.id, { color: SOURCE_COLOR.hr, amount: 0.45 });
        break;
      }
      case 'buffer': {
        const p = toWorld(h.center, BLOCK_HEIGHT + 0.6);
        const fill = new THREE.Mesh(
          new THREE.CircleGeometry(h.radius, 96),
          new THREE.MeshBasicMaterial({
            color: ACCENT,
            transparent: true,
            opacity: 0.1,
            depthWrite: false,
          }),
        );
        fill.rotation.x = -Math.PI / 2;
        fill.renderOrder = 2;
        const edge = flatRing(h.radius - 2, h.radius, ACCENT, 0.9);
        const pulse = flatRing(h.radius - 1.2, h.radius, ACCENT, 0.6);
        for (const mesh of [fill, edge, pulse]) mesh.position.copy(p);
        mark.group.add(fill, edge, pulse);
        mark.pulse = pulse;
        break;
      }
      case 'sensor': {
        const sensor = sensorById.get(h.id)!;
        const ring = flatRing(6, 8, ACCENT, 0.95);
        const pulse = flatRing(7, 8, ACCENT, 0.6);
        const p = toWorld(sensor.at, sensorBase(sensor) + 0.4);
        ring.position.copy(p);
        pulse.position.copy(p);
        mark.group.add(ring, pulse);
        mark.pulse = pulse;
        addMarkPin(mark, labelHtml(h.label), new THREE.Vector3(), h.hit ? 'pin-hit' : 'pin-shop');
        break;
      }
      case 'station': {
        const ring = flatRing(9, 11, SOURCE_COLOR.weather, 0.9);
        ring.position.copy(toWorld(STATION.at, BLOCK_HEIGHT + 0.5));
        mark.group.add(ring);
        addMarkPin(mark, labelHtml(h.label), toWorld(STATION.at, BLOCK_HEIGHT + 36), 'pin-weather');
        break;
      }
      case 'heat':
        break;
    }
    markRoot.add(mark.group);
    return mark;
  };

  const removeMark = (key: string) => {
    const mark = marks.get(key)!;
    stage.disposeGroup(mark.group);
    mark.group.removeFromParent();
    stage.removePins(mark.pinClass);
    marks.delete(key);
  };

  const syncMarks = (highlights: Highlight[], fresh: boolean, now: number) => {
    emphasis.clear();
    markedVehicles.clear();
    markedPersonas.clear();
    const keep = new Set<string>();
    for (const h of highlights) {
      const key = markKey(h);
      keep.add(key);
      const existing = marks.get(key);
      if (existing && existing.signature === markSignature(h) && !fresh) {
        existing.highlight = h;
        if (h.type === 'vehicle') {
          markedVehicles.add(h.id);
          if (existing.trail && h.trail && h.trail.length > 1) {
            existing.trail.geometry.setPositions(
              h.trail.flatMap((p) => [p.x - CITY.width / 2, 1.2, CITY.height / 2 - p.y]),
            );
          }
        }
        if (h.type === 'shop' && existing.bars) {
          existing.bars.target = [h.today, h.baseline];
          if (h.hit) emphasis.set(existing.bars.shop.buildingId, { color: ACCENT, amount: 0.4 });
        }
        if (h.type === 'persona') markedPersonas.add(h.id);
        if (h.type === 'place') {
          const building = buildingAt(h.at);
          if (building) emphasis.set(building.id, { color: SOURCE_COLOR.hr, amount: 0.45 });
        }
        if ('label' in h && h.label && existing.pins[0]) {
          const html = h.type === 'edge' ? `<b>${escapeHtml(h.label)}</b>` : labelHtml(h.label);
          if (existing.pins[0].element.innerHTML !== html)
            existing.pins[0].element.innerHTML = html;
        }
        continue;
      }
      if (existing) removeMark(key);
      marks.set(key, buildMark(h, fresh ? now : now - 10000));
    }
    for (const key of [...marks.keys()]) if (!keep.has(key)) removeMark(key);
    heatOn = highlights.some((h) => h.type === 'heat');
    heatMinute = Number.NaN;
  };

  // ─────────────────────────── 分层视图 ───────────────────────────

  const layerRoot = new THREE.Group();
  scene.add(layerRoot);
  const planeMaterials: THREE.MeshBasicMaterial[] = [];
  const outlineLines: Line2[] = [];
  const makePlane = (y: number, halfW: number, halfD: number, tint: THREE.Color) => {
    const material = new THREE.MeshBasicMaterial({
      color: tint,
      transparent: true,
      opacity: 0.05,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    planeMaterials.push(material);
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(halfW * 2, halfD * 2), material);
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = y;
    plane.renderOrder = 1;
    const outline = stage.makeLine(
      rectOutline(halfW, halfD).map((p) => p.setY(y)),
      tint,
      1.4,
      0.55,
    );
    outlineLines.push(outline);
    layerRoot.add(plane, outline);
  };
  makePlane(LAYER.mapping, HALF_W, HALF_D, ACCENT);
  makePlane(LAYER.graph, HALF_W, HALF_D, new THREE.Color(0xffffff));
  makePlane(LAYER.ontology, ONTOLOGY_HALF.w, ONTOLOGY_HALF.d, AMBER);

  const layerLabel = (title: string, note: string) => `<b>${title}</b><span>${note}</span>`;
  stage.addPin(
    layerLabel(
      tr('本体', 'Ontology'),
      tr('TBox：类与类之间的关系', 'TBox: relations between classes'),
    ),
    new THREE.Vector3(-ONTOLOGY_HALF.w, LAYER.ontology, ONTOLOGY_HALF.d),
    'pin-layer pin-layer-onto',
    'layers',
  ).element.dataset.layer = 'ontology';
  stage.addPin(
    layerLabel(
      tr('虚拟知识图谱', 'Virtual knowledge graph'),
      tr('同一 IRI 的记录汇合为一个实体', 'Records with the same IRI merge into one entity'),
    ),
    new THREE.Vector3(-HALF_W, LAYER.graph, HALF_D),
    'pin-layer pin-layer-graph',
    'layers',
  ).element.dataset.layer = 'graph';
  stage.addPin(
    layerLabel(
      tr('映射', 'Mappings'),
      tr('每个数据源各有一组映射', 'One set of mappings per source'),
    ),
    new THREE.Vector3(-HALF_W, LAYER.mapping, HALF_D),
    'pin-layer pin-layer-map',
    'layers',
  ).element.dataset.layer = 'mapping';
  stage.addPin(
    layerLabel(
      tr('数据源', 'Data sources'),
      tr('八个独立系统，查询时访问', 'Eight independent systems, accessed at query time'),
    ),
    new THREE.Vector3(-HALF_W, 0, HALF_D),
    'pin-layer pin-layer-data',
    'layers',
  ).element.dataset.layer = 'data';

  // 数据源：街区前方一排数据库
  interface Pillar {
    source: DataSource;
    material: THREE.MeshStandardMaterial;
    top: THREE.Vector3;
    pin: Pin;
  }
  const pillars = new Map<SourceId, Pillar>();
  /** 分层视图中可点击的网格：数据源与本体类。 */
  const infoMeshes: THREE.Object3D[] = [];
  const discGeometry = new THREE.CylinderGeometry(16, 16, 9, 40);
  stage.markShared(discGeometry);
  SOURCES.forEach((source, i) => {
    const base = new THREE.Vector3((i - 3) * 165, 0, HALF_D + 70);
    const material = new THREE.MeshStandardMaterial({
      color: SOURCE_COLOR[source.id],
      emissive: SOURCE_COLOR[source.id],
      emissiveIntensity: 0.35,
      roughness: 0.45,
      transparent: true,
    });
    for (let k = 0; k < 3; k++) {
      const disc = new THREE.Mesh(discGeometry, material);
      disc.position.copy(base).setY(6 + k * 12);
      disc.userData.source = source.id;
      infoMeshes.push(disc);
      layerRoot.add(disc);
    }
    const pin = stage.addPin(
      sourcePin(source, true),
      base.clone().setZ(base.z + 20),
      'pin-source',
      'layers',
    );
    pin.element.style.setProperty('--source', source.color);
    pin.element.dataset.source = source.id;
    pillars.set(source.id, { source, material, top: base.clone().setY(PILLAR_TOP), pin });
  });

  const syncPillars = () => {
    const night = mode === 'night';
    for (const [id, pillar] of pillars) {
      const on = enabled.has(id);
      pillar.material.color.copy(on ? SOURCE_COLOR[id] : color.set(0x5d666f));
      pillar.material.emissive.copy(on ? SOURCE_COLOR[id] : color.set(0x000000));
      pillar.material.emissiveIntensity = on ? (night ? 0.55 : 0.25) : 0;
      pillar.material.opacity = on ? 1 : 0.4;
      pillar.pin.element.classList.toggle('is-off', !on);
      pillar.pin.element.innerHTML = sourcePin(pillar.source, on);
    }
  };

  // 本体类节点（随查询变化）
  interface ClassNode {
    mesh: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial>;
    position: THREE.Vector3;
  }
  const classGroup = new THREE.Group();
  layerRoot.add(classGroup);
  const classNodes = new Map<string, ClassNode>();
  let classSignature = '';
  /** 返回类节点是否发生变化。 */
  const syncClasses = (classes: string[], subclass: [string, string][]) => {
    const signature = `${classes.join(',')}|${subclass.map((pair) => pair.join('<')).join(',')}`;
    if (signature === classSignature) return false;
    classSignature = signature;
    stage.disposeGroup(classGroup);
    stage.removePins('pin-class');
    classNodes.clear();
    const parents = new Set(subclass.map(([, parent]) => parent));
    const rows = [
      { list: classes.filter((c) => !parents.has(c)), z: 80 },
      { list: classes.filter((c) => parents.has(c)), z: -90 },
    ];
    for (const { list, z } of rows) {
      const spacing = Math.min(210, 880 / Math.max(1, list.length));
      list.forEach((name, i) => {
        const position = new THREE.Vector3(
          (i - (list.length - 1) / 2) * spacing,
          LAYER.ontology,
          z,
        );
        const mesh = new THREE.Mesh(
          new THREE.CylinderGeometry(9, 9, 3, 32),
          new THREE.MeshStandardMaterial({
            color: AMBER,
            emissive: AMBER,
            emissiveIntensity: mode === 'night' ? 1.2 : 0.6,
            roughness: 0.5,
          }),
        );
        mesh.position.copy(position);
        mesh.userData.cls = name;
        classGroup.add(mesh);
        stage.addPin(
          escapeHtml(name),
          position.clone().setY(LAYER.ontology + 14),
          'pin-class',
          'layers',
        ).element.dataset.cls = name;
        classNodes.set(name, { mesh, position });
      });
    }
    for (const [child, parent] of subclass) {
      const a = classNodes.get(child);
      const b = classNodes.get(parent);
      if (a && b) classGroup.add(stage.makeLine([a.position, b.position], AMBER, 2.2, 0.9));
    }
    return true;
  };

  // 图谱中的实体：节点、映射门、到各数据源的连线、到本体类的 rdf:type 连线
  interface GraphNode {
    entity: FusionEntity;
    group: THREE.Group;
    mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
    halo: THREE.Mesh | null;
    gate: THREE.Mesh;
    drop: Line2;
    links: { source: SourceId; line: Line2; next: number }[];
    typeLine: Line2 | null;
    pinClass: string | null;
    pin: Pin | null;
    position: THREE.Vector3;
    target: THREE.Vector3;
    gatePosition: THREE.Vector3;
    born: number;
    visible: boolean;
  }
  const graphRoot = new THREE.Group();
  layerRoot.add(graphRoot);
  const graphNodes = new Map<string, GraphNode>();
  const graphSignatures = new Map<string, string>();
  const nodeGeometry = new THREE.SphereGeometry(6, 20, 14);
  const gateGeometry = new THREE.RingGeometry(4.5, 7, 28);
  const haloGeometry = new THREE.RingGeometry(9.5, 11, 40);
  for (const geometry of [nodeGeometry, gateGeometry, haloGeometry]) stage.markShared(geometry);
  let graphSerial = 0;

  const entityPoint = (entity: FusionEntity): Point | null => {
    switch (entity.kind) {
      case 'intersection':
        return nodeById.get(entity.ref as number)!;
      case 'vehicle': {
        const v = vehicleViewById.get(entity.ref as string);
        return v?.active ? planOf(v.position) : null;
      }
      case 'station':
        return city.stations.find((s) => s.id === entity.ref)!.location;
      case 'shop':
        return centerOf(shopById.get(entity.ref as number)!.buildingId);
      case 'weather':
        return STATION.at;
      case 'sensor':
        return sensorById.get(entity.ref as string)!.at;
      case 'road': {
        const edge = edgeById.get(entity.ref as number)!;
        const a = nodeById.get(edge.a)!;
        const b = nodeById.get(edge.b)!;
        return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      }
      case 'person': {
        const state = personAt(entity.ref as string, simT);
        if (state) return state;
        const person = personById.get(entity.ref as string);
        return person?.homeId ? centerOf(person.homeId) : null;
      }
      case 'company': {
        const company = companyById.get(entity.ref as number)!;
        return company.buildingId ? centerOf(company.buildingId) : { x: 80, y: 120 };
      }
      case 'event': {
        const event = events.find((e) => e.id === entity.ref)!;
        return event.venue.kind === 'park' ? park.lake.center : centerOf(event.venue.id);
      }
      case 'building':
        return centerOf(entity.ref as number);
      case 'order': {
        const trip = tripsOf(dayOf(simT)).find((t) => t.id === entity.ref);
        return trip ? trip.from : null;
      }
      case 'stop':
        return nodeById.get(entity.ref as number)!;
    }
  };

  // 类由到本体层的 rdf:type 连线表示，标签只写名称与数据源
  const entityPinHtml = (entity: FusionEntity) =>
    `<b>${escapeHtml(entity.label)}</b>${sourceDots(entity.sources)}`;

  const createGraphNode = (entity: FusionEntity, born: number, labeled: boolean): GraphNode => {
    const palette = PALETTE[mode];
    const group = new THREE.Group();
    const tint = entity.hit ? ACCENT : new THREE.Color(palette.neutral);
    const mesh = new THREE.Mesh(
      nodeGeometry,
      new THREE.MeshStandardMaterial({
        color: tint,
        emissive: tint,
        emissiveIntensity: entity.hit ? (mode === 'night' ? 1.3 : 0.5) : 0.3,
      }),
    );
    group.add(mesh);
    let halo: THREE.Mesh | null = null;
    if (entity.sources.length > 1) {
      halo = new THREE.Mesh(
        haloGeometry,
        new THREE.MeshBasicMaterial({
          color: palette.ink,
          transparent: true,
          opacity: 0.75,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      halo.rotation.x = -Math.PI / 2;
      group.add(halo);
    }
    const gate = new THREE.Mesh(
      gateGeometry,
      new THREE.MeshBasicMaterial({
        color: ACCENT,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    gate.rotation.x = -Math.PI / 2;
    group.add(gate);
    const origin = new THREE.Vector3();
    const drop = stage.makeLine([origin, origin], palette.ink, 1.3, 0.5);
    group.add(drop);
    const links = entity.sources.map((source, i) => {
      const line = stage.makeLine([origin, origin], SOURCE_COLOR[source], 1.8, 0.85);
      group.add(line);
      return { source, line, next: born + 600 + i * 260 + (graphSerial % 7) * 180 };
    });
    let typeLine: Line2 | null = null;
    if (classNodes.has(entity.cls)) {
      typeLine = stage.makeLine([origin, origin], AMBER, 1.1, 0.55);
      group.add(typeLine);
    }
    let pin: Pin | null = null;
    let pinClass: string | null = null;
    if (labeled) {
      pinClass = `pin-gn-${++graphSerial}`;
      const extra = entity.key === 'sel' ? ' pin-selected-graph' : '';
      pin = stage.addPin(
        entityPinHtml(entity),
        new THREE.Vector3(),
        `pin-entity ${pinClass}${extra}`,
        'layers',
      );
    } else {
      graphSerial++;
    }
    graphRoot.add(group);
    return {
      entity,
      group,
      mesh,
      halo,
      gate,
      drop,
      links,
      typeLine,
      pinClass,
      pin,
      position: new THREE.Vector3(Number.NaN, LAYER.graph, 0),
      target: new THREE.Vector3(0, LAYER.graph, 0),
      gatePosition: new THREE.Vector3(),
      born,
      visible: false,
    };
  };

  const removeGraphNode = (key: string) => {
    const node = graphNodes.get(key)!;
    stage.disposeGroup(node.group);
    node.group.removeFromParent();
    if (node.pinClass) stage.removePins(node.pinClass);
    graphNodes.delete(key);
    graphSignatures.delete(key);
  };
  const clearGraph = () => {
    for (const key of [...graphNodes.keys()]) removeGraphNode(key);
  };

  /** 实体的签名：来源、类、命中状态或标签变化时重建节点。 */
  const entitySignature = (entity: FusionEntity, labeled: boolean) =>
    `${entity.sources.join(',')}|${entity.cls}|${entity.hit}|${entity.label}|${labeled}`;

  // 实体之间的关系
  interface RelationLine {
    relation: FusionRelation;
    line: Line2;
    pin: Pin | null;
    pinClass: string | null;
    points: THREE.Vector3[];
  }
  const relationRoot = new THREE.Group();
  layerRoot.add(relationRoot);
  const relationLines = new Map<string, RelationLine>();
  const CURVE_POINTS = 13;

  let currentEntities: FusionEntity[] = [];
  let currentRelations: FusionRelation[] = [];
  let selectionEntity: FusionEntity | null = null;

  const syncGraph = (fresh: boolean, now: number) => {
    const list = selectionEntity ? [...currentEntities, selectionEntity] : currentEntities;
    // 车辆在路口排队时彼此很近，只在结果以车辆为主（如轨迹查询）时标注车牌
    const vehicleCount = list.filter((e) => e.kind === 'vehicle').length;
    const crowded = vehicleCount > 6 || list.some((e) => e.kind === 'intersection');
    const keep = new Set<string>();
    for (const entity of list) {
      const labeled = entity.kind !== 'vehicle' || !crowded || entity.key === 'sel';
      const signature = entitySignature(entity, labeled);
      keep.add(entity.key);
      const existing = graphNodes.get(entity.key);
      if (existing && graphSignatures.get(entity.key) === signature && !fresh) {
        existing.entity = entity;
        continue;
      }
      if (existing) removeGraphNode(entity.key);
      graphNodes.set(entity.key, createGraphNode(entity, fresh ? now : now - 10000, labeled));
      graphSignatures.set(entity.key, signature);
    }
    for (const key of [...graphNodes.keys()]) if (!keep.has(key)) removeGraphNode(key);

    const relationKeep = new Set<string>();
    const labelRelations = currentRelations.length <= 3;
    for (const relation of currentRelations) {
      const key = `${relation.from}|${relation.to}|${relation.label}`;
      relationKeep.add(key);
      if (relationLines.has(key)) continue;
      const points = Array.from({ length: CURVE_POINTS }, () => new THREE.Vector3());
      const line = stage.makeLine(points, PALETTE[mode].ink, 1.4, 0.6);
      relationRoot.add(line);
      let pin: Pin | null = null;
      let pinClass: string | null = null;
      if (labelRelations) {
        pinClass = `pin-rel-${++graphSerial}`;
        pin = stage.addPin(
          `<code>:${escapeHtml(relation.label)}</code>`,
          new THREE.Vector3(),
          `pin-relation ${pinClass}`,
          'layers',
        );
      }
      relationLines.set(key, { relation, line, pin, pinClass, points });
    }
    for (const [key, entry] of relationLines) {
      if (relationKeep.has(key)) continue;
      entry.line.geometry.dispose();
      entry.line.material.dispose();
      entry.line.removeFromParent();
      if (entry.pinClass) stage.removePins(entry.pinClass);
      relationLines.delete(key);
    }
  };

  // 数据流动：从数据源沿映射流向实体的光点
  const PARTICLES = 240;
  const particleMaterial = new THREE.MeshBasicMaterial();
  const particleMesh = makeInstanced(
    new THREE.SphereGeometry(2.4, 10, 8),
    particleMaterial,
    PARTICLES,
  );
  layerRoot.add(particleMesh);
  interface Particle {
    node: string;
    source: SourceId;
    start: number;
    duration: number;
  }
  const particles: Particle[] = [];

  const updateGraph = (now: number, dt: number) => {
    const mix = Math.max(stage.mix, 0.05);
    const inverse = 1 / mix;

    // 目标位置：实体所在地的正上方；相互靠得太近时略微分开
    const nodes = [...graphNodes.values()];
    for (const node of nodes) {
      const point = entityPoint(node.entity);
      node.visible = point !== null;
      if (point) node.target.copy(toWorld(point, LAYER.graph));
    }
    // 分开后的节点仍须留在图谱层内；贴边的节点不再外移，由相邻节点继续向内让开
    const keepInside = (p: THREE.Vector3) => {
      p.x = Math.min(GRAPH_LIMIT.x, Math.max(-GRAPH_LIMIT.x, p.x));
      p.z = Math.min(GRAPH_LIMIT.z, Math.max(-GRAPH_LIMIT.z, p.z));
    };
    for (let pass = 0; pass < 10; pass++) {
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i].target;
          const b = nodes[j].target;
          let dx = b.x - a.x;
          let dz = b.z - a.z;
          // 带标签的节点主要在水平方向分开，避免标签重叠
          if (nodes[i].pin && nodes[j].pin) {
            if (Math.abs(dx) >= 180 || Math.abs(dz) >= 220) continue;
            const push = ((180 - Math.abs(dx)) / 2) * (dx < 0 ? -1 : 1);
            a.x -= push;
            b.x += push;
            keepInside(a);
            keepInside(b);
            continue;
          }
          let distance = Math.hypot(dx, dz);
          if (distance >= 26) continue;
          if (distance < 0.01) {
            dx = 1;
            dz = 0.4;
            distance = Math.hypot(dx, dz);
          }
          const push = (26 - distance) / 2 / distance;
          a.x -= dx * push;
          a.z -= dz * push;
          b.x += dx * push;
          b.z += dz * push;
          keepInside(a);
          keepInside(b);
        }
      }
    }

    const k = reduced ? 1 : damp(10, dt);
    for (const node of nodes) {
      if (Number.isNaN(node.position.x)) node.position.copy(node.target);
      else node.position.lerp(node.target, k);
      node.group.visible = node.visible;
      const appear = reduced ? 1 : easeOut(clamp01((now - node.born) / 600));
      const p = node.position;
      node.mesh.position.copy(p);
      const s = Math.max(appear, 0.001);
      node.mesh.scale.set(s, s * inverse, s);
      if (node.halo) {
        node.halo.position.copy(p);
        node.halo.scale.setScalar(s);
      }
      node.gatePosition.set(p.x, LAYER.mapping, p.z);
      node.gate.position.copy(node.gatePosition);
      const gateEnd = scratch.copy(p).lerp(node.gatePosition, appear);
      stage.setSegment(node.drop, p, gateEnd);
      for (const link of node.links) {
        const top = pillars.get(link.source)!.top;
        const grow = reduced ? 1 : easeOut(clamp01((now - node.born - 350) / 700));
        stage.setSegment(
          link.line,
          node.gatePosition,
          scratch.copy(node.gatePosition).lerp(top, grow),
        );
      }
      if (node.typeLine) {
        const cls = classNodes.get(node.entity.cls);
        if (cls)
          stage.setSegment(node.typeLine, cls.position, scratch.copy(cls.position).lerp(p, appear));
      }
      if (node.pin) {
        node.pin.anchor.set(p.x, LAYER.graph + 16, p.z);
        node.pin.shown = node.visible && appear > 0.6;
      }
    }

    for (const entry of relationLines.values()) {
      const a = graphNodes.get(entry.relation.from);
      const b = graphNodes.get(entry.relation.to);
      const shown = Boolean(a?.visible && b?.visible);
      entry.line.visible = shown;
      if (entry.pin) entry.pin.shown = shown;
      if (!a || !b || !shown) continue;
      const mid = scratch.copy(a.position).add(b.position).multiplyScalar(0.5);
      mid.y += 14 + a.position.distanceTo(b.position) * 0.08;
      entry.points.forEach((point, i) => {
        const t = i / (CURVE_POINTS - 1);
        const u = 1 - t;
        point
          .copy(a.position)
          .multiplyScalar(u * u)
          .addScaledVector(mid, 2 * u * t)
          .addScaledVector(b.position, t * t);
      });
      stage.setPath(entry.line, entry.points);
      if (entry.pin) entry.pin.anchor.copy(entry.points[(CURVE_POINTS - 1) / 2]);
    }

    // 光点：每条“数据源 → 实体”连线定期发出一个
    if (!reduced && stage.mix > 0.6) {
      for (const [key, node] of graphNodes) {
        if (!node.visible) continue;
        for (const link of node.links) {
          if (now < link.next) continue;
          link.next = now + 1900 + ((link.source.length * 97 + key.length * 53) % 700);
          if (particles.length < PARTICLES) {
            particles.push({ node: key, source: link.source, start: now, duration: 1300 });
          }
        }
      }
    }
    let slot = 0;
    for (let i = particles.length - 1; i >= 0; i--) {
      const particle = particles[i];
      const node = graphNodes.get(particle.node);
      const t = (now - particle.start) / particle.duration;
      if (!node || t >= 1) {
        particles.splice(i, 1);
        continue;
      }
      const top = pillars.get(particle.source)!.top;
      const e = t * t * (3 - 2 * t);
      if (e < 0.55) scratch.copy(top).lerp(node.gatePosition, e / 0.55);
      else scratch.copy(node.gatePosition).lerp(node.position, (e - 0.55) / 0.45);
      matrix.compose(scratch, quaternion.identity(), scaleVector.set(1, inverse, 1));
      particleMesh.setMatrixAt(slot, matrix);
      particleMesh.setColorAt(slot, SOURCE_COLOR[particle.source]);
      slot++;
    }
    for (let i = slot; i < PARTICLES; i++) particleMesh.setMatrixAt(i, HIDDEN);
    particleMesh.instanceMatrix.needsUpdate = true;
    if (particleMesh.instanceColor) particleMesh.instanceColor.needsUpdate = true;

    for (const node of classNodes.values()) node.mesh.scale.y = inverse;
  };

  // ─────────────────────────── 选择 ───────────────────────────

  let selection: Selection | null = null;
  let hovered: number | null = null;
  let follow: { type: 'vehicle' | 'person'; id: string } | null = null;
  const selectedHalo = flatRing(8.5, 10, 0xffffff, 0.95);
  selectedHalo.visible = false;
  scene.add(selectedHalo);

  const updateTargets = () => {
    const selectedBuilding = selection?.type === 'building' ? selection.id : null;
    for (const entry of entries.values()) {
      const id = entry.building.id;
      entry.target.copy(entry.base);
      const emphasized = emphasis.get(id);
      if (selectedBuilding === id) entry.target.lerp(ACCENT, mode === 'night' ? 0.55 : 0.7);
      else if (emphasized) entry.target.lerp(emphasized.color, emphasized.amount);
      else if (hovered === id) entry.target.lerp(ACCENT, 0.25);
    }
  };

  // ─────────────────────────── 相机 ───────────────────────────

  let insets: Insets = { left: 0, right: 0, top: 0, bottom: 0 };
  /** 可见区域越窄，相机越远，保证内容在面板之间完整可见。 */
  const frame = (reference: number, max: number) => {
    const width = Math.max(1, container.clientWidth - insets.left - insets.right);
    const height = Math.max(1, container.clientHeight - insets.top - insets.bottom);
    return THREE.MathUtils.clamp(reference / (width / height), 1, max);
  };
  const near = (distance: number) => distance * frame(1.4, 2.2);

  const homes = {
    city: () => {
      const s = frame(1.6, 2.6);
      return {
        position: new THREE.Vector3(240, 560, 800).multiplyScalar(s),
        target: new THREE.Vector3(10, 0, 40),
      };
    },
    layers: () => {
      const s = frame(1.4, 2.8);
      const target = new THREE.Vector3(20, 250, 80);
      return {
        position: target.clone().add(new THREE.Vector3(480, 640, 1780).multiplyScalar(s)),
        target,
      };
    },
  };
  const goHome = () => {
    follow = null;
    const pose = homes[view]();
    stage.flyToPose(pose.position, pose.target);
  };
  const start = homes[view]();
  camera.position.copy(start.position);
  controls.target.copy(start.target);

  const followPoint = (): THREE.Vector3 | null => {
    if (!follow) return null;
    if (follow.type === 'vehicle') {
      const v = vehicleViewById.get(follow.id);
      return v?.active ? v.position.clone().setY(0) : null;
    }
    const p = personPoint(follow.id);
    return p ? p.setY(0) : null;
  };

  /** 选中的人此刻的位置：乘车时取车辆在场景中的位置，步行时取画出的行人。 */
  const personPoint = (id: string): THREE.Vector3 | null => {
    const state = personAt(id, simT);
    if (!state) return null;
    if (state.leg.vehicle && isRide(state.leg.mode)) {
      const v = vehicleViewById.get(state.leg.vehicle);
      if (v?.active) return v.position.clone();
    }
    const shown = shownPeople.find((p) => p.id === id);
    return shown ? shown.position.clone() : toWorld(state, groundAt(state));
  };

  /** 结果中有空间位置的标注：用于切换查询后移动镜头。 */
  const focusResult = (highlights: Highlight[]) => {
    const points: Point[] = [];
    for (const h of highlights) {
      if (h.type === 'node') points.push(nodeById.get(h.id)!);
      else if (h.type === 'vehicle') {
        const v = vehicleViewById.get(h.id);
        if (v?.active) points.push(planOf(v.position));
        if (h.trail) points.push(...h.trail);
      } else if (h.type === 'edge' && h.hit) {
        const edge = edgeById.get(h.id)!;
        points.push(nodeById.get(edge.a)!, nodeById.get(edge.b)!);
      } else if (h.type === 'shop' && h.hit) points.push(centerOf(shopById.get(h.id)!.buildingId));
      else if (h.type === 'persona') points.push(...h.path);
      else if (h.type === 'place') points.push(h.at);
      else if (h.type === 'sensor' && h.hit) points.push(sensorById.get(h.id)!.at);
      else if (h.type === 'station') points.push(STATION.at);
      else if (h.type === 'buffer') {
        points.push(
          { x: h.center.x - h.radius, y: h.center.y - h.radius },
          { x: h.center.x + h.radius, y: h.center.y + h.radius },
        );
      }
    }
    if (!points.length) return;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const center = {
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      y: (Math.min(...ys) + Math.max(...ys)) / 2,
    };
    const extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    stage.flyTo(toWorld(center), near(THREE.MathUtils.clamp(extent * 1.4, 380, 1000)));
  };

  // ─────────────────────────── 拾取 ───────────────────────────

  /** 行人很小：按屏幕距离拾取，离指针 14 像素以内的最近一人。 */
  const pickPerson = (event: PointerEvent): { id: string; distance: number } | null => {
    if (stage.mix >= 0.5) return null;
    const rect = stage.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    let best: { id: string; distance: number } | null = null;
    let bestPixels = 14;
    for (const person of shownPeople) {
      scratch.copy(person.position).setY(person.position.y + 2);
      const distance = scratch.distanceTo(camera.position);
      scratch.project(camera);
      if (scratch.z > 1) continue;
      const px = ((scratch.x + 1) / 2) * rect.width;
      const py = ((1 - scratch.y) / 2) * rect.height;
      const pixels = Math.hypot(px - x, py - y);
      if (pixels < bestPixels) {
        bestPixels = pixels;
        best = { id: person.id, distance };
      }
    }
    return best;
  };

  const pickAt = (event: PointerEvent): Selection | null => {
    const targets: THREE.Object3D[] = [...world.buildingGroup.children];
    if (fade.traffic > 0.5 && stage.mix < 0.5) targets.push(cars, vans, buses);
    if (fade.iot > 0.5 && stage.mix < 0.5) targets.push(envHeads);
    const hit = stage.pick(event, targets);
    const person = pickPerson(event);
    // 行人在前（没有被建筑或车辆挡住）时选中行人
    if (person && (!hit || person.distance < hit.distance + 4)) {
      return { type: 'person', id: person.id };
    }
    if (!hit) return null;
    if (hit.object === envHeads) {
      const sensor = hit.instanceId === undefined ? undefined : ENV_SENSORS[hit.instanceId];
      return sensor ? { type: 'sensor', id: sensor.id } : null;
    }
    if (hit.object === cars || hit.object === vans || hit.object === buses) {
      const list = hit.object === cars ? carList : hit.object === vans ? vanList : busList;
      const vehicle = hit.instanceId === undefined ? undefined : list[hit.instanceId];
      return vehicle ? { type: 'vehicle', id: vehicle.id } : null;
    }
    const id = hit.object.userData.id as number | undefined;
    return id === undefined ? null : { type: 'building', id };
  };
  /** 分层视图中点到的数据源或本体类。 */
  const pickInfo = (event: PointerEvent): InfoTarget | null => {
    if (stage.mix < 0.5) return null;
    const hit = stage.pick(event, [...infoMeshes, ...classGroup.children]);
    if (hit?.object.userData.source) return { type: 'source', id: hit.object.userData.source };
    if (hit?.object.userData.cls) return { type: 'class', name: hit.object.userData.cls };
    return null;
  };
  stage.onClick((event) => {
    const info = pickInfo(event);
    if (info) callbacks.onInfo(info);
    else callbacks.onSelect(pickAt(event));
  });
  // 标签内容会随状态重绘，按下时即响应
  pinLayer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const el = (event.target as HTMLElement).closest<HTMLElement>(
      '.pin-source, .pin-layer, .pin-class',
    );
    if (!el) return;
    if (el.dataset.source) callbacks.onInfo({ type: 'source', id: el.dataset.source as SourceId });
    else if (el.dataset.layer)
      callbacks.onInfo({ type: 'layer', id: el.dataset.layer as LayerKey });
    else if (el.dataset.cls) callbacks.onInfo({ type: 'class', name: el.dataset.cls });
  });
  stage.onHover((event) => {
    const picked = pickAt(event);
    stage.canvas.style.cursor = picked || pickInfo(event) ? 'pointer' : '';
    const id = picked?.type === 'building' ? picked.id : null;
    if (id !== hovered) {
      hovered = id;
      updateTargets();
    }
  });

  // ─────────────────────────── 每帧更新 ───────────────────────────

  const updateVehicles = () => {
    if (statesAtT !== simT) {
      states = statesAt(simT);
      queuesAt(simT, states);
      statesAtT = simT;
    }
    const center = new THREE.Vector3();
    for (const view of vehicleViews) {
      const state = states.get(view.vehicle.id);
      if (!state) {
        if (view.active) {
          view.active = false;
          view.mesh.setMatrixAt(view.index, HIDDEN);
          headLights.setMatrixAt(view.slot, HIDDEN);
          tailLights.setMatrixAt(view.slot, HIDDEN);
        }
        continue;
      }
      const direction = view.direction.set(Math.cos(state.heading), 0, -Math.sin(state.heading));
      const position = toWorld(state);
      if (state.waiting && state.queueIndex) {
        position.addScaledVector(direction, -state.queueIndex * (view.half * 2 + 2.6));
      }
      // 快速播放时把车身沿行驶方向拉长，形成光迹
      const moved = view.active ? position.distanceTo(view.position) : 0;
      view.active = true;
      view.position.copy(position);
      const stretchTarget = playing && moved < 240 ? Math.min(44, Math.max(0, moved - 3)) : 0;
      view.stretch += (stretchTarget - view.stretch) * 0.35;
      quaternion.setFromAxisAngle(UP, state.heading);
      center.copy(position).addScaledVector(direction, -view.stretch / 2);
      matrix.compose(center, quaternion, scaleVector.set(1 + view.stretch / (view.half * 2), 1, 1));
      view.mesh.setMatrixAt(view.index, matrix);
      const lightY = view.vehicle.kind === 'bus' ? 2 : 1.6;
      center
        .copy(position)
        .addScaledVector(direction, view.half + 0.1)
        .setY(lightY);
      headLights.setMatrixAt(view.slot, matrix.compose(center, quaternion, ONE));
      center
        .copy(position)
        .addScaledVector(direction, -(view.half + view.stretch) - 0.1)
        .setY(lightY);
      tailLights.setMatrixAt(view.slot, matrix.compose(center, quaternion, ONE));
      tailLights.setColorAt(view.slot, state.waiting ? BRAKE : TAIL);
      const highlighted =
        markedVehicles.has(view.vehicle.id) ||
        (selection?.type === 'vehicle' && selection.id === view.vehicle.id);
      color.copy(view.base);
      if (highlighted) color.lerp(ACCENT, 0.8);
      view.mesh.setColorAt(view.index, color);
    }
    for (const mesh of [cars, vans, buses, headLights, tailLights]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    const traffic = fade.traffic;
    vehicleMaterial.opacity = 0.07 + 0.93 * traffic;
    vehicleMaterial.depthWrite = traffic > 0.5;
    headMaterial.opacity = tailMaterial.opacity = traffic;
    headMaterial.color.setRGB(0.9, 0.9, 0.85).lerp(color.setRGB(3, 2.7, 2.1), blend);
    tailMaterial.color.setScalar(0.75 + 1.1 * blend);
  };

  const updateSignals = () => {
    const traffic = fade.traffic;
    // 快速播放时信号每秒切换多次，改为不闪烁的中性色
    const blurred = playing && speed > 30;
    const glow = 1 + 1.8 * blend;
    signalHeads.forEach((head, i) => {
      if (traffic < 0.5) color.copy(SIGNAL_UNKNOWN);
      else if (blurred) color.copy(SIGNAL_BLUR);
      else color.copy(SIGNAL_COLOR[signalState(head.node, head.axis, simT)]).multiplyScalar(glow);
      signalLamps.setColorAt(i, color);
      stopBars.setColorAt(i, color);
    });
    signalLamps.instanceColor!.needsUpdate = true;
    stopBars.instanceColor!.needsUpdate = true;
    stopMaterial.opacity = blurred ? 0 : 0.85 * traffic;
  };

  const updateDecor = (now: number) => {
    const gis = fade.gis;
    lampMaterial.color.setRGB(0.72, 0.72, 0.68).lerp(color.setRGB(1.9, 1.4, 0.85), blend);
    lampMaterial.opacity = poleMaterial.opacity = gis;
    lamps.visible = lampPoles.visible = gis > 0.01;
    stripeMaterial.opacity = (mode === 'night' ? 0.22 : 0.5) * gis;
    stripes.visible = gis > 0.01 && stage.mix < 0.5;
    stopSignMaterial.opacity = 0.15 + 0.85 * fade.mobility;
    stopSignMaterial.emissiveIntensity = 0.3 + 0.9 * blend;
    stopSigns.visible = stage.mix < 0.5;
    for (const pin of basePins) pin.shown = gis > 0.5;

    // 商户招牌随屋顶高度移动
    const commerce = fade.commerce;
    signMaterial.opacity = commerce;
    signMaterial.emissiveIntensity = 0.25 + 1.2 * blend;
    signs.visible = commerce > 0.01;
    shops.forEach((shop, i) => {
      const building = buildingOf(shop.buildingId);
      const f = building.footprint;
      const p = toWorld({ x: f.x + f.w / 2, y: f.y + 0.6 }, roofOf(building) + 1.3);
      matrix.compose(p, quaternion.identity(), scaleVector.set(f.w * 0.7, 1, 1));
      signs.setMatrixAt(i, matrix);
    });
    signs.instanceMatrix.needsUpdate = true;

    // 客流传感器
    const footfall = fade.iot;
    sensorMaterial.color.copy(SOURCE_COLOR.iot).multiplyScalar(1 + 1.4 * blend);
    sensorMaterial.opacity = footfall;
    sensors.visible = footfall > 0.01;

    // 企业在岗
    for (const office of offices) {
      const ratio = presence(office.company.id, simT) / office.peak;
      office.line.material.opacity = fade.hr * (0.12 + 0.88 * ratio) * (1 - stage.mix * 0.6);
      office.line.visible = fade.hr > 0.01;
    }

    // 社区活动
    const pulse = reduced ? 0.8 : 0.65 + 0.3 * Math.sin(now / 420);
    for (const mark of eventMarks) {
      const active = simT >= mark.event.start - 600 && simT <= mark.event.end;
      const material = mark.ring.material as THREE.MeshBasicMaterial;
      material.opacity = active ? fade.community * pulse : 0;
      mark.ring.visible = active && fade.community > 0.01;
      mark.pin.shown = active && fade.community > 0.5;
    }
  };

  const updateSensors = (now: number, dt: number) => {
    const minute = Math.floor(simT / 60);
    if (minute !== readingMinute) {
      readingMinute = minute;
      readings = new Map(ENV_SENSORS.map((sensor) => [sensor.id, readingAt(sensor, simT)]));
    }
    const iot = fade.iot;
    const glow = 1 + 1.4 * blend;
    ENV_SENSORS.forEach((sensor, i) => {
      const base = sensorBase(sensor);
      const height = POLE_HEIGHT[sensor.mount];
      const p = toWorld(sensor.at, base);
      envPoles.setMatrixAt(
        i,
        matrix.compose(p, quaternion.identity(), scaleVector.set(1, height, 1)),
      );
      const head = sensorHeads
        .get(sensor.id)!
        .copy(p)
        .setY(base + height + 1.6);
      envHeads.setMatrixAt(i, matrix.makeTranslation(head.x, head.y, head.z));
      const reading = readings.get(sensor.id);
      if (reading && iot > 0.5) temperatureColor(reading.temperature, color).multiplyScalar(glow);
      else color.setRGB(0.35, 0.37, 0.4);
      envHeads.setColorAt(i, color);
    });
    envPoles.instanceMatrix.needsUpdate = true;
    envHeads.instanceMatrix.needsUpdate = true;
    envHeads.instanceColor!.needsUpdate = true;
    envPoleMaterial.opacity = envHeadMaterial.opacity = 0.12 + 0.88 * iot;
    envPoleMaterial.depthWrite = envHeadMaterial.depthWrite = iot > 0.5;
    envPoles.visible = envHeads.visible = stage.mix < 0.98;

    // 气象站：风杯随风速转动
    const weather = fade.weather;
    stationMaterial.opacity = 0.12 + 0.88 * weather;
    stationMaterial.depthWrite = weather > 0.5;
    stationPin.shown = weather > 0.5 && !marks.has('station');
    if (!reduced) cups.rotation.y += windAt(simT) * weather * dt * 0.8;

    // 热力图
    const heatTarget = heatOn && iot > 0.5 ? 1 - stage.mix : 0;
    heatMaterial.opacity += (heatTarget - heatMaterial.opacity) * (reduced ? 1 : damp(4, dt));
    heatPlane.visible = heatMaterial.opacity > 0.01;
    if (heatPlane.visible && minute !== heatMinute) {
      heatMinute = minute;
      drawHeat();
    }
    void now;
  };

  const updatePedestrians = () => {
    const visible = stage.mix < 0.5;
    pedestrianMesh.visible = umbrellas.visible = visible;
    if (!visible) return;
    const umbrellaShare = rainVisual * 0.9;
    const selectedPerson = selection?.type === 'person' ? selection.id : null;
    shownPeople.length = 0;
    let n = 0;
    for (const p of pedestriansAt(simT)) {
      if (n >= PEDESTRIANS) break;
      if (avatarShown.has(p.person)) continue;
      const trait = traitsOf(p.person);
      // 候车的人散开一些
      const spread = p.leg.mode === 'wait' ? 2.6 : 1.2;
      const at = { x: p.x + trait.dx * spread, y: p.y + trait.dy * spread };
      const position = toWorld(at, groundAt(at));
      matrix.makeTranslation(position.x, position.y, position.z);
      pedestrianMesh.setMatrixAt(n, matrix);
      pedestrianMesh.setColorAt(n, p.person === selectedPerson ? ACCENT : trait.color);
      umbrellas.setMatrixAt(n, trait.umbrella < umbrellaShare ? matrix : HIDDEN);
      umbrellas.setColorAt(n, trait.umbrellaColor);
      shownPeople.push({ id: p.person, position });
      n++;
    }
    for (let i = n; i < shownCount; i++) {
      pedestrianMesh.setMatrixAt(i, HIDDEN);
      umbrellas.setMatrixAt(i, HIDDEN);
    }
    shownCount = n;
    // 夜间路灯下仍能看清行人
    pedestrianMaterial.emissive.setScalar(0.32 * blend);
    umbrellaMaterial.emissive.setScalar(0.18 * blend);
    for (const mesh of [pedestrianMesh, umbrellas]) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor!.needsUpdate = true;
    }
  };

  const updateAvatars = () => {
    const known = Math.max(fade.hr, fade.community);
    // 同一地点的人物合并为一个标签
    const groups = new Map<string, { members: typeof avatars; building?: Building }>();
    avatarShown.clear();
    for (const avatar of avatars) {
      avatar.pin.shown = false;
      const state = personAt(avatar.person.id, simT);
      const showing = detail && known > 0.5 && state !== null && state.leg.mode !== 'home';
      if (showing) avatarShown.add(avatar.person.id);
      // 乘车时人物在车内：只显示车辆周围的光圈
      const riding = showing && isRide(state!.leg.mode);
      avatar.body.visible = showing && state!.leg.mode !== 'metro' && !riding;
      avatar.ring.visible = showing && state!.leg.mode !== 'metro';
      if (!showing || !state) continue;
      const building = riding ? undefined : buildingAt(state);
      const height = building
        ? roofOf(building)
        : !riding && pointInPolygon(state, park.area)
          ? BLOCK_HEIGHT
          : 0.2;
      const p = toWorld(state, height);
      avatar.body.position.copy(p);
      avatar.ring.position.copy(p).setY(height + 0.3);
      avatar.ring.scale.setScalar(
        (markedPersonas.has(avatar.person.id) ? 1.6 : 1) * (riding ? 1.9 : 1),
      );
      avatar.pin.anchor.copy(p).setY(height + (riding ? 18 : 14));
      const key = building
        ? `b${building.id}`
        : `${Math.round(state.x / 12)},${Math.round(state.y / 12)}`;
      const group = groups.get(key) ?? { members: [], building };
      group.members.push(avatar);
      groups.set(key, group);
    }
    for (const { members, building } of groups.values()) {
      const lead = members[0];
      lead.pin.shown = true;
      // 与进行中的社区活动同在一栋楼时，标签上移，避免与活动标签重叠
      const hosting = eventMarks.some(
        (mark) =>
          mark.ring.visible &&
          mark.event.venue.kind === 'building' &&
          mark.event.venue.id === building?.id,
      );
      lead.pin.element.classList.toggle('is-stacked', hosting);
      lead.pin.element.classList.toggle(
        'is-hit',
        members.some((member) => markedPersonas.has(member.person.id)),
      );
      const leg = personAt(lead.person.id, simT)!.leg;
      const plate =
        leg.vehicle && isRide(leg.mode) && fade.traffic > 0.5
          ? tr(
              `（${vehicleViewById.get(leg.vehicle)!.vehicle.plate}）`,
              ` (${term(vehicleViewById.get(leg.vehicle)!.vehicle.plate)})`,
            )
          : '';
      const activity = `${leg.label}${plate}`;
      const label = `${members.map((m) => `<i style="--c:${m.person.color}"></i>`).join('')}<b>${members
        .map((m) => escapeHtml(term(m.person.name!)))
        .join(tr('、', ', '))}</b><span>${escapeHtml(activity)}</span>`;
      if (label !== lead.label) {
        lead.label = label;
        lead.pin.element.innerHTML = label;
      }
    }
  };

  const updateBusPins = () => {
    const show = fade.mobility > 0.5 && fade.traffic > 0.5 && stage.mix < 0.4;
    for (const entry of busPins) {
      const view = vehicleViewById.get(entry.vehicle.id)!;
      entry.pin.shown = show && view.active;
      if (!entry.pin.shown) continue;
      entry.pin.anchor.copy(view.position).setY(14);
      const load = busLoad(entry.vehicle.id, simT);
      const text = `<b>${escapeHtml(term(entry.vehicle.plate))}</b><span>${tr(`${load} 人`, `${load} on board`)}</span>`;
      if (text !== entry.text) {
        entry.text = text;
        entry.pin.element.innerHTML = text;
      }
    }
  };

  const updateMarks = (now: number) => {
    for (const mark of marks.values()) {
      const appear = reduced ? 1 : easeOut(clamp01((now - mark.born) / 700));
      const h = mark.highlight;
      if (mark.pulse) {
        const p = reduced ? 0.5 : (now / 2200) % 1;
        mark.pulse.scale.setScalar(h.type === 'buffer' ? 0.15 + p * 0.85 : 1 + p * 0.9);
        (mark.pulse.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - p);
      }
      if (h.type === 'node' || h.type === 'buffer') {
        mark.group.children.forEach((child) => {
          if (child !== mark.pulse) child.scale.setScalar(Math.max(appear, 0.001));
        });
      }
      if (h.type === 'vehicle' && mark.halo) {
        const v = vehicleViewById.get(h.id);
        mark.halo.visible = Boolean(v?.active);
        if (v?.active) {
          mark.halo.position.copy(v.position).setY(0.4);
          if (mark.pins[0]) mark.pins[0].anchor.copy(v.position).setY(18);
        }
        if (mark.pins[0]) mark.pins[0].shown = Boolean(v?.active);
      }
      if (h.type === 'sensor') {
        const head = sensorHeads.get(h.id)!;
        if (mark.pins[0]) mark.pins[0].anchor.copy(head).setY(head.y + 8);
        const base = sensorBase(sensorById.get(h.id)!) + 0.4;
        for (const child of mark.group.children) child.position.y = base;
      }
      if (h.type === 'shop' && mark.bars) {
        const building = buildingOf(mark.bars.shop.buildingId);
        const roof = roofOf(building);
        const center = toWorld(rectCenter(building.footprint), roof);
        const [today, baseline] = mark.bars.target;
        const k = reduced ? 1 : 0.12;
        const unit = BAR_HEIGHT / Math.max(1, today, baseline);
        for (const [mesh, value, dx] of [
          [mark.bars.today, today, 3.2],
          [mark.bars.baseline, baseline, -3.2],
        ] as const) {
          const height = Math.max(0.001, value * unit * appear);
          mesh.scale.y += (height - mesh.scale.y) * k;
          mesh.position.set(center.x + dx, roof + 0.2, center.z);
        }
        if (mark.pins[0]) {
          mark.pins[0].anchor.set(center.x, roof + BAR_HEIGHT + 10, center.z);
        }
      }
    }
  };

  const applyLayerPalette = () => {
    const palette = PALETTE[mode];
    planeMaterials[1].color.set(mode === 'night' ? 0xffffff : 0x24303a);
    outlineLines[1].material.color.set(mode === 'night' ? 0xffffff : 0x24303a);
    for (const line of outlineLines) {
      line.material.opacity = palette.outlineOpacity;
      line.material.linewidth = mode === 'night' ? 1.4 : 1.8;
    }
    for (const node of classNodes.values()) {
      node.mesh.material.emissiveIntensity = mode === 'night' ? 1.2 : 0.6;
    }
    for (const entry of relationLines.values()) entry.line.material.color.set(palette.ink);
    syncPillars();
  };

  /** 场景明暗切换时更新分层视图的配色；实体节点的颜色在创建时确定，重建一次。 */
  const setPalette = (next: Mode) => {
    mode = next;
    applyLayerPalette();
    clearGraph();
    syncGraph(false, performance.now() - 10000);
  };

  stage.onFrame((now, dt) => {
    controls.target.x = THREE.MathUtils.clamp(controls.target.x, -560, 560);
    controls.target.z = THREE.MathUtils.clamp(controls.target.z, -440, 520);
    controls.target.y = THREE.MathUtils.clamp(controls.target.y, 0, 320);

    // 视图过渡
    const targetMix = view === 'layers' ? 1 : 0;
    if (stage.mix !== targetMix) {
      stage.mix = reduced ? targetMix : stage.mix + (targetMix - stage.mix) * damp(5, dt);
      if (Math.abs(stage.mix - targetMix) < 0.002) stage.mix = targetMix;
    }
    const mix = stage.mix;
    layerRoot.visible = mix > 0.01;
    layerRoot.scale.y = Math.max(mix, 0.001);
    for (const material of planeMaterials) material.opacity = PALETTE[mode].planeOpacity * mix;
    buildingScale = 1 - (1 - FLAT) * mix;
    world.setBuildingScale(buildingScale);

    // 数据源的淡入淡出
    const k = reduced ? 1 : damp(5, dt);
    for (const source of SOURCES) {
      const goal = enabled.has(source.id) ? 1 : 0;
      fade[source.id] += (goal - fade[source.id]) * k;
      if (Math.abs(goal - fade[source.id]) < 0.002) fade[source.id] = goal;
    }
    world.setOpacity(0.1 + 0.9 * fade.gis);

    // 天气与昼夜：按模拟时间，切换视图不影响
    const weatherOn = fade.weather;
    rainVisual = rainAt(simT) * weatherOn;
    const storm = stormAt(simT) * weatherOn;
    const fog = fogAt(simT) * weatherOn;
    const cloud = cloudAt(simT) * weatherOn;
    const wetness = wetnessAt(simT) * fade.weather;
    if (Math.abs(wetness - wet) > 0.002) {
      wet = wetness;
      world.setWetness(wet);
    }
    const nextBlend = clamp01(darkness(simT) + 0.3 * rainVisual + 0.15 * storm);
    if (Math.abs(nextBlend - blend) > 0.003) {
      blend = nextBlend;
      world.applyBlend(blend);
      // 本示例以近景为主：夜间窗灯与泛光比地理示例弱一些
      stage.bloom.strength *= 0.5;
      for (const entry of entries.values()) entry.mesh.material.emissiveIntensity *= 0.5;
      lighting.sun = stage.sun.intensity;
      lighting.hemi = stage.hemi.intensity;
      lighting.bloom = stage.bloom.strength;
      lighting.background.copy(scene.background as THREE.Color);
      updateTargets();
      const nextMode: Mode = blend > 0.5 ? 'night' : 'day';
      if (nextMode !== mode) setPalette(nextMode);
    }

    // 阴天削弱日照与阴影，雾把远处褪成灰白；雷阵雨时偶有闪电
    if (storm > 0.5 && !reduced && mix < 0.5 && now > lightning.next) {
      lightning.flash = 1;
      lightning.echo = now + 140;
      lightning.next = now + 1800 + Math.random() * 4200;
    }
    if (lightning.echo && now > lightning.echo) {
      lightning.flash = Math.max(lightning.flash, 0.7);
      lightning.echo = 0;
    }
    lightning.flash *= Math.exp(-dt * 9);
    const flash = lightning.flash;
    const dim = 1 - mix;
    stage.sun.intensity = lighting.sun * (1 - 0.7 * cloud * dim) * (1 - 0.5 * fog * dim);
    stage.hemi.intensity = lighting.hemi * (1 - 0.15 * cloud * dim) + 2.6 * flash;
    stage.bloom.strength = lighting.bloom + 0.5 * flash;
    const background = scene.background as THREE.Color;
    background
      .copy(lighting.background)
      .lerp(color.set(0xa9b2b9).lerp(OVERCAST_NIGHT, blend), (0.45 * cloud + 0.6 * fog) * dim)
      .lerp(FLASH, 0.45 * flash);
    stage.fog.color.copy(background);
    const distance = camera.position.distanceTo(controls.target);
    const haze = rainVisual * dim;
    const density = fog * dim;
    stage.fog.near = Math.max(
      10,
      (distance + 250 + 500 * mix) * (1 - 0.45 * haze) - density * (distance + 100),
    );
    stage.fog.far = Math.max(
      stage.fog.near + 200,
      (distance + 2200 + 1200 * mix) * (1 - 0.3 * haze) - density * 1900,
    );

    rain.visible = rainVisual > 0.01 && mix < 0.5;
    if (rain.visible) {
      rainMaterial.uniforms.uTime.value = reduced ? 0 : now / 1000;
      rainMaterial.uniforms.uOpacity.value =
        rainVisual * (0.55 - 0.15 * blend + 0.25 * storm) * (1 - mix * 2);
      rainMaterial.uniforms.uWind.value = windAt(simT);
      (rainMaterial.uniforms.uColor.value as THREE.Color)
        .setRGB(0.42, 0.5, 0.6)
        .lerp(color.setRGB(0.65, 0.75, 0.95), blend);
      (rainMaterial.uniforms.uCenter.value as THREE.Vector3).copy(controls.target);
    }

    updateDecor(now);
    updateSensors(now, dt);
    updateSignals();
    updateVehicles();
    updateAvatars();
    updatePedestrians();
    updateBusPins();
    updateMarks(now);
    if (mix > 0.01) updateGraph(now, dt);

    // 选中的车辆或行人
    if (selection?.type === 'vehicle') {
      const v = vehicleViewById.get(selection.id);
      selectedHalo.visible = Boolean(v?.active) && fade.traffic > 0.5;
      if (v?.active) selectedHalo.position.copy(v.position).setY(0.5);
      selectedHalo.scale.setScalar(1);
      (selectedHalo.material as THREE.MeshBasicMaterial).color.set(PALETTE[mode].ink);
    } else if (selection?.type === 'person' && mix < 0.5) {
      const p = personPoint(selection.id);
      const state = personAt(selection.id, simT);
      const riding = Boolean(state?.leg.vehicle && isRide(state.leg.mode));
      // 在室内时不显示
      const indoor = state?.leg.building !== undefined && !riding;
      selectedHalo.visible = Boolean(p) && !indoor;
      if (p) selectedHalo.position.copy(p).setY(p.y + 0.4);
      selectedHalo.scale.setScalar(riding ? 1 : 0.45);
      (selectedHalo.material as THREE.MeshBasicMaterial).color.set(PALETTE[mode].ink);
    } else {
      selectedHalo.visible = false;
    }

    // 跟随镜头
    const followed = view === 'city' ? followPoint() : null;
    if (followed) {
      const delta = followed
        .sub(controls.target)
        .setY(0)
        .multiplyScalar(reduced ? 1 : damp(2.5, dt));
      controls.target.add(delta);
      camera.position.add(delta);
    }

    world.update();
  });

  // 初始状态
  world.applyMode(mode);
  syncPillars();
  applyLayerPalette();
  container.dataset.view = view;

  let selectionInfo: SelectionInfo | null = null;

  const refreshSelectionEntity = () => {
    selectionEntity = selectionInfo
      ? {
          key: 'sel',
          kind:
            selectionInfo.selection.type === 'node'
              ? 'intersection'
              : selectionInfo.selection.type === 'edge'
                ? 'road'
                : selectionInfo.selection.type,
          ref: selectionInfo.selection.id,
          label: selectionInfo.label,
          cls: selectionInfo.cls,
          sources: selectionInfo.sources,
          hit: true,
        }
      : null;
  };

  const scene3d: CityScene = {
    setTime(t, isPlaying, nextSpeed) {
      simT = t;
      playing = isPlaying;
      speed = nextSpeed;
    },
    setSources(sources) {
      enabled = new Set(sources);
      syncPillars();
    },
    setDetail(value) {
      detail = value;
    },
    setNightView(value) {
      nightView = value;
    },
    showResult(result, fresh) {
      const now = performance.now();
      currentEntities = result.entities;
      currentRelations = result.relations;
      syncMarks(result.highlights, fresh, now);
      // 类节点变化时，实体到类的 rdf:type 连线需要重建
      if (syncClasses(result.classes, result.subclass)) clearGraph();
      syncGraph(fresh, now);
      if (fresh && view === 'city') {
        follow = null;
        focusResult(result.highlights);
      }
      updateTargets();
    },
    select(info) {
      selectionInfo = info;
      selection = info?.selection ?? null;
      stage.removePins('pin-selected');
      if (info?.selection.type === 'building') {
        const building = buildingOf(info.selection.id);
        if (!emphasis.has(building.id)) {
          stage.addPin(
            escapeHtml(info.label),
            toWorld(rectCenter(building.footprint), roofOf(building) + 10),
            'pin-selected',
            'city',
          );
        }
        if (view === 'city') {
          follow = null;
          stage.flyTo(toWorld(rectCenter(building.footprint)), near(400));
        }
      } else if (info?.selection.type === 'sensor') {
        const sensor = sensorById.get(info.selection.id)!;
        stage.addPin(
          escapeHtml(info.label),
          sensorHeads
            .get(sensor.id)!
            .clone()
            .setY(sensorHeads.get(sensor.id)!.y + 8),
          'pin-selected',
          'city',
        );
        if (view === 'city') {
          follow = null;
          stage.flyTo(toWorld(sensor.at), near(320));
        }
      } else if (info?.selection.type === 'node' || info?.selection.type === 'edge') {
        const p =
          info.selection.type === 'node'
            ? nodeById.get(info.selection.id)!
            : (() => {
                const edge = edgeById.get(info.selection.id)!;
                const a = nodeById.get(edge.a)!;
                const b = nodeById.get(edge.b)!;
                return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
              })();
        // 查询结果已标注该路口或路段时不再重复加标签
        if (!marks.has(`${info.selection.type}:${info.selection.id}`)) {
          stage.addPin(escapeHtml(info.label), toWorld(p, 16), 'pin-selected', 'city');
        }
        if (view === 'city') {
          follow = null;
          stage.flyTo(toWorld(p), near(340));
        }
      } else if (info?.selection.type === 'vehicle' && view === 'city') {
        follow = { type: 'vehicle', id: info.selection.id };
        const v = vehicleViewById.get(info.selection.id);
        if (v?.active) stage.flyTo(v.position.clone().setY(0), near(300));
      } else if (info?.selection.type === 'person' && view === 'city') {
        // 跟随选中的人；已经在近处时不再推近镜头
        const changed = follow?.type !== 'person' || follow.id !== info.selection.id;
        follow = { type: 'person', id: info.selection.id };
        const p = followPoint();
        if (p && changed && camera.position.distanceTo(controls.target) > 420) {
          stage.flyTo(p, near(260));
        }
      } else if (!info) {
        follow = null;
      }
      refreshSelectionEntity();
      if (graphNodes.has('sel')) removeGraphNode('sel');
      syncGraph(false, performance.now() - (reduced ? 10000 : 0));
      updateTargets();
    },
    focus(target) {
      follow = null;
      if (view !== 'city') return;
      switch (target.type) {
        case 'node':
          stage.flyTo(toWorld(nodeById.get(target.id)!), near(340));
          break;
        case 'edge': {
          const edge = edgeById.get(target.id)!;
          const a = nodeById.get(edge.a)!;
          const b = nodeById.get(edge.b)!;
          stage.flyTo(toWorld({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }), near(400));
          break;
        }
        case 'building':
          stage.flyTo(toWorld(centerOf(target.id)), near(380));
          break;
        case 'point':
          stage.flyTo(toWorld(target.at), near(420));
          break;
        case 'sensor':
          stage.flyTo(toWorld(sensorById.get(target.id)!.at), near(340));
          break;
        case 'vehicle':
        case 'persona': {
          follow = { type: target.type === 'vehicle' ? 'vehicle' : 'person', id: target.id };
          const p = followPoint();
          if (p) stage.flyTo(p, near(300));
          break;
        }
      }
    },
    setView(next) {
      if (next === view) return;
      view = next;
      container.dataset.view = view;
      goHome();
      if (view === 'layers') {
        // 切换到分层视图时重新播放实体与连线的生长
        clearGraph();
        syncGraph(true, performance.now());
      }
    },
    resetView: goHome,
    tour(step) {
      stage.removePins('pin-marker');
      if (!step) return;
      let anchor: THREE.Vector3 | null = null;
      if (step.focus) {
        scene3d.focus(step.focus);
        const f = step.focus;
        anchor =
          f.type === 'node'
            ? toWorld(nodeById.get(f.id)!, 12)
            : f.type === 'building'
              ? toWorld(centerOf(f.id), heightOf(buildingOf(f.id)) + 8)
              : f.type === 'sensor'
                ? toWorld(sensorById.get(f.id)!.at, 20)
                : f.type === 'point'
                  ? toWorld(f.at, 10)
                  : null;
      } else if (step.layer) {
        follow = null;
        const s = frame(1.4, 2.8);
        const poses: Record<
          LayerKey,
          { target: THREE.Vector3; offset: THREE.Vector3; mark: THREE.Vector3 }
        > = {
          data: {
            target: new THREE.Vector3(0, 20, HALF_D + 70),
            offset: new THREE.Vector3(160, 300, 760),
            mark: new THREE.Vector3(0, PILLAR_TOP, HALF_D + 70),
          },
          mapping: {
            target: new THREE.Vector3(0, LAYER.mapping - 40, 60),
            offset: new THREE.Vector3(320, 260, 1500),
            mark: new THREE.Vector3(-HALF_W * 0.55, LAYER.mapping, HALF_D),
          },
          graph: {
            target: new THREE.Vector3(0, LAYER.graph - 40, 60),
            offset: new THREE.Vector3(260, 380, 1050),
            mark: new THREE.Vector3(-HALF_W * 0.55, LAYER.graph, HALF_D),
          },
          ontology: {
            target: new THREE.Vector3(0, LAYER.ontology - 30, 0),
            offset: new THREE.Vector3(200, 300, 860),
            mark: new THREE.Vector3(-ONTOLOGY_HALF.w * 0.6, LAYER.ontology, ONTOLOGY_HALF.d),
          },
        };
        if (step.layer === 'overview') {
          goHome();
        } else {
          const pose = poses[step.layer];
          stage.flyToPose(
            pose.target.clone().add(pose.offset.clone().multiplyScalar(s)),
            pose.target,
            1800,
          );
          anchor = pose.mark;
        }
      }
      if (anchor && step.marker) {
        stage.addPin(`<i></i><span>${escapeHtml(step.marker)}</span>`, anchor, 'pin-marker');
      }
    },
    setInsets(next) {
      insets = next;
    },
    dispose() {
      stage.dispose();
    },
  };
  return scene3d;
}
