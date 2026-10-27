/**
 * “VKG × 城市数据融合”示例的页面控制：查询分组与切换、数据源开关、聚合与明细、模拟时间轴、
 * 结果列表、对象详情卡片，以及三维场景的按需加载与全屏。
 */
import { city } from '../../lib/geo/city';
import { capitalize, term } from '../../lib/geo/names';
import { tr } from '../../i18n/runtime';
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
import type {
  CityScene,
  CityTourStep,
  FocusTarget,
  InfoTarget,
  Insets,
  Selection,
  SelectionInfo,
  View,
} from './scene';
import { infoCard, type ClassUsage } from './info';

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

const buildingName = (id: number) => {
  const building = city.buildings.find((b) => b.id === id);
  return building ? term(building.name) : tr(`建筑 #${id}`, `Building #${id}`);
};
const plateOf = (id: string) => term(vehicleById.get(id)!.plate);
const nodeName = (id: number) => term(nodeById.get(id)!.name);
const edgeName = (id: number) => term(edgeById.get(id)!.name);
/** 列举：中文用顿号，英文用逗号。 */
const list = (items: string[]) => items.join(tr('、', ', '));
const more = (shown: number, total: number) => (total > shown ? tr(' 等', ' and others') : '');

/** 人物在卡片与说明中的称呼：明细视图中具名人物显示姓名，其余显示编号。 */
function personLabel(id: string, detail: boolean): string {
  const person = personById.get(id);
  if (!person) return id;
  if (detail && person.persona) return term(person.name!);
  return person.kind === 'resident'
    ? tr(`居民 ${id}`, `Resident ${id}`)
    : tr(`外来人员 ${id}`, `Non-resident ${id}`);
}

const building = (id: number): Selection => ({ type: 'building', id });
const vehicleRef = (id: string): Ref => ({
  name: plateOf(id),
  target: { type: 'vehicle', id },
});
const nodeRef = (id: number): Ref => ({
  name: nodeName(id),
  target: { type: 'node', id },
});
const edgeRef = (id: number): Ref => ({
  name: edgeName(id),
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
  const plate = leg.vehicle ? plateOf(leg.vehicle) : '';
  // 英文的具名人物行程以动词开头（如 “Walk to North Station”），接在方式之后时去掉动词
  const after = (verb: string) => leg.label.replace(new RegExp(`^${verb} `), '');
  let text: string;
  switch (leg.mode) {
    case 'walk':
      text = tr(`步行 · ${leg.label}`, `Walking · ${after('Walk')}`);
      break;
    case 'bus':
      text = tr(`在${plate}上 · ${leg.label}`, `On ${plate} · ${after('Bus')}`);
      break;
    case 'drive':
      text = tr(`驾驶 ${plate} · ${leg.label}`, `Driving ${plate} · ${after('Drive')}`);
      break;
    case 'ride':
      text = tr(`乘坐 ${plate}`, `Riding in ${plate}`);
      break;
    case 'taxi':
      text = tr(
        `乘网约车 ${plate} · ${leg.label}`,
        `In ride-hailing car ${plate} · ${after('Ride-hailing car')}`,
      );
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
      return plateOf(selection.id);
    case 'person':
      return personLabel(selection.id, detail);
    case 'sensor':
      return selection.id;
    case 'node':
      return nodeName(selection.id);
    case 'edge':
      return edgeName(selection.id);
  }
}

/** 某人此刻在哪里（简短，接在称呼之后）：所在建筑、所乘车辆或正在步行。 */
function whereabouts(id: string, t: number): string {
  const state = personAt(id, t);
  if (!state) return tr('不在街区', ' outside the district');
  const leg = state.leg;
  if (leg.vehicle && isRide(leg.mode))
    return tr(`在${plateOf(leg.vehicle)}上`, ` on ${plateOf(leg.vehicle)}`);
  if (leg.building !== undefined)
    return tr(`在${buildingName(leg.building)}`, ` at ${buildingName(leg.building)}`);
  if (leg.mode === 'walk') return tr('步行中', ' walking');
  return tr(leg.label, ` (${leg.label})`);
}

function buildingCard(id: number, t: number, on: ReadonlySet<SourceId>, detail: boolean): Card {
  const building = city.buildings.find((b) => b.id === id)!;
  const shop = shopByBuilding.get(id);
  const company = companies.find((c) => c.buildingId === id);
  const residents = people.filter((p) => p.homeId === id).map((p) => p.id);
  const hosted = events.filter((e) => e.venue.kind === 'building' && e.venue.id === id);
  const rows: CardRow[] = [
    {
      source: 'gis',
      text: tr(
        `${building.kind} · ${building.floors} 层`,
        `${capitalize(term(building.kind))} · ${building.floors} floors`,
      ),
    },
  ];
  if (shop) {
    rows.push({
      source: 'commerce',
      text: `${term(shop.name)} · ${capitalize(term(shop.category))} · ${formatTime(shop.open[0])}–${formatTime(shop.open[1])}`,
    });
    const hour = footfallCount(shop, t - 3600, t);
    const today = footfallCount(shop, startOfDay(dayOf(t)), t);
    rows.push({
      source: 'iot',
      text: tr(
        `计数器 ${shop.sensor} · 近一小时进店 ${hour} 人 · 今日累计 ${today} 人`,
        `Counter ${shop.sensor} · ${hour} visitors in the last hour · ${today} today`,
      ),
    });
  }
  for (const sensor of ENV_SENSORS.filter((s) => s.buildingId === id)) {
    const reading = readingAt(sensor, t);
    rows.push({
      source: 'iot',
      text: reading
        ? tr(
            `屋顶温湿度传感器 ${sensor.id} · ${reading.temperature.toFixed(1)}°C · ${reading.humidity}%`,
            `Rooftop sensor ${sensor.id} · ${reading.temperature.toFixed(1)}°C · ${reading.humidity}%`,
          )
        : tr(`屋顶温湿度传感器 ${sensor.id} · 离线`, `Rooftop sensor ${sensor.id} · offline`),
    });
  }
  if (company) {
    rows.push({
      source: 'hr',
      text: tr(
        `${company.name} · 此刻在岗 ${presence(company.id, t)} 人`,
        `${term(company.name)} · ${presence(company.id, t)} present now`,
      ),
    });
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
            ? tr(
                `登记住户 ${residents.length} 人：${roster.join('、')}`,
                `${residents.length} registered residents: ${roster.join(', ')}`,
              )
            : tr(
                `登记住户 ${residents.length} 人（明细视图中列出住户）`,
                `${residents.length} registered residents (listed in the detail view)`,
              )
          : '',
        ...hosted
          .filter((e) => dayOf(e.start) === dayOf(t))
          .map((e) => `${term(e.title)} ${formatTime(e.start)}–${formatTime(e.end)}`),
      ]
        .filter(Boolean)
        .join(' · '),
    });
  }
  const commerce = shop && on.has('commerce');
  const inside = peopleInside(id, t);
  let truth = inside.length
    ? tr(`此刻楼内 ${inside.length} 人`, `${inside.length} people inside now`)
    : tr('此刻楼内无人', 'Nobody inside now');
  const truthRefs: Ref[] = [];
  if (detail && residents.length) {
    // 住户在家几人，外出的人此刻在哪里
    const out = residents.filter((r) => !inside.includes(r));
    truth += tr(
      ` · 住户在家 ${residents.length - out.length} 人`,
      ` · ${residents.length - out.length} residents at home`,
    );
    if (out.length) {
      const shown = out.slice(0, 4);
      const where = list(shown.map((r) => `${personLabel(r, detail)}${whereabouts(r, t)}`));
      truth += tr(`，外出 ${out.length} 人：${where}`, `, ${out.length} out: ${where}`);
      truth += more(shown.length, out.length);
      truthRefs.push(...shown.map((r) => personRef(r, detail)));
    }
  } else if (detail && inside.length) {
    const shown = inside.slice(0, 4);
    truth += `${tr('：', ': ')}${list(shown.map((p) => personLabel(p, detail)))}${more(shown.length, inside.length)}`;
    truthRefs.push(...shown.map((p) => personRef(p, detail)));
  }
  return {
    kind: on.has('gis') ? capitalize(term(building.kind)) : tr('建筑', 'Building'),
    title: on.has('gis')
      ? term(building.name)
      : commerce
        ? term(shop.name)
        : tr(`建筑 #${id}`, `Building #${id}`),
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
      ? tr('公交', 'Bus')
      : vehicle.kind === 'taxi'
        ? tr('网约车', 'Ride-hailing car')
        : vehicle.kind === 'van'
          ? tr('配送车', 'Delivery van')
          : tr('小汽车', 'Car');
  const rows: CardRow[] = [
    {
      source: 'traffic',
      text: state
        ? `${state.waiting ? tr('等待红灯', 'Waiting at a red light') : `${Math.round(state.speed * 3.6)} km/h`} · ${tr('坐标', 'position')} (${Math.round(state.x)}, ${Math.round(state.y)})`
        : tr('此刻不在路上', 'Not on the road now'),
    },
  ];
  if (state) {
    const edge = edgeById.get(state.edge)!;
    rows.push({
      source: 'gis',
      text: state.waiting
        ? tr(`停在 ${nodeName(state.node)} 路口`, `Stopped at ${nodeName(state.node)}`)
        : tr(`行驶在 ${term(edge.name)}`, `Driving on ${term(edge.name)}`),
      refs: [state.waiting ? nodeRef(state.node) : edgeRef(edge.id)],
    });
  }
  if (vehicle.owner) {
    const owner = personById.get(vehicle.owner)!;
    const company = companyById.get(carOwners.find((c) => c.person === owner.id)!.companyId)!;
    const who = detail && owner.persona ? term(owner.name!) : owner.id;
    const employer = term(company.name);
    rows.push({
      source: 'hr',
      text: tr(
        `停车许可 · ${company.name}员工${detail && owner.persona ? ` ${who}` : `（${who}）`}`,
        `Parking permit · ${employer} employee ${detail && owner.persona ? who : `(${who})`}`,
      ),
      refs: [
        { name: who, target: { type: 'person', id: owner.id } },
        { name: employer, target: building(company.buildingId) },
      ],
    });
  }
  if (vehicle.kind === 'taxi' && vehicle.driver === 'P05') {
    rows.push({
      source: 'hr',
      text: detail
        ? tr('司机王磊 · 畅行出行员工（虚构）', 'Driver Wang Lei · SmoothRide employee (fictional)')
        : tr(
            '司机为畅行出行员工（聚合视图不显示姓名）',
            'The driver is a SmoothRide employee (name hidden in the aggregate view)',
          ),
      refs: detail ? [{ name: term('王磊'), target: { type: 'person', id: 'P05' } }] : [],
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
    const late = Boolean(handover && t >= handover.arrive);
    const onDuty = late ? crew.late : crew.early;
    rows.push({
      source: 'mobility',
      text: tr(
        `车上 ${busLoad(id, t)} 人 · 今日上车刷卡 ${taps.length} 次 · 当班司机 ${onDuty}（${late ? '晚班' : '早班'}）`,
        `${busLoad(id, t)} on board · ${taps.length} boarding taps today · driver on duty ${onDuty} (${late ? 'late' : 'early'} shift)`,
      ),
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
        ? tr(
            `司机 ${who} · ${t < current.pickup ? '前往接客' : '载客中'} · 乘客 ${personLabel(current.person, detail)} · 今日已完成 ${done} 单`,
            `Driver ${who} · ${t < current.pickup ? 'on the way to pick up' : 'with passenger'} · passenger ${personLabel(current.person, detail)} · ${done} trips completed today`,
          )
        : tr(
            `司机 ${who} · 空车 · 今日已完成 ${done} 单`,
            `Driver ${who} · vacant · ${done} trips completed today`,
          ),
      refs: [
        personRef(vehicle.driver!, detail),
        ...(current ? [personRef(current.person, detail)] : []),
      ],
    });
  }
  let truth: string;
  const truthRefs: Ref[] = [];
  if (!state) truth = tr('此刻不在街区内的道路上', 'Not on a road in the district now');
  else if (!driver) truth = tr('停靠中，驾驶人不在车上', 'Parked; the driver is not on board');
  else {
    const role =
      vehicle.kind === 'bus'
        ? tr('司机', 'Driver')
        : vehicle.kind === 'van'
          ? tr('配送员', 'Courier')
          : tr('驾驶人', 'Driver');
    truth = `${role} ${personLabel(driver, detail)}`;
    truthRefs.push(personRef(driver, detail));
    // 车上的人：最多列出四位，可以逐个点开
    if (passengers.length) {
      const shown = passengers.slice(0, 4);
      const names = list(shown.map((p) => personLabel(p, detail)));
      truth += tr(` · 车上 ${names}`, ` · on board: ${names}`);
      if (passengers.length > shown.length)
        truth += tr(` 等 ${passengers.length} 人`, ` (${passengers.length} in total)`);
      truthRefs.push(...shown.map((p) => personRef(p, detail)));
    }
    if (vehicle.role === 'through') truth += tr(' · 路过街区', ' · passing through');
    if (vehicle.role === 'guest') truth += tr(' · 开车来访', ' · visiting by car');
  }
  return {
    kind,
    title: term(vehicle.plate),
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
        detail
          ? tr(`登记居民 · 住在${home}`, `Registered resident · lives at ${home}`)
          : tr(
              '登记居民（聚合视图不显示住址）',
              'Registered resident (address hidden in the aggregate view)',
            ),
        ...today.map((e) =>
          detail
            ? tr(`报名${e.title}`, `signed up for ${term(e.title)}`)
            : tr('今日报名社区活动', 'signed up for a community event today'),
        ),
      ].join(' · '),
      refs: detail
        ? [
            { name: home, target: building(person.homeId!) },
            ...today
              .filter((e) => e.venue.kind === 'building')
              .map((e) => ({ name: term(e.title), target: building(e.venue.id) })),
          ]
        : [],
    });
  }
  if (person.companyId) {
    const company = companyById.get(person.companyId)!;
    const session = sessionsOf(day).find((s) => s.personId === id && s.start <= t);
    const permit = vehicleByOwner.get(id);
    const employer = term(company.name);
    const parts = [tr(`${company.name}员工`, `Employee of ${employer}`)];
    const refs: Ref[] = company.buildingId
      ? [{ name: employer, target: building(company.buildingId) }]
      : [];
    if (company.buildingId) {
      parts.push(
        !session
          ? tr('今日尚无门禁记录', 'no access records today')
          : !detail
            ? tr('今日有门禁记录', 'access records today')
            : session.end <= t
              ? tr(
                  `今日 ${formatTime(session.start)} 进门，${formatTime(session.end)} 离开`,
                  `in at ${formatTime(session.start)}, out at ${formatTime(session.end)} today`,
                )
              : tr(
                  `今日 ${formatTime(session.start)} 进门`,
                  `in at ${formatTime(session.start)} today`,
                ),
      );
    }
    if (permit) {
      parts.push(
        detail
          ? tr(`停车许可 ${term(permit.plate)}`, `parking permit ${term(permit.plate)}`)
          : tr('有停车许可', 'has a parking permit'),
      );
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
        ? tr(
            `公交卡 ${person.card} · 今日刷卡 ${taps.length} 次，最近 ${formatTime(last.time)} 在${nodeName(last.node)}${last.kind === 'board' ? '上车' : '下车'}（${plateOf(last.bus)}）`,
            `Transit card ${person.card} · ${taps.length} taps today, last at ${formatTime(last.time)}: ${last.kind === 'board' ? 'boarded' : 'alighted'} at ${nodeName(last.node)} (${plateOf(last.bus)})`,
          )
        : tr(`今日公交刷卡 ${taps.length} 次`, `${taps.length} transit taps today`),
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
        ? tr(
            `今日网约车订单 ${orders.length} 单，最近一单 ${plateOf(last.vehicle)}`,
            `${orders.length} ride orders today, the latest with ${plateOf(last.vehicle)}`,
          )
        : tr(`今日网约车订单 ${orders.length} 单`, `${orders.length} ride orders today`),
      refs: detail ? [vehicleRef(last.vehicle)] : [],
    });
  }
  const own = vehicleByDriver.get(id);
  if (own?.kind === 'taxi') {
    rows.push({
      source: 'mobility',
      text: tr(`网约车司机 · ${term(own.plate)}`, `Ride-hailing driver · ${term(own.plate)}`),
      refs: [vehicleRef(own.id)],
    });
  }
  const crew = busCrews.find((c) => c.early === id || c.late === id);
  if (crew) {
    rows.push({
      source: 'mobility',
      text: tr(
        `公交司机 · ${plateOf(crew.bus)}${crew.early === id ? '早班' : '晚班'}`,
        `Bus driver · ${plateOf(crew.bus)}, ${crew.early === id ? 'early' : 'late'} shift`,
      ),
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
        ? tr(
            `会员${detail ? ` ${person.member}` : ''} · 今日尚无消费`,
            `Member${detail ? ` ${person.member}` : ''} · no purchases today`,
          )
        : detail
          ? tr(
              `会员 ${person.member} · 今日消费 ${bought.length} 笔，共 ${total} 元，最近在${shop.name}`,
              `Member ${person.member} · ${bought.length} purchases today, ¥${total} in total, latest at ${term(shop.name)}`,
            )
          : tr(`会员 · 今日消费 ${bought.length} 笔`, `Member · ${bought.length} purchases today`),
      refs: shop && detail ? [{ name: term(shop.name), target: building(shop.buildingId) }] : [],
    });
  }
  // 停车许可把车牌对应到人：开自己的车时，交通时序给出车辆位置
  const leg = state?.leg;
  if (leg?.mode === 'drive' && leg.vehicle && vehicleById.get(leg.vehicle)!.owner === id) {
    const v = vehicleAt(vehicleById.get(leg.vehicle)!, t);
    if (v) {
      const plate = plateOf(leg.vehicle);
      rows.push({
        source: 'traffic',
        text: tr(
          `所驾车辆 ${plate} 此刻${v.waiting ? `停在 ${nodeName(v.node)} 路口` : `行驶在 ${edgeName(v.edge)}`}`,
          `Car ${plate} is ${v.waiting ? `stopped at ${nodeName(v.node)}` : `driving on ${edgeName(v.edge)}`}`,
        ),
        refs: [vehicleRef(leg.vehicle), v.waiting ? nodeRef(v.node) : edgeRef(v.edge)],
      });
    }
  }
  const kind =
    person.kind === 'resident'
      ? person.companyId
        ? tr('居民 · 员工', 'Resident · employee')
        : tr('居民', 'Resident')
      : `${tr('外来人员', 'Non-resident')}${person.role ? ` · ${term(person.role)}` : ''}`;
  const truth = state ? describeLeg(state.leg, person, detail) : null;
  return {
    kind,
    title: personLabel(id, detail),
    iri: `:person/${id}`,
    cls: person.companyId ? ':Employee' : ':Person',
    rows,
    truth: truth?.text ?? tr('此刻不在街区内', 'Outside the district now'),
    truthRefs: truth?.refs,
    empty: tr(
      '各数据源中都没有此人的记录：只有模拟实况知道此人在这里。',
      'No source has any record of this person; only the simulation knows they are here.',
    ),
  };
}

const light = (state: 'green' | 'yellow' | 'red') =>
  ({
    green: tr('绿灯', 'green'),
    yellow: tr('黄灯', 'yellow'),
    red: tr('红灯', 'red'),
  })[state];
const kmh = (speed: number) => Math.round(speed * 3.6);

function nodeCard(id: number, t: number, detail: boolean): Card {
  const node = nodeById.get(id)!;
  const gate = isGate(id);
  const rows: CardRow[] = [
    {
      source: 'gis',
      text: `${gate ? tr('街区出入口', 'District entrance') : tr('路口', 'Intersection')} · ${tr('坐标', 'position')} (${node.x}, ${node.y})`,
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
        ? tr('没有信号灯', 'No traffic lights')
        : tr(
            `南北向${light(signalState(id, 'ns', t))} · 东西向${light(signalState(id, 'ew', t))}`,
            `North–south ${light(signalState(id, 'ns', t))} · east–west ${light(signalState(id, 'ew', t))}`,
          ),
      waiting.length
        ? (() => {
            const axes = (['ew', 'ns'] as const)
              .map(
                (axis) =>
                  [axis, waiting.filter((v) => states.get(v)!.axis === axis).length] as const,
              )
              .filter(([, n]) => n)
              .map(([axis, n]) =>
                tr(
                  `${axis === 'ew' ? '东西向' : '南北向'} ${n} 辆`,
                  `${n} ${axis === 'ew' ? 'east–west' : 'north–south'}`,
                ),
              )
              .join(tr('，', ', '));
            const plates = `${list(shown.map(plateOf))}${more(shown.length, waiting.length)}`;
            return tr(
              `等灯 ${waiting.length} 辆（${axes}）：${plates}`,
              `${waiting.length} waiting at the light (${axes}): ${plates}`,
            );
          })()
        : tr('此刻没有车辆等灯', 'No vehicles waiting at the light'),
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
        ? tr(
            `公交站 · 下一班 ${plateOf(next.bus)} ${t >= next.arrive ? '正在进站' : `${formatTime(next.arrive)} 到站`}`,
            `Bus stop · next bus ${plateOf(next.bus)} ${t >= next.arrive ? 'arriving now' : `at ${formatTime(next.arrive)}`}`,
          )
        : tr('公交站 · 今日已收车', 'Bus stop · service has ended for today'),
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
      const who = names.length
        ? `${tr('：', ': ')}${list(names.map((p) => personLabel(p, detail)))}${more(names.length, waitingPeople.length)}`
        : '';
      parts.push(
        tr(
          `站台候车 ${waitingPeople.length} 人${who}`,
          `${waitingPeople.length} waiting at the platform${who}`,
        ),
      );
      truthRefs.push(...names.map((p) => personRef(p, detail)));
    } else {
      parts.push(tr('站台无人候车', 'Nobody waiting at the platform'));
    }
  }
  const nearby = pedestriansAt(t).filter((p) => Math.hypot(p.x - node.x, p.y - node.y) < 40);
  parts.push(
    nearby.length
      ? tr(`路口附近行人 ${nearby.length} 人`, `${nearby.length} pedestrians nearby`)
      : tr('路口附近没有行人', 'No pedestrians nearby'),
  );
  return {
    kind: gate ? tr('出入口', 'Entrance') : tr('路口', 'Intersection'),
    title: term(node.name),
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
    kind: tr('路段', 'Road segment'),
    title: term(edge.name),
    iri: `:road/${id}`,
    cls: ':RoadSegment',
    rows: [
      {
        source: 'gis',
        text: tr(`长 ${Math.round(edge.length)} 米`, `${Math.round(edge.length)} m long`),
      },
      {
        source: 'traffic',
        text: [
          tr(
            `此刻 ${on.length} 辆车${on.length ? `（行驶 ${moving.length} 辆）` : ''}`,
            `${on.length} vehicles now${on.length ? ` (${moving.length} moving)` : ''}`,
          ),
          average
            ? tr(
                `近 10 分钟平均车速 ${kmh(average)} km/h`,
                `average speed over the last 10 minutes ${kmh(average)} km/h`,
              )
            : tr('近 10 分钟没有车辆驶过', 'no vehicles in the last 10 minutes'),
        ].join(' · '),
      },
    ],
    truth: on.length
      ? `${tr('路上：', 'On the road: ')}${list(shown.map(plateOf))}${more(shown.length, on.length)}`
      : tr('此刻路上没有车', 'No vehicles on the road now'),
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
        ? tr(
            `${reading.temperature.toFixed(1)}°C · 湿度 ${reading.humidity}% · ${formatTime(reading.ts)} 上报`,
            `${reading.temperature.toFixed(1)}°C · humidity ${reading.humidity}% · reported at ${formatTime(reading.ts)}`,
          )
        : tr('离线，没有最新读数', 'Offline, no recent reading'),
    },
    { source: 'gis', text: `${placeOf(sensor)} · ${term(sensor.mount)}` },
    {
      source: 'weather',
      text:
        tr(
          `气象站 ${station.temperature.toFixed(1)}°C · 湿度 ${station.humidity}%`,
          `Weather station ${station.temperature.toFixed(1)}°C · humidity ${station.humidity}%`,
        ) +
        (reading
          ? ` · ${tr('温差', 'difference')} ${reading.temperature - station.temperature >= 0 ? '+' : '−'}${Math.abs(reading.temperature - station.temperature).toFixed(1)}°C`
          : ''),
    },
  ];
  return {
    kind: tr('温湿度传感器', 'Temperature and humidity sensor'),
    title: id,
    iri: `:sensor/${id}`,
    cls: ':EnvSensor',
    rows,
  };
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

  const queries = cityQueries();
  let active: CityQuery = queries[0];
  let t = active.suggest;
  let detail = true;
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
  /** 详情卡片中显示的数据源、层或类的介绍；与对象详情互斥。 */
  let infoTarget: InfoTarget | null = null;
  let lastResult: CityResult | null = null;
  let classUsage: ClassUsage | null = null;
  /** 各类出现在哪些查询中：按每条查询的建议时刻求值一次。 */
  const usage = (): ClassUsage => {
    if (!classUsage) {
      classUsage = new Map();
      for (const query of queries) {
        const result = query.run({ t: query.suggest, sources: new Set(ALL_SOURCES), detail: true });
        for (const cls of result.classes) {
          classUsage.set(cls, [...(classUsage.get(cls) ?? []), query.id]);
        }
      }
    }
    return classUsage;
  };

  // ── 结果 ──
  const renderResult = (result: CityResult) => {
    rowTargets = result.rows.map((row) => focusFor(active, row));
    const notes = result.notes
      .map(
        (note) =>
          `<li${note.includes(tr('未接入', 'not connected')) ? ' class="is-missing"' : ''}>${escapeHtml(note)}</li>`,
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
      ? `<button type="button" class="to-layers" data-city-to-layers>${tr('在分层视图中查看', 'View in the layered view')}</button>`
      : '';
    const html = `
      <p class="results-head${result.status === 'unavailable' ? ' is-unavailable' : ''}">${tr('结果', 'Results')} <span>${escapeHtml(result.summary)}</span>${toLayers}</p>
      ${notes ? `<ul class="notes" role="list">${notes}</ul>` : ''}
      ${rows ? `<ul role="list">${rows}</ul>` : ''}`;
    if (html !== lastResultHtml) {
      lastResultHtml = html;
      resultBox.innerHTML = html;
    }
  };

  // ── 详情卡片 ──
  const renderCard = () => {
    if (infoTarget) {
      const html = infoCard(infoTarget, sources, queries, lastResult, usage());
      if (html !== lastCardHtml) {
        lastCardHtml = html;
        card.innerHTML = html;
        card.scrollTop = 0;
      }
      card.classList.remove('is-collapsed');
      card.classList.add('is-info');
      card.hidden = false;
      if (lastSelectionKey) {
        lastSelectionKey = '';
        scene?.select(null);
      }
      return;
    }
    card.classList.remove('is-info');
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
        ? `${tr(`${connected.length} 个数据源的记录映射到同一个 IRI，在图谱中是同一个实体。`, `Records from ${connected.length} sources map to the same IRI and are one entity in the graph.`)}<button type="button" class="to-layers" data-city-to-layers>${tr('在分层视图中查看', 'View in the layered view')}</button>`
        : connected.length === 1
          ? tr('目前只有一个已接入的数据源描述它。', 'Only one connected source describes it.')
          : !data.rows.length && data.empty
            ? escapeHtml(data.empty)
            : tr('没有已接入的数据源描述它。', 'No connected source describes it.');
    const truth = data.truth
      ? `<p class="card-truth"><span>${tr('模拟实况', 'Simulation')}</span><span class="card-text">${linkify(data.truth, data.truthRefs)}</span></p>`
      : '';
    const rows = data.rows
      .map((row) => {
        const source = sourceById.get(row.source)!;
        const on = sources.has(row.source);
        return `<li${on ? '' : ' class="is-off"'} style="--source:${source.color}"><span class="card-source">${escapeHtml(source.name)}</span><span class="card-text">${on ? linkify(row.text, row.refs) : tr('未接入', 'Not connected')}</span></li>`;
      })
      .join('');
    const previous = trail.at(-1);
    const back = previous
      ? `<button type="button" class="card-back" data-card-back>← ${tr('返回', 'Back to')} ${escapeHtml(selectionTitle(previous, detail))}</button>`
      : '';
    const html = `
      ${back}
      <div class="card-head">
        <div>
          <p class="card-kind">${escapeHtml(data.kind)}</p>
          <h3 class="card-title">${escapeHtml(data.title)}</h3>
        </div>
        <div class="card-actions">
          <button type="button" class="card-close" data-card-collapse aria-expanded="${!cardCollapsed}" aria-label="${cardCollapsed ? tr('展开详情', 'Expand details') : tr('收起详情', 'Collapse details')}" title="${cardCollapsed ? tr('展开', 'Expand') : tr('收起', 'Collapse')}">${cardCollapsed ? CHEVRON_UP : CHEVRON_DOWN}</button>
          <button type="button" class="card-close" data-card-close aria-label="${tr('关闭详情', 'Close details')}" title="${tr('关闭', 'Close')}">${CLOSE_ICON}</button>
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
    lastResult = result;
    renderResult(result);
    scene?.showResult(result, fresh);
    renderCard();
  };

  // ── 时间 ──
  const syncHud = () => {
    clock.textContent = formatTime(t);
    if (sources.has('weather')) {
      const o = observationAt(t);
      const parts = [
        term(o.condition),
        `${Math.round(o.temperature)}°C`,
        `${tr('湿度', 'humidity')} ${o.humidity}%`,
      ];
      if (o.precipitation > 0) parts.push(`${tr('降水', 'precipitation')} ${o.precipitation} mm`);
      if (o.visibility < 2000) parts.push(`${tr('能见度', 'visibility')} ${o.visibility} m`);
      if (o.wind >= 6) parts.push(`${tr('风', 'wind')} ${Math.round(o.wind)} m/s`);
      weather.textContent = parts.join(' · ');
      weather.classList.remove('is-off');
    } else {
      weather.textContent = tr('气象未接入', 'Weather not connected');
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
          `<span class="marker marker-${m.kind}" style="left:${percent(m.from)}%;width:${percent(m.to) - percent(m.from)}%" title="${escapeHtml(`${term(m.label)} ${formatTime(m.from)}–${formatTime(m.to)}`)}"><i>${escapeHtml(term(m.label))}</i></span>`,
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
    playButton.setAttribute('aria-label', playing ? tr('暂停', 'Pause') : tr('播放', 'Play'));
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
      badge.textContent = sources.has(id) ? tr('需要', 'Needed') : tr('缺少', 'Missing');
    });
    sourceCount.textContent = tr(
      `${sources.size} / ${SOURCES.length} 已接入`,
      `${sources.size} / ${SOURCES.length} connected`,
    );
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
    if (next) infoTarget = null;
    renderCard();
  };

  /** 打开数据源、层或类的介绍。 */
  const openInfo = (next: InfoTarget) => {
    selection = null;
    trail = [];
    infoTarget = next;
    lastCardHtml = '';
    renderCard();
  };

  const toggleSource = (id: SourceId) => {
    if (sources.has(id)) sources.delete(id);
    else sources.add(id);
    syncSources();
    refresh();
  };

  // ── 事件 ──
  groupTabs.forEach((tab) =>
    tab.addEventListener(
      'click',
      () => showQuery(queries.find((q) => q.group === tab.dataset.groupTab)!),
      { signal },
    ),
  );
  queryButtons.forEach((button) =>
    button.addEventListener(
      'click',
      () => showQuery(queries.find((q) => q.id === button.dataset.cityQuery)!),
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
      const infoSource = target.closest<HTMLElement>('[data-info-source]');
      const infoClass = target.closest<HTMLElement>('[data-info-class]');
      const infoLayer = target.closest<HTMLElement>('[data-info-layer]');
      const toggle = target.closest<HTMLElement>('[data-toggle-source]');
      const queryLink = target.closest<HTMLElement>('[data-query]');
      if (target.closest('[data-card-close]')) {
        infoTarget = null;
        select(null);
      } else if (toggle) toggleSource(toggle.dataset.toggleSource as SourceId);
      else if (queryLink) showQuery(queries.find((q) => q.id === queryLink.dataset.query)!);
      else if (infoSource)
        openInfo({ type: 'source', id: infoSource.dataset.infoSource as SourceId });
      else if (infoClass) openInfo({ type: 'class', name: infoClass.dataset.infoClass! });
      else if (infoLayer) {
        openInfo({ type: 'layer', id: infoLayer.dataset.infoLayer as 'data' });
      } else if (target.closest('[data-card-collapse]')) {
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
    nightButton.title = nightView
      ? tr('夜景显示：已开启', 'Night view: on')
      : tr('夜景显示：光照跟随模拟时间', 'Night view: off, lighting follows the simulated time');
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

  // ── 导览：镜头依次飞向街区中的对象与分层视图的各层，配合讲解 ──
  interface TourStep extends CityTourStep {
    title: string;
    text: string;
    duration: number;
    enter(): void;
  }
  const byId = (id: CityQuery['id']) => queries.find((q) => q.id === id)!;
  /** 当前查询结果中第一个可以定位的对象。 */
  const firstTarget = (): FocusTarget | undefined => {
    const result = active.run({ t, sources, detail });
    const i = result.rows.findIndex((row, k) => row.hit && focusFor(active, row) && k >= 0);
    return i >= 0 ? (focusFor(active, result.rows[i]) ?? undefined) : undefined;
  };
  const setAllSources = () => {
    sources = new Set(ALL_SOURCES);
    syncSources();
  };
  const TOUR: TourStep[] = [
    {
      title: tr('街区与数据源', 'The district and its data sources'),
      text: tr(
        '示例模拟一座虚构街区一周的运行：车辆在道路上行驶，居民通勤、乘车与消费，每天的天气各不相同。这些活动分别由八个相互独立的系统记录。',
        'The example simulates one week in a fictional district: vehicles move along the roads, residents commute, ride and shop, and the weather differs from day to day. Eight independent systems record these activities separately.',
      ),
      duration: 9,
      enter() {
        setView('city');
        setAllSources();
        showQuery(byId('queues'));
        if (!reduced) setPlaying(true);
        scene?.tour({ layer: 'overview' });
      },
    },
    {
      marker: tr('红灯前排队', 'Queue at a red light'),
      title: tr('交通时序', 'Traffic time series'),
      text: tr(
        '交通时序每 5 秒记录一次信号相位与车辆位置，路口名称存放在城市基础数据中。查询“红灯前排队 3 辆车以上的路口”需要同时访问这两个数据源。',
        'The traffic time series records signal phases and vehicle positions every 5 seconds, while intersection names are stored in the base city data. The query for intersections with three or more vehicles queued at a red light accesses both sources.',
      ),
      duration: 10,
      enter() {
        showQuery(byId('queues'));
        const focus = firstTarget();
        scene?.tour({ focus, marker: this.marker });
      },
    },
    {
      marker: tr('温湿度传感器', 'Temperature sensor'),
      title: tr('传感器与气象', 'Sensors and weather'),
      text: tr(
        '物联网平台中的温湿度传感器只记录编号与坐标，气象站观测存放在气象数据源中。查询将每个传感器的读数与相邻传感器及气象站比较，识别读数异常的传感器。',
        'Temperature and humidity sensors on the IoT platform record only an ID and coordinates; weather station observations are kept in the weather source. The query compares each reading with neighbouring sensors and the weather station to identify sensors with anomalous readings.',
      ),
      duration: 10,
      enter() {
        showQuery(byId('sensorAnomaly'));
        scene?.tour({ focus: firstTarget(), marker: this.marker });
      },
    },
    {
      marker: tr('客流 + 销售', 'Footfall + sales'),
      title: tr('商店的客流与销售', 'Shop footfall and sales'),
      text: tr(
        '客流计数器属于物联网平台，订单数存放在商户系统中，降雨记录在气象观测中。三者按建筑编号与时间对齐后，可以得出降雨时客流下降最多的商店。',
        'Footfall counters belong to the IoT platform, order counts are stored in the merchant system, and rainfall is recorded in the weather observations. Aligned by building ID and time, the three sources identify the shops whose footfall drops most when it rains.',
      ),
      duration: 10,
      enter() {
        showQuery(byId('rainFootfall'));
        scene?.tour({ focus: firstTarget(), marker: this.marker });
      },
    },
    {
      title: tr('分布在五个数据源中的人物记录', 'Records of one person across five sources'),
      text: tr(
        '虚构居民的住址存放在社区应用中，雇佣关系与考勤存放在企业系统中，乘车与消费记录分别存放在出行服务与商户系统中。这些系统使用统一的居民编号，映射将各条记录关联到同一个 IRI，形成该居民当天的完整行程。',
        'A fictional resident’s address is stored in the community app, employment and attendance in the company system, and rides and purchases in the mobility service and the merchant system. These systems share a resident ID, so the mappings link every record to the same IRI and yield the resident’s complete itinerary for the day.',
      ),
      duration: 11,
      enter() {
        showQuery(byId('persona'));
        scene?.tour({ focus: firstTarget() });
      },
    },
    {
      title: tr('分层视图', 'The layered view'),
      text: tr(
        '分层视图从另一个角度呈现同一条查询：底层为八个数据源，其上依次为映射、虚拟知识图谱与本体。结果中的每个实体都连接到描述它的数据源。',
        'The layered view presents the same query from another angle: the eight sources form the bottom layer, followed by the mappings, the virtual knowledge graph and the ontology. Each entity in the result is connected to the sources that describe it.',
      ),
      duration: 9,
      enter() {
        showQuery(byId('commuteCars'));
        setView('layers');
        scene?.tour({ layer: 'overview' });
      },
    },
    {
      layer: 'data',
      marker: tr('8 个数据源', '8 data sources'),
      title: tr('数据源层', 'Source layer'),
      text: tr(
        '每个圆柱代表一个独立的数据库，标签为其在联邦查询引擎中的 catalog 名。VKG 不复制数据，查询时直接访问各数据源。点击圆柱可查看其表结构与映射。',
        'Each cylinder represents an independent database, labelled with its catalog name in the federated query engine. The VKG copies no data and accesses each source at query time. Click a cylinder to view its tables and mappings.',
      ),
      duration: 10,
      enter() {
        scene?.tour({ layer: 'data', marker: this.marker });
      },
    },
    {
      layer: 'mapping',
      marker: tr('映射', 'Mappings'),
      title: tr('映射层', 'Mapping layer'),
      text: tr(
        '映射将各数据源的表转换为统一的词汇：SQL 查询选取记录，IRI 模板为记录命名。交通时序中的车牌与企业系统中的停车许可生成相同的 :vehicle/{plate}，因而指向同一辆车。',
        'Mappings translate each source’s tables into a shared vocabulary: an SQL query selects the records and an IRI template names them. A plate in the traffic time series and a parking permit in the company system produce the same :vehicle/{plate} and therefore refer to the same vehicle.',
      ),
      duration: 10,
      enter() {
        scene?.tour({ layer: 'mapping', marker: this.marker });
      },
    },
    {
      layer: 'graph',
      marker: tr('同一 IRI 汇合', 'Same IRI, one entity'),
      title: tr('虚拟知识图谱层', 'Virtual knowledge graph layer'),
      text: tr(
        '映射生成的实体位于这一层。连接多条彩色连线的节点由多个数据源共同描述，例如企业系统中的员工与交通时序中的车辆在图谱中相互关联。',
        'Entities produced by the mappings reside on this layer. A node with several coloured links is described by multiple sources; for example, an employee from the company system is connected to a vehicle from the traffic time series.',
      ),
      duration: 11,
      enter() {
        scene?.tour({ layer: 'graph', marker: this.marker });
      },
    },
    {
      layer: 'ontology',
      marker: tr('类与子类', 'Classes and subclasses'),
      title: tr('本体层', 'Ontology layer'),
      text: tr(
        '本体定义类以及类之间的关系：员工是人的子类，公交车与出租车是运营车辆的子类。查询基于这些类编写，查询上位类时，子类的实例通过推理一并返回。点击类可查看其定义与来源。',
        'The ontology defines classes and their relations: employee is a subclass of person, and buses and taxis are subclasses of service vehicle. Queries are written over these classes, and querying a superclass also returns instances of its subclasses through reasoning. Click a class to view its definition and sources.',
      ),
      duration: 10,
      enter() {
        scene?.tour({ layer: 'ontology', marker: this.marker });
      },
    },
    {
      layer: 'overview',
      title: tr('断开数据源后的结果', 'Results after disconnecting a source'),
      text: tr(
        '断开企业与门禁系统后，员工与车牌的对应关系不再可用，“开车上班的员工”查询无法回答，图谱中的相应连线随之消失。VKG 的查询结果取决于当前接入的数据源。',
        'With the company and access system disconnected, the link between employees and plates is no longer available: the query for employees who drive to work cannot be answered, and the corresponding links disappear from the graph. VKG query results depend on the sources currently connected.',
      ),
      duration: 10,
      enter() {
        sources = new Set(ALL_SOURCES.filter((id) => id !== 'hr'));
        syncSources();
        refresh();
        scene?.tour({ layer: 'overview' });
      },
    },
    {
      title: tr('继续探索', 'Explore further'),
      text: tr(
        '左侧列出 11 条查询。在城市视图中点击建筑、车辆或行人，可查看其在各数据源中的记录；在分层视图中点击数据源、层或类，可查看相应介绍。',
        'The 11 queries are listed on the left. In the city view, click a building, vehicle or person to view its records in each source; in the layered view, click a source, layer or class to view its description.',
      ),
      duration: 0,
      enter() {
        setAllSources();
        setView('city');
        refresh();
        scene?.tour({ layer: 'overview' });
      },
    },
  ];

  const tourBox = root.querySelector<HTMLElement>('[data-tour]')!;
  const tourBar = root.querySelector<HTMLElement>('[data-tour-bar]')!;
  const tourNext = root.querySelector<HTMLButtonElement>('[data-tour-next]')!;
  const tourPrev = root.querySelector<HTMLButtonElement>('[data-tour-prev]')!;
  let touring = -1;
  let tourTimer = 0;
  const TOUR_KEY = 'city-tour-seen';
  const tourSeen = () => {
    try {
      return localStorage.getItem(TOUR_KEY) === '1';
    } catch {
      return false;
    }
  };

  const showTourStep = (index: number) => {
    window.clearTimeout(tourTimer);
    touring = index;
    const step = TOUR[index];
    stage.classList.add('is-touring');
    tourBox.hidden = false;
    hint.hidden = true;
    infoTarget = null;
    select(null);
    scene?.setInsets(insets());
    root.querySelector<HTMLElement>('[data-tour-step]')!.textContent =
      `${index + 1} / ${TOUR.length}`;
    root.querySelector<HTMLElement>('[data-tour-title]')!.textContent = step.title;
    root.querySelector<HTMLElement>('[data-tour-text]')!.textContent = step.text;
    tourPrev.disabled = index === 0;
    const last = index === TOUR.length - 1;
    tourNext.textContent = last ? tr('开始探索', 'Start exploring') : tr('下一步', 'Next');
    step.enter();
    tourBar.style.transition = 'none';
    tourBar.style.width = last ? '100%' : '0';
    if (!last && step.duration) {
      void tourBar.offsetWidth;
      tourBar.style.transition = `width ${step.duration}s linear`;
      tourBar.style.width = '100%';
      tourTimer = window.setTimeout(() => showTourStep(index + 1), step.duration * 1000);
    }
  };

  const endTour = () => {
    window.clearTimeout(tourTimer);
    if (touring < 0) return;
    touring = -1;
    stage.classList.remove('is-touring');
    tourBox.hidden = true;
    scene?.tour(null);
    setAllSources();
    refresh();
    scene?.setInsets(insets());
    scene?.resetView();
    try {
      localStorage.setItem(TOUR_KEY, '1');
      localStorage.setItem(HINT_KEY, '1');
    } catch {
      // 隐私模式下 localStorage 可能不可用，忽略即可。
    }
    layersButton.classList.remove('is-new');
  };

  tourNext.addEventListener(
    'click',
    () => (touring >= TOUR.length - 1 ? endTour() : showTourStep(touring + 1)),
    { signal },
  );
  tourPrev.addEventListener('click', () => touring > 0 && showTourStep(touring - 1), { signal });
  root.querySelector('[data-tour-skip]')!.addEventListener('click', endTour, { signal });
  root
    .querySelector('[data-city-tour]')!
    .addEventListener('click', () => showTourStep(0), { signal });
  signal.addEventListener('abort', () => window.clearTimeout(tourTimer));

  // 数据源面板中的介绍按钮与本体入口
  sourcesPanel.addEventListener(
    'click',
    (event) => {
      const target = event.target as HTMLElement;
      const button = target.closest<HTMLElement>('[data-info-source], [data-info-layer]');
      if (!button) return;
      event.preventDefault();
      if (button.dataset.infoSource) {
        openInfo({ type: 'source', id: button.dataset.infoSource as SourceId });
      } else openInfo({ type: 'layer', id: button.dataset.infoLayer as 'ontology' });
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
    fullscreenButton.setAttribute(
      'aria-label',
      full ? tr('退出全屏', 'Exit full screen') : tr('全屏', 'Full screen'),
    );
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
    if (touring >= 0 || getComputedStyle(queriesPanel).position !== 'absolute') {
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
      status.textContent = tr(
        '当前环境不支持 WebGL，三维场景不可用；查询、数据源开关与时间轴仍可使用。',
        'WebGL is not available, so the 3D scene cannot be shown; queries, source switches and the timeline still work.',
      );
      return;
    }
    status.textContent = tr('正在加载三维场景…', 'Loading the 3D scene…');
    try {
      const { createCityScene } = await import('./scene');
      if (signal.aborted) return;
      scene = createCityScene(
        viewport,
        pinLayer,
        { onSelect: select, onInfo: openInfo },
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
      if (tourSeen()) window.setTimeout(showHint, 1500);
      else window.setTimeout(() => !signal.aborted && touring < 0 && showTourStep(0), 600);
    } catch (error) {
      console.error(error);
      stage.classList.add('is-fallback');
      status.textContent = tr(
        '三维场景加载失败；查询、数据源开关与时间轴仍可使用。',
        'The 3D scene failed to load; queries, source switches and the timeline still work.',
      );
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
