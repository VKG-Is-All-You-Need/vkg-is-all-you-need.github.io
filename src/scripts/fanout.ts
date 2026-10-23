import { onPageLoad, prefersReducedMotion, watchVisibility } from './lifecycle';

type Phase = 'query' | 'rewrite' | 'execute' | 'result';

const PHASES: { phase: Phase; duration: number }[] = [
  { phase: 'query', duration: 2600 },
  { phase: 'rewrite', duration: 2600 },
  { phase: 'execute', duration: 2600 },
  { phase: 'result', duration: 3800 },
];

/** 查询涉及的数据源；production 不被访问。 */
const USED = ['wellbore', 'FIELD', 'company'];

/** 控制台各阶段的标签与文字。 */
const CONSOLE: Record<'zh' | 'en', Record<Phase, [tag: string, text: string]>> = {
  zh: {
    query: ['查询', '用本体词汇描述问题：2010 年以后完钻、由 Equinor 作业的油田中的井'],
    rewrite: ['改写', 'Ontop 依据本体与映射生成 SQL，联邦引擎把它拆分到 3 个数据源'],
    execute: ['执行', '各数据源返回匹配的行；查询不涉及产量数据，数据湖不被访问'],
    result: ['结果', '4 行，以本体词汇返回，与各库的表名和列名无关'],
  },
  en: {
    query: [
      'Query',
      'The question in ontology terms: wells completed since 2010 in fields operated by Equinor',
    ],
    rewrite: [
      'Rewriting',
      'Ontop generates SQL from the ontology and mappings; the federation engine splits it across 3 sources',
    ],
    execute: [
      'Execution',
      'Each source returns the matching rows; the data lake holds no data the query needs and is not accessed',
    ],
    result: ['Result', '4 rows in ontology terms, independent of table and column names'],
  },
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
  const root = document.querySelector<HTMLElement>('[data-fanout]');
  const svg = root?.querySelector('svg');
  const layer = svg?.querySelector('[data-particles]');
  const tagEl = root?.querySelector('[data-console-tag]');
  const textEl = root?.querySelector('[data-console-text]');
  if (!root || !svg || !layer || !tagEl || !textEl) return;

  const reduced = prefersReducedMotion();
  const lang = document.documentElement.lang === 'en' ? 'en' : 'zh';
  const edge = (key: string) => svg.querySelector<SVGPathElement>(`[data-edge="${key}"]`)!;
  const source = (key: string) => svg.querySelector<SVGGElement>(`[data-source="${key}"]`)!;

  const setHot = (keys: string[]) => {
    svg.querySelectorAll('.edge-flow').forEach((path) => {
      path.classList.toggle('is-hot', keys.includes((path as SVGPathElement).dataset.edge!));
    });
    svg.querySelectorAll<SVGGElement>('[data-source]').forEach((group) => {
      group.classList.toggle('is-hot', keys.includes(group.dataset.source!));
    });
  };
  const setDone = (keys: string[]) => {
    svg.querySelectorAll<SVGGElement>('[data-source]').forEach((group) => {
      group.classList.toggle('is-done', keys.includes(group.dataset.source!));
    });
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
    }, 24);
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

  const spawn = (path: SVGPathElement, { delay = 0, duration = 900, reverse = false } = {}) => {
    const element = document.createElementNS(SVG_NS, 'circle');
    element.setAttribute('r', '2.8');
    element.setAttribute('class', 'particle');
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
    const { phase, duration } = PHASES[index];
    const [tag, text] = CONSOLE[lang][phase];
    svg.dataset.phase = phase;
    type(tag, text);

    if (phase === 'query') {
      setHot([]);
      setDone([]);
      later(() => {
        setHot(['query']);
        spawn(edge('query'), { duration: 700 });
      }, 1300);
    } else if (phase === 'rewrite') {
      setHot(['query', 'ontop']);
      spawn(edge('ontop'), { delay: 300, duration: 600 });
      later(() => {
        setHot(['ontop', ...USED]);
        USED.forEach((key, i) => spawn(edge(key), { delay: i * 180 }));
      }, 1000);
    } else if (phase === 'execute') {
      setHot(USED);
      USED.forEach((key, i) => {
        later(() => setDone([...USED.slice(0, i + 1)]), 300 + i * 260);
        spawn(edge(key), { delay: 500 + i * 180, reverse: true });
      });
      later(() => {
        setHot(['ontop']);
        spawn(edge('ontop'), { reverse: true, duration: 600 });
      }, 1700);
    } else {
      setHot(['result']);
      spawn(edge('result'), { duration: 700 });
      later(() => setHot([]), 1600);
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

  const reset = () => {
    svg.dataset.phase = 'idle';
    setHot([]);
    setDone([]);
  };

  const sync = () => {
    const shouldRun = started && visible && !hovering && !document.hidden && !reduced;
    if (shouldRun && !running) {
      running = true;
      index = 0;
      runPhase();
    } else if (!shouldRun && running) {
      running = false;
      clearTimers();
      clearParticles();
      window.clearInterval(typing);
      reset();
    }
  };

  // ── 悬停数据源：显示表结构与分到的 SQL ──
  const tips = new Map(
    [...root.querySelectorAll<HTMLElement>('[data-tip]')].map((tip) => [tip.dataset.tip!, tip]),
  );
  const open = (key: string | null) => {
    tips.forEach((tip, k) => tip.classList.toggle('is-open', k === key));
  };

  svg.querySelectorAll<SVGGElement>('[data-source]').forEach((group) => {
    const key = group.dataset.source!;
    const enter = () => {
      hovering = true;
      sync();
      setHot(USED.includes(key) ? [key] : []);
      source(key).classList.add('is-hot');
      open(key);
    };
    const leave = () => {
      hovering = false;
      open(null);
      setHot([]);
      sync();
    };
    group.addEventListener('pointerenter', enter, { signal });
    group.addEventListener('pointerleave', leave, { signal });
    group.addEventListener('focus', enter, { signal });
    group.addEventListener('blur', leave, { signal });
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
    reduced ? 0 : 2200,
  );

  signal.addEventListener('abort', () => {
    window.clearTimeout(startTimer);
    window.clearInterval(typing);
    clearTimers();
    clearParticles();
  });
});
