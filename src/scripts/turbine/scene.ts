/**
 * “VKG × 设备诊断”示例的三维场景。由 scripts/turbine/controller.ts 在场景进入视口后按需加载。
 *
 * 前方是两座电厂、六台燃气轮机：转子随转速转动，有火焰时燃烧室发光、烟囱冒烟，出力越大烟越浓。
 * 后方是八个数据源：电厂的信号持续流入实时流，每 10 分钟批量写入各自的历史库。
 * 上方的环表示虚拟知识图谱：选中查询时，所用数据源的连线亮起，汇入图谱，结果再落到命中的机组上。
 */
import * as THREE from 'three';
import type { Line2 } from 'three/addons/lines/Line2.js';
import { tr } from '../../i18n/runtime';
import {
  MODELS,
  PLANTS,
  TURBINES,
  sensorsOf,
  turbineById,
  type PlantId,
  type TurbineId,
} from '../../lib/turbine/fleet';
import { SOURCES, sourceById, type SourceId } from '../../lib/turbine/sources';
import { BATCH } from '../../lib/turbine/time';
import { createStage, type Pin } from '../three/stage';
import { damp, escapeHtml } from '../three/util';

/** 机组在某一时刻的可视状态。 */
export interface UnitVisual {
  /** 转速（rpm），读不到时为 NaN。 */
  speed: number;
  flame: boolean;
  power: number;
  /** 喷嘴温度（°C），按序号排列。 */
  tips: number[];
}

/** 机组头顶卡片的内容。 */
export interface UnitCard {
  state: string;
  /** 卡片中的数值，如 52 MW。 */
  value: string;
  /** 查询命中时的说明。 */
  alert?: string;
  /** 查询用到了这台机组的数据。 */
  involved: boolean;
  hit: boolean;
}

export interface Insets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface TurbineScene {
  setTime(t: number, playing: boolean): void;
  setUnits(units: Record<TurbineId, UnitVisual>, cards: Record<TurbineId, UnitCard>): void;
  setSources(sources: ReadonlySet<SourceId>): void;
  /** 选中查询后播放数据流：所用数据源 → 知识图谱 → 命中的机组。fresh 为 true 时重新播放。 */
  showQuery(used: SourceId[], hits: TurbineId[], hotTips: string[], fresh: boolean): void;
  setPlantInfo(info: Record<PlantId, string>): void;
  select(turbine: TurbineId | null): void;
  setInsets(insets: Insets): void;
  resetView(): void;
  /** 导览：镜头飞向某处，并在该处标出提示点；传入 null 时移除提示点。 */
  tour(step: TourFocus | null): void;
  dispose(): void;
}

export type FocusKey = 'overview' | 'turbine' | 'tips' | 'sources' | 'ingest' | 'hub' | 'demo';

export interface TourFocus {
  focus: FocusKey;
  turbine?: TurbineId;
  /** 提示点旁的短标签。 */
  marker?: string;
}

const PLANT_X: Record<PlantId, number> = { A: -225, B: 225 };
/** 同一电厂的三台机组左右并排。 */
const UNIT_SPACING = 86;
const UNIT_Z = 30;
const SOURCE_Z = -330;
const HUB = new THREE.Vector3(0, 190, -250);
const HUB_RADIUS = 64;
const HOME = {
  position: new THREE.Vector3(0, 790, 1230),
  target: new THREE.Vector3(0, 40, -110),
};
const WARN = new THREE.Color('#ffb547');
const ACCENT = new THREE.Color('#3fd0ff');
/** 场景固定使用深蓝底色与青色荧光轮廓，不随站点主题变化。 */
const NEON = {
  background: 0x030816,
  ground: 0x050d1f,
  grid: 0x123a66,
  pad: 0x081631,
  edge: 0x3fd0ff,
} as const;
const FLAME = new THREE.Color('#ff8a3c');

/** 数据源底座的横向位置，历史库分别在两座电厂后方。 */
const SOURCE_X: Record<SourceId, number> = {
  hist_a: -364,
  events: -260,
  cmms: -156,
  master: -52,
  live: 52,
  dispatch: 156,
  weather: 260,
  hist_b: 364,
};

const unitPosition = (id: TurbineId) => {
  const turbine = turbineById.get(id)!;
  const index = TURBINES.filter((t) => t.plant === turbine.plant).indexOf(turbine);
  return new THREE.Vector3(PLANT_X[turbine.plant] + (index - 1) * UNIT_SPACING, 0, UNIT_Z);
};

const sourceTop = (id: SourceId) => new THREE.Vector3(SOURCE_X[id], 34, SOURCE_Z);

/** 两点之间向上拱起的曲线。 */
function arc(a: THREE.Vector3, b: THREE.Vector3, lift: number, segments = 24): THREE.Vector3[] {
  const mid = a.clone().add(b).multiplyScalar(0.5);
  mid.y = Math.max(a.y, b.y) + lift;
  const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
  return curve.getPoints(segments);
}

function softTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

/** 圆角矩形平面（电厂场地）。 */
function padGeometry(w: number, d: number, r: number) {
  const shape = new THREE.Shape();
  const x = -w / 2;
  const y = -d / 2;
  shape.moveTo(x + r, y);
  shape.lineTo(x + w - r, y);
  shape.quadraticCurveTo(x + w, y, x + w, y + r);
  shape.lineTo(x + w, y + d - r);
  shape.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
  shape.lineTo(x + r, y + d);
  shape.quadraticCurveTo(x, y + d, x, y + d - r);
  shape.lineTo(x, y + r);
  shape.quadraticCurveTo(x, y, x + r, y);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 2, bevelEnabled: false });
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

interface Unit {
  id: TurbineId;
  group: THREE.Group;
  rotor: THREE.Group;
  combustor: THREE.MeshStandardMaterial;
  tips: { mesh: THREE.Mesh; material: THREE.MeshStandardMaterial; tag: string }[];
  ring: THREE.Mesh;
  pin: Pin;
  smoke: { sprite: THREE.Sprite; age: number; life: number; vx: number; vz: number }[];
  stackTop: THREE.Vector3;
  visual: UnitVisual;
  spin: number;
  emit: number;
}

interface Pulse {
  mesh: THREE.Mesh;
  points: THREE.Vector3[];
  t: number;
  speed: number;
  /** 循环播放（数据源到图谱的常驻流）或播放一次后移除。 */
  loop: boolean;
  delay: number;
}

export function createTurbineScene(
  container: HTMLElement,
  pinLayer: HTMLElement,
  options: { reducedMotion: boolean; onSelect(turbine: TurbineId): void },
): TurbineScene {
  const stage = createStage(container, pinLayer, {
    reducedMotion: options.reducedMotion,
    target: HOME.target,
  });
  const { scene, camera, controls } = stage;
  const reduced = options.reducedMotion;
  /** 画面越窄，镜头越远，保证两座电厂完整可见。 */
  const homePosition = () => {
    const scale = stage.framingScale(1.7, 2.8);
    return HOME.target.clone().add(HOME.position.clone().sub(HOME.target).multiplyScalar(scale));
  };
  let moved = false;
  controls.addEventListener('start', () => (moved = true));
  camera.position.copy(homePosition());
  controls.target.copy(HOME.target);
  controls.minDistance = 140;
  controls.maxDistance = 1800;
  stage.fog.near = 900;
  stage.fog.far = 2600;
  stage.sun.position.set(-300, 520, 380);

  const soft = softTexture();

  // 荧光轮廓线：同一几何体的轮廓只生成一次
  const edgeMaterial = new THREE.LineBasicMaterial({
    color: NEON.edge,
    transparent: true,
    opacity: 0.7,
  });
  const edgeCache = new Map<THREE.BufferGeometry, THREE.EdgesGeometry>();
  const outline = (mesh: THREE.Mesh, opacity?: number) => {
    let edges = edgeCache.get(mesh.geometry);
    if (!edges) {
      edges = new THREE.EdgesGeometry(mesh.geometry, 25);
      edgeCache.set(mesh.geometry, edges);
      stage.markShared(edges);
    }
    const material = opacity === undefined ? edgeMaterial : edgeMaterial.clone();
    if (opacity !== undefined) material.opacity = opacity;
    mesh.add(new THREE.LineSegments(edges, material));
  };

  // ── 地面与电厂场地 ──
  const groundMaterial = new THREE.MeshStandardMaterial({ roughness: 1 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), groundMaterial);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.5;
  ground.receiveShadow = true;
  scene.add(ground);
  const grid = new THREE.GridHelper(2400, 60);
  (grid.material as THREE.Material).transparent = true;
  scene.add(grid);

  const padMaterial = new THREE.MeshStandardMaterial({ roughness: 0.9 });
  const sourcePadMaterial = new THREE.MeshStandardMaterial({ roughness: 0.9 });
  const plantPins: Record<PlantId, Pin> = {} as Record<PlantId, Pin>;
  for (const plant of Object.values(PLANTS)) {
    const pad = new THREE.Mesh(padGeometry(300, 230, 18), padMaterial);
    pad.position.set(PLANT_X[plant.id], 0, UNIT_Z);
    pad.receiveShadow = true;
    outline(pad, 0.45);
    scene.add(pad);
    plantPins[plant.id] = stage.addPin(
      `<b>${escapeHtml(plant.name)}</b><span></span>`,
      new THREE.Vector3(PLANT_X[plant.id], 0, UNIT_Z + 122),
      'pin-plant',
    );
  }
  const sourcePad = new THREE.Mesh(padGeometry(830, 90, 20), sourcePadMaterial);
  sourcePad.position.set(0, 0, SOURCE_Z);
  sourcePad.receiveShadow = true;
  outline(sourcePad, 0.45);
  scene.add(sourcePad);

  // ── 燃气轮机 ──
  const metal = new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.35 });
  const casing = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.25 });
  const generatorMaterial = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.2 });
  const skidMaterial = new THREE.MeshStandardMaterial({ roughness: 0.8 });
  const bladeMaterial = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.5 });

  const shared = {
    skid: new THREE.BoxGeometry(150, 5, 46),
    generator: new THREE.BoxGeometry(34, 30, 32),
    shaft: new THREE.CylinderGeometry(2.4, 2.4, 22, 12),
    compressor: new THREE.CylinderGeometry(11, 17, 40, 28, 1, false),
    combustor: new THREE.CylinderGeometry(15, 15, 22, 28),
    turbine: new THREE.CylinderGeometry(17, 11, 24, 28),
    duct: new THREE.BoxGeometry(18, 22, 26),
    stack: new THREE.CylinderGeometry(8, 9.5, 74, 20),
    hub: new THREE.CylinderGeometry(5, 5, 3, 16),
    blade: new THREE.BoxGeometry(1.4, 2, 15),
    tip: new THREE.SphereGeometry(2.6, 12, 10),
    ring: new THREE.RingGeometry(40, 44, 64),
  };
  Object.values(shared).forEach((g) => stage.markShared(g));

  const units = new Map<TurbineId, Unit>();
  const pickables: THREE.Object3D[] = [];
  const cardHtml = (id: TurbineId, card?: UnitCard) => {
    const model = turbineById.get(id)!.model;
    return `<span class="uc-head"><b>${id}</b><i>${model}</i></span><span class="uc-state">${escapeHtml(card?.state ?? '—')}<em>${escapeHtml(card?.value ?? '')}</em></span>${card?.alert ? `<span class="uc-alert">${escapeHtml(card.alert)}</span>` : ''}`;
  };

  for (const turbine of TURBINES) {
    const group = new THREE.Group();
    group.position.copy(unitPosition(turbine.id));
    // 机组轴线朝向镜头：发电机在前，烟囱在后
    group.rotation.y = Math.PI / 2;
    scene.add(group);
    const add = (
      geometry: THREE.BufferGeometry,
      material: THREE.Material,
      x: number,
      y: number,
      z = 0,
    ) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      mesh.userData.turbine = turbine.id;
      pickables.push(mesh);
      outline(mesh);
      return mesh;
    };
    add(shared.skid, skidMaterial, 0, 2.5);
    add(shared.generator, generatorMaterial, -54, 20);
    const shaft = add(shared.shaft, metal, -27, 20);
    shaft.rotation.z = Math.PI / 2;
    const compressor = add(shared.compressor, casing, -2, 22);
    compressor.rotation.z = -Math.PI / 2;
    const combustorMaterial = new THREE.MeshStandardMaterial({
      roughness: 0.4,
      metalness: 0.3,
      emissive: FLAME,
      emissiveIntensity: 0,
    });
    const combustor = add(shared.combustor, combustorMaterial, 29, 22);
    combustor.rotation.z = Math.PI / 2;
    const turbineCone = add(shared.turbine, casing, 52, 22);
    turbineCone.rotation.z = -Math.PI / 2;
    add(shared.duct, casing, 72, 18);
    add(shared.stack, metal, 72, 66);

    // 进气端的转子叶片
    const rotor = new THREE.Group();
    rotor.position.set(-23, 22, 0);
    const hub = new THREE.Mesh(shared.hub, bladeMaterial);
    hub.rotation.z = Math.PI / 2;
    rotor.add(hub);
    for (let i = 0; i < 8; i++) {
      const blade = new THREE.Mesh(shared.blade, bladeMaterial);
      blade.position.set(
        0,
        Math.cos((i / 8) * Math.PI * 2) * 6,
        Math.sin((i / 8) * Math.PI * 2) * 6,
      );
      blade.rotation.x = (i / 8) * Math.PI * 2;
      rotor.add(blade);
    }
    group.add(rotor);

    // 燃烧室外圈的喷嘴
    const tips = sensorsOf(turbine.id, 'tip').map((sensor, i, all) => {
      const angle = (i / all.length) * Math.PI * 2;
      const material = new THREE.MeshStandardMaterial({
        roughness: 0.4,
        emissive: FLAME,
        emissiveIntensity: 0,
      });
      const mesh = new THREE.Mesh(shared.tip, material);
      mesh.position.set(29, 22 + Math.cos(angle) * 15.5, Math.sin(angle) * 15.5);
      group.add(mesh);
      return { mesh, material, tag: sensor.tag };
    });

    const ring = new THREE.Mesh(
      shared.ring,
      new THREE.MeshBasicMaterial({
        color: ACCENT,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 3;
    group.add(ring);

    const smoke = Array.from({ length: 26 }, () => {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: soft, transparent: true, opacity: 0, depthWrite: false }),
      );
      sprite.visible = false;
      scene.add(sprite);
      return { sprite, age: 0, life: 1, vx: 0, vz: 0 };
    });

    // 中间一台的卡片抬高，避免与相邻卡片重叠
    const index = TURBINES.filter((t) => t.plant === turbine.plant).indexOf(turbine);
    const pin = stage.addPin(
      cardHtml(turbine.id),
      group.position.clone().add(new THREE.Vector3(0, index === 1 ? 172 : 100, 0)),
      'pin-unit',
    );
    pin.element.dataset.turbine = turbine.id;
    units.set(turbine.id, {
      id: turbine.id,
      group,
      rotor,
      combustor: combustorMaterial,
      tips,
      ring,
      pin,
      smoke,
      stackTop: (group.updateMatrixWorld(), group.localToWorld(new THREE.Vector3(72, 104, 0))),
      visual: { speed: 0, flame: false, power: 0, tips: [] },
      spin: 0,
      emit: 0,
    });
  }

  // ── 数据源与知识图谱 ──
  const sourceMaterials = new Map<SourceId, THREE.MeshStandardMaterial>();
  const sourcePins = new Map<SourceId, Pin>();
  const baseMaterial = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.2 });
  const diskGeometry = new THREE.CylinderGeometry(20, 20, 6, 32);
  const baseGeometry = new THREE.CylinderGeometry(24, 26, 10, 32);
  for (const source of SOURCES) {
    const x = SOURCE_X[source.id];
    const base = new THREE.Mesh(baseGeometry, baseMaterial);
    base.position.set(x, 5, SOURCE_Z);
    base.castShadow = true;
    scene.add(base);
    const material = new THREE.MeshStandardMaterial({
      color: source.color,
      emissive: source.color,
      emissiveIntensity: 0.4,
      roughness: 0.5,
    });
    for (let i = 0; i < 3; i++) {
      const disk = new THREE.Mesh(diskGeometry, material);
      disk.position.set(x, 13 + i * 7.5, SOURCE_Z);
      disk.castShadow = true;
      scene.add(disk);
    }
    sourceMaterials.set(source.id, material);
    sourcePins.set(
      source.id,
      stage.addPin(
        `<i style="--source:${source.color}"></i>${escapeHtml(source.name)}`,
        new THREE.Vector3(x, 46, SOURCE_Z),
        'pin-source',
      ),
    );
  }

  const hubMaterial = new THREE.MeshBasicMaterial({
    color: ACCENT,
    transparent: true,
    opacity: 0.9,
  });
  const hubRing = new THREE.Mesh(new THREE.TorusGeometry(HUB_RADIUS, 2.2, 12, 96), hubMaterial);
  hubRing.position.copy(HUB);
  hubRing.rotation.x = Math.PI / 2;
  scene.add(hubRing);
  const hubDiscMaterial = new THREE.MeshBasicMaterial({
    color: ACCENT,
    transparent: true,
    opacity: 0.08,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const hubDisc = new THREE.Mesh(new THREE.CircleGeometry(HUB_RADIUS, 64), hubDiscMaterial);
  hubDisc.position.copy(HUB);
  hubDisc.rotation.x = -Math.PI / 2;
  scene.add(hubDisc);
  // 图谱中的节点与边：环内几个缓慢旋转的点
  const graph = new THREE.Group();
  graph.position.copy(HUB);
  const nodeGeometry = new THREE.SphereGeometry(3.4, 12, 10);
  const nodeMaterial = new THREE.MeshBasicMaterial({ color: ACCENT });
  const nodes: THREE.Vector3[] = [];
  for (let i = 0; i < 9; i++) {
    const r = i === 0 ? 0 : i < 5 ? 26 : 46;
    const a = (i / (i < 5 ? 4 : 4)) * Math.PI * 2 + (i < 5 ? 0 : 0.6);
    const p = new THREE.Vector3(Math.cos(a) * r, (i % 2) * 6 - 3, Math.sin(a) * r);
    nodes.push(p);
    const node = new THREE.Mesh(nodeGeometry, nodeMaterial);
    node.position.copy(p);
    graph.add(node);
  }
  scene.add(graph);
  const graphLines = [
    [0, 1],
    [0, 2],
    [0, 3],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
    [4, 8],
    [1, 6],
    [3, 8],
  ].map(([a, b]) => {
    const line = stage.makeLine([nodes[a], nodes[b]], ACCENT, 1.2, 0.55);
    graph.add(line);
    return line;
  });
  stage.addPin(
    `<b>${escapeHtml(tr('虚拟知识图谱', 'Virtual knowledge graph'))}</b><span>${escapeHtml(tr('一个本体 · 八个数据源', 'One ontology · eight sources'))}</span>`,
    HUB.clone().add(new THREE.Vector3(0, 30, 0)),
    'pin-hub',
  );

  /** 数据源到图谱的连线。 */
  const feedPaths = new Map<SourceId, THREE.Vector3[]>();
  const feedLines = new Map<SourceId, Line2>();
  for (const source of SOURCES) {
    const top = sourceTop(source.id);
    const angle = Math.atan2(top.z - HUB.z, top.x - HUB.x);
    const rim = HUB.clone().add(
      new THREE.Vector3(Math.cos(angle) * HUB_RADIUS, 0, Math.sin(angle) * HUB_RADIUS),
    );
    const points = arc(top, rim, 40);
    feedPaths.set(source.id, points);
    const line = stage.makeLine(points, source.color, 1.6, 0.25);
    scene.add(line);
    feedLines.set(source.id, line);
  }

  /** 电厂到实时流与历史库的连线。 */
  const ingest: { plant: PlantId; target: SourceId; points: THREE.Vector3[]; line: Line2 }[] = [];
  for (const plant of Object.values(PLANTS)) {
    for (const target of [plant.historian, 'live'] as SourceId[]) {
      const from = new THREE.Vector3(
        PLANT_X[plant.id] + (target === 'live' ? 60 : -60),
        4,
        UNIT_Z - 112,
      );
      const to = sourceTop(target).clone().setY(12);
      const points = arc(from, to, 30, 20);
      const line = stage.makeLine(
        points,
        sourceById.get(target)!.color,
        1.4,
        0.3,
        target !== 'live',
      );
      scene.add(line);
      ingest.push({ plant: plant.id, target, points, line });
    }
  }

  // ── 流动的数据包 ──
  const pulseGeometry = new THREE.SphereGeometry(2.8, 10, 8);
  const packetGeometry = new THREE.BoxGeometry(9, 6, 9);
  const pulses: Pulse[] = [];
  const addPulse = (
    points: THREE.Vector3[],
    color: THREE.ColorRepresentation,
    speed: number,
    loop: boolean,
    delay = 0,
    geometry: THREE.BufferGeometry = pulseGeometry,
  ) => {
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ color, transparent: true }),
    );
    mesh.visible = false;
    scene.add(mesh);
    const pulse = { mesh, points, t: 0, speed, loop, delay };
    pulses.push(pulse);
    return pulse;
  };
  const removePulse = (pulse: Pulse) => {
    scene.remove(pulse.mesh);
    (pulse.mesh.material as THREE.Material).dispose();
    pulses.splice(pulses.indexOf(pulse), 1);
  };
  const pointAt = (points: THREE.Vector3[], t: number, out: THREE.Vector3) => {
    const f = t * (points.length - 1);
    const i = Math.min(points.length - 2, Math.floor(f));
    return out.lerpVectors(points[i], points[i + 1], f - i);
  };

  /** 实时流的常驻数据包。 */
  const livePulses = ingest
    .filter((i) => i.target === 'live')
    .flatMap((i) =>
      [0, 0.33, 0.66].map((offset) => ({
        pulse: addPulse(i.points, sourceById.get('live')!.color, 0.45, true),
        offset,
        plant: i.plant,
      })),
    );
  for (const { pulse, offset } of livePulses) pulse.t = offset;

  /** 查询所用数据源到图谱的数据包。 */
  let feedPulses: Pulse[] = [];
  let answerLines: Line2[] = [];
  let answerPulses: Pulse[] = [];

  // ── 状态 ──
  let sources: ReadonlySet<SourceId> = new Set(SOURCES.map((s) => s.id));
  let used: SourceId[] = [];
  let hits: TurbineId[] = [];
  let hotTips = new Set<string>();
  let selected: TurbineId | null = null;
  let simTime = 0;
  let lastBatchIndex = -1;
  let playing = false;
  let queryGlow = 0;

  // ── 配色：深蓝底色，轮廓线发出青色荧光 ──
  scene.background = new THREE.Color(NEON.background);
  stage.fog.color.set(NEON.background);
  groundMaterial.color.set(NEON.ground);
  (grid.material as THREE.LineBasicMaterial).color.set(NEON.grid);
  (grid.material as THREE.LineBasicMaterial).opacity = 0.55;
  padMaterial.color.set(NEON.pad);
  sourcePadMaterial.color.set(NEON.pad);
  metal.color.set(0x1d3556);
  casing.color.set(0x213d63);
  generatorMaterial.color.set(0x16304f);
  skidMaterial.color.set(0x0f2140);
  bladeMaterial.color.set(0x5d8fc4);
  baseMaterial.color.set(0x0f2140);
  stage.hemi.color.set(0x4a78c8);
  stage.hemi.groundColor.set(0x030712);
  stage.hemi.intensity = 1.6;
  stage.sun.color.set(0x9cc4ff);
  stage.sun.intensity = 1.1;
  stage.renderer.toneMappingExposure = 1.15;
  stage.bloom.strength = 0.7;
  stage.bloom.threshold = 0.72;
  stage.bloom.radius = 0.45;
  for (const unit of units.values()) {
    for (const s of unit.smoke) (s.sprite.material as THREE.SpriteMaterial).color.set(0x6f8fb8);
  }
  hubDiscMaterial.opacity = 0.09;

  // ── 取景：面板占用的边距 ──
  let insets: Insets = { left: 0, right: 0, top: 0, bottom: 0 };
  const applyInsets = () => {
    const { clientWidth: w, clientHeight: h } = container;
    if (!w || !h) return;
    if (!moved) camera.position.copy(homePosition());
    camera.setViewOffset(
      w,
      h,
      (insets.right - insets.left) / 2,
      (insets.bottom - insets.top) / 2,
      w,
      h,
    );
    camera.updateProjectionMatrix();
  };
  const resizeObserver = new ResizeObserver(applyInsets);
  resizeObserver.observe(container);

  // ── 拾取 ──
  const pickTurbine = (event: PointerEvent) =>
    stage.pick(event, pickables)?.object.userData.turbine as TurbineId | undefined;
  stage.onClick((event) => {
    const id = pickTurbine(event);
    if (id) options.onSelect(id);
  });
  stage.onHover((event) => {
    stage.canvas.style.cursor = pickTurbine(event) ? 'pointer' : '';
  });
  pinLayer.addEventListener('click', (event) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>('.pin-unit');
    if (card?.dataset.turbine) options.onSelect(card.dataset.turbine as TurbineId);
  });

  // ── 每帧 ──
  const scratch = new THREE.Vector3();
  stage.onFrame((now, dt) => {
    const k = reduced ? 1 : damp(4, dt);
    const time = now / 1000;
    hubRing.rotation.z += dt * 0.15;
    graph.rotation.y += dt * 0.12;
    queryGlow = Math.max(0, queryGlow - dt * 0.35);
    hubMaterial.opacity = 0.65 + 0.35 * Math.max(queryGlow, 0.3 + 0.2 * Math.sin(time * 1.6));
    for (const line of graphLines) line.material.opacity = 0.35 + 0.4 * queryGlow;

    for (const unit of units.values()) {
      const v = unit.visual;
      const rpm = Number.isNaN(v.speed) ? 0 : v.speed;
      // 转子转速：额定 3000 rpm 时每秒约 1.5 圈（视觉上放慢）
      unit.spin += ((rpm / 3000) * 9 - unit.spin) * k;
      if (!reduced) unit.rotor.rotation.x += unit.spin * dt;
      const flameGoal = v.flame ? 0.75 : 0;
      unit.combustor.emissiveIntensity += (flameGoal - unit.combustor.emissiveIntensity) * k;
      const model = MODELS[turbineById.get(unit.id)!.model];
      unit.tips.forEach((tip, i) => {
        const temp = v.tips[i] ?? 0;
        const hot = hotTips.has(tip.tag);
        const level = v.flame ? Math.min(0.8, Math.max(0, (temp - 420) / 300)) : 0;
        const pulse = hot ? 0.6 + 0.6 * Math.abs(Math.sin(time * 4)) : 0;
        tip.material.emissive.copy(hot ? WARN : FLAME);
        tip.material.emissiveIntensity += (level + pulse * 2 - tip.material.emissiveIntensity) * k;
        tip.mesh.scale.setScalar(hot ? 1.5 : temp > model.tipLimit ? 1.3 : 1);
      });
      // 选中与命中的地面光环
      const ringMaterial = unit.ring.material as THREE.MeshBasicMaterial;
      const isHit = hits.includes(unit.id);
      const goal = isHit ? 0.55 + 0.3 * Math.sin(time * 3) : unit.id === selected ? 0.5 : 0;
      ringMaterial.color.copy(isHit ? WARN : ACCENT);
      ringMaterial.opacity += (goal - ringMaterial.opacity) * k;
      const scale = isHit && !reduced ? 1 + 0.06 * Math.sin(time * 3) : 1;
      unit.ring.scale.setScalar(scale);

      // 烟囱冒烟：出力越大越浓
      const rate = v.flame ? 1.5 + (v.power / model.capacity) * 9 : 0;
      unit.emit += rate * dt;
      for (const s of unit.smoke) {
        if (s.sprite.visible) {
          s.age += dt;
          const life = s.age / s.life;
          if (life >= 1) {
            s.sprite.visible = false;
            continue;
          }
          s.sprite.position.x += s.vx * dt;
          s.sprite.position.z += s.vz * dt;
          s.sprite.position.y += (16 + 10 * (1 - life)) * dt;
          const size = 10 + life * 34;
          s.sprite.scale.set(size, size, 1);
          (s.sprite.material as THREE.SpriteMaterial).opacity =
            0.32 * (1 - life) * Math.min(1, life * 6);
        } else if (unit.emit >= 1 && !reduced) {
          unit.emit -= 1;
          s.sprite.visible = true;
          s.age = 0;
          s.life = 3 + Math.random() * 1.5;
          s.vx = 8 + Math.random() * 6;
          s.vz = (Math.random() - 0.5) * 6;
          s.sprite.position
            .copy(unit.stackTop)
            .add(scratch.set((Math.random() - 0.5) * 4, 0, (Math.random() - 0.5) * 4));
        }
      }
      unit.emit = Math.min(unit.emit, 2);
    }

    // 数据源的开关
    for (const source of SOURCES) {
      const on = sources.has(source.id);
      const material = sourceMaterials.get(source.id)!;
      const isUsed = used.includes(source.id);
      const glow = on ? (isUsed ? 0.9 + 0.5 * queryGlow : 0.35) : 0;
      material.emissiveIntensity += (glow - material.emissiveIntensity) * k;
      material.color.set(on ? source.color : 0x1a2740);
      const line = feedLines.get(source.id)!;
      const lineGoal = on ? (isUsed ? 0.85 : 0.14) : 0;
      line.material.opacity += (lineGoal - line.material.opacity) * k;
      line.visible = line.material.opacity > 0.01;
    }
    for (const i of ingest) {
      const on = sources.has(i.target);
      i.line.material.opacity += ((on ? 0.45 : 0) - i.line.material.opacity) * k;
      i.line.visible = i.line.material.opacity > 0.01;
    }

    // 数据包
    for (const pulse of [...pulses]) {
      if (pulse.delay > 0) {
        pulse.delay -= dt;
        pulse.mesh.visible = false;
        continue;
      }
      pulse.t += pulse.speed * dt * (reduced ? 0 : 1);
      if (pulse.t >= 1) {
        if (pulse.loop) pulse.t -= 1;
        else {
          removePulse(pulse);
          continue;
        }
      }
      pulse.mesh.visible = true;
      pointAt(pulse.points, pulse.t, pulse.mesh.position);
    }
    for (const { pulse, plant } of livePulses) {
      const anyRunning = TURBINES.some(
        (t) => t.plant === plant && units.get(t.id)!.visual.speed > 5,
      );
      pulse.speed = playing ? 0.9 : 0.35;
      pulse.mesh.visible = pulse.mesh.visible && sources.has('live') && anyRunning;
    }
    for (const p of feedPulses) {
      const source = SOURCES.find((s) => feedPaths.get(s.id) === p.points)!;
      if (!sources.has(source.id)) p.mesh.visible = false;
    }
  });

  // ── 接口 ──
  const clearAnswers = () => {
    for (const line of answerLines) {
      scene.remove(line);
      line.geometry.dispose();
      line.material.dispose();
    }
    answerLines = [];
    for (const p of [...answerPulses]) if (pulses.includes(p)) removePulse(p);
    answerPulses = [];
  };

  const scene3d: TurbineScene = {
    setTime(t, isPlaying) {
      playing = isPlaying;
      const batchIndex = Math.floor(t / BATCH);
      // 播放跨过入库时刻时，向两座电厂的历史库各发一个数据包
      if (isPlaying && lastBatchIndex >= 0 && batchIndex > lastBatchIndex && t > simTime) {
        for (const i of ingest.filter((x) => x.target !== 'live' && sources.has(x.target))) {
          addPulse(i.points, sourceById.get(i.target)!.color, 0.6, false, 0, packetGeometry);
        }
      }
      lastBatchIndex = batchIndex;
      simTime = t;
    },
    setUnits(visuals, cards) {
      for (const unit of units.values()) {
        unit.visual = visuals[unit.id];
        const card = cards[unit.id];
        const el = unit.pin.element;
        const html = cardHtml(unit.id, card);
        if (el.dataset.html !== html) {
          el.innerHTML = html;
          el.dataset.html = html;
        }
        el.classList.toggle('is-hit', card.hit);
        el.classList.toggle('is-involved', card.involved && !card.hit);
        el.classList.toggle('is-selected', unit.id === selected);
      }
    },
    setSources(next) {
      sources = next;
      for (const [id, pin] of sourcePins) pin.element.classList.toggle('is-off', !next.has(id));
    },
    showQuery(nextUsed, nextHits, nextHot, fresh) {
      const changed = fresh || nextHits.join() !== hits.join();
      used = nextUsed;
      hits = nextHits;
      hotTips = new Set(nextHot);
      for (const [id, pin] of sourcePins)
        pin.element.classList.toggle('is-used', nextUsed.includes(id));
      if (fresh) {
        for (const p of feedPulses) if (pulses.includes(p)) removePulse(p);
        feedPulses = nextUsed.flatMap((id) =>
          [0, 0.5].map((delay) =>
            addPulse(feedPaths.get(id)!, sourceById.get(id)!.color, 0.7, true, delay),
          ),
        );
        queryGlow = 1;
      }
      if (changed) {
        clearAnswers();
        for (const id of nextHits) {
          const unit = units.get(id)!;
          const to = unit.pin.anchor.clone().setY(unit.pin.anchor.y - 6);
          const from = HUB.clone().add(
            to.clone().sub(HUB).setY(0).normalize().multiplyScalar(HUB_RADIUS),
          );
          const points = arc(from, to, 30, 20);
          const line = stage.makeLine(points, WARN, 1.6, 0.7, true);
          scene.add(line);
          answerLines.push(line);
          answerPulses.push(addPulse(points, WARN, 0.6, true, fresh ? 0.9 : 0));
        }
      }
    },
    setPlantInfo(info) {
      for (const plant of Object.values(PLANTS)) {
        plantPins[plant.id].element.querySelector('span')!.textContent = info[plant.id];
      }
    },
    select(turbine) {
      selected = turbine;
      for (const unit of units.values())
        unit.pin.element.classList.toggle('is-selected', unit.id === turbine);
    },
    setInsets(next) {
      insets = next;
      applyInsets();
    },
    resetView() {
      moved = false;
      stage.flyToPose(homePosition(), HOME.target.clone());
    },
    tour(step) {
      stage.removePins('pin-marker');
      if (!step) return;
      const unit = units.get(step.turbine ?? 'A3')!;
      unit.group.updateMatrixWorld();
      const local = (x: number, y: number, z = 0) =>
        unit.group.localToWorld(new THREE.Vector3(x, y, z));
      let position: THREE.Vector3;
      let target: THREE.Vector3;
      let anchor: THREE.Vector3 | null = null;
      switch (step.focus) {
        case 'overview':
          position = HOME.target.clone().add(homePosition().sub(HOME.target).multiplyScalar(0.78));
          target = HOME.target.clone();
          break;
        case 'turbine':
          target = local(10, 30);
          position = target.clone().add(new THREE.Vector3(240, 130, 110));
          anchor = local(-54, 40);
          break;
        case 'tips':
          target = local(29, 22);
          position = target.clone().add(new THREE.Vector3(120, 55, 30));
          anchor = local(29, 40);
          break;
        case 'sources':
          target = new THREE.Vector3(0, 30, SOURCE_Z);
          position = new THREE.Vector3(0, 430, SOURCE_Z + 780);
          anchor = new THREE.Vector3(0, 60, SOURCE_Z);
          break;
        case 'ingest': {
          const live = ingest.find((i) => i.plant === 'A' && i.target === 'live')!;
          target = new THREE.Vector3(-90, 10, -220);
          position = new THREE.Vector3(70, 330, 160);
          anchor = live.points[Math.floor(live.points.length / 2)].clone();
          break;
        }
        case 'hub':
          target = HUB.clone().setY(HUB.y - 40);
          position = HUB.clone().add(new THREE.Vector3(0, 230, 600));
          anchor = HUB.clone().add(new THREE.Vector3(0, 8, HUB_RADIUS));
          break;
        case 'demo':
          target = new THREE.Vector3(-60, 60, -110);
          position = new THREE.Vector3(140, 520, 700);
          anchor = local(29, 40);
          break;
      }
      moved = step.focus !== 'overview';
      stage.flyToPose(position, target, 1800);
      if (anchor && step.marker) {
        stage.addPin(`<i></i><span>${escapeHtml(step.marker)}</span>`, anchor, 'pin-marker');
      }
    },
    dispose() {
      resizeObserver.disconnect();
      soft.dispose();
      stage.dispose();
    },
  };
  return scene3d;
}
