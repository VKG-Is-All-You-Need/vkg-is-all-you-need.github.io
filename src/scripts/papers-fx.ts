import { prefersReducedMotion, watchVisibility } from './lifecycle';

// 文献页动效版本：页首标题解码、星图的扫描点亮、布局切换、传承高亮、提示卡片与筛选联动。

const LAYOUT_KEY = 'papers-sky-layout';

interface StarInfo {
  year: number;
  title: string;
  authors: string;
  venue: string;
  summary: string;
  url: string;
  code: string | null;
  repos: string[];
  topic: string;
  history: string | null;
}

export interface Constellation {
  /** 下次进入视口时重新播放扫描动画（切换到动效模式时调用）。 */
  rearm(): void;
  /** 与列表筛选同步：visible 为当前可见的论文 id；filtered 为 false 时恢复全部星点。 */
  sync(visible: Set<string>, filtered: boolean): void;
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** 标题逐字解码：未定位的字符先随机跳动，再从左到右依次落定。 */
export function decodeTitle(el: HTMLElement, signal: AbortSignal): void {
  if (prefersReducedMotion()) return;
  const target = el.dataset.text ?? el.textContent ?? '';
  el.dataset.text = target;
  const cjk = /[㐀-鿿]/.test(target);
  const pool = cjk ? '本体映射查询知识图谱虚拟数据语义集成推理视图' : 'ABDFGIKMOQRSVX0123456789';
  const chars = [...target];
  const start = performance.now();
  const duration = 900;
  let frame = 0;
  const tick = (now: number) => {
    const k = Math.min(1, (now - start) / duration);
    el.textContent = chars
      .map((c, i) => {
        if (c === ' ' || k >= (i + 1) / chars.length) return c;
        return pool[Math.floor(Math.random() * pool.length)];
      })
      .join('');
    if (k < 1) frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  signal.addEventListener('abort', () => {
    cancelAnimationFrame(frame);
    el.textContent = target;
  });
}

/** 数字从 0 滚动到目标值。 */
function countUp(els: HTMLElement[], reduced: boolean) {
  for (const el of els) {
    const target = Number(el.dataset.count);
    if (reduced) {
      el.textContent = String(target);
      continue;
    }
    const start = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / 1400);
      el.textContent = String(Math.round(target * (1 - (1 - k) ** 3)));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

/** 一种布局在客户端需要的数据，由 Constellation.astro 从 lib/constellation 的结果生成。 */
interface SkyLayout {
  id: string;
  width: number;
  height: number;
  fit: boolean;
  positions: Record<string, [number, number]>;
  progress: Record<string, number>;
  links: string[];
  sweep: { kind: 'line' } | { kind: 'ripple'; r: number } | { kind: 'trace' } | { kind: 'none' };
  rows?: { top: number; height: number }[];
}

const ease = (k: number) => (k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2);

export function initConstellation(root: HTMLElement, signal: AbortSignal): Constellation {
  const scroller = root.querySelector<HTMLElement>('[data-sky-scroll]')!;
  const svg = root.querySelector<SVGSVGElement>('[data-sky-svg]')!;
  const layoutButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-sky-layout]')];
  const rowLabels = [...root.querySelectorAll<HTMLElement>('[data-row]')];
  const notes = [...root.querySelectorAll<HTMLElement>('[data-note]')];
  const dust = svg.querySelector<SVGGElement>('[data-sky-dust]')!;
  const tip = root.querySelector<HTMLElement>('[data-sky-tip]')!;
  const replay = root.querySelector<HTMLButtonElement>('[data-sky-replay]')!;
  const counters = [...root.querySelectorAll<HTMLElement>('[data-count]')];
  const info = JSON.parse(root.querySelector('[data-sky-data]')?.textContent ?? '{}') as Record<
    string,
    StarInfo
  >;
  const layouts = JSON.parse(
    root.querySelector('[data-sky-layouts]')?.textContent ?? '[]',
  ) as SkyLayout[];
  const layers = new Map(
    [...svg.querySelectorAll<SVGGElement>('[data-layer]')].map((el) => [el.dataset.layer!, el]),
  );
  const stars = new Map(
    [...svg.querySelectorAll<SVGGElement>('[data-star]')].map((el) => [el.dataset.star!, el]),
  );
  const links = [...svg.querySelectorAll<SVGGElement>('[data-from]')];
  const reduced = prefersReducedMotion();
  const en = document.documentElement.lang === 'en';
  let layout = layouts.find((item) => item.id === root.dataset.layout) ?? layouts[0];
  const layerOf = (id: string) => layers.get(id)!;

  // ── 扫描：按当前布局的形式推进（竖线、光环或沿路径描绘），进度经过的星点依次点亮 ──
  let frame = 0;
  let userMoved = false;
  const setSweep = (k: number) => {
    const layer = layerOf(layout.id);
    if (layout.sweep.kind === 'line') {
      const x = k * layout.width;
      const line = layer.querySelector('[data-sweep-line]')!;
      const trail = layer.querySelector('[data-sweep-trail]')!;
      line.setAttribute('x1', String(x));
      line.setAttribute('x2', String(x));
      trail.setAttribute('x', String(Math.max(0, x - 140)));
      trail.setAttribute('width', String(Math.min(140, x)));
    } else if (layout.sweep.kind === 'ripple') {
      layer.querySelector('[data-ripple]')!.setAttribute('r', String(k * layout.sweep.r));
    } else if (layout.sweep.kind === 'trace') {
      layer.querySelector<SVGPathElement>('[data-trace]')!.style.strokeDashoffset = String(1 - k);
    }
  };
  /** k 为扫描进度（0–1），与星点及背景元素在当前布局中的进度比较。 */
  const light = (k: number, pop: boolean) => {
    for (const [id, el] of stars) {
      if (!el.classList.contains('is-on') && (layout.progress[id] ?? 0) <= k) {
        el.classList.add('is-on');
        if (pop) el.classList.add('is-pop');
      }
    }
    for (const el of layerOf(layout.id).querySelectorAll<SVGElement>('[data-p]')) {
      if (Number(el.dataset.p) <= k) el.classList.add('is-on');
    }
    for (const link of links) {
      if (
        !link.classList.contains('is-on') &&
        stars.get(link.dataset.from!)!.classList.contains('is-on') &&
        stars.get(link.dataset.to!)!.classList.contains('is-on')
      ) {
        link.classList.add('is-on');
      }
    }
  };
  const finish = () => {
    light(Infinity, false);
    // 其他布局的背景元素也一并显示，切换过去时无需再等扫描
    svg.querySelectorAll('[data-p]').forEach((el) => el.classList.add('is-on'));
    svg.classList.remove('is-sweeping');
    svg.classList.add('is-done');
  };
  const play = () => {
    cancelAnimationFrame(frame);
    for (const [, el] of stars) el.classList.remove('is-on', 'is-pop');
    for (const el of [...links, ...svg.querySelectorAll('[data-p]')]) el.classList.remove('is-on');
    svg.classList.remove('is-done');
    countUp(counters, reduced);
    if (reduced) {
      finish();
      return;
    }
    svg.classList.add('is-sweeping');
    userMoved = false;
    const duration = 3800;
    const start = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / duration);
      const eased = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      setSweep(eased);
      light(eased, true);
      // 横向滚动的布局中，视野跟着扫描线移动
      if (!userMoved && !layout.fit) {
        scroller.scrollLeft = Math.max(0, eased * layout.width - scroller.clientWidth * 0.62);
      }
      if (k < 1) frame = requestAnimationFrame(step);
      else finish();
    };
    frame = requestAnimationFrame(step);
  };

  let started = false;
  watchVisibility(
    root,
    (visible) => {
      // 标准模式下星图不显示（尺寸为 0）；切换到动效模式后元素重新出现，观察器会再次回调
      if (visible && !started && root.offsetWidth > 0) {
        started = true;
        play();
      }
    },
    signal,
    '0px 0px -15% 0px',
  );
  replay.addEventListener('click', play, { signal });
  signal.addEventListener('abort', () => cancelAnimationFrame(frame));

  // ── 布局切换：星点经 CSS 过渡移动到新坐标，画布尺寸同步变化，连线在星点落定后重新描绘 ──
  let sizeFrame = 0;
  let morphTimer = 0;
  const setSize = (w: number, h: number) => {
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));
  };
  const setLinkPaths = () => {
    links.forEach((link, i) => {
      link.querySelectorAll('path').forEach((path) => path.setAttribute('d', layout.links[i]));
    });
  };
  const setLayout = (id: string, animate: boolean) => {
    const next = layouts.find((item) => item.id === id);
    if (!next) return;
    const previous = layout;
    layout = next;
    root.dataset.layout = layout.id;
    root.classList.toggle('is-fit', layout.fit);
    root.classList.toggle('is-stacked', !layout.rows);
    for (const button of layoutButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.skyLayout === layout.id));
    }
    for (const [layerId, layer] of layers)
      layer.classList.toggle('is-active', layerId === layout.id);
    rowLabels.forEach((label, i) => {
      const row = layout.rows?.[i];
      label.style.top = row ? `${row.top}px` : '';
      label.style.height = row ? `${row.height}px` : '';
    });
    for (const note of notes) note.hidden = note.dataset.note !== layout.id;
    const move = animate && !reduced;
    for (const [starId, el] of stars) {
      const [x, y] = layout.positions[starId];
      el.style.setProperty('--cx', String(x));
      el.style.setProperty('--cy', String(y));
      el.style.setProperty(
        '--delay',
        move ? `${Math.round((layout.progress[starId] ?? 0) * 400)}ms` : '0ms',
      );
    }
    clearFocus();
    pinned = null;
    if (layout.fit) scroller.scrollLeft = 0;
    cancelAnimationFrame(sizeFrame);
    window.clearTimeout(morphTimer);
    if (!move) {
      setSize(layout.width, layout.height);
      setLinkPaths();
      svg.classList.remove('is-morphing');
      return;
    }
    const from = { w: svg.viewBox.baseVal.width || previous.width, h: svg.viewBox.baseVal.height };
    const start = performance.now();
    const step = (now: number) => {
      const k = ease(Math.min(1, (now - start) / 900));
      setSize(from.w + (layout.width - from.w) * k, from.h + (layout.height - from.h) * k);
      if (now - start < 900) sizeFrame = requestAnimationFrame(step);
    };
    sizeFrame = requestAnimationFrame(step);
    // 连线先淡出，星点落定后换成新布局的路径并重新描绘
    svg.classList.add('is-morphing');
    morphTimer = window.setTimeout(() => {
      setLinkPaths();
      const drawn = links.filter((link) => link.classList.contains('is-on'));
      for (const link of drawn) link.classList.remove('is-on');
      void svg.getBoundingClientRect();
      svg.classList.remove('is-morphing');
      for (const link of drawn) link.classList.add('is-on');
    }, 1250);
  };
  signal.addEventListener('abort', () => {
    cancelAnimationFrame(sizeFrame);
    window.clearTimeout(morphTimer);
  });

  // ── 指针视差：背景星点随指针轻微移动 ──
  if (!reduced) {
    root.addEventListener(
      'pointermove',
      (event) => {
        const rect = root.getBoundingClientRect();
        const px = (event.clientX - rect.left) / rect.width - 0.5;
        const py = (event.clientY - rect.top) / rect.height - 0.5;
        dust.style.setProperty('--px', `${(-px * 14).toFixed(1)}px`);
        dust.style.setProperty('--py', `${(-py * 10).toFixed(1)}px`);
      },
      { passive: true, signal },
    );
  }

  // ── 传承高亮与提示卡片 ──
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const link of links) {
    const { from, to } = link.dataset as { from: string; to: string };
    outgoing.set(from, [...(outgoing.get(from) ?? []), to]);
    incoming.set(to, [...(incoming.get(to) ?? []), from]);
  }
  const walk = (start: string, edges: Map<string, string[]>) => {
    const seen = new Set<string>([start]);
    const queue = [start];
    while (queue.length) {
      for (const next of edges.get(queue.shift()!) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return seen;
  };

  let pinned: string | null = null;
  const clearFocus = () => {
    svg.classList.remove('has-focus');
    svg.querySelectorAll('.is-related, .is-focus').forEach((el) => {
      el.classList.remove('is-related', 'is-focus');
    });
    tip.hidden = true;
  };
  const showTip = (id: string) => {
    const item = info[id];
    const el = stars.get(id);
    if (!item || !el) return;
    // 星点经 transform 定位，且放射布局可能缩放；按屏幕位置换算到滚动容器内的坐标
    const dot = el.querySelector('.star-hit')!.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    const x = dot.left + dot.width / 2 - box.left + scroller.scrollLeft;
    const y = dot.top + dot.height / 2 - box.top;
    const codeRepo = item.code?.match(/github\.com\/([^/]+\/[^/#?]+)/)?.[1];
    const repos = item.repos.filter((repo) => repo !== codeRepo);
    const linksHtml = [
      `<a href="#${id}">${en ? 'Show in list ↓' : '在列表中查看 ↓'}</a>`,
      `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${en ? 'Paper' : '论文'} ↗</a>`,
      item.code
        ? `<a href="${escapeHtml(item.code)}" target="_blank" rel="noopener">${en ? 'Code' : '代码'} ↗</a>`
        : '',
      ...repos.map(
        (repo) =>
          `<a href="https://github.com/${escapeHtml(repo)}" target="_blank" rel="noopener">${escapeHtml(repo)} ↗</a>`,
      ),
      item.history
        ? `<a href="${escapeHtml(item.history)}">${en ? 'History →' : '发展历程 →'}</a>`
        : '',
    ].join('');
    tip.innerHTML = `<p class="tip-meta"><span>${item.year}</span><span>${escapeHtml(item.topic)} · ${escapeHtml(item.venue)}</span></p><p class="tip-title">${escapeHtml(item.title)}</p><p class="tip-authors">${escapeHtml(item.authors)}</p><p class="tip-text">${escapeHtml(item.summary)}</p><p class="tip-links">${linksHtml}</p>`;
    tip.hidden = false;
    tip.style.width = `${Math.min(320, scroller.clientWidth - 16)}px`;
    const tipWidth = tip.offsetWidth;
    const tipHeight = tip.offsetHeight;
    const minLeft = scroller.scrollLeft + 8;
    const maxLeft = scroller.scrollLeft + scroller.clientWidth - tipWidth - 8;
    const left = Math.min(Math.max(minLeft, x - 24), maxLeft);
    const below = y + 18 + tipHeight < scroller.clientHeight;
    tip.style.left = `${left}px`;
    tip.style.top = `${below ? y + 18 : Math.max(6, y - tipHeight - 16)}px`;
  };
  const focus = (id: string) => {
    clearFocus();
    const related = new Set([...walk(id, outgoing), ...walk(id, incoming)]);
    svg.classList.add('has-focus');
    for (const rid of related) stars.get(rid)?.classList.add('is-related');
    stars.get(id)?.classList.add('is-focus');
    for (const link of links) {
      if (related.has(link.dataset.from!) && related.has(link.dataset.to!)) {
        link.classList.add('is-related');
      }
    }
    showTip(id);
  };

  for (const [id, el] of stars) {
    el.addEventListener(
      'pointerenter',
      (event) => {
        if (event.pointerType === 'mouse' && !pinned) focus(id);
      },
      { signal },
    );
    el.addEventListener(
      'pointerleave',
      (event) => {
        if (event.pointerType === 'mouse' && !pinned) clearFocus();
      },
      { signal },
    );
    el.addEventListener(
      'click',
      (event) => {
        event.stopPropagation();
        userMoved = true;
        if (pinned === id) {
          pinned = null;
          clearFocus();
        } else {
          pinned = id;
          focus(id);
        }
      },
      { signal },
    );
    el.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          pinned = id;
          focus(id);
        }
      },
      { signal },
    );
    el.addEventListener('focus', () => focus(id), { signal });
  }
  tip.addEventListener(
    'click',
    (event) => {
      event.stopPropagation();
      // 跳到列表后收起卡片
      if ((event.target as Element).closest('a[href^="#"]')) {
        pinned = null;
        clearFocus();
      }
    },
    { signal },
  );
  document.addEventListener(
    'click',
    () => {
      if (pinned) {
        pinned = null;
        clearFocus();
      }
    },
    { signal },
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape') {
        pinned = null;
        clearFocus();
      }
    },
    { signal },
  );
  scroller.addEventListener('pointerdown', () => (userMoved = true), { signal });

  let stored: string | null = null;
  try {
    stored = localStorage.getItem(LAYOUT_KEY);
  } catch {}
  if (stored && stored !== layout.id) setLayout(stored, false);
  for (const button of layoutButtons) {
    button.addEventListener(
      'click',
      () => {
        const id = button.dataset.skyLayout!;
        if (id === layout.id) return;
        try {
          localStorage.setItem(LAYOUT_KEY, id);
        } catch {}
        setLayout(id, true);
      },
      { signal },
    );
  }
  scroller.addEventListener('wheel', () => (userMoved = true), { passive: true, signal });

  return {
    rearm() {
      started = false;
    },
    sync(visible, filtered) {
      svg.classList.toggle('is-filtered', filtered);
      for (const [id, el] of stars) el.classList.toggle('is-off', filtered && !visible.has(id));
    },
  };
}
