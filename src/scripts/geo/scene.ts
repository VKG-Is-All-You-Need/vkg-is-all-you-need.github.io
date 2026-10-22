/**
 * “VKG × 地理信息”示例的三维场景。
 * 由 scripts/geo/controller.ts 在场景进入视口后按需加载；渲染基础设施见 scripts/three。
 *
 * 两种视图：
 * - 城市：PostGIS 中的街区数据以三维城市呈现。
 * - 分层：自下而上为数据源、映射、虚拟知识图谱与本体，查询按“本体推理 → 映射改写 → 空间 SQL → 返回结果”逐层播放。
 */
import * as THREE from 'three';
import type { Line2 } from 'three/addons/lines/Line2.js';
import { CITY, FACILITY_CLASS, type Building, type City } from '../../lib/geo/city';
import { rectCenter, type Point } from '../../lib/geo/spatial';
import type { Focus, LayerPlan } from '../../lib/geo/queries';
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
import {
  clamp01,
  createBeamTexture,
  easeInOut,
  easeOut,
  escapeHtml,
  rectOutline,
} from '../three/util';

export type { Mode } from '../three/world';
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
  const stage = createStage(container, pinLayer, { reducedMotion: options.reducedMotion });
  const { scene, camera, controls, reduced } = stage;
  controls.minDistance = 160;
  const world = createWorld(stage, city);
  const { entries } = world;
  const park = city.parks[0];
  let mode: Mode = options.mode;
  let view: View = options.view;
  stage.mix = view === 'layers' ? 1 : 0;

  for (const station of city.stations) {
    stage.addPin(
      `<b>M</b>${escapeHtml(station.name)}`,
      toWorld(station.location, 34),
      'pin-station',
      'city',
    );
  }
  stage.addPin(escapeHtml(park.name), toWorld({ x: 800, y: 470 }, 14), 'pin-park', 'city');

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
    const outline = stage.makeLine(
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
    const pin = stage.addPin(
      escapeHtml(name),
      position.clone().setY(LAYER.ontology + 14),
      'pin-class',
      'layers',
    );
    classNodes.set(name, { mesh, position, pin, active: false });
  }
  for (const [child, parent] of STATIC_SUBCLASS) {
    layerRoot.add(
      stage.makeLine(
        [classNodes.get(child)!.position, classNodes.get(parent)!.position],
        AMBER,
        1.2,
        0.35,
        true,
      ),
    );
  }

  // 各层标签
  const layerLabel = (title: string, note: string) => `<b>${title}</b><span>${note}</span>`;
  stage.addPin(
    layerLabel('本体', 'TBox：类与类之间的关系'),
    new THREE.Vector3(-ONTOLOGY_HALF.w, LAYER.ontology, ONTOLOGY_HALF.d),
    'pin-layer pin-layer-onto',
    'layers',
  );
  stage.addPin(
    layerLabel('虚拟知识图谱', '实体按需生成，不做物化'),
    new THREE.Vector3(-HALF_W, LAYER.graph, HALF_D),
    'pin-layer pin-layer-graph',
    'layers',
  );
  stage.addPin(
    layerLabel('映射', 'SQL 结果 → RDF 三元组'),
    new THREE.Vector3(-HALF_W, LAYER.mapping, HALF_D),
    'pin-layer pin-layer-map',
    'layers',
  );
  stage.addPin(
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
  let queryStart = 0;
  let overlayDelay = 0;
  let lastPhase = -1;
  let lastEmit = 0;

  const particleGeometry = new THREE.SphereGeometry(2.6, 10, 8);
  stage.markShared(particleGeometry);
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

  const updateTargets = () => {
    const palette = PALETTE[mode];
    const background = new THREE.Color(palette.background);
    for (const entry of entries.values()) {
      const { building, base, target, mesh } = entry;
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
    world.applyMode(mode);
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
    const outline = new THREE.Shape(world.parkShape.getPoints());
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
      new THREE.ShapeGeometry(world.parkShape),
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
      const line = stage.makeLine([from, from], AMBER, 3, 0.95);
      chain.add(line);
      tweens.push({
        t0: 0.15,
        t1: 0.85,
        update: (k) => stage.setSegment(line, from, from.clone().lerp(to, easeOut(k))),
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
        const line = stage.makeLine([from, from], AMBER, 1.6, 0.75);
        chain.add(line);
        tweens.push({
          t0: 0.9 + jitter,
          t1: 1.35 + jitter,
          update: (k) => stage.setSegment(line, from, from.clone().lerp(anchor.graph, easeOut(k))),
        });
      }

      const beam = stage.makeLine(
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
          stage.setSegment(beam, anchor.graph, anchor.graph.clone().lerp(anchor.data, easeOut(k))),
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
        const pin = stage.addPin(
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
          const pin = stage.addPin(
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
      const line = stage.makeLine(
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
    stage.disposeGroup(overlay);
    stage.disposeGroup(cityBeams);
    stage.disposeGroup(chain);
    for (const p of particles.splice(0)) {
      (p.mesh.material as THREE.Material).dispose();
      p.mesh.removeFromParent();
    }
    pulses.length = 0;
    tweens.length = 0;
    hitBeams.length = 0;
    stage.removePins('pin-hit');
    stage.removePins('pin-chain');
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
    stage.disposeGroup(selectionChain);
    stage.removePins('pin-selected');
    if (id === null) return;
    const building = entries.get(id)!.building;
    const anchor = entityAnchor(`b:${id}`);
    const ink = PALETTE[mode].ink;
    if (!hits.has(id)) {
      stage.addPin(
        escapeHtml(building.name),
        toWorld(rectCenter(building.footprint), BLOCK_HEIGHT + heightOf(building) + 10),
        'pin-selected',
        'city',
      );
    }
    selectionChain.add(stage.makeLine([anchor.data, anchor.graph], ink, 2, 0.9));
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
        stage.makeLine([anchor.graph, classNodes.get(cls)!.position], ink, 1.6, 0.8, true),
      );
    }
    stage.addPin(
      label ?? escapeHtml(building.name),
      anchor.graph.clone().setY(LAYER.graph + 16),
      'pin-selected pin-selected-graph',
      'layers',
    );
  };

  // ── 相机 ──
  const homes = {
    city: () => {
      const scale = stage.framingScale(1.6, 2.2);
      return {
        position: new THREE.Vector3(420, 560, 780).multiplyScalar(scale),
        target: new THREE.Vector3(30, 0, 30),
      };
    },
    layers: () => {
      const scale = stage.framingScale(1.7, 2.4);
      const target = new THREE.Vector3(30, 270, 10);
      return {
        position: target.clone().add(new THREE.Vector3(500, 700, 1740).multiplyScalar(scale)),
        target,
      };
    },
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
    stage.flyTo(toWorld(center), Math.max(380, extent * 1.45));
  };

  const goHome = () => {
    const pose = homes[view]();
    stage.flyToPose(pose.position, pose.target);
  };

  // ── 拾取 ──
  const pickBuilding = (event: PointerEvent): number | null =>
    (stage.pick(event, world.buildingGroup.children)?.object.userData.id as number | undefined) ??
    null;
  stage.onClick((event) => callbacks.onSelect(pickBuilding(event)));
  stage.onHover((event) => {
    const id = pickBuilding(event);
    if (id !== hovered) {
      hovered = id;
      stage.canvas.style.cursor = id ? 'pointer' : '';
      updateTargets();
    }
  });

  let autoRotate = !reduced;
  let idleTimer = 0;
  controls.addEventListener('start', () => {
    controls.autoRotate = false;
    window.clearTimeout(idleTimer);
  });
  controls.addEventListener('end', () => {
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(
      () => (controls.autoRotate = autoRotate && view === 'city'),
      9000,
    );
  });

  const start = homes[view]();
  camera.position.copy(start.position);
  controls.target.copy(start.target);
  controls.autoRotate = autoRotate && view === 'city';

  // ── 每帧更新 ──
  let lastView = '';
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
    const mix = stage.mix;
    layerRoot.visible = mix > 0.01;
    layerRoot.scale.y = Math.max(mix, 0.001);
    for (const material of planeMaterials) material.opacity = PALETTE[mode].planeOpacity * mix;
    world.setBuildingScale(1 - (1 - FLAT) * mix);
    cityBeams.visible = mix < 0.5;
    // 雾随相机距离变化，拉远时不至于把场景整体淡掉
    const distance = camera.position.distanceTo(controls.target);
    stage.fog.near = distance + 250 + 500 * mix;
    stage.fog.far = distance + 2200 + 1200 * mix;
    // 节点在压缩高度时保持球形
    const inverse = 1 / Math.max(mix, 0.05);
    for (const object of [
      ...chain.children,
      ...selectionChain.children,
      ...[...classNodes.values()].map((node) => node.mesh),
    ]) {
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

  stage.onFrame((now) => {
    controls.target.x = THREE.MathUtils.clamp(controls.target.x, -560, 560);
    controls.target.z = THREE.MathUtils.clamp(controls.target.z, -440, 440);
    controls.target.y = THREE.MathUtils.clamp(controls.target.y, 0, 320);

    const targetMix = view === 'layers' ? 1 : 0;
    if (stage.mix !== targetMix) {
      stage.mix = reduced ? targetMix : stage.mix + (targetMix - stage.mix) * 0.08;
      if (Math.abs(stage.mix - targetMix) < 0.002) stage.mix = targetMix;
    }
    applyMix();
    world.update();

    // 查询时间轴
    const elapsed = reduced ? 99 : (now - queryStart) / 1000;
    if (queryActive) {
      for (const tween of tweens) {
        tween.update(clamp01((elapsed - tween.t0) / (tween.t1 - tween.t0)));
      }
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
      if (userData.fade) {
        ((object as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = g * userData.opacity;
      }
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
      p.mesh.scale.set(1, 1 / Math.max(stage.mix, 0.05), 1);
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

    reportView();
  });

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
      stage.addPin(
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
        stage.flyTo(toWorld(rectCenter(building.footprint)), 440);
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
      window.clearTimeout(idleTimer);
      for (const p of particles.splice(0)) (p.mesh.material as THREE.Material).dispose();
      particleGeometry.dispose();
      beamTexture.dispose();
      stage.dispose();
    },
  };
}
