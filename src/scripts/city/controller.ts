/**
 * “VKG × 城市数据融合”示例的页面控制：查询分组与切换、数据源开关、聚合与明细、模拟时间轴、
 * 结果列表、对象详情卡片，以及三维场景的按需加载与全屏。
 */
import { city } from '../../lib/geo/city';
import { footfallCount, footfallRate, shopById, shopByBuilding } from '../../lib/city/commerce';
import { companies, companyById, events, people, presence } from '../../lib/city/people';
import {
  cityQueries,
  type CityQuery,
  type CityResult,
  type QueryGroup,
  type ResultRow,
} from '../../lib/city/queries';
import { dayMarkers } from '../../lib/city/calendar';
import { edgeById, nodeById } from '../../lib/city/roads';
import { ENV_SENSORS, placeOf, readingAt, sensorById } from '../../lib/city/sensors';
import { ALL_SOURCES, SOURCES, sourceById, type SourceId } from '../../lib/city/sources';
import {
  DAY,
  DAY_COUNT,
  DAY_END,
  DAY_START,
  dayOf,
  endOfDay,
  formatTime,
  startOfDay,
  timeOfDay,
} from '../../lib/city/time';
import { vehicleAt, vehicleById } from '../../lib/city/traffic';
import { observationAt } from '../../lib/city/weather';
import { prefersReducedMotion } from '../lifecycle';
import type { CityScene, FocusTarget, Insets, Selection, SelectionInfo, View } from './scene';

const PRESETS: Record<string, SourceId[]> = {
  all: ALL_SOURCES,
  gis: ['gis'],
  mobility: ['gis', 'traffic', 'weather'],
  people: ['gis', 'hr', 'community'],
};

/** 播放时结果列表与详情卡片的刷新间隔（毫秒）。 */
const REFRESH_INTERVAL = 350;

const CLOSE_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

// ── 详情卡片：同一对象在各数据源中的记录 ──
interface CardRow {
  source: SourceId;
  text: string;
}

interface Card {
  kind: string;
  title: string;
  iri: string;
  cls: string;
  rows: CardRow[];
}

function buildingCard(id: number, t: number, on: ReadonlySet<SourceId>): Card {
  const building = city.buildings.find((b) => b.id === id)!;
  const shop = shopByBuilding.get(id);
  const company = companies.find((c) => c.buildingId === id);
  const residents = people.filter((p) => p.homeId === id).length;
  const hosted = events.filter((e) => e.venue.kind === 'building' && e.venue.id === id);
  const rows: CardRow[] = [{ source: 'gis', text: `${building.kind} · ${building.floors} 层` }];
  if (shop) {
    rows.push({
      source: 'commerce',
      text: `${shop.name} · ${shop.category} · ${formatTime(shop.open[0])}–${formatTime(shop.open[1])}`,
    });
    rows.push({
      source: 'iot',
      text: `计数器 ${shop.sensor} · 此刻约 ${Math.round(footfallRate(shop, t))} 人/时 · 今日累计 ${footfallCount(shop, startOfDay(dayOf(t)), t)} 人`,
    });
  }
  for (const sensor of ENV_SENSORS.filter((s) => s.buildingId === id)) {
    const reading = readingAt(sensor, t);
    rows.push({
      source: 'iot',
      text: reading
        ? `屋顶温湿度传感器 ${sensor.id} · ${reading.temperature.toFixed(1)}°C · ${reading.humidity}%`
        : `屋顶温湿度传感器 ${sensor.id} · 离线`,
    });
  }
  if (company) {
    rows.push({ source: 'hr', text: `${company.name} · 此刻在岗 ${presence(company.id, t)} 人` });
  }
  if (residents || hosted.length) {
    rows.push({
      source: 'community',
      text: [
        residents ? `登记住户 ${residents} 人` : '',
        ...hosted
          .filter((e) => dayOf(e.start) === dayOf(t))
          .map((e) => `${e.title} ${formatTime(e.start)}–${formatTime(e.end)}`),
      ]
        .filter(Boolean)
        .join(' · '),
    });
  }
  const commerce = shop && on.has('commerce');
  return {
    kind: on.has('gis') ? building.kind : '建筑',
    title: on.has('gis') ? building.name : commerce ? shop.name : `建筑 #${id}`,
    iri: `:building/${id}`,
    cls: commerce ? (shop.category === '咖啡' ? ':Cafe' : ':Shop') : ':Building',
    rows,
  };
}

function vehicleCard(id: string, t: number, detail: boolean): Card {
  const vehicle = vehicleById.get(id)!;
  const state = vehicleAt(vehicle, t);
  const kind = vehicle.kind === 'bus' ? '公交' : vehicle.kind === 'taxi' ? '网约车' : '小汽车';
  const rows: CardRow[] = [
    {
      source: 'traffic',
      text: state
        ? `${state.waiting ? '等待红灯' : `${Math.round(state.speed * 3.6)} km/h`} · 坐标 (${Math.round(state.x)}, ${Math.round(state.y)})`
        : '此刻不在路上',
    },
  ];
  if (state) {
    rows.push({
      source: 'gis',
      text: state.waiting
        ? `停在 ${nodeById.get(state.node)!.name} 路口`
        : `行驶在 ${edgeById.get(state.edge)!.name}`,
    });
  }
  if (vehicle.driver) {
    rows.push({
      source: 'hr',
      text: detail
        ? `司机 ${vehicle.driver} · 畅行出行（虚构）`
        : '司机为畅行出行员工（聚合视图不显示姓名）',
    });
  }
  return {
    kind,
    title: vehicle.plate,
    iri: `:vehicle/${id}`,
    cls: vehicle.kind === 'bus' ? ':Bus' : vehicle.kind === 'taxi' ? ':Taxi' : ':Vehicle',
    rows,
  };
}

function sensorCard(id: string, t: number): Card {
  const sensor = sensorById.get(id)!;
  const reading = readingAt(sensor, t);
  const station = observationAt(t);
  const rows: CardRow[] = [
    {
      source: 'iot',
      text: reading
        ? `${reading.temperature.toFixed(1)}°C · 湿度 ${reading.humidity}% · ${formatTime(reading.ts)} 上报`
        : '离线，没有最新读数',
    },
    { source: 'gis', text: `${placeOf(sensor)} · ${sensor.mount}` },
    {
      source: 'weather',
      text: reading
        ? `气象站 ${station.temperature.toFixed(1)}°C · 湿度 ${station.humidity}% · 温差 ${reading.temperature - station.temperature >= 0 ? '+' : '−'}${Math.abs(reading.temperature - station.temperature).toFixed(1)}°C`
        : `气象站 ${station.temperature.toFixed(1)}°C · 湿度 ${station.humidity}%`,
    },
  ];
  return { kind: '温湿度传感器', title: id, iri: `:sensor/${id}`, cls: ':EnvSensor', rows };
}

/** 结果行对应的镜头目标。 */
function focusFor(query: CityQuery, row: ResultRow): FocusTarget | null {
  const { key } = row;
  const eventFocus = (id: number): FocusTarget | null => {
    const event = events.find((e) => e.id === id);
    if (!event) return null;
    return event.venue.kind === 'park'
      ? { type: 'point', at: city.parks[0].lake.center }
      : { type: 'building', id: event.venue.id };
  };
  switch (query.id) {
    case 'queues':
      return { type: 'node', id: Number(key.slice(1)) };
    case 'trails':
      return { type: 'vehicle', id: key };
    case 'rainFootfall': {
      const shop = shopById.get(Number(key.slice(4)));
      return shop ? { type: 'building', id: shop.buildingId } : null;
    }
    case 'weatherSpeed':
      return { type: 'edge', id: Number(key.slice(1)) };
    case 'sensorAnomaly':
    case 'heatIsland':
      return { type: 'sensor', id: key };
    case 'persona': {
      if (key.startsWith('l')) return { type: 'persona', id: 'P01' };
      if (key.startsWith('e')) return eventFocus(Number(key.slice(1)));
      const company = companyById.get(Number(key.slice(1)));
      return company?.buildingId ? { type: 'building', id: company.buildingId } : null;
    }
    case 'afterwork': {
      const match = /^e(\d+)/.exec(key);
      return match ? eventFocus(Number(match[1])) : null;
    }
  }
}

export function initCity(root: HTMLElement, signal: AbortSignal): void {
  const stage = root.querySelector<HTMLElement>('[data-city-stage]')!;
  const viewport = root.querySelector<HTMLElement>('[data-city-viewport]')!;
  const pinLayer = root.querySelector<HTMLElement>('[data-city-pins]')!;
  const status = root.querySelector<HTMLElement>('[data-city-status]')!;
  const clock = root.querySelector<HTMLElement>('[data-city-clock]')!;
  const weather = root.querySelector<HTMLElement>('[data-city-weather]')!;
  const dayButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-city-day]')];
  const markerBox = root.querySelector<HTMLElement>('[data-city-markers]')!;
  const groupTabs = [...root.querySelectorAll<HTMLButtonElement>('[data-group-tab]')];
  const queryButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-city-query]')];
  const privacy = root.querySelector<HTMLElement>('[data-city-privacy]')!;
  const detailButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-city-detail]')];
  const resultBox = root.querySelector<HTMLElement>('[data-city-result]')!;
  const card = root.querySelector<HTMLElement>('[data-city-card]')!;
  const sourceInputs = [...root.querySelectorAll<HTMLInputElement>('[data-source]')];
  const needBadges = [...root.querySelectorAll<HTMLElement>('[data-source-need]')];
  const presetButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-city-preset]')];
  const sourceCount = root.querySelector<HTMLElement>('[data-city-source-count]')!;
  const playButton = root.querySelector<HTMLButtonElement>('[data-city-play]')!;
  const speedButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-city-speed]')];
  const timeInput = root.querySelector<HTMLInputElement>('[data-city-time]')!;
  const viewButton = root.querySelector<HTMLButtonElement>('[data-city-view]')!;
  const resetButton = root.querySelector<HTMLButtonElement>('[data-city-reset]')!;
  const fullscreenButton = root.querySelector<HTMLButtonElement>('[data-city-fullscreen]')!;
  const panels = [...document.querySelectorAll<HTMLElement>('[data-city-panel]')];
  const queriesPanel = root.querySelector<HTMLElement>('.panel-queries')!;
  const sourcesPanel = root.querySelector<HTMLElement>('.panel-sources')!;
  const timeline = root.querySelector<HTMLElement>('.timeline')!;
  const reduced = prefersReducedMotion();

  let active: CityQuery = cityQueries[0];
  let t = active.suggest;
  let detail = false;
  let sources = new Set<SourceId>(ALL_SOURCES);
  let playing = false;
  let speed = Number(
    speedButtons.find((b) => b.getAttribute('aria-pressed') === 'true')?.dataset.citySpeed ?? 10,
  );
  let view: View = 'city';
  let selection: Selection | null = null;
  let scene: CityScene | null = null;
  let rowTargets: (FocusTarget | null)[] = [];
  let lastResultHtml = '';
  let lastCardHtml = '';
  let lastSelectionKey = '';

  // ── 结果 ──
  const renderResult = (result: CityResult) => {
    rowTargets = result.rows.map((row) => focusFor(active, row));
    const notes = result.notes
      .map(
        (note) =>
          `<li${note.includes('未接入') ? ' class="is-missing"' : ''}>${escapeHtml(note)}</li>`,
      )
      .join('');
    const rows = result.rows
      .map((row, i) => {
        const body = `<span class="result-name">${escapeHtml(row.title)}</span><span class="result-detail">${escapeHtml(row.detail)}</span>`;
        const cls = `result${row.hit ? '' : ' is-miss'}`;
        return rowTargets[i]
          ? `<li><button type="button" class="${cls}" data-focus="${i}">${body}</button></li>`
          : `<li><span class="${cls}">${body}</span></li>`;
      })
      .join('');
    const html = `
      <p class="results-head${result.status === 'unavailable' ? ' is-unavailable' : ''}">结果 <span>${escapeHtml(result.summary)}</span></p>
      ${notes ? `<ul class="notes" role="list">${notes}</ul>` : ''}
      ${rows ? `<ul role="list">${rows}</ul>` : ''}`;
    if (html !== lastResultHtml) {
      lastResultHtml = html;
      resultBox.innerHTML = html;
    }
  };

  // ── 详情卡片 ──
  const renderCard = () => {
    if (!selection) {
      card.hidden = true;
      lastCardHtml = '';
      if (lastSelectionKey) {
        lastSelectionKey = '';
        scene?.select(null);
      }
      return;
    }
    const data =
      selection.type === 'building'
        ? buildingCard(selection.id, t, sources)
        : selection.type === 'vehicle'
          ? vehicleCard(selection.id, t, detail)
          : sensorCard(selection.id, t);
    // 同一数据源可能有多条记录（如商店的客流计数器与屋顶传感器），按数据源计数
    const connected = [...new Set(data.rows.map((row) => row.source))].filter((id) =>
      sources.has(id),
    );
    const foot =
      connected.length >= 2
        ? `${connected.length} 个数据源的记录映射到同一个 IRI，在图谱中是同一个实体。`
        : connected.length === 1
          ? '目前只有一个已接入的数据源描述它。'
          : '没有已接入的数据源描述它。';
    const rows = data.rows
      .map((row) => {
        const source = sourceById.get(row.source)!;
        const on = sources.has(row.source);
        return `<li${on ? '' : ' class="is-off"'} style="--source:${source.color}"><span class="card-source">${escapeHtml(source.name)}</span><span class="card-text">${on ? escapeHtml(row.text) : '未接入'}</span></li>`;
      })
      .join('');
    const html = `
      <div class="card-head">
        <div>
          <p class="card-kind">${escapeHtml(data.kind)}</p>
          <h3 class="card-title">${escapeHtml(data.title)}</h3>
        </div>
        <button type="button" class="card-close" data-card-close aria-label="关闭详情">${CLOSE_ICON}</button>
      </div>
      <p class="card-iri"><code>${escapeHtml(data.iri)}</code><span>${escapeHtml(data.cls)}</span></p>
      <ul class="card-rows" role="list">${rows}</ul>
      <p class="card-foot">${foot}</p>`;
    if (html !== lastCardHtml) {
      lastCardHtml = html;
      card.innerHTML = html;
    }
    card.hidden = false;
    const info: SelectionInfo = {
      selection,
      label: data.title,
      cls: data.cls,
      sources: connected,
    };
    const key = JSON.stringify(info);
    if (key !== lastSelectionKey) {
      lastSelectionKey = key;
      scene?.select(info);
    }
  };

  const refresh = (fresh = false) => {
    const result = active.run({ t, sources, detail });
    renderResult(result);
    scene?.showResult(result, fresh);
    renderCard();
  };

  // ── 时间 ──
  const syncHud = () => {
    clock.textContent = formatTime(t);
    if (sources.has('weather')) {
      const o = observationAt(t);
      const parts = [o.condition, `${Math.round(o.temperature)}°C`, `湿度 ${o.humidity}%`];
      if (o.precipitation > 0) parts.push(`降水 ${o.precipitation} mm`);
      if (o.visibility < 2000) parts.push(`能见度 ${o.visibility} m`);
      if (o.wind >= 6) parts.push(`风 ${Math.round(o.wind)} m/s`);
      weather.textContent = parts.join(' · ');
      weather.classList.remove('is-off');
    } else {
      weather.textContent = '气象未接入';
      weather.classList.add('is-off');
    }
  };

  const percent = (seconds: number) => ((seconds - DAY_START) / (DAY_END - DAY_START)) * 100;
  let shownDay = -1;
  /** 切换日期时更新日期按钮与时间轴标记。 */
  const syncDay = () => {
    const day = dayOf(t);
    if (day === shownDay) return;
    shownDay = day;
    dayButtons.forEach((button) =>
      button.setAttribute('aria-pressed', String(Number(button.dataset.cityDay) === day)),
    );
    markerBox.innerHTML = dayMarkers(day)
      .map(
        (m) =>
          `<span class="marker marker-${m.kind}" style="left:${percent(m.from)}%;width:${percent(m.to) - percent(m.from)}%" title="${escapeHtml(`${m.label} ${formatTime(m.from)}–${formatTime(m.to)}`)}"><i>${escapeHtml(m.label)}</i></span>`,
      )
      .join('');
  };

  const syncTime = () => {
    timeInput.value = String(Math.round(timeOfDay(t)));
    syncDay();
    syncHud();
    scene?.setTime(t, playing, speed);
  };

  let frame = 0;
  let lastFrame = 0;
  let lastRefresh = 0;
  const tick = (now: number) => {
    frame = requestAnimationFrame(tick);
    const dt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 0;
    lastFrame = now;
    t += dt * speed;
    // 每天只演示 06:00–24:00，播放到当天结束时进入下一天
    const day = dayOf(t - dt * speed);
    const finished = t > endOfDay(day) && day === DAY_COUNT - 1;
    if (t > endOfDay(day)) t = finished ? endOfDay(day) : startOfDay(day + 1);
    syncTime();
    if (now - lastRefresh > REFRESH_INTERVAL) {
      lastRefresh = now;
      refresh();
    }
    if (finished) setPlaying(false);
  };

  const setPlaying = (value: boolean) => {
    if (value && t >= endOfDay(DAY_COUNT - 1)) t = startOfDay(0);
    playing = value;
    playButton.setAttribute('aria-pressed', String(playing));
    playButton.setAttribute('aria-label', playing ? '暂停' : '播放');
    cancelAnimationFrame(frame);
    lastFrame = 0;
    if (playing) frame = requestAnimationFrame(tick);
    else refresh();
    syncTime();
  };

  /** 设置当天的时刻（秒）。 */
  const setTimeOfDay = (seconds: number) => {
    t = dayOf(t) * DAY + Math.min(DAY_END - 1, Math.max(DAY_START, seconds));
    syncTime();
    refresh();
  };

  /** 切换到另一天的同一时刻。 */
  const setDay = (day: number) => {
    t = day * DAY + timeOfDay(t);
    syncTime();
    refresh();
  };

  // ── 查询与数据源 ──
  const syncPanels = () => {
    const variant = active.personal && detail && active.detailText ? 'detail' : 'aggregate';
    panels.forEach(
      (panel) =>
        (panel.hidden = panel.dataset.cityPanel !== active.id || panel.dataset.variant !== variant),
    );
  };

  const syncSources = () => {
    sourceInputs.forEach(
      (input) => (input.checked = sources.has(input.dataset.source as SourceId)),
    );
    needBadges.forEach((badge) => {
      const id = badge.dataset.sourceNeed as SourceId;
      badge.hidden = !active.sources.includes(id);
      badge.classList.toggle('is-missing', !sources.has(id));
      badge.textContent = sources.has(id) ? '需要' : '缺少';
    });
    sourceCount.textContent = `${sources.size} / ${SOURCES.length} 已接入`;
    syncHud();
    scene?.setSources(sources);
  };

  const showGroup = (group: QueryGroup) => {
    groupTabs.forEach((tab) =>
      tab.setAttribute('aria-selected', String(tab.dataset.groupTab === group)),
    );
    queryButtons.forEach((button) => (button.hidden = button.dataset.group !== group));
  };

  const showQuery = (query: CityQuery) => {
    active = query;
    showGroup(query.group);
    queryButtons.forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset.cityQuery === query.id)),
    );
    privacy.hidden = !query.personal;
    t = query.suggest;
    syncPanels();
    syncSources();
    syncTime();
    lastResultHtml = '';
    refresh(true);
  };

  const setDetail = (value: boolean) => {
    detail = value;
    detailButtons.forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset.cityDetail === String(value))),
    );
    scene?.setDetail(detail);
    syncPanels();
    refresh();
  };

  const select = (next: Selection | null) => {
    selection = next;
    renderCard();
  };

  // ── 事件 ──
  groupTabs.forEach((tab) =>
    tab.addEventListener(
      'click',
      () => showQuery(cityQueries.find((q) => q.group === tab.dataset.groupTab)!),
      { signal },
    ),
  );
  queryButtons.forEach((button) =>
    button.addEventListener(
      'click',
      () => showQuery(cityQueries.find((q) => q.id === button.dataset.cityQuery)!),
      { signal },
    ),
  );
  detailButtons.forEach((button) =>
    button.addEventListener('click', () => setDetail(button.dataset.cityDetail === 'true'), {
      signal,
    }),
  );
  sourceInputs.forEach((input) =>
    input.addEventListener(
      'change',
      () => {
        const id = input.dataset.source as SourceId;
        if (input.checked) sources.add(id);
        else sources.delete(id);
        syncSources();
        refresh();
      },
      { signal },
    ),
  );
  presetButtons.forEach((button) =>
    button.addEventListener(
      'click',
      () => {
        sources = new Set(PRESETS[button.dataset.cityPreset!]);
        syncSources();
        refresh();
      },
      { signal },
    ),
  );
  resultBox.addEventListener(
    'click',
    (event) => {
      const target = (event.target as Element).closest<HTMLElement>('[data-focus]');
      const focus = target ? rowTargets[Number(target.dataset.focus)] : null;
      if (focus) scene?.focus(focus);
    },
    { signal },
  );
  card.addEventListener(
    'click',
    (event) => {
      if ((event.target as Element).closest('[data-card-close]')) select(null);
    },
    { signal },
  );
  playButton.addEventListener('click', () => setPlaying(!playing), { signal });
  speedButtons.forEach((button) =>
    button.addEventListener(
      'click',
      () => {
        speed = Number(button.dataset.citySpeed);
        speedButtons.forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
        syncTime();
      },
      { signal },
    ),
  );
  timeInput.addEventListener('input', () => setTimeOfDay(Number(timeInput.value)), { signal });
  dayButtons.forEach((button) =>
    button.addEventListener('click', () => setDay(Number(button.dataset.cityDay)), { signal }),
  );
  resetButton.addEventListener('click', () => scene?.resetView(), { signal });

  const syncViewButton = () => {
    root.dataset.view = view;
    viewButton.setAttribute('aria-pressed', String(view === 'layers'));
    viewButton.querySelector('[data-label]')!.textContent = view === 'layers' ? '分层' : '城市';
  };
  viewButton.addEventListener(
    'click',
    () => {
      view = view === 'layers' ? 'city' : 'layers';
      scene?.setView(view);
      syncViewButton();
    },
    { signal },
  );

  // ── 全屏：优先使用 Fullscreen API；不支持时（如 iPhone Safari）以固定定位铺满窗口 ──
  type FullscreenTarget = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
  type FullscreenDocument = Document & {
    webkitFullscreenElement?: Element | null;
    webkitExitFullscreen?: () => Promise<void> | void;
  };
  const doc = document as FullscreenDocument;
  let pseudoFullscreen = false;
  const nativeFullscreen = () => (doc.fullscreenElement ?? doc.webkitFullscreenElement) === stage;

  const syncFullscreen = () => {
    const full = nativeFullscreen() || pseudoFullscreen;
    stage.classList.toggle('is-fullscreen', full);
    stage.classList.toggle('is-pseudo-fullscreen', pseudoFullscreen);
    document.documentElement.classList.toggle('geo-locked', pseudoFullscreen);
    fullscreenButton.setAttribute('aria-pressed', String(full));
    fullscreenButton.setAttribute('aria-label', full ? '退出全屏' : '全屏');
    // 画面比例变化较大：等下一帧完成布局与尺寸回调后再重新取景
    requestAnimationFrame(() => requestAnimationFrame(() => scene?.resetView()));
  };

  const setPseudoFullscreen = (value: boolean) => {
    pseudoFullscreen = value;
    syncFullscreen();
  };

  const toggleFullscreen = async () => {
    if (nativeFullscreen()) {
      await (doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
      return;
    }
    if (pseudoFullscreen) {
      setPseudoFullscreen(false);
      return;
    }
    const target = stage as FullscreenTarget;
    try {
      if (target.requestFullscreen) await target.requestFullscreen({ navigationUI: 'hide' });
      else if (target.webkitRequestFullscreen) await target.webkitRequestFullscreen();
      else setPseudoFullscreen(true);
    } catch {
      setPseudoFullscreen(true);
    }
  };

  const isTyping = (target: EventTarget | null) =>
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ['TEXTAREA', 'SELECT'].includes(target.tagName) ||
      (target.tagName === 'INPUT' &&
        (target as HTMLInputElement).type !== 'range' &&
        (target as HTMLInputElement).type !== 'checkbox'));
  const stageInView = () => {
    const rect = stage.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight;
  };

  fullscreenButton.addEventListener('click', () => void toggleFullscreen(), { signal });
  document.addEventListener('fullscreenchange', syncFullscreen, { signal });
  document.addEventListener('webkitfullscreenchange', syncFullscreen, { signal });
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape') {
        if (pseudoFullscreen) setPseudoFullscreen(false);
        else if (selection && !nativeFullscreen()) select(null);
        return;
      }
      if (
        event.key.toLowerCase() === 'f' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !isTyping(event.target) &&
        !document.querySelector('dialog[open]') &&
        stageInView()
      ) {
        event.preventDefault();
        void toggleFullscreen();
      }
    },
    { signal },
  );

  /** 浮于场景之上的面板所占的边距；窄屏下面板排在场景下方，不占用场景。 */
  const insets = (): Insets => {
    if (getComputedStyle(queriesPanel).position !== 'absolute') {
      return { left: 0, right: 0, top: 0, bottom: 0 };
    }
    const area = viewport.getBoundingClientRect();
    return {
      left: Math.max(0, queriesPanel.getBoundingClientRect().right - area.left),
      right: Math.max(0, area.right - sourcesPanel.getBoundingClientRect().left),
      top: 0,
      bottom: Math.max(0, area.bottom - timeline.getBoundingClientRect().top),
    };
  };
  const resizeObserver = new ResizeObserver(() => scene?.setInsets(insets()));
  resizeObserver.observe(stage);

  // ── 三维场景按需加载 ──
  const loadScene = async () => {
    if (!webglAvailable()) {
      stage.classList.add('is-fallback');
      status.textContent =
        '当前环境不支持 WebGL，三维场景不可用；查询、数据源开关与时间轴仍可使用。';
      return;
    }
    status.textContent = '正在加载三维场景…';
    try {
      const { createCityScene } = await import('./scene');
      if (signal.aborted) return;
      scene = createCityScene(
        viewport,
        pinLayer,
        { onSelect: select },
        { view, reducedMotion: reduced, t, sources, detail },
      );
      stage.classList.add('is-ready');
      status.textContent = '';
      scene.setInsets(insets());
      scene.resetView();
      scene.setTime(t, playing, speed);
      lastSelectionKey = '';
      refresh(true);
      if (!reduced) setPlaying(true);
    } catch (error) {
      console.error(error);
      stage.classList.add('is-fallback');
      status.textContent = '三维场景加载失败；查询、数据源开关与时间轴仍可使用。';
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
    cancelAnimationFrame(frame);
    if (nativeFullscreen()) void (doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
    document.documentElement.classList.remove('geo-locked');
    loader.disconnect();
    resizeObserver.disconnect();
    scene?.dispose();
    scene = null;
  });

  root.setAttribute('data-ready', '');
  syncViewButton();
  showQuery(active);
}
