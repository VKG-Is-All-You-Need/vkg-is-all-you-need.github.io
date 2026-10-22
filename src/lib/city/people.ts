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

// ── 具名人物的行程（明细演示用） ──
export type LegMode = 'home' | 'walk' | 'metro' | 'bike' | 'work' | 'event' | 'run' | 'drive';

export interface Leg {
  start: number;
  end: number;
  mode: LegMode;
  path: Point[];
  label: string;
}

/** 沿道路行走的路径：先走到最近的街道，沿街道到达目的地附近，再进入建筑。 */
function streetPath(from: Point, to: Point): Point[] {
  const snapX = (x: number) => Math.min(800, Math.max(160, Math.round(x / 160) * 160));
  const snapY = (y: number) => Math.min(540, Math.max(180, Math.round(y / 180) * 180));
  const sx = snapX(from.x);
  const tx = snapX(to.x);
  const sy = snapY(to.y);
  return [from, { x: sx, y: from.y }, { x: sx, y: sy }, { x: tx, y: sy }, { x: tx, y: to.y }, to];
}

const homeOf = (id: string) =>
  center(city.buildings.find((b) => b.id === personById.get(id)!.homeId)!);
const cafe = center(byName('拾光咖啡'));
const corner = center(byName('街角咖啡'));
const office = center(central);
const clinic = center(hospital);
const parkGate = { x: 660, y: 450 };
const market = { x: 740, y: 470 };

/** 夜跑：绕湖一圈的路径。 */
const lakeLoop: Point[] = Array.from({ length: 25 }, (_, i) => {
  const a = (i / 24) * Math.PI * 2;
  const lake = city.parks[0].lake;
  return {
    x: lake.center.x + Math.cos(a) * (lake.rx + 22),
    y: lake.center.y + Math.sin(a) * (lake.ry + 22),
  };
});

/** 按当天的时刻依次排列行程：每段给出结束时刻，起点为上一段的结束。 */
function schedule(day: number) {
  const legs: Leg[] = [];
  let cursor = at(day, 6);
  const add = (mode: LegMode, until: number, path: Point[], label: string) => {
    legs.push({ start: cursor, end: until, mode, path, label });
    cursor = until;
  };
  const time = (h: number, m = 0) => at(day, h, m);
  return {
    legs,
    time,
    /** 停留到某个时刻。 */
    stay: (mode: LegMode, until: number, place: Point, label: string) =>
      add(mode, until, [place], label),
    /** 移动若干分钟。 */
    move: (mode: LegMode, minutes: number, path: Point[], label: string) =>
      add(mode, cursor + minutes * 60, path, label),
    /** 待到当天结束。 */
    rest: (place: Point, label = '在家') => add('home', time(24), [place], label),
  };
}

type Plan = (day: number) => Leg[];

const PLANS: Record<string, Plan> = {
  // 林晓：住在北站附近，乘地铁通勤；周二下班去读书会，周六去周末市集
  P01: (day) => {
    const p = schedule(day);
    const home = homeOf('P01');
    if (day === 6) {
      p.rest(home);
    } else if (day === 5) {
      p.stay('home', p.time(9, 30), home, '在家');
      p.move('walk', 12, streetPath(home, station('北站')), '步行至北站');
      p.move(
        'metro',
        26,
        [station('北站'), station('中心站'), station('湖滨站')],
        '地铁 1 号线换 2 号线',
      );
      p.move('walk', 8, streetPath(station('湖滨站'), market), '步行至周末市集');
      p.stay('event', p.time(12), market, '周末市集');
      p.move('walk', 8, streetPath(market, station('湖滨站')), '步行至湖滨站');
      p.move(
        'metro',
        26,
        [station('湖滨站'), station('中心站'), station('北站')],
        '地铁 2 号线换 1 号线',
      );
      p.move('walk', 12, streetPath(station('北站'), home), '步行回家');
      p.rest(home);
    } else {
      const [, , h1, m1] = PERSONA_SHIFTS.P01.shift(day);
      p.stay('home', p.time(7, 50), home, '在家');
      p.move('walk', 12, streetPath(home, station('北站')), '步行至北站');
      p.move('metro', 18, [station('北站'), station('中心站')], '地铁 1 号线');
      p.move('walk', 8, streetPath(station('中心站'), office), '步行至中央大厦');
      p.stay(
        'work',
        p.time(h1, m1),
        office,
        day === 3 ? '在星河科技工作（加班）' : '在星河科技工作',
      );
      if (day === 1) {
        p.move('walk', 10, streetPath(office, cafe), '步行至拾光咖啡');
        p.stay('event', p.time(20, 10), cafe, '读书会');
        p.move('walk', 6, streetPath(cafe, station('中心站')), '步行至中心站');
      } else {
        p.move('walk', 8, streetPath(office, station('中心站')), '步行至中心站');
      }
      p.move('metro', 18, [station('中心站'), station('北站')], '地铁 1 号线');
      p.move('walk', 12, streetPath(station('北站'), home), '步行回家');
      p.rest(home);
    }
    return p.legs;
  },
  // 周宁：住湖畔公寓，骑车通勤；周二读书会，周二、周四夜跑，周六逛市集
  P02: (day) => {
    const p = schedule(day);
    const home = homeOf('P02');
    if (day === 6) {
      p.rest(home);
    } else if (day === 5) {
      p.stay('home', p.time(10, 40), home, '在家');
      p.move('walk', 12, streetPath(home, market), '步行至周末市集');
      p.stay('event', p.time(13), market, '周末市集');
      p.move('walk', 12, streetPath(market, home), '步行回家');
      p.rest(home);
    } else {
      p.stay('home', p.time(9, 5), home, '在家');
      p.move('bike', 15, streetPath(home, office), '骑车上班');
      p.stay('work', p.time(18, 35), office, '在星河科技工作');
      if (day === 1) {
        p.move('walk', 10, streetPath(office, cafe), '步行至拾光咖啡');
        p.stay('event', p.time(20, 10), cafe, '读书会');
        p.move('bike', 15, streetPath(cafe, home), '骑车回家');
      } else {
        p.move('bike', 15, streetPath(office, home), '骑车回家');
      }
      if (day === 1 || day === 3) {
        p.stay('home', p.time(20, 50), home, '在家');
        p.move('walk', 10, streetPath(home, parkGate), '步行至湖滨公园');
        p.move('run', 40, lakeLoop, '夜跑');
        p.move('walk', 12, streetPath(parkGate, home), '步行回家');
      }
      p.rest(home);
    }
    return p.legs;
  },
  // 孙浩：步行通勤，常加班；周二、周四下班后直接去夜跑
  P03: (day) => {
    const p = schedule(day);
    const home = homeOf('P03');
    if (DAYS[day].weekend) {
      p.rest(home);
      return p.legs;
    }
    p.stay('home', p.time(8, 50), home, '在家');
    p.move('walk', 20, streetPath(home, office), '步行上班');
    p.stay('work', p.time(20, 40), office, '在星河科技工作（加班）');
    if (day === 1 || day === 3) {
      p.move('walk', 20, streetPath(office, parkGate), '步行至湖滨公园');
      p.move('run', 40, lakeLoop, '夜跑');
      p.move('walk', 15, streetPath(parkGate, home), '步行回家');
    } else {
      p.move('walk', 20, streetPath(office, home), '步行回家');
    }
    p.rest(home);
    return p.legs;
  },
  // 陈雨：市立医院护士，周日上班、周六休息；周二下班去读书会，周六逛市集
  P04: (day) => {
    const p = schedule(day);
    const home = homeOf('P04');
    if (day === 5) {
      p.stay('home', p.time(10, 45), home, '在家');
      p.move('walk', 25, streetPath(home, market), '步行至周末市集');
      p.stay('event', p.time(12, 30), market, '周末市集');
      p.move('walk', 25, streetPath(market, home), '步行回家');
      p.rest(home);
      return p.legs;
    }
    p.stay('home', p.time(7, 12), home, '在家');
    p.move('walk', 13, streetPath(home, clinic), '步行上班');
    p.stay('work', p.time(18, 5), clinic, '在市立医院值班');
    if (day === 1) {
      p.move('walk', 13, streetPath(clinic, cafe), '步行至拾光咖啡');
      p.stay('event', p.time(20, 10), cafe, '读书会');
      p.move('walk', 14, streetPath(cafe, home), '步行回家');
    } else {
      p.move('walk', 13, streetPath(clinic, home), '步行回家');
    }
    p.rest(home);
    return p.legs;
  },
  // 赵敏：街角咖啡店主，每天开店；周三在店里主持市集筹备会，周六在市集摆摊
  P06: (day) => {
    const p = schedule(day);
    const home = homeOf('P06');
    p.stay('home', day === 5 ? p.time(8, 15) : p.time(6, 40), home, '在家');
    if (day === 5) {
      p.move('walk', 25, streetPath(home, market), '步行至周末市集');
      p.stay('event', p.time(16, 30), market, '周末市集（摆摊）');
      p.move('walk', 20, streetPath(market, corner), '步行回店里');
    } else {
      p.move('walk', 15, streetPath(home, corner), '步行至店里');
    }
    if (day === 2) {
      p.stay('work', p.time(15), corner, '经营街角咖啡');
      p.stay('event', p.time(16), corner, '周末市集筹备会');
    }
    p.stay('work', p.time(21, 10), corner, '经营街角咖啡');
    p.move('walk', 15, streetPath(corner, home), '步行回家');
    p.rest(home);
    return p.legs;
  },
};

const legCache = new Map<string, Leg[]>();

export const hasItinerary = (id: string) => id in PLANS;

/** 具名人物某一天的行程。 */
export function itinerary(id: string, day: number): Leg[] {
  const key = `${id}:${day}`;
  let legs = legCache.get(key);
  if (!legs) {
    legs = PLANS[id]?.(day) ?? [];
    legCache.set(key, legs);
  }
  return legs;
}

const pathLength = (path: Point[]) =>
  path.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - path[i].x, p.y - path[i].y), 0);

function along(path: Point[], k: number): Point {
  if (path.length === 1) return path[0];
  let remaining = pathLength(path) * k;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (remaining <= length || i === path.length - 1) {
      const f = length ? Math.min(1, remaining / length) : 0;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
    remaining -= length;
  }
  return path.at(-1)!;
}

export interface PersonaState {
  x: number;
  y: number;
  leg: Leg;
}

export function personaAt(id: string, t: number): PersonaState | null {
  if (!hasItinerary(id)) return null;
  const legs = itinerary(id, dayOf(t));
  const current = legs.find((l) => t >= l.start && t < l.end) ?? legs.at(-1)!;
  const k = current.end > current.start ? (t - current.start) / (current.end - current.start) : 0;
  return { ...along(current.path, Math.min(1, Math.max(0, k))), leg: current };
}
