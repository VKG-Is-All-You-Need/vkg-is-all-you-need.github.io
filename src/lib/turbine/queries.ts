/**
 * 设备诊断示例中的查询。每条查询声明所需的数据源，并按此刻（now）与当前接入的数据源求值：
 * 信号只读到 now 为止，历史库只含已入库的批次，实时流只保留最近 10 分钟。
 * 时序规则由 rules.ts 中的算子实际计算，结果随时间轴与数据源开关变化。
 */
import { tr } from '../../i18n/runtime';
import {
  MODELS,
  PLANTS,
  TURBINES,
  componentById,
  componentShort,
  modelOf,
  plantOf,
  sensorsOf,
  turbineById,
  type Sensor,
  type SensorKind,
  type TurbineId,
} from './fleet';
import {
  EVENTS,
  INSPECTION_MONTHS,
  WORK_ORDERS,
  batchOf,
  daysBetween,
  eventLabel,
  eventsUntil,
  lastBurnerService,
  plannedPower,
  weatherAt,
  type ControlEvent,
} from './records';
import {
  after,
  avg,
  latest,
  length,
  longer,
  max,
  mean,
  median,
  min,
  rising,
  samples,
  where,
  type Interval,
} from './rules';
import { observed, originOf, tagsOf, toFahrenheit } from './signals';
import { SIGNAL_SOURCES, sourceById, type SourceId } from './sources';
import { LIVE_RETENTION, SAMPLES, SPAN, formatSpan, formatTime, lastBatch, m } from './time';

export type QueryGroup = 'temporal' | 'fusion' | 'live';

export interface TurbineContext {
  now: number;
  sources: ReadonlySet<SourceId>;
}

export interface ResultRow {
  key: string;
  title: string;
  detail: string;
  hit: boolean;
  /** 点击后选中的机组与跳转的时刻。 */
  turbine?: TurbineId;
  at?: number;
}

/** 一条语义规则展开到各机组后引用的传感器编号。 */
export interface Expansion {
  rules: number;
  turbines: { turbine: TurbineId; tags: string[] }[];
}

export interface TurbineResult {
  status: 'ok' | 'partial' | 'unavailable';
  missing: SourceId[];
  notes: string[];
  summary: string;
  rows: ResultRow[];
  hits: TurbineId[];
  /** 默认在信号视图中展示的机组。 */
  focus?: TurbineId;
  expansion?: Expansion;
}

export type Tone = 'main' | 'muted' | 'hit' | 'plan';

export interface Series {
  label: string;
  values: Float32Array;
  tone: Tone;
  /** 曲线所用的传感器（聚合曲线有多个）。 */
  tags?: string[];
}

export interface Mark {
  from: number;
  to: number;
  label: string;
  tone: 'hit' | 'info' | 'miss';
}

/** 两个时刻之间的先后关系，如 after[15s]。 */
export interface Link {
  from: number;
  to: number;
  label: string;
  ok: boolean;
}

export interface Track {
  id: string;
  label: string;
  unit: string;
  series: Series[];
  step?: boolean;
  /** 固定的纵轴范围；未给出时按数据自动缩放。 */
  fixed?: [number, number];
  /** 自动缩放时纵轴的最小跨度，避免噪声被放大。 */
  minSpan?: number;
  thresholds: { value: number; label: string }[];
  marks: Mark[];
  links: Link[];
}

export interface ChartSpec {
  tracks: Track[];
  /** 建议的显示范围。 */
  window: [number, number];
  /** 查询涉及的传感器，与命中的传感器。 */
  sensors: string[];
  hitSensors: string[];
  events: { t: number; label: string }[];
}

export interface QueryText {
  rule: string;
  sql: string;
}

export interface TurbineQuery {
  id:
    | 'purging'
    | 'tipFault'
    | 'trip'
    | 'rampChange'
    | 'stuckSensor'
    | 'hottestTips'
    | 'exhaust'
    | 'faultHistory'
    | 'batchRisk'
    | 'vibration'
    | 'state'
    | 'dispatch'
    | 'powerDrop';
  group: QueryGroup;
  /** 规则所用的语言。 */
  lang: 'sigRL' | 'STARQL' | 'SPARQL';
  title: string;
  description: string;
  sources: SourceId[];
  /** 选中查询后停下的时刻。 */
  suggest: number;
  /** 选中查询后自动播放的起点与倍速，播放到 suggest 为止。 */
  story: { from: number; speed: number };
  /** 面向非专业读者的说明：难在哪里，VKG 怎么做。 */
  explain: { hard: string; vkg: string };
  text: QueryText;
  run(ctx: TurbineContext): TurbineResult;
  chart(turbine: TurbineId, ctx: TurbineContext, result: TurbineResult): ChartSpec;
}

// ─────────────────────────── 公共部分 ───────────────────────────

const names = (ids: SourceId[]) => ids.map((id) => sourceById.get(id)!.name).join(tr('、', ', '));
const has = (ctx: TurbineContext, id: SourceId) => ctx.sources.has(id);
const fmt = (value: number, digits = 0) =>
  value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const signed = (value: number, digits = 0) => {
  const text = fmt(Math.abs(value), digits);
  return `${value >= 0 || Number(text) === 0 ? '+' : '−'}${text}`;
};
/** 计数：中文用量词，英文区分单复数。 */
const count = (n: number, zh: string, en: string, enPlural = `${en}s`) =>
  tr(`${n} ${zh}`, `${n} ${n === 1 ? en : enPlural}`);
const clampWindow = (from: number, to: number): [number, number] => {
  const a = Math.max(0, Math.round(from));
  const b = Math.min(SPAN, Math.round(to));
  return b - a < 60 ? [Math.max(0, b - 60), Math.max(60, b)] : [a, b];
};
const recent = (ctx: TurbineContext, seconds: number): [number, number] =>
  clampWindow(ctx.now - seconds, ctx.now);

const sig = (tag: string, ctx: TurbineContext) => observed(tag, ctx.now, ctx.sources);
const sigs = (turbine: TurbineId, kind: SensorKind, ctx: TurbineContext) =>
  tagsOf(turbine, kind).map((tag) => sig(tag, ctx));
const speedOf = (turbine: TurbineId, ctx: TurbineContext) => avg(sigs(turbine, 'speed', ctx));
const flameOf = (turbine: TurbineId, ctx: TurbineContext) => sig(tagsOf(turbine, 'flame')[0], ctx);
const powerOf = (turbine: TurbineId, ctx: TurbineContext) => sig(tagsOf(turbine, 'power')[0], ctx);

/** 信号缺失的说明：历史库或实时流未接入时，哪些时段读不到。 */
function signalNotes(ctx: TurbineContext): string[] {
  const notes: string[] = [];
  const batch = formatTime(lastBatch(ctx.now));
  if (!has(ctx, 'live')) {
    notes.push(
      tr(
        `实时流未接入：只能读到 ${batch} 之前已入库的数据。`,
        `Live stream not connected: only data loaded before ${batch} is available.`,
      ),
    );
  }
  for (const plant of Object.values(PLANTS)) {
    if (has(ctx, plant.historian)) continue;
    const name = sourceById.get(plant.historian)!.name;
    notes.push(
      has(ctx, 'live')
        ? tr(
            `${name} 未接入：${plant.name}只有最近 10 分钟的实时数据。`,
            `${name} not connected: only the last 10 minutes of live data are available for the ${plant.name}.`,
          )
        : tr(
            `${name} 未接入：${plant.name}没有信号。`,
            `${name} not connected: no signals from the ${plant.name}.`,
          ),
    );
  }
  return notes;
}

function base(query: Pick<TurbineQuery, 'sources'>, ctx: TurbineContext): TurbineResult {
  const missing = query.sources.filter((id) => !has(ctx, id));
  const notes = query.sources.some((id) => SIGNAL_SOURCES.includes(id)) ? signalNotes(ctx) : [];
  return {
    status: missing.length ? 'partial' : 'ok',
    missing,
    notes,
    summary: '',
    rows: [],
    hits: [],
  };
}

const unavailable = (result: TurbineResult, note: string): TurbineResult => ({
  ...result,
  status: 'unavailable',
  notes: [note, ...result.notes],
  summary: tr('无法回答', 'Cannot answer'),
  rows: [],
  hits: [],
});

const needMaster = (result: TurbineResult, what: string) =>
  unavailable(
    result,
    tr(`设备主数据未接入：缺少${what}。`, `Equipment master data not connected: ${what} missing.`),
  );

/** 机组在 now 时刻是否有任何可读的信号。 */
const readable = (turbine: TurbineId, ctx: TurbineContext) => {
  const plant = turbineById.get(turbine)!.plant;
  return (
    originOf(plant, ctx.now, ctx.now, ctx.sources) !== null ||
    originOf(plant, lastBatch(ctx.now), ctx.now, ctx.sources) !== null
  );
};

const tipName = (sensor: Sensor) => componentShort(componentById.get(sensor.component)!);

/** 事件对应的机组：北港电厂的事件代号与历史库 A 一致，西岭电厂需经设备主数据对照。 */
function eventTurbine(event: ControlEvent, ctx: TurbineContext): TurbineId | null {
  const plant = turbineById.get(event.turbine)!.plant;
  return plant === 'A' || has(ctx, 'master') ? event.turbine : null;
}

const westNote = () =>
  tr(
    '设备主数据未接入：西岭电厂的事件以控制系统代号（如 11MBA）登记，无法对应到机组。',
    'Equipment master data not connected: Westridge events are registered under control system codes (such as 11MBA) and cannot be linked to turbines.',
  );

// ── 信号视图中的轨道 ──

function speedTrack(
  turbine: TurbineId,
  ctx: TurbineContext,
  options: { sensors?: boolean; hitTag?: string; thresholds?: Track['thresholds'] } = {},
): Track {
  const tags = tagsOf(turbine, 'speed');
  const series: Series[] = options.sensors
    ? tags.map((tag) => ({
        label: tag,
        tags: [tag],
        values: sig(tag, ctx),
        tone: tag === options.hitTag ? 'hit' : 'muted',
      }))
    : [
        {
          label: tr('平均转速', 'Average speed'),
          values: speedOf(turbine, ctx),
          tone: 'main',
          tags,
        },
      ];
  return {
    id: 'speed',
    label: tr('转速', 'Rotor speed'),
    unit: 'rpm',
    series,
    fixed: options.sensors ? undefined : [0, 3300],
    minSpan: 8,
    thresholds: options.thresholds ?? [],
    marks: [],
    links: [],
  };
}

const flameTrack = (turbine: TurbineId, ctx: TurbineContext): Track => ({
  id: 'flame',
  label: tr('火焰', 'Flame'),
  unit: '',
  series: [
    {
      label: tr('火焰', 'Flame'),
      values: flameOf(turbine, ctx),
      tone: 'main',
      tags: tagsOf(turbine, 'flame'),
    },
  ],
  step: true,
  thresholds: [],
  marks: [],
  links: [],
});

function tipTrack(turbine: TurbineId, ctx: TurbineContext, hitTag?: string): Track {
  const model = modelOf(turbine);
  return {
    id: 'tip',
    label: tr('喷嘴温度', 'Burner tip temperature'),
    unit: '°C',
    minSpan: 120,
    series: sensorsOf(turbine, 'tip').map((s) => ({
      label: tipName(s),
      tags: [s.tag],
      values: sig(s.tag, ctx),
      tone: s.tag === hitTag ? 'hit' : 'muted',
    })),
    thresholds: has(ctx, 'master') ? [{ value: model.tipLimit, label: tr('上限', 'Limit') }] : [],
    marks: [],
    links: [],
  };
}

function powerTrack(turbine: TurbineId, ctx: TurbineContext): Track {
  const series: Series[] = [
    {
      label: tr('实际出力', 'Actual output'),
      values: powerOf(turbine, ctx),
      tone: 'main',
      tags: tagsOf(turbine, 'power'),
    },
  ];
  if (has(ctx, 'dispatch')) {
    const plan = new Float32Array(SAMPLES);
    for (let t = 0; t < SAMPLES; t++) plan[t] = plannedPower(turbine, t);
    series.push({ label: tr('调度计划', 'Dispatch plan'), values: plan, tone: 'plan' });
  }
  return {
    id: 'power',
    label: tr('有功出力', 'Active power'),
    unit: 'MW',
    fixed: [0, Math.ceil((modelOf(turbine).capacity * 1.1) / 10) * 10],
    series,
    thresholds: [],
    marks: [],
    links: [],
  };
}

function exhaustTrack(turbine: TurbineId, ctx: TurbineContext): Track {
  const series: Series[] = [
    {
      label: tr('实测', 'Measured'),
      values: sig(tagsOf(turbine, 'exhaust')[0], ctx),
      tone: 'main',
      tags: tagsOf(turbine, 'exhaust'),
    },
  ];
  if (has(ctx, 'master')) {
    const model = modelOf(turbine);
    const plant = turbineById.get(turbine)!.plant;
    const power = powerOf(turbine, ctx);
    const ref = new Float32Array(SAMPLES).fill(NaN);
    for (let t = 0; t <= Math.min(ctx.now, SPAN); t++) {
      if (Number.isNaN(power[t]) || power[t] < 1) continue;
      const amb = has(ctx, 'weather') ? weatherAt(plant, t).temp : 15;
      ref[t] =
        model.exhaustBase +
        (model.exhaustSlope * power[t]) / model.capacity +
        model.ambientCoef * (amb - 15);
    }
    series.push({ label: tr('参考曲线', 'Reference curve'), values: ref, tone: 'plan' });
  }
  return {
    id: 'exhaust',
    label: tr('排气温度', 'Exhaust temperature'),
    unit: '°C',
    minSpan: 100,
    series,
    thresholds: [],
    marks: [],
    links: [],
  };
}

function vibrationTrack(turbine: TurbineId, ctx: TurbineContext, hitTag?: string): Track {
  return {
    id: 'vibration',
    label: tr('轴承振动', 'Bearing vibration'),
    unit: 'mm/s',
    minSpan: 4,
    series: sensorsOf(turbine, 'vibration').map((s) => ({
      label: componentShort(componentById.get(s.component)!),
      tags: [s.tag],
      values: sig(s.tag, ctx),
      tone: s.tag === hitTag ? 'hit' : 'muted',
    })),
    thresholds: [],
    marks: [],
    links: [],
  };
}

const eventsOf = (turbine: TurbineId, ctx: TurbineContext) =>
  has(ctx, 'events')
    ? eventsUntil(ctx.now)
        .filter((e) => e.turbine === turbine && eventTurbine(e, ctx))
        .map((e) => ({ t: e.t, label: eventLabel(e.type) }))
    : [];

const spec = (
  tracks: Track[],
  window: [number, number],
  turbine: TurbineId,
  ctx: TurbineContext,
  extra: Partial<ChartSpec> = {},
): ChartSpec => ({
  tracks,
  window,
  sensors: tracks.flatMap((t) => t.series.flatMap((s) => s.tags ?? [])),
  hitSensors: [],
  events: eventsOf(turbine, ctx),
  ...extra,
});

const expansionOf = (kinds: SensorKind[], rulesPerTurbine: number): Expansion => ({
  rules: rulesPerTurbine * TURBINES.length,
  turbines: TURBINES.map((t) => ({
    turbine: t.id,
    tags: kinds.flatMap((kind) => tagsOf(t.id, kind)),
  })),
});

const SIGNALS: SourceId[] = ['hist_a', 'hist_b', 'live'];

// ─────────────────────────── 时序模式 ───────────────────────────

interface PurgeCase {
  flame: Interval;
  start: Interval;
  stop?: Interval;
  /** 清吹结束后 20 秒内的最低转速。 */
  lowest?: number;
}

function purgeCases(turbine: TurbineId, ctx: TurbineContext): PurgeCase[] {
  const model = modelOf(turbine);
  const speed = speedOf(turbine, ctx);
  const flames = longer(
    where(flameOf(turbine, ctx), ctx.now, (v) => v > 0.5),
    10,
  );
  const starts = where(speed, ctx.now, (v) => v > model.purgingSpeed);
  const stops = where(speed, ctx.now, (v) => v < model.nonPurgingSpeed);
  return after(flames, starts, 15).map(({ first, second }) => {
    const stop = after([second], stops, 20)[0]?.second;
    const window = samples(speed, second.to + 1, second.to + 20);
    return {
      flame: first,
      start: second,
      stop,
      lowest: window.length ? Math.min(...window) : undefined,
    };
  });
}

const purging = (): TurbineQuery => ({
  id: 'purging',
  group: 'temporal',
  lang: 'sigRL',
  title: tr('点火失败后的清吹是否完成', 'Whether purging finished after a failed ignition'),
  description: tr(
    'sigRL 论文中的清吹任务：火焰持续 10 秒以上后熄灭，15 秒内转速升到清吹阈值以上，之后 20 秒内降到结束阈值以下。阈值随机组型号不同，来自设备主数据。',
    'The purging task from the sigRL paper: the flame burns for more than 10 s and goes out, the rotor exceeds the purging speed within 15 s, and then drops below the end threshold within 20 s. Thresholds differ by model and come from the master data.',
  ),
  sources: [...SIGNALS, 'master'],
  suggest: m(14, 30),
  story: { from: m(4), speed: 60 },
  explain: {
    hard: tr(
      '点火失败后，要用高速气流把残留燃料吹干净（清吹）。判断是否吹净要看转速，而转速分散在两个结构不同的历史库和实时流里；两种型号的阈值也不同。传统做法要为每台机组单独写规则。',
      'After a failed ignition, the turbine blows out leftover fuel with fast airflow (purging). Whether purging finished depends on rotor speed, which is spread across two historians with different layouts and a live stream, and the two models use different thresholds. Traditionally, rules are written separately for every turbine.',
    ),
    vkg: tr(
      '一条规则按“火焰熄灭 → 15 秒内升速 → 20 秒内降速”描述清吹。VKG 通过本体找到每台机组的转速传感器，从设备主数据读取各自的阈值，规则自动用于全部 8 台机组。',
      "One rule describes purging as “flame out → speed up within 15 s → slow down within 20 s”. The VKG finds each turbine's speed sensors through the ontology and reads its thresholds from the master data, so the rule applies to all eight turbines.",
    ),
  },
  text: {
    rule: `${tr('# sigRL（Mehdi 等，ISWC 2017，例 4）', '# sigRL (Mehdi et al., ISWC 2017, Example 4)')}
rotorSensor(x) ← :RotorSpeedSensor(x) ∧ :monitors(x, y) ∧ :Rotor(y)

PurgingStart = avg rotorSensor : value(>, :purgingSpeed)
PurgingStop  = avg rotorSensor : value(<, :nonPurgingSpeed)

message("Purging over") =
    :FlameSensor : duration(>, 10s)
      : after[15s] PurgingStart
      : after[20s] PurgingStop`,
    sql: `${tr('-- obs：映射展开的 hist_a ∪ hist_b ∪ live（见下方映射）', '-- obs: hist_a ∪ hist_b ∪ live as unfolded from the mappings (see below)')}
WITH speed AS (
  SELECT o.serial, o.ts, AVG(o.value) AS rpm
  FROM   obs o
  WHERE  o.class = 'RotorSpeedSensor'
  GROUP  BY o.serial, o.ts
), flagged AS (
  SELECT s.*, s.rpm > p.purging_speed     AS purging,
              s.rpm < p.non_purging_speed AS stopped
  FROM   speed s JOIN master.dbo.parameters p ON p.serial = s.serial
)
${tr('-- 连续时段：时间戳减行号分组；after[t] 比较相邻时段的端点', '-- intervals: group by timestamp minus row number; after[t] compares interval endpoints')}
SELECT f.serial, MIN(st.ts) AS purging_over
FROM   flame_runs f
JOIN   purge_runs  pu ON pu.serial = f.serial AND pu.start - f.stop BETWEEN 1 AND 15
JOIN   stop_runs   st ON st.serial = f.serial AND st.start - pu.stop BETWEEN 1 AND 20
WHERE  f.stop - f.start > 10
GROUP  BY f.serial`,
  },
  run(ctx) {
    const result = base(this, ctx);
    if (!has(ctx, 'master'))
      return needMaster(
        result,
        tr(
          '各机组的清吹阈值，规则无法实例化',
          'the purging thresholds of each turbine, so the rule cannot be instantiated',
        ),
      );
    let done = 0;
    let started = 0;
    for (const turbine of TURBINES) {
      const model = MODELS[turbine.model];
      const cases = purgeCases(turbine.id, ctx);
      if (!cases.length) {
        result.rows.push({
          key: turbine.id,
          title: turbine.id,
          detail: readable(turbine.id, ctx)
            ? tr('无点火失败后的清吹', 'No purge after failed ignition')
            : tr('无信号', 'No signal'),
          hit: false,
          turbine: turbine.id,
        });
        continue;
      }
      started++;
      const c = cases[cases.length - 1];
      if (c.stop) {
        done++;
        result.hits.push(turbine.id);
        result.rows.push({
          key: turbine.id,
          title: tr(`${turbine.id} 清吹完成`, `${turbine.id} purging over`),
          detail: formatTime(c.stop.from),
          hit: true,
          turbine: turbine.id,
          at: c.stop.from + 30,
        });
      } else if (c.start.open || ctx.now - c.start.to <= 20) {
        result.rows.push({
          key: turbine.id,
          title: tr(`${turbine.id} 清吹进行中`, `${turbine.id} purging`),
          detail: tr(`${model.purgingSpeed} rpm 以上`, `above ${model.purgingSpeed} rpm`),
          hit: false,
          turbine: turbine.id,
        });
      } else {
        result.hits.push(turbine.id);
        result.rows.push({
          key: turbine.id,
          title: tr(`${turbine.id} 清吹未完成`, `${turbine.id} purging not finished`),
          detail: tr(
            `20 秒内最低 ${fmt(c.lowest ?? NaN)} rpm（阈值 ${model.nonPurgingSpeed}）`,
            `lowest ${fmt(c.lowest ?? NaN)} rpm within 20 s (threshold ${model.nonPurgingSpeed})`,
          ),
          hit: true,
          turbine: turbine.id,
          at: c.start.to + 60,
        });
      }
    }
    result.rows.sort((a, b) => Number(b.hit) - Number(a.hit));
    result.summary = started
      ? tr(`${started} 台清吹，${done} 台完成`, `${started} purged, ${done} finished`)
      : tr('无清吹过程', 'No purging');
    result.focus = result.hits[0];
    result.expansion = expansionOf(['speed', 'flame'], 3);
    return result;
  },
  chart(turbine, ctx) {
    const model = modelOf(turbine);
    const flame = flameTrack(turbine, ctx);
    const speed = speedTrack(turbine, ctx, {
      thresholds: has(ctx, 'master')
        ? [
            { value: model.purgingSpeed, label: tr('清吹', 'Purging') },
            { value: model.nonPurgingSpeed, label: tr('结束', 'End') },
          ]
        : [],
    });
    const cases = has(ctx, 'master') ? purgeCases(turbine, ctx) : [];
    const c = cases[cases.length - 1];
    if (!c) return spec([flame, speed], recent(ctx, 900), turbine, ctx);
    flame.marks.push({ from: c.flame.from, to: c.flame.to, label: 'duration > 10s', tone: 'info' });
    speed.marks.push({ from: c.start.from, to: c.start.to, label: 'PurgingStart', tone: 'info' });
    flame.links.push({
      from: c.flame.to,
      to: c.start.from,
      label: `after[15s] · ${c.start.from - c.flame.to} s`,
      ok: true,
    });
    if (c.stop) {
      speed.marks.push({
        from: c.stop.from,
        to: Math.min(c.stop.to, c.stop.from + 40),
        label: 'PurgingStop',
        tone: 'hit',
      });
      speed.links.push({
        from: c.start.to,
        to: c.stop.from,
        label: `after[20s] · ${c.stop.from - c.start.to} s`,
        ok: true,
      });
    } else if (!c.start.open) {
      speed.links.push({
        from: c.start.to,
        to: c.start.to + 20,
        label: tr('20 秒内未降到阈值以下', 'not below threshold within 20 s'),
        ok: false,
      });
    }
    return spec(
      [flame, speed],
      clampWindow(c.flame.from - 60, (c.stop?.from ?? c.start.to + 20) + 90),
      turbine,
      ctx,
    );
  },
});

interface TipFault {
  event: ControlEvent;
  turbine: TurbineId;
  sensor: Sensor;
  rising: boolean;
  /** 窗口起止的温度（°C）。 */
  from: number;
  to: number;
  readable: boolean;
}

function tipFaults(ctx: TurbineContext): TipFault[] {
  if (!has(ctx, 'events')) return [];
  const out: TipFault[] = [];
  for (const event of eventsUntil(ctx.now)) {
    if (event.type !== 'fault') continue;
    const turbine = eventTurbine(event, ctx);
    if (!turbine) continue;
    const sensor = sensorsOf(turbine, 'tip').find(
      (s) => componentById.get(s.component)!.code === event.component,
    )!;
    const values = sig(sensor.tag, ctx);
    const ok = rising(values, event.t - 10, event.t);
    out.push({
      event,
      turbine,
      sensor,
      rising: ok,
      from: values[event.t - 10],
      to: values[event.t],
      readable: !Number.isNaN(values[event.t]),
    });
  }
  return out;
}

const tipFault = (): TurbineQuery => ({
  id: 'tipFault',
  group: 'temporal',
  lang: 'STARQL',
  title: tr(
    '喷嘴温度在 10 秒内单调上升后报故障',
    'Burner tip temperature rising for 10 s before a fault',
  ),
  description: tr(
    'Optique 演示中的连续查询：10 秒窗口、每秒滑动一次，窗口内温度单调上升且以故障标记结束时输出。故障标记来自控制系统事件，温度来自三个信号源。',
    'The continuous query from the Optique demo: a 10 s window sliding every second, reporting when the temperature rises monotonically within the window and ends in a fault flag. Fault flags come from control system events, temperatures from the three signal sources.',
  ),
  sources: [...SIGNALS, 'events', 'master'],
  suggest: m(42),
  story: { from: m(40, 30), speed: 10 },
  explain: {
    hard: tr(
      '喷嘴过热之前，温度会持续上升。北港电厂的温度以摄氏度存放，西岭电厂以华氏度存放；报警记录在另一个系统中，两座电厂的报警代码也不同。',
      'Before a burner tip overheats, its temperature keeps rising. North Harbor stores temperatures in Celsius and Westridge in Fahrenheit; alarms live in another system, and the two plants use different alarm codes.',
    ),
    vkg: tr(
      '连续查询每秒检查最近 10 秒的温度是否一路上升并以报警结束。单位换算与报警代码的对应写在映射中，查询本身不关心数据来自哪里。',
      'A continuous query checks every second whether the temperature over the last 10 seconds rose all the way and ended in an alarm. Unit conversion and alarm codes are handled in the mappings, so the query does not care where the data comes from.',
    ),
  },
  text: {
    rule: `${tr('# STARQL（Kharlamov 等，DEBS 2016，图 2）', '# STARQL (Kharlamov et al., DEBS 2016, Figure 2)')}
CREATE STREAM S_out AS
CONSTRUCT GRAPH NOW { ?c2 rdf:type :MonInc }
FROM STREAM S_Msmt [NOW-"PT10S"^^xsd:duration, NOW]->"PT1S"^^xsd:duration,
     STATIC DATA <static>, ONTOLOGY <ontology>
USING PULSE WITH START = "06:00:00", FREQUENCY = "1S"
WHERE { ?c1 a :BurnerTip . ?c2 a :TemperatureSensor .
        ?c1 :monitoredBy ?c2 . }
SEQUENCE BY StandardSequencing AS seq
HAVING MONOTONIC.HAVING(seq, ?c2, :hasValue)

CREATE AGGREGATE MONOTONIC.HAVING ($seq, $var, $attr) AS
HAVING EXISTS ?k IN $seq: GRAPH ?k { $var :showsFault "true" }
   AND FORALL ?i, ?j IN $seq:
       IF (?i < ?j < ?k AND GRAPH ?i { $var $attr ?x }
                        AND GRAPH ?j { $var $attr ?y }) THEN ?x < ?y`,
    sql: `${tr('-- 展开为流上的 SQL：每秒对 10 秒窗口求值', '-- unfolded into SQL over the stream, evaluated on a 10 s window every second')}
SELECT w.tag, w.window_end
FROM (
  SELECT o.tag, o.ts, o.value_c,
         o.value_c > LAG(o.value_c) OVER (PARTITION BY o.tag ORDER BY o.ts) AS up,
         MAX(o.ts) OVER (PARTITION BY o.tag) AS window_end
  FROM   obs o                     ${tr('-- hist_b 的 °F 已在映射中换算', '-- °F from hist_b converted in the mapping')}
  WHERE  o.class = 'TemperatureSensor'
    AND  o.ts > NOW() - INTERVAL '10' SECOND
) w
JOIN events.public.alarm_log a
  ON  a.unit = w.unit AND a.component = w.component
  AND a.code IN ('BT_TEMP_HI', 'E2041')      ${tr('-- 两座电厂的代码', '-- codes of both plants')}
  AND a.ts = w.window_end
GROUP BY w.tag, w.window_end
HAVING BOOL_AND(w.up OR w.up IS NULL)`,
  },
  run(ctx) {
    const result = base(this, ctx);
    if (!has(ctx, 'events')) {
      return unavailable(
        result,
        tr(
          '控制系统事件未接入：没有故障标记（showsFault）。',
          'Control system events not connected: no fault flags (showsFault).',
        ),
      );
    }
    if (!has(ctx, 'master')) result.notes.unshift(westNote());
    const faults = tipFaults(ctx);
    for (const f of faults) {
      const rise = f.to - f.from;
      const plantB = turbineById.get(f.turbine)!.plant === 'B';
      const fromHistB = originOf('B', f.event.t, ctx.now, ctx.sources) === 'hist_b';
      if (!f.readable) {
        result.rows.push({
          key: f.sensor.tag,
          title: `${f.turbine} ${tipName(f.sensor)}`,
          detail: tr('该时段信号不可读', 'Signal not readable'),
          hit: false,
          turbine: f.turbine,
        });
        continue;
      }
      result.hits.push(f.turbine);
      result.rows.push({
        key: f.sensor.tag,
        title: tr(
          `${f.turbine} ${tipName(f.sensor)} 10 秒内 ${signed(rise)} °C`,
          `${f.turbine} ${tipName(f.sensor)} ${signed(rise)} °C in 10 s`,
        ),
        detail: formatTime(f.event.t),
        hit: f.rising,
        turbine: f.turbine,
        at: f.event.t + 60,
      });
      if (plantB && fromHistB) {
        result.notes.push(
          tr(
            `${f.turbine} 的读数来自历史库 B，原始值 ${fmt(toFahrenheit(f.from))} → ${fmt(toFahrenheit(f.to))} °F，映射中换算为摄氏度。`,
            `${f.turbine} readings come from Historian B; raw values ${fmt(toFahrenheit(f.from))} → ${fmt(toFahrenheit(f.to))} °F are converted to Celsius in the mapping.`,
          ),
        );
      }
    }
    result.hits = [...new Set(result.hits)];
    result.summary = result.rows.length
      ? count(result.rows.filter((r) => r.hit).length, '次命中', 'match', 'matches')
      : tr('截至此刻无故障标记', 'No fault flags so far');
    result.focus = result.hits[result.hits.length - 1];
    result.expansion = expansionOf(['tip'], 0);
    result.expansion.rules = result.expansion.turbines.reduce((n, t) => n + t.tags.length, 0);
    return result;
  },
  chart(turbine, ctx) {
    const fault = tipFaults(ctx)
      .filter((f) => f.turbine === turbine)
      .pop();
    const tip = tipTrack(turbine, ctx, fault?.sensor.tag);
    const power = powerTrack(turbine, ctx);
    if (!fault) return spec([tip, power], recent(ctx, 900), turbine, ctx);
    tip.marks.push({
      from: fault.event.t - 10,
      to: fault.event.t,
      label: fault.rising
        ? tr('窗口内单调上升', 'Monotonic in window')
        : tr('非单调', 'Not monotonic'),
      tone: fault.rising ? 'hit' : 'miss',
    });
    return spec([tip, power], clampWindow(fault.event.t - 120, fault.event.t + 180), turbine, ctx, {
      hitSensors: [fault.sensor.tag],
    });
  },
});

function tripCases(turbine: TurbineId, ctx: TurbineContext) {
  const model = modelOf(turbine);
  const flames = longer(
    where(flameOf(turbine, ctx), ctx.now, (v) => v > 0.5),
    10,
  );
  const still = longer(
    where(speedOf(turbine, ctx), ctx.now, (v) => v < model.standStillSpeed),
    30,
  );
  const pairs = after(flames, still, 120);
  const lastFlame = flames.filter((f) => !f.open).pop();
  const slow = lastFlame && still.find((s) => s.from > lastFlame.to);
  const burning = flames[flames.length - 1]?.open ?? false;
  return { pairs, lastFlame, slow, burning };
}

const trip = (): TurbineQuery => ({
  id: 'trip',
  group: 'temporal',
  lang: 'sigRL',
  title: tr('点火后 2 分钟内停转的机组', 'Turbines that stop within 2 minutes after ignition'),
  description: tr(
    '参照 sigRL 论文的任务 D4：有火焰 10 秒以上，熄火后 2 分钟内转速降到静止阈值以下并保持 30 秒。正常停机的惰转时间更长，不会命中。',
    'Based on task D4 in the sigRL paper: the flame burns for more than 10 s, and within 2 minutes after it goes out the rotor drops below the standstill threshold and stays there for 30 s. Normal shutdowns coast down for longer and do not match.',
  ),
  sources: [...SIGNALS, 'master'],
  suggest: m(17),
  story: { from: m(12, 30), speed: 30 },
  explain: {
    hard: tr(
      '机组点火后很快停转，通常意味着跳闸。判断时要把火焰信号和转速信号按时间对齐，并与正常停机区分开。',
      'A turbine that stops soon after ignition has usually tripped. Detecting it means aligning the flame and speed signals in time and telling a trip apart from a normal shutdown.',
    ),
    vkg: tr(
      '规则用“火焰持续 10 秒以上，熄灭后 2 分钟内停转”刻画跳闸。正常停机的惰转时间更长，不会被误判。',
      'The rule describes a trip as “flame for more than 10 s, then standstill within 2 minutes after flame out”. Normal shutdowns coast down for longer and are not mistaken for trips.',
    ),
  },
  text: {
    rule: `${tr('# sigRL，参照任务 D4', '# sigRL, based on task D4')}
Fired      = :FlameSensor : duration(>, 10s)
StandStill = avg rotorSensor : value(<, :standStillSpeed)
                             : duration(>, 30s)

message("Stop after ignition") = Fired : after[2m] StandStill`,
    sql: `SELECT f.serial, f.stop AS flame_out, s.start AS standstill
FROM   flame_runs f
JOIN   (SELECT r.serial, r.start, r.stop
        FROM   speed_runs r
        JOIN   master.dbo.parameters p ON p.serial = r.serial
        WHERE  r.max_rpm < p.stand_still_speed
          AND  r.stop - r.start > 30) s
  ON   s.serial = f.serial
 AND   s.start - f.stop BETWEEN 1 AND 120
WHERE  f.stop - f.start > 10`,
  },
  run(ctx) {
    const result = base(this, ctx);
    if (!has(ctx, 'master'))
      return needMaster(result, tr('静止转速阈值', 'the standstill speed threshold'));
    for (const turbine of TURBINES) {
      const { pairs, lastFlame, slow, burning } = tripCases(turbine.id, ctx);
      const pair = pairs[pairs.length - 1];
      if (pair) {
        result.hits.push(turbine.id);
        result.rows.push({
          key: turbine.id,
          title: tr(
            `${turbine.id} 熄火后 ${pair.second.from - pair.first.to} 秒停转`,
            `${turbine.id} stopped ${pair.second.from - pair.first.to} s after flame out`,
          ),
          detail: formatTime(pair.first.to),
          hit: true,
          turbine: turbine.id,
          at: pair.second.from + 40,
        });
      } else if (burning) {
        result.rows.push({
          key: turbine.id,
          title: turbine.id,
          detail: tr('有火焰', 'Flame on'),
          hit: false,
          turbine: turbine.id,
        });
      } else if (lastFlame && slow) {
        result.rows.push({
          key: turbine.id,
          title: tr(
            `${turbine.id} 熄火后 ${formatSpan(slow.from - lastFlame.to)}停转`,
            `${turbine.id} stopped ${formatSpan(slow.from - lastFlame.to)} after flame out`,
          ),
          detail: tr('超过 2 分钟', 'over 2 min'),
          hit: false,
          turbine: turbine.id,
          at: slow.from + 30,
        });
      } else if (lastFlame) {
        result.rows.push({
          key: turbine.id,
          title: turbine.id,
          detail: tr(
            `${formatTime(lastFlame.to)} 熄火，未停转`,
            `flame out ${formatTime(lastFlame.to)}, still turning`,
          ),
          hit: false,
          turbine: turbine.id,
        });
      } else {
        result.rows.push({
          key: turbine.id,
          title: turbine.id,
          detail: readable(turbine.id, ctx)
            ? tr('无熄火', 'No flame out')
            : tr('无信号', 'No signal'),
          hit: false,
          turbine: turbine.id,
        });
      }
    }
    result.rows.sort((a, b) => Number(b.hit) - Number(a.hit));
    result.summary = count(result.hits.length, '台', 'turbine');
    result.focus = result.hits[0];
    result.expansion = expansionOf(['speed', 'flame'], 3);
    return result;
  },
  chart(turbine, ctx) {
    const model = modelOf(turbine);
    const flame = flameTrack(turbine, ctx);
    const speed = speedTrack(turbine, ctx, {
      thresholds: has(ctx, 'master')
        ? [{ value: model.standStillSpeed, label: tr('静止', 'Standstill') }]
        : [],
    });
    if (!has(ctx, 'master')) return spec([flame, speed], recent(ctx, 900), turbine, ctx);
    const { pairs, lastFlame, slow } = tripCases(turbine, ctx);
    const pair = pairs[pairs.length - 1];
    const f = pair?.first ?? lastFlame;
    const s = pair?.second ?? slow;
    if (!f) return spec([flame, speed], recent(ctx, 900), turbine, ctx);
    flame.marks.push({ from: f.from, to: f.to, label: 'duration > 10s', tone: 'info' });
    if (s) {
      speed.marks.push({
        from: s.from,
        to: Math.min(s.to, s.from + 60),
        label: 'StandStill',
        tone: pair ? 'hit' : 'miss',
      });
      speed.links.push({
        from: f.to,
        to: s.from,
        label: `after[2m] · ${formatSpan(s.from - f.to)}`,
        ok: !!pair,
      });
    }
    return spec(
      [flame, speed],
      clampWindow(Math.max(f.from, f.to - 240) - 30, (s?.from ?? f.to) + 120),
      turbine,
      ctx,
    );
  },
});

function rampCases(turbine: TurbineId, ctx: TurbineContext) {
  const model = modelOf(turbine);
  const speeds = sigs(turbine, 'speed', ctx);
  const fast = longer(
    where(max(speeds), ctx.now, (v) => v > model.fastSpeed),
    30,
  );
  const slow = longer(
    where(min(speeds), ctx.now, (v) => v < model.slowSpeed),
    30,
  );
  return { fast, slow, pairs: after(fast, slow, 360) };
}

const rampChange = (): TurbineQuery => ({
  id: 'rampChange',
  group: 'temporal',
  lang: 'sigRL',
  title: tr('高速运行后 6 分钟内降到低速', 'Drop to low speed within 6 minutes after running fast'),
  description: tr(
    'sigRL 论文的任务 D1：最高转速在高速阈值以上持续 30 秒，结束后 6 分钟内最低转速降到低速阈值以下并持续 30 秒。',
    'Task D1 from the sigRL paper: the maximum speed stays above the fast threshold for 30 s, and within 6 minutes after that the minimum speed falls below the slow threshold for 30 s.',
  ),
  sources: [...SIGNALS, 'master'],
  suggest: m(55),
  story: { from: m(49, 30), speed: 60 },
  explain: {
    hard: tr(
      '从额定转速降到低速的快慢反映停机过程是否正常，需要同时看一台机组上全部转速传感器的最大值和最小值。',
      'How fast a turbine drops from rated speed to low speed shows whether a shutdown is normal. It requires the maximum and minimum over all speed sensors of the turbine.',
    ),
    vkg: tr(
      '规则直接对“这台机组的所有转速传感器”取最大值和最小值，不必逐个列出传感器编号。',
      'The rule takes the maximum and minimum over “all speed sensors of this turbine” directly, without listing sensor tags one by one.',
    ),
  },
  text: {
    rule: `${tr('# sigRL（Mehdi 等，ISWC 2017，任务 D1）', '# sigRL (Mehdi et al., ISWC 2017, task D1)')}
FastRotor  = max rotorSensor : value(>, :fastSpeed) : duration(>, 30s)
SlowRotor  = min rotorSensor : value(<, :slowSpeed) : duration(>, 30s)
RampChange = FastRotor : after[6m] SlowRotor

message("Ramp change") = RampChange`,
    sql: `WITH speed AS (
  SELECT serial, ts, MAX(value) AS max_rpm, MIN(value) AS min_rpm
  FROM   obs WHERE class = 'RotorSpeedSensor'
  GROUP  BY serial, ts
)
SELECT f.serial, f.stop AS fast_end, s.start AS slow_start
FROM   runs(speed, 'max_rpm > fast_speed') f
JOIN   runs(speed, 'min_rpm < slow_speed') s
  ON   s.serial = f.serial AND s.start - f.stop BETWEEN 1 AND 360
WHERE  f.stop - f.start > 30 AND s.stop - s.start > 30
${tr('-- runs(…)：连续时段的通用写法，阈值取自 master.dbo.parameters', '-- runs(…): the usual interval pattern; thresholds come from master.dbo.parameters')}`,
  },
  run(ctx) {
    const result = base(this, ctx);
    if (!has(ctx, 'master'))
      return needMaster(result, tr('高速与低速阈值', 'the fast and slow speed thresholds'));
    for (const turbine of TURBINES) {
      const { fast, pairs } = rampCases(turbine.id, ctx);
      const pair = pairs[pairs.length - 1];
      if (pair) {
        result.hits.push(turbine.id);
        result.rows.push({
          key: turbine.id,
          title: tr(
            `${turbine.id} 降速用时 ${formatSpan(pair.second.from - pair.first.to)}`,
            `${turbine.id} slowed down in ${formatSpan(pair.second.from - pair.first.to)}`,
          ),
          detail: formatTime(pair.second.from),
          hit: true,
          turbine: turbine.id,
          at: pair.second.from + 60,
        });
      } else {
        const lastFast = fast[fast.length - 1];
        result.rows.push({
          key: turbine.id,
          title: turbine.id,
          detail: !readable(turbine.id, ctx)
            ? tr('无信号', 'No signal')
            : lastFast?.open
              ? tr('高速运行中', 'Running fast')
              : lastFast
                ? tr(
                    `${formatTime(lastFast.to)} 起降速`,
                    `slowing since ${formatTime(lastFast.to)}`,
                  )
                : tr('未达到高速', 'Not reached fast speed'),
          hit: false,
          turbine: turbine.id,
        });
      }
    }
    result.rows.sort((a, b) => Number(b.hit) - Number(a.hit));
    result.summary = count(result.hits.length, '台', 'turbine');
    result.focus = result.hits[0];
    result.expansion = expansionOf(['speed'], 3);
    return result;
  },
  chart(turbine, ctx) {
    const model = modelOf(turbine);
    const speed = speedTrack(turbine, ctx, {
      thresholds: has(ctx, 'master')
        ? [
            { value: model.fastSpeed, label: tr('高速', 'Fast') },
            { value: model.slowSpeed, label: tr('低速', 'Slow') },
          ]
        : [],
    });
    const power = powerTrack(turbine, ctx);
    if (!has(ctx, 'master')) return spec([speed, power], recent(ctx, 900), turbine, ctx);
    const { fast, pairs } = rampCases(turbine, ctx);
    const pair = pairs[pairs.length - 1];
    const f = pair?.first ?? fast.filter((i) => !i.open).pop();
    if (!f) return spec([speed, power], recent(ctx, 900), turbine, ctx);
    speed.marks.push({
      from: Math.max(f.from, f.to - 120),
      to: f.to,
      label: 'FastRotor',
      tone: 'info',
    });
    if (pair) {
      speed.marks.push({
        from: pair.second.from,
        to: Math.min(pair.second.to, pair.second.from + 60),
        label: 'SlowRotor',
        tone: 'hit',
      });
      speed.links.push({
        from: f.to,
        to: pair.second.from,
        label: `after[6m] · ${formatSpan(pair.second.from - f.to)}`,
        ok: true,
      });
    }
    return spec(
      [speed, power],
      clampWindow(f.to - 300, (pair?.second.from ?? f.to + 360) + 120),
      turbine,
      ctx,
    );
  },
});

interface Stuck {
  sensor: Sensor;
  since: number;
  value: number;
  siblings: number;
}

function stuckSensors(ctx: TurbineContext): Stuck[] {
  const out: Stuck[] = [];
  const from = ctx.now - 300;
  if (from < 0) return out;
  for (const turbine of TURBINES) {
    for (const kind of ['speed', 'tip', 'vibration'] as SensorKind[]) {
      const group = sensorsOf(turbine.id, kind);
      const ranges = group.map((s) => {
        const values = samples(sig(s.tag, ctx), from, ctx.now);
        return values.length > 200 ? Math.max(...values) - Math.min(...values) : NaN;
      });
      group.forEach((sensor, i) => {
        const others = ranges.filter((r, j) => j !== i && !Number.isNaN(r));
        if (Number.isNaN(ranges[i]) || ranges[i] >= 0.05 || median(others) <= 0.2) return;
        const values = sig(sensor.tag, ctx);
        const value = values[ctx.now] ?? NaN;
        let since = ctx.now;
        while (
          since > 0 &&
          !Number.isNaN(values[since - 1]) &&
          Math.abs(values[since - 1] - value) < 0.05
        )
          since--;
        out.push({ sensor, since, value, siblings: others.length });
      });
    }
  }
  return out;
}

const stuckSensor = (): TurbineQuery => ({
  id: 'stuckSensor',
  group: 'temporal',
  lang: 'SPARQL',
  title: tr(
    '读数不变而同组传感器在变化的传感器',
    'Sensors that stay flat while their siblings change',
  ),
  description: tr(
    '最近 5 分钟读数不变，而同一部件上同类传感器的读数在变化。同组关系来自本体中的 :monitors 与传感器类，适用于任意数量的传感器；停机时整组读数都不变，不会误报。',
    'The reading has not changed for 5 minutes while sensors of the same type on the same component keep changing. The sibling relation comes from :monitors and the sensor classes in the ontology and works for any number of sensors; at standstill the whole group is flat, so it is not reported.',
  ),
  sources: [...SIGNALS],
  suggest: m(30),
  story: { from: m(24), speed: 60 },
  explain: {
    hard: tr(
      '传感器卡死后读数不再变化，但机组停机时读数同样不变。判断时要与同一部件上的其他传感器比较，而传感器装在哪个部件上记录在历史库的部件表里。',
      "A stuck sensor stops changing, but so does every sensor on a stopped turbine. The check must compare it with other sensors on the same component, and which component a sensor sits on is recorded in the historians' component tables.",
    ),
    vkg: tr(
      '本体描述了传感器与部件的关系，查询按这种关系找到同组传感器。传感器数量不同的机组也能用同一条查询。',
      'The ontology describes how sensors relate to components, and the query finds sibling sensors through that relation. Turbines with different numbers of sensors share the same query.',
    ),
  },
  text: {
    rule: `SELECT ?sensor ?since WHERE {
  ?sensor a ?cls ; :monitors ?c .
  ?other  a ?cls ; :monitors ?c .
  FILTER (?other != ?sensor)
  ?cls rdfs:subClassOf sosa:Sensor .
  { SELECT ?sensor (MAX(?v) - MIN(?v) AS ?range) WHERE {
      ?o sosa:madeBySensor ?sensor ; sosa:hasSimpleResult ?v ;
         sosa:resultTime ?t .
      FILTER (?t > NOW() - "PT5M"^^xsd:duration) } GROUP BY ?sensor }
  { SELECT ?other (MAX(?w) - MIN(?w) AS ?r2) WHERE { … } GROUP BY ?other }
  FILTER (?range < 0.05 && ?r2 > 0.2)
}`,
    sql: `WITH r AS (
  SELECT o.tag, o.component, o.class,
         MAX(o.value) - MIN(o.value) AS range
  FROM   obs o
  WHERE  o.ts > NOW() - INTERVAL '5' MINUTE
  GROUP  BY o.tag, o.component, o.class
)
SELECT a.tag
FROM   r a
JOIN   r b ON b.component = a.component AND b.class = a.class
          AND b.tag <> a.tag
WHERE  a.range < 0.05
GROUP  BY a.tag
HAVING PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY b.range) > 0.2`,
  },
  run(ctx) {
    const result = base(this, ctx);
    const stuck = stuckSensors(ctx);
    for (const s of stuck) {
      result.hits.push(s.sensor.turbine);
      result.rows.push({
        key: s.sensor.tag,
        title: `${s.sensor.turbine} ${s.sensor.tag}`,
        detail: tr(
          `${formatTime(s.since)} 起恒为 ${fmt(s.value, 1)}`,
          `flat at ${fmt(s.value, 1)} since ${formatTime(s.since)}`,
        ),
        hit: true,
        turbine: s.sensor.turbine,
      });
    }
    const checked = TURBINES.filter((t) => readable(t.id, ctx)).flatMap((t) =>
      ['speed', 'tip', 'vibration'].flatMap((k) => sensorsOf(t.id, k as SensorKind)),
    ).length;
    result.rows.push({
      key: 'rest',
      title: tr('其余传感器', 'Other sensors'),
      detail: tr(`${checked - stuck.length} 个正常`, `${checked - stuck.length} normal`),
      hit: false,
    });
    result.summary = count(stuck.length, '个', 'sensor');
    result.focus = result.hits[0];
    if (ctx.now < 300)
      result.notes.push(tr('需要 5 分钟的数据。', 'Five minutes of data are needed.'));
    return result;
  },
  chart(turbine, ctx) {
    const stuck = stuckSensors(ctx).find((s) => s.sensor.turbine === turbine);
    const kind = stuck?.sensor.kind ?? 'speed';
    const track =
      kind === 'tip'
        ? tipTrack(turbine, ctx, stuck?.sensor.tag)
        : kind === 'vibration'
          ? vibrationTrack(turbine, ctx, stuck?.sensor.tag)
          : speedTrack(turbine, ctx, { sensors: true, hitTag: stuck?.sensor.tag });
    if (stuck) {
      track.marks.push({
        from: stuck.since,
        to: ctx.now,
        label: tr('读数不变', 'Flat reading'),
        tone: 'hit',
      });
    }
    return spec(
      [track, powerTrack(turbine, ctx)],
      stuck ? clampWindow(stuck.since - 300, ctx.now + 30) : recent(ctx, 900),
      turbine,
      ctx,
      {
        hitSensors: stuck ? [stuck.sensor.tag] : [],
      },
    );
  },
});

// ─────────────────────────── 多源融合 ───────────────────────────

const hottestTips = (): TurbineQuery => ({
  id: 'hottestTips',
  group: 'fusion',
  lang: 'SPARQL',
  title: tr(
    '最近 30 分钟温度峰值最高的喷嘴',
    'Burner tips with the highest peak in the last 30 minutes',
  ),
  description: tr(
    '一条查询覆盖两种表结构、两种温度单位与归档、实时两部分数据。历史库 B 以华氏度存储，映射中换算为摄氏度后统一比较。',
    'One query covers two table layouts, two temperature units, and both archived and live data. Historian B stores Fahrenheit; the mapping converts it to Celsius so that all values compare directly.',
  ),
  sources: [...SIGNALS, 'master'],
  suggest: m(45),
  story: { from: m(44), speed: 10 },
  explain: {
    hard: tr(
      '比较所有喷嘴的温度，需要同时查询两种表结构、两种温度单位，并把已入库的历史数据与最近 10 分钟的实时数据拼接起来。',
      'Comparing all burner tips means querying two table layouts and two temperature units at once, and joining archived data with the last 10 minutes of live data.',
    ),
    vkg: tr(
      '映射把三个信号源统一为同一种“观测”，温度统一为摄氏度。一条查询直接给出两座电厂的排名。',
      'The mappings turn the three signal sources into one kind of observation, with temperatures in Celsius. A single query ranks the tips of both plants.',
    ),
  },
  text: {
    rule: `SELECT ?turbine ?tip (MAX(?c) AS ?peak) WHERE {
  ?tip a :BurnerTip ; :partOf/:partOf ?turbine ;
       :monitoredBy ?s .
  ?o sosa:madeBySensor ?s ; sosa:hasSimpleResult ?c ;
     sosa:resultTime ?t .
  FILTER (?t > NOW() - "PT30M"^^xsd:duration)
}
GROUP BY ?turbine ?tip
ORDER BY DESC(?peak)
LIMIT 6`,
    sql: `SELECT tag, MAX(value_c) AS peak
FROM (
  SELECT s.tag, m.ts, m.value AS value_c          ${tr('-- 历史库 A：°C，分表', '-- Historian A: °C, separate tables')}
  FROM   hist_a.public.measurements m
  JOIN   hist_a.public.sensors s ON s.id = m.sensor_id AND s.type_id = 3
  UNION ALL
  SELECT c.sensor_tag, m.time, (m.value - 32) / 1.8  ${tr('-- 历史库 B：°F，合表', '-- Historian B: °F, merged table')}
  FROM   hist_b.public.measurements m
  JOIN   hist_b.public.turbine_components c
         ON c.sensor_id = m.sensor_id AND c.sensor_type = 3
  UNION ALL
  SELECT tag, ts, value FROM live.stream.live_measurements
  WHERE  kind = 'temperature'                     ${tr('-- 实时流：°C', '-- live stream: °C')}
) t
WHERE  ts > NOW() - INTERVAL '30' MINUTE
GROUP  BY tag ORDER BY peak DESC LIMIT 6`,
  },
  run(ctx) {
    const result = base(this, ctx);
    const from = Math.max(0, ctx.now - 1800);
    const peaks: { sensor: Sensor; peak: number; t: number }[] = [];
    for (const turbine of TURBINES) {
      for (const sensor of sensorsOf(turbine.id, 'tip')) {
        const values = sig(sensor.tag, ctx);
        let peak = -Infinity;
        let at = -1;
        for (let t = from; t <= ctx.now; t++) {
          if (!Number.isNaN(values[t]) && values[t] > peak) {
            peak = values[t];
            at = t;
          }
        }
        if (at >= 0) peaks.push({ sensor, peak, t: at });
      }
    }
    peaks.sort((a, b) => b.peak - a.peak);
    let fahrenheit = false;
    for (const p of peaks.slice(0, 6)) {
      const plant = turbineById.get(p.sensor.turbine)!.plant;
      const origin = originOf(plant, p.t, ctx.now, ctx.sources);
      const raw =
        origin === 'hist_b'
          ? tr(`（原始 ${fmt(toFahrenheit(p.peak))} °F）`, ` (raw ${fmt(toFahrenheit(p.peak))} °F)`)
          : '';
      fahrenheit ||= origin === 'hist_b';
      const over = has(ctx, 'master') && p.peak > modelOf(p.sensor.turbine).tipLimit;
      if (over) result.hits.push(p.sensor.turbine);
      result.rows.push({
        key: p.sensor.tag,
        title: `${p.sensor.turbine} ${tipName(p.sensor)} · ${sourceById.get(origin!)!.name}`,
        detail: `${fmt(p.peak)} °C${raw}`,
        hit: over,
        turbine: p.sensor.turbine,
        at: p.t + 60,
      });
    }
    if (fahrenheit) {
      result.notes.push(
        tr(
          '历史库 B 的温度以华氏度存储，映射中换算为摄氏度后与其他数据源比较。',
          'Historian B stores temperatures in Fahrenheit; the mapping converts them to Celsius before comparison.',
        ),
      );
    }
    if (!has(ctx, 'master'))
      result.notes.push(
        tr(
          '设备主数据未接入：无法判断是否超过型号的温度上限。',
          'Equipment master data not connected: the temperature limit of each model is unknown.',
        ),
      );
    result.hits = [...new Set(result.hits)];
    result.summary = tr(
      `${peaks.length} 个喷嘴中前 ${Math.min(6, peaks.length)} 个`,
      `top ${Math.min(6, peaks.length)} of ${peaks.length}`,
    );
    result.focus = peaks[0]?.sensor.turbine;
    return result;
  },
  chart(turbine, ctx) {
    const tags = sensorsOf(turbine, 'tip').map((s) => s.tag);
    const top = tags
      .map((tag) => ({
        tag,
        peak: Math.max(-Infinity, ...samples(sig(tag, ctx), ctx.now - 1800, ctx.now)),
      }))
      .sort((a, b) => b.peak - a.peak)[0];
    return spec(
      [tipTrack(turbine, ctx, top?.tag), powerTrack(turbine, ctx)],
      recent(ctx, 1800),
      turbine,
      ctx,
      {
        hitSensors: top ? [top.tag] : [],
      },
    );
  },
});

interface ExhaustRow {
  turbine: TurbineId;
  raw: number;
  reference: number;
  power: number;
  ambient: number;
}

function exhaustRows(ctx: TurbineContext): ExhaustRow[] {
  const out: ExhaustRow[] = [];
  for (const turbine of TURBINES) {
    const model = MODELS[turbine.model];
    const power = mean(samples(powerOf(turbine.id, ctx), ctx.now - 60, ctx.now));
    const raw = mean(samples(sig(tagsOf(turbine.id, 'exhaust')[0], ctx), ctx.now - 60, ctx.now));
    if (Number.isNaN(power) || power < 5 || Number.isNaN(raw)) continue;
    const ambient = has(ctx, 'weather') ? weatherAt(turbine.plant, ctx.now).temp : 15;
    const reference =
      model.exhaustBase +
      (model.exhaustSlope * power) / model.capacity +
      model.ambientCoef * (ambient - 15);
    out.push({ turbine: turbine.id, raw, reference, power, ambient });
  }
  return out;
}

const exhaust = (): TurbineQuery => ({
  id: 'exhaust',
  group: 'fusion',
  lang: 'SPARQL',
  title: tr(
    '按负荷与环境温度校正后排气温度偏高的机组',
    'Turbines with high exhaust temperature after load and ambient correction',
  ),
  description: tr(
    '排气温度随负荷与环境温度变化。查询把实测值与型号参考曲线（设备主数据）在当地气温（气象观测）下的取值比较，偏差超过 15 °C 时命中。不接入气象观测时，两座电厂的气温差异会被误判为设备偏差。',
    'Exhaust temperature varies with load and ambient temperature. The query compares the measured value with the model reference curve (master data) at the local temperature (weather observations) and reports deviations above 15 °C. Without weather data, the temperature difference between the two plants is mistaken for an equipment deviation.',
  ),
  sources: [...SIGNALS, 'master', 'weather'],
  suggest: m(20),
  story: { from: m(19), speed: 10 },
  explain: {
    hard: tr(
      '排气温度受负荷和天气影响。寒冷的北港电厂与温暖的西岭电厂，原始读数不能直接比较。',
      'Exhaust temperature depends on load and weather. Raw readings from the cold North Harbor plant and the warm Westridge plant cannot be compared directly.',
    ),
    vkg: tr(
      '查询把实测值、设计参考曲线与当地气温放在一起计算偏差。关闭气象观测可以看到，缺少天气信息时结论会出错。',
      'The query computes the deviation from the measured value, the design reference curve and the local air temperature. Switch off the weather source to see the conclusion go wrong.',
    ),
  },
  text: {
    rule: `SELECT ?turbine ?raw ?ref (?raw - ?ref AS ?dev) WHERE {
  ?turbine a :GasTurbine ; :model ?m ; :locatedAt ?plant .
  ?m :exhaustBase ?b ; :exhaustSlope ?k ; :ambientCoef ?a ;
     :ratedPower ?cap .
  ?turbine :exhaustTemperature ?raw ; :activePower ?p .   ${tr('# 最近 1 分钟均值', '# 1-minute means')}
  ?w a :WeatherObservation ; :site ?plant ; :airTemperature ?amb .
  BIND (?b + ?k * ?p / ?cap + ?a * (?amb - 15) AS ?ref)
  FILTER (ABS(?raw - ?ref) > 15)
}`,
    sql: `SELECT t.serial, e.raw,
       mo.exhaust_base + mo.exhaust_slope * p.mw / mo.rated_mw
         + mo.ambient_coef * (w.air_temp - 15) AS ref
FROM   master.dbo.turbines t
JOIN   master.dbo.models   mo ON mo.id = t.model
JOIN   (SELECT serial, AVG(value) AS raw FROM obs
        WHERE class = 'ExhaustTemperature' AND ts > NOW() - INTERVAL '1' MINUTE
        GROUP BY serial) e ON e.serial = t.serial
JOIN   (SELECT serial, AVG(value) AS mw FROM obs
        WHERE class = 'PowerMeter' AND ts > NOW() - INTERVAL '1' MINUTE
        GROUP BY serial) p ON p.serial = t.serial
JOIN   weather.default.observations w
       ON w.site = t.plant AND w.ts = (SELECT MAX(ts) FROM weather.default.observations
                                       WHERE site = t.plant)`,
  },
  run(ctx) {
    const result = base(this, ctx);
    if (!has(ctx, 'master'))
      return needMaster(
        result,
        tr('型号与排气温度参考曲线', 'models and exhaust reference curves'),
      );
    if (!has(ctx, 'weather')) {
      result.notes.unshift(
        tr(
          '气象观测未接入：按 15 °C 计算参考值，北港电厂（约 4 °C）的机组显得偏低，西岭电厂偏高。',
          'Weather observations not connected: the reference assumes 15 °C, so North Harbor turbines (about 4 °C) look low and Westridge turbines look high.',
        ),
      );
    }
    const rows = exhaustRows(ctx);
    for (const r of rows) {
      const dev = r.raw - r.reference;
      const hit = Math.abs(dev) > 15;
      if (hit) result.hits.push(r.turbine);
      result.rows.push({
        key: r.turbine,
        title: tr(
          `${r.turbine} ${fmt(r.raw)} °C（参考 ${fmt(r.reference)}）`,
          `${r.turbine} ${fmt(r.raw)} °C (ref. ${fmt(r.reference)})`,
        ),
        detail: `${signed(dev)} °C`,
        hit,
        turbine: r.turbine,
      });
    }
    if (has(ctx, 'weather')) {
      result.notes.push(
        tr(
          `环境温度：北港电厂 ${fmt(weatherAt('A', ctx.now).temp, 1)} °C，西岭电厂 ${fmt(weatherAt('B', ctx.now).temp, 1)} °C。`,
          `Ambient: North Harbor ${fmt(weatherAt('A', ctx.now).temp, 1)} °C, Westridge ${fmt(weatherAt('B', ctx.now).temp, 1)} °C.`,
        ),
      );
    }
    result.rows.sort((a, b) => Number(b.hit) - Number(a.hit));
    result.summary = rows.length
      ? tr(
          `${rows.length} 台带负荷，${result.hits.length} 台偏差超限`,
          `${rows.length} loaded, ${result.hits.length} out of range`,
        )
      : tr('无带负荷机组', 'No loaded turbines');
    result.focus = result.hits[0] ?? rows[0]?.turbine;
    return result;
  },
  chart(turbine, ctx) {
    return spec(
      [exhaustTrack(turbine, ctx), powerTrack(turbine, ctx)],
      recent(ctx, 1200),
      turbine,
      ctx,
    );
  },
});

const faultHistory = (): TurbineQuery => ({
  id: 'faultHistory',
  group: 'fusion',
  lang: 'SPARQL',
  title: tr('报故障部件的检修记录', 'Maintenance history of faulted components'),
  description: tr(
    '控制系统以机组代号登记事件，维修系统以设备号登记工单，两者经设备主数据中的对照表映射到同一个机组 IRI。结果给出故障部件的零件批次与上次检查距今的时间。',
    'The control system registers events by unit code and the maintenance system registers work orders by equipment number; both map to the same turbine IRI through the cross-reference in the master data. The result shows the part batch of each faulted component and the time since its last inspection.',
  ),
  sources: ['events', 'cmms', 'master'],
  suggest: m(42, 30),
  story: { from: m(40, 50), speed: 10 },
  explain: {
    hard: tr(
      '报警系统用机组代号（如 NH-GT3、11MBA）登记，维修系统用设备号（如 10004713）登记，两边的记录对不上。',
      'The alarm system registers turbines by unit code (such as NH-GT3 or 11MBA) and the maintenance system by equipment number (such as 10004713), so the records do not match up.',
    ),
    vkg: tr(
      '设备主数据中的对照表在映射里把三种编号连到同一台机组，查询可以从报警直接查到检修记录。',
      'The cross-reference in the master data links the three numbering schemes to one turbine in the mappings, so the query goes straight from an alarm to its maintenance history.',
    ),
  },
  text: {
    rule: `SELECT ?turbine ?tip ?ts ?batch ?lastService WHERE {
  ?e a :BurnerTipOvertemperature ; :component ?tip ;
     :time ?ts .
  ?tip :partOf/:partOf ?turbine .
  ?tip :installedPart [ :batch ?batch ] .
  ?turbine :lastBurnerService ?lastService .
}`,
    sql: `SELECT t.serial, a.component, a.ts, ip.batch, MAX(wo.done_on) AS last_service
FROM   events.public.alarm_log a
JOIN   master.dbo.id_map t ON t.dcs_code = a.unit         ${tr('-- NH-GT3 / 11MBA', '-- NH-GT3 / 11MBA')}
JOIN   cmms.pm.installed_parts ip
       ON ip.equipment_no = t.equipment_no AND ip.position = a.component
JOIN   cmms.pm.work_orders wo
       ON wo.equipment_no = t.equipment_no AND wo.object IN ('MBM10', 'MBM1*')
WHERE  a.code IN ('BT_TEMP_HI', 'E2041')
GROUP  BY t.serial, a.component, a.ts, ip.batch`,
  },
  run(ctx) {
    const result = base(this, ctx);
    if (!has(ctx, 'events'))
      return unavailable(
        result,
        tr('控制系统事件未接入：没有故障记录。', 'Control system events not connected: no faults.'),
      );
    if (!has(ctx, 'master')) {
      return unavailable(
        result,
        tr(
          '设备主数据未接入：控制系统代号与维修设备号无法对应。',
          'Equipment master data not connected: control system codes cannot be matched with equipment numbers.',
        ),
      );
    }
    const faults = eventsUntil(ctx.now).filter((e) => e.type === 'fault');
    for (const f of faults) {
      const turbine = turbineById.get(f.turbine)!;
      const tip = `BT${f.component!.slice(4)}`;
      if (!has(ctx, 'cmms')) {
        result.rows.push({
          key: f.turbine,
          title: `${f.turbine} ${tip}`,
          detail: formatTime(f.t),
          hit: false,
          turbine: f.turbine,
          at: f.t + 60,
        });
        continue;
      }
      const service = lastBurnerService(f.turbine);
      const days = daysBetween(service.date);
      const overdue = days > INSPECTION_MONTHS * 30.4;
      const batch = batchOf(f.turbine, f.component!);
      if (overdue) result.hits.push(f.turbine);
      result.rows.push({
        key: `${f.turbine}-${f.t}`,
        title: tr(
          `${f.turbine} ${tip}：批次 ${batch?.batch ?? '—'}，上次检修 ${service.date}`,
          `${f.turbine} ${tip}: batch ${batch?.batch ?? '—'}, last service ${service.date}`,
        ),
        detail: overdue
          ? tr(
              `超期 ${days - Math.round(INSPECTION_MONTHS * 30.4)} 天`,
              `${days - Math.round(INSPECTION_MONTHS * 30.4)} days overdue`,
            )
          : tr(`${days} 天前`, `${days} days ago`),
        hit: overdue,
        turbine: f.turbine,
        at: f.t + 60,
      });
      void turbine;
    }
    if (!has(ctx, 'cmms'))
      result.notes.unshift(
        tr(
          '维修管理未接入：只有故障时间，没有检修记录。',
          'Maintenance management not connected: fault times only, no maintenance records.',
        ),
      );
    if (faults.length) {
      result.notes.push(
        tr(
          `燃烧器检查周期为 ${INSPECTION_MONTHS} 个月。`,
          `Burner inspection interval: ${INSPECTION_MONTHS} months.`,
        ),
      );
    }
    result.summary = faults.length
      ? count(faults.length, '个故障部件', 'faulted component')
      : tr('截至此刻无故障', 'No faults so far');
    result.focus = faults[faults.length - 1]?.turbine;
    return result;
  },
  chart(turbine, ctx) {
    const fault = eventsUntil(ctx.now)
      .filter((e) => e.type === 'fault' && e.turbine === turbine)
      .pop();
    const tag =
      fault &&
      sensorsOf(turbine, 'tip').find(
        (s) => componentById.get(s.component)!.code === fault.component,
      )?.tag;
    const tip = tipTrack(turbine, ctx, tag);
    if (fault)
      tip.marks.push({ from: fault.t - 10, to: fault.t, label: eventLabel('fault'), tone: 'hit' });
    return spec(
      [tip, powerTrack(turbine, ctx)],
      fault ? clampWindow(fault.t - 300, fault.t + 300) : recent(ctx, 900),
      turbine,
      ctx,
      {
        hitSensors: tag ? [tag] : [],
      },
    );
  },
});

function batchRisks(ctx: TurbineContext) {
  const faults = eventsUntil(ctx.now).filter((e) => e.type === 'fault');
  const out: { fault: ControlEvent; batch: string; turbine: TurbineId; tips: Sensor[] }[] = [];
  for (const f of faults) {
    const batch = batchOf(f.turbine, f.component!)?.batch;
    if (!batch) continue;
    for (const turbine of TURBINES) {
      const tips = sensorsOf(turbine.id, 'tip').filter((s) => {
        const code = componentById.get(s.component)!.code;
        return (
          batchOf(turbine.id, code)?.batch === batch &&
          !(turbine.id === f.turbine && code === f.component)
        );
      });
      if (tips.length) out.push({ fault: f, batch, turbine: turbine.id, tips });
    }
  }
  return out;
}

const batchRisk = (): TurbineQuery => ({
  id: 'batchRisk',
  group: 'fusion',
  lang: 'SPARQL',
  title: tr('与故障喷嘴同批次的其他喷嘴', 'Other burner tips from the same batch as a faulted tip'),
  description: tr(
    '从一座电厂的故障出发，经维修系统中的零件批次，找到另一座电厂同批次的零件，并附上它们此刻的温度。三个数据源在映射后共用机组与部件 IRI。',
    'Starting from a fault at one plant, the query follows the part batch in the maintenance system to parts of the same batch at the other plant, together with their current temperature. After mapping, the three sources share turbine and component IRIs.',
  ),
  sources: ['events', 'cmms', 'master', ...SIGNALS],
  suggest: m(24),
  story: { from: m(23), speed: 10 },
  explain: {
    hard: tr(
      '一个零件出了问题，同一批次的零件可能也有隐患，但它们装在另一座电厂，记录在另一套系统里。',
      'When one part fails, parts from the same batch may carry the same risk, but they are installed at another plant and recorded in other systems.',
    ),
    vkg: tr(
      '查询沿着“报警 → 零件批次 → 同批次零件 → 所在机组 → 此刻温度”一路查下去，跨越三个系统和两座电厂。',
      'The query follows alarm → part batch → parts of the same batch → their turbines → current temperature, across three systems and two plants.',
    ),
  },
  text: {
    rule: `SELECT ?other ?turbine ?batch (MAX(?c) AS ?now) WHERE {
  ?e a :BurnerTipOvertemperature ; :component ?tip .
  ?tip   :installedPart [ :batch ?batch ] .
  ?other :installedPart [ :batch ?batch ] ;
         :partOf/:partOf ?turbine ; :monitoredBy ?s .
  FILTER (?other != ?tip)
  ?o sosa:madeBySensor ?s ; sosa:hasSimpleResult ?c ;
     sosa:resultTime ?t .
  FILTER (?t > NOW() - "PT1M"^^xsd:duration)
}
GROUP BY ?other ?turbine ?batch`,
    sql: `SELECT o.equipment_no, o.position, o.batch, MAX(m.value_c) AS now_c
FROM   events.public.alarm_log a
JOIN   master.dbo.id_map t   ON t.dcs_code = a.unit
JOIN   cmms.pm.installed_parts f
       ON f.equipment_no = t.equipment_no AND f.position = a.component
JOIN   cmms.pm.installed_parts o
       ON o.batch = f.batch AND NOT (o.equipment_no = f.equipment_no
                                     AND o.position = f.position)
JOIN   master.dbo.id_map t2  ON t2.equipment_no = o.equipment_no
JOIN   obs m ON m.serial = t2.serial AND m.component = o.position
WHERE  a.code IN ('BT_TEMP_HI', 'E2041')
  AND  m.ts > NOW() - INTERVAL '1' MINUTE
GROUP  BY o.equipment_no, o.position, o.batch`,
  },
  run(ctx) {
    const result = base(this, ctx);
    if (!has(ctx, 'events'))
      return unavailable(
        result,
        tr('控制系统事件未接入：没有故障记录。', 'Control system events not connected: no faults.'),
      );
    if (!has(ctx, 'cmms'))
      return unavailable(
        result,
        tr(
          '维修管理未接入：没有零件批次。',
          'Maintenance management not connected: no part batches.',
        ),
      );
    if (!has(ctx, 'master'))
      return needMaster(
        result,
        tr('机组代号与设备号的对照', 'the cross-reference of unit codes and equipment numbers'),
      );
    for (const risk of batchRisks(ctx)) {
      const temps = risk.tips
        .map((s) => latest(sig(s.tag, ctx), ctx.now)?.value ?? NaN)
        .filter((v) => !Number.isNaN(v));
      const same = risk.turbine === risk.fault.turbine;
      result.hits.push(risk.turbine);
      result.rows.push({
        key: `${risk.fault.turbine}-${risk.turbine}`,
        title: tr(
          `${risk.turbine}${same ? ' 其余' : ''} ${risk.tips.length} 个喷嘴 · 批次 ${risk.batch}`,
          `${risk.turbine}: ${risk.tips.length} ${same ? 'other ' : ''}tips · batch ${risk.batch}`,
        ),
        detail: temps.length
          ? tr(`此刻最高 ${fmt(Math.max(...temps))} °C`, `now max ${fmt(Math.max(...temps))} °C`)
          : tr('无信号', 'No signal'),
        hit: true,
        turbine: risk.turbine,
      });
    }
    const faults = eventsUntil(ctx.now).filter((e) => e.type === 'fault');
    for (const f of faults) {
      result.notes.push(
        tr(
          `${f.turbine} BT${f.component!.slice(4)} 于 ${formatTime(f.t)} 报故障，批次 ${batchOf(f.turbine, f.component!)?.batch}。`,
          `${f.turbine} BT${f.component!.slice(4)} faulted at ${formatTime(f.t)}, batch ${batchOf(f.turbine, f.component!)?.batch}.`,
        ),
      );
    }
    result.hits = [...new Set(result.hits)];
    result.summary = faults.length
      ? count(result.hits.length, '台机组', 'turbine')
      : tr('截至此刻无故障', 'No faults so far');
    result.focus =
      result.rows.find((r) => r.turbine && !faults.some((f) => f.turbine === r.turbine))?.turbine ??
      result.hits[0];
    return result;
  },
  chart(turbine, ctx) {
    const risk =
      has(ctx, 'cmms') && has(ctx, 'events')
        ? batchRisks(ctx).filter((r) => r.turbine === turbine)
        : [];
    const tags = risk.flatMap((r) => r.tips.map((s) => s.tag));
    const tip = tipTrack(turbine, ctx);
    for (const s of tip.series) if (s.tags?.some((tag) => tags.includes(tag))) s.tone = 'hit';
    return spec([tip, powerTrack(turbine, ctx)], recent(ctx, 1200), turbine, ctx, {
      hitSensors: tags,
    });
  },
});

function vibrationRows(ctx: TurbineContext) {
  const recentOrders = WORK_ORDERS.filter(
    (o) => o.component.startsWith('MBD') && daysBetween(o.date) <= 7,
  );
  const running = (id: TurbineId) => {
    const sp = samples(speedOf(id, ctx), ctx.now - 600, ctx.now);
    return sp.length > 300 && Math.min(...sp) > 2900;
  };
  const levels = new Map<string, number>();
  for (const turbine of TURBINES) {
    if (!running(turbine.id)) continue;
    for (const s of sensorsOf(turbine.id, 'vibration')) {
      levels.set(s.tag, mean(samples(sig(s.tag, ctx), ctx.now - 600, ctx.now)));
    }
  }
  return recentOrders.map((order) => {
    const index = Number(order.component[3]);
    const sensor = sensorsOf(order.turbine, 'vibration').find((s) => s.index === index)!;
    const model = turbineById.get(order.turbine)!.model;
    const peers = TURBINES.filter((t) => t.model === model && t.id !== order.turbine)
      .map((t) => levels.get(sensorsOf(t.id, 'vibration').find((s) => s.index === index)!.tag))
      .filter((v): v is number => v !== undefined);
    return {
      order,
      sensor,
      level: levels.get(sensor.tag),
      peers: median(peers),
      count: peers.length,
    };
  });
}

const vibration = (): TurbineQuery => ({
  id: 'vibration',
  group: 'fusion',
  lang: 'SPARQL',
  title: tr(
    '近 7 天检修过、振动高于同型号机组的轴承',
    'Bearings serviced in the last 7 days that vibrate more than on peer turbines',
  ),
  description: tr(
    '维修系统给出近 7 天检修过的轴承，设备主数据给出同型号机组，信号给出最近 10 分钟的振动均值。比较对象只取额定转速运行的机组。',
    'The maintenance system lists bearings serviced in the last 7 days, the master data gives turbines of the same model, and the signals give the 10-minute mean vibration. Only turbines running at rated speed are compared.',
  ),
  sources: ['cmms', 'master', ...SIGNALS],
  suggest: m(30),
  story: { from: m(29), speed: 10 },
  explain: {
    hard: tr(
      '检修后振动偏高，可能是安装出了问题。需要先从维修系统找出近期检修过的轴承，再与同型号机组的振动比较。',
      'Higher vibration after maintenance may point to an installation problem. It requires finding recently serviced bearings in the maintenance system and comparing them with turbines of the same model.',
    ),
    vkg: tr(
      '查询结合维修记录、型号信息与实时振动，自动选出同型号的比较对象。',
      'The query combines maintenance records, model information and live vibration, and picks the peer turbines automatically.',
    ),
  },
  text: {
    rule: `SELECT ?bearing ?v (MEDIAN(?peer) AS ?fleet) WHERE {
  ?wo a :WorkOrder ; :object ?bearing ; :doneOn ?d .
  FILTER (?d > NOW() - "P7D"^^xsd:duration)
  ?bearing a :Bearing ; :position ?pos ; :partOf ?turbine .
  ?turbine :model ?m ; :vibration10min [ :bearing ?bearing ; :mean ?v ] .
  ?peerT :model ?m ; :vibration10min [ :position ?pos ; :mean ?peer ] .
  FILTER (?peerT != ?turbine)
}
GROUP BY ?bearing ?v
HAVING (?v > 1.5 * MEDIAN(?peer))`,
    sql: `WITH v AS (
  SELECT serial, component, AVG(value) AS mean_mm_s
  FROM   obs
  WHERE  class = 'VibrationSensor' AND ts > NOW() - INTERVAL '10' MINUTE
  GROUP  BY serial, component
)
SELECT wo.equipment_no, wo.object, v.mean_mm_s,
       PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY p.mean_mm_s) AS fleet
FROM   cmms.pm.work_orders wo
JOIN   master.dbo.id_map  t  ON t.equipment_no = wo.equipment_no
JOIN   master.dbo.turbines tt ON tt.serial = t.serial
JOIN   v ON v.serial = t.serial AND v.component = wo.object
JOIN   master.dbo.turbines pt ON pt.model = tt.model AND pt.serial <> tt.serial
JOIN   v p ON p.serial = pt.serial AND p.component = wo.object
WHERE  wo.done_on > CURRENT_DATE - 7
GROUP  BY wo.equipment_no, wo.object, v.mean_mm_s`,
  },
  run(ctx) {
    const result = base(this, ctx);
    if (!has(ctx, 'cmms'))
      return unavailable(
        result,
        tr(
          '维修管理未接入：不知道哪些轴承近期检修过。',
          'Maintenance management not connected: recently serviced bearings are unknown.',
        ),
      );
    if (!has(ctx, 'master'))
      return needMaster(
        result,
        tr('型号信息，无法确定比较对象', 'model information, so peer turbines are unknown'),
      );
    for (const r of vibrationRows(ctx)) {
      const label = tr(
        `${r.order.turbine} ${r.order.component[3]} 号轴承，${r.order.date} 更换`,
        `${r.order.turbine} bearing ${r.order.component[3]}, replaced ${r.order.date}`,
      );
      if (r.level === undefined || Number.isNaN(r.peers)) {
        result.rows.push({
          key: r.sensor.tag,
          title: label,
          detail:
            r.level === undefined
              ? tr('未在额定转速运行', 'Not at rated speed')
              : tr('无同型号运行机组', 'No running peers'),
          hit: false,
          turbine: r.order.turbine,
        });
        continue;
      }
      const ratio = r.level / r.peers;
      const hit = ratio > 1.5;
      if (hit) result.hits.push(r.order.turbine);
      result.rows.push({
        key: r.sensor.tag,
        title: label,
        detail: tr(
          `${fmt(r.level, 1)} mm/s，同型号 ${fmt(r.peers, 1)}（${fmt(ratio, 1)} 倍）`,
          `${fmt(r.level, 1)} mm/s vs ${fmt(r.peers, 1)} (${fmt(ratio, 1)}×)`,
        ),
        hit,
        turbine: r.order.turbine,
      });
    }
    result.summary = count(result.hits.length, '个轴承', 'bearing');
    result.focus = result.rows[0]?.turbine;
    return result;
  },
  chart(turbine, ctx) {
    const rows = has(ctx, 'cmms')
      ? vibrationRows(ctx).filter((r) => r.order.turbine === turbine)
      : [];
    const tag = rows[0]?.sensor.tag;
    const track = vibrationTrack(turbine, ctx, tag);
    const peers = rows[0]?.peers;
    if (peers !== undefined && !Number.isNaN(peers)) {
      track.thresholds.push({ value: peers * 1.5, label: tr('同型号 ×1.5', 'Peers ×1.5') });
    }
    return spec([track, speedTrack(turbine, ctx)], recent(ctx, 1200), turbine, ctx, {
      hitSensors: tag ? [tag] : [],
    });
  },
});

// ─────────────────────────── 实时监测 ───────────────────────────

export type StateId =
  'stopped' | 'cranking' | 'purging' | 'firing' | 'idle' | 'loaded' | 'coasting' | 'unknown';

export const stateLabel = (state: StateId) =>
  ({
    stopped: tr('停机', 'Stopped'),
    cranking: tr('盘车升速', 'Cranking'),
    purging: tr('清吹', 'Purging'),
    firing: tr('点火升速', 'Firing'),
    idle: tr('额定转速空载', 'Full speed, no load'),
    loaded: tr('并网带负荷', 'On load'),
    coasting: tr('惰转降速', 'Coasting down'),
    unknown: tr('无数据', 'No data'),
  })[state];

/** 由转速、火焰与出力推断的运行状态。 */
export function stateOf(turbine: TurbineId, ctx: TurbineContext) {
  const model = has(ctx, 'master') ? modelOf(turbine) : MODELS['GT-B'];
  const speed = speedOf(turbine, ctx);
  const last = latest(speed, ctx.now);
  if (!last) return { state: 'unknown' as StateId, t: ctx.now, speed: NaN, power: NaN };
  const t = last.t;
  const power = powerOf(turbine, ctx)[t];
  const flame = flameOf(turbine, ctx)[t] > 0.5;
  const before = speed[Math.max(0, t - 10)];
  let state: StateId;
  if (power >= 1) state = 'loaded';
  else if (flame) state = last.value >= 2950 ? 'idle' : 'firing';
  else if (last.value < model.standStillSpeed) state = 'stopped';
  else if (!Number.isNaN(before) && last.value - before < -5) state = 'coasting';
  else if (last.value >= 2000) state = 'coasting';
  else if (last.value >= model.purgingSpeed) state = 'purging';
  else state = 'cranking';
  return { state, t, speed: last.value, power };
}

const state = (): TurbineQuery => ({
  id: 'state',
  group: 'live',
  lang: 'SPARQL',
  title: tr('各机组此刻的运行状态', 'Current operating state of each turbine'),
  description: tr(
    '由最近的转速、火焰与出力推断状态，判断清吹与静止所用的阈值随型号不同。关闭实时流时，状态只能截至最近一次入库，滞后最多 10 分钟。',
    'The state is inferred from the latest speed, flame and output; the purging and standstill thresholds depend on the model. With the live stream off, the state is only known up to the last batch load, up to 10 minutes late.',
  ),
  sources: ['live', 'master'],
  suggest: m(14),
  story: { from: m(10), speed: 30 },
  explain: {
    hard: tr(
      '机组状态要由转速、火焰和出力综合判断，而且必须用最新的数据。只看每 10 分钟入库一次的历史库，状态会滞后。',
      "A turbine's state is judged from speed, flame and output together, and it needs the latest data. A historian loaded every 10 minutes is always behind.",
    ),
    vkg: tr(
      '查询同时读取历史库与实时流，状态随新数据到达而更新。关闭实时流可以看到，状态停在最近一次入库的时刻。',
      'The query reads the historians and the live stream together, so the state updates as data arrives. Switch off the live stream and the state freezes at the last batch load.',
    ),
  },
  text: {
    rule: `SELECT ?turbine ?state WHERE {
  ?turbine a :GasTurbine ; :model ?m .
  ?m :purgingSpeed ?ps ; :standStillSpeed ?ss .
  ?turbine :latest [ :rpm ?rpm ; :rpm10sAgo ?rpm0 ;
                     :flame ?flame ; :mw ?mw ] .
  BIND (IF(?mw >= 1, :OnLoad,
        IF(?flame, IF(?rpm >= 2950, :FullSpeedNoLoad, :Firing),
        IF(?rpm < ?ss, :Stopped,
        IF(?rpm - ?rpm0 < -5, :CoastingDown,
        IF(?rpm >= ?ps, :Purging, :Cranking))))) AS ?state)
}`,
    sql: `SELECT t.serial, l.rpm, l.flame, l.mw,
       CASE WHEN l.mw >= 1 THEN 'OnLoad'
            WHEN l.flame = 1 AND l.rpm >= 2950 THEN 'FullSpeedNoLoad'
            WHEN l.flame = 1 THEN 'Firing'
            WHEN l.rpm < p.stand_still_speed THEN 'Stopped'
            WHEN l.rpm - l.rpm_10s < -5 THEN 'CoastingDown'
            WHEN l.rpm >= p.purging_speed THEN 'Purging'
            ELSE 'Cranking' END AS state
FROM   master.dbo.turbines t
JOIN   master.dbo.parameters p ON p.serial = t.serial
JOIN   LATERAL (SELECT … FROM live.stream.live_measurements
                WHERE serial = t.serial
                ORDER BY ts DESC LIMIT 1) l ON TRUE`,
  },
  run(ctx) {
    const result = base(this, ctx);
    if (!has(ctx, 'master')) {
      result.notes.unshift(
        tr(
          '设备主数据未接入：按通用阈值判断清吹与静止，GT-A 型的清吹会被误判。',
          'Equipment master data not connected: generic thresholds are used for purging and standstill, which misjudges purging on GT-A turbines.',
        ),
      );
    }
    let lag = 0;
    for (const turbine of TURBINES) {
      const s = stateOf(turbine.id, ctx);
      lag = Math.max(lag, ctx.now - s.t);
      const transient = !['stopped', 'loaded', 'unknown'].includes(s.state);
      if (transient) result.hits.push(turbine.id);
      result.rows.push({
        key: turbine.id,
        title: `${turbine.id} ${stateLabel(s.state)}`,
        detail:
          s.state === 'unknown'
            ? '—'
            : s.state === 'loaded'
              ? `${fmt(s.power, 1)} MW`
              : `${fmt(s.speed)} rpm`,
        hit: transient,
        turbine: turbine.id,
      });
    }
    if (lag > 5) {
      result.notes.unshift(
        tr(
          `状态截至 ${formatTime(ctx.now - lag)}，滞后 ${formatSpan(lag)}。`,
          `State as of ${formatTime(ctx.now - lag)}, ${formatSpan(lag)} late.`,
        ),
      );
    }
    result.summary = tr(
      `${result.hits.length} 台处于启停过程`,
      `${result.hits.length} starting or stopping`,
    );
    result.focus = result.hits[0];
    return result;
  },
  chart(turbine, ctx) {
    return spec(
      [flameTrack(turbine, ctx), speedTrack(turbine, ctx), powerTrack(turbine, ctx)],
      recent(ctx, 900),
      turbine,
      ctx,
    );
  },
});

function deviation(turbine: TurbineId, ctx: TurbineContext) {
  const model = modelOf(turbine);
  const power = powerOf(turbine, ctx);
  const from = Math.max(0, ctx.now - 300);
  let all = true;
  let count = 0;
  let start = -1;
  for (let t = from; t <= ctx.now; t++) {
    if (Number.isNaN(power[t])) continue;
    count++;
    if (Math.abs(power[t] - plannedPower(turbine, t)) <= 0.1 * model.capacity) all = false;
  }
  if (all && count > 200) {
    start = ctx.now;
    while (
      start > 0 &&
      !Number.isNaN(power[start - 1]) &&
      Math.abs(power[start - 1] - plannedPower(turbine, start - 1)) > 0.1 * model.capacity
    )
      start--;
  }
  const last = latest(power, ctx.now);
  return {
    hit: all && count > 200,
    start,
    actual: last?.value ?? NaN,
    plan: plannedPower(turbine, last?.t ?? ctx.now),
    count,
  };
}

const dispatch = (): TurbineQuery => ({
  id: 'dispatch',
  group: 'live',
  lang: 'SPARQL',
  title: tr(
    '偏离调度计划超过 5 分钟的机组',
    'Turbines off the dispatch plan for more than 5 minutes',
  ),
  description: tr(
    '实际出力与调度计划之差连续 5 分钟超过额定出力的 10%。调度系统以序列号登记机组，信号以传感器编号登记，经映射对齐到同一机组。',
    'The gap between actual output and the dispatch plan exceeds 10% of rated output for 5 consecutive minutes. The dispatch system identifies turbines by serial number and the signals by sensor tag; the mappings align both to the same turbine.',
  ),
  sources: ['live', 'hist_a', 'hist_b', 'dispatch', 'master'],
  suggest: m(50),
  story: { from: m(44), speed: 60 },
  explain: {
    hard: tr(
      '调度计划由电网下发，以序列号标识机组；实际出力来自传感器。两者编号不同，更新频率也不同。',
      'The dispatch plan comes from the grid operator and identifies turbines by serial number; actual output comes from sensors. The two use different identifiers and update at different rates.',
    ),
    vkg: tr(
      '映射把计划与实测对齐到同一台机组、同一条时间轴上，查询持续比较两者。',
      'The mappings align plan and measurement to the same turbine and the same timeline, and the query compares them continuously.',
    ),
  },
  text: {
    rule: `SELECT ?turbine (MIN(?gap) AS ?minGap) WHERE {
  ?turbine :ratedPower ?cap ; :powerMeter ?pm .
  ?o sosa:madeBySensor ?pm ; sosa:hasSimpleResult ?mw ;
     sosa:resultTime ?t .
  ?plan a :DispatchPlan ; :unit ?turbine ; :at ?t ; :mw ?target .
  FILTER (?t > NOW() - "PT5M"^^xsd:duration)
  BIND (ABS(?mw - ?target) AS ?gap)
}
GROUP BY ?turbine ?cap
HAVING (MIN(?gap) > 0.1 * ?cap)`,
    sql: `SELECT t.serial, MIN(ABS(o.value - s.mw)) AS min_gap
FROM   obs o
JOIN   master.dbo.turbines t ON t.serial = o.serial
JOIN   dispatch.default.unit_schedule s
       ON s.serial = o.serial
      AND o.ts >= s.valid_from AND o.ts < s.valid_to   ${tr('-- 计划按 15 分钟段下达', '-- plan issued in 15-minute blocks')}
WHERE  o.class = 'PowerMeter'
  AND  o.ts > NOW() - INTERVAL '5' MINUTE
GROUP  BY t.serial, t.rated_mw
HAVING MIN(ABS(o.value - s.mw)) > 0.1 * t.rated_mw`,
  },
  run(ctx) {
    const result = base(this, ctx);
    if (!has(ctx, 'dispatch'))
      return unavailable(
        result,
        tr('调度计划未接入：没有计划出力。', 'Dispatch schedule not connected: no planned output.'),
      );
    if (!has(ctx, 'master'))
      return needMaster(
        result,
        tr('额定出力与序列号对照', 'rated output and the serial number cross-reference'),
      );
    for (const turbine of TURBINES) {
      const d = deviation(turbine.id, ctx);
      if (d.count < 200) {
        result.rows.push({
          key: turbine.id,
          title: turbine.id,
          detail: tr('最近 5 分钟数据不足', 'Not enough data in 5 min'),
          hit: false,
          turbine: turbine.id,
        });
        continue;
      }
      if (d.hit) result.hits.push(turbine.id);
      result.rows.push({
        key: turbine.id,
        title: tr(
          `${turbine.id} ${fmt(d.actual, 1)} MW（计划 ${fmt(d.plan, 1)}）`,
          `${turbine.id} ${fmt(d.actual, 1)} MW (plan ${fmt(d.plan, 1)})`,
        ),
        detail: d.hit
          ? tr(`自 ${formatTime(d.start)}`, `since ${formatTime(d.start)}`)
          : tr('在范围内', 'Within range'),
        hit: d.hit,
        turbine: turbine.id,
      });
    }
    result.rows.sort((a, b) => Number(b.hit) - Number(a.hit));
    result.summary = tr(`${result.hits.length} 台偏离`, `${result.hits.length} off plan`);
    result.focus = result.hits[0];
    return result;
  },
  chart(turbine, ctx) {
    const power = powerTrack(turbine, ctx);
    if (has(ctx, 'dispatch') && has(ctx, 'master')) {
      const d = deviation(turbine, ctx);
      if (d.hit)
        power.marks.push({
          from: d.start,
          to: ctx.now,
          label: tr('偏离计划', 'Off plan'),
          tone: 'hit',
        });
    }
    return spec([power, speedTrack(turbine, ctx)], recent(ctx, 1500), turbine, ctx);
  },
});

function drops(ctx: TurbineContext) {
  const out: {
    turbine: TurbineId;
    before: number;
    after: number;
    planned: boolean | null;
    cause?: ControlEvent;
  }[] = [];
  if (ctx.now < 900) return out;
  for (const turbine of TURBINES) {
    const power = powerOf(turbine.id, ctx);
    const before = mean(samples(power, ctx.now - 930, ctx.now - 900));
    const now = mean(samples(power, ctx.now - 30, ctx.now));
    if (Number.isNaN(before) || Number.isNaN(now) || before < 5 || (before - now) / before <= 0.2)
      continue;
    const planDrop = plannedPower(turbine.id, ctx.now - 915) - plannedPower(turbine.id, ctx.now);
    const planned = has(ctx, 'dispatch') ? planDrop >= 0.8 * (before - now) : null;
    const cause = has(ctx, 'events')
      ? EVENTS.find(
          (e) =>
            e.turbine === turbine.id &&
            e.t > ctx.now - 930 &&
            e.t <= ctx.now &&
            eventTurbine(e, ctx) &&
            ['fault', 'trip', 'shutdown', 'runback'].includes(e.type),
        )
      : undefined;
    out.push({ turbine: turbine.id, before, after: now, planned, cause });
  }
  return out;
}

const powerDrop = (): TurbineQuery => ({
  id: 'powerDrop',
  group: 'live',
  lang: 'SPARQL',
  title: tr(
    '最近 15 分钟出力下降超过 20% 的机组',
    'Turbines whose output fell by more than 20% in 15 minutes',
  ),
  description: tr(
    '比较 15 分钟前与此刻的出力，再用调度计划区分计划内与计划外的下降，并附上同一时段的控制系统事件作为原因。拼接历史库与实时流的数据。',
    'Compares output 15 minutes ago with output now, uses the dispatch plan to separate planned from unplanned drops, and attaches control system events from the same period as the cause. Data from the historians and the live stream are combined.',
  ),
  sources: ['live', 'hist_a', 'hist_b', 'dispatch', 'events', 'master'],
  suggest: m(52),
  story: { from: m(44), speed: 60 },
  explain: {
    hard: tr(
      '出力下降可能是计划内的停机，也可能是故障。区分两者需要调度计划，解释原因需要报警记录。',
      'A drop in output may be a planned shutdown or a fault. Telling them apart needs the dispatch plan, and explaining the cause needs the alarm records.',
    ),
    vkg: tr(
      '一条查询同时读取出力、调度计划与报警事件，区分计划内与计划外的下降，并给出原因。',
      'A single query reads output, the dispatch plan and alarm events, separates planned from unplanned drops, and gives the cause.',
    ),
  },
  text: {
    rule: `SELECT ?turbine ?before ?now ?planned ?cause WHERE {
  ?turbine :avgPower [ :at "PT15M" ; :mw ?before ] ,
                     [ :at "PT0M"  ; :mw ?now ] .
  FILTER (?before >= 5 && (?before - ?now) / ?before > 0.2)
  ?turbine :plannedDrop15min ?planDrop .
  BIND (?planDrop >= 0.8 * (?before - ?now) AS ?planned)
  OPTIONAL {
    ?e :unit ?turbine ; a ?cause ; :time ?t .
    ?cause rdfs:subClassOf :OperationalEvent .
    FILTER (?t > NOW() - "PT15M"^^xsd:duration)
  }
}`,
    sql: `WITH p AS (
  SELECT serial,
         AVG(value) FILTER (WHERE ts BETWEEN NOW() - INTERVAL '930' SECOND
                                         AND NOW() - INTERVAL '900' SECOND) AS before_mw,
         AVG(value) FILTER (WHERE ts > NOW() - INTERVAL '30' SECOND)      AS now_mw
  FROM   obs                              ${tr('-- 15 分钟前的数据来自历史库，此刻来自实时流', '-- data from 15 minutes ago comes from the historians, current data from the stream')}
  WHERE  class = 'PowerMeter'
  GROUP  BY serial
)
SELECT p.*, s.planned_drop >= 0.8 * (p.before_mw - p.now_mw) AS planned, a.code
FROM   p
JOIN   dispatch.default.planned_drop_15min s ON s.serial = p.serial
LEFT   JOIN master.dbo.id_map m ON m.serial = p.serial
LEFT   JOIN events.public.alarm_log a
       ON a.unit = m.dcs_code AND a.ts > NOW() - INTERVAL '15' MINUTE
WHERE  p.before_mw >= 5 AND (p.before_mw - p.now_mw) / p.before_mw > 0.2`,
  },
  run(ctx) {
    const result = base(this, ctx);
    if (!has(ctx, 'dispatch'))
      result.notes.unshift(
        tr(
          '调度计划未接入：无法区分计划内与计划外的下降。',
          'Dispatch schedule not connected: planned and unplanned drops cannot be told apart.',
        ),
      );
    if (!has(ctx, 'events'))
      result.notes.unshift(
        tr('控制系统事件未接入：没有下降原因。', 'Control system events not connected: no causes.'),
      );
    if (ctx.now < 900)
      result.notes.push(tr('需要 15 分钟的数据。', 'Fifteen minutes of data are needed.'));
    for (const d of drops(ctx)) {
      const pct = ((d.before - d.after) / d.before) * 100;
      const unplanned = d.planned !== true;
      if (unplanned) result.hits.push(d.turbine);
      const kind =
        d.planned === null ? '' : d.planned ? tr('计划内', 'planned') : tr('计划外', 'unplanned');
      const cause = d.cause ? `${eventLabel(d.cause.type)} ${formatTime(d.cause.t)}` : '';
      result.rows.push({
        key: d.turbine,
        title: tr(
          `${d.turbine} ${fmt(d.before)} → ${fmt(d.after)} MW（−${fmt(pct)}%）`,
          `${d.turbine} ${fmt(d.before)} → ${fmt(d.after)} MW (−${fmt(pct)}%)`,
        ),
        detail: [kind, cause].filter(Boolean).join(tr('，', ', ')) || '—',
        hit: unplanned,
        turbine: d.turbine,
      });
    }
    result.rows.sort((a, b) => Number(b.hit) - Number(a.hit));
    result.summary = result.rows.length
      ? tr(
          `${result.rows.length} 台下降，${result.hits.length} 台计划外`,
          `${result.rows.length} fell, ${result.hits.length} unplanned`,
        )
      : tr('无明显下降', 'No significant drop');
    result.focus = result.hits[0] ?? result.rows[0]?.turbine;
    return result;
  },
  chart(turbine, ctx) {
    const power = powerTrack(turbine, ctx);
    if (ctx.now >= 900) {
      power.links.push({
        from: ctx.now - 900,
        to: ctx.now,
        label: tr('15 分钟', '15 min'),
        ok: true,
      });
    }
    return spec([power, speedTrack(turbine, ctx)], recent(ctx, 1500), turbine, ctx);
  },
});

// ─────────────────────────── 导出 ───────────────────────────

export const turbineQueries = (): TurbineQuery[] => [
  purging(),
  tipFault(),
  trip(),
  rampChange(),
  stuckSensor(),
  hottestTips(),
  exhaust(),
  faultHistory(),
  batchRisk(),
  vibration(),
  state(),
  dispatch(),
  powerDrop(),
];

export const queryGroups = (): { id: QueryGroup; label: string }[] => [
  { id: 'temporal', label: tr('时序模式', 'Temporal patterns') },
  { id: 'fusion', label: tr('多源融合', 'Data fusion') },
  { id: 'live', label: tr('实时监测', 'Live monitoring') },
];

export { names as sourceNames, length, LIVE_RETENTION, PLANTS, plantOf };
