/**
 * 静态城市模型：地面、街区、道路标线、公园与湖、树木、建筑、地铁站，以及昼夜配色。
 * 地理示例与城市示例共用。
 */
import * as THREE from 'three';
import {
  CITY,
  FLOOR_HEIGHT,
  GRID,
  type Building,
  type BuildingKind,
  type City,
} from '../../lib/geo/city';
import { pointInPolygon, rectCenter, seededRandom, type Point } from '../../lib/geo/spatial';
import type { Stage } from './stage';

export type Mode = 'day' | 'night';

export const ACCENT = new THREE.Color('#49bbdd');
export const AMBER = new THREE.Color('#e6c07b');
export const BLOCK_HEIGHT = 1.2;

export const PALETTE = {
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

export type Palette = (typeof PALETTE)[Mode];

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

export const toWorld = ({ x, y }: Point, height = 0) =>
  new THREE.Vector3(x - CITY.width / 2, height, CITY.height / 2 - y);

export const heightOf = (building: Building) => building.floors * FLOOR_HEIGHT;

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

export interface BuildingEntry {
  building: Building;
  mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  /** 当前模式下的基础颜色。 */
  base: THREE.Color;
  /** 期望颜色，每帧向其渐变。 */
  target: THREE.Color;
}

export interface World {
  entries: Map<number, BuildingEntry>;
  buildingGroup: THREE.Group;
  parkShape: THREE.Shape;
  stationMaterial: THREE.MeshStandardMaterial;
  groundMaterial: THREE.MeshStandardMaterial;
  /** 按模式设置场景、灯光与静态材质颜色，并重算建筑基础色。 */
  applyMode(mode: Mode): void;
  /** 昼夜连续过渡：night 为 0（白天）到 1（夜晚）。 */
  applyBlend(night: number): void;
  /** 路面湿度 0–1：下雨时路面变暗、反光增强。 */
  setWetness(wetness: number): void;
  /** 建筑高度压缩（分层视图）：scale 为 1 时原高。 */
  setBuildingScale(scale: number): void;
  /**
   * 城市模型的不透明度 0–1。小于 1 时建筑、街区、公园与地铁站半透明，并以线框勾出建筑轮廓，
   * 用于表示“没有接入城市基础数据”。
   */
  setOpacity(opacity: number): void;
  /** 每帧调用：建筑颜色向 target 渐变。 */
  update(): void;
}

export function createWorld(stage: Stage, city: City): World {
  const { scene } = stage;
  const matrix = new THREE.Matrix4();

  // ── 地面、网格与街区 ──
  const groundMaterial = new THREE.MeshStandardMaterial({ roughness: 1 });
  const groundColor = new THREE.Color();
  let wet = 0;
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
        if (!nearBuilding({ x, y }, 3)) {
          treeSpots.push({ p: { x, y }, s: 2.6 + treeRandom() * 1.2 });
        }
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

  // 半透明时显示的建筑轮廓线，作为建筑的子对象随高度压缩一同缩放
  const ghostMaterial = new THREE.LineBasicMaterial({
    color: ACCENT,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const ghostEdges: THREE.LineSegments[] = [];
  for (const entry of entries.values()) {
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(entry.mesh.geometry),
      ghostMaterial,
    );
    edges.visible = false;
    entry.mesh.add(edges);
    ghostEdges.push(edges);
  }

  // ── 地铁站 ──
  const stationMaterial = new THREE.MeshStandardMaterial({
    color: AMBER,
    emissive: AMBER,
    emissiveIntensity: 0.6,
    roughness: 0.4,
  });
  const stationTop = new THREE.MeshBasicMaterial({ color: AMBER });
  const stationMeshes: THREE.Mesh[] = [];
  for (const station of city.stations) {
    const position = toWorld(station.location);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(9, 10, 2, 32), stationMaterial);
    base.position.copy(position).setY(1);
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 22, 12), stationMaterial);
    pillar.position.copy(position).setY(12);
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(3.6, 24, 16), stationTop);
    beacon.position.copy(position).setY(25);
    base.castShadow = pillar.castShadow = true;
    scene.add(base, pillar, beacon);
    stationMeshes.push(base, pillar);
  }

  const fadable: THREE.Material[] = [
    ...[...entries.values()].map((entry) => entry.mesh.material),
    blockMaterial,
    parkMaterial,
    waterMaterial,
    foliageMaterial,
    trunkMaterial,
    markingMaterial,
    stationMaterial,
    stationTop,
  ];
  const shadowCasters: THREE.Object3D[] = [
    ...[...entries.values()].map((entry) => entry.mesh),
    foliage,
    trunks,
    ...stationMeshes,
  ];
  let opacity = 1;

  return {
    entries,
    buildingGroup,
    parkShape,
    stationMaterial,
    groundMaterial,
    applyMode(mode) {
      this.applyBlend(mode === 'night' ? 1 : 0);
    },
    applyBlend(night) {
      const day = PALETTE.day;
      const dark = PALETTE.night;
      const color = (a: number, b: number) => new THREE.Color(a).lerp(new THREE.Color(b), night);
      const mix = (a: number, b: number) => a + (b - a) * night;
      scene.background = color(day.background, dark.background);
      stage.fog.color.copy(scene.background as THREE.Color);
      groundColor.copy(color(day.ground, dark.ground));
      groundMaterial.color.copy(groundColor).multiplyScalar(1 - 0.35 * wet);
      blockMaterial.color.copy(color(day.block, dark.block));
      parkMaterial.color.copy(color(day.park, dark.park));
      waterMaterial.color.copy(color(day.water, dark.water));
      waterMaterial.emissive.copy(color(0x000000, 0x0a3546));
      gridMaterial.color.copy(color(day.grid, dark.grid));
      markingMaterial.color.copy(color(day.marking, dark.marking));
      foliageMaterial.color.copy(color(day.foliage, dark.foliage));
      foliageMaterial.emissive.copy(color(0x000000, 0x0f2a1b));
      stage.hemi.color.copy(color(day.hemiSky, dark.hemiSky));
      stage.hemi.groundColor.copy(color(day.hemiGround, dark.hemiGround));
      stage.hemi.intensity = mix(day.hemi, dark.hemi);
      stage.sun.color.copy(color(day.sun, dark.sun));
      stage.sun.intensity = mix(day.sunIntensity, dark.sunIntensity);
      stage.renderer.toneMappingExposure = mix(day.exposure, dark.exposure);
      stage.bloom.strength = mix(day.bloom, dark.bloom);
      stationMaterial.emissiveIntensity = mix(0.35, 1.4);
      for (const entry of entries.values()) {
        entry.base.set(KIND_COLOR[entry.building.kind]).lerp(NIGHT_BASE, 0.78 * night);
        entry.mesh.material.emissiveIntensity = mix(day.windows, dark.windows);
      }
    },
    setWetness(wetness) {
      wet = wetness;
      groundMaterial.color.copy(groundColor).multiplyScalar(1 - 0.35 * wet);
      groundMaterial.roughness = 1 - 0.65 * wet;
      groundMaterial.metalness = 0.25 * wet;
      blockMaterial.roughness = 0.95 - 0.5 * wet;
    },
    setOpacity(next) {
      if (Math.abs(next - opacity) < 0.001) return;
      opacity = next;
      const transparent = opacity < 0.999;
      for (const material of fadable) {
        if (material.transparent !== transparent) {
          material.transparent = transparent;
          material.depthWrite = !transparent;
          material.needsUpdate = true;
        }
        material.opacity = opacity;
      }
      for (const object of shadowCasters) object.castShadow = opacity > 0.6;
      markings.visible = opacity > 0.05;
      ghostMaterial.opacity = (1 - opacity) * 0.55;
      for (const edges of ghostEdges) edges.visible = transparent;
    },
    setBuildingScale(scale) {
      for (const entry of entries.values()) {
        const h = heightOf(entry.building);
        entry.mesh.scale.y = scale;
        entry.mesh.position.y = BLOCK_HEIGHT + (h * scale) / 2;
      }
    },
    update() {
      for (const entry of entries.values()) entry.mesh.material.color.lerp(entry.target, 0.12);
    },
  };
}
