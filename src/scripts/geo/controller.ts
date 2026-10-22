/**
 * “VKG × 地理信息”示例的页面控制：查询切换、结果列表、建筑详情、平面图与三维场景的按需加载。
 */
import { city, CITY, FACILITY_CLASS, FLOOR_HEIGHT, type Building } from '../../lib/geo/city';
import { queries, type GeoQuery, type QueryResult } from '../../lib/geo/queries';
import { rectToWkt, type Point } from '../../lib/geo/spatial';
import { highlight } from '../../lib/highlight';
import { prefersReducedMotion } from '../lifecycle';
import type { GeoScene, Mode, PlanView } from './scene';

const byId = new Map(city.buildings.map((building) => [building.id, building]));
const results = new Map<GeoQuery['id'], QueryResult>(
  queries.map((query) => [query.id, query.run(city)]),
);

const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function triples(building: Building): string {
  const s = `:building/${building.id}`;
  const lines = [
    `${s} a :Building ;`,
    `    :name "${building.name}" ;`,
    `    :kind "${building.kind}" ;`,
    `    geo:hasGeometry ${s}/geom .`,
    `${s}/geom`,
    `    geo:asWKT "${rectToWkt(building.footprint)}"^^geo:wktLiteral .`,
  ];
  const facility = FACILITY_CLASS[building.kind];
  if (facility) lines.push(`${s} a ${facility} .`, `# 经本体推出：${s} a :PublicFacility`);
  return lines.join('\n');
}

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

export function initGeo(root: HTMLElement, signal: AbortSignal): void {
  const stage = root.querySelector<HTMLElement>('[data-geo-stage]')!;
  const viewport = root.querySelector<HTMLElement>('[data-geo-viewport]')!;
  const pinLayer = root.querySelector<HTMLElement>('[data-geo-pins]')!;
  const status = root.querySelector<HTMLElement>('[data-geo-status]')!;
  const queryButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-query]')];
  const resultsBox = root.querySelector<HTMLElement>('[data-geo-results]')!;
  const info = root.querySelector<HTMLElement>('[data-geo-info]')!;
  const infoDefault = info.innerHTML;
  const plan = root.querySelector<HTMLCanvasElement>('[data-geo-plan]')!;
  const modeButton = root.querySelector<HTMLButtonElement>('[data-geo-mode]')!;
  const rotateButton = root.querySelector<HTMLButtonElement>('[data-geo-rotate]')!;
  const resetButton = root.querySelector<HTMLButtonElement>('[data-geo-reset]')!;
  const panels = [...document.querySelectorAll<HTMLElement>('[data-query-panel]')];
  const reduced = prefersReducedMotion();

  let active: GeoQuery['id'] = 'cafes';
  let selected: number | null = null;
  let view: PlanView | null = null;
  let scene: GeoScene | null = null;
  let userMode: Mode | null = null;
  const themeMode = (): Mode =>
    document.documentElement.dataset.theme === 'light' ? 'day' : 'night';
  const mode = () => userMode ?? themeMode();

  // ── 平面图 ──
  const drawPlan = () => {
    const ctx = plan.getContext('2d');
    if (!ctx) return;
    const ratio = window.devicePixelRatio || 1;
    const width = plan.clientWidth;
    const height = plan.clientHeight;
    if (!width || !height) return;
    plan.width = Math.round(width * ratio);
    plan.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const css = getComputedStyle(root);
    const color = (name: string) => css.getPropertyValue(name).trim();
    const pad = 10;
    const scale = Math.min((width - pad * 2) / CITY.width, (height - pad * 2) / CITY.height);
    const ox = (width - CITY.width * scale) / 2;
    const oy = (height - CITY.height * scale) / 2;
    const toPlan = ({ x, y }: Point) => ({ x: ox + x * scale, y: oy + (CITY.height - y) * scale });
    const result = results.get(active)!;
    const hits = new Set(result.hits.map((hit) => hit.id));

    ctx.fillStyle = color('--surface-2');
    for (const block of city.blocks) {
      const p = toPlan({ x: block.x, y: block.y + block.h });
      ctx.fillRect(p.x, p.y, block.w * scale, block.h * scale);
    }

    const park = city.parks[0];
    ctx.beginPath();
    park.area.forEach((point, i) => {
      const p = toPlan(point);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(110, 160, 100, 0.35)';
    ctx.fill();
    const lake = toPlan(park.lake.center);
    ctx.beginPath();
    ctx.ellipse(lake.x, lake.y, park.lake.rx * scale, park.lake.ry * scale, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(80, 150, 180, 0.5)';
    ctx.fill();

    for (const building of city.buildings) {
      const { x, y, w, h } = building.footprint;
      const p = toPlan({ x, y: y + h });
      const isHit = hits.has(building.id);
      ctx.fillStyle =
        isHit || building.id === selected ? color('--accent') : color('--line-strong');
      ctx.globalAlpha = isHit || building.id === selected ? 1 : 0.9;
      ctx.fillRect(p.x, p.y, w * scale, h * scale);
      if (building.id === selected) {
        ctx.strokeStyle = color('--ink');
        ctx.lineWidth = 1.5;
        ctx.strokeRect(p.x - 1.5, p.y - 1.5, w * scale + 3, h * scale + 3);
      }
    }
    ctx.globalAlpha = 1;

    ctx.strokeStyle = color('--accent');
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    if (result.focus.type === 'buffer') {
      for (const center of result.focus.centers) {
        const p = toPlan(center);
        ctx.beginPath();
        ctx.arc(p.x, p.y, result.focus.radius * scale, 0, Math.PI * 2);
        ctx.stroke();
      }
    } else {
      ctx.beginPath();
      result.focus.polygon.forEach((point, i) => {
        const p = toPlan(point);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.stroke();
    }
    ctx.setLineDash([]);

    ctx.fillStyle = color('--code-var');
    for (const station of city.stations) {
      const p = toPlan(station.location);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    if (view) {
      const p = toPlan({
        x: Math.min(CITY.width + 40, Math.max(-40, view.x)),
        y: Math.min(CITY.height + 40, Math.max(-40, view.y)),
      });
      ctx.save();
      ctx.translate(Math.min(width - 6, Math.max(6, p.x)), Math.min(height - 6, Math.max(6, p.y)));
      ctx.rotate(view.angle);
      ctx.fillStyle = color('--ink');
      ctx.beginPath();
      ctx.moveTo(0, -7);
      ctx.lineTo(5, 5);
      ctx.lineTo(0, 2);
      ctx.lineTo(-5, 5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    plan.dataset.scale = String(scale);
    plan.dataset.ox = String(ox);
    plan.dataset.oy = String(oy);
  };

  // ── 结果与详情 ──
  const renderResults = () => {
    const query = queries.find((q) => q.id === active)!;
    const result = results.get(active)!;
    const item = (hit: { id: number; detail: string }, miss = false) =>
      `<li><button type="button" class="result${miss ? ' is-miss' : ''}${hit.id === selected ? ' is-selected' : ''}" data-select="${hit.id}"><span class="result-name">${escapeHtml(byId.get(hit.id)!.name)}</span><span class="result-detail">${escapeHtml(hit.detail)}</span></button></li>`;
    resultsBox.innerHTML = `
      <p class="results-head">结果 <span>${result.hits.length} 项</span><code>${escapeHtml(query.feature)}</code></p>
      <ul role="list">${result.hits.map((hit) => item(hit)).join('')}</ul>
      ${result.misses.length ? `<p class="results-sub">未满足条件</p><ul role="list">${result.misses.map((hit) => item(hit, true)).join('')}</ul>` : ''}`;
  };

  const renderInfo = () => {
    if (selected === null) {
      info.innerHTML = infoDefault;
      return;
    }
    const building = byId.get(selected)!;
    const facility = FACILITY_CLASS[building.kind];
    const result = results.get(active)!;
    const relation = [...result.hits, ...result.misses].find((hit) => hit.id === building.id);
    info.innerHTML = `
      <p class="info-kind">${escapeHtml(building.kind)}${facility ? ` · ${facility} ⊑ :PublicFacility` : ''}</p>
      <h3 class="info-title">${escapeHtml(building.name)}</h3>
      <p class="info-meta">${building.floors} 层 · 约 ${Math.round(building.floors * FLOOR_HEIGHT)} 米${relation ? ` · ${escapeHtml(relation.detail)}` : ''}</p>
      <p class="info-label">buildings 表中的记录</p>
      <dl class="info-row">
        <div><dt>id</dt><dd>${building.id}</dd></div>
        <div><dt>name</dt><dd>${escapeHtml(building.name)}</dd></div>
        <div><dt>kind</dt><dd>${escapeHtml(building.kind)}</dd></div>
        <div><dt>floors</dt><dd>${building.floors}</dd></div>
        <div><dt>footprint</dt><dd>${rectToWkt(building.footprint)}</dd></div>
      </dl>
      <p class="info-label">映射生成的虚拟三元组</p>
      <pre class="code"><code>${highlight(triples(building))}</code></pre>
      <button type="button" class="info-close" data-select="">返回说明</button>`;
  };

  const select = (id: number | null) => {
    selected = id;
    renderResults();
    renderInfo();
    drawPlan();
    scene?.select(id);
  };

  const showQuery = (id: GeoQuery['id']) => {
    active = id;
    selected = null;
    queryButtons.forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset.query === id)),
    );
    panels.forEach((panel) => (panel.hidden = panel.dataset.queryPanel !== id));
    const result = results.get(id)!;
    scene?.showQuery({
      hits: result.hits.map((hit) => ({
        id: hit.id,
        label: `<b>${escapeHtml(byId.get(hit.id)!.name)}</b><span>${escapeHtml(hit.detail)}</span>`,
      })),
      focus: result.focus,
    });
    scene?.select(null);
    renderResults();
    renderInfo();
    drawPlan();
  };

  const syncModeButton = () => {
    const current = mode();
    modeButton.setAttribute('aria-pressed', String(current === 'night'));
    modeButton.querySelector('[data-label]')!.textContent = current === 'night' ? '夜晚' : '白天';
  };

  // ── 事件 ──
  queryButtons.forEach((button) =>
    button.addEventListener('click', () => showQuery(button.dataset.query as GeoQuery['id']), {
      signal,
    }),
  );
  root.addEventListener(
    'click',
    (event) => {
      const target = (event.target as Element).closest<HTMLElement>('[data-select]');
      if (!target) return;
      select(target.dataset.select ? Number(target.dataset.select) : null);
    },
    { signal },
  );
  plan.addEventListener(
    'click',
    (event) => {
      const rect = plan.getBoundingClientRect();
      const scale = Number(plan.dataset.scale);
      const x = (event.clientX - rect.left - Number(plan.dataset.ox)) / scale;
      const y = CITY.height - (event.clientY - rect.top - Number(plan.dataset.oy)) / scale;
      const tolerance = 6;
      const hit = city.buildings.find(
        ({ footprint: f }) =>
          x > f.x - tolerance &&
          x < f.x + f.w + tolerance &&
          y > f.y - tolerance &&
          y < f.y + f.h + tolerance,
      );
      select(hit?.id ?? null);
    },
    { signal },
  );
  modeButton.addEventListener(
    'click',
    () => {
      userMode = mode() === 'night' ? 'day' : 'night';
      scene?.setMode(userMode);
      syncModeButton();
    },
    { signal },
  );
  rotateButton.addEventListener(
    'click',
    () => {
      const enabled = rotateButton.getAttribute('aria-pressed') !== 'true';
      rotateButton.setAttribute('aria-pressed', String(enabled));
      scene?.setAutoRotate(enabled);
    },
    { signal },
  );
  resetButton.addEventListener('click', () => scene?.resetView(), { signal });

  const themeObserver = new MutationObserver(() => {
    if (!userMode) scene?.setMode(themeMode());
    syncModeButton();
    drawPlan();
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  const resizeObserver = new ResizeObserver(drawPlan);
  resizeObserver.observe(plan);

  // ── 三维场景按需加载 ──
  const loadScene = async () => {
    if (!webglAvailable()) {
      stage.classList.add('is-fallback');
      status.textContent = '当前环境不支持 WebGL，已切换为平面图。';
      drawPlan();
      return;
    }
    status.textContent = '正在加载三维场景…';
    try {
      const { createGeoScene } = await import('./scene');
      if (signal.aborted) return;
      scene = createGeoScene(
        viewport,
        pinLayer,
        city,
        {
          onSelect: select,
          onView: (next) => {
            view = next;
            drawPlan();
          },
        },
        { mode: mode(), reducedMotion: reduced },
      );
      stage.classList.add('is-ready');
      status.textContent = '';
      rotateButton.setAttribute('aria-pressed', String(!reduced));
      showQuery(active);
    } catch (error) {
      console.error(error);
      stage.classList.add('is-fallback');
      status.textContent = '三维场景加载失败，已切换为平面图。';
      drawPlan();
    }
  };

  const loader = new IntersectionObserver(
    ([entry]) => {
      if (!entry.isIntersecting) return;
      loader.disconnect();
      void loadScene();
    },
    { rootMargin: '200px' },
  );
  loader.observe(stage);

  signal.addEventListener('abort', () => {
    loader.disconnect();
    themeObserver.disconnect();
    resizeObserver.disconnect();
    scene?.dispose();
    scene = null;
  });

  root.setAttribute('data-ready', '');
  syncModeButton();
  showQuery(active);
}
