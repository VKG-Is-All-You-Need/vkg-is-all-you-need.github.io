/**
 * “VKG × 设备诊断”示例的三维场景。由 scripts/turbine/controller.ts 在场景进入视口后按需加载。
 *
 * 前方是两座电厂、八台燃气轮机。外壳半透明，可以看到内部的压气机与涡轮叶片级、燃烧室与轴承座：
 * 转子随转速转动，有火焰时燃烧室发光、烟囱冒烟，出力越大烟越浓。每个传感器都单独建模，
 * 悬停可查看编号与读数，查询用到的传感器会亮起。
 * 后方是八个数据源：电厂的信号持续流入实时流，每 10 分钟批量写入各自的历史库。
 * 上方的环表示虚拟知识图谱：选中查询时，所用数据源的连线亮起，汇入图谱，结果再落到命中的机组上。
 */
import * as THREE from 'three';
import type { Line2 } from 'three/addons/lines/Line2.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { tr } from '../../i18n/runtime';
import {
  MODELS,
  PLANTS,
  TURBINES,
  SENSOR_UNITS,
  componentById,
  componentLabel,
  sensorKindLabel,
  sensorsOf,
  turbineById,
  type PlantId,
  type Sensor,
  type SensorKind,
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
  /** 各传感器此刻的读数，按传感器编号索引。 */
  readings: Record<string, number>;
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
  /** 查询用到的传感器与命中的传感器。 */
  setSensorFocus(used: string[], hit: string[]): void;
  setPlantInfo(info: Record<PlantId, string>): void;
  select(turbine: TurbineId | null): void;
  setInsets(insets: Insets): void;
  resetView(): void;
  /** 导览：镜头飞向某处，并在该处标出提示点；传入 null 时移除提示点。 */
  tour(step: TourFocus | null): void;
  /** 切换暗色与亮色配色。 */
  setMode(mode: SceneMode): void;
  /** 镜头移向某台机组。 */
  focusUnit(turbine: TurbineId): void;
  /** 镜头移近某个传感器并标出它；传入 null 时恢复显示全部机组。 */
  focusSensor(tag: string | null): void;
  dispose(): void;
}

export type FocusKey =
  'overview' | 'turbine' | 'internals' | 'sources' | 'ingest' | 'hub' | 'demo' | 'pair';

export interface TourFocus {
  focus: FocusKey;
  turbine?: TurbineId;
  /** focus 为 pair 时同时取景的两台机组。 */
  turbines?: [TurbineId, TurbineId];
  /** 提示点旁的短标签。 */
  marker?: string;
  /** 标出该机组各类传感器的位置。 */
  labels?: boolean;
}

const PLANT_X: Record<PlantId, number> = { A: -200, B: 200 };
/** 同一电厂的四台机组左右并排。 */
const UNIT_SPACING = 78;
const UNIT_Z = 30;
const SOURCE_Z = -330;
const HUB = new THREE.Vector3(0, 190, -250);
const HUB_RADIUS = 64;
const HOME = {
  position: new THREE.Vector3(0, 790, 1230),
  target: new THREE.Vector3(0, 40, -110),
};
/** 强调色与报警色随配色切换（setMode 时原地修改）。 */
const WARN = new THREE.Color('#ffb547');
const ACCENT = new THREE.Color('#3fd0ff');
const FLAME = new THREE.Color('#ff8a3c');

/** 两套配色：暗色是深蓝底与青色荧光，亮色是浅底与深色描边。 */
const SCHEMES = {
  night: {
    background: 0x030816,
    fog: 0x071a3a,
    horizon: 0x0b2350,
    zenith: 0x01040c,
    ground: 0x050d1f,
    minor: 0x0f3a6e,
    major: 0x1d7fc4,
    ripple: 0x3fd0ff,
    pad: 0x081631,
    edge: 0x3fd0ff,
    edgeOpacity: 0.7,
    metal: 0x1d3556,
    casing: 0x3a6ea8,
    casingOpacity: 0.22,
    generator: 0x16304f,
    skid: 0x0f2140,
    blade: 0x7fb2e6,
    bladeEmissive: 0x123a66,
    base: 0x0f2140,
    hemiSky: 0x4a78c8,
    hemiGround: 0x030712,
    hemi: 1.6,
    sun: 0x9cc4ff,
    sunIntensity: 1.1,
    exposure: 1.15,
    bloom: 0.7,
    bloomThreshold: 0.72,
    smoke: 0x6f8fb8,
    smokeOpacity: 0.32,
    dust: 0x3fd0ff,
    dustOpacity: 0.55,
    stars: true,
    accent: 0x3fd0ff,
    warn: 0xffb547,
    sourceGlow: 0.25,
    sensorGlow: 0.35,
  },
  day: {
    background: 0xeef2f7,
    fog: 0xe8edf4,
    horizon: 0xf4f6f9,
    zenith: 0xc9d6e6,
    ground: 0xe9eef4,
    minor: 0xb7c4d4,
    major: 0x5f7590,
    ripple: 0x0077b6,
    pad: 0xffffff,
    edge: 0x0d2546,
    edgeOpacity: 0.85,
    metal: 0x4a5b72,
    casing: 0x1d4f8a,
    casingOpacity: 0.16,
    generator: 0x2a4a72,
    skid: 0xb9c4d2,
    blade: 0x1f5fa8,
    bladeEmissive: 0x000000,
    base: 0xcfd8e3,
    hemiSky: 0xffffff,
    hemiGround: 0xaab6c4,
    hemi: 1.9,
    sun: 0xffffff,
    sunIntensity: 2.3,
    exposure: 1.0,
    bloom: 0.12,
    bloomThreshold: 0.92,
    smoke: 0x6b7889,
    smokeOpacity: 0.4,
    dust: 0x0077b6,
    dustOpacity: 0.35,
    stars: false,
    accent: 0x0077b6,
    warn: 0xd9480f,
    sourceGlow: 0.1,
    sensorGlow: 0.15,
  },
} as const;

export type SceneMode = keyof typeof SCHEMES;

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
  return new THREE.Vector3(PLANT_X[turbine.plant] + (index - 1.5) * UNIT_SPACING, 0, UNIT_Z);
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

/** 传感器在机组局部坐标中的位置（机组轴线沿 x，发电机在 -x 端）。 */
function sensorPosition(sensor: Sensor, count: number): THREE.Vector3 {
  const i = sensor.index - 1;
  const SHAFT = 22;
  switch (sensor.kind) {
    case 'speed': {
      const a = -Math.PI / 2 + (i + 0.5) * (Math.PI / count);
      return new THREE.Vector3(-30, SHAFT + Math.sin(-a) * 5.5, Math.cos(a) * 5.5);
    }
    case 'inlet':
      return new THREE.Vector3(-23, SHAFT + 18.5, 0);
    case 'pressure':
      return new THREE.Vector3(16, SHAFT + 13.5, 0);
    case 'flame':
      return new THREE.Vector3(29, SHAFT + 17.5, 0);
    case 'fuel':
      return new THREE.Vector3(29, SHAFT - 17.5, 0);
    case 'tip': {
      const a = (i / count) * Math.PI * 2;
      return new THREE.Vector3(29, SHAFT + Math.cos(a) * 15.5, Math.sin(a) * 15.5);
    }
    case 'exhaust':
      return new THREE.Vector3(72, 31, 0);
    case 'vibration':
      return new THREE.Vector3(sensor.index === 1 ? -34 : 62, 12, 7.5);
    case 'bearingTemp':
      return new THREE.Vector3(sensor.index === 1 ? -34 : 62, 12, -7.5);
    case 'power':
      return new THREE.Vector3(-54, 37, 0);
  }
}

/** 亮色下传感器的颜色：更深、更饱和，在浅底上清楚可辨。 */
const SENSOR_COLORS_DAY: Record<SensorKind, number> = {
  speed: 0x0077b6,
  flame: 0xe8590c,
  tip: 0xe8590c,
  exhaust: 0xc92a2a,
  power: 0x2f9e44,
  vibration: 0x7048e8,
  inlet: 0x1c7ed6,
  pressure: 0x0c8f6c,
  fuel: 0xe67700,
  bearingTemp: 0xc2255c,
};

/** 传感器的颜色：转速、温度、压力等各用一种。 */
const SENSOR_COLORS: Record<SensorKind, number> = {
  speed: 0x3fd0ff,
  flame: 0xff8a3c,
  tip: 0xff8a3c,
  exhaust: 0xff6f6f,
  power: 0x9be15d,
  vibration: 0xc9a0ff,
  inlet: 0x7fe0ff,
  pressure: 0x5ee6c0,
  fuel: 0xffd166,
  bearingTemp: 0xff9fd0,
};

/** 一组叶片级：每一级是一个薄盘加一圈径向叶片，合并成一个几何体。 */
function bladeStages(stages: { x: number; r: number }[], blades: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const { x, r } of stages) {
    const disk = new THREE.CylinderGeometry(r * 0.45, r * 0.45, 1.6, 20);
    disk.rotateZ(Math.PI / 2);
    disk.translate(x, 0, 0);
    parts.push(disk);
    for (let b = 0; b < blades; b++) {
      const blade = new THREE.BoxGeometry(0.5, r * 0.5, 1.5);
      blade.translate(0, r * 0.45 + r * 0.275, 0);
      blade.rotateX((b / blades) * Math.PI * 2);
      blade.translate(x, 0, 0);
      parts.push(blade);
    }
  }
  const merged = mergeGeometries(parts.map((g) => g.toNonIndexed()));
  parts.forEach((g) => g.dispose());
  return merged;
}

interface SensorMesh {
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  sensor: Sensor;
  color: THREE.Color;
}

interface Unit {
  id: TurbineId;
  group: THREE.Group;
  rotor: THREE.Group;
  combustor: THREE.MeshStandardMaterial;
  crown: THREE.MeshBasicMaterial;
  sensors: SensorMesh[];
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
  options: {
    reducedMotion: boolean;
    mode: SceneMode;
    onSelect(turbine: TurbineId): void;
    onSelectSensor(tag: string): void;
  },
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
    color: SCHEMES.night.edge,
    transparent: true,
    opacity: 0.7,
  });
  const edgeCache = new Map<THREE.BufferGeometry, THREE.EdgesGeometry>();
  /** 场地轮廓线使用单独的材质，透明度不同。 */
  const padEdges: THREE.LineBasicMaterial[] = [];
  const outline = (mesh: THREE.Mesh, opacity?: number) => {
    let edges = edgeCache.get(mesh.geometry);
    if (!edges) {
      edges = new THREE.EdgesGeometry(mesh.geometry, 25);
      edgeCache.set(mesh.geometry, edges);
      stage.markShared(edges);
    }
    const material = opacity === undefined ? edgeMaterial : edgeMaterial.clone();
    if (opacity !== undefined) {
      material.opacity = opacity;
      padEdges.push(material);
    }
    mesh.add(new THREE.LineSegments(edges, material));
  };

  // ── 背景：发光网格地面、夜空渐变、星点与漂浮的光点 ──
  const groundUniforms = {
    time: { value: 0 },
    base: { value: new THREE.Color(SCHEMES.night.ground) },
    minor: { value: new THREE.Color(0x0f3a6e) },
    major: { value: new THREE.Color(0x1d7fc4) },
    ripple: { value: new THREE.Color(0x3fd0ff) },
    center: { value: new THREE.Vector2(HUB.x, HUB.z) },
  };
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(6000, 6000),
    new THREE.ShaderMaterial({
      uniforms: groundUniforms,
      vertexShader: `
        varying vec3 vWorld;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: `
        uniform float time;
        uniform vec3 base, minor, major, ripple;
        uniform vec2 center;
        varying vec3 vWorld;
        float grid(vec2 p, float size, float width) {
          vec2 q = p / size;
          vec2 g = abs(fract(q - 0.5) - 0.5) / (fwidth(q) * width);
          return 1.0 - min(min(g.x, g.y), 1.0);
        }
        void main() {
          vec2 p = vWorld.xz;
          float d = length(p - vec2(0.0, -80.0));
          float fade = 1.0 - smoothstep(350.0, 1700.0, d);
          vec3 color = base * (1.0 + 0.6 * (1.0 - smoothstep(0.0, 900.0, d)));
          // 网格线与底色混合而非叠加，浅底上的深色线条才不会溢出成白色
          color = mix(color, minor, grid(p, 26.0, 1.0) * 0.7 * fade);
          color = mix(color, major, grid(p, 130.0, 1.4) * 0.9 * fade);
          float r = length(p - center);
          float w = fract(r / 260.0 - time * 0.22);
          float ring = smoothstep(0.0, 0.015, w) * (1.0 - smoothstep(0.015, 0.06, w));
          color = mix(color, ripple, ring * 0.45 * (1.0 - smoothstep(150.0, 1100.0, r)));
          gl_FragColor = vec4(color, 1.0);
        }`,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.5;
  scene.add(ground);

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(4500, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        horizon: { value: new THREE.Color(0x0b2350) },
        zenith: { value: new THREE.Color(0x01040c) },
      },
      vertexShader: `
        varying float vHeight;
        void main() {
          vHeight = normalize(position).y;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 horizon, zenith;
        varying float vHeight;
        void main() {
          gl_FragColor = vec4(mix(horizon, zenith, smoothstep(-0.02, 0.45, vHeight)), 1.0);
        }`,
    }),
  );
  scene.add(sky);

  const random = (seed: number) => {
    const x = Math.sin(seed * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  };
  const starPositions = new Float32Array(900 * 3);
  for (let i = 0; i < 900; i++) {
    const a = random(i) * Math.PI * 2;
    const h = 0.08 + random(i + 0.5) * 0.9;
    const r = 4000;
    starPositions.set(
      [Math.cos(a) * Math.sqrt(1 - h * h) * r, h * r, Math.sin(a) * Math.sqrt(1 - h * h) * r],
      i * 3,
    );
  }
  const stars = new THREE.Points(
    new THREE.BufferGeometry().setAttribute(
      'position',
      new THREE.BufferAttribute(starPositions, 3),
    ),
    new THREE.PointsMaterial({
      color: 0x9cc8ff,
      size: 1.6,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.7,
      fog: false,
    }),
  );
  scene.add(stars);

  const DUST = 420;
  const dustPositions = new Float32Array(DUST * 3);
  for (let i = 0; i < DUST; i++) {
    dustPositions.set(
      [(random(i + 7) - 0.5) * 1500, random(i + 13) * 320, (random(i + 21) - 0.6) * 1100],
      i * 3,
    );
  }
  const dustGeometry = new THREE.BufferGeometry().setAttribute(
    'position',
    new THREE.BufferAttribute(dustPositions, 3),
  );
  const dust = new THREE.Points(
    dustGeometry,
    new THREE.PointsMaterial({
      color: 0x3fd0ff,
      size: 3.2,
      map: softTexture(),
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  scene.add(dust);

  const padMaterial = new THREE.MeshStandardMaterial({ roughness: 0.9 });
  const sourcePadMaterial = new THREE.MeshStandardMaterial({ roughness: 0.9 });
  const plantPins: Record<PlantId, Pin> = {} as Record<PlantId, Pin>;
  for (const plant of Object.values(PLANTS)) {
    const pad = new THREE.Mesh(padGeometry(350, 230, 18), padMaterial);
    pad.position.set(PLANT_X[plant.id], 0, UNIT_Z);
    pad.receiveShadow = true;
    outline(pad, 0.8);
    scene.add(pad);
    plantPins[plant.id] = stage.addPin(
      `<b>${escapeHtml(plant.name)}</b><span></span>`,
      new THREE.Vector3(PLANT_X[plant.id], 0, UNIT_Z + 124),
      'pin-plant',
    );
  }
  const sourcePad = new THREE.Mesh(padGeometry(830, 90, 20), sourcePadMaterial);
  sourcePad.position.set(0, 0, SOURCE_Z);
  sourcePad.receiveShadow = true;
  outline(sourcePad, 0.8);
  scene.add(sourcePad);

  // ── 燃气轮机 ──
  const metal = new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.35 });
  // 外壳半透明，露出内部的转子、燃烧室与传感器
  const casing = new THREE.MeshStandardMaterial({
    roughness: 0.3,
    metalness: 0.2,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const generatorMaterial = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.2 });
  const skidMaterial = new THREE.MeshStandardMaterial({ roughness: 0.8 });
  const bladeMaterial = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.5 });
  const neonMaterial = new THREE.MeshBasicMaterial({
    color: ACCENT,
    transparent: true,
    opacity: 0.85,
  });

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
    core: new THREE.CylinderGeometry(9, 9, 18, 24),
    band: new THREE.TorusGeometry(9.3, 0.55, 8, 40),
    crown: new THREE.TorusGeometry(8.4, 0.9, 8, 40),
    rotorShaft: new THREE.CylinderGeometry(2.6, 2.6, 100, 12),
    pedestal: new THREE.BoxGeometry(7, 14, 12),
    probe: new THREE.SphereGeometry(1.7, 10, 8),
    compressorStages: bladeStages(
      [-17, -11, -5, 1, 7, 13].map((x) => ({ x, r: 17 - ((x + 22) / 40) * 6 - 1.6 })),
      14,
    ),
    turbineStages: bladeStages(
      [44, 50, 57].map((x) => ({ x, r: 11 + ((x - 40) / 24) * 6 - 1.6 })),
      16,
    ),
  };
  Object.values(shared).forEach((g) => stage.markShared(g));

  const units = new Map<TurbineId, Unit>();
  const pickables: THREE.Object3D[] = [];
  /** 可悬停查看读数的传感器。 */
  const probes: THREE.Object3D[] = [];
  const cardHtml = (id: TurbineId, card?: UnitCard) => {
    const model = turbineById.get(id)!.model;
    return `<span class="uc-head"><b>${id}</b><i>${model}</i><em>${escapeHtml(card?.value ?? '')}</em></span><span class="uc-state">${escapeHtml(card?.state ?? '—')}</span>${card?.alert ? `<span class="uc-alert">${escapeHtml(card.alert)}</span>` : ''}`;
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
    const shell = add(shared.combustor, casing, 29, 22);
    shell.rotation.z = Math.PI / 2;
    // 燃烧室内的火焰核心
    const combustorMaterial = new THREE.MeshStandardMaterial({
      color: 0x2a1a14,
      roughness: 0.6,
      emissive: FLAME,
      emissiveIntensity: 0,
    });
    const core = new THREE.Mesh(shared.core, combustorMaterial);
    core.position.set(29, 22, 0);
    core.rotation.z = Math.PI / 2;
    core.userData.turbine = turbine.id;
    group.add(core);
    pickables.push(core);
    // 轴承座
    for (const x of [-34, 62]) add(shared.pedestal, skidMaterial, x, 12);
    const turbineCone = add(shared.turbine, casing, 52, 22);
    turbineCone.rotation.z = -Math.PI / 2;
    add(shared.duct, casing, 72, 18);
    add(shared.stack, metal, 72, 66);
    // 烟囱上的发光环；顶部的环在有火焰时变成橙色
    for (const y of [44, 70]) {
      const band = new THREE.Mesh(shared.band, neonMaterial);
      band.position.set(72, y, 0);
      band.rotation.x = Math.PI / 2;
      group.add(band);
    }
    const crownMaterial = new THREE.MeshBasicMaterial({ color: ACCENT });
    const crown = new THREE.Mesh(shared.crown, crownMaterial);
    crown.position.set(72, 103, 0);
    crown.rotation.x = Math.PI / 2;
    group.add(crown);

    // 转子：贯穿压气机与涡轮的主轴、各级叶片与进气端的叶片
    const rotor = new THREE.Group();
    rotor.position.set(0, 22, 0);
    const rotorShaft = new THREE.Mesh(shared.rotorShaft, metal);
    rotorShaft.rotation.z = Math.PI / 2;
    rotorShaft.position.x = 16;
    rotor.add(rotorShaft);
    rotor.add(new THREE.Mesh(shared.compressorStages, bladeMaterial));
    rotor.add(new THREE.Mesh(shared.turbineStages, bladeMaterial));
    const hub = new THREE.Mesh(shared.hub, bladeMaterial);
    hub.rotation.z = Math.PI / 2;
    hub.position.x = -23;
    rotor.add(hub);
    for (let i = 0; i < 8; i++) {
      const blade = new THREE.Mesh(shared.blade, bladeMaterial);
      blade.position.set(
        -23,
        Math.cos((i / 8) * Math.PI * 2) * 6,
        Math.sin((i / 8) * Math.PI * 2) * 6,
      );
      blade.rotation.x = (i / 8) * Math.PI * 2;
      rotor.add(blade);
    }
    group.add(rotor);

    // 传感器：每个都单独建模，颜色按类型区分
    const sensorMeshes: SensorMesh[] = sensorsOf(turbine.id)
      .filter((sensor) => sensor.kind !== 'tip')
      .map((sensor) => {
        const color = new THREE.Color(SENSOR_COLORS[sensor.kind]);
        const material = new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: 0.35,
          roughness: 0.4,
        });
        const mesh = new THREE.Mesh(shared.probe, material);
        const count = sensorsOf(turbine.id, sensor.kind).length;
        mesh.position.copy(sensorPosition(sensor, count));
        mesh.userData = { turbine: turbine.id, tag: sensor.tag };
        group.add(mesh);
        probes.push(mesh);
        return { mesh, material, sensor, color };
      });

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
      mesh.userData = { turbine: turbine.id, tag: sensor.tag };
      probes.push(mesh);
      sensorMeshes.push({ mesh, material, sensor, color: FLAME.clone() });
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

    // 相邻机组的卡片高低错开，避免重叠
    const index = TURBINES.filter((t) => t.plant === turbine.plant).indexOf(turbine);
    const pin = stage.addPin(
      cardHtml(turbine.id),
      group.position.clone().add(new THREE.Vector3(0, index % 2 ? 170 : 100, 0)),
      'pin-unit',
    );
    pin.element.dataset.turbine = turbine.id;
    units.set(turbine.id, {
      id: turbine.id,
      group,
      rotor,
      combustor: combustorMaterial,
      crown: crownMaterial,
      sensors: sensorMeshes,
      tips,
      ring,
      pin,
      smoke,
      stackTop: (group.updateMatrixWorld(), group.localToWorld(new THREE.Vector3(72, 104, 0))),
      visual: { speed: 0, flame: false, power: 0, tips: [], readings: {} },
      spin: 0,
      emit: 0,
    });
  }

  // ── 数据源与知识图谱 ──
  const sourceMaterials = new Map<SourceId, THREE.MeshStandardMaterial>();
  const sourcePins = new Map<SourceId, Pin>();
  const baseMaterial = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.2 });
  const diskGeometry = new THREE.CylinderGeometry(20, 20, 6, 32);
  const sourceRingGeometry = new THREE.TorusGeometry(20, 0.6, 6, 48);
  const sourceRings = new Map<SourceId, THREE.MeshBasicMaterial>();
  const baseGeometry = new THREE.CylinderGeometry(24, 26, 10, 32);
  for (const source of SOURCES) {
    const x = SOURCE_X[source.id];
    const base = new THREE.Mesh(baseGeometry, baseMaterial);
    base.position.set(x, 5, SOURCE_Z);
    base.castShadow = true;
    scene.add(base);
    // 半透明的盘体，边缘是发光的环
    const material = new THREE.MeshStandardMaterial({
      color: source.color,
      emissive: source.color,
      emissiveIntensity: 0.25,
      roughness: 0.3,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
    });
    const ringMaterial = new THREE.MeshBasicMaterial({ color: source.color, transparent: true });
    for (let i = 0; i < 3; i++) {
      const disk = new THREE.Mesh(diskGeometry, material);
      disk.position.set(x, 13 + i * 7.5, SOURCE_Z);
      scene.add(disk);
      for (const dy of [-3, 3]) {
        const ring = new THREE.Mesh(sourceRingGeometry, ringMaterial);
        ring.position.set(x, 13 + i * 7.5 + dy, SOURCE_Z);
        ring.rotation.x = Math.PI / 2;
        scene.add(ring);
      }
    }
    sourceRings.set(source.id, ringMaterial);
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

  // ── 配色：暗色为深蓝底与青色荧光，亮色为浅底与深色描边 ──
  let scheme: (typeof SCHEMES)[SceneMode] = SCHEMES[options.mode];
  /** 自发光强度的缩放：亮色背景下降低，避免颜色发白。 */
  let glowScale = 1;
  const applyMode = (mode: SceneMode) => {
    scheme = SCHEMES[mode];
    glowScale = mode === 'day' ? 0.4 : 1;
    ACCENT.set(scheme.accent);
    WARN.set(scheme.warn);
    scene.background = new THREE.Color(scheme.background);
    stage.fog.color.set(scheme.fog);
    // 亮色下雾会把物体冲淡，推到更远处
    stage.fog.near = mode === 'day' ? 2600 : 900;
    stage.fog.far = mode === 'day' ? 6000 : 2600;
    const skyUniforms = (sky.material as THREE.ShaderMaterial).uniforms;
    skyUniforms.horizon.value.set(scheme.horizon);
    skyUniforms.zenith.value.set(scheme.zenith);
    groundUniforms.base.value.set(scheme.ground);
    groundUniforms.minor.value.set(scheme.minor);
    groundUniforms.major.value.set(scheme.major);
    groundUniforms.ripple.value.set(scheme.ripple);
    stars.visible = scheme.stars;
    const dustMaterial = dust.material as THREE.PointsMaterial;
    dustMaterial.color.set(scheme.dust);
    dustMaterial.opacity = scheme.dustOpacity;
    dustMaterial.blending = mode === 'day' ? THREE.NormalBlending : THREE.AdditiveBlending;
    dustMaterial.needsUpdate = true;
    padMaterial.color.set(scheme.pad);
    sourcePadMaterial.color.set(scheme.pad);
    edgeMaterial.color.set(scheme.edge);
    edgeMaterial.opacity = scheme.edgeOpacity;
    for (const material of padEdges) material.color.set(scheme.edge);
    metal.color.set(scheme.metal);
    casing.color.set(scheme.casing);
    casing.opacity = scheme.casingOpacity;
    generatorMaterial.color.set(scheme.generator);
    skidMaterial.color.set(scheme.skid);
    bladeMaterial.color.set(scheme.blade);
    bladeMaterial.emissive.set(scheme.bladeEmissive);
    baseMaterial.color.set(scheme.base);
    stage.hemi.color.set(scheme.hemiSky);
    stage.hemi.groundColor.set(scheme.hemiGround);
    stage.hemi.intensity = scheme.hemi;
    stage.sun.color.set(scheme.sun);
    stage.sun.intensity = scheme.sunIntensity;
    stage.renderer.toneMappingExposure = scheme.exposure;
    stage.bloom.strength = scheme.bloom;
    // 浅色背景本身就超过泛光阈值，亮色下关闭泛光，否则整个画面会蒙上一层光晕
    stage.bloom.enabled = mode !== 'day';
    stage.bloom.threshold = scheme.bloomThreshold;
    stage.bloom.radius = 0.45;
    // 数据源盘体：亮色下更不透明，避免在浅底上发淡
    for (const material of sourceMaterials.values())
      material.opacity = mode === 'day' ? 0.78 : 0.32;
    neonMaterial.color.copy(ACCENT);
    hubMaterial.color.copy(ACCENT);
    hubDiscMaterial.color.copy(ACCENT);
    hubDiscMaterial.opacity = mode === 'day' ? 0.12 : 0.09;
    nodeMaterial.color.copy(ACCENT);
    for (const line of graphLines) line.material.color.copy(ACCENT);
    for (const unit of units.values()) {
      for (const smoke of unit.smoke) {
        (smoke.sprite.material as THREE.SpriteMaterial).color.set(scheme.smoke);
      }
      // 喷嘴在亮色下用深橙褐色，避免白色小球在浅底上发淡
      for (const tip of unit.tips) tip.material.color.set(mode === 'day' ? 0x9a3a10 : 0xffffff);
      for (const sensor of unit.sensors) {
        if (sensor.sensor.kind === 'tip') continue;
        sensor.color.set((mode === 'day' ? SENSOR_COLORS_DAY : SENSOR_COLORS)[sensor.sensor.kind]);
        sensor.material.color.copy(sensor.color);
      }
    }
  };
  applyMode(options.mode);

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

  // ── 拾取与悬停 ──
  stage.onClick((event) => {
    const hit = stage.pick(event, [...probes, ...pickables]);
    const tag = hit?.object.userData.tag as string | undefined;
    if (tag) options.onSelectSensor(tag);
    else if (hit?.object.userData.turbine)
      options.onSelect(hit.object.userData.turbine as TurbineId);
  });
  const probePin = stage.addPin('', new THREE.Vector3(), 'pin-probe', 'both', false);
  let hovered: string | null = null;
  const probeHtml = (tag: string) => {
    const sensor = [...units.values()]
      .flatMap((u) => u.sensors)
      .find((s) => s.sensor.tag === tag)!.sensor;
    const value = units.get(sensor.turbine)!.visual.readings[tag];
    const unit = SENSOR_UNITS[sensor.kind];
    const reading =
      value === undefined || Number.isNaN(value)
        ? '—'
        : sensor.kind === 'flame'
          ? value > 0.5
            ? tr('有火焰', 'Flame on')
            : tr('无火焰', 'No flame')
          : `${value.toLocaleString('en-US', { maximumFractionDigits: Math.abs(value) < 10 ? 2 : 1 })} ${unit}`;
    return `<b>${tag}</b><span>${escapeHtml(sensorKindLabel(sensor.kind))} · ${escapeHtml(componentLabel(componentById.get(sensor.component)!))}</span><em>${escapeHtml(reading)}</em>`;
  };
  stage.onHover((event) => {
    const hit = stage.pick(event, [...probes, ...pickables]);
    const tag = hit?.object.userData.tag as string | undefined;
    stage.canvas.style.cursor = hit ? 'pointer' : '';
    hovered = tag ?? null;
    probePin.shown = !!tag;
    if (tag) {
      (hit!.object as THREE.Mesh).getWorldPosition(probePin.anchor);
      probePin.anchor.y += 3;
      probePin.element.innerHTML = probeHtml(tag);
    }
  });
  let usedTags = new Set<string>();
  let hitTags = new Set<string>();
  // 卡片内容随播放刷新，按下时即响应，避免 click 因元素被替换而丢失
  pinLayer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const card = (event.target as HTMLElement).closest<HTMLElement>('.pin-unit');
    if (card?.dataset.turbine) options.onSelect(card.dataset.turbine as TurbineId);
  });

  // ── 每帧 ──
  const scratch = new THREE.Vector3();
  stage.onFrame((now, dt) => {
    const k = reduced ? 1 : damp(4, dt);
    const time = now / 1000;
    groundUniforms.time.value = reduced ? 0 : time;
    if (!reduced) {
      const array = dustGeometry.attributes.position.array as Float32Array;
      for (let i = 0; i < DUST; i++) {
        array[i * 3 + 1] += dt * (4 + (i % 5));
        if (array[i * 3 + 1] > 320) array[i * 3 + 1] = 0;
      }
      dustGeometry.attributes.position.needsUpdate = true;
    }
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
      unit.crown.color.copy(v.flame ? FLAME : ACCENT);
      unit.combustor.emissiveIntensity += (flameGoal - unit.combustor.emissiveIntensity) * k;
      const model = MODELS[turbineById.get(unit.id)!.model];
      unit.tips.forEach((tip, i) => {
        const temp = v.tips[i] ?? 0;
        const hot = hotTips.has(tip.tag) || hitTags.has(tip.tag);
        const level = v.flame ? Math.min(0.8, Math.max(0, (temp - 420) / 300)) : 0;
        const pulse = hot ? 0.6 + 0.6 * Math.abs(Math.sin(time * 4)) : 0;
        tip.material.emissive.copy(hot ? WARN : FLAME);
        tip.material.emissiveIntensity += (level + pulse * 2 - tip.material.emissiveIntensity) * k;
        tip.mesh.scale.setScalar(hot ? 1.5 : temp > model.tipLimit ? 1.3 : 1);
      });
      // 传感器：查询用到的亮起，命中的闪烁
      for (const s of unit.sensors) {
        if (s.sensor.kind === 'tip') continue;
        const isHitTag = hitTags.has(s.sensor.tag);
        const isUsed = usedTags.has(s.sensor.tag);
        const glow = isHitTag
          ? 1.2 + Math.abs(Math.sin(time * 4)) * 1.5
          : isUsed
            ? 1.3
            : s.sensor.kind === 'flame' && v.flame
              ? 0.9
              : 0.3 * glowScale;
        s.material.emissive.copy(isHitTag ? WARN : s.color);
        s.material.emissiveIntensity += (glow - s.material.emissiveIntensity) * k;
        s.mesh.scale.setScalar(isHitTag ? 1.6 : isUsed ? 1.3 : 1);
      }

      // 选中与命中的地面光环
      const ringMaterial = unit.ring.material as THREE.MeshBasicMaterial;
      const isHit = hits.includes(unit.id);
      const goal = isHit ? 0.55 + 0.3 * Math.sin(time * 3) : unit.id === selected ? 0.5 : 0;
      ringMaterial.color.copy(isHit ? WARN : ACCENT);
      ringMaterial.opacity += (goal - ringMaterial.opacity) * k;
      const scale = isHit && !reduced ? 1 + 0.06 * Math.sin(time * 3) : 1;
      unit.ring.scale.setScalar(scale);

      // 烟囱冒烟：出力越大越浓
      const rate = v.flame && unit.group.visible ? 1.5 + (v.power / model.capacity) * 9 : 0;
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
            scheme.smokeOpacity * (1 - life) * Math.min(1, life * 6);
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
      const glow = on ? (isUsed ? 0.45 + 0.4 * queryGlow : 0.2) * glowScale : 0;
      material.emissiveIntensity += (glow - material.emissiveIntensity) * k;
      material.color.set(on ? source.color : 0x1a2740);
      const ring = sourceRings.get(source.id)!;
      ring.color.set(on ? source.color : 0x22324d);
      ring.opacity = on ? (isUsed ? 1 : 0.6) : 0.4;
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
  /** 只显示某台机组（看内部或传感器时），传入 null 时全部显示。 */
  const isolateUnit = (id: TurbineId | null) => {
    for (const u of units.values()) {
      const visible = !id || u.id === id;
      u.group.visible = visible;
      u.pin.shown = visible;
    }
  };
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
        // 只更新变化的文字；报警说明在内容变化时才重建，入场动画只播放一次
        const value = el.querySelector('.uc-head em');
        const state = el.querySelector('.uc-state');
        if (!value || !state) {
          el.innerHTML = cardHtml(unit.id, card);
        } else {
          if (value.textContent !== card.value) value.textContent = card.value;
          if (state.textContent !== card.state) state.textContent = card.state;
          const alert = el.querySelector('.uc-alert');
          if ((alert?.textContent ?? undefined) !== card.alert) {
            alert?.remove();
            if (card.alert) {
              const next = document.createElement('span');
              next.className = 'uc-alert';
              next.textContent = card.alert;
              el.append(next);
            }
          }
        }
        el.classList.toggle('is-hit', card.hit);
        el.classList.toggle('is-involved', card.involved && !card.hit);
        el.classList.toggle('is-selected', unit.id === selected);
      }
      if (hovered) probePin.element.innerHTML = probeHtml(hovered);
    },
    setSensorFocus(used, hit) {
      usedTags = new Set(used);
      hitTags = new Set(hit);
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
      stage.removePins('pin-sensor');
      // 看机组内部时只保留这一台，其余机组暂时隐去
      isolateUnit(step?.focus === 'internals' ? (step.turbine ?? 'A3') : null);
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
        case 'internals':
          target = local(8, 6);
          position = target.clone().add(new THREE.Vector3(205, 95, 26));
          anchor = null;
          break;
        case 'pair': {
          const [a, b] = (step.turbines ?? ['A1', 'A2']).map((id) => units.get(id)!.group.position);
          target = a.clone().add(b).multiplyScalar(0.5).setY(60);
          const span = Math.max(160, a.distanceTo(b));
          position = target.clone().add(new THREE.Vector3(0, span * 0.75 + 120, span * 1.05 + 160));
          anchor = local(0, 60);
          break;
        }
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
      if (step.labels) {
        // 每类传感器标一次，注明数量
        const seen = new Set<SensorKind>();
        for (const s of unit.sensors) {
          if (seen.has(s.sensor.kind)) continue;
          const group = unit.sensors.filter((x) => x.sensor.kind === s.sensor.kind);
          const count = group.length;
          // 喷嘴的标签放在侧面的喷嘴上，避免与上方的火焰传感器重叠
          if (s.sensor.kind === 'tip' && s !== group[Math.floor(count / 4)]) continue;
          seen.add(s.sensor.kind);
          const world = s.mesh.getWorldPosition(new THREE.Vector3());
          stage.addPin(
            `<i style="--c:#${s.color.getHexString()}"></i>${escapeHtml(sensorKindLabel(s.sensor.kind))}${count > 1 ? ` ×${count}` : ''}`,
            world,
            'pin-sensor',
          );
        }
      }
    },
    setMode(mode) {
      applyMode(mode);
    },
    focusUnit(turbine) {
      const unit = units.get(turbine)!;
      isolateUnit(null);
      stage.removePins('pin-focus');
      const target = unit.group.position.clone().setY(40);
      moved = true;
      stage.flyToPose(target.clone().add(new THREE.Vector3(150, 190, 260)), target, 1200);
    },
    focusSensor(tag) {
      stage.removePins('pin-focus');
      if (!tag) {
        isolateUnit(null);
        return;
      }
      const sensor = [...units.values()]
        .flatMap((u) => u.sensors)
        .find((x) => x.sensor.tag === tag);
      if (!sensor) return;
      isolateUnit(sensor.sensor.turbine);
      const world = sensor.mesh.getWorldPosition(new THREE.Vector3());
      stage.addPin('<i></i>', world.clone(), 'pin-focus');
      moved = true;
      stage.flyToPose(world.clone().add(new THREE.Vector3(150, 75, 70)), world, 1200);
    },
    dispose() {
      resizeObserver.disconnect();
      soft.dispose();
      stage.dispose();
    },
  };
  return scene3d;
}
