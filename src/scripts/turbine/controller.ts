/**
 * “VKG × 设备诊断”示例的页面控制：查询分组与切换、选中查询后的自动播放、数据源开关、机组选择、
 * 模拟时间轴、结果列表、规则展开、信号曲线，以及三维场景的按需加载与全屏。
 */
import { tr } from '../../i18n/runtime';
import {
  PLANTS,
  TURBINES,
  sensorByTag,
  sensorsOf,
  turbineById,
  type TurbineId,
} from '../../lib/turbine/fleet';
import {
  stateLabel,
  stateOf,
  turbineQueries,
  type QueryGroup,
  type TurbineContext,
  type TurbineQuery,
  type TurbineResult,
} from '../../lib/turbine/queries';
import { weatherAt } from '../../lib/turbine/records';
import { latest } from '../../lib/turbine/rules';
import { observed, originOf, tagsOf } from '../../lib/turbine/signals';
import { ALL_SOURCES, SOURCES, sourceById, type SourceId } from '../../lib/turbine/sources';
import { SPAN, formatTime, lastBatch, m } from '../../lib/turbine/time';
import { prefersReducedMotion } from '../lifecycle';
import { SignalChart, seriesColor, type OriginSpan } from './chart';
import { sensorDetail, unitDetail } from './detail';
import type { TourFocus, TurbineScene, UnitCard, UnitVisual } from './scene';

const PRESETS: Record<string, SourceId[]> = {
  all: ALL_SOURCES,
  live: ALL_SOURCES.filter((id) => id !== 'hist_a' && id !== 'hist_b'),
  archive: ALL_SOURCES.filter((id) => id !== 'live'),
  nomaster: ALL_SOURCES.filter((id) => id !== 'master'),
};

/** 播放时结果与卡片的刷新间隔（毫秒）。 */
const REFRESH_INTERVAL = 250;
/** “跟随此刻”时信号曲线显示的时长（秒）。 */
const FOLLOW_SPAN = 600;

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

export function initTurbine(root: HTMLElement, signal: AbortSignal): void {
  const $ = <T extends Element>(selector: string) => root.querySelector<T>(selector)!;
  const $$ = <T extends Element>(selector: string) => [...root.querySelectorAll<T>(selector)];

  const queries = turbineQueries();
  const reduced = prefersReducedMotion();
  const stage = $<HTMLElement>('[data-turbine-stage]');
  const viewport = $<HTMLElement>('[data-turbine-viewport]');
  const pinLayer = $<HTMLElement>('[data-turbine-pins]');
  const status = $<HTMLElement>('[data-turbine-status]');
  const resultBox = $<HTMLElement>('[data-turbine-result]');
  const timeInput = $<HTMLInputElement>('[data-turbine-time]');
  const clock = $<HTMLElement>('[data-turbine-clock]');
  const playButton = $<HTMLButtonElement>('[data-turbine-play]');
  const legend = $<HTMLElement>('[data-turbine-legend]');
  const chartTitle = $<HTMLElement>('[data-turbine-chart-title]');
  const signalsPanel = $<HTMLElement>('[data-turbine-signals]');
  const story = $<HTMLElement>('.story');
  const queriesPanel = $<HTMLElement>('.panel-queries');
  const sourcesPanel = $<HTMLElement>('.panel-sources');
  const timeline = $<HTMLElement>('.timeline');
  const sourceCount = $<HTMLElement>('[data-turbine-source-count]');
  const chart = new SignalChart(
    $<HTMLCanvasElement>('[data-turbine-canvas]'),
    $<HTMLElement>('[data-turbine-tip]'),
    signal,
  );

  let query: TurbineQuery = queries[0];
  let now = query.suggest;
  let sources = new Set<SourceId>(ALL_SOURCES);
  let selected: TurbineId | null = null;
  /** 用户未手动选择机组时，信号曲线跟随查询结果中的机组。 */
  let autoSelect = true;
  let range: 'follow' | 'fit' | 'full' = 'follow';
  let result: TurbineResult;
  let speed = 60;
  let playing = false;
  /** 自动播放的终点；为 null 时播放到结尾。 */
  let storyEnd: number | null = null;
  let scene: TurbineScene | null = null;
  /** 右侧面板中展示的详情。 */
  let detail: { type: 'unit'; id: TurbineId } | { type: 'sensor'; tag: string } | null = null;
  const detailBox = $<HTMLElement>('[data-turbine-detail]');
  const detailEmpty = detailBox.innerHTML;
  let lastDetailHtml = '';
  let freshQuery = true;

  const ctx = (): TurbineContext => ({ now, sources });

  // ── 结果列表 ──
  function renderResult() {
    const head = result.status === 'unavailable' ? ' is-unavailable' : '';
    const notes = [
      ...result.missing.map(
        (id) =>
          `<li class="is-missing">${escapeHtml(
            tr(`未接入：${sourceById.get(id)!.name}`, `Not connected: ${sourceById.get(id)!.name}`),
          )}</li>`,
      ),
      ...result.notes.map((n) => `<li>${escapeHtml(n)}</li>`),
    ].join('');
    const rows = result.rows
      .map((row) => {
        const cls = [
          'result',
          row.hit ? 'is-hit' : 'is-miss',
          row.turbine === selected && 'is-selected',
        ]
          .filter(Boolean)
          .join(' ');
        const inner = `<span class="result-name">${escapeHtml(row.title)}</span><span class="result-detail">${escapeHtml(row.detail)}</span>`;
        return row.turbine
          ? `<li><button type="button" class="${cls}" data-row-turbine="${row.turbine}"${row.at !== undefined ? ` data-row-at="${row.at}"` : ''}>${inner}</button></li>`
          : `<li><span class="${cls}">${inner}</span></li>`;
      })
      .join('');
    let expansion = '';
    if (result.expansion && result.status !== 'unavailable') {
      const tags = result.expansion.turbines.reduce((n, t) => n + t.tags.length, 0);
      const list = result.expansion.turbines
        .map((t) => `<dt>${t.turbine}</dt><dd>${t.tags.join(' ')}</dd>`)
        .join('');
      expansion = `<details class="expansion"><summary>${tr(
        `1 条语义规则 → 相当于 <b>${result.expansion.rules}</b> 条按机组手写的规则，涉及 <b>${tags}</b> 个传感器编号`,
        `1 semantic rule → the equivalent of <b>${result.expansion.rules}</b> hand-written per-turbine rules over <b>${tags}</b> sensor tags`,
      )}</summary><dl>${list}</dl></details>`;
    }
    resultBox.innerHTML = `<p class="results-head${head}">${escapeHtml(tr('结果', 'Results'))} <span>${escapeHtml(result.summary)}</span></p>${notes ? `<ul class="notes" role="list">${notes}</ul>` : ''}<ul role="list">${rows}</ul>${expansion}`;
  }

  function renderNeeds() {
    for (const el of $$<HTMLElement>('[data-source-need]')) {
      const id = el.dataset.sourceNeed as SourceId;
      const need = query.sources.includes(id);
      el.hidden = !need;
      el.classList.toggle('is-missing', need && !sources.has(id));
    }
    sourceCount.textContent = tr(
      `${sources.size} / ${SOURCES.length} 已接入`,
      `${sources.size} / ${SOURCES.length} connected`,
    );
  }

  function renderStory() {
    const index = queries.indexOf(query) + 1;
    $<HTMLElement>('[data-story-index]').textContent = String(index).padStart(2, '0');
    $<HTMLElement>('[data-story-title]').textContent = query.title;
    $<HTMLElement>('[data-story-hard]').textContent = query.explain.hard;
    $<HTMLElement>('[data-story-vkg]').textContent = query.explain.vkg;
  }

  // ── 信号曲线 ──
  function origins(turbine: TurbineId): OriginSpan[] {
    const plant = turbineById.get(turbine)!.plant;
    const spans: OriginSpan[] = [];
    let start = 0;
    let current = originOf(plant, 0, now, sources);
    const color = (id: string | null) => (id ? sourceById.get(id as SourceId)!.color : null);
    for (let t = 1; t <= SPAN; t++) {
      const o = originOf(plant, t, now, sources);
      if (o !== current) {
        spans.push({ from: start, to: t, color: color(current) });
        start = t;
        current = o;
      }
    }
    spans.push({ from: start, to: SPAN, color: color(current) });
    return spans.filter((s) => s.color || s.to <= now + 1);
  }

  function renderSignals() {
    const turbine = selected!;
    const spec = query.chart(turbine, ctx(), result);
    const plant = PLANTS[turbineById.get(turbine)!.plant];
    chartTitle.textContent = tr(
      `${turbine} 的信号 · ${plant.name}`,
      `${turbine} signals · ${plant.name}`,
    );
    const seen = new Map<string, { color: string; dashed: boolean }>();
    for (const track of spec.tracks) {
      for (const s of track.series) {
        const key = s.tone === 'muted' && track.series.length > 2 ? track.label : s.label;
        if (!seen.has(key)) {
          seen.set(key, { color: seriesColor(s, chart.palette), dashed: s.tone === 'plan' });
        }
      }
    }
    legend.innerHTML = [...seen]
      .slice(0, 5)
      .map(
        ([label, { color, dashed }]) =>
          `<li><i style="--swatch:${color}"${dashed ? ' class="is-dashed"' : ''}></i>${escapeHtml(label)}</li>`,
      )
      .join('');
    const window: [number, number] =
      range === 'full'
        ? [0, SPAN]
        : range === 'fit'
          ? spec.window
          : [Math.max(0, now - FOLLOW_SPAN), Math.max(FOLLOW_SPAN, now) + 30];
    chart.update({
      spec,
      window,
      now,
      batch: sources.has('hist_a') || sources.has('hist_b') ? lastBatch(now) : null,
      origins: origins(turbine),
      labels: { now: tr(`此刻 ${formatTime(now)}`, `Now ${formatTime(now)}`), batch: '' },
    });
  }

  // ── 三维场景 ──
  function renderScene() {
    if (!scene) return;
    const c = ctx();
    const visuals = {} as Record<TurbineId, UnitVisual>;
    const cards = {} as Record<TurbineId, UnitCard>;
    for (const turbine of TURBINES) {
      const id = turbine.id;
      const speedNow = latest(observed(tagsOf(id, 'speed')[0], now, sources), now);
      const t = speedNow?.t ?? now;
      const flame = observed(tagsOf(id, 'flame')[0], now, sources)[t] > 0.5;
      const power = observed(tagsOf(id, 'power')[0], now, sources)[t];
      visuals[id] = {
        speed: speedNow?.value ?? NaN,
        flame,
        power: Number.isNaN(power) ? 0 : power,
        tips: tagsOf(id, 'tip').map((tag) => observed(tag, now, sources)[t]),
        readings: Object.fromEntries(
          sensorsOf(id).map((sensor) => [sensor.tag, observed(sensor.tag, now, sources)[t]]),
        ),
      };
      const s = stateOf(id, c);
      const row = result.rows.find((r) => r.turbine === id && r.hit);
      const alert = row
        ? `${row.title.startsWith(id) ? row.title.slice(id.length).trim() : row.title}${row.detail ? ` · ${row.detail}` : ''}`
        : undefined;
      cards[id] = {
        state: stateLabel(s.state),
        value:
          s.state === 'unknown'
            ? ''
            : s.state === 'loaded'
              ? `${s.power.toFixed(0)} MW`
              : `${Math.round(s.speed)} rpm`,
        alert,
        involved: false,
        hit: result.hits.includes(id),
      };
    }
    scene.setUnits(visuals, cards);
    scene.setSources(sources);
    const focusTurbines = [...new Set([...result.hits, ...(selected ? [selected] : [])])];
    const specs = focusTurbines.map((id) => query.chart(id, c, result));
    const hitTags = specs.flatMap((spec) => spec.hitSensors);
    const hot = hitTags.filter((tag) => sensorByTag.get(tag)?.kind === 'tip');
    // 正在查看的传感器始终亮起
    scene.setSensorFocus(
      [
        ...specs.flatMap((spec) => spec.sensors),
        ...(detail?.type === 'sensor' ? [detail.tag] : []),
      ],
      hitTags,
    );
    scene.showQuery(
      query.sources.filter((id) => sources.has(id)),
      result.hits,
      hot,
      freshQuery,
    );
    freshQuery = false;
    scene.setPlantInfo({
      A: sources.has('weather') ? `${weatherAt('A', now).temp.toFixed(1)} °C` : '',
      B: sources.has('weather') ? `${weatherAt('B', now).temp.toFixed(1)} °C` : '',
    });
    scene.select(selected);
    scene.setTime(now, playing);
  }

  function refresh() {
    result = query.run(ctx());
    if (!selected || (autoSelect && result.focus)) selected = result.focus ?? selected ?? 'A1';
    clock.textContent = formatTime(now);
    timeInput.value = String(now);
    renderResult();
    renderNeeds();
    renderSignals();
    renderScene();
    renderDetail();
    for (const b of $$<HTMLButtonElement>('[data-turbine-range]')) {
      b.setAttribute('aria-pressed', String(b.dataset.turbineRange === range));
    }
  }

  function showSideTab(tab: 'sources' | 'detail') {
    for (const b of $$<HTMLButtonElement>('[data-side-tab]')) {
      b.setAttribute('aria-selected', String(b.dataset.sideTab === tab));
    }
    for (const panel of $$<HTMLElement>('[data-side-panel]')) {
      panel.hidden = panel.dataset.sidePanel !== tab;
    }
  }

  function renderDetail() {
    const html = !detail
      ? detailEmpty
      : detail.type === 'unit'
        ? unitDetail(detail.id, ctx())
        : sensorDetail(detail.tag, ctx());
    if (html !== lastDetailHtml) {
      lastDetailHtml = html;
      detailBox.innerHTML = html;
    }
  }

  function openUnit(id: TurbineId) {
    detail = { type: 'unit', id };
    selected = id;
    autoSelect = false;
    showSideTab('detail');
    sourcesPanel.scrollTop = 0;
    scene?.focusUnit(id);
    refresh();
  }

  function openSensor(tag: string) {
    const turbine = sensorByTag.get(tag)!.turbine;
    detail = { type: 'sensor', tag };
    selected = turbine;
    autoSelect = false;
    showSideTab('detail');
    sourcesPanel.scrollTop = 0;
    scene?.focusSensor(tag);
    refresh();
  }

  function closeDetail() {
    if (detail?.type === 'sensor') scene?.focusSensor(null);
    detail = null;
    scene?.resetView();
    refresh();
  }

  function setSpeed(next: number) {
    speed = next;
    for (const b of $$<HTMLButtonElement>('[data-turbine-speed]')) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.turbineSpeed) === next));
    }
  }

  /** 从查询的起点自动播放到结果出现的时刻。 */
  function playStory() {
    stop();
    selected = null;
    autoSelect = true;
    if (reduced) {
      now = query.suggest;
      refresh();
      return;
    }
    now = query.story.from;
    storyEnd = query.suggest;
    setSpeed(query.story.speed);
    refresh();
    play();
  }

  /** 切换查询（不自动播放）。 */
  function setQuery(next: TurbineQuery) {
    query = next;
    for (const b of $$<HTMLButtonElement>('[data-turbine-query]')) {
      b.setAttribute('aria-pressed', String(b.dataset.turbineQuery === next.id));
    }
    for (const panel of document.querySelectorAll<HTMLElement>('[data-turbine-panel]')) {
      panel.hidden = panel.dataset.turbinePanel !== next.id;
    }
    for (const tab of $$<HTMLButtonElement>('[data-group-tab]')) {
      tab.setAttribute('aria-selected', String(tab.dataset.groupTab === next.group));
    }
    for (const b of $$<HTMLButtonElement>('[data-turbine-query]')) {
      b.hidden = b.dataset.group !== next.group;
    }
    freshQuery = true;
    range = 'follow';
    renderStory();
  }

  function selectQuery(next: TurbineQuery) {
    if (touring >= 0) endTour();
    setQuery(next);
    playStory();
  }

  function selectGroup(group: QueryGroup) {
    for (const tab of $$<HTMLButtonElement>('[data-group-tab]')) {
      tab.setAttribute('aria-selected', String(tab.dataset.groupTab === group));
    }
    for (const b of $$<HTMLButtonElement>('[data-turbine-query]')) {
      b.hidden = b.dataset.group !== group;
    }
    if (query.group !== group) selectQuery(queries.find((q) => q.group === group)!);
  }

  function selectTurbine(id: TurbineId) {
    openUnit(id);
  }

  function setSources(next: Set<SourceId>) {
    sources = next;
    for (const input of $$<HTMLInputElement>('[data-source]')) {
      input.checked = sources.has(input.dataset.source as SourceId);
    }
  }

  /** 从 from 起按 speed 倍速播放到 end。 */
  function playFrom(from: number, rate: number, end: number) {
    stop();
    now = from;
    storyEnd = end;
    setSpeed(rate);
    refresh();
    if (!reduced) play();
    else {
      now = end;
      refresh();
    }
  }

  // ── 导览 ──
  interface TourStep extends TourFocus {
    title: string;
    text: string;
    /** 自动进入下一步前停留的秒数。 */
    duration: number;
    enter(): void;
  }
  const byId = (id: TurbineQuery['id']) => queries.find((q) => q.id === id)!;
  const TOUR: TourStep[] = [
    {
      focus: 'overview',
      title: tr('两座电厂，八台燃气轮机', 'Two plants, eight gas turbines'),
      text: tr(
        '这是一家虚构的发电公司：北港电厂和西岭电厂各有四台燃气轮机。每台机组头顶的卡片显示它此刻的状态，烟囱冒烟表示正在燃烧发电。',
        'A fictional power company: the North Harbor and Westridge plants each run four gas turbines. The card above each turbine shows its current state, and smoke from a stack means it is burning fuel and generating power.',
      ),
      duration: 8,
      enter() {
        setSources(new Set(ALL_SOURCES));
        setQuery(byId('state'));
        selected = null;
        autoSelect = true;
        playFrom(m(11), 30, m(16));
      },
    },
    {
      focus: 'turbine',
      turbine: 'A3',
      marker: tr('发电机', 'Generator'),
      title: tr('一台燃气轮机', 'One gas turbine'),
      text: tr(
        '压气机把空气压缩后送进燃烧室，与燃料一起燃烧；高温燃气推动涡轮，带动前端的发电机发电。进气端的叶片转得越快，转速越高。',
        'The compressor squeezes air into the combustor, where it burns with fuel; the hot gas drives the turbine, which turns the generator at the front. The faster the inlet blades spin, the higher the rotor speed.',
      ),
      duration: 8,
      enter() {},
    },
    {
      focus: 'internals',
      turbine: 'A3',
      labels: true,
      title: tr('机组内部的传感器', 'Sensors inside the turbine'),
      text: tr(
        '外壳做成了半透明：前段是压气机的多级叶片，中间是燃烧室，后段是涡轮。每台机组装有 18 或 19 个传感器，测量转速、进气温度、压气机出口压力、火焰、燃料流量、喷嘴温度、排气温度、轴承振动与温度以及有功功率，每个每秒产生一个读数。鼠标移到传感器上可以看到编号和读数。',
        'The casing is see-through: compressor stages at the front, the combustor in the middle and the turbine behind it. Each turbine carries 18 or 19 sensors for rotor speed, inlet temperature, compressor discharge pressure, flame, fuel flow, burner tip temperature, exhaust temperature, bearing vibration and temperature, and active power, each producing a reading every second. Hover over a sensor to see its tag and reading.',
      ),
      duration: 13,
      enter() {},
    },
    {
      focus: 'sources',
      marker: tr('8 个数据源', '8 data sources'),
      title: tr('数据分散在 8 个系统里', 'Data spread over eight systems'),
      text: tr(
        '两座电厂各有一个历史库，表结构不同，温度一个存摄氏度、一个存华氏度；此外还有实时流、设备主数据、报警、维修、调度与气象系统，各自用不同的方式给机组编号。',
        'Each plant has its own historian with a different table layout, one storing Celsius and the other Fahrenheit; there are also a live stream and the master data, alarm, maintenance, dispatch and weather systems, each numbering turbines its own way.',
      ),
      duration: 9,
      enter() {},
    },
    {
      focus: 'turbine',
      turbine: 'A3',
      marker: 'NH-GT3 = 10004713 = GA-60-0207',
      title: tr('同一台机组，三个编号', 'One turbine, three identifiers'),
      text: tr(
        '报警系统叫它 NH-GT3，维修系统叫它 10004713，设备主数据和调度计划叫它 GA-60-0207；西岭电厂的报警代码又是另一套写法。在 VKG 中，它们都映射到同一台机组，查询时只需写“A3”。',
        'The alarm system calls it NH-GT3, the maintenance system 10004713, and the master data and dispatch plan GA-60-0207; the Westridge plant uses yet another code scheme for alarms. In the VKG they all map to the same turbine, so a query simply refers to A3.',
      ),
      duration: 10,
      enter() {},
    },
    {
      focus: 'ingest',
      marker: tr('实时流', 'Live stream'),
      title: tr('实时数据与历史数据', 'Live and archived data'),
      text: tr(
        '读数每秒流入实时流，但只保留最近 10 分钟；历史库每 10 分钟才批量写入一次（看那个方块）。要看完整的一小时，就得把两边拼起来。',
        'Readings flow into the live stream every second, but it keeps only the last 10 minutes; the historians are loaded in batches every 10 minutes (watch the block). Seeing a full hour means joining both.',
      ),
      duration: 9,
      enter() {
        playFrom(m(9, 30), 60, m(11));
      },
    },
    {
      focus: 'hub',
      marker: tr('一个本体', 'One ontology'),
      title: tr('VKG：一个本体连起所有系统', 'The VKG: one ontology over all systems'),
      text: tr(
        'VKG 不搬运、不复制数据。它用一个本体统一描述 8 个系统中的机组、传感器和事件；查询时把问题翻译成各系统能执行的 SQL，再把结果合并。',
        'The VKG does not move or copy data. One ontology describes the turbines, sensors and events in all eight systems; at query time the question is translated into SQL each system can run, and the results are merged.',
      ),
      duration: 9,
      enter() {},
    },
    {
      focus: 'demo',
      turbine: 'A3',
      marker: tr('报警', 'Alarm'),
      title: tr('一个例子：喷嘴过热', 'An example: an overheating burner tip'),
      text: tr(
        '查询“喷嘴温度 10 秒内一路上升并报警”的机组。它同时读取三个信号源和报警系统：A3 一报警，卡片立即变橙；20 分钟前西岭电厂 B1 的同类故障也被找出，尽管它的温度存的是华氏度。',
        'Query for turbines whose burner tip temperature rose for 10 seconds straight and then raised an alarm. The query reads the three signal sources and the alarm system together: the moment A3 alarms, its card turns orange, and a similar fault at Westridge B1 twenty minutes earlier is found too, even though its temperatures are stored in Fahrenheit.',
      ),
      duration: 13,
      enter() {
        setSources(new Set(ALL_SOURCES));
        setQuery(byId('tipFault'));
        selected = null;
        autoSelect = true;
        playFrom(query.story.from, query.story.speed, query.suggest);
      },
    },
    {
      focus: 'demo',
      turbine: 'A3',
      marker: tr('查不到了', 'Not found'),
      title: tr('关掉实时流会怎样', 'What if the live stream is off'),
      text: tr(
        '最近 10 分钟的数据只在实时流里。关掉它，A3 刚发生的报警就查不出来了，只剩已经入库的 B1。VKG 的结果始终取决于当前接入了哪些数据。',
        'The last 10 minutes exist only in the live stream. Switch it off and A3’s fresh alarm can no longer be found; only B1, already archived, remains. VKG results always depend on which sources are connected.',
      ),
      duration: 9,
      enter() {
        stop();
        now = query.suggest;
        setSources(new Set(ALL_SOURCES.filter((id) => id !== 'live')));
        refresh();
      },
    },
    {
      focus: 'pair',
      turbines: ['A1', 'A2'],
      turbine: 'A2',
      marker: tr('清吹未完成', 'Purge not finished'),
      title: tr('一条规则，用于全部机组', 'One rule for every turbine'),
      text: tr(
        '点火失败后要“清吹”残留燃料：火焰熄灭后 15 秒内升速，再在 20 秒内降速。两种型号的转速阈值不同，传统做法要为每台机组手写规则；语义规则只写一次，阈值从设备主数据读取。结果：A1 清吹完成，A2 的转速停在 760 rpm，没能完成。',
        'After a failed ignition the turbine must purge leftover fuel: speed up within 15 s after flame out, then slow down within 20 s. The two models use different speed thresholds, so traditionally each turbine gets hand-written rules; the semantic rule is written once and reads thresholds from the master data. Result: A1 finishes purging, while A2 stalls at 760 rpm.',
      ),
      duration: 14,
      enter() {
        setSources(new Set(ALL_SOURCES));
        setQuery(byId('purging'));
        selected = null;
        autoSelect = true;
        playFrom(query.story.from, query.story.speed, query.suggest);
      },
    },
    {
      focus: 'pair',
      turbines: ['A1', 'B1'],
      turbine: 'A1',
      marker: tr('同批次 L17', 'Same batch L17'),
      title: tr('跨电厂追溯同批次零件', 'Tracing a part batch across plants'),
      text: tr(
        '西岭电厂 B1 的喷嘴报警后，查询沿着“报警 → 零件批次 → 同批次零件 → 所在机组”查下去，发现北港电厂 A1 的 6 个喷嘴也来自批次 L17。这需要同时用到报警系统、维修系统和设备主数据。',
        'After a burner tip alarm at Westridge B1, the query follows alarm → part batch → parts from the same batch → their turbines, and finds that the six tips of North Harbor A1 also come from batch L17. This takes the alarm system, the maintenance system and the master data together.',
      ),
      duration: 11,
      enter() {
        setQuery(byId('batchRisk'));
        selected = null;
        autoSelect = true;
        playFrom(query.story.from, query.story.speed, query.suggest);
      },
    },
    {
      focus: 'pair',
      turbines: ['A3', 'B3'],
      turbine: 'B3',
      marker: tr('计划内停机', 'Planned shutdown'),
      title: tr('计划内还是计划外', 'Planned or unplanned'),
      text: tr(
        '最近 15 分钟，A3 和 B3 的出力都明显下降。对照调度计划可以区分：B3 是按计划停机，A3 是计划外的降负荷，原因来自报警系统中的喷嘴温度高。',
        'In the last 15 minutes, output fell sharply at both A3 and B3. The dispatch plan tells them apart: B3 is a planned shutdown, while A3 is an unplanned load reduction caused by the burner tip overtemperature in the alarm system.',
      ),
      duration: 11,
      enter() {
        setQuery(byId('powerDrop'));
        selected = null;
        autoSelect = true;
        playFrom(query.story.from, query.story.speed, query.suggest);
      },
    },
    {
      focus: 'overview',
      title: tr('自己试试', 'Try it yourself'),
      text: tr(
        '左侧有 13 条查询，涵盖时序模式、多源融合与实时监测。点任意一条，场景会自动演示；右侧可以开关数据源，底部可以拖动时间。',
        'There are 13 queries on the left covering temporal patterns, data fusion and live monitoring. Click any of them and the scene plays it out; switch sources on the right and drag the time at the bottom.',
      ),
      duration: 0,
      enter() {
        setSources(new Set(ALL_SOURCES));
        refresh();
      },
    },
  ];

  const tourBox = $<HTMLElement>('[data-tour]');
  const tourBar = $<HTMLElement>('[data-tour-bar]');
  const tourNext = $<HTMLButtonElement>('[data-tour-next]');
  const tourPrev = $<HTMLButtonElement>('[data-tour-prev]');
  let touring = -1;
  let tourTimer = 0;
  const TOUR_KEY = 'turbine-tour-seen';

  function showTourStep(index: number) {
    window.clearTimeout(tourTimer);
    touring = index;
    const step = TOUR[index];
    stage.classList.add('is-touring');
    tourBox.hidden = false;
    scene?.setInsets(insets());
    $<HTMLElement>('[data-tour-step]').textContent = `${index + 1} / ${TOUR.length}`;
    $<HTMLElement>('[data-tour-title]').textContent = step.title;
    $<HTMLElement>('[data-tour-text]').textContent = step.text;
    tourPrev.disabled = index === 0;
    const lastStep = index === TOUR.length - 1;
    tourNext.textContent = lastStep ? tr('开始探索', 'Start exploring') : tr('下一步', 'Next');
    step.enter();
    scene?.tour(step);
    tourBar.style.transition = 'none';
    tourBar.style.width = lastStep ? '100%' : '0';
    if (!lastStep && step.duration) {
      void tourBar.offsetWidth;
      tourBar.style.transition = `width ${step.duration}s linear`;
      tourBar.style.width = '100%';
      tourTimer = window.setTimeout(() => showTourStep(index + 1), step.duration * 1000);
    }
  }

  function startTour() {
    showTourStep(0);
  }

  function endTour() {
    window.clearTimeout(tourTimer);
    touring = -1;
    stage.classList.remove('is-touring');
    tourBox.hidden = true;
    scene?.tour(null);
    setSources(new Set(ALL_SOURCES));
    scene?.setInsets(insets());
    scene?.resetView();
    try {
      localStorage.setItem(TOUR_KEY, '1');
    } catch {
      /* 存储不可用时下次仍会播放导览 */
    }
    refresh();
  }

  tourNext.addEventListener(
    'click',
    () => (touring >= TOUR.length - 1 ? endTour() : showTourStep(touring + 1)),
    { signal },
  );
  tourPrev.addEventListener('click', () => touring > 0 && showTourStep(touring - 1), { signal });
  $<HTMLButtonElement>('[data-tour-skip]').addEventListener('click', endTour, { signal });
  $<HTMLButtonElement>('[data-turbine-tour]').addEventListener('click', startTour, { signal });
  signal.addEventListener('abort', () => window.clearTimeout(tourTimer));

  const tourSeen = () => {
    try {
      return localStorage.getItem(TOUR_KEY) === '1';
    } catch {
      return false;
    }
  };

  // ── 播放 ──
  let frame = 0;
  let last = 0;
  let lastRefresh = 0;
  let carry = 0;
  function tick(time: number) {
    if (!playing) return;
    const dt = last ? Math.min(0.1, (time - last) / 1000) : 0;
    last = time;
    carry += dt * speed;
    const step = Math.floor(carry);
    const end = storyEnd ?? SPAN;
    if (step > 0) {
      carry -= step;
      now = Math.min(end, now + step);
    }
    if (time - lastRefresh > REFRESH_INTERVAL || now >= end) {
      lastRefresh = time;
      refresh();
    }
    if (now >= end) {
      storyEnd = null;
      stop();
      return;
    }
    frame = requestAnimationFrame(tick);
  }
  function play() {
    if (now >= SPAN) now = 0;
    playing = true;
    last = 0;
    carry = 0;
    playButton.setAttribute('aria-pressed', 'true');
    playButton.setAttribute('aria-label', tr('暂停', 'Pause'));
    frame = requestAnimationFrame(tick);
  }
  function stop() {
    playing = false;
    cancelAnimationFrame(frame);
    playButton.setAttribute('aria-pressed', 'false');
    playButton.setAttribute('aria-label', tr('播放', 'Play'));
    scene?.setTime(now, false);
  }

  // ── 事件 ──
  for (const tab of $$<HTMLButtonElement>('[data-group-tab]')) {
    tab.addEventListener('click', () => selectGroup(tab.dataset.groupTab as QueryGroup), {
      signal,
    });
  }
  for (const b of $$<HTMLButtonElement>('[data-turbine-query]')) {
    b.addEventListener(
      'click',
      () => selectQuery(queries.find((q) => q.id === b.dataset.turbineQuery)!),
      { signal },
    );
  }
  /**
   * 播放时结果列表与详情每秒重绘多次，按下与松开可能落在不同的元素上而丢失 click，
   * 因此鼠标在按下时响应，键盘仍通过 click 响应。
   */
  const onActivate = (el: HTMLElement, handler: (target: HTMLElement) => void) => {
    el.addEventListener(
      'pointerdown',
      (event) => {
        if (event.button === 0) handler(event.target as HTMLElement);
      },
      { signal },
    );
    el.addEventListener(
      'click',
      (event) => {
        if (event.detail === 0) handler(event.target as HTMLElement);
      },
      { signal },
    );
  };
  onActivate(detailBox, (target) => {
    const unit = target.closest<HTMLElement>('[data-unit]');
    const sensor = target.closest<HTMLElement>('[data-sensor]');
    if (target.closest('[data-detail-close]')) closeDetail();
    else if (sensor) openSensor(sensor.dataset.sensor!);
    else if (unit) {
      if (detail?.type === 'sensor') scene?.focusSensor(null);
      openUnit(unit.dataset.unit as TurbineId);
    }
  });
  for (const b of $$<HTMLButtonElement>('[data-side-tab]')) {
    b.addEventListener('click', () => showSideTab(b.dataset.sideTab as 'sources' | 'detail'), {
      signal,
    });
  }
  onActivate(resultBox, (target) => {
    const button = target.closest<HTMLButtonElement>('[data-row-turbine]');
    if (!button) return;
    selected = button.dataset.rowTurbine as TurbineId;
    autoSelect = false;
    if (button.dataset.rowAt !== undefined && !playing) {
      now = Math.min(SPAN, Number(button.dataset.rowAt));
    }
    range = 'fit';
    refresh();
  });
  for (const input of $$<HTMLInputElement>('[data-source]')) {
    input.addEventListener(
      'change',
      () => {
        const id = input.dataset.source as SourceId;
        const next = new Set(sources);
        if (input.checked) next.add(id);
        else next.delete(id);
        sources = next;
        refresh();
      },
      { signal },
    );
  }
  for (const b of $$<HTMLButtonElement>('[data-turbine-preset]')) {
    b.addEventListener(
      'click',
      () => {
        sources = new Set(PRESETS[b.dataset.turbinePreset!]);
        for (const input of $$<HTMLInputElement>('[data-source]')) {
          input.checked = sources.has(input.dataset.source as SourceId);
        }
        refresh();
      },
      { signal },
    );
  }
  for (const b of $$<HTMLButtonElement>('[data-turbine-range]')) {
    b.addEventListener(
      'click',
      () => {
        range = b.dataset.turbineRange as typeof range;
        refresh();
      },
      { signal },
    );
  }
  $<HTMLButtonElement>('[data-turbine-collapse]').addEventListener(
    'click',
    (event) => {
      const collapsed = signalsPanel.classList.toggle('is-collapsed');
      (event.currentTarget as HTMLElement).setAttribute('aria-expanded', String(!collapsed));
      window.setTimeout(() => scene?.setInsets(insets()), 320);
    },
    { signal },
  );
  timeInput.addEventListener(
    'input',
    () => {
      storyEnd = null;
      now = Number(timeInput.value);
      refresh();
    },
    { signal },
  );
  playButton.addEventListener(
    'click',
    () => {
      if (playing) stop();
      else {
        storyEnd = null;
        play();
      }
    },
    { signal },
  );
  for (const b of $$<HTMLButtonElement>('[data-turbine-speed]')) {
    b.addEventListener('click', () => setSpeed(Number(b.dataset.turbineSpeed)), { signal });
  }
  $<HTMLButtonElement>('[data-turbine-replay]').addEventListener('click', playStory, { signal });
  $<HTMLButtonElement>('[data-turbine-reset]').addEventListener('click', () => scene?.resetView(), {
    signal,
  });

  // ── 全屏 ──
  const fullscreenButton = $<HTMLButtonElement>('[data-turbine-fullscreen]');
  fullscreenButton.addEventListener(
    'click',
    () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void stage.requestFullscreen?.();
    },
    { signal },
  );
  document.addEventListener(
    'fullscreenchange',
    () => {
      const on = document.fullscreenElement === stage;
      stage.classList.toggle('is-fullscreen', on);
      fullscreenButton.setAttribute('aria-pressed', String(on));
    },
    { signal },
  );

  // ── 取景：面板占用的边距 ──
  const insets = () => {
    if (touring >= 0 || window.matchMedia('(max-width: 1080px)').matches) {
      return { left: 0, right: 0, top: 0, bottom: 0 };
    }
    const area = viewport.getBoundingClientRect();
    const bottomEdge = Math.min(
      signalsPanel.getBoundingClientRect().top,
      timeline.getBoundingClientRect().top,
    );
    return {
      left: Math.max(0, queriesPanel.getBoundingClientRect().right - area.left),
      right: Math.max(0, area.right - sourcesPanel.getBoundingClientRect().left),
      top: Math.max(0, story.getBoundingClientRect().bottom - area.top),
      bottom: Math.max(0, area.bottom - bottomEdge),
    };
  };
  const resizeObserver = new ResizeObserver(() => scene?.setInsets(insets()));
  resizeObserver.observe(stage);

  // ── 三维场景按需加载 ──
  const loadScene = async () => {
    if (!webglAvailable()) {
      stage.classList.add('is-fallback');
      status.textContent = tr(
        '当前环境不支持 WebGL，三维场景不可用；查询、数据源开关、时间轴与信号曲线仍可使用。',
        'WebGL is not available, so the 3D scene cannot be shown; queries, source switches, the timeline and the signals still work.',
      );
      playStory();
      return;
    }
    status.textContent = tr('正在加载三维场景…', 'Loading the 3D scene…');
    try {
      const { createTurbineScene } = await import('./scene');
      if (signal.aborted) return;
      scene = createTurbineScene(viewport, pinLayer, {
        reducedMotion: reduced,
        onSelect: selectTurbine,
        onSelectSensor: openSensor,
      });
      stage.classList.add('is-ready');
      status.textContent = '';
      scene.setInsets(insets());
      freshQuery = true;
      if (tourSeen()) playStory();
      else startTour();
    } catch (error) {
      console.error(error);
      stage.classList.add('is-fallback');
      status.textContent = tr(
        '三维场景加载失败；查询、数据源开关、时间轴与信号曲线仍可使用。',
        'The 3D scene failed to load; queries, source switches, the timeline and the signals still work.',
      );
      playStory();
    }
  };

  const loader = new IntersectionObserver(
    ([entry]) => {
      if (!entry.isIntersecting) return;
      loader.disconnect();
      void loadScene();
    },
    { rootMargin: '100px' },
  );
  loader.observe(stage);

  signal.addEventListener('abort', () => {
    stop();
    loader.disconnect();
    resizeObserver.disconnect();
    scene?.dispose();
    scene = null;
  });

  refresh();
}
