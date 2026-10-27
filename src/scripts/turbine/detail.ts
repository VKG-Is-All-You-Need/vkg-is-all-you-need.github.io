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

// ─────────────────────────── 数据源详情 ───────────────────────────

/** 详情中可以跳转的查询。 */
export interface QueryRef {
  id: string;
  title: string;
  sources: SourceId[];
}

interface SourceInfo {
  /** 这个系统如何标识机组。 */
  identifies: string;
  /** 映射到本体中的类与属性。 */
  maps: string[];
  /** 表结构，每张表的列。 */
  schema: [string, string[]][];
}

const SOURCE_INFO = (): Record<SourceId, SourceInfo> => ({
  hist_a: {
    identifies: tr(
      '机组代号（NH-GT1…）与数值传感器主键；传感器类型用数字编码，3 表示温度',
      'Unit codes (NH-GT1…) and numeric sensor keys; sensor types are numeric codes, 3 meaning temperature',
    ),
    maps: [':TemperatureSensor', ':RotorSpeedSensor', ':monitors', 'sosa:Observation'],
    schema: [
      ['turbine_components', ['id', 'turbine_id', 'type_id', 'code']],
      ['sensors', ['id', 'tag', 'component_id', 'type_id']],
      ['measurements', ['sensor_id', 'ts', 'value']],
    ],
  },
  hist_b: {
    identifies: tr(
      'KKS 风格的机组代号（11MBA…）；部件与传感器在同一张表中，温度为华氏度',
      'KKS-style unit codes (11MBA…); components and sensors share one table, temperatures in Fahrenheit',
    ),
    maps: [':TemperatureSensor', ':RotorSpeedSensor', ':monitors', 'sosa:Observation'],
    schema: [
      [
        'turbine_components',
        ['id', 'turbine_id', 'code', 'sensor_id', 'sensor_tag', 'sensor_type'],
      ],
      ['measurements', ['sensor_id', 'time', 'value']],
    ],
  },
  live: {
    identifies: tr(
      '传感器编号（如 T44B1T3），不含机组字段',
      'Sensor tags (such as T44B1T3), with no turbine column',
    ),
    maps: ['sosa:Observation', 'sosa:madeBySensor', 'sosa:resultTime'],
    schema: [['live_measurements', ['tag', 'ts', 'value']]],
  },
  master: {
    identifies: tr(
      '序列号（GA-60-0207…），并保存序列号、控制系统代号与维修设备号的对照',
      'Serial numbers (GA-60-0207…), plus the cross-reference of serials, control system codes and equipment numbers',
    ),
    maps: [':GasTurbine', ':model', ':ratedPower', ':purgingSpeed', ':dcsCode', ':equipmentNo'],
    schema: [
      ['turbines', ['serial', 'model', 'plant', 'commissioned']],
      ['models', ['id', 'rated_mw', 'exhaust_base', 'exhaust_slope', 'ambient_coef']],
      ['parameters', ['serial', 'purging_speed', 'non_purging_speed', 'tip_limit']],
      ['id_map', ['serial', 'dcs_code', 'equipment_no', 'sensor_tag']],
    ],
  },
  events: {
    identifies: tr(
      '控制系统代号（NH-GT3、11MBA…）；两座电厂的事件代码不同，如 BT_TEMP_HI 与 E2041',
      'Control system codes (NH-GT3, 11MBA…); the plants use different event codes, such as BT_TEMP_HI and E2041',
    ),
    maps: [':BurnerTipOvertemperature', ':Trip', ':Ignition', ':component', ':time'],
    schema: [['alarm_log', ['unit', 'ts', 'code', 'component']]],
  },
  cmms: {
    identifies: tr(
      '维修设备号（10004711…）与部件位置',
      'Maintenance equipment numbers (10004711…) and component positions',
    ),
    maps: [':WorkOrder', ':installedPart', ':batch', ':lastBurnerService'],
    schema: [
      ['work_orders', ['id', 'equipment_no', 'object', 'type', 'done_on']],
      ['installed_parts', ['equipment_no', 'position', 'batch', 'installed_on']],
    ],
  },
  dispatch: {
    identifies: tr(
      '序列号；计划按 15 分钟一段下达',
      'Serial numbers; the plan is issued in 15-minute blocks',
    ),
    maps: [':DispatchPlan', ':unit', ':mw'],
    schema: [['unit_schedule', ['serial', 'valid_from', 'valid_to', 'mw']]],
  },
  weather: {
    identifies: tr('电厂所在地，不涉及机组', 'Plant site; no turbine identifiers'),
    maps: [':WeatherObservation', ':site', ':airTemperature'],
    schema: [['observations', ['site', 'ts', 'air_temp', 'humidity']]],
  },
});

function table(head: string[], rows: (string | number)[][]): string {
  return `<div class="card-table"><table><thead><tr>${head.map((h) => `<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((row) => `<tr>${row.map((c) => `<td>${escape(String(c))}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`;
}

/** 按此刻从数据源中取的几行原始记录。 */
function sampleRows(id: SourceId, ctx: TurbineContext): string {
  const batch = lastBatch(ctx.now);
  const rowsAt = (tag: string, times: number[], convert = (v: number) => v) => {
    const values = observed(tag, ctx.now, new Set([id]) as ReadonlySet<SourceId>);
    return times
      .filter((t) => t >= 0 && !Number.isNaN(values[t]))
      .map((t) => [t, convert(values[t])] as const);
  };
  switch (id) {
    case 'hist_a': {
      const sensor = sensorByTag.get('T44B1T3')!;
      const rows = rowsAt(sensor.tag, [batch - 2, batch - 1, batch]);
      return (
        table(['id', 'tag', 'component_id', 'type_id'], [[sensor.dbId, sensor.tag, 3014, 3]]) +
        table(
          ['sensor_id', 'ts', 'value'],
          rows.map(([t, v]) => [sensor.dbId, formatTime(t), fmt(v, 1)]),
        )
      );
    }
    case 'hist_b': {
      const sensor = sensorByTag.get('T43B1T4')!;
      const rows = rowsAt(sensor.tag, [batch - 2, batch - 1, batch], toFahrenheit);
      return (
        table(
          ['turbine_id', 'code', 'sensor_id', 'sensor_type'],
          [['11MBA', 'MBM13', sensor.dbId, 3]],
        ) +
        table(
          ['sensor_id', 'time', 'value (°F)'],
          rows.map(([t, v]) => [sensor.dbId, formatTime(t), fmt(v, 1)]),
        )
      );
    }
    case 'live': {
      const tags = ['S21R1T1', 'T44B1T3', 'P01G1T4', 'V62D2T6'];
      const rows = tags.flatMap((tag) =>
        rowsAt(tag, [ctx.now]).map(([t, v]) => [tag, formatTime(t), fmt(v, 2)]),
      );
      return table(['tag', 'ts', 'value'], rows);
    }
    case 'master':
      return table(
        ['serial', 'model', 'dcs_code', 'equipment_no'],
        TURBINES.slice(0, 4).map((t) => [t.serial, t.model, t.dcs, t.equipmentNo]),
      );
    case 'events':
      return table(
        ['unit', 'ts', 'code', 'component'],
        eventsUntil(ctx.now)
          .slice(-4)
          .reverse()
          .map((e) => [e.dcs, formatTime(e.t), e.code, e.component ?? '']),
      );
    case 'cmms':
      return table(
        ['equipment_no', 'object', 'done_on', 'batch'],
        [...WORK_ORDERS]
          .sort((a, b) => b.date.localeCompare(a.date))
          .slice(0, 4)
          .map((o) => [o.equipmentNo, o.component, o.date, o.batch ?? '']),
      );
    case 'dispatch': {
      const from = Math.floor(ctx.now / 900) * 900;
      return table(
        ['serial', 'valid_from', 'mw'],
        TURBINES.slice(0, 4).map((t) => [
          t.serial,
          formatTime(from),
          fmt(plannedPower(t.id, from), 1),
        ]),
      );
    }
    case 'weather':
      return table(
        ['site', 'ts', 'air_temp', 'humidity'],
        (['A', 'B'] as const).map((plant) => {
          const w = weatherAt(plant, ctx.now);
          return [PLANTS[plant].name, formatTime(w.t), w.temp, w.humidity];
        }),
      );
  }
}

export function sourceDetail(id: SourceId, ctx: TurbineContext, queries: QueryRef[]): string {
  const source = sourceById.get(id)!;
  const info = SOURCE_INFO()[id];
  const on = ctx.sources.has(id);
  const used = queries.filter((q) => q.sources.includes(id));
  return `
    <div class="card-head">
      <div>
        <p class="card-kind" style="--source:${source.color}"><i class="card-swatch"></i>${escape(tr('数据源', 'Data source'))} · ${escape(source.system)}</p>
        <h3 class="card-title">${escape(source.name)}</h3>
      </div>
      <button type="button" class="card-close" data-detail-close aria-label="${escape(tr('关闭详情', 'Close details'))}">×</button>
    </div>
    <p class="card-desc">${escape(source.description)}</p>
    <div class="card-facts">
      <p><span>${escape(tr('更新', 'Updates'))}</span>${escape(source.refresh)}</p>
      <p><span>catalog</span><code>${source.catalog}</code></p>
      <p><span>${escape(tr('机组标识', 'Turbine IDs'))}</span>${escape(info.identifies)}</p>
    </div>
    <button type="button" class="card-toggle${on ? '' : ' is-off'}" data-toggle-source="${id}">${escape(
      on
        ? tr('已接入 · 点击断开', 'Connected · click to disconnect')
        : tr('未接入 · 点击接入', 'Not connected · click to connect'),
    )}</button>
    <p class="card-label">${escape(tr('表结构', 'Tables'))}</p>
    <div class="card-schema">${info.schema
      .map(
        ([name, cols]) =>
          `<p><code>${source.catalog}.${name}</code><span>${cols.join(', ')}</span></p>`,
      )
      .join('')}</div>
    <p class="card-label">${escape(tr(`此刻的原始记录（${formatTime(ctx.now)}）`, `Raw records now (${formatTime(ctx.now)})`))}</p>
    ${sampleRows(id, ctx)}
    <p class="card-label">${escape(tr('在本体中映射为', 'Mapped to'))}</p>
    <div class="card-chips">${info.maps.map((m) => `<span class="card-chip is-static"><code>${m}</code></span>`).join('')}</div>
    <p class="card-label">${escape(tr(`用到它的查询（${used.length} 条）`, `Queries that use it (${used.length})`))}</p>
    <div class="card-chips">${used
      .map(
        (q) =>
          `<button type="button" class="card-chip" data-query="${q.id}">${escape(q.title)}</button>`,
      )
      .join('')}</div>
    <p class="card-label">${escape(tr('其他数据源', 'Other sources'))}</p>
    <div class="card-chips">${[...sourceById.values()]
      .filter((s) => s.id !== id)
      .map(
        (s) =>
          `<button type="button" class="card-chip" data-src="${s.id}"><i style="--c:${s.color}"></i>${escape(s.name)}</button>`,
      )
      .join(
        '',
      )}<button type="button" class="card-chip" data-src="hub">${escape(tr('虚拟知识图谱', 'Virtual knowledge graph'))}</button></div>`;
}

// ─────────────────────────── 知识图谱详情 ───────────────────────────

export function hubDetail(ctx: TurbineContext, ontology: string): string {
  const connected = [...sourceById.values()].filter((s) => ctx.sources.has(s.id));
  const sensors = TURBINES.flatMap((t) => sensorsOf(t.id));
  const components = TURBINES.flatMap((t) => componentsOf(t.id));
  // 此刻可以查询到的观测：每个传感器在已接入数据源中可读的秒数
  let observations = 0;
  for (const plant of ['A', 'B'] as const) {
    let readable = 0;
    for (let t = 0; t <= ctx.now; t++) if (originOf(plant, t, ctx.now, ctx.sources)) readable++;
    observations +=
      readable * sensors.filter((s) => turbineById.get(s.turbine)!.plant === plant).length;
  }
  const count = (kinds: string[]) => sensors.filter((s) => kinds.includes(s.kind)).length;
  const classes: [string, number | string][] = [
    [':GasTurbine', TURBINES.length],
    [':Component', components.length],
    [':BurnerTip', components.filter((c) => c.kind === 'tip').length],
    [':TemperatureSensor', count(['tip', 'exhaust', 'inlet', 'bearingTemp'])],
    [':RotorSpeedSensor', count(['speed'])],
    [':VibrationSensor', count(['vibration'])],
    [':OperationalEvent', eventsUntil(ctx.now).length],
    [':WorkOrder', WORK_ORDERS.length],
    ['sosa:Observation', observations],
  ];
  const stats: [string, string][] = [
    [tr('已接入数据源', 'Connected sources'), `${connected.length} / ${sourceById.size}`],
    [tr('机组', 'Turbines'), String(TURBINES.length)],
    [tr('传感器', 'Sensors'), String(sensors.length)],
    [tr('可查询的观测', 'Queryable observations'), observations.toLocaleString('en-US')],
    [tr('复制的数据', 'Data copied'), '0'],
  ];
  return `
    <div class="card-head">
      <div>
        <p class="card-kind">${escape(tr('本体 + 映射', 'Ontology + mappings'))}</p>
        <h3 class="card-title">${escape(tr('虚拟知识图谱', 'Virtual knowledge graph'))}</h3>
      </div>
      <button type="button" class="card-close" data-detail-close aria-label="${escape(tr('关闭详情', 'Close details'))}">×</button>
    </div>
    <p class="card-desc">${escape(
      tr(
        '虚拟知识图谱不存放数据。本体用统一的词汇描述机组、部件、传感器和事件，映射说明这些词汇对应各数据源中的哪些表与列。查询写在本体上，执行时被改写成各数据源的 SQL，结果再合并返回。',
        'A virtual knowledge graph stores no data. The ontology describes turbines, components, sensors and events in one vocabulary, and the mappings state which tables and columns in each source correspond to that vocabulary. Queries are written against the ontology and rewritten into SQL for each source at run time; the results are then merged.',
      ),
    )}</p>
    <div class="card-stats">${stats.map(([label, value]) => `<p><b>${escape(value)}</b><span>${escape(label)}</span></p>`).join('')}</div>
    <p class="card-label">${escape(tr('一条查询的执行过程', 'How a query runs'))}</p>
    <ol class="card-steps">
      <li>${escape(tr('用本体推理扩展查询：问“温度传感器”，也会查到喷嘴、排气与轴承上的温度传感器。', 'Expand the query with the ontology: asking for temperature sensors also covers those on burner tips, exhaust and bearings.'))}</li>
      <li>${escape(tr('按映射展开：每个类与属性换成对应数据源上的 SQL，历史库 B 的华氏度在这一步换算。', 'Unfold through the mappings: each class and property becomes SQL over the matching sources; Fahrenheit from Historian B is converted here.'))}</li>
      <li>${escape(tr('联邦执行：SQL 分发到 8 个数据源，各自在原处计算。', 'Federated execution: the SQL is sent to the eight sources and evaluated where the data lives.'))}</li>
      <li>${escape(tr('合并结果：不同编号的记录因映射到同一个 IRI 而汇合。', 'Merge the results: records with different identifiers meet because they map to the same IRI.'))}</li>
    </ol>
    <p class="card-label">${escape(tr('本体中的类与此刻的实例数', 'Classes and current instance counts'))}</p>
    <div class="card-classes">${classes
      .map(
        ([name, n]) =>
          `<p><code>${name}</code><span>${typeof n === 'number' ? n.toLocaleString('en-US') : n}</span></p>`,
      )
      .join('')}</div>
    <p class="card-label">${escape(tr('数据源（点击查看）', 'Sources (click to inspect)'))}</p>
    <div class="card-chips">${[...sourceById.values()]
      .map(
        (s) =>
          `<button type="button" class="card-chip${ctx.sources.has(s.id) ? '' : ' is-off'}" data-src="${s.id}"><i style="--c:${s.color}"></i>${escape(s.name)}</button>`,
      )
      .join('')}</div>
    <p class="card-label">${escape(tr('本体节选', 'Ontology excerpt'))}</p>
    <pre class="card-code">${escape(ontology)}</pre>`;
}
