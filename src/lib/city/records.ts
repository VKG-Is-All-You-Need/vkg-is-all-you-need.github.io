/**
 * 各数据源中与人有关的记录。全部从每个人的行程（mobility.ts）派生，因此彼此一致：
 * - 出行服务：公交刷卡（上车与下车）；网约车订单即交通模拟中的用车记录（traffic.ts）；
 * - 商户系统：会员消费；
 * - 物联网平台：商店门口的客流计数，即进店人数；
 * - 企业与门禁：上下班记录，即当天第一次进门与最后一次离开。
 * 车上有哪些人也由行程得出。
 */
import { type Shop } from './commerce';
import { dayPeople, type LegMode } from './mobility';
import { companyById, personById } from './people';
import { DAY, dayOf } from './time';

export interface Tap {
  /** 卡号：居民为居民编号，外来人员为匿名卡号。 */
  card: string;
  bus: string;
  node: number;
  time: number;
  kind: 'board' | 'alight';
}

export interface Purchase {
  member: string;
  shop: number;
  time: number;
  amount: number;
}

export interface WorkSession {
  personId: string;
  companyId: number;
  start: number;
  end: number;
}

/** 某人在某辆车上的时段。 */
export interface Occupant {
  person: string;
  start: number;
  end: number;
  mode: LegMode;
}

interface DayRecords {
  taps: Tap[];
  purchases: Purchase[];
  /** 每家店的进店时刻（升序）。 */
  entries: Map<number, number[]>;
  sessions: WorkSession[];
  occupants: Map<string, Occupant[]>;
}

function buildRecords(day: number): DayRecords {
  const taps: Tap[] = [];
  const purchases: Purchase[] = [];
  const entries = new Map<number, number[]>();
  const sessions: WorkSession[] = [];
  const occupants = new Map<string, Occupant[]>();
  for (const [id, legs] of dayPeople(day).legs) {
    const person = personById.get(id)!;
    const company = person.companyId ? companyById.get(person.companyId) : undefined;
    let session: WorkSession | null = null;
    for (const leg of legs) {
      if (leg.vehicle) {
        const list = occupants.get(leg.vehicle) ?? [];
        list.push({ person: id, start: leg.start, end: leg.end, mode: leg.mode });
        occupants.set(leg.vehicle, list);
      }
      if (leg.mode === 'bus' && leg.stops) {
        taps.push(
          {
            card: person.card,
            bus: leg.vehicle!,
            node: leg.stops[0],
            time: leg.start - 5,
            kind: 'board',
          },
          {
            card: person.card,
            bus: leg.vehicle!,
            node: leg.stops[1],
            time: leg.end - 5,
            kind: 'alight',
          },
        );
      }
      if (leg.mode === 'shop' && leg.shop !== undefined) {
        const list = entries.get(leg.shop) ?? [];
        list.push(leg.start);
        entries.set(leg.shop, list);
        // 逛到一半在收银台结账
        if (leg.amount && person.member) {
          purchases.push({
            member: person.member,
            shop: leg.shop,
            time: Math.min(leg.end - 60, leg.start + 900),
            amount: leg.amount,
          });
        }
      }
      if (leg.mode === 'work' && company?.buildingId && leg.building === company.buildingId) {
        if (session) session.end = leg.end;
        else session = { personId: id, companyId: company.id, start: leg.start, end: leg.end };
      }
    }
    if (session) sessions.push(session);
  }
  for (const list of entries.values()) list.sort((a, b) => a - b);
  taps.sort((a, b) => a.time - b.time);
  purchases.sort((a, b) => a.time - b.time);
  return { taps, purchases, entries, sessions, occupants };
}

const recordCache = new Map<number, DayRecords>();

function recordsOf(day: number): DayRecords {
  let records = recordCache.get(day);
  if (!records) {
    records = buildRecords(day);
    recordCache.set(day, records);
  }
  return records;
}

/** 某一天的公交刷卡记录。 */
export const tapsOf = (day: number) => recordsOf(day).taps;

/** 某一天的会员消费记录。 */
export const purchasesOf = (day: number) => recordsOf(day).purchases;

/** 某一天的上下班记录（门禁）。 */
export const sessionsOf = (day: number) => recordsOf(day).sessions;

/** 门禁汇总：某企业在时刻 t 的在岗人数。 */
export function presence(companyId: number, t: number): number {
  return sessionsOf(dayOf(t)).filter((s) => s.companyId === companyId && s.start <= t && s.end > t)
    .length;
}

const countBefore = (sorted: number[], t: number) => {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

/** 区间内的客流计数：进店人数。 */
export function footfallCount(shop: Shop, from: number, to: number): number {
  let total = 0;
  for (let day = dayOf(from); day <= dayOf(to - 1); day++) {
    const list = recordsOf(day).entries.get(shop.id) ?? [];
    const a = Math.max(from, day * DAY);
    const b = Math.min(to, (day + 1) * DAY);
    total += countBefore(list, b) - countBefore(list, a);
  }
  return total;
}

/** t 时车上的人：驾驶人与乘客。 */
export function occupantsAt(vehicle: string, t: number): { driver?: string; passengers: string[] } {
  const list = recordsOf(dayOf(t)).occupants.get(vehicle) ?? [];
  const here = list.filter((o) => o.start <= t && t < o.end);
  return {
    driver: here.find((o) => o.mode === 'drive')?.person,
    passengers: here.filter((o) => o.mode !== 'drive').map((o) => o.person),
  };
}

/** 公交车在 t 时的车上人数（不含司机）。 */
export const busLoad = (bus: string, t: number) => occupantsAt(bus, t).passengers.length;
