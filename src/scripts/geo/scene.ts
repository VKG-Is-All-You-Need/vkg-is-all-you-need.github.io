/**
 * “VKG × 地理信息”示例的三维场景（three.js）。
 * 由 scripts/geo/controller.ts 在场景进入视口后按需加载。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import {
  CITY,
  FLOOR_HEIGHT,
  GRID,
  type Building,
  type BuildingKind,
  type City,
} from '../../lib/geo/city';
import { pointInPolygon, rectCenter, seededRandom, type Point } from '../../lib/geo/spatial';
import type { Focus } from '../../lib/geo/queries';

export type Mode = 'day' | 'night';

export interface PlanView {
  x: number;
  y: number;
  angle: number;
}

export interface SceneCallbacks {
  onSelect(id: number | null): void;
  onView(view: PlanView): void;
}

export interface QueryState {
  hits: { id: number; label: string }[];
  focus: Focus;
}

export interface GeoScene {
  showQuery(state: QueryState | null): void;
  select(id: number | null): void;
  setMode(mode: Mode): void;
  setAutoRotate(enabled: boolean): void;
  resetView(): void;
  dispose(): void;
}

const ACCENT = new THREE.Color('#49bbdd');
const AMBER = new THREE.Color('#e6c07b');
const BLOCK_HEIGHT = 1.2;

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

/** 竖向渐隐纹理，用于光柱。 */
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

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

interface Pin {
  element: HTMLElement;
  anchor: THREE.Vector3;
}

interface BuildingEntry {
  building: Building;
  mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  base: THREE.Color;
  target: THREE.Color;
}

export function createGeoScene(
  container: HTMLElement,
  pinLayer: HTMLElement,
  city: City,
  callbacks: SceneCallbacks,
  options: { mode: Mode; reducedMotion: boolean },
): GeoScene {
  const reduced = options.reducedMotion;
  let mode: Mode = options.mode;

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
  scene.fog = new THREE.Fog(0x000000, 1300, 3200);

  const camera = new THREE.PerspectiveCamera(36, 1, 5, 6000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 160;
  controls.maxDistance = 1800;
  controls.minPolarAngle = 0.2;
  controls.maxPolarAngle = 1.3;
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
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(5000, 5000), groundMaterial);
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
      if (!inPark(k * GRID.width, y))
        dashes.push(new THREE.Matrix4().makeTranslation(toWorld({ x: k * GRID.width, y }, 0.08)));
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
  // 行道树：沿主要街道的人行道边缘
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

  // ── 查询可视化图层 ──
  const overlay = new THREE.Group();
  scene.add(overlay);
  const beamTexture = createBeamTexture();
  const pulses: THREE.Mesh[] = [];
  let overlayStart = 0;

  // ── 标签 ──
  const pins: Pin[] = [];
  const addPin = (html: string, anchor: THREE.Vector3, className: string): Pin => {
    const element = document.createElement('div');
    element.className = `geo-pin ${className}`;
    element.innerHTML = html;
    pinLayer.append(element);
    const pin = { element, anchor };
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
  const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  for (const station of city.stations) {
    addPin(`<b>M</b>${escapeHtml(station.name)}`, toWorld(station.location, 34), 'pin-station');
  }
  addPin(escapeHtml(park.name), toWorld({ x: 800, y: 470 }, 14), 'pin-park');

  // ── 状态 ──
  let hits = new Set<number>();
  let selected: number | null = null;
  let hovered: number | null = null;
  let queryActive = false;

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
    (scene.fog as THREE.Fog).color.set(palette.background);
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
    updateTargets();
    for (const entry of entries.values()) entry.mesh.material.color.copy(entry.target);
    container.dataset.mode = mode;
  };

  const clearOverlay = () => {
    overlay.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        (object.material as THREE.Material).dispose();
      }
    });
    overlay.clear();
    pulses.length = 0;
    removePins('pin-hit');
  };

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
    pulse.userData.base = 1;
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

  const addBeam = (building: Building) => {
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
    overlay.add(beam);
  };

  // ── 相机 ──
  const home = () => {
    const aspect = camera.aspect || 1.6;
    const scale = aspect < 1.2 ? 1.45 : aspect < 1.6 ? 1.15 : 1;
    return {
      position: new THREE.Vector3(420, 560, 780).multiplyScalar(scale),
      target: new THREE.Vector3(30, 0, 30),
    };
  };
  let flight: {
    from: THREE.Vector3;
    to: THREE.Vector3;
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
    start: number;
    duration: number;
  } | null = null;

  const flyTo = (target: THREE.Vector3, distance: number) => {
    const direction = camera.position.clone().sub(controls.target).normalize();
    direction.y = Math.max(direction.y, 0.62);
    direction.normalize();
    const to = target.clone().add(direction.multiplyScalar(distance));
    if (reduced) {
      camera.position.copy(to);
      controls.target.copy(target);
      return;
    }
    flight = {
      from: camera.position.clone(),
      to,
      fromTarget: controls.target.clone(),
      toTarget: target.clone(),
      start: performance.now(),
      duration: 1300,
    };
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

  // 用户操作后暂停自动旋转，空闲一段时间再恢复。
  let autoRotate = !reduced;
  let idleTimer = 0;
  const onControlStart = () => {
    controls.autoRotate = false;
    flight = null;
    window.clearTimeout(idleTimer);
  };
  const onControlEnd = () => {
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => (controls.autoRotate = autoRotate), 9000);
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
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
  resize();
  const start = home();
  camera.position.copy(start.position);
  controls.target.copy(start.target);
  controls.autoRotate = autoRotate;

  // ── 渲染循环 ──
  const projected = new THREE.Vector3();
  let frame = 0;
  let lastView = '';
  const clampTarget = () => {
    controls.target.x = THREE.MathUtils.clamp(controls.target.x, -560, 560);
    controls.target.z = THREE.MathUtils.clamp(controls.target.z, -440, 440);
    controls.target.y = 0;
  };

  const updatePins = () => {
    const { clientWidth: width, clientHeight: height } = container;
    for (const pin of pins) {
      projected.copy(pin.anchor).project(camera);
      const visible =
        projected.z < 1 && Math.abs(projected.x) < 1.05 && Math.abs(projected.y) < 1.05;
      pin.element.style.display = visible ? '' : 'none';
      if (!visible) continue;
      pin.element.style.transform = `translate(${((projected.x + 1) / 2) * width}px, ${((1 - projected.y) / 2) * height}px)`;
      pin.element.style.zIndex = String(Math.round((1 - projected.z) * 1e5));
    }
  };

  const reportView = () => {
    const forward = controls.target.clone().sub(camera.position);
    const view = {
      x: camera.position.x + CITY.width / 2,
      y: CITY.height / 2 - camera.position.z,
      angle: Math.atan2(forward.x, -forward.z),
    };
    const key = `${view.x.toFixed(0)},${view.y.toFixed(0)},${view.angle.toFixed(2)}`;
    if (key !== lastView) {
      lastView = key;
      callbacks.onView(view);
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
    clampTarget();

    for (const entry of entries.values()) entry.mesh.material.color.lerp(entry.target, 0.12);

    const elapsed = (now - overlayStart) / 1000;
    const grow = reduced ? 1 : easeInOut(Math.min(1, elapsed / 0.9));
    const g = Math.max(grow, 0.001);
    overlay.children.forEach((object) => {
      const { userData } = object;
      if (userData.grow) object.scale.setScalar(g);
      if (userData.roof !== undefined) {
        // 光柱从楼顶向上生长
        object.scale.set(1, g, 1);
        object.position.y = userData.roof + 80 * g;
      }
      if (userData.fade) {
        ((object as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = g * userData.opacity;
      }
    });
    if (!reduced) {
      for (const pulse of pulses) {
        const p = (elapsed * 0.45) % 1;
        pulse.scale.setScalar(0.15 + p * 0.85);
        (pulse.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - p);
      }
    }

    composer.render();
    updatePins();
    reportView();
  };

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

  return {
    showQuery(state) {
      clearOverlay();
      hits = new Set(state?.hits.map((hit) => hit.id) ?? []);
      queryActive = state !== null;
      overlayStart = performance.now();
      if (state) {
        if (state.focus.type === 'buffer')
          state.focus.centers.forEach((center) =>
            addBuffer(center, (state.focus as { radius: number }).radius),
          );
        else addArea();
        for (const { id, label } of state.hits) {
          const building = entries.get(id)!.building;
          addBeam(building);
          addPin(
            label,
            toWorld(rectCenter(building.footprint), BLOCK_HEIGHT + heightOf(building) + 10),
            'pin-hit',
          );
        }
        focusOn(state.focus);
      }
      updateTargets();
    },
    select(id) {
      selected = id;
      removePins('pin-selected');
      if (id !== null) {
        const building = entries.get(id)!.building;
        if (!hits.has(id)) {
          addPin(
            escapeHtml(building.name),
            toWorld(rectCenter(building.footprint), BLOCK_HEIGHT + heightOf(building) + 10),
            'pin-selected',
          );
        }
        flyTo(toWorld(rectCenter(building.footprint)), 440);
      }
      updateTargets();
    },
    setMode(next) {
      mode = next;
      applyMode();
      // 光柱与范围的混合方式随模式变化，重新生成。
      if (queryActive) {
        overlay.children.forEach((object) => {
          const material = (object as THREE.Mesh).material as THREE.MeshBasicMaterial;
          if (material.alphaMap) {
            material.blending = mode === 'night' ? THREE.AdditiveBlending : THREE.NormalBlending;
            material.opacity = mode === 'night' ? 0.9 : 0.8;
            material.needsUpdate = true;
          }
        });
      }
    },
    setAutoRotate(enabled) {
      autoRotate = enabled && !reduced;
      controls.autoRotate = autoRotate;
    },
    resetView() {
      const target = home();
      flyTo(target.target, target.position.distanceTo(target.target));
    },
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
