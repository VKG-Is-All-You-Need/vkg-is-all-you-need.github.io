import { prefersReducedMotion, watchVisibility } from './lifecycle';

// 文献页动效版本：页首标题解码、星图的扫描点亮、传承高亮、提示卡片与筛选联动。

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

export function initConstellation(root: HTMLElement, signal: AbortSignal): Constellation {
  const scroller = root.querySelector<HTMLElement>('[data-sky-scroll]')!;
  const svg = root.querySelector<SVGSVGElement>('[data-sky-svg]')!;
  const sweepLine = svg.querySelector<SVGLineElement>('[data-sweep]')!;
  const trail = svg.querySelector<SVGRectElement>('[data-sweep-trail]')!;
  const dust = svg.querySelector<SVGGElement>('[data-sky-dust]')!;
  const tip = root.querySelector<HTMLElement>('[data-sky-tip]')!;
  const replay = root.querySelector<HTMLButtonElement>('[data-sky-replay]')!;
  const counters = [...root.querySelectorAll<HTMLElement>('[data-count]')];
  const info = JSON.parse(root.querySelector('[data-sky-data]')?.textContent ?? '{}') as Record<
    string,
    StarInfo
  >;
  const stars = new Map(
    [...svg.querySelectorAll<SVGGElement>('[data-star]')].map((el) => [el.dataset.star!, el]),
  );
  const links = [...svg.querySelectorAll<SVGGElement>('[data-from]')];
  const bars = [...svg.querySelectorAll<SVGGElement>('.bar')];
  const width = svg.viewBox.baseVal.width;
  const height = svg.viewBox.baseVal.height;
  const reduced = prefersReducedMotion();
  const en = document.documentElement.lang === 'en';

  // ── 扫描：竖线从左扫到右，经过的星点依次点亮 ──
  let frame = 0;
  let userMoved = false;
  const setSweep = (x: number) => {
    sweepLine.setAttribute('x1', String(x));
    sweepLine.setAttribute('x2', String(x));
    trail.setAttribute('x', String(Math.max(0, x - 140)));
    trail.setAttribute('width', String(Math.min(140, x)));
  };
  const light = (x: number, pop: boolean) => {
    for (const [, el] of stars) {
      if (!el.classList.contains('is-on') && Number(el.dataset.x) <= x) {
        el.classList.add('is-on');
        if (pop) el.classList.add('is-pop');
      }
    }
    for (const bar of bars) {
      if (Number(bar.dataset.x) <= x) bar.classList.add('is-on');
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
    svg.classList.remove('is-sweeping');
    svg.classList.add('is-done');
  };
  const play = () => {
    cancelAnimationFrame(frame);
    for (const [, el] of stars) el.classList.remove('is-on', 'is-pop');
    for (const el of [...links, ...bars]) el.classList.remove('is-on');
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
      const x = eased * width;
      setSweep(x);
      light(x, true);
      if (!userMoved) scroller.scrollLeft = Math.max(0, x - scroller.clientWidth * 0.62);
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
    const dot = el.querySelector('circle')!;
    const x = Number(dot.getAttribute('cx'));
    const y = Number(dot.getAttribute('cy'));
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
    const maxLeft = Math.min(width, scroller.scrollLeft + scroller.clientWidth) - tipWidth - 8;
    const left = Math.min(Math.max(minLeft, x - 24), maxLeft);
    const below = y + 18 + tipHeight < height;
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
