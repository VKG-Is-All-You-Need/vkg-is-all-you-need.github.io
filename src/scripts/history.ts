import { onPageLoad, prefersReducedMotion, watchVisibility } from './lifecycle';
import { placeTip } from './tip';

// 发展历程页：页首缩写轮换、全景图的扫描动画与传承高亮、名称定位，以及时期导航。

interface MilestoneInfo {
  year: number;
  label: string;
  text: string;
  cite: string;
  href: string;
  external: boolean;
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** 页首的大字在 OBDA、OBDI、OBDM… 之间轮换，切换时逐字乱码过渡。 */
function initAcronym(el: HTMLElement, signal: AbortSignal) {
  const words = JSON.parse(el.dataset.acronym ?? '[]') as string[];
  if (words.length < 2 || prefersReducedMotion()) return;
  const letters = 'ABDFGIKMOQV';
  let index = 0;
  let timer = 0;
  let frame = 0;
  const scramble = (target: string) => {
    const start = performance.now();
    const from = el.textContent ?? '';
    const length = Math.max(from.length, target.length);
    const tick = (now: number) => {
      const k = Math.min(1, (now - start) / 520);
      let out = '';
      for (let i = 0; i < length; i++) {
        const settle = (i + 1) / length;
        if (k >= settle) out += target[i] ?? '';
        else out += letters[Math.floor(Math.random() * letters.length)];
      }
      el.textContent = out;
      if (k < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  };
  timer = window.setInterval(() => {
    index = (index + 1) % words.length;
    scramble(words[index]);
  }, 2600);
  signal.addEventListener('abort', () => {
    window.clearInterval(timer);
    cancelAnimationFrame(frame);
  });
}

function initPanorama(root: HTMLElement, signal: AbortSignal) {
  const scroller = root.querySelector<HTMLElement>('[data-panorama-scroll]')!;
  const svg = root.querySelector<SVGSVGElement>('[data-panorama-svg]')!;
  const cursor = svg.querySelector<SVGLineElement>('[data-cursor]')!;
  const trail = svg.querySelector<SVGRectElement>('[data-cursor-trail]')!;
  const tip = root.querySelector<HTMLElement>('[data-panorama-tip]')!;
  const replay = root.querySelector<HTMLButtonElement>('[data-panorama-replay]')!;
  const info = JSON.parse(
    root.querySelector('[data-panorama-data]')?.textContent ?? '{}',
  ) as Record<string, MilestoneInfo>;

  const nodes = new Map(
    [...svg.querySelectorAll<SVGGElement>('[data-node]')].map((el) => [el.dataset.node!, el]),
  );
  const links = [...svg.querySelectorAll<SVGGElement>('[data-from]')];
  const width = svg.viewBox.baseVal.width;
  const reduced = prefersReducedMotion();
  const en = document.documentElement.lang === 'en';

  // ── 扫描动画：时间游标从 2002 扫到 2026，经过的节点依次点亮 ──
  let frame = 0;
  let userMoved = false;
  const setCursor = (x: number) => {
    cursor.setAttribute('x1', String(x));
    cursor.setAttribute('x2', String(x));
    trail.setAttribute('x', String(Math.max(0, x - 160)));
    trail.setAttribute('width', String(Math.min(160, x)));
  };
  const light = (x: number, pop: boolean) => {
    for (const [, el] of nodes) {
      if (!el.classList.contains('is-on') && Number(el.dataset.x) <= x) {
        el.classList.add('is-on');
        if (pop) el.classList.add('is-pop');
      }
    }
    for (const link of links) {
      if (
        !link.classList.contains('is-on') &&
        nodes.get(link.dataset.from!)!.classList.contains('is-on') &&
        nodes.get(link.dataset.to!)!.classList.contains('is-on')
      ) {
        link.classList.add('is-on');
      }
    }
  };
  const finish = () => {
    light(Infinity, false);
    svg.classList.remove('is-sweeping');
    svg.classList.add('is-flowing');
  };
  const sweep = () => {
    cancelAnimationFrame(frame);
    for (const [, el] of nodes) el.classList.remove('is-on', 'is-pop');
    for (const link of links) link.classList.remove('is-on');
    svg.classList.remove('is-flowing');
    if (reduced) {
      finish();
      return;
    }
    svg.classList.add('is-sweeping');
    userMoved = false;
    const duration = 4600;
    const start = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / duration);
      const eased = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      const x = eased * width;
      setCursor(x);
      light(x, true);
      // 画布比视口宽时，视野跟着游标移动
      if (!userMoved) {
        scroller.scrollLeft = Math.max(0, x - scroller.clientWidth * 0.62);
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
      if (visible && !started) {
        started = true;
        sweep();
      }
    },
    signal,
    '0px 0px -20% 0px',
  );
  replay.addEventListener('click', sweep, { signal });
  signal.addEventListener('abort', () => cancelAnimationFrame(frame));

  // ── 传承高亮：悬停或选中节点时，点亮它的全部前驱与后继 ──
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
  const focus = (id: string) => {
    clearFocus();
    const related = new Set([...walk(id, outgoing), ...walk(id, incoming)]);
    svg.classList.add('has-focus');
    for (const rid of related) nodes.get(rid)?.classList.add('is-related');
    nodes.get(id)?.classList.add('is-focus');
    for (const link of links) {
      if (related.has(link.dataset.from!) && related.has(link.dataset.to!)) {
        link.classList.add('is-related');
      }
    }
    showTip(id);
    // 只有点击固定后，卡片才接收指针（悬停时卡片若接收指针，会抢走节点的悬停状态）
    tip.classList.toggle('is-pinned', pinned === id);
  };
  const showTip = (id: string) => {
    const item = info[id];
    const el = nodes.get(id);
    if (!item || !el) return;
    const dot = el.querySelector('circle')!;
    const x = Number(dot.getAttribute('cx'));
    const y = Number(dot.getAttribute('cy'));
    const target = item.external ? ' target="_blank" rel="noopener"' : '';
    tip.innerHTML = `<p class="tip-year">${item.year}</p><p class="tip-title">${escapeHtml(item.label)}</p><p class="tip-text">${escapeHtml(item.text)}</p><a class="tip-cite" href="${escapeHtml(item.href)}"${target}>${escapeHtml(item.cite)} ${item.external ? '↗' : en ? '→ Papers' : '→ 文献页'}</a>`;
    tip.hidden = false;
    placeTip(tip, scroller, x, y, 300);
  };

  for (const [id, el] of nodes) {
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
  tip.addEventListener('click', (event) => event.stopPropagation(), { signal });
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

  // ── 拖动平移 ──
  let drag: { x: number; left: number; moved: boolean } | null = null;
  scroller.addEventListener(
    'pointerdown',
    (event) => {
      userMoved = true;
      if (event.pointerType !== 'mouse' || (event.target as Element).closest('[data-node], .tip'))
        return;
      drag = { x: event.clientX, left: scroller.scrollLeft, moved: false };
      scroller.classList.add('is-dragging');
    },
    { signal },
  );
  window.addEventListener(
    'pointermove',
    (event) => {
      if (!drag) return;
      const dx = event.clientX - drag.x;
      if (Math.abs(dx) > 3) drag.moved = true;
      scroller.scrollLeft = drag.left - dx;
    },
    { signal },
  );
  window.addEventListener(
    'pointerup',
    () => {
      drag = null;
      scroller.classList.remove('is-dragging');
    },
    { signal },
  );
  scroller.addEventListener('wheel', () => (userMoved = true), { passive: true, signal });

  /** 供名称列表调用：滚动到全景图并选中某个里程碑。 */
  return (id: string) => {
    const el = nodes.get(id);
    if (!el) return;
    finish();
    cancelAnimationFrame(frame);
    userMoved = true;
    root.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
    const x = Number(el.dataset.x);
    scroller.scrollTo({
      left: Math.max(0, x - scroller.clientWidth / 2),
      behavior: reduced ? 'auto' : 'smooth',
    });
    pinned = id;
    focus(id);
  };
}

function initEras(root: HTMLElement, signal: AbortSignal) {
  const sections = [...root.querySelectorAll<HTMLElement>('[data-era-section]')];
  const navLinks = new Map(
    [...root.querySelectorAll<HTMLAnchorElement>('[data-era-link]')].map((a) => [
      a.dataset.eraLink!,
      a,
    ]),
  );
  const yearEl = root.querySelector<HTMLElement>('[data-era-year]');
  const progress = root.querySelector<HTMLElement>('[data-era-progress]');
  const list = root.querySelector<HTMLElement>('.era-list')!;
  const reduced = prefersReducedMotion();
  let active = '';
  let shownYear = Number(yearEl?.textContent ?? 0);
  let frame = 0;

  /** 年份计数器滚动到目标年份。 */
  const countTo = (year: number) => {
    if (!yearEl) return;
    cancelAnimationFrame(frame);
    if (reduced) {
      shownYear = year;
      yearEl.textContent = String(year);
      return;
    }
    const from = shownYear;
    const start = performance.now();
    const tick = (now: number) => {
      const k = Math.min(1, (now - start) / 600);
      shownYear = Math.round(from + (year - from) * (1 - (1 - k) ** 3));
      yearEl.textContent = String(shownYear);
      if (k < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  };

  const sync = () => {
    const mark = window.innerHeight * 0.35;
    let current = sections[0];
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= mark) current = section;
    }
    if (current.dataset.eraSection !== active) {
      active = current.dataset.eraSection!;
      navLinks.forEach((a, id) => a.classList.toggle('is-active', id === active));
      countTo(Number(current.dataset.from));
    }
    if (progress) {
      const rect = list.getBoundingClientRect();
      const k = Math.min(1, Math.max(0, (mark - rect.top) / rect.height));
      progress.style.height = `${k * 100}%`;
    }
  };
  sync();
  window.addEventListener('scroll', sync, { passive: true, signal });
  window.addEventListener('resize', sync, { passive: true, signal });
  signal.addEventListener('abort', () => cancelAnimationFrame(frame));
}

onPageLoad((signal) => {
  const hero = document.querySelector<HTMLElement>('[data-history-hero]');
  if (!hero) return;
  const acronym = hero.querySelector<HTMLElement>('[data-acronym]');
  if (acronym) initAcronym(acronym, signal);

  const panorama = document.querySelector<HTMLElement>('[data-panorama]');
  const locate = panorama ? initPanorama(panorama, signal) : undefined;
  document.querySelectorAll<HTMLButtonElement>('[data-locate]').forEach((button) => {
    button.addEventListener(
      'click',
      (event) => {
        event.stopPropagation();
        locate?.(button.dataset.locate!);
      },
      { signal },
    );
  });

  const eras = document.querySelector<HTMLElement>('[data-eras]');
  if (eras) initEras(eras, signal);
});
