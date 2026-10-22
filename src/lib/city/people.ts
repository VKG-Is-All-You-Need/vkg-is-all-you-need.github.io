/**
 * 街区中的人（全部为虚构数据），时间跨度为一周。
 * - 登记居民：社区应用中有住址，其中一部分是企业员工（企业与门禁）；六位具名人物用于“明细”演示，
 *   其余居民只以编号出现。居民的公交卡号与会员号就是居民编号。
 * - 外来人员：在街区上班、购物、看病、开车路过的人，以及公交司机、网约车司机与配送员。
 *   他们不是社区应用的登记居民，大多只在公交刷卡（匿名卡号）或会员消费（会员号）中留下记录。
 * 每个人每天做什么由 plans.ts 安排，实际行程由 mobility.ts 按交通模拟落实。
 */
import { city, type Building } from '../geo/city';
import { rectCenter, seededRandom, type Point } from '../geo/spatial';
import { DAY, DAYS, at, hours } from './time';

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
  /** 登记居民（社区应用）或外来人员。 */
  kind: 'resident' | 'outsider';
  /** 居民的住址。 */
  homeId?: number;
  companyId?: number;
  /** 外来上班族的工作地点（建筑编号）。 */
  workplace?: number;
  /** 具名人物，用于明细演示。 */
  persona: boolean;
  color?: string;
  /** 公交卡号：居民以居民编号登记，外来人员为匿名卡号。 */
  card: string;
  /** 商户会员号：居民以居民编号登记。 */
  member?: string;
  /** 开车进出街区（外来上班族与访客）。 */
  drives?: boolean;
  /** 步行速度（米/秒）。 */
  pace: number;
}

type PersonaInput = Omit<Person, 'kind' | 'card' | 'member' | 'pace' | 'persona'>;
const persona = (input: PersonaInput): Person => ({
  ...input,
  kind: 'resident',
  persona: true,
  card: input.id,
  member: input.id,
  pace: 1.35,
});

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
  persona({
    id: 'P01',
    name: '林晓',
    role: '软件工程师',
    homeId: linHome.id,
    companyId: 1,
    color: '#49bbdd',
  }),
  persona({
    id: 'P02',
    name: '周宁',
    role: '产品经理',
    homeId: zhouHome.id,
    companyId: 1,
    color: '#f29fb8',
  }),
  persona({
    id: 'P03',
    name: '孙浩',
    role: '后端工程师',
    homeId: sunHome.id,
    companyId: 1,
    color: '#7fd38a',
  }),
  persona({
    id: 'P04',
    name: '陈雨',
    role: '护士',
    homeId: chenHome.id,
    companyId: 3,
    color: '#c9a0f0',
  }),
  persona({
    id: 'P05',
    name: '王磊',
    role: '网约车司机',
    homeId: wangHome.id,
    companyId: 4,
    color: '#e6c07b',
  }),
  persona({
    id: 'P06',
    name: '赵敏',
    role: '街角咖啡店主',
    homeId: zhaoHome.id,
    color: '#ff9f6b',
  }),
];

function buildResidents(): Person[] {
  const random = seededRandom(73);
  const traits = seededRandom(74);
  const homes = city.buildings.filter((b) => b.kind === '住宅');
  const residents: Person[] = [...personas];
  const add = (companyId?: number) => {
    const id = `R${String(residents.length - personas.length + 1).padStart(3, '0')}`;
    residents.push({
      id,
      kind: 'resident',
      homeId: homes[Math.floor(random() * homes.length)].id,
      companyId,
      persona: false,
      card: id,
      member: traits() < 0.55 ? id : undefined,
      pace: 1.1 + traits() * 0.45,
    });
  };
  for (let i = 0; i < 36; i++) add(1);
  for (let i = 0; i < 18; i++) add(2);
  for (let i = 0; i < 50; i++) add(3);
  for (let i = 0; i < 40; i++) add();
  return residents;
}

/** 登记居民（社区应用 residents 表），含具名人物。 */
export const people = buildResidents();

// ── 外来人员 ──
/** 过境车辆数：每辆车有一名固定的驾驶人，约三成常有同乘者。 */
export const THROUGH_CARS = 2600;
/** 开车来商场的访客车辆数。 */
export const GUEST_CARS = 220;

export interface Staff {
  bus: string[];
  taxi: string[];
  courier: string[];
  /** 过境车辆的驾驶人与同乘者（与车辆一一对应）。 */
  through: { driver: string; companion?: string }[];
  office: string[];
  visitors: string[];
}

function buildOutsiders(): { outsiders: Person[]; staff: Staff } {
  const random = seededRandom(211);
  const outsiders: Person[] = [];
  const cards = new Set<string>();
  const unique = (prefix: string) => {
    let code: string;
    do code = `${prefix}${10000 + Math.floor(random() * 90000)}`;
    while (cards.has(code));
    cards.add(code);
    return code;
  };
  const add = (extra: Partial<Person> = {}) => {
    const id = `N${String(outsiders.length + 1).padStart(5, '0')}`;
    outsiders.push({
      id,
      kind: 'outsider',
      persona: false,
      card: unique('C'),
      pace: 1.1 + random() * 0.45,
      ...extra,
    });
    return id;
  };
  const staff: Staff = { bus: [], taxi: [], courier: [], through: [], office: [], visitors: [] };
  // 在街区写字楼上班的人：所在企业没有接入企业与门禁
  const offices = city.buildings.filter(
    (b) => b.kind === '办公' && b.id !== central.id && b.id !== designOffice.id,
  );
  for (const office of offices) {
    const n = 14 + Math.floor(random() * 13);
    for (let i = 0; i < n; i++) {
      staff.office.push(
        add({ role: '上班族', workplace: office.id, drives: random() < 0.22 || undefined }),
      );
    }
  }
  for (let i = 0; i < 8; i++) staff.bus.push(add({ role: '公交司机' }));
  for (let i = 0; i < 2; i++) staff.taxi.push(add({ role: '网约车司机' }));
  for (let i = 0; i < 10; i++) staff.courier.push(add({ role: '配送员' }));
  for (let i = 0; i < THROUGH_CARS; i++) {
    const driver = add({ role: '驾车路过' });
    staff.through.push({ driver, companion: random() < 0.3 ? add() : undefined });
  }
  for (let i = 0; i < 12000; i++) {
    staff.visitors.push(
      add({
        member: random() < 0.15 ? unique('M') : undefined,
        drives: i < GUEST_CARS || undefined,
      }),
    );
  }
  return { outsiders, staff };
}

const outside = buildOutsiders();
/** 外来人员：不在社区应用中登记。 */
export const outsiders = outside.outsiders;
export const staff = outside.staff;

export const personById = new Map([...people, ...outsiders].map((p) => [p.id, p]));
export const isPersona = (id: string) => personById.get(id)?.persona === true;

// ── 排班：员工计划几点进门、几点离开（实际的门禁记录见 records.ts） ──
export interface WorkShift {
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

function buildShifts(day: number): WorkShift[] {
  const random = seededRandom(97 + day * 131);
  const between = (a: number, b: number) => a + random() * (b - a);
  const weekend = DAYS[day].weekend;
  const shifts: WorkShift[] = [];
  for (const [personId, plan] of Object.entries(PERSONA_SHIFTS)) {
    if (!plan.days.includes(day)) continue;
    const [h0, m0, h1, m1] = plan.shift(day);
    shifts.push({
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
      shifts.push({
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
      shifts.push({
        personId: person.id,
        companyId: 3,
        start: day * DAY + start + between(-600, 600),
        end: day * DAY + Math.min(hours(24), end + between(-600, 900)),
      });
    }
  }
  return shifts;
}

/** 具名人物某天的上下班时刻；不上班时为 null。 */
export function personaShift(person: string, day: number): [number, number] | null {
  const plan = PERSONA_SHIFTS[person];
  if (!plan?.days.includes(day)) return null;
  const [h0, m0, h1, m1] = plan.shift(day);
  return [at(day, h0, m0), at(day, h1, m1)];
}

const shiftCache = new Map<number, WorkShift[]>();

/** 某一天的排班。 */
export function shiftsOf(day: number): WorkShift[] {
  let shifts = shiftCache.get(day);
  if (!shifts) {
    shifts = buildShifts(day);
    shiftCache.set(day, shifts);
  }
  return shifts;
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
  center(city.buildings.find((b) => b.id === personById.get(id)!.homeId!)!);

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
