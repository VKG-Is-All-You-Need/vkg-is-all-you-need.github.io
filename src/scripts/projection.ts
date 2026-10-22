import { onPageLoad, prefersReducedMotion, watchVisibility } from './lifecycle';

type Phase = 'mapping' | 'query' | 'reason' | 'rewrite' | 'result';

const PHASES: { phase: Phase; tag: string; text: string; duration: number }[] = [
  {
    phase: 'mapping',
    tag: '映射',
    text: '每一行数据对应图中的一个实体，数据不被复制',
    duration: 3000,
  },
  {
    phase: 'query',
    tag: '查询',
    text: 'SELECT ?name WHERE { ?p a :Person ; :name ?name }',
    duration: 2400,
  },
  { phase: 'reason', tag: '推理', text: ':Student ⊑ :Person，:Teacher ⊑ :Person', duration: 2200 },
  {
    phase: 'rewrite',
    tag: '改写',
    text: 'SELECT name FROM student UNION ALL SELECT name FROM teacher',
    duration: 2800,
  },
  { phase: 'result', tag: '结果', text: '3 行：林晓、周宁、陈老师', duration: 3000 },
];

const KEYS = ['s1', 's2', 't1'] as const;

/** 窄屏下画布可横向滚动时，各阶段的视野位置（0 = 最左，1 = 最右）。 */
const FOCUS: Record<Phase, number> = {
  mapping: 0.35,
  query: 1,
  reason: 1,
  rewrite: 0.5,
  result: 0,
};

const DESCRIPTIONS: Record<string, string> = {
  s1: 'student 表第 1 行 ⇄ :student/1 a :Student',
  s2: 'student 表第 2 行 ⇄ :student/2 a :Student',
  t1: 'teacher 表第 1 行 ⇄ :teacher/1 a :Teacher',
};

const SVG_NS = 'http://www.w3.org/2000/svg';
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

interface Particle {
  path: SVGPathElement;
  length: number;
  element: SVGCircleElement;
  start: number;
  duration: number;
  reverse: boolean;
}

onPageLoad((signal) => {
  const root = document.querySelector<HTMLElement>('[data-projection]');
  const svg = root?.querySelector('svg');
  const layer = svg?.querySelector('[data-particles]');
  const tagEl = root?.querySelector('[data-console-tag]');
  const textEl = root?.querySelector('[data-console-text]');
  if (!root || !svg || !layer || !tagEl || !textEl) return;

  const reduced = prefersReducedMotion();
  const canvas = root.querySelector<HTMLElement>('.canvas');
  let userScrolled = false;
  canvas?.addEventListener('pointerdown', () => (userScrolled = true), { signal });
  const focus = (phase: Phase) => {
    if (!canvas || userScrolled) return;
    const range = canvas.scrollWidth - canvas.clientWidth;
    if (range > 4) canvas.scrollTo({ left: range * FOCUS[phase], behavior: 'smooth' });
  };
  const mapPaths = new Map(
    KEYS.map((key) => [key, svg.querySelector<SVGPathElement>(`.map-flow[data-key="${key}"]`)!]),
  );
  const subPaths = [...svg.querySelectorAll<SVGPathElement>('.sub-flow')];

  const setHot = (keys: readonly string[]) => {
    svg.querySelectorAll('.is-hot').forEach((element) => element.classList.remove('is-hot'));
    for (const key of keys) {
      svg.querySelectorAll(`[data-key="${key}"]`).forEach((el) => el.classList.add('is-hot'));
    }
  };

  // ── 控制台打字效果 ──
  let typing = 0;
  const type = (tag: string, text: string) => {
    window.clearInterval(typing);
    tagEl.textContent = tag;
    if (reduced) {
      textEl.textContent = text;
      return;
    }
    let shown = 0;
    textEl.textContent = '';
    typing = window.setInterval(() => {
      shown += 2;
      textEl.textContent = text.slice(0, shown);
      if (shown >= text.length) window.clearInterval(typing);
    }, 26);
  };

  // ── 沿路径运动的光点 ──
  const particles: Particle[] = [];
  let frame = 0;

  const tick = (now: number) => {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      const t = (now - p.start) / p.duration;
      if (t < 0) continue;
      if (t >= 1) {
        p.element.remove();
        particles.splice(i, 1);
        continue;
      }
      const progress = easeInOut(t);
      const point = p.path.getPointAtLength(p.length * (p.reverse ? 1 - progress : progress));
      p.element.setAttribute('cx', point.x.toFixed(2));
      p.element.setAttribute('cy', point.y.toFixed(2));
      p.element.style.opacity = String(Math.min(1, t * 6, (1 - t) * 6));
    }
    frame = particles.length > 0 ? requestAnimationFrame(tick) : 0;
  };

  const spawn = (
    path: SVGPathElement,
    { delay = 0, duration = 1100, reverse = false, warm = false } = {},
  ) => {
    const element = document.createElementNS(SVG_NS, 'circle');
    element.setAttribute('r', '2.8');
    element.setAttribute('class', warm ? 'particle particle-warm' : 'particle');
    element.style.opacity = '0';
    layer.append(element);
    particles.push({
      path,
      length: path.getTotalLength(),
      element,
      start: performance.now() + delay,
      duration,
      reverse,
    });
    if (!frame) frame = requestAnimationFrame(tick);
  };

  const clearParticles = () => {
    particles.splice(0).forEach((p) => p.element.remove());
    cancelAnimationFrame(frame);
    frame = 0;
  };

  // ── 阶段循环 ──
  let timers: number[] = [];
  const later = (fn: () => void, ms: number) => timers.push(window.setTimeout(fn, ms));
  const clearTimers = () => {
    timers.forEach((id) => window.clearTimeout(id));
    timers = [];
  };

  let index = 0;
  const runPhase = () => {
    const { phase, tag, text, duration } = PHASES[index];
    svg.dataset.phase = phase;
    type(tag, text);
    setHot([]);
    focus(phase);

    if (phase === 'mapping') {
      KEYS.forEach((key, i) => {
        later(() => setHot([key]), i * 700);
        spawn(mapPaths.get(key)!, { delay: i * 700 });
      });
      later(() => setHot([]), KEYS.length * 700 + 400);
    } else if (phase === 'reason') {
      subPaths.forEach((path, i) => {
        spawn(path, { reverse: true, warm: true, delay: i * 250, duration: 900 });
        spawn(path, { reverse: true, warm: true, delay: 1100 + i * 250, duration: 900 });
      });
    } else if (phase === 'rewrite') {
      setHot(KEYS);
      KEYS.forEach((key, i) => spawn(mapPaths.get(key)!, { reverse: true, delay: i * 260 }));
    } else if (phase === 'result') {
      setHot(KEYS);
      KEYS.forEach((key, i) => spawn(mapPaths.get(key)!, { delay: 200 + i * 220, duration: 900 }));
    }

    later(() => {
      index = (index + 1) % PHASES.length;
      runPhase();
    }, duration);
  };

  let started = false;
  let visible = false;
  let hovering = false;
  let running = false;

  const sync = () => {
    const shouldRun = started && visible && !hovering && !document.hidden && !reduced;
    if (shouldRun && !running) {
      running = true;
      runPhase();
    } else if (!shouldRun && running) {
      running = false;
      clearTimers();
      clearParticles();
      window.clearInterval(typing);
      svg.dataset.phase = 'idle';
      setHot([]);
    }
  };

  // ── 悬停联动：行 ⇄ 实体 ──
  svg.querySelectorAll<SVGGElement>('.row[data-key], .entity[data-key]').forEach((element) => {
    const key = element.dataset.key!;
    element.addEventListener(
      'pointerenter',
      () => {
        hovering = true;
        sync();
        setHot([key]);
        type('映射', DESCRIPTIONS[key]);
      },
      { signal },
    );
    element.addEventListener(
      'pointerleave',
      () => {
        hovering = false;
        setHot([]);
        sync();
      },
      { signal },
    );
  });

  watchVisibility(
    root,
    (isVisible) => {
      visible = isVisible;
      sync();
    },
    signal,
  );
  document.addEventListener('visibilitychange', sync, { signal });
  const startTimer = window.setTimeout(
    () => {
      started = true;
      sync();
    },
    reduced ? 0 : 2600,
  );

  signal.addEventListener('abort', () => {
    window.clearTimeout(startTimer);
    window.clearInterval(typing);
    clearTimers();
    clearParticles();
  });
});
