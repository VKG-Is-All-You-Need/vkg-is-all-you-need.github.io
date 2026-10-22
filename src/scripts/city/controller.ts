/**
 * “VKG × 城市数据融合”示例的页面控制：查询分组与切换、数据源开关、聚合与明细、模拟时间轴、
 * 结果列表、对象详情卡片，以及三维场景的按需加载与全屏。
 */
import { city } from '../../lib/geo/city';
import { shopById, shopByBuilding } from '../../lib/city/commerce';
import { isRide, pedestriansAt, peopleInside, personAt, type Leg } from '../../lib/city/mobility';
import { platformOf } from '../../lib/city/plans';
import {
  carOwners,
  companies,
  companyById,
  events,
  people,
  personById,
  type Person,
} from '../../lib/city/people';
import {
  cityQueries,
  type CityQuery,
  type CityResult,
  type QueryGroup,
  type ResultRow,
} from '../../lib/city/queries';
import { dayMarkers } from '../../lib/city/calendar';
import {
  busLoad,
  footfallCount,
  occupantsAt,
  presence,
  purchasesOf,
  sessionsOf,
  tapsOf,
} from '../../lib/city/records';
import { BUS_LOOP, edgeById, isGate, nodeById, signalState } from '../../lib/city/roads';
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
import {
  edgeSpeeds,
  handoversOf,
  statesAt,
  stopVisits,
  tripsOf,
  vehicleAt,
} from '../../lib/city/traffic';
import { busCrews, vehicleByDriver, vehicleById, vehicleByOwner } from '../../lib/city/vehicles';
import { observationAt } from '../../lib/city/weather';
import { prefersReducedMotion } from '../lifecycle';
import type { CityScene, FocusTarget, Insets, Selection, SelectionInfo, View } from './scene';

const PRESETS: Record<string, SourceId[]> = {
  all: ALL_SOURCES,
  gis: ['gis'],
  mobility: ['gis', 'traffic', 'weather'],
  people: ['gis', 'traffic', 'mobility', 'commerce', 'hr', 'community'],
};

/** 播放时结果列表与详情卡片的刷新间隔（毫秒）。 */
const REFRESH_INTERVAL = 350;

const CHEVRON_DOWN =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const CHEVRON_UP =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>';

const CLOSE_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const NIGHT_KEY = 'city-night-view';

/** 夜景显示默认打开；关闭后记住选择。 */
function readNightView(): boolean {
  try {
    return localStorage.getItem(NIGHT_KEY) !== 'off';
  } catch {
    return true;
  }
}

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
  /** 文中可以点击跳转的实体。 */
  refs?: Ref[];
}

/** 卡片中的实体名称：点击后选中该实体，查看它在各数据源中的记录。 */
interface Ref {
  name: string;
  target: Selection;
}

interface Card {
  kind: string;
  title: string;
  iri: string;
  cls: string;
  rows: CardRow[];
  /** 模拟中的实况：不属于任何数据源，用来对照数据源能查到什么。 */
  truth?: string;
  truthRefs?: Ref[];
  /** 没有任何记录时的说明。 */
  empty?: string;
}

const buildingName = (id: number) => city.buildings.find((b) => b.id === id)?.name ?? `建筑 #${id}`;

/** 人物在卡片与说明中的称呼：明细视图中具名人物显示姓名，其余显示编号。 */
function personLabel(id: string, detail: boolean): string {
  const person = personById.get(id);
  if (!person) return id;
  if (detail && person.persona) return person.name!;
  return person.kind === 'resident' ? `居民 ${id}` : `外来人员 ${id}`;
}

const building = (id: number): Selection => ({ type: 'building', id });
const vehicleRef = (id: string): Ref => ({
  name: vehicleById.get(id)!.plate,
  target: { type: 'vehicle', id },
});
const nodeRef = (id: number): Ref => ({
  name: nodeById.get(id)!.name,
  target: { type: 'node', id },
});
const edgeRef = (id: number): Ref => ({
  name: edgeById.get(id)!.name,
  target: { type: 'edge', id },
});
const personRef = (id: string, detail: boolean): Ref => ({
  name: personLabel(id, detail),
  target: { type: 'person', id },
});

/** 行程段的描述（模拟实况），以及其中可以跳转的车辆与建筑。 */
function describeLeg(leg: Leg, person: Person, detail: boolean): { text: string; refs: Ref[] } {
  const refs: Ref[] = [];
  if (leg.vehicle) refs.push(vehicleRef(leg.vehicle));
  const plate = leg.vehicle ? vehicleById.get(leg.vehicle)!.plate : '';
  let text: string;
  switch (leg.mode) {
    case 'walk':
      text = `步行 · ${leg.label}`;
      break;
    case 'bus':
      text = `在${plate}上 · ${leg.label}`;
      break;
    case 'drive':
      text = `驾驶 ${plate} · ${leg.label}`;
      break;
    case 'ride':
      text = `乘坐 ${plate}`;
      break;
    case 'taxi':
      text = `乘网约车 ${plate} · ${leg.label}`;
      break;
    default:
      text = leg.label;
  }
  // 在室内时注明所在建筑，步行时注明要去的建筑；聚合视图不显示居民的住址
  if (leg.building !== undefined && !(leg.mode === 'home' && !detail)) {
    const name = buildingName(leg.building);
    if (!text.includes(name)) text += ` · ${name}`;
    refs.push({ name, target: building(leg.building) });
  }
  if (leg.destination !== undefined && (detail || leg.destination !== person.homeId)) {
    const name = buildingName(leg.destination);
    if (!text.includes(name)) text += ` → ${name}`;
    refs.push({ name, target: building(leg.destination) });
  }
  return { text, refs };
}

/** 把文中的实体名称换成可以点击的按钮。 */
function linkify(text: string, refs: Ref[] = []): string {
  const spans: { start: number; end: number; ref: Ref }[] = [];
  for (const ref of refs) {
    for (let from = 0; ;) {
      const start = text.indexOf(ref.name, from);
      if (start < 0) break;
      const end = start + ref.name.length;
      if (!spans.some((span) => start < span.end && end > span.start)) {
        spans.push({ start, end, ref });
        break;
      }
      from = start + 1;
    }
  }
  spans.sort((a, b) => a.start - b.start);
  let html = '';
  let at = 0;
  for (const { start, end, ref } of spans) {
    const key = `${ref.target.type}:${ref.target.id}`;
    html += `${escapeHtml(text.slice(at, start))}<button type="button" class="card-link" data-card-link="${escapeHtml(key)}">${escapeHtml(ref.name)}</button>`;
    at = end;
  }
  return html + escapeHtml(text.slice(at));
}

function parseSelection(key: string): Selection {
  const [type, id] = key.split(':') as [Selection['type'], string];
  return type === 'building' || type === 'node' || type === 'edge'
    ? { type, id: Number(id) }
    : ({ type, id } as Selection);
}

const sameSelection = (a: Selection | null, b: Selection | null) =>
  a?.type === b?.type && a?.id === b?.id;

/** 返回按钮上的名称。 */
function selectionTitle(selection: Selection, detail: boolean): string {
  switch (selection.type) {
    case 'building':
      return buildingName(selection.id);
    case 'vehicle':
      return vehicleById.get(selection.id)!.plate;
    case 'person':
      return personLabel(selection.id, detail);
    case 'sensor':
      return selection.id;
    case 'node':
      return nodeById.get(selection.id)!.name;
    case 'edge':
      return edgeById.get(selection.id)!.name;
  }
}

/** 某人此刻在哪里（简短）：所在建筑、所乘车辆或正在步行。 */
function whereabouts(id: string, t: number): string {
  const state = personAt(id, t);
  if (!state) return '不在街区';
  const leg = state.leg;
  if (leg.vehicle && isRide(leg.mode)) return `在${vehicleById.get(leg.vehicle)!.plate}上`;
  if (leg.building !== undefined) return `在${buildingName(leg.building)}`;
  if (leg.mode === 'wait') return leg.label;
  if (leg.mode === 'walk') return '步行中';
  return leg.label;
}

function buildingCard(id: number, t: number, on: ReadonlySet<SourceId>, detail: boolean): Card {
  const building = city.buildings.find((b) => b.id === id)!;
  const shop = shopByBuilding.get(id);
  const company = companies.find((c) => c.buildingId === id);
  const residents = people.filter((p) => p.homeId === id).map((p) => p.id);
  const hosted = events.filter((e) => e.venue.kind === 'building' && e.venue.id === id);
  const rows: CardRow[] = [{ source: 'gis', text: `${building.kind} · ${building.floors} 层` }];
  if (shop) {
    rows.push({
      source: 'commerce',
      text: `${shop.name} · ${shop.category} · ${formatTime(shop.open[0])}–${formatTime(shop.open[1])}`,
    });
    rows.push({
      source: 'iot',
      text: `计数器 ${shop.sensor} · 近一小时进店 ${footfallCount(shop, t - 3600, t)} 人 · 今日累计 ${footfallCount(shop, startOfDay(dayOf(t)), t)} 人`,
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
  if (residents.length || hosted.length) {
    // 住户名单等于住址：只在明细视图中列出
    const roster = residents.map((r) => personLabel(r, detail));
    rows.push({
      source: 'community',
      refs: detail ? residents.map((r) => personRef(r, detail)) : [],
      text: [
        residents.length
          ? detail
            ? `登记住户 ${residents.length} 人：${roster.join('、')}`
            : `登记住户 ${residents.length} 人（明细视图中列出住户）`
          : '',
        ...hosted
          .filter((e) => dayOf(e.start) === dayOf(t))
          .map((e) => `${e.title} ${formatTime(e.start)}–${formatTime(e.end)}`),
      ]
        .filter(Boolean)
        .join(' · '),
    });
  }
  const commerce = shop && on.has('commerce');
  const inside = peopleInside(id, t);
  let truth = inside.length ? `此刻楼内 ${inside.length} 人` : '此刻楼内无人';
  const truthRefs: Ref[] = [];
  if (detail && residents.length) {
    // 住户在家几人，外出的人此刻在哪里
    const out = residents.filter((r) => !inside.includes(r));
    truth += ` · 住户在家 ${residents.length - out.length} 人`;
    if (out.length) {
      const shown = out.slice(0, 4);
      truth += `，外出 ${out.length} 人：${shown.map((r) => `${personLabel(r, detail)}${whereabouts(r, t)}`).join('、')}`;
      if (out.length > shown.length) truth += ' 等';
      truthRefs.push(...shown.map((r) => personRef(r, detail)));
    }
  } else if (detail && inside.length) {
    const shown = inside.slice(0, 4);
    truth += `：${shown.map((p) => personLabel(p, detail)).join('、')}${inside.length > shown.length ? ' 等' : ''}`;
    truthRefs.push(...shown.map((p) => personRef(p, detail)));
  }
  return {
    kind: on.has('gis') ? building.kind : '建筑',
    title: on.has('gis') ? building.name : commerce ? shop.name : `建筑 #${id}`,
    iri: `:building/${id}`,
    cls: commerce ? (shop.category === '咖啡' ? ':Cafe' : ':Shop') : ':Building',
    rows,
    truth,
    truthRefs,
  };
}

function vehicleCard(id: string, t: number, detail: boolean): Card {
  const vehicle = vehicleById.get(id)!;
  const state = vehicleAt(vehicle, t);
  const kind =
    vehicle.kind === 'bus'
      ? '公交'
      : vehicle.kind === 'taxi'
        ? '网约车'
        : vehicle.kind === 'van'
          ? '配送车'
          : '小汽车';
  const rows: CardRow[] = [
    {
      source: 'traffic',
      text: state
        ? `${state.waiting ? '等待红灯' : `${Math.round(state.speed * 3.6)} km/h`} · 坐标 (${Math.round(state.x)}, ${Math.round(state.y)})`
        : '此刻不在路上',
    },
  ];
  if (state) {
    const edge = edgeById.get(state.edge)!;
    rows.push({
      source: 'gis',
      text: state.waiting ? `停在 ${nodeById.get(state.node)!.name} 路口` : `行驶在 ${edge.name}`,
      refs: [state.waiting ? nodeRef(state.node) : edgeRef(edge.id)],
    });
  }
  if (vehicle.owner) {
    const owner = personById.get(vehicle.owner)!;
    const company = companyById.get(carOwners.find((c) => c.person === owner.id)!.companyId)!;
    const who = detail && owner.persona ? owner.name! : owner.id;
    rows.push({
      source: 'hr',
      text: `停车许可 · ${company.name}员工${detail && owner.persona ? ` ${who}` : `（${who}）`}`,
      refs: [
        { name: who, target: { type: 'person', id: owner.id } },
        { name: company.name, target: building(company.buildingId) },
      ],
    });
  }
  if (vehicle.kind === 'taxi' && vehicle.driver === 'P05') {
    rows.push({
      source: 'hr',
      text: detail ? '司机王磊 · 畅行出行员工（虚构）' : '司机为畅行出行员工（聚合视图不显示姓名）',
      refs: detail ? [{ name: '王磊', target: { type: 'person', id: 'P05' } }] : [],
    });
  }
  const day = dayOf(t);
  const { driver, passengers } = occupantsAt(id, t);
  if (vehicle.kind === 'bus') {
    const taps = tapsOf(day).filter(
      (tap) => tap.bus === id && tap.time <= t && tap.kind === 'board',
    );
    // 公交排班：午后在湖滨站换班
    const crew = busCrews.find((c) => c.bus === id)!;
    const handover = handoversOf(day).find((h) => h.bus === id);
    const shift = handover && t >= handover.arrive ? '晚班' : '早班';
    const onDuty = shift === '晚班' ? crew.late : crew.early;
    rows.push({
      source: 'mobility',
      text: `车上 ${busLoad(id, t)} 人 · 今日上车刷卡 ${taps.length} 次 · 当班司机 ${onDuty}（${shift}）`,
      refs: [{ name: onDuty, target: { type: 'person', id: onDuty } }],
    });
  }
  if (vehicle.kind === 'taxi') {
    const trips = tripsOf(day).filter((trip) => trip.vehicle === id);
    const current = trips.find((trip) => trip.request <= t && t < trip.arrive);
    const done = trips.filter((trip) => trip.arrive <= t).length;
    const who = personLabel(vehicle.driver!, detail);
    rows.push({
      source: 'mobility',
      text: current
        ? `司机 ${who} · ${t < current.pickup ? '前往接客' : '载客中'} · 乘客 ${personLabel(current.person, detail)} · 今日已完成 ${done} 单`
        : `司机 ${who} · 空车 · 今日已完成 ${done} 单`,
      refs: [
        personRef(vehicle.driver!, detail),
        ...(current ? [personRef(current.person, detail)] : []),
      ],
    });
  }
  let truth: string;
  const truthRefs: Ref[] = [];
  if (!state) truth = '此刻不在街区内的道路上';
  else if (!driver) truth = '停靠中，驾驶人不在车上';
  else {
    const role = vehicle.kind === 'bus' ? '司机' : vehicle.kind === 'van' ? '配送员' : '驾驶人';
    truth = `${role} ${personLabel(driver, detail)}`;
    truthRefs.push(personRef(driver, detail));
    // 车上的人：最多列出四位，可以逐个点开
    if (passengers.length) {
      const shown = passengers.slice(0, 4);
      truth += ` · 车上 ${shown.map((p) => personLabel(p, detail)).join('、')}`;
      if (passengers.length > shown.length) truth += ` 等 ${passengers.length} 人`;
      truthRefs.push(...shown.map((p) => personRef(p, detail)));
    }
    if (vehicle.role === 'through') truth += ' · 路过街区';
    if (vehicle.role === 'guest') truth += ' · 开车来访';
  }
  return {
    kind,
    title: vehicle.plate,
    iri: `:vehicle/${id}`,
    cls: vehicle.kind === 'bus' ? ':Bus' : vehicle.kind === 'taxi' ? ':Taxi' : ':Vehicle',
    rows,
    truth,
    truthRefs,
  };
}

function personCard(id: string, t: number, detail: boolean): Card {
  const person = personById.get(id)!;
  const day = dayOf(t);
  const rows: CardRow[] = [];
  const state = personAt(id, t);
  // 聚合视图只说明有哪类记录、有几条；明细视图给出具体内容
  if (person.kind === 'resident') {
    const today = events.filter(
      (e) => dayOf(e.start) === day && e.start <= t && e.attendees.includes(id),
    );
    const home = buildingName(person.homeId!);
    rows.push({
      source: 'community',
      text: [
        detail ? `登记居民 · 住在${home}` : '登记居民（聚合视图不显示住址）',
        ...today.map((e) => (detail ? `报名${e.title}` : '今日报名社区活动')),
      ].join(' · '),
      refs: detail
        ? [
            { name: home, target: building(person.homeId!) },
            ...today
              .filter((e) => e.venue.kind === 'building')
              .map((e) => ({ name: e.title, target: building(e.venue.id) })),
          ]
        : [],
    });
  }
  if (person.companyId) {
    const company = companyById.get(person.companyId)!;
    const session = sessionsOf(day).find((s) => s.personId === id && s.start <= t);
    const permit = vehicleByOwner.get(id);
    const parts = [`${company.name}员工`];
    const refs: Ref[] = company.buildingId
      ? [{ name: company.name, target: building(company.buildingId) }]
      : [];
    if (company.buildingId) {
      parts.push(
        !session
          ? '今日尚无门禁记录'
          : !detail
            ? '今日有门禁记录'
            : session.end <= t
              ? `今日 ${formatTime(session.start)} 进门，${formatTime(session.end)} 离开`
              : `今日 ${formatTime(session.start)} 进门`,
      );
    }
    if (permit) {
      parts.push(detail ? `停车许可 ${permit.plate}` : '有停车许可');
      if (detail) refs.push(vehicleRef(permit.id));
    }
    rows.push({ source: 'hr', text: parts.join(' · '), refs });
  }
  const taps = tapsOf(day).filter((tap) => tap.card === person.card && tap.time <= t);
  if (taps.length) {
    const last = taps.at(-1)!;
    rows.push({
      source: 'mobility',
      text: detail
        ? `公交卡 ${person.card} · 今日刷卡 ${taps.length} 次，最近 ${formatTime(last.time)} 在${nodeById.get(last.node)!.name}${last.kind === 'board' ? '上车' : '下车'}（${vehicleById.get(last.bus)!.plate}）`
        : `今日公交刷卡 ${taps.length} 次`,
      refs: detail ? [nodeRef(last.node), vehicleRef(last.bus)] : [],
    });
  }
  const orders = tripsOf(day).filter(
    (trip) => trip.kind === 'taxi' && trip.person === id && trip.request <= t,
  );
  if (orders.length) {
    const last = orders.at(-1)!;
    rows.push({
      source: 'mobility',
      text: detail
        ? `今日网约车订单 ${orders.length} 单，最近一单 ${vehicleById.get(last.vehicle)!.plate}`
        : `今日网约车订单 ${orders.length} 单`,
      refs: detail ? [vehicleRef(last.vehicle)] : [],
    });
  }
  const own = vehicleByDriver.get(id);
  if (own?.kind === 'taxi') {
    rows.push({
      source: 'mobility',
      text: `网约车司机 · ${own.plate}`,
      refs: [vehicleRef(own.id)],
    });
  }
  const crew = busCrews.find((c) => c.early === id || c.late === id);
  if (crew) {
    rows.push({
      source: 'mobility',
      text: `公交司机 · ${vehicleById.get(crew.bus)!.plate}${crew.early === id ? '早班' : '晚班'}`,
      refs: [vehicleRef(crew.bus)],
    });
  }
  if (person.member) {
    const bought = purchasesOf(day).filter((p) => p.member === person.member && p.time <= t);
    const total = bought.reduce((sum, p) => sum + p.amount, 0);
    const shop = bought.length ? shopById.get(bought.at(-1)!.shop)! : null;
    rows.push({
      source: 'commerce',
      text: !shop
        ? `会员${detail ? ` ${person.member}` : ''} · 今日尚无消费`
        : detail
          ? `会员 ${person.member} · 今日消费 ${bought.length} 笔，共 ${total} 元，最近在${shop.name}`
          : `会员 · 今日消费 ${bought.length} 笔`,
      refs: shop && detail ? [{ name: shop.name, target: building(shop.buildingId) }] : [],
    });
  }
  // 停车许可把车牌对应到人：开自己的车时，交通时序给出车辆位置
  const leg = state?.leg;
  if (leg?.mode === 'drive' && leg.vehicle && vehicleById.get(leg.vehicle)!.owner === id) {
    const v = vehicleAt(vehicleById.get(leg.vehicle)!, t);
    if (v) {
      const plate = vehicleById.get(leg.vehicle)!.plate;
      rows.push({
        source: 'traffic',
        text: `所驾车辆 ${plate} 此刻${v.waiting ? `停在 ${nodeById.get(v.node)!.name} 路口` : `行驶在 ${edgeById.get(v.edge)!.name}`}`,
        refs: [vehicleRef(leg.vehicle), v.waiting ? nodeRef(v.node) : edgeRef(v.edge)],
      });
    }
  }
  const kind =
    person.kind === 'resident'
      ? person.companyId
        ? '居民 · 员工'
        : '居民'
      : `外来人员${person.role ? ` · ${person.role}` : ''}`;
  const truth = state ? describeLeg(state.leg, person, detail) : null;
  return {
    kind,
    title: personLabel(id, detail),
    iri: `:person/${id}`,
    cls: person.companyId ? ':Employee' : ':Person',
    rows,
    truth: truth?.text ?? '此刻不在街区内',
    truthRefs: truth?.refs,
    empty: '各数据源中都没有此人的记录：只有模拟实况知道此人在这里。',
  };
}

const LIGHT = { green: '绿灯', yellow: '黄灯', red: '红灯' } as const;
const kmh = (speed: number) => Math.round(speed * 3.6);

function nodeCard(id: number, t: number, detail: boolean): Card {
  const node = nodeById.get(id)!;
  const gate = isGate(id);
  const rows: CardRow[] = [
    {
      source: 'gis',
      text: `${gate ? '街区出入口' : '路口'} · 坐标 (${node.x}, ${node.y})`,
    },
  ];
  const states = statesAt(t);
  const waiting = [...states.entries()]
    .filter(([, s]) => s.waiting && s.node === id)
    .map(([vehicle]) => vehicle);
  const shown = waiting.slice(0, 4);
  rows.push({
    source: 'traffic',
    text: [
      gate
        ? '没有信号灯'
        : `南北向${LIGHT[signalState(id, 'ns', t)]} · 东西向${LIGHT[signalState(id, 'ew', t)]}`,
      waiting.length
        ? `等灯 ${waiting.length} 辆（${(['ew', 'ns'] as const)
            .map(
              (axis) => [axis, waiting.filter((v) => states.get(v)!.axis === axis).length] as const,
            )
            .filter(([, n]) => n)
            .map(([axis, n]) => `${axis === 'ew' ? '东西向' : '南北向'} ${n} 辆`)
            .join(
              '，',
            )}）：${shown.map((v) => vehicleById.get(v)!.plate).join('、')}${waiting.length > shown.length ? ' 等' : ''}`
        : '此刻没有车辆等灯',
    ].join(' · '),
    refs: shown.map(vehicleRef),
  });
  const truthRefs: Ref[] = [];
  const parts: string[] = [];
  if (BUS_LOOP.includes(id)) {
    const next = stopVisits(dayOf(t)).find((v) => v.node === id && v.depart >= t);
    rows.push({
      source: 'mobility',
      text: next
        ? `公交站 · 下一班 ${vehicleById.get(next.bus)!.plate} ${t >= next.arrive ? '正在进站' : `${formatTime(next.arrive)} 到站`}`
        : '公交站 · 今日已收车',
      refs: next ? [vehicleRef(next.bus)] : [],
    });
    // 站台上候车的人
    const platform = platformOf(id);
    const waitingPeople = pedestriansAt(t)
      .filter(
        (p) =>
          p.leg.mode === 'wait' &&
          Math.hypot(p.leg.path[0].x - platform.x, p.leg.path[0].y - platform.y) < 1,
      )
      .map((p) => p.person);
    if (waitingPeople.length) {
      const names = waitingPeople.slice(0, detail ? 4 : 0);
      parts.push(
        `站台候车 ${waitingPeople.length} 人${names.length ? `：${names.map((p) => personLabel(p, detail)).join('、')}${waitingPeople.length > names.length ? ' 等' : ''}` : ''}`,
      );
      truthRefs.push(...names.map((p) => personRef(p, detail)));
    } else {
      parts.push('站台无人候车');
    }
  }
  const nearby = pedestriansAt(t).filter((p) => Math.hypot(p.x - node.x, p.y - node.y) < 40);
  parts.push(nearby.length ? `路口附近行人 ${nearby.length} 人` : '路口附近没有行人');
  return {
    kind: gate ? '出入口' : '路口',
    title: node.name,
    iri: `:intersection/${id}`,
    cls: ':Intersection',
    rows,
    truth: parts.join(' · '),
    truthRefs,
  };
}

function edgeCard(id: number, t: number): Card {
  const edge = edgeById.get(id)!;
  const states = statesAt(t);
  const on = [...states.entries()].filter(([, s]) => s.edge === id).map(([vehicle]) => vehicle);
  const moving = on.filter((v) => !states.get(v)!.waiting);
  const speeds = edgeSpeeds([[Math.max(t - 600, dayOf(t) * DAY), t]]);
  const average = speeds.get(id);
  const shown = on.slice(0, 4);
  return {
    kind: '路段',
    title: edge.name,
    iri: `:road/${id}`,
    cls: ':RoadSegment',
    rows: [
      { source: 'gis', text: `长 ${Math.round(edge.length)} 米` },
      {
        source: 'traffic',
        text: [
          `此刻 ${on.length} 辆车${on.length ? `（行驶 ${moving.length} 辆）` : ''}`,
          average ? `近 10 分钟平均车速 ${kmh(average)} km/h` : '近 10 分钟没有车辆驶过',
        ].join(' · '),
      },
    ],
    truth: on.length
      ? `路上：${shown.map((v) => vehicleById.get(v)!.plate).join('、')}${on.length > shown.length ? ' 等' : ''}`
      : '此刻路上没有车',
    truthRefs: shown.map(vehicleRef),
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

/** 结果行对应的实体（公园中的地点没有详情卡片）。 */
function selectionFor(focus: FocusTarget): Selection | null {
  switch (focus.type) {
    case 'persona':
      return { type: 'person', id: focus.id };
    case 'point':
      return null;
    default:
      return focus as Selection;
  }
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
    case 'commuteCars': {
      if (key.startsWith('d')) {
        const vehicle = vehicleByOwner.get(key.slice(1));
        return vehicle ? { type: 'vehicle', id: vehicle.id } : null;
      }
      const company = companyById.get(Number(key.slice(1)));
      return company?.buildingId ? { type: 'building', id: company.buildingId } : null;
    }
    case 'weatherTaxi': {
      if (!key.startsWith('o')) return null;
      const id = key.slice(1);
      for (let day = 0; day < DAY_COUNT; day++) {
        const trip = tripsOf(day).find((t) => t.id === id);
        if (trip) return { type: 'vehicle', id: trip.vehicle };
      }
      return null;
    }
    case 'busShopping': {
      const shop = shopById.get(Number(key.slice(key.startsWith('m') ? 1 : 4).split(':')[0]));
      return shop ? { type: 'building', id: shop.buildingId } : null;
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
  const viewButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-city-view]')];
  const layersButton = viewButtons.find((button) => button.dataset.cityView === 'layers')!;
  const hint = root.querySelector<HTMLElement>('[data-city-hint]')!;
  const resetButton = root.querySelector<HTMLButtonElement>('[data-city-reset]')!;
  const nightButton = root.querySelector<HTMLButtonElement>('[data-city-night]')!;
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
  /** 从卡片中的链接跳转过来时，之前看过的对象，用于返回。 */
  let trail: Selection[] = [];
  let cardCollapsed = false;
  let nightView = readNightView();
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
    const toLayers = result.entities.length
      ? '<button type="button" class="to-layers" data-city-to-layers>在分层视图中查看</button>'
      : '';
    const html = `
      <p class="results-head${result.status === 'unavailable' ? ' is-unavailable' : ''}">结果 <span>${escapeHtml(result.summary)}</span>${toLayers}</p>
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
        ? buildingCard(selection.id, t, sources, detail)
        : selection.type === 'vehicle'
          ? vehicleCard(selection.id, t, detail)
          : selection.type === 'person'
            ? personCard(selection.id, t, detail)
            : selection.type === 'node'
              ? nodeCard(selection.id, t, detail)
              : selection.type === 'edge'
                ? edgeCard(selection.id, t)
                : sensorCard(selection.id, t);
    // 同一数据源可能有多条记录（如商店的客流计数器与屋顶传感器），按数据源计数
    const connected = [...new Set(data.rows.map((row) => row.source))].filter((id) =>
      sources.has(id),
    );
    const foot =
      connected.length >= 2
        ? `${connected.length} 个数据源的记录映射到同一个 IRI，在图谱中是同一个实体。<button type="button" class="to-layers" data-city-to-layers>在分层视图中查看</button>`
        : connected.length === 1
          ? '目前只有一个已接入的数据源描述它。'
          : !data.rows.length && data.empty
            ? escapeHtml(data.empty)
            : '没有已接入的数据源描述它。';
    const truth = data.truth
      ? `<p class="card-truth"><span>模拟实况</span><span class="card-text">${linkify(data.truth, data.truthRefs)}</span></p>`
      : '';
    const rows = data.rows
      .map((row) => {
        const source = sourceById.get(row.source)!;
        const on = sources.has(row.source);
        return `<li${on ? '' : ' class="is-off"'} style="--source:${source.color}"><span class="card-source">${escapeHtml(source.name)}</span><span class="card-text">${on ? linkify(row.text, row.refs) : '未接入'}</span></li>`;
      })
      .join('');
    const previous = trail.at(-1);
    const back = previous
      ? `<button type="button" class="card-back" data-card-back>← 返回 ${escapeHtml(selectionTitle(previous, detail))}</button>`
      : '';
    const html = `
      ${back}
      <div class="card-head">
        <div>
          <p class="card-kind">${escapeHtml(data.kind)}</p>
          <h3 class="card-title">${escapeHtml(data.title)}</h3>
        </div>
        <div class="card-actions">
          <button type="button" class="card-close" data-card-collapse aria-expanded="${!cardCollapsed}" aria-label="${cardCollapsed ? '展开详情' : '收起详情'}" title="${cardCollapsed ? '展开' : '收起'}">${cardCollapsed ? CHEVRON_UP : CHEVRON_DOWN}</button>
          <button type="button" class="card-close" data-card-close aria-label="关闭详情" title="关闭">${CLOSE_ICON}</button>
        </div>
      </div>
      <p class="card-iri"><code>${escapeHtml(data.iri)}</code><span>${escapeHtml(data.cls)}</span></p>
      ${rows ? `<ul class="card-rows" role="list">${rows}</ul>` : ''}
      ${truth}
      <p class="card-foot">${foot}</p>`;
    if (html !== lastCardHtml) {
      lastCardHtml = html;
      card.innerHTML = html;
    }
    card.classList.toggle('is-collapsed', cardCollapsed);
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

  /** via：在场景中点选（清空返回记录）、从卡片链接跳转（记下当前对象），或返回上一个对象。 */
  const select = (next: Selection | null, via: 'scene' | 'link' | 'back' = 'scene') => {
    if (via === 'link' && selection) trail.push(selection);
    else if (via === 'scene') trail = [];
    if (!sameSelection(next, selection)) cardCollapsed = false;
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
      if (!focus) return;
      scene?.focus(focus);
      // 同时打开该实体的详情卡片
      const next = selectionFor(focus);
      if (next) select(next);
    },
    { signal },
  );
  card.addEventListener(
    'click',
    (event) => {
      const target = event.target as Element;
      const link = target.closest<HTMLElement>('[data-card-link]');
      if (target.closest('[data-card-close]')) select(null);
      else if (target.closest('[data-card-collapse]')) {
        cardCollapsed = !cardCollapsed;
        renderCard();
      } else if (target.closest('[data-card-back]')) {
        const previous = trail.pop();
        if (previous) select(previous, 'back');
      } else if (link) {
        select(parseSelection(link.dataset.cardLink!), 'link');
      } else if (cardCollapsed && target.closest('.card-head')) {
        cardCollapsed = false;
        renderCard();
      }
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

  // ── 夜景显示：场景始终按夜间光照呈现，模拟时间不变 ──
  const syncNightButton = () => {
    nightButton.setAttribute('aria-pressed', String(nightView));
    nightButton.title = nightView ? '夜景显示：已开启' : '夜景显示：光照跟随模拟时间';
  };
  nightButton.addEventListener(
    'click',
    () => {
      nightView = !nightView;
      scene?.setNightView(nightView);
      syncNightButton();
      try {
        localStorage.setItem(NIGHT_KEY, nightView ? 'on' : 'off');
      } catch {
        // 隐私模式下 localStorage 可能不可用，忽略即可。
      }
    },
    { signal },
  );
  syncNightButton();

  const syncViewButton = () => {
    root.dataset.view = view;
    for (const button of viewButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.cityView === view));
    }
  };

  // ── 分层视图的引导：第一次看到场景时提示一次，看过分层视图或关闭提示后不再出现 ──
  const HINT_KEY = 'city-layers-seen';
  const hintSeen = () => {
    try {
      return localStorage.getItem(HINT_KEY) === '1';
    } catch {
      return false;
    }
  };
  const dismissHint = () => {
    hint.hidden = true;
    layersButton.classList.remove('is-new');
    try {
      localStorage.setItem(HINT_KEY, '1');
    } catch {
      // 隐私模式下 localStorage 可能不可用，忽略即可。
    }
  };
  const showHint = () => {
    if (hintSeen() || view !== 'city' || signal.aborted) return;
    hint.hidden = false;
    // 小三角对准分层按钮
    const tools = hint.parentElement!.getBoundingClientRect();
    const button = layersButton.getBoundingClientRect();
    hint.style.setProperty('--arrow', `${tools.right - (button.left + button.width / 2)}px`);
  };
  if (!hintSeen()) layersButton.classList.add('is-new');

  const setView = (next: View) => {
    if (next === view) return;
    view = next;
    scene?.setView(view);
    syncViewButton();
    if (view === 'layers') dismissHint();
  };
  for (const button of viewButtons) {
    button.addEventListener('click', () => setView(button.dataset.cityView as View), { signal });
  }
  root.addEventListener(
    'click',
    (event) => {
      if ((event.target as Element).closest('[data-city-to-layers]')) setView('layers');
    },
    { signal },
  );
  root
    .querySelector('[data-city-hint-go]')!
    .addEventListener('click', () => setView('layers'), { signal });
  root.querySelector('[data-city-hint-close]')!.addEventListener('click', dismissHint, { signal });

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
        { view, reducedMotion: reduced, t, sources, detail, nightView },
      );
      stage.classList.add('is-ready');
      status.textContent = '';
      scene.setInsets(insets());
      scene.resetView();
      scene.setTime(t, playing, speed);
      lastSelectionKey = '';
      refresh(true);
      if (!reduced) setPlaying(true);
      window.setTimeout(showHint, 1500);
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
