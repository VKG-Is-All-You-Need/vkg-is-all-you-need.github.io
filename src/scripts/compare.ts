import { onPageLoad, prefersReducedMotion, watchVisibility } from './lifecycle';

type Mode = 'sql' | 'vkg';

/** 直接查询时，各数据库对应的查询步骤（按执行顺序排在右侧，与数据库顺序不同，连线因此交叉）。 */
const DBS = ['wellbore', 'FIELD', 'company'];

/** 跨库关联时需人工对照的列。 */
const LINKS: [string, string][] = [
  ['col-wellbore-fld_id', 'col-FIELD-FLD_NPDID'],
  ['col-FIELD-CMP_ID', 'col-company-cmp_id'],
];

/** VKG 方式下自动轮流高亮的词汇。 */
const TERMS = ['wellName', 'completionYear', 'inField', 'fieldName', 'operator', 'Equinor'];

const SVG_NS = 'http://www.w3.org/2000/svg';

onPageLoad((signal) => {
  const root = document.querySelector<HTMLElement>('[data-compare]');
  const stage = root?.querySelector<HTMLElement>('[data-stage]');
  const wires = root?.querySelector<SVGSVGElement>('[data-wires]');
  if (!root || !stage || !wires) return;

  const reduced = prefersReducedMotion();
  const anchor = (name: string) => root.querySelector<HTMLElement>(`[data-anchor="${name}"]`);
  const mode = () => root.dataset.mode as Mode;

  // ── 连线 ──
  const box = (element: Element) => {
    const s = stage.getBoundingClientRect();
    const r = element.getBoundingClientRect();
    return {
      left: r.left - s.left,
      right: r.right - s.left,
      top: r.top - s.top,
      cy: r.top - s.top + r.height / 2,
    };
  };

  const curve = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = Math.max(30, (x2 - x1) * 0.5);
    return `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`;
  };

  const add = (d: string, className: string, data: Record<string, string> = {}) => {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', `wire ${className}`);
    Object.entries(data).forEach(([key, value]) => (path.dataset[key] = value));
    wires.append(path);
    return path;
  };

  const draw = () => {
    wires.replaceChildren();
    if (getComputedStyle(wires).display === 'none') return;

    if (mode() === 'sql') {
      for (const key of DBS) {
        const db = anchor(`db-${key}`);
        const query = anchor(`q-${key}`);
        if (!db || !query) continue;
        const a = box(db);
        const b = box(query);
        add(curve(a.right, a.cy, b.left, b.top + 16), 'wire-sql');
      }
      LINKS.forEach(([from, to], i) => {
        const a = anchor(from);
        const b = anchor(to);
        if (!a || !b) return;
        const p = box(a);
        const q = box(b);
        const out = 22 + i * 12;
        add(
          `M${p.left} ${p.cy} C${p.left - out} ${p.cy} ${q.left - out} ${q.cy} ${q.left} ${q.cy}`,
          'wire-link',
        );
      });
    } else {
      const hub = anchor('ontop');
      const sparql = anchor('sparql');
      if (!hub || !sparql) return;
      const h = box(hub);
      for (const key of DBS) {
        const db = anchor(`db-${key}`);
        if (!db) continue;
        const a = box(db);
        const d = curve(a.right, a.cy, h.left, h.cy);
        add(d, 'wire-vkg-base');
        add(d, 'wire-vkg', { db: key });
      }
      const s = box(sparql);
      const d = curve(h.right, h.cy, s.left, s.top + Math.min(60, (s.cy - s.top) * 0.6));
      add(d, 'wire-vkg-base');
      add(d, 'wire-vkg');
      if (activeTerm) showTerm(activeTerm);
    }
  };

  // ── 词汇与列的对应 ──
  let activeTerm: string | null = null;
  const showTerm = (term: string | null) => {
    activeTerm = term;
    root.querySelectorAll('.is-hot').forEach((element) => element.classList.remove('is-hot'));
    wires.querySelectorAll('[data-term-wire]').forEach((path) => path.remove());
    if (!term || mode() !== 'vkg') return;

    root
      .querySelectorAll(`[data-term="${term}"]`)
      .forEach((element) => element.classList.add('is-hot'));
    const hub = anchor('ontop');
    if (!hub || getComputedStyle(wires).display === 'none') return;
    const h = box(hub);
    root.querySelectorAll<HTMLElement>(`li[data-term="${term}"]`).forEach((li) => {
      const c = box(li);
      const db = li.closest('.db');
      const right = db ? box(db).right : c.right;
      add(curve(right, c.cy, h.left, h.cy), 'wire-vkg is-hot', { termWire: term });
    });
  };

  // ── 自动轮流高亮词汇 ──
  let cycle = 0;
  let cycleIndex = 0;
  let visible = false;
  let hovering = false;
  const syncCycle = () => {
    const run = mode() === 'vkg' && visible && !hovering && !document.hidden && !reduced;
    if (run && !cycle) {
      cycle = window.setInterval(() => {
        showTerm(TERMS[cycleIndex % TERMS.length]);
        cycleIndex++;
      }, 1800);
    } else if (!run && cycle) {
      window.clearInterval(cycle);
      cycle = 0;
      if (!hovering) showTerm(null);
    }
  };

  root.querySelectorAll<HTMLElement>('.term').forEach((term) => {
    const enter = () => {
      hovering = true;
      syncCycle();
      showTerm(term.dataset.term!);
    };
    const leave = () => {
      hovering = false;
      showTerm(null);
      syncCycle();
    };
    term.addEventListener('pointerenter', enter, { signal });
    term.addEventListener('pointerleave', leave, { signal });
    term.addEventListener('focus', enter, { signal });
    term.addEventListener('blur', leave, { signal });
  });

  // ── 切换方式 ──
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-mode-button]')];
  const setMode = (next: Mode) => {
    root.dataset.mode = next;
    root.dataset.touched = '';
    buttons.forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset.modeButton === next)),
    );
    root.querySelectorAll<HTMLElement>('[data-pane]').forEach((pane) => {
      pane.setAttribute('aria-hidden', String(pane.dataset.pane !== next));
    });
    showTerm(null);
    draw();
    // 面板切换带有位移动画，结束后按最终位置重画
    window.setTimeout(() => !signal.aborted && draw(), 650);
    syncCycle();
  };
  buttons.forEach((button) =>
    button.addEventListener(
      'click',
      () => {
        if (button.dataset.modeButton !== mode()) setMode(button.dataset.modeButton as Mode);
      },
      { signal },
    ),
  );

  const observer = new ResizeObserver(() => draw());
  observer.observe(stage);
  document.fonts?.ready.then(() => {
    if (!signal.aborted) draw();
  });
  watchVisibility(
    root,
    (isVisible) => {
      visible = isVisible;
      syncCycle();
    },
    signal,
  );
  document.addEventListener('visibilitychange', syncCycle, { signal });

  signal.addEventListener('abort', () => {
    observer.disconnect();
    window.clearInterval(cycle);
  });
});
