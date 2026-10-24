/** 设备诊断示例中的模拟数据源。每个数据源对应联邦查询引擎中的一个 catalog。 */
import { isEnglish } from '../../i18n/runtime';

export type SourceId =
  'hist_a' | 'hist_b' | 'live' | 'master' | 'events' | 'cmms' | 'dispatch' | 'weather';

export interface DataSource {
  id: SourceId;
  name: string;
  /** 示意的存储方式。 */
  system: string;
  catalog: string;
  tables: string[];
  refresh: string;
  description: string;
  color: string;
}

type Text = { name: string; refresh: string; description: string; system?: string };

function source(
  fixed: Omit<DataSource, 'name' | 'refresh' | 'description'>,
  zh: Text,
  en: Text,
): DataSource {
  const text = () => (isEnglish() ? en : zh);
  return {
    ...fixed,
    get name() {
      return text().name;
    },
    get refresh() {
      return text().refresh;
    },
    get description() {
      return text().description;
    },
    get system() {
      return text().system ?? fixed.system;
    },
  };
}

export const SOURCES: DataSource[] = [
  source(
    {
      id: 'hist_a',
      system: 'Teradata',
      catalog: 'hist_a',
      tables: ['turbine_components', 'sensors', 'measurements'],
      color: '#49bbdd',
    },
    {
      name: '历史库 A',
      refresh: '每 10 分钟批量入库',
      description:
        '北港电厂的信号归档。部件与传感器分表存放，传感器类型以数字编码，温度单位为摄氏度。',
    },
    {
      name: 'Historian A',
      refresh: 'Batch load every 10 min',
      description:
        'Signal archive of the North Harbor plant. Components and sensors are stored in separate tables, sensor types are numeric codes, and temperatures are in degrees Celsius.',
    },
  ),
  source(
    {
      id: 'hist_b',
      system: 'Oracle',
      catalog: 'hist_b',
      tables: ['turbine_components', 'measurements'],
      color: '#7fd38a',
    },
    {
      name: '历史库 B',
      refresh: '每 10 分钟批量入库',
      description: '西岭电厂的信号归档。部件与传感器合并在一张表中，温度单位为华氏度。',
    },
    {
      name: 'Historian B',
      refresh: 'Batch load every 10 min',
      description:
        'Signal archive of the Westridge plant. Components and sensors share one table, and temperatures are in degrees Fahrenheit.',
    },
  ),
  source(
    {
      id: 'live',
      system: 'Kafka → ExaStream',
      catalog: 'live',
      tables: ['live_measurements'],
      color: '#ff9f6b',
    },
    {
      name: '实时流',
      refresh: '每秒',
      description:
        '两座电厂的实时信号，保留最近 10 分钟。字段与历史库的 measurements 相同，以传感器编号标识。',
    },
    {
      name: 'Live stream',
      refresh: 'Every second',
      description:
        'Live signals from both plants, retained for 10 minutes. Fields match the historian measurements tables, keyed by sensor tag.',
    },
  ),
  source(
    {
      id: 'master',
      system: 'SQL Server',
      catalog: 'master',
      tables: ['turbines', 'models', 'parameters', 'id_map'],
      color: '#9fb0bd',
    },
    {
      name: '设备主数据',
      refresh: '按需更新',
      description:
        '机组型号、额定出力、诊断阈值与排气温度参考曲线，以及序列号、控制系统代号与维修设备号的对照。',
    },
    {
      name: 'Equipment master data',
      refresh: 'On demand',
      description:
        'Turbine models, rated output, diagnostic thresholds and exhaust temperature reference curves, together with the cross-reference of serial numbers, control system codes and maintenance equipment numbers.',
    },
  ),
  source(
    {
      id: 'events',
      system: 'PostgreSQL（DCS 事件）',
      catalog: 'events',
      tables: ['alarm_log'],
      color: '#f29fb8',
    },
    {
      name: '控制系统事件',
      refresh: '实时',
      description:
        '启动、点火、跳闸与报警事件。两座电厂的机组代号与事件代码各自编排，如 BT_TEMP_HI 与 E2041。',
    },
    {
      name: 'Control system events',
      system: 'PostgreSQL (DCS events)',
      refresh: 'Real time',
      description:
        'Start, ignition, trip and alarm events. The two plants use their own unit codes and event codes, such as BT_TEMP_HI and E2041.',
    },
  ),
  source(
    {
      id: 'cmms',
      system: 'SAP PM',
      catalog: 'cmms',
      tables: ['work_orders', 'installed_parts'],
      color: '#e6c07b',
    },
    {
      name: '维修管理',
      refresh: '每天',
      description: '检修工单、更换零件的批次与检查周期，以维修设备号标识机组。',
    },
    {
      name: 'Maintenance management',
      refresh: 'Daily',
      description:
        'Work orders, batches of replaced parts and inspection intervals, with turbines identified by maintenance equipment number.',
    },
  ),
  source(
    {
      id: 'dispatch',
      system: '调度系统 → CSV',
      catalog: 'dispatch',
      tables: ['unit_schedule'],
      color: '#c9a0f0',
    },
    {
      name: '调度计划',
      refresh: '每 15 分钟',
      description: '电网调度下达的各机组计划出力曲线，以序列号标识机组。',
    },
    {
      name: 'Dispatch schedule',
      system: 'Dispatch system → CSV',
      refresh: 'Every 15 min',
      description:
        'Planned output curves issued by the grid operator for each turbine, identified by serial number.',
    },
  ),
  source(
    {
      id: 'weather',
      system: '气象接口 → Parquet',
      catalog: 'weather',
      tables: ['observations'],
      color: '#9aa8ff',
    },
    {
      name: '气象观测',
      refresh: '每 10 分钟',
      description: '两座电厂所在地的环境温度与相对湿度。',
    },
    {
      name: 'Weather observations',
      system: 'Weather API → Parquet',
      refresh: 'Every 10 min',
      description: 'Ambient temperature and relative humidity at both plant sites.',
    },
  ),
];

export const sourceById = new Map(SOURCES.map((source) => [source.id, source]));
export const ALL_SOURCES = SOURCES.map((source) => source.id);
/** 信号所在的三个数据源。 */
export const SIGNAL_SOURCES: SourceId[] = ['hist_a', 'hist_b', 'live'];
