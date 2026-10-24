/**
 * 信号以外的记录：控制系统事件、维修工单、调度计划与气象观测。
 * 两座电厂的事件代码与机组代号写法不同，维修系统以设备号标识机组，调度计划以序列号标识机组；
 * 它们在映射中统一到同一个机组 IRI 与同一组事件类。
 */
import { tr } from '../../i18n/runtime';
import { turbineById, type PlantId, type TurbineId } from './fleet';
import { ambientAt, interpolate } from './signals';
import { BATCH, DATE } from './time';

export type EventType =
  | 'start'
  | 'ignition'
  | 'flameLoss'
  | 'purge'
  | 'abort'
  | 'trip'
  | 'sync'
  | 'fault'
  | 'runback'
  | 'shutdown'
  | 'flameOff';

export interface ControlEvent {
  turbine: TurbineId;
  /** 控制系统中的机组代号。 */
  dcs: string;
  t: number;
  type: EventType;
  /** 电厂自己的事件代码。 */
  code: string;
  /** 涉及的部件代号（如 MBM14）。 */
  component?: string;
}

/** 两座电厂的事件代码：北港电厂用文字代码，西岭电厂用数字代码。 */
const EVENT_CODES: Record<PlantId, Record<EventType, string>> = {
  A: {
    start: 'START_CMD',
    ignition: 'IGN_ON',
    flameLoss: 'FLAME_LOSS',
    purge: 'PURGE_ON',
    abort: 'START_ABORT',
    trip: 'TRIP',
    sync: 'GEN_SYNC',
    fault: 'BT_TEMP_HI',
    runback: 'LOAD_RUNBACK',
    shutdown: 'STOP_CMD',
    flameOff: 'FLAME_OFF',
  },
  B: {
    start: 'E1001',
    ignition: 'E1010',
    flameLoss: 'E2010',
    purge: 'E1005',
    abort: 'E2090',
    trip: 'E2099',
    sync: 'E1020',
    fault: 'E2041',
    runback: 'E2050',
    shutdown: 'E1002',
    flameOff: 'E1012',
  },
};

/** 事件类型对应的本体类。 */
export const EVENT_CLASSES: Record<EventType, string> = {
  start: ':StartCommand',
  ignition: ':Ignition',
  flameLoss: ':FlameLoss',
  purge: ':PurgeStart',
  abort: ':StartAbort',
  trip: ':Trip',
  sync: ':GridSync',
  fault: ':BurnerTipOvertemperature',
  runback: ':LoadRunback',
  shutdown: ':StopCommand',
  flameOff: ':FlameOff',
};

export const eventLabel = (type: EventType) =>
  ({
    start: tr('启动指令', 'Start command'),
    ignition: tr('点火', 'Ignition'),
    flameLoss: tr('火焰丢失', 'Flame loss'),
    purge: tr('清吹开始', 'Purge start'),
    abort: tr('启动中止', 'Start aborted'),
    trip: tr('跳闸', 'Trip'),
    sync: tr('并网', 'Grid sync'),
    fault: tr('喷嘴温度高', 'Burner tip overtemperature'),
    runback: tr('自动降负荷', 'Load runback'),
    shutdown: tr('停机指令', 'Stop command'),
    flameOff: tr('熄火', 'Flame off'),
  })[type];

const RAW_EVENTS: [TurbineId, number, EventType, string?][] = [
  ['A1', 240, 'start'],
  ['A1', 300, 'ignition'],
  ['A1', 318, 'flameLoss'],
  ['A1', 331, 'purge'],
  ['A1', 480, 'ignition'],
  ['A1', 900, 'sync'],
  ['A2', 600, 'start'],
  ['A2', 660, 'ignition'],
  ['A2', 674, 'flameLoss'],
  ['A2', 682, 'purge'],
  ['A2', 930, 'abort'],
  ['A3', 2463, 'fault', 'MBM14'],
  ['A3', 2465, 'runback'],
  ['B1', 1403, 'fault', 'MBM13'],
  ['B1', 1405, 'runback'],
  ['B2', 600, 'start'],
  ['B2', 765, 'ignition'],
  ['B2', 870, 'trip'],
  ['B2', 1800, 'start'],
  ['B2', 1965, 'ignition'],
  ['B2', 2400, 'sync'],
  ['B3', 2700, 'shutdown'],
  ['B3', 3000, 'flameOff'],
];

/** 按时间排序的事件。 */
export const EVENTS: ControlEvent[] = RAW_EVENTS.map(([id, t, type, component]) => {
  const turbine = turbineById.get(id)!;
  return {
    turbine: id,
    dcs: turbine.dcs,
    t,
    type,
    code: EVENT_CODES[turbine.plant][type],
    component,
  };
}).sort((a, b) => a.t - b.t);

export const eventsUntil = (now: number) => EVENTS.filter((e) => e.t <= now);

// ── 维修管理系统 ──

export type WorkType = 'replace' | 'inspect' | 'calibrate';

export interface WorkOrder {
  id: string;
  turbine: TurbineId;
  equipmentNo: string;
  /** 部件代号；MBM1* 表示全部喷嘴。 */
  component: string;
  date: string;
  type: WorkType;
  /** 更换零件的批次。 */
  batch?: string;
}

const RAW_ORDERS: [TurbineId, string, string, WorkType, string?][] = [
  ['A1', 'MBM1*', '2026-06-12', 'replace', 'L17'],
  ['A1', 'MBD10', '2026-09-30', 'inspect'],
  ['A2', 'MBM1*', '2025-11-20', 'replace', 'L12'],
  ['A2', 'MBM10', '2026-05-03', 'inspect'],
  ['A2', 'MBA10', '2026-10-10', 'calibrate'],
  ['A3', 'MBM1*', '2024-03-15', 'replace', 'L09'],
  ['A3', 'MBM10', '2025-07-08', 'inspect'],
  ['B1', 'MBM1*', '2026-08-20', 'replace', 'L17'],
  ['B2', 'MBM1*', '2025-12-02', 'replace', 'L12'],
  ['B2', 'MBM10', '2026-09-14', 'replace'],
  ['B3', 'MBM1*', '2026-04-02', 'replace', 'L22'],
  ['B3', 'MBD20', '2026-10-21', 'replace', 'K03'],
  ['A4', 'MBM1*', '2026-01-15', 'replace', 'L12'],
  ['A4', 'MBM10', '2026-07-02', 'inspect'],
  ['B4', 'MBM1*', '2026-03-11', 'replace', 'L22'],
];

export const WORK_ORDERS: WorkOrder[] = RAW_ORDERS.map(([id, component, date, type, batch], i) => ({
  id: `WO-${4100 + i * 7}`,
  turbine: id,
  equipmentNo: turbineById.get(id)!.equipmentNo,
  component,
  date,
  type,
  batch,
}));

/** 燃烧器检查周期（月）。 */
export const INSPECTION_MONTHS = 12;

export const workLabel = (order: WorkOrder) => {
  const what =
    order.component === 'MBM1*'
      ? tr('全部喷嘴', 'all burner tips')
      : order.component === 'MBM10'
        ? tr('燃烧室', 'combustor')
        : order.component === 'MBA10'
          ? tr('转速传感器', 'speed sensors')
          : order.component.startsWith('MBD')
            ? tr(`${order.component[3]} 号轴承`, `bearing ${order.component[3]}`)
            : order.component;
  const verb = {
    replace: tr('更换', 'Replaced '),
    inspect: tr('检查', 'Inspected '),
    calibrate: tr('校准', 'Calibrated '),
  }[order.type];
  return `${verb}${what}`;
};

/** 两个日期之间的天数。 */
export const daysBetween = (from: string, to = DATE) =>
  Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

/** 某部件当前安装的零件批次（取最近一次更换记录）。 */
export function batchOf(turbine: TurbineId, code: string): WorkOrder | undefined {
  return WORK_ORDERS.filter(
    (o) =>
      o.turbine === turbine &&
      o.type === 'replace' &&
      o.batch &&
      (o.component === code || (o.component === 'MBM1*' && code.startsWith('MBM1'))),
  ).sort((a, b) => b.date.localeCompare(a.date))[0];
}

/** 最近一次燃烧器检查或喷嘴更换。 */
export function lastBurnerService(turbine: TurbineId): WorkOrder {
  return WORK_ORDERS.filter(
    (o) =>
      o.turbine === turbine &&
      ((o.component === 'MBM10' && o.type === 'inspect') ||
        (o.component === 'MBM1*' && o.type === 'replace')),
  ).sort((a, b) => b.date.localeCompare(a.date))[0];
}

// ── 调度计划 ──

/** 各机组的计划出力（MW），以序列号登记。 */
export const DISPATCH: Record<TurbineId, [number, number][]> = {
  A1: [
    [0, 0],
    [900, 0],
    [2100, 55],
  ],
  A2: [
    [0, 0],
    [1200, 0],
    [2100, 30],
  ],
  A3: [[0, 52]],
  A4: [[0, 34]],
  B1: [[0, 50]],
  B4: [[0, 36]],
  B2: [
    [0, 0],
    [1200, 0],
    [2400, 35],
  ],
  B3: [
    [0, 45],
    [2700, 45],
    [3000, 0],
  ],
};

export const plannedPower = (turbine: TurbineId, t: number) => interpolate(DISPATCH[turbine], t);

// ── 气象 ──

/** 截至 now 的最近一次气象观测（每 10 分钟一次）。 */
export function weatherAt(plant: PlantId, now: number) {
  const t = Math.floor(now / BATCH) * BATCH;
  const { temp, humidity } = ambientAt(plant, t);
  return { t, temp: Math.round(temp * 10) / 10, humidity: Math.round(humidity) };
}
