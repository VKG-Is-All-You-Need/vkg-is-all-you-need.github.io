/**
 * 右侧面板中的详情：机组详情列出它在各数据源中的记录、传感器与相关机组；
 * 传感器详情给出读数、最近 10 分钟的曲线、数据所在的数据源与本体中的表示。
 * 卡片中带 data-unit 与 data-sensor 的元素可以点击跳转。
 */
import { tr } from '../../i18n/runtime';
import {
  MODELS,
  PLANTS,
  SENSOR_CLASSES,
  SENSOR_UNITS,
  TURBINES,
  componentById,
  componentLabel,
  componentsOf,
  sensorByTag,
  sensorKindLabel,
  sensorsOf,
  turbineById,
  type Sensor,
  type TurbineId,
} from '../../lib/turbine/fleet';
import {
  WORK_ORDERS,
  batchOf,
  eventLabel,
  eventsUntil,
  plannedPower,
  weatherAt,
  workLabel,
} from '../../lib/turbine/records';
import { latest } from '../../lib/turbine/rules';
import { observed, originOf, toFahrenheit } from '../../lib/turbine/signals';
import { sourceById, type SourceId } from '../../lib/turbine/sources';
import { formatTime, lastBatch } from '../../lib/turbine/time';
import { stateLabel, stateOf, type TurbineContext } from '../../lib/turbine/queries';

const escape = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const fmt = (value: number, digits?: number) =>
  value.toLocaleString('en-US', {
    maximumFractionDigits: digits ?? (Math.abs(value) < 10 ? 2 : Math.abs(value) < 100 ? 1 : 0),
  });

/** 传感器读数的文字表示。 */
export function reading(sensor: Sensor, value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return '—';
  if (sensor.kind === 'flame')
    return value > 0.5 ? tr('有火焰', 'Flame on') : tr('无火焰', 'No flame');
  return `${fmt(value)} ${SENSOR_UNITS[sensor.kind]}`;
}

const unitLink = (id: TurbineId, label: string = id) =>
  `<button type="button" class="card-chip" data-unit="${id}">${escape(label)}</button>`;

const sensorLink = (sensor: Sensor, label: string) =>
  `<button type="button" class="card-chip" data-sensor="${sensor.tag}">${label}</button>`;

interface Row {
  source: SourceId;
  html: string;
}

function rowsHtml(rows: Row[], ctx: TurbineContext): string {
  return rows
    .map(({ source, html }) => {
      const meta = sourceById.get(source)!;
      const on = ctx.sources.has(source);
      return `<li${on ? '' : ' class="is-off"'} style="--source:${meta.color}"><span class="card-source">${escape(meta.name)}</span><span class="card-text">${on ? html : escape(tr('未接入', 'Not connected'))}</span></li>`;
    })
    .join('');
}

/** 两个元素之间的“上一台 / 下一台”。 */
function neighbors<T>(list: T[], item: T): [T, T] {
  const i = list.indexOf(item);
  return [list[(i - 1 + list.length) % list.length], list[(i + 1) % list.length]];
}

const value = (tag: string, ctx: TurbineContext) =>
  latest(observed(tag, ctx.now, ctx.sources), ctx.now);

// ─────────────────────────── 机组详情 ───────────────────────────

export function unitDetail(id: TurbineId, ctx: TurbineContext): string {
  const turbine = turbineById.get(id)!;
  const model = MODELS[turbine.model];
  const plant = PLANTS[turbine.plant];
  const historian = plant.historian;
  const ids = TURBINES.map((t) => t.id);
  const [prev, next] = neighbors(ids, id);
  const state = stateOf(id, ctx);
  const sensors = sensorsOf(id);
  const speed = value(sensorsOf(id, 'speed')[0].tag, ctx);
  const power = value(sensorsOf(id, 'power')[0].tag, ctx);
  const events = eventsUntil(ctx.now)
    .filter((e) => e.turbine === id)
    .slice(-3)
    .reverse();
  const orders = WORK_ORDERS.filter((o) => o.turbine === id)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 3);
  const weather = weatherAt(turbine.plant, ctx.now);

  const rows: Row[] = [
    {
      source: 'master',
      html: tr(
        `型号 ${model.id}，额定 ${model.capacity} MW；序列号 <code>${turbine.serial}</code>；清吹阈值 ${model.purgingSpeed}/${model.nonPurgingSpeed} rpm，喷嘴温度上限 ${model.tipLimit} °C`,
        `Model ${model.id}, rated ${model.capacity} MW; serial <code>${turbine.serial}</code>; purging thresholds ${model.purgingSpeed}/${model.nonPurgingSpeed} rpm, tip limit ${model.tipLimit} °C`,
      ),
    },
    {
      source: historian,
      html: tr(
        `${sensors.length} 个传感器的归档，已入库至 ${formatTime(lastBatch(ctx.now))}${turbine.plant === 'B' ? '；温度以华氏度存储' : ''}`,
        `Archive of ${sensors.length} sensors, loaded up to ${formatTime(lastBatch(ctx.now))}${turbine.plant === 'B' ? '; temperatures stored in Fahrenheit' : ''}`,
      ),
    },
    {
      source: 'live',
      html: speed
        ? tr(
            `${formatTime(speed.t)}：转速 ${fmt(speed.value)} rpm，出力 ${fmt(power?.value ?? 0, 1)} MW`,
            `${formatTime(speed.t)}: ${fmt(speed.value)} rpm, ${fmt(power?.value ?? 0, 1)} MW`,
          )
        : tr('无读数', 'No readings'),
    },
    {
      source: 'events',
      html:
        `<code>${turbine.dcs}</code>：` +
        (events.length
          ? events
              .map((e) => `${formatTime(e.t)} ${escape(eventLabel(e.type))}（${e.code}）`)
              .join('；')
          : tr('截至此刻无事件', 'no events so far')),
    },
    {
      source: 'cmms',
      html:
        `<code>${turbine.equipmentNo}</code>：` +
        orders
          .map(
            (o) =>
              `${o.date} ${escape(workLabel(o))}${o.batch ? tr(`（批次 ${o.batch}）`, ` (batch ${o.batch})`) : ''}`,
          )
          .join('；'),
    },
    {
      source: 'dispatch',
      html: tr(
        `此刻计划 ${fmt(plannedPower(id, ctx.now), 1)} MW`,
        `Planned now: ${fmt(plannedPower(id, ctx.now), 1)} MW`,
      ),
    },
    {
      source: 'weather',
      html: tr(
        `${plant.name} ${fmt(weather.temp, 1)} °C，湿度 ${weather.humidity}%`,
        `${plant.name} ${fmt(weather.temp, 1)} °C, humidity ${weather.humidity}%`,
      ),
    },
  ];
  const connected = rows.filter((r) => ctx.sources.has(r.source)).length;

  // 按部件分组的传感器
  const groups = componentsOf(id)
    .map((component) => {
      const list = sensors.filter((s) => s.component === component.id);
      if (!list.length) return '';
      const chips = list
        .map((s) =>
          sensorLink(
            s,
            `<i style="--c:var(--k-${s.kind})"></i>${escape(sensorKindLabel(s.kind))}<em>${escape(reading(s, value(s.tag, ctx)?.value))}</em>`,
          ),
        )
        .join('');
      return `<div class="card-group"><p>${escape(componentLabel(component))} <code>${component.code}</code></p><div class="card-chips">${chips}</div></div>`;
    })
    .join('');

  // 相关机组
  const sameModel = TURBINES.filter((t) => t.model === turbine.model && t.id !== id);
  const samePlant = TURBINES.filter((t) => t.plant === turbine.plant && t.id !== id);
  const batch = batchOf(id, 'MBM11')?.batch;
  const sameBatch = batch
    ? TURBINES.filter((t) => t.id !== id && batchOf(t.id, 'MBM11')?.batch === batch)
    : [];
  const related = [
    [tr('同型号', 'Same model'), sameModel],
    [tr('同电厂', 'Same plant'), samePlant],
    ...(sameBatch.length
      ? [[tr(`同批次喷嘴 ${batch}`, `Same tip batch ${batch}`), sameBatch]]
      : []),
  ] as [string, typeof TURBINES][];

  return `
    <div class="card-nav">
      ${unitLink(prev, `← ${prev}`)}
      <span>${escape(tr('机组', 'Turbine'))} ${ids.indexOf(id) + 1} / ${ids.length}</span>
      ${unitLink(next, `${next} →`)}
    </div>
    <div class="card-head">
      <div>
        <p class="card-kind">${escape(tr('燃气轮机', 'Gas turbine'))} · ${model.id} · ${escape(plant.name)}</p>
        <h3 class="card-title">${id}</h3>
      </div>
      <button type="button" class="card-close" data-detail-close aria-label="${escape(tr('关闭详情', 'Close details'))}">×</button>
    </div>
    <p class="card-state"><b>${escape(stateLabel(state.state))}</b>${
      state.state === 'loaded'
        ? ` · ${fmt(state.power, 1)} MW`
        : state.state !== 'unknown'
          ? ` · ${fmt(state.speed)} rpm`
          : ''
    }</p>
    <p class="card-iri"><code>:turbine/${turbine.serial}</code><span>:GasTurbine</span></p>
    <p class="card-label">${escape(tr('各数据源中的记录', 'Records in each source'))}</p>
    <ul class="card-rows" role="list">${rowsHtml(rows, ctx)}</ul>
    <p class="card-foot">${escape(
      tr(
        `${connected} 个数据源以不同的编号记录这台机组，在映射后都指向同一个 IRI。`,
        `${connected} sources record this turbine under different identifiers; after mapping they all point to the same IRI.`,
      ),
    )}</p>
    <p class="card-label">${escape(tr(`传感器（${sensors.length} 个，点击查看）`, `Sensors (${sensors.length}, click to inspect)`))}</p>
    ${groups}
    <p class="card-label">${escape(tr('相关机组', 'Related turbines'))}</p>
    ${related
      .map(
        ([label, list]) =>
          `<div class="card-group"><p>${escape(label)}</p><div class="card-chips">${list.map((t) => unitLink(t.id)).join('')}</div></div>`,
      )
      .join('')}`;
}

// ─────────────────────────── 传感器详情 ───────────────────────────

function sparkline(values: Float32Array, from: number, to: number): string {
  const points: [number, number][] = [];
  for (let t = Math.max(0, from); t <= to; t++) {
    if (!Number.isNaN(values[t])) points.push([t, values[t]]);
  }
  if (points.length < 2) return '';
  let min = Math.min(...points.map((p) => p[1]));
  let max = Math.max(...points.map((p) => p[1]));
  // 纵轴至少覆盖读数的 5%，避免把噪声放大成剧烈波动
  const span = Math.max(Math.abs(max) * 0.05, 1);
  if (max - min < span) {
    const mid = (max + min) / 2;
    min = mid - span / 2;
    max = mid + span / 2;
  }
  const w = 240;
  const h = 56;
  const x = (t: number) => ((t - from) / (to - from)) * w;
  const y = (v: number) => h - 4 - ((v - min) / (max - min)) * (h - 8);
  const d = points
    .map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`)
    .join('');
  return `<svg class="card-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}"/></svg><p class="card-spark-axis"><span>${formatTime(from)}</span><span>${fmt(min)} – ${fmt(max)}</span><span>${formatTime(to)}</span></p>`;
}

export function sensorDetail(tag: string, ctx: TurbineContext): string {
  const sensor = sensorByTag.get(tag)!;
  const turbine = turbineById.get(sensor.turbine)!;
  const component = componentById.get(sensor.component)!;
  const model = MODELS[turbine.model];
  const values = observed(tag, ctx.now, ctx.sources);
  const last = latest(values, ctx.now);
  const origin = last ? originOf(turbine.plant, last.t, ctx.now, ctx.sources) : null;
  const siblings = sensorsOf(turbine.id);
  const [prev, next] = neighbors(siblings, sensor);
  const historian = PLANTS[turbine.plant].historian;
  const fahrenheit =
    turbine.plant === 'B' && SENSOR_UNITS[sensor.kind] === '°C' && last && origin === 'hist_b';
  const sameKind = siblings.filter((s) => s.kind === sensor.kind && s !== sensor);
  const peers = TURBINES.filter((t) => t.id !== turbine.id)
    .map((t) => sensorsOf(t.id, sensor.kind).find((s) => s.index === sensor.index))
    .filter((s): s is Sensor => !!s);
  const threshold =
    sensor.kind === 'tip'
      ? tr(`型号上限 ${model.tipLimit} °C`, `model limit ${model.tipLimit} °C`)
      : sensor.kind === 'speed'
        ? tr(
            `清吹阈值 ${model.purgingSpeed}/${model.nonPurgingSpeed} rpm，静止 ${model.standStillSpeed} rpm`,
            `purging ${model.purgingSpeed}/${model.nonPurgingSpeed} rpm, standstill ${model.standStillSpeed} rpm`,
          )
        : sensor.kind === 'exhaust'
          ? tr(
              `参考曲线 ${model.exhaustBase} + ${model.exhaustSlope} × 负荷率 °C`,
              `reference ${model.exhaustBase} + ${model.exhaustSlope} × load °C`,
            )
          : '';
  const rows: Row[] = [
    {
      source: historian,
      html: tr(
        `数值主键 ${sensor.dbId}，已入库至 ${formatTime(lastBatch(ctx.now))}${
          turbine.plant === 'B' && SENSOR_UNITS[sensor.kind] === '°C' ? '，以华氏度存储' : ''
        }`,
        `Numeric key ${sensor.dbId}, loaded up to ${formatTime(lastBatch(ctx.now))}${
          turbine.plant === 'B' && SENSOR_UNITS[sensor.kind] === '°C'
            ? ', stored in Fahrenheit'
            : ''
        }`,
      ),
    },
    {
      source: 'live',
      html: tr(
        `编号 <code>${tag}</code>，每秒一条，保留 10 分钟`,
        `Tag <code>${tag}</code>, one reading per second, kept for 10 minutes`,
      ),
    },
    {
      source: 'master',
      html:
        tr(`所属部件 <code>${component.code}</code>`, `Component <code>${component.code}</code>`) +
        (threshold ? `；${escape(threshold)}` : ''),
    },
  ];
  return `
    <div class="card-nav">
      ${unitLink(turbine.id, `← ${turbine.id}`)}
      <span>${siblings.indexOf(sensor) + 1} / ${siblings.length}</span>
      <span class="card-nav-pair">${sensorLink(prev, '‹')}${sensorLink(next, '›')}</span>
    </div>
    <div class="card-head">
      <div>
        <p class="card-kind">${escape(sensorKindLabel(sensor.kind))} · ${escape(componentLabel(component))} · ${turbine.id}</p>
        <h3 class="card-title card-mono">${tag}</h3>
      </div>
      <button type="button" class="card-close" data-detail-close aria-label="${escape(tr('关闭详情', 'Close details'))}">×</button>
    </div>
    <p class="card-value">${escape(reading(sensor, last?.value))}${
      origin
        ? `<span style="--source:${sourceById.get(origin)!.color}">${escape(sourceById.get(origin)!.name)}</span>`
        : ''
    }</p>
    ${
      fahrenheit
        ? `<p class="card-note">${escape(
            tr(
              `历史库 B 中存的是 ${fmt(toFahrenheit(last!.value))} °F，映射换算为摄氏度。`,
              `Historian B stores ${fmt(toFahrenheit(last!.value))} °F; the mapping converts it to Celsius.`,
            ),
          )}</p>`
        : ''
    }
    ${sensor.kind === 'flame' ? '' : sparkline(values, ctx.now - 600, ctx.now)}
    <p class="card-iri"><code>:sensor/${tag}</code><span>${SENSOR_CLASSES[sensor.kind]}</span></p>
    <p class="card-iri"><span>:monitors</span><code>:component/${turbine.serial}/${component.code}</code></p>
    <p class="card-label">${escape(tr('数据所在', 'Where the data lives'))}</p>
    <ul class="card-rows" role="list">${rowsHtml(rows, ctx)}</ul>
    ${
      sameKind.length
        ? `<p class="card-label">${escape(tr('同组传感器', 'Sibling sensors'))}</p><div class="card-chips">${sameKind
            .map((s) =>
              sensorLink(s, `${s.tag}<em>${escape(reading(s, value(s.tag, ctx)?.value))}</em>`),
            )
            .join('')}</div>`
        : ''
    }
    <p class="card-label">${escape(tr('其他机组的同位置传感器', 'Same position on other turbines'))}</p>
    <div class="card-chips">${peers
      .map((s) =>
        sensorLink(s, `${s.turbine}<em>${escape(reading(s, value(s.tag, ctx)?.value))}</em>`),
      )
      .join('')}</div>`;
}
