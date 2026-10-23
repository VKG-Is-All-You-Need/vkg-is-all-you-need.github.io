/** 城市示例中的模拟数据源。每个数据源对应联邦查询引擎中的一个 catalog。 */
import { isEnglish } from '../../i18n/runtime';

export type SourceId =
  'gis' | 'traffic' | 'mobility' | 'iot' | 'weather' | 'commerce' | 'hr' | 'community';

export interface DataSource {
  id: SourceId;
  name: string;
  /** 示意的存储方式。 */
  system: string;
  /** 联邦查询引擎（如 Trino）中的 catalog 名。 */
  catalog: string;
  tables: string[];
  refresh: string;
  description: string;
  color: string;
}

type Text = { name: string; refresh: string; description: string; system?: string };

/** 数据源的名称、更新频率与说明随当前语言取值。 */
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
      id: 'gis',
      system: 'PostGIS',
      catalog: 'gis',
      tables: ['buildings', 'roads', 'intersections', 'stations', 'parks'],
      color: '#9fb0bd',
    },
    {
      name: '城市基础数据',
      refresh: '按需更新',
      description: '建筑、道路、路口、地铁站与公园的几何与名称。',
    },
    {
      name: 'Base city data',
      refresh: 'On demand',
      description:
        'Geometries and names of buildings, roads, intersections, metro stations and parks.',
    },
  ),
  source(
    {
      id: 'traffic',
      system: 'TimescaleDB',
      catalog: 'traffic',
      tables: ['vehicles', 'signal_phases', 'vehicle_positions'],
      color: '#49bbdd',
    },
    { name: '交通时序', refresh: '每 5 秒', description: '路口信号相位与车辆 GPS 轨迹。' },
    {
      name: 'Traffic time series',
      refresh: 'Every 5 s',
      description: 'Signal phases at intersections and vehicle GPS trajectories.',
    },
  ),
  source(
    {
      id: 'mobility',
      system: 'Kafka → ClickHouse',
      catalog: 'mobility',
      tables: ['transit_taps', 'ride_orders'],
      color: '#ff9f6b',
    },
    {
      name: '出行服务',
      refresh: '实时',
      description: '公交刷卡记录与网约车订单。乘客以居民编号登记，不含车辆位置。',
    },
    {
      name: 'Mobility service',
      refresh: 'Real time',
      description:
        'Transit card taps and ride-hailing orders. Passengers are registered by resident ID; vehicle positions are not included.',
    },
  ),
  source(
    {
      id: 'iot',
      system: 'MQTT → TimescaleDB',
      catalog: 'iot',
      tables: ['devices', 'footfall', 'env_readings'],
      color: '#7fd38a',
    },
    {
      name: '物联网平台',
      refresh: '每分钟',
      description: '商店门口的客流计数器与街区中的温湿度传感器。设备只记录编号与坐标。',
    },
    {
      name: 'IoT platform',
      refresh: 'Every minute',
      description:
        'Footfall counters at shop entrances and temperature and humidity sensors around the district. Devices only record an ID and coordinates.',
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
      description: '湖滨公园气象站的观测：气温、相对湿度、降水、能见度与风速。',
    },
    {
      name: 'Weather observations',
      system: 'Weather API → Parquet',
      refresh: 'Every 10 min',
      description:
        'Observations from the Lakeside Park weather station: temperature, relative humidity, precipitation, visibility and wind speed.',
    },
  ),
  source(
    {
      id: 'commerce',
      system: 'MySQL（POS）',
      catalog: 'pos',
      tables: ['shops', 'sales_hourly', 'member_purchases'],
      color: '#e6c07b',
    },
    {
      name: '商户系统',
      refresh: '每小时',
      description: '商店名称、类别、营业时间、小时订单数与会员消费记录。',
    },
    {
      name: 'Merchant system',
      system: 'MySQL (POS)',
      refresh: 'Hourly',
      description:
        'Shop names, categories, opening hours, hourly order counts and member purchases.',
    },
  ),
  source(
    {
      id: 'hr',
      system: 'SQL Server（HR）',
      catalog: 'hr',
      tables: ['companies', 'employment', 'work_sessions', 'parking_permits', 'garage_entries'],
      color: '#f29fb8',
    },
    {
      name: '企业与门禁',
      refresh: '实时',
      description: '企业、雇佣关系、上下班记录、员工停车许可与车库进出记录。',
    },
    {
      name: 'Companies and access control',
      system: 'SQL Server (HR)',
      refresh: 'Real time',
      description:
        'Companies, employment, working sessions, employee parking permits and garage entries.',
    },
  ),
  source(
    {
      id: 'community',
      system: 'PostgreSQL（社区 App）',
      catalog: 'community',
      tables: ['residents', 'events', 'event_attendance'],
      color: '#c9a0f0',
    },
    { name: '社区应用', refresh: '实时', description: '居民住址、社区活动与报名记录。' },
    {
      name: 'Community app',
      system: 'PostgreSQL (community app)',
      refresh: 'Real time',
      description: 'Resident addresses, community events and sign-ups.',
    },
  ),
];

export const sourceById = new Map(SOURCES.map((source) => [source.id, source]));
export const ALL_SOURCES = SOURCES.map((source) => source.id);
