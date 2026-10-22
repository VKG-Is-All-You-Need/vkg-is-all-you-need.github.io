/**
 * “VKG × 地理信息”示例的三维场景（three.js）。
 * 由 scripts/geo/controller.ts 在场景进入视口后按需加载。
 *
 * 两种视图：
 * - 城市：PostGIS 中的街区数据以三维城市呈现。
 * - 分层：自下而上为数据源、映射、虚拟知识图谱与本体，查询按“本体推理 → 映射改写 → 空间 SQL → 返回结果”逐层播放。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import {
  CITY,
  FACILITY_CLASS,
  FLOOR_HEIGHT,
  GRID,
  type Building,
  type BuildingKind,
  type City,
} from '../../lib/geo/city';
import { pointInPolygon, rectCenter, seededRandom, type Point } from '../../lib/geo/spatial';
import type { Focus, LayerPlan } from '../../lib/geo/queries';

export type Mode = 'day' | 'night';
export type View = 'layers' | 'city';

export interface PlanView {
  x: number;
  y: number;
  angle: number;
}

export interface SceneCallbacks {
  onSelect(id: number | null): void;
  onView(view: PlanView): void;
  /** 分层视图中查询动画进入的阶段：0 本体推理、1 映射改写、2 空间 SQL、3 返回结果。 */
  onPhase(phase: number): void;
}

export interface QueryState {
  /** 城市视图中命中建筑的标签（HTML）。 */
  hits: { id: number; label: string }[];
  focus: Focus;
  plan: LayerPlan;
  /** 分层视图中实体节点的标签（HTML），键为 b:12 / s:1 / p:1。 */
  entityLabels: Record<string, string>;
}

export interface GeoScene {
  showQuery(state: QueryState | null): void;
  select(id: number | null, label?: string): void;
  setMode(mode: Mode): void;
  setView(view: View): void;
  setAutoRotate(enabled: boolean): void;
  resetView(): void;
  dispose(): void;
}

const ACCENT = new THREE.Color('#49bbdd');
const AMBER = new THREE.Color('#e6c07b');
const BLOCK_HEIGHT = 1.2;

/** 分层视图中各层的高度（米）与建筑压缩比例。 */
const LAYER = { mapping: 190, graph: 380, ontology: 570 } as const;
const FLAT = 0.3;

/** 本体平台上各类的位置（世界坐标 x, z）。 */
const CLASS_POSITION: Record<string, [number, number]> = {
  ':Station': [-380, 40],
  ':Park': [-225, 40],
  ':Building': [-70, 40],
  ':School': [95, 130],
  ':Hospital': [200, 150],
  ':Library': [305, 150],
  ':Museum': [410, 130],
  ':PublicFacility': [250, -70],
};
const ONTOLOGY_HALF = { w: 500, d: 210 };
const STATIC_SUBCLASS: [string, string][] = [
  [':School', ':PublicFacility'],
  [':Hospital', ':PublicFacility'],
  [':Library', ':PublicFacility'],
  [':Museum', ':PublicFacility'],
];

/** 查询动画各阶段的起始时间（秒）。 */
const PHASES = [0, 0.9, 1.8, 2.6];

const PALETTE = {
  day: {
    background: 0xe3e8e9,
    ground: 0xb7bfc1,
    block: 0xeceae3,
    park: 0xaacb93,
    water: 0x6aa9bf,
    grid: 0xa9b2b3,
    marking: 0xf4f4ef,
    foliage: 0x77a463,
    hemiSky: 0xdcebf8,
    hemiGround: 0xa9a291,
    hemi: 1.35,
    sun: 0xfff0d8,
    sunIntensity: 3.1,
    exposure: 0.95,
    windows: 0,
    bloom: 0.1,
    dim: 0.42,
    plane: 0x2b5f74,
    planeOpacity: 0.14,
    outlineOpacity: 0.95,
    ink: 0x24303a,
    neutral: 0x8d979f,
  },
  night: {
    background: 0x05070a,
    ground: 0x0b0f14,
    block: 0x141920,
    park: 0x12241a,
    water: 0x0c2f3c,
    grid: 0x16202b,
    marking: 0x2a3440,
    foliage: 0x2f5c40,
    hemiSky: 0x30476a,
    hemiGround: 0x06080b,
    hemi: 0.7,
    sun: 0xa9bfff,
    sunIntensity: 0.55,
    exposure: 1.1,
    windows: 1.5,
    bloom: 0.9,
    dim: 0.7,
    plane: 0x49bbdd,
    planeOpacity: 0.045,
    outlineOpacity: 0.55,
    ink: 0xe8eef2,
    neutral: 0x55606b,
  },
} as const;

const KIND_COLOR: Record<BuildingKind, string> = {
  住宅: '#e7e1d6',
  办公: '#cfd9e0',
  商店: '#ead6c2',
  商场: '#e3d3c0',
  咖啡馆: '#d8a878',
  学校: '#c3d7b0',
  医院: '#e9eff3',
  图书馆: '#d3c6e0',
  博物馆: '#e2d2b0',
  茶室: '#cdb084',
  游客中心: '#d6d0c2',
};
const NIGHT_BASE = new THREE.Color('#1b2129');

const toWorld = ({ x, y }: Point, height = 0) =>
  new THREE.Vector3(x - CITY.width / 2, height, CITY.height / 2 - y);

const heightOf = (building: Building) => building.floors * FLOOR_HEIGHT;
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** 窗户纹理：黑底上随机点亮的暖色窗格，夜间作为自发光贴图。 */
function createWindowTexture(): THREE.CanvasTexture {
  const size = 256;
  const cells = 8;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  const random = seededRandom(7);
  const cell = size / cells;
  for (let row = 0; row < cells; row++) {
    for (let col = 0; col < cells; col++) {
      if (random() > 0.42) continue;
      const warmth = 190 + Math.round(random() * 60);
      ctx.fillStyle = `rgb(255, ${warmth}, ${Math.round(warmth * 0.6)})`;
      ctx.fillRect(col * cell + cell * 0.22, row * cell + cell * 0.2, cell * 0.56, cell * 0.5);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** 竖向渐隐纹理，用于城市视图中的光柱。 */
function createBeamTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createLinearGradient(0, 0, 0, 128);
  gradient.addColorStop(0, 'rgba(255,255,255,0)');
  gradient.addColorStop(1, 'rgba(255,255,255,1)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 4, 128);
  return new THREE.CanvasTexture(canvas);
}

/** 调整盒体 UV：侧面按楼层与开间重复窗户，屋顶与底面映射到纹理的黑色角落。 */
function buildingGeometry(w: number, h: number, d: number, random: () => number) {
  const geometry = new THREE.BoxGeometry(w, h, d);
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
  const offsetU = Math.floor(random() * 8) / 8;
  const offsetV = Math.floor(random() * 8) / 8;
  const faces = [d, d, 0, 0, w, w]; // px, nx, py, ny, pz, nz 的面宽
  faces.forEach((faceWidth, face) => {
    for (let v = face * 4; v < face * 4 + 4; v++) {
      if (faceWidth === 0) {
        uv.setXY(v, 0.001, 0.001);
      } else {
        uv.setXY(
          v,
          offsetU + (uv.getX(v) * faceWidth) / 4 / 8,
          offsetV + (uv.getY(v) * h) / FLOOR_HEIGHT / 8,
        );
      }
    }
  });
  uv.needsUpdate = true;
  return geometry;
}

/** 平面四边形的轮廓线（用于各层边框）。 */
function rectOutline(halfW: number, halfD: number): THREE.Vector3[] {
  return [
    new THREE.Vector3(-halfW, 0, -halfD),
    new THREE.Vector3(halfW, 0, -halfD),
    new THREE.Vector3(halfW, 0, halfD),
    new THREE.Vector3(-halfW, 0, halfD),
    new THREE.Vector3(-halfW, 0, -halfD),
  ];
}

interface Pin {
  element: HTMLElement;
  /** 分层视图中的锚点使用“完全展开”时的坐标，投影时按展开程度缩放高度。 */
  anchor: THREE.Vector3;
  view: View | 'both';
  shown: boolean;
}

interface BuildingEntry {
  building: Building;
  mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  base: THREE.Color;
  target: THREE.Color;
}

/** 按时间推进的动画片段：k 为 0 到 1 的进度。 */
interface Tween {
  t0: number;
  t1: number;
  update(k: number): void;
}

interface Particle {
  mesh: THREE.Mesh;
  from: THREE.Vector3;
  to: THREE.Vector3;
  start: number;
  duration: number;
}

export function createGeoScene(
  container: HTMLElement,
  pinLayer: HTMLElement,
  city: City,
  callbacks: SceneCallbacks,
  options: { mode: Mode; view: View; reducedMotion: boolean },
): GeoScene {
  const reduced = options.reducedMotion;
  let mode: Mode = options.mode;
  let view: View = options.view;
  let mix = view === 'layers' ? 1 : 0;

  // ── 渲染器与后期 ──
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.setAttribute('aria-hidden', 'true');
  container.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  const fog = new THREE.Fog(0x000000, 1300, 3200);
  scene.fog = fog;

  const camera = new THREE.PerspectiveCamera(36, 1, 5, 8000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 160;
  controls.maxDistance = 2800;
  controls.minPolarAngle = 0.2;
  controls.maxPolarAngle = 1.36;
  controls.autoRotateSpeed = 0.35;

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.8, 0.55, 0.78);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // ── 灯光 ──
  const hemi = new THREE.HemisphereLight();
  scene.add(hemi);
  const sun = new THREE.DirectionalLight();
  sun.position.set(-420, 640, 360);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, {
    left: -720,
    right: 720,
    top: 620,
    bottom: -620,
    near: 10,
    far: 2200,
  });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.8;
  scene.add(sun);

  // ── 地面、网格与街区 ──
  const groundMaterial = new THREE.MeshStandardMaterial({ roughness: 1 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), groundMaterial);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const grid = new THREE.GridHelper(3200, 40);
  const gridMaterial = grid.material as THREE.LineBasicMaterial;
  gridMaterial.transparent = true;
  gridMaterial.opacity = 0.55;
  grid.position.y = 0.05;
  scene.add(grid);

  const blockMaterial = new THREE.MeshStandardMaterial({ roughness: 0.95 });
  const blocks = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, BLOCK_HEIGHT, 1),
    blockMaterial,
    city.blocks.length,
  );
  const matrix = new THREE.Matrix4();
  city.blocks.forEach((block, i) => {
    const center = toWorld(rectCenter(block), BLOCK_HEIGHT / 2);
    matrix.compose(center, new THREE.Quaternion(), new THREE.Vector3(block.w, 1, block.h));
    blocks.setMatrixAt(i, matrix);
  });
  blocks.receiveShadow = true;
  scene.add(blocks);

  // 道路标线：沿街道中线的短虚线
  const dashes: THREE.Matrix4[] = [];
  const inPark = (x: number, y: number) => x > 640 && y > 360;
  for (let k = 1; k < GRID.cols; k++) {
    for (let y = 6; y < CITY.height; y += 14) {
      if (!inPark(k * GRID.width, y)) {
        dashes.push(new THREE.Matrix4().makeTranslation(toWorld({ x: k * GRID.width, y }, 0.08)));
      }
    }
  }
  for (let k = 1; k < GRID.rows; k++) {
    for (let x = 6; x < CITY.width; x += 14) {
      if (!inPark(x, k * GRID.height)) {
        dashes.push(
          new THREE.Matrix4()
            .makeRotationY(Math.PI / 2)
            .setPosition(toWorld({ x, y: k * GRID.height }, 0.08)),
        );
      }
    }
  }
  const markingMaterial = new THREE.MeshBasicMaterial();
  const markings = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.6, 0.06, 6),
    markingMaterial,
    dashes.length,
  );
  dashes.forEach((m, i) => markings.setMatrixAt(i, m));
  scene.add(markings);

  // ── 公园与湖 ──
  const park = city.parks[0];
  const parkShape = new THREE.Shape(
    park.area.map((p) => new THREE.Vector2(p.x - CITY.width / 2, p.y - CITY.height / 2)),
  );
  const parkMaterial = new THREE.MeshStandardMaterial({ roughness: 1 });
  const parkMesh = new THREE.Mesh(
    new THREE.ExtrudeGeometry(parkShape, { depth: BLOCK_HEIGHT, bevelEnabled: false }),
    parkMaterial,
  );
  parkMesh.rotation.x = -Math.PI / 2;
  parkMesh.receiveShadow = true;
  scene.add(parkMesh);

  const lakeShape = new THREE.Shape();
  lakeShape.absellipse(
    park.lake.center.x - CITY.width / 2,
    park.lake.center.y - CITY.height / 2,
    park.lake.rx,
    park.lake.ry,
    0,
    Math.PI * 2,
    false,
    0,
  );
  const waterMaterial = new THREE.MeshStandardMaterial({ roughness: 0.12, metalness: 0.35 });
  const lake = new THREE.Mesh(new THREE.ShapeGeometry(lakeShape, 64), waterMaterial);
  lake.rotation.x = -Math.PI / 2;
  lake.position.y = BLOCK_HEIGHT + 0.08;
  scene.add(lake);

  // ── 树木 ──
  const treeRandom = seededRandom(42);
  const treeSpots: { p: Point; s: number }[] = [];
  const nearBuilding = (p: Point, gap: number) =>
    city.buildings.some(
      ({ footprint: f }) =>
        p.x > f.x - gap && p.x < f.x + f.w + gap && p.y > f.y - gap && p.y < f.y + f.h + gap,
    );
  while (treeSpots.length < 90) {
    const p = { x: 652 + treeRandom() * 296, y: 372 + treeRandom() * 336 };
    const lakeDistance =
      ((p.x - park.lake.center.x) / (park.lake.rx + 10)) ** 2 +
      ((p.y - park.lake.center.y) / (park.lake.ry + 10)) ** 2;
    if (!pointInPolygon(p, park.area) || lakeDistance < 1 || nearBuilding(p, 8)) continue;
    treeSpots.push({ p, s: 4 + treeRandom() * 3 });
  }
  for (const block of city.blocks) {
    for (let x = block.x + 10; x < block.x + block.w - 6; x += 22) {
      for (const y of [block.y + 3, block.y + block.h - 3]) {
        if (!nearBuilding({ x, y }, 3))
          treeSpots.push({ p: { x, y }, s: 2.6 + treeRandom() * 1.2 });
      }
    }
  }
  const foliageMaterial = new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true });
  const foliage = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1, 0),
    foliageMaterial,
    treeSpots.length,
  );
  const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x6b5a48, roughness: 1 });
  const trunks = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.35, 0.45, 1, 5),
    trunkMaterial,
    treeSpots.length,
  );
  const tint = new THREE.Color();
  treeSpots.forEach(({ p, s }, i) => {
    const base = toWorld(p, BLOCK_HEIGHT);
    matrix.compose(
      base.clone().setY(BLOCK_HEIGHT + s * 1.3),
      new THREE.Quaternion(),
      new THREE.Vector3(s, s * 1.2, s),
    );
    foliage.setMatrixAt(i, matrix);
    foliage.setColorAt(i, tint.setHSL(0, 0, 0.85 + treeRandom() * 0.3));
    matrix.compose(
      base.clone().setY(BLOCK_HEIGHT + s * 0.4),
      new THREE.Quaternion(),
      new THREE.Vector3(1, s * 0.8, 1),
    );
    trunks.setMatrixAt(i, matrix);
  });
  foliage.castShadow = trunks.castShadow = true;
  scene.add(foliage, trunks);

  // ── 建筑 ──
  const windowTexture = createWindowTexture();
  const buildingRandom = seededRandom(9);
  const entries = new Map<number, BuildingEntry>();
  const buildingGroup = new THREE.Group();
  for (const building of city.buildings) {
    const h = heightOf(building);
    const { w, h: d } = building.footprint;
    const material = new THREE.MeshStandardMaterial({
      roughness: 0.82,
      metalness: 0.04,
      emissive: 0xffffff,
      emissiveMap: windowTexture,
    });
    const mesh = new THREE.Mesh(buildingGeometry(w, h, d, buildingRandom), material);
    mesh.position.copy(toWorld(rectCenter(building.footprint), BLOCK_HEIGHT + h / 2));
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData.id = building.id;
    buildingGroup.add(mesh);
    entries.set(building.id, {
      building,
      mesh,
      base: new THREE.Color(),
      target: new THREE.Color(),
    });
  }
  scene.add(buildingGroup);

  // ── 地铁站 ──
  const stationGroup = new THREE.Group();
  const stationMaterial = new THREE.MeshStandardMaterial({
    color: AMBER,
    emissive: AMBER,
    emissiveIntensity: 0.6,
    roughness: 0.4,
  });
  const stationTop = new THREE.MeshBasicMaterial({ color: AMBER });
  for (const station of city.stations) {
    const position = toWorld(station.location);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(9, 10, 2, 32), stationMaterial);
    base.position.copy(position).setY(1);
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 22, 12), stationMaterial);
    pillar.position.copy(position).setY(12);
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(3.6, 24, 16), stationTop);
    beacon.position.copy(position).setY(25);
    base.castShadow = pillar.castShadow = true;
    stationGroup.add(base, pillar, beacon);
  }
  scene.add(stationGroup);

  // ── 标签 ──
  const pins: Pin[] = [];
  const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const addPin = (
    html: string,
    anchor: THREE.Vector3,
    className: string,
    pinView: Pin['view'] = 'both',
    shown = true,
  ): Pin => {
    const element = document.createElement('div');
    element.className = `geo-pin ${className}`;
    element.innerHTML = html;
    pinLayer.append(element);
    const pin = { element, anchor, view: pinView, shown };
    pins.push(pin);
    return pin;
  };
  const removePins = (className: string) => {
    for (let i = pins.length - 1; i >= 0; i--) {
      if (pins[i].element.classList.contains(className)) {
        pins[i].element.remove();
        pins.splice(i, 1);
      }
    }
  };
  for (const station of city.stations) {
    addPin(
      `<b>M</b>${escapeHtml(station.name)}`,
      toWorld(station.location, 34),
      'pin-station',
      'city',
    );
  }
  addPin(escapeHtml(park.name), toWorld({ x: 800, y: 470 }, 14), 'pin-park', 'city');

  // ── 线条工具（Line2：可设置像素宽度） ──
  const lineMaterials = new Set<LineMaterial>();
  const makeLine = (
    points: THREE.Vector3[],
    color: THREE.ColorRepresentation,
    width: number,
    opacity = 1,
    dashed = false,
  ) => {
    const geometry = new LineGeometry();
    geometry.setPositions(points.flatMap((p) => [p.x, p.y, p.z]));
    const material = new LineMaterial({
      color,
      linewidth: width,
      transparent: true,
      opacity,
      dashed,
      dashSize: 6,
      gapSize: 5,
      depthWrite: false,
    });
    material.resolution.set(container.clientWidth || 1, container.clientHeight || 1);
    lineMaterials.add(material);
    const line = new Line2(geometry, material);
    line.computeLineDistances();
    line.frustumCulled = false;
    line.userData.baseOpacity = opacity;
    return line;
  };
  /** 原地更新单段线的端点，用于“生长”动画。 */
  const setSegment = (line: Line2, a: THREE.Vector3, b: THREE.Vector3) => {
    const attribute = line.geometry.getAttribute(
      'instanceStart',
    ) as THREE.InterleavedBufferAttribute;
    attribute.data.array.set([a.x, a.y, a.z, b.x, b.y, b.z]);
    attribute.data.needsUpdate = true;
  };

  // ── 分层结构（静态部分） ──
  // 所有分层元素放在 layerRoot 中，以“完全展开”的坐标建模；切换视图时缩放其高度。
  const layerRoot = new THREE.Group();
  scene.add(layerRoot);
  const HALF_W = CITY.width / 2 + 30;
  const HALF_D = CITY.height / 2 + 30;

  const planeMaterials: THREE.MeshBasicMaterial[] = [];
  const outlineLines: Line2[] = [];
  const makePlane = (y: number, halfW: number, halfD: number, color: THREE.Color) => {
    const material = new THREE.MeshBasicMaterial({
      color,
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
    const outline = makeLine(
      rectOutline(halfW, halfD).map((p) => p.setY(y)),
      color,
      1.4,
      0.55,
    );
    outlineLines.push(outline);
    layerRoot.add(plane, outline);
  };
  makePlane(LAYER.mapping, HALF_W, HALF_D, ACCENT);
  makePlane(LAYER.graph, HALF_W, HALF_D, new THREE.Color(0xffffff));
  makePlane(LAYER.ontology, ONTOLOGY_HALF.w, ONTOLOGY_HALF.d, AMBER);

  // 图谱层上的全部实体（暗点），表示每一行数据都对应一个虚拟实体。
  const entityAnchor = (key: string) => {
    const [type, raw] = key.split(':');
    const id = Number(raw);
    if (type === 'b') {
      const building = entries.get(id)!.building;
      const center = rectCenter(building.footprint);
      return {
        graph: toWorld(center, LAYER.graph),
        data: toWorld(center, BLOCK_HEIGHT + heightOf(building) * FLAT + 1),
      };
    }
    if (type === 's') {
      const station = city.stations.find((s) => s.id === id)!;
      return { graph: toWorld(station.location, LAYER.graph), data: toWorld(station.location, 27) };
    }
    const centroid = { x: 800, y: 540 };
    return { graph: toWorld(centroid, LAYER.graph), data: toWorld(centroid, BLOCK_HEIGHT + 1) };
  };
  const allEntityKeys = [
    ...city.buildings.map((b) => `b:${b.id}`),
    ...city.stations.map((s) => `s:${s.id}`),
    `p:${park.id}`,
  ];
  const dotMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.45 });
  const dots = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1.8, 10, 8),
    dotMaterial,
    allEntityKeys.length,
  );
  allEntityKeys.forEach((key, i) => {
    dots.setMatrixAt(i, new THREE.Matrix4().makeTranslation(entityAnchor(key).graph));
  });
  layerRoot.add(dots);

  // 本体类节点
  interface ClassNode {
    mesh: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial>;
    position: THREE.Vector3;
    pin: Pin;
    active: boolean;
  }
  const classNodes = new Map<string, ClassNode>();
  for (const [name, [x, z]] of Object.entries(CLASS_POSITION)) {
    const position = new THREE.Vector3(x, LAYER.ontology, z);
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(9, 9, 3, 32),
      new THREE.MeshStandardMaterial({
        color: AMBER,
        emissive: AMBER,
        emissiveIntensity: 0.3,
        roughness: 0.5,
      }),
    );
    mesh.position.copy(position);
    layerRoot.add(mesh);
    const pin = addPin(
      escapeHtml(name),
      position.clone().setY(LAYER.ontology + 14),
      'pin-class',
      'layers',
    );
    classNodes.set(name, { mesh, position, pin, active: false });
  }
  for (const [child, parent] of STATIC_SUBCLASS) {
    const line = makeLine(
      [classNodes.get(child)!.position, classNodes.get(parent)!.position],
      AMBER,
      1.2,
      0.35,
      true,
    );
    layerRoot.add(line);
  }

  // 各层标签
  const layerLabel = (title: string, note: string) => `<b>${title}</b><span>${note}</span>`;
  addPin(
    layerLabel('本体', 'TBox：类与类之间的关系'),
    new THREE.Vector3(-ONTOLOGY_HALF.w, LAYER.ontology, ONTOLOGY_HALF.d),
    'pin-layer pin-layer-onto',
    'layers',
  );
  addPin(
    layerLabel('虚拟知识图谱', '实体按需生成，不做物化'),
    new THREE.Vector3(-HALF_W, LAYER.graph, HALF_D),
    'pin-layer pin-layer-graph',
    'layers',
  );
  addPin(
    layerLabel('映射', 'SQL 结果 → RDF 三元组'),
    new THREE.Vector3(-HALF_W, LAYER.mapping, HALF_D),
    'pin-layer pin-layer-map',
    'layers',
  );
  addPin(
    layerLabel('数据源 · PostGIS', 'buildings / stations / parks'),
    new THREE.Vector3(-HALF_W, 0, HALF_D),
    'pin-layer pin-layer-data',
    'layers',
  );

  // ── 查询的动态部分 ──
  const overlay = new THREE.Group(); // 数据层上的缓冲区或范围
  scene.add(overlay);
  const cityBeams = new THREE.Group(); // 城市视图中的光柱
  scene.add(cityBeams);
  const chain = new THREE.Group(); // 分层视图中的连线、节点与映射门
  layerRoot.add(chain);
  const selectionChain = new THREE.Group();
  layerRoot.add(selectionChain);
  const beamTexture = createBeamTexture();
  const pulses: THREE.Mesh[] = [];
  const tweens: Tween[] = [];
  const particles: Particle[] = [];
  const hitBeams: { from: THREE.Vector3; to: THREE.Vector3 }[] = [];
  const nodeMeshes: THREE.Mesh[] = [];
  let queryStart = 0;
  let overlayDelay = 0;
  let lastPhase = -1;
  let lastEmit = 0;

  const particleGeometry = new THREE.SphereGeometry(2.6, 10, 8);
  const spawnParticle = (
    from: THREE.Vector3,
    to: THREE.Vector3,
    color: THREE.Color,
    delay = 0,
    duration = 700,
  ) => {
    if (reduced) return;
    const mesh = new THREE.Mesh(
      particleGeometry,
      new THREE.MeshBasicMaterial({ color, transparent: true }),
    );
    mesh.visible = false;
    layerRoot.add(mesh);
    particles.push({ mesh, from, to, start: performance.now() + delay, duration });
  };

  // ── 状态 ──
  let hits = new Set<number>();
  let selected: number | null = null;
  let selectedLabel: string | undefined;
  let hovered: number | null = null;
  let queryActive = false;
  let currentState: QueryState | null = null;

  const disposeGroup = (group: THREE.Group) => {
    group.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof Line2) {
        if (object.geometry !== particleGeometry) object.geometry.dispose();
        const material = object.material as THREE.Material;
        if (material instanceof LineMaterial) lineMaterials.delete(material);
        material.dispose();
      }
    });
    group.clear();
  };

  const updateTargets = () => {
    const palette = PALETTE[mode];
    const background = new THREE.Color(palette.background);
    for (const entry of entries.values()) {
      const { building, base, target, mesh } = entry;
      base.set(KIND_COLOR[building.kind]);
      if (mode === 'night') base.lerp(NIGHT_BASE, 0.78);
      const emphasized = hits.has(building.id) || selected === building.id;
      if (emphasized) target.copy(base).lerp(ACCENT, mode === 'night' ? 0.55 : 0.75);
      else if (queryActive) target.copy(base).lerp(background, palette.dim);
      else target.copy(base);
      if (hovered === building.id && !emphasized) target.lerp(ACCENT, 0.25);
      mesh.material.emissiveIntensity =
        queryActive && !emphasized ? palette.windows * 0.25 : palette.windows;
    }
  };

  const applyMode = () => {
    const palette = PALETTE[mode];
    scene.background = new THREE.Color(palette.background);
    fog.color.set(palette.background);
    groundMaterial.color.set(palette.ground);
    blockMaterial.color.set(palette.block);
    parkMaterial.color.set(palette.park);
    waterMaterial.color.set(palette.water);
    waterMaterial.emissive.set(mode === 'night' ? 0x0a3546 : 0x000000);
    gridMaterial.color.set(palette.grid);
    markingMaterial.color.set(palette.marking);
    foliageMaterial.color.set(palette.foliage);
    foliageMaterial.emissive.set(mode === 'night' ? 0x0f2a1b : 0x000000);
    hemi.color.set(palette.hemiSky);
    hemi.groundColor.set(palette.hemiGround);
    hemi.intensity = palette.hemi;
    sun.color.set(palette.sun);
    sun.intensity = palette.sunIntensity;
    renderer.toneMappingExposure = palette.exposure;
    bloom.strength = palette.bloom;
    stationMaterial.emissiveIntensity = mode === 'night' ? 1.4 : 0.35;
    dotMaterial.color.set(palette.neutral);
    planeMaterials[1].color.set(mode === 'night' ? 0xffffff : 0x24303a);
    outlineLines[1].material.color.set(mode === 'night' ? 0xffffff : 0x24303a);
    for (const line of outlineLines) {
      line.material.opacity = palette.outlineOpacity;
      line.material.linewidth = mode === 'night' ? 1.4 : 1.8;
    }
    updateTargets();
    for (const entry of entries.values()) entry.mesh.material.color.copy(entry.target);
    container.dataset.mode = mode;
  };

  // ── 数据层叠加：缓冲区、范围与城市光柱 ──
  const addBuffer = (center: Point, radius: number) => {
    const position = toWorld(center, BLOCK_HEIGHT + 0.6);
    const fill = new THREE.Mesh(
      new THREE.CircleGeometry(radius, 128),
      new THREE.MeshBasicMaterial({
        color: ACCENT,
        transparent: true,
        opacity: mode === 'night' ? 0.07 : 0.12,
        depthWrite: false,
      }),
    );
    const edge = new THREE.Mesh(
      new THREE.RingGeometry(radius - 2, radius, 160),
      new THREE.MeshBasicMaterial({
        color: ACCENT,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
      }),
    );
    const pulse = new THREE.Mesh(
      new THREE.RingGeometry(radius - 1.2, radius, 160),
      new THREE.MeshBasicMaterial({
        color: ACCENT,
        transparent: true,
        opacity: 0.6,
        depthWrite: false,
      }),
    );
    for (const mesh of [fill, edge, pulse]) {
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.copy(position);
      mesh.renderOrder = 2;
      overlay.add(mesh);
    }
    pulses.push(pulse);
    fill.userData.grow = edge.userData.grow = true;
  };

  const addArea = () => {
    const outline = new THREE.Shape(parkShape.getPoints());
    const inner = park.area.map((p) => {
      const cx = 800;
      const cy = 540;
      return new THREE.Vector2(
        cx + (p.x - cx) * 0.982 - CITY.width / 2,
        cy + (p.y - cy) * 0.982 - CITY.height / 2,
      );
    });
    outline.holes.push(new THREE.Path(inner.reverse()));
    const edge = new THREE.Mesh(
      new THREE.ShapeGeometry(outline),
      new THREE.MeshBasicMaterial({
        color: ACCENT,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
      }),
    );
    const fill = new THREE.Mesh(
      new THREE.ShapeGeometry(parkShape),
      new THREE.MeshBasicMaterial({
        color: ACCENT,
        transparent: true,
        opacity: mode === 'night' ? 0.06 : 0.12,
        depthWrite: false,
      }),
    );
    for (const mesh of [edge, fill]) {
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = BLOCK_HEIGHT + 0.5;
      mesh.renderOrder = 2;
      overlay.add(mesh);
    }
    edge.userData.fade = fill.userData.fade = true;
    edge.userData.opacity = 0.95;
    fill.userData.opacity = fill.material.opacity;
  };

  const addCityBeam = (building: Building) => {
    const h = heightOf(building);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(2.6, 2.6, 160, 16, 1, true),
      new THREE.MeshBasicMaterial({
        color: ACCENT,
        alphaMap: beamTexture,
        transparent: true,
        opacity: mode === 'night' ? 0.9 : 0.8,
        depthWrite: false,
        blending: mode === 'night' ? THREE.AdditiveBlending : THREE.NormalBlending,
        side: THREE.DoubleSide,
      }),
    );
    beam.position.copy(toWorld(rectCenter(building.footprint), BLOCK_HEIGHT + h + 80));
    beam.userData.roof = BLOCK_HEIGHT + h;
    cityBeams.add(beam);
  };

  // ── 分层视图：按计划构建连线与动画 ──
  const buildChain = (state: QueryState) => {
    const { plan } = state;
    const palette = PALETTE[mode];
    const relevant = new Set(plan.classes);
    for (const [name, node] of classNodes) {
      node.active = relevant.has(name);
      node.pin.shown = node.active;
    }

    // 1. 本体推理：子类关系由父类向子类展开
    for (const [child, parent] of plan.subclass) {
      const from = classNodes.get(parent)!.position;
      const to = classNodes.get(child)!.position;
      const line = makeLine([from, from], AMBER, 3, 0.95);
      chain.add(line);
      tweens.push({
        t0: 0.15,
        t1: 0.85,
        update: (k) => setSegment(line, from, from.clone().lerp(to, easeOut(k))),
      });
      spawnParticle(from, to, AMBER, 150, 700);
    }

    const gates = new Set<string>();
    plan.entities.forEach((entity, i) => {
      const anchor = entityAnchor(entity.key);
      const jitter = (i % 6) * 0.05;

      // 2. 映射改写：类 → 实体（rdf:type），实体 → 数据（映射）
      // rdf:type 只连到命中的实体，减少干扰
      for (const cls of entity.hit ? entity.classes : []) {
        const from = classNodes.get(cls)!.position;
        const line = makeLine([from, from], AMBER, entity.hit ? 1.6 : 1, entity.hit ? 0.75 : 0.35);
        chain.add(line);
        tweens.push({
          t0: 0.9 + jitter,
          t1: 1.35 + jitter,
          update: (k) => setSegment(line, from, from.clone().lerp(anchor.graph, easeOut(k))),
        });
      }

      const beam = makeLine(
        [anchor.graph, anchor.graph],
        ACCENT,
        entity.hit ? 2.2 : 1.2,
        entity.hit ? 0.95 : 0.4,
      );
      chain.add(beam);
      tweens.push({
        t0: 1.3 + jitter,
        t1: 1.8 + jitter,
        update: (k) =>
          setSegment(beam, anchor.graph, anchor.graph.clone().lerp(anchor.data, easeOut(k))),
      });
      spawnParticle(anchor.graph, anchor.data, ACCENT, 1300 + jitter * 1000, 600);
      if (entity.hit) hitBeams.push({ from: anchor.data, to: anchor.graph });

      // 映射门：竖线穿过映射层的位置
      const gatePosition = anchor.graph.clone().setY(LAYER.mapping);
      const gate = new THREE.Mesh(
        new THREE.RingGeometry(4.5, 7.5, 32),
        new THREE.MeshBasicMaterial({
          color: ACCENT,
          transparent: true,
          opacity: 0,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      gate.rotation.x = -Math.PI / 2;
      gate.position.copy(gatePosition);
      chain.add(gate);
      tweens.push({
        t0: 1.45 + jitter,
        t1: 1.75 + jitter,
        update: (k) =>
          ((gate.material as THREE.MeshBasicMaterial).opacity = (entity.hit ? 0.95 : 0.5) * k),
      });
      if (!gates.has(entity.mapping)) {
        gates.add(entity.mapping);
        const pin = addPin(
          `<code>${escapeHtml(entity.mapping)}</code> 映射`,
          gatePosition.clone().setY(LAYER.mapping + 10),
          'pin-gate pin-chain',
          'layers',
          false,
        );
        tweens.push({ t0: 1.5, t1: 1.6, update: (k) => (pin.shown = k > 0) });
      }

      // 实体节点：命中的结果在返回阶段点亮
      const node = new THREE.Mesh(
        new THREE.SphereGeometry(entity.hit ? 6 : 4.5, 20, 14),
        new THREE.MeshStandardMaterial({
          color: palette.neutral,
          emissive: palette.neutral,
          emissiveIntensity: 0.3,
        }),
      );
      node.position.copy(anchor.graph);
      node.scale.setScalar(0.001);
      node.userData.scale = 1;
      nodeMeshes.push(node);
      chain.add(node);
      tweens.push({
        t0: 1.05 + jitter,
        t1: 1.4 + jitter,
        update: (k) => (node.userData.scale = Math.max(0.001, easeOut(k))),
      });
      if (entity.hit) {
        const material = node.material as THREE.MeshStandardMaterial;
        tweens.push({
          t0: 2.6,
          t1: 3.0,
          update: (k) => {
            material.color.set(palette.neutral).lerp(ACCENT, k);
            material.emissive.set(palette.neutral).lerp(ACCENT, k);
            material.emissiveIntensity = 0.3 + k * (mode === 'night' ? 1.4 : 0.5);
          },
        });
        const label = state.entityLabels[entity.key];
        if (label) {
          const pin = addPin(
            label,
            anchor.graph.clone().setY(LAYER.graph + 14),
            'pin-entity pin-chain',
            'layers',
            false,
          );
          tweens.push({ t0: 2.9, t1: 3.0, update: (k) => (pin.shown = k > 0) });
        }
      }
    });

    // 4. 返回结果：图谱层中的空间关系
    for (const relation of plan.relations) {
      const a = entityAnchor(relation.from).graph;
      const b = entityAnchor(relation.to).graph;
      const mid = a.clone().add(b).multiplyScalar(0.5);
      mid.y += 14 + a.distanceTo(b) * 0.08;
      const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
      const line = makeLine(
        curve.getPoints(24),
        relation.hit ? ACCENT : palette.neutral,
        relation.hit ? 2.2 : 1,
        relation.hit ? 0.95 : 0.45,
        !relation.hit,
      );
      line.material.opacity = 0;
      chain.add(line);
      tweens.push({
        t0: 2.7,
        t1: 3.2,
        update: (k) => (line.material.opacity = (line.userData.baseOpacity as number) * k),
      });
    }
  };

  const clearQuery = () => {
    disposeGroup(overlay);
    disposeGroup(cityBeams);
    disposeGroup(chain);
    for (const p of particles.splice(0)) {
      (p.mesh.material as THREE.Material).dispose();
      p.mesh.removeFromParent();
    }
    pulses.length = 0;
    tweens.length = 0;
    hitBeams.length = 0;
    nodeMeshes.length = 0;
    removePins('pin-hit');
    removePins('pin-chain');
    for (const node of classNodes.values()) {
      node.active = false;
      node.pin.shown = true;
    }
  };

  const restartTimeline = () => {
    queryStart = performance.now();
    lastPhase = -1;
    lastEmit = 0;
  };

  // ── 点选建筑：在分层视图中显示它的整条对应链 ──
  const buildSelection = (id: number | null, label?: string) => {
    disposeGroup(selectionChain);
    removePins('pin-selected');
    if (id === null) return;
    const building = entries.get(id)!.building;
    const anchor = entityAnchor(`b:${id}`);
    const ink = PALETTE[mode].ink;
    if (!hits.has(id)) {
      addPin(
        escapeHtml(building.name),
        toWorld(rectCenter(building.footprint), BLOCK_HEIGHT + heightOf(building) + 10),
        'pin-selected',
        'city',
      );
    }
    selectionChain.add(makeLine([anchor.data, anchor.graph], ink, 2, 0.9));
    const node = new THREE.Mesh(
      new THREE.SphereGeometry(6.5, 20, 14),
      new THREE.MeshBasicMaterial({ color: ink }),
    );
    node.position.copy(anchor.graph);
    node.userData.scale = 1;
    selectionChain.add(node);
    const classes = [':Building', FACILITY_CLASS[building.kind]].filter(Boolean) as string[];
    for (const cls of classes) {
      selectionChain.add(
        makeLine([anchor.graph, classNodes.get(cls)!.position], ink, 1.6, 0.8, true),
      );
    }
    addPin(
      label ?? escapeHtml(building.name),
      anchor.graph.clone().setY(LAYER.graph + 16),
      'pin-selected pin-selected-graph',
      'layers',
    );
  };

  // ── 相机 ──
  const homes = {
    city: () => {
      const aspect = camera.aspect || 1.6;
      const scale = aspect < 1.2 ? 1.45 : aspect < 1.6 ? 1.15 : 1;
      return {
        position: new THREE.Vector3(420, 560, 780).multiplyScalar(scale),
        target: new THREE.Vector3(30, 0, 30),
      };
    },
    layers: () => {
      const aspect = camera.aspect || 1.6;
      const scale = aspect < 1.2 ? 1.5 : aspect < 1.6 ? 1.18 : 1;
      const target = new THREE.Vector3(30, 270, 10);
      return {
        position: target.clone().add(new THREE.Vector3(500, 700, 1740).multiplyScalar(scale)),
        target,
      };
    },
  };
  let flight: {
    from: THREE.Vector3;
    to: THREE.Vector3;
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
    start: number;
    duration: number;
  } | null = null;

  const flyToPose = (position: THREE.Vector3, target: THREE.Vector3) => {
    if (reduced) {
      camera.position.copy(position);
      controls.target.copy(target);
      return;
    }
    flight = {
      from: camera.position.clone(),
      to: position,
      fromTarget: controls.target.clone(),
      toTarget: target,
      start: performance.now(),
      duration: 1400,
    };
  };

  const flyTo = (target: THREE.Vector3, distance: number) => {
    const direction = camera.position.clone().sub(controls.target).normalize();
    direction.y = Math.max(direction.y, 0.62);
    direction.normalize();
    flyToPose(target.clone().add(direction.multiplyScalar(distance)), target);
  };

  const focusOn = (focus: Focus) => {
    const points = focus.type === 'buffer' ? focus.centers : focus.polygon;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const center = {
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      y: (Math.min(...ys) + Math.max(...ys)) / 2,
    };
    const pad = focus.type === 'buffer' ? focus.radius * 2 : 0;
    const extent =
      Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) + pad;
    flyTo(toWorld(center), Math.max(380, extent * 1.45));
  };

  const goHome = () => {
    const pose = homes[view]();
    flyToPose(pose.position, pose.target);
  };

  // ── 拾取 ──
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const pick = (event: PointerEvent): number | null => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    const [hit] = raycaster.intersectObjects(buildingGroup.children, false);
    return hit ? (hit.object.userData.id as number) : null;
  };

  let downAt: { x: number; y: number } | null = null;
  const canvas = renderer.domElement;
  const onPointerDown = (event: PointerEvent) => {
    downAt = { x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event: PointerEvent) => {
    if (!downAt || Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > 5) return;
    downAt = null;
    callbacks.onSelect(pick(event));
  };
  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse' || event.buttons) return;
    const id = pick(event);
    if (id !== hovered) {
      hovered = id;
      canvas.style.cursor = id ? 'pointer' : '';
      updateTargets();
    }
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointermove', onPointerMove);

  let autoRotate = !reduced;
  let idleTimer = 0;
  const onControlStart = () => {
    controls.autoRotate = false;
    flight = null;
    window.clearTimeout(idleTimer);
  };
  const onControlEnd = () => {
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(
      () => (controls.autoRotate = autoRotate && view === 'city'),
      9000,
    );
  };
  controls.addEventListener('start', onControlStart);
  controls.addEventListener('end', onControlEnd);

  // ── 尺寸 ──
  const resize = () => {
    const { clientWidth: width, clientHeight: height } = container;
    if (width === 0 || height === 0) return;
    renderer.setSize(width, height, false);
    composer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    for (const material of lineMaterials) material.resolution.set(width, height);
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
  resize();
  const start = homes[view]();
  camera.position.copy(start.position);
  controls.target.copy(start.target);
  controls.autoRotate = autoRotate && view === 'city';

  // ── 渲染循环 ──
  const projected = new THREE.Vector3();
  const scratch = new THREE.Vector3();
  let lastView = '';

  const updatePins = () => {
    const { clientWidth: width, clientHeight: height } = container;
    for (const pin of pins) {
      const wanted = pin.view === 'both' || (pin.view === 'layers' ? mix > 0.6 : mix < 0.4);
      let visible = wanted && pin.shown;
      if (visible) {
        scratch.copy(pin.anchor);
        if (pin.view === 'layers') scratch.y *= mix;
        projected.copy(scratch).project(camera);
        visible = projected.z < 1 && Math.abs(projected.x) < 1.05 && Math.abs(projected.y) < 1.05;
      }
      pin.element.style.display = visible ? '' : 'none';
      if (!visible) continue;
      pin.element.style.transform = `translate(${((projected.x + 1) / 2) * width}px, ${((1 - projected.y) / 2) * height}px)`;
      pin.element.style.zIndex = String(Math.round((1 - projected.z) * 1e5));
    }
  };

  const reportView = () => {
    const forward = controls.target.clone().sub(camera.position);
    const next = {
      x: camera.position.x + CITY.width / 2,
      y: CITY.height / 2 - camera.position.z,
      angle: Math.atan2(forward.x, -forward.z),
    };
    const key = `${next.x.toFixed(0)},${next.y.toFixed(0)},${next.angle.toFixed(2)}`;
    if (key !== lastView) {
      lastView = key;
      callbacks.onView(next);
    }
  };

  const applyMix = () => {
    const visible = mix > 0.01;
    layerRoot.visible = visible;
    layerRoot.scale.y = Math.max(mix, 0.001);
    for (const material of planeMaterials) material.opacity = PALETTE[mode].planeOpacity * mix;
    for (const entry of entries.values()) {
      const h = heightOf(entry.building);
      const scale = 1 - (1 - FLAT) * mix;
      entry.mesh.scale.y = scale;
      entry.mesh.position.y = BLOCK_HEIGHT + (h * scale) / 2;
    }
    cityBeams.visible = mix < 0.5;
    fog.near = 1300 + 900 * mix;
    fog.far = 3200 + 1800 * mix;
    // 节点在压缩高度时保持球形
    const inverse = 1 / Math.max(mix, 0.05);
    for (const object of [
      ...chain.children,
      ...selectionChain.children,
      ...classNodes.values(),
    ].map((o) => ('mesh' in o ? o.mesh : o))) {
      if (object instanceof THREE.Mesh && object.geometry instanceof THREE.SphereGeometry) {
        const s = (object.userData.scale as number | undefined) ?? 1;
        object.scale.set(s, s * inverse, s);
      } else if (
        object instanceof THREE.Mesh &&
        object.geometry instanceof THREE.CylinderGeometry
      ) {
        object.scale.y = inverse;
      }
    }
  };

  const tick = (now: number) => {
    frame = requestAnimationFrame(tick);
    if (flight) {
      const t = Math.min(1, (now - flight.start) / flight.duration);
      const k = easeInOut(t);
      camera.position.lerpVectors(flight.from, flight.to, k);
      controls.target.lerpVectors(flight.fromTarget, flight.toTarget, k);
      if (t >= 1) flight = null;
    }
    controls.update();
    controls.target.x = THREE.MathUtils.clamp(controls.target.x, -560, 560);
    controls.target.z = THREE.MathUtils.clamp(controls.target.z, -440, 440);
    controls.target.y = THREE.MathUtils.clamp(controls.target.y, 0, 320);

    const targetMix = view === 'layers' ? 1 : 0;
    if (mix !== targetMix) {
      mix = reduced ? targetMix : mix + (targetMix - mix) * 0.08;
      if (Math.abs(mix - targetMix) < 0.002) mix = targetMix;
    }
    applyMix();

    for (const entry of entries.values()) entry.mesh.material.color.lerp(entry.target, 0.12);

    // 查询时间轴
    const elapsed = reduced ? 99 : (now - queryStart) / 1000;
    if (queryActive) {
      for (const tween of tweens)
        tween.update(clamp01((elapsed - tween.t0) / (tween.t1 - tween.t0)));
      if (view === 'layers') {
        const phase = PHASES.filter((t) => elapsed >= t).length - 1;
        if (phase !== lastPhase) {
          lastPhase = phase;
          callbacks.onPhase(phase);
        }
        // 结果持续沿映射线回流
        if (elapsed > 2.6 && now - lastEmit > 1600) {
          lastEmit = now;
          hitBeams.forEach(({ from, to }, i) => spawnParticle(from, to, ACCENT, i * 90, 900));
        }
      }
    }

    const overlayElapsed = elapsed - overlayDelay;
    const grow = reduced ? 1 : easeInOut(clamp01(overlayElapsed / 0.9));
    const g = Math.max(grow, 0.001);
    overlay.children.forEach((object) => {
      const { userData } = object;
      object.visible = overlayElapsed > 0;
      if (userData.grow) object.scale.setScalar(g);
      if (userData.fade)
        ((object as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = g * userData.opacity;
    });
    cityBeams.children.forEach((object) => {
      object.scale.set(1, g, 1);
      object.position.y = (object.userData.roof as number) + 80 * g;
    });
    if (!reduced) {
      for (const pulse of pulses) {
        const p = (((overlayElapsed * 0.45) % 1) + 1) % 1;
        pulse.scale.setScalar(0.15 + p * 0.85);
        (pulse.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - p);
      }
    }

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      const t = (now - p.start) / p.duration;
      if (t < 0) continue;
      if (t >= 1) {
        (p.mesh.material as THREE.Material).dispose();
        p.mesh.removeFromParent();
        particles.splice(i, 1);
        continue;
      }
      p.mesh.visible = true;
      p.mesh.position.lerpVectors(p.from, p.to, easeInOut(t));
      p.mesh.scale.set(1, 1 / Math.max(mix, 0.05), 1);
    }

    for (const node of classNodes.values()) {
      const material = node.mesh.material;
      const targetIntensity = node.active
        ? mode === 'night'
          ? 1.6
          : 0.8
        : queryActive
          ? 0.08
          : 0.3;
      material.emissiveIntensity += (targetIntensity - material.emissiveIntensity) * 0.1;
    }

    composer.render();
    updatePins();
    reportView();
  };

  let frame = 0;
  let running = false;
  const setRunning = (value: boolean) => {
    if (value === running) return;
    running = value;
    if (running) frame = requestAnimationFrame(tick);
    else cancelAnimationFrame(frame);
  };
  const visibility = new IntersectionObserver(([entry]) =>
    setRunning(entry.isIntersecting && !document.hidden),
  );
  visibility.observe(container);
  const onVisibilityChange = () =>
    setRunning(!document.hidden && container.getBoundingClientRect().bottom > 0);
  document.addEventListener('visibilitychange', onVisibilityChange);

  applyMode();
  container.dataset.view = view;

  const runQuery = (state: QueryState, replay = true) => {
    clearQuery();
    hits = new Set(state.hits.map((hit) => hit.id));
    buildSelection(selected, selectedLabel);
    queryActive = true;
    if (replay) restartTimeline();
    overlayDelay = view === 'layers' ? PHASES[2] : 0;
    if (state.focus.type === 'buffer') {
      const radius = state.focus.radius;
      state.focus.centers.forEach((center) => addBuffer(center, radius));
    } else {
      addArea();
    }
    for (const { id, label } of state.hits) {
      const building = entries.get(id)!.building;
      addCityBeam(building);
      addPin(
        label,
        toWorld(rectCenter(building.footprint), BLOCK_HEIGHT + heightOf(building) + 10),
        'pin-hit',
        'city',
      );
    }
    buildChain(state);
    if (view === 'city' && replay) focusOn(state.focus);
    updateTargets();
  };

  return {
    showQuery(state) {
      currentState = state;
      if (state) {
        runQuery(state);
      } else {
        clearQuery();
        hits = new Set();
        queryActive = false;
        updateTargets();
      }
    },
    select(id, label) {
      selected = id;
      selectedLabel = label;
      buildSelection(id, label);
      if (id !== null && view === 'city') {
        const building = entries.get(id)!.building;
        flyTo(toWorld(rectCenter(building.footprint)), 440);
      }
      updateTargets();
    },
    setMode(next) {
      mode = next;
      applyMode();
      if (currentState) runQuery(currentState, false);
    },
    setView(next) {
      if (next === view) return;
      view = next;
      container.dataset.view = view;
      // 分层视图保持固定构图，城市视图可自动旋转
      controls.autoRotate = autoRotate && view === 'city';
      goHome();
      // 切换到分层视图时重新播放查询过程
      if (currentState) runQuery(currentState);
    },
    setAutoRotate(enabled) {
      autoRotate = enabled && !reduced;
      controls.autoRotate = autoRotate && view === 'city';
    },
    resetView: goHome,
    dispose() {
      setRunning(false);
      window.clearTimeout(idleTimer);
      visibility.disconnect();
      resizeObserver.disconnect();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointermove', onPointerMove);
      controls.dispose();
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
        (Array.isArray(material) ? material : material ? [material] : []).forEach((m) =>
          m.dispose(),
        );
      });
      particleGeometry.dispose();
      windowTexture.dispose();
      beamTexture.dispose();
      composer.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      pins.forEach((pin) => pin.element.remove());
    },
  };
}
