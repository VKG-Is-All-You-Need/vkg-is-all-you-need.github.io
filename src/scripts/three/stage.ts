/**
 * 三维舞台：渲染器、相机与控制器、后期泛光、灯光、HTML 标签、Line2 连线、相机飞行、拾取，
 * 以及按可见性启停的渲染循环。具体场景（地理示例、城市示例）在此之上搭建内容。
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
import { easeInOut } from './util';

export type PinView = 'both' | 'city' | 'layers';

export interface Pin {
  element: HTMLElement;
  /** 分层元素的锚点使用“完全展开”时的坐标，投影时按展开程度 mix 缩放高度。 */
  anchor: THREE.Vector3;
  view: PinView;
  shown: boolean;
}

export interface Stage {
  container: HTMLElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  bloom: UnrealBloomPass;
  hemi: THREE.HemisphereLight;
  sun: THREE.DirectionalLight;
  fog: THREE.Fog;
  canvas: HTMLCanvasElement;
  reduced: boolean;
  /** 分层展开程度：0 为城市视图，1 为完全展开的分层视图。 */
  mix: number;
  addPin(
    html: string,
    anchor: THREE.Vector3,
    className: string,
    view?: PinView,
    shown?: boolean,
  ): Pin;
  removePins(className: string): void;
  makeLine(
    points: THREE.Vector3[],
    color: THREE.ColorRepresentation,
    width: number,
    opacity?: number,
    dashed?: boolean,
  ): Line2;
  /** 原地更新单段线的端点，用于“生长”动画。 */
  setSegment(line: Line2, a: THREE.Vector3, b: THREE.Vector3): void;
  /** 原地更新折线的各点（点数须与创建时相同），用于跟随移动对象的连线。 */
  setPath(line: Line2, points: THREE.Vector3[]): void;
  disposeGroup(group: THREE.Object3D): void;
  /** 标记多处复用的几何体，disposeGroup 时不释放。 */
  markShared(geometry: THREE.BufferGeometry): void;
  flyToPose(position: THREE.Vector3, target: THREE.Vector3, duration?: number): void;
  flyTo(target: THREE.Vector3, distance: number): void;
  cancelFlight(): void;
  /** 画面越窄，相机越远，保证宽内容在水平方向完整可见。 */
  framingScale(reference: number, max: number): number;
  pick(event: PointerEvent, objects: THREE.Object3D[]): THREE.Intersection | null;
  /** 注册每帧回调，dt 为秒。 */
  onFrame(callback: (now: number, dt: number) => void): void;
  /** 注册点击（非拖动）回调。 */
  onClick(callback: (event: PointerEvent) => void): void;
  onHover(callback: (event: PointerEvent) => void): void;
  dispose(): void;
}

export function createStage(
  container: HTMLElement,
  pinLayer: HTMLElement,
  options: { reducedMotion: boolean; target?: THREE.Vector3 },
): Stage {
  const reduced = options.reducedMotion;

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
  const canvas = renderer.domElement;

  const scene = new THREE.Scene();
  const fog = new THREE.Fog(0x000000, 1300, 3200);
  scene.fog = fog;

  const camera = new THREE.PerspectiveCamera(36, 1, 5, 12000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 60;
  // 竖屏时需要拉远才能看全街区，上限随之放宽
  controls.maxDistance = 7000;
  controls.minPolarAngle = 0.2;
  controls.maxPolarAngle = 1.36;
  controls.autoRotateSpeed = 0.35;

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.8, 0.55, 0.78);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

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

  // ── 标签 ──
  const pins: Pin[] = [];
  const addPin: Stage['addPin'] = (html, anchor, className, view = 'both', shown = true) => {
    const element = document.createElement('div');
    element.className = `geo-pin ${className}`;
    element.innerHTML = html;
    pinLayer.append(element);
    const pin = { element, anchor, view, shown };
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

  // ── 线条 ──
  const lineMaterials = new Set<LineMaterial>();
  const makeLine: Stage['makeLine'] = (points, color, width, opacity = 1, dashed = false) => {
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
  const setSegment: Stage['setSegment'] = (line, a, b) => {
    const attribute = line.geometry.getAttribute(
      'instanceStart',
    ) as THREE.InterleavedBufferAttribute;
    attribute.data.array.set([a.x, a.y, a.z, b.x, b.y, b.z]);
    attribute.data.needsUpdate = true;
  };
  const setPath: Stage['setPath'] = (line, points) => {
    const attribute = line.geometry.getAttribute(
      'instanceStart',
    ) as THREE.InterleavedBufferAttribute;
    const array = attribute.data.array as Float32Array;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      array.set([a.x, a.y, a.z, b.x, b.y, b.z], (i - 1) * 6);
    }
    attribute.data.needsUpdate = true;
  };
  const sharedGeometries = new Set<THREE.BufferGeometry>();
  const disposeGroup: Stage['disposeGroup'] = (group) => {
    group.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof Line2) {
        if (!sharedGeometries.has(object.geometry)) object.geometry.dispose();
        const material = object.material as THREE.Material;
        if (material instanceof LineMaterial) lineMaterials.delete(material);
        material.dispose();
      }
    });
    group.clear();
  };

  // ── 相机飞行 ──
  let flight: {
    from: THREE.Vector3;
    to: THREE.Vector3;
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
    start: number;
    duration: number;
  } | null = null;
  const flyToPose: Stage['flyToPose'] = (position, target, duration = 1400) => {
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
      duration,
    };
  };
  const flyTo: Stage['flyTo'] = (target, distance) => {
    const direction = camera.position.clone().sub(controls.target).normalize();
    direction.y = Math.max(direction.y, 0.62);
    direction.normalize();
    flyToPose(target.clone().add(direction.multiplyScalar(distance)), target);
  };
  const framingScale: Stage['framingScale'] = (reference, max) =>
    THREE.MathUtils.clamp(reference / (camera.aspect || reference), 1, max);

  // ── 拾取与指针 ──
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const pick: Stage['pick'] = (event, objects) => {
    const rect = canvas.getBoundingClientRect();
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    return raycaster.intersectObjects(objects, false)[0] ?? null;
  };
  const clickCallbacks: ((event: PointerEvent) => void)[] = [];
  const hoverCallbacks: ((event: PointerEvent) => void)[] = [];
  let downAt: { x: number; y: number } | null = null;
  const onPointerDown = (event: PointerEvent) => {
    downAt = { x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event: PointerEvent) => {
    if (!downAt || Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > 5) return;
    downAt = null;
    clickCallbacks.forEach((callback) => callback(event));
  };
  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse' || event.buttons) return;
    hoverCallbacks.forEach((callback) => callback(event));
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointermove', onPointerMove);
  controls.addEventListener('start', () => (flight = null));

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

  // ── 渲染循环 ──
  const frameCallbacks: ((now: number, dt: number) => void)[] = [];
  const projected = new THREE.Vector3();
  const scratch = new THREE.Vector3();

  const stage: Stage = {
    container,
    renderer,
    scene,
    camera,
    controls,
    bloom,
    hemi,
    sun,
    fog,
    canvas,
    reduced,
    mix: 0,
    addPin,
    removePins,
    makeLine,
    setSegment,
    setPath,
    disposeGroup,
    markShared: (geometry) => sharedGeometries.add(geometry),
    flyToPose,
    flyTo,
    cancelFlight: () => (flight = null),
    framingScale,
    pick,
    onFrame: (callback) => frameCallbacks.push(callback),
    onClick: (callback) => clickCallbacks.push(callback),
    onHover: (callback) => hoverCallbacks.push(callback),
    dispose,
  };

  const updatePins = () => {
    const { clientWidth: width, clientHeight: height } = container;
    const mix = stage.mix;
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

  let frame = 0;
  let last = 0;
  const tick = (now: number) => {
    frame = requestAnimationFrame(tick);
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
    last = now;
    if (flight) {
      const t = Math.min(1, (now - flight.start) / flight.duration);
      const k = easeInOut(t);
      camera.position.lerpVectors(flight.from, flight.to, k);
      controls.target.lerpVectors(flight.fromTarget, flight.toTarget, k);
      if (t >= 1) flight = null;
    }
    controls.update();
    frameCallbacks.forEach((callback) => callback(now, dt));
    composer.render();
    updatePins();
  };

  let running = false;
  const setRunning = (value: boolean) => {
    if (value === running) return;
    running = value;
    last = 0;
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

  function dispose() {
    setRunning(false);
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
      (Array.isArray(material) ? material : material ? [material] : []).forEach((m) => {
        for (const value of Object.values(m)) if (value instanceof THREE.Texture) value.dispose();
        m.dispose();
      });
    });
    composer.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
    pins.forEach((pin) => pin.element.remove());
  }

  return stage;
}
