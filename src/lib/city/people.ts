/**
 * 企业、居民与社区活动（全部为虚构数据），时间跨度为一周。
 * - 企业与门禁（hr）：企业、雇佣关系、上下班记录、楼宇门禁小时汇总；
 * - 社区应用（community）：居民住址、活动与报名记录。
 * 六位具名人物用于“明细”演示，其余居民与员工只以编号出现，用于聚合统计。
 */
import { city, type Building } from '../geo/city';
import { rectCenter, seededRandom, type Point } from '../geo/spatial';
import { DAY, DAYS, at, dayOf, hours } from './time';

const byName = (name: string) => city.buildings.find((b) => b.name === name)!;
const center = (building: Building) => rectCenter(building.footprint);
const station = (name: string) => city.stations.find((s) => s.name === name)!.location;
const nearestResidential = (p: Point, exclude: number[] = []) =>
  city.buildings
    .filter((b) => b.kind === '住宅' && !exclude.includes(b.id))
    .sort((a, b) => {
      const ca = center(a);
      const cb = center(b);
      return Math.hypot(ca.x - p.x, ca.y - p.y) - Math.hypot(cb.x - p.x, cb.y - p.y);
    })[0];
const nearestOffice = (p: Point) =>
  city.buildings
    .filter((b) => b.kind === '办公' && b.name !== '中央大厦')
    .sort((a, b) => {
      const ca = center(a);
      const cb = center(b);
      return Math.hypot(ca.x - p.x, ca.y - p.y) - Math.hypot(cb.x - p.x, cb.y - p.y);
    })[0];

// ── 企业 ──
export interface Company {
  id: number;
  name: string;
  buildingId: number;
}

const central = byName('中央大厦');
const hospital = byName('市立医院');
const designOffice = nearestOffice({ x: 300, y: 300 });

export const companies: Company[] = [
  { id: 1, name: '星河科技', buildingId: central.id },
  { id: 2, name: '云杉设计', buildingId: designOffice.id },
  { id: 3, name: '市立医院', buildingId: hospital.id },
  { id: 4, name: '畅行出行', buildingId: 0 },
];
export const companyById = new Map(companies.map((c) => [c.id, c]));

// ── 人物 ──
export interface Person {
  id: string;
  name?: string;
  role?: string;
  homeId: number;
  companyId?: number;
  /** 具名人物，用于明细演示。 */
  persona: boolean;
  color?: string;
}

const linHome = nearestResidential(station('北站'));
const zhouHome = byName('湖畔公寓');
const sunHome = nearestResidential({ x: 470, y: 620 }, [linHome.id]);
const chenHome = nearestResidential(center(hospital), [linHome.id, sunHome.id]);
const wangHome = nearestResidential({ x: 90, y: 240 }, [linHome.id, sunHome.id, chenHome.id]);
const zhaoHome = nearestResidential({ x: 560, y: 600 }, [
  linHome.id,
  sunHome.id,
  chenHome.id,
  wangHome.id,
]);

export const personas: Person[] = [
  {
    id: 'P01',
    name: '林晓',
    role: '软件工程师',
    homeId: linHome.id,
    companyId: 1,
    persona: true,
    color: '#49bbdd',
  },
  {
    id: 'P02',
    name: '周宁',
    role: '产品经理',
    homeId: zhouHome.id,
    companyId: 1,
    persona: true,
    color: '#f29fb8',
  },
  {
    id: 'P03',
    name: '孙浩',
    role: '后端工程师',
    homeId: sunHome.id,
    companyId: 1,
    persona: true,
    color: '#7fd38a',
  },
  {
    id: 'P04',
    name: '陈雨',
    role: '护士',
    homeId: chenHome.id,
    companyId: 3,
    persona: true,
    color: '#c9a0f0',
  },
  {
    id: 'P05',
    name: '王磊',
    role: '网约车司机',
    homeId: wangHome.id,
    companyId: 4,
    persona: true,
    color: '#e6c07b',
  },
  {
    id: 'P06',
    name: '赵敏',
    role: '街角咖啡店主',
    homeId: zhaoHome.id,
    persona: true,
    color: '#ff9f6b',
  },
];

function buildResidents(): Person[] {
  const random = seededRandom(73);
  const homes = city.buildings.filter((b) => b.kind === '住宅');
  const residents: Person[] = [...personas];
  const add = (companyId?: number) =>
    residents.push({
      id: `R${String(residents.length - personas.length + 1).padStart(3, '0')}`,
      homeId: homes[Math.floor(random() * homes.length)].id,
      companyId,
      persona: false,
    });
  for (let i = 0; i < 36; i++) add(1);
  for (let i = 0; i < 18; i++) add(2);
  for (let i = 0; i < 50; i++) add(3);
  for (let i = 0; i < 40; i++) add();
  return residents;
}

export const people = buildResidents();
export const personById = new Map(people.map((p) => [p.id, p]));

// ── 上下班记录（门禁） ──
export interface WorkSession {
  personId: string;
  companyId: number;
  start: number;
  end: number;
}

/** 具名人物的工作时段（当天的小时与分钟），未列出的日子不上班。 */
const PERSONA_SHIFTS: Record<
  string,
  { companyId: number; days: number[]; shift: (day: number) => [number, number, number, number] }
> = {
  // 林晓周二准时下班去读书会，周四加班
  P01: {
    companyId: 1,
    days: [0, 1, 2, 3, 4],
    shift: (day) =>
      [8, 28, ...(day === 1 ? [18, 40] : day === 3 ? [19, 40] : [18, 20])] as [
        number,
        number,
        number,
        number,
      ],
  },
  P02: { companyId: 1, days: [0, 1, 2, 3, 4], shift: () => [9, 20, 18, 35] },
  P03: { companyId: 1, days: [0, 1, 2, 3, 4], shift: () => [9, 10, 20, 40] },
  // 陈雨是护士，周六休息，周日上白班
  P04: { companyId: 3, days: [0, 1, 2, 3, 4, 6], shift: () => [7, 25, 18, 5] },
};

function buildSessions(day: number): WorkSession[] {
  const random = seededRandom(97 + day * 131);
  const between = (a: number, b: number) => a + random() * (b - a);
  const weekend = DAYS[day].weekend;
  const sessions: WorkSession[] = [];
  for (const [personId, plan] of Object.entries(PERSONA_SHIFTS)) {
    if (!plan.days.includes(day)) continue;
    const [h0, m0, h1, m1] = plan.shift(day);
    sessions.push({
      personId,
      companyId: plan.companyId,
      start: at(day, h0, m0),
      end: at(day, h1, m1),
    });
  }
  for (const person of people) {
    if (person.persona || !person.companyId) continue;
    if (person.companyId === 1 || person.companyId === 2) {
      if (weekend) continue;
      const [a, b, c, d] =
        person.companyId === 1
          ? [hours(8, 30), hours(9, 45), hours(18), hours(20, 30)]
          : [hours(9), hours(10), hours(17, 30), hours(19)];
      sessions.push({
        personId: person.id,
        companyId: person.companyId,
        start: day * DAY + between(a, b),
        end: day * DAY + between(c, d),
      });
    } else if (person.companyId === 3) {
      // 医院轮班：周末约一半人上班
      if (weekend && random() < 0.45) continue;
      const shift = random();
      const [start, end] =
        shift < 0.5
          ? [hours(7), hours(15, 30)]
          : shift < 0.8
            ? [hours(7, 30), hours(18)]
            : [hours(18), hours(24)];
      sessions.push({
        personId: person.id,
        companyId: 3,
        start: day * DAY + start + between(-600, 600),
        end: day * DAY + Math.min(hours(24), end + between(-600, 900)),
      });
    }
  }
  return sessions;
}

/** 具名人物某天的上下班时刻；不上班时为 null。 */
export function personaShift(person: string, day: number): [number, number] | null {
  const plan = PERSONA_SHIFTS[person];
  if (!plan?.days.includes(day)) return null;
  const [h0, m0, h1, m1] = plan.shift(day);
  return [at(day, h0, m0), at(day, h1, m1)];
}

const sessionCache = new Map<number, WorkSession[]>();

/** 某一天的上下班记录。 */
export function sessionsOf(day: number): WorkSession[] {
  let sessions = sessionCache.get(day);
  if (!sessions) {
    sessions = buildSessions(day);
    sessionCache.set(day, sessions);
  }
  return sessions;
}

/** 门禁汇总：某企业在时刻 t 的在岗人数。 */
export function presence(companyId: number, t: number): number {
  return sessionsOf(dayOf(t)).filter((s) => s.companyId === companyId && s.start <= t && s.end > t)
    .length;
}

// ── 社区活动 ──
export interface CommunityEvent {
  id: number;
  title: string;
  venue: { kind: 'building'; id: number } | { kind: 'park'; id: number };
  start: number;
  end: number;
  attendees: string[];
}

const park = { kind: 'park' as const, id: city.parks[0].id };

export const events: CommunityEvent[] = [
  {
    id: 1,
    title: '读书会',
    venue: { kind: 'building', id: byName('拾光咖啡').id },
    start: at(1, 18, 50),
    end: at(1, 20, 10),
    attendees: ['P01', 'P02', 'P04', 'R020', 'R112'],
  },
  {
    id: 2,
    title: '夜跑',
    venue: park,
    start: at(1, 21),
    end: at(1, 21, 40),
    attendees: ['P02', 'P03', 'R012', 'R118', 'R133'],
  },
  {
    id: 3,
    title: '周末市集筹备会',
    venue: { kind: 'building', id: byName('街角咖啡').id },
    start: at(2, 15),
    end: at(2, 16),
    attendees: ['P06', 'R103', 'R109', 'R121'],
  },
  {
    id: 4,
    title: '夜跑',
    venue: park,
    start: at(3, 21),
    end: at(3, 21, 40),
    attendees: ['P02', 'P03', 'R012', 'R118'],
  },
  {
    id: 5,
    title: '周末市集',
    venue: park,
    start: at(5, 10),
    end: at(5, 16),
    attendees: [
      'P06',
      'P01',
      'P02',
      'P04',
      'R103',
      'R109',
      'R121',
      'R005',
      'R017',
      'R033',
      'R046',
      'R058',
      'R071',
      'R090',
      'R126',
      'R140',
    ],
  },
];

// ── 常用地点 ──
export const homeOf = (id: string) =>
  center(city.buildings.find((b) => b.id === personById.get(id)!.homeId)!);

export const PLACES = {
  office: center(central),
  clinic: center(hospital),
  cafe: center(byName('拾光咖啡')),
  corner: center(byName('街角咖啡')),
  mall: center(byName('星河商场')),
  parkGate: { x: 660, y: 450 },
  market: { x: 740, y: 470 },
};

export const stationAt = station;

// ── 车辆登记与停车许可（企业与门禁） ──
export interface CarOwner {
  person: string;
  companyId: number;
}

/** 有停车许可的员工：周宁与部分员工开车上班，车停在公司车库。 */
export const carOwners: CarOwner[] = (() => {
  const owners: CarOwner[] = [{ person: 'P02', companyId: 1 }];
  const quota = new Map([
    [1, 18],
    [2, 10],
    [3, 12],
  ]);
  for (const person of people) {
    if (person.persona || !person.companyId) continue;
    const left = quota.get(person.companyId) ?? 0;
    if (left <= 0) continue;
    quota.set(person.companyId, left - 1);
    owners.push({ person: person.id, companyId: person.companyId });
  }
  return owners;
})();

// ── 具名人物需要车辆的出行（交通模拟按此安排车辆） ──
export interface PersonaTrip {
  id: string;
  person: string;
  mode: 'drive' | 'taxi';
  /** 出发（自驾）或下单（打车）时刻。 */
  depart: number;
  from: Point;
  to: Point;
  label: string;
}

export function personaTrips(day: number): PersonaTrip[] {
  const trips: PersonaTrip[] = [];
  const home = homeOf('P02');
  // 周宁：工作日开车上下班；周日天冷，开车去商场
  if (!DAYS[day].weekend) {
    trips.push(
      {
        id: `P02-${day}-am`,
        person: 'P02',
        mode: 'drive',
        depart: at(day, 9, 6),
        from: home,
        to: PLACES.office,
        label: '开车上班',
      },
      {
        id: `P02-${day}-pm`,
        person: 'P02',
        mode: 'drive',
        depart: day === 1 ? at(day, 20, 18) : at(day, 18, 40),
        from: PLACES.office,
        to: home,
        label: '开车回家',
      },
    );
  }
  if (day === 6) {
    trips.push(
      {
        id: 'P02-6-out',
        person: 'P02',
        mode: 'drive',
        depart: at(6, 14),
        from: home,
        to: PLACES.mall,
        label: '开车去星河商场',
      },
      {
        id: 'P02-6-back',
        person: 'P02',
        mode: 'drive',
        depart: at(6, 15, 30),
        from: PLACES.mall,
        to: home,
        label: '开车回家',
      },
    );
  }
  // 陈雨：周二下班时正下雨，打车去读书会
  if (day === 1) {
    trips.push({
      id: 'P04-1-taxi',
      person: 'P04',
      mode: 'taxi',
      depart: at(1, 18, 6),
      from: PLACES.clinic,
      to: PLACES.cafe,
      label: '打车去拾光咖啡',
    });
  }
  // 孙浩：周日上午下小雨，打车去商场
  if (day === 6) {
    trips.push({
      id: 'P03-6-taxi',
      person: 'P03',
      mode: 'taxi',
      depart: at(6, 10, 50),
      from: homeOf('P03'),
      to: PLACES.mall,
      label: '打车去星河商场',
    });
  }
  return trips;
}
