/** 城市示例中的模拟数据源。每个数据源对应联邦查询引擎中的一个 catalog。 */

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

export const SOURCES: DataSource[] = [
  {
    id: 'gis',
    name: '城市基础数据',
    system: 'PostGIS',
    catalog: 'gis',
    tables: ['buildings', 'roads', 'intersections', 'stations', 'parks'],
    refresh: '按需更新',
    description: '建筑、道路、路口、地铁站与公园的几何与名称。',
    color: '#9fb0bd',
  },
  {
    id: 'traffic',
    name: '交通时序',
    system: 'TimescaleDB',
    catalog: 'traffic',
    tables: ['vehicles', 'signal_phases', 'vehicle_positions'],
    refresh: '每 5 秒',
    description: '路口信号相位与车辆 GPS 轨迹。',
    color: '#49bbdd',
  },
  {
    id: 'mobility',
    name: '出行服务',
    system: 'Kafka → ClickHouse',
    catalog: 'mobility',
    tables: ['transit_taps', 'ride_orders'],
    refresh: '实时',
    description: '公交刷卡记录与网约车订单。乘客以居民编号登记，不含车辆位置。',
    color: '#ff9f6b',
  },
  {
    id: 'iot',
    name: '物联网平台',
    system: 'MQTT → TimescaleDB',
    catalog: 'iot',
    tables: ['devices', 'footfall', 'env_readings'],
    refresh: '每分钟',
    description: '商店门口的客流计数器与街区中的温湿度传感器。设备只记录编号与坐标。',
    color: '#7fd38a',
  },
  {
    id: 'weather',
    name: '气象观测',
    system: '气象接口 → Parquet',
    catalog: 'weather',
    tables: ['observations'],
    refresh: '每 10 分钟',
    description: '湖滨公园气象站的观测：气温、相对湿度、降水、能见度与风速。',
    color: '#9aa8ff',
  },
  {
    id: 'commerce',
    name: '商户系统',
    system: 'MySQL（POS）',
    catalog: 'pos',
    tables: ['shops', 'sales_hourly', 'member_purchases'],
    refresh: '每小时',
    description: '商店名称、类别、营业时间、小时订单数与会员消费记录。',
    color: '#e6c07b',
  },
  {
    id: 'hr',
    name: '企业与门禁',
    system: 'SQL Server（HR）',
    catalog: 'hr',
    tables: ['companies', 'employment', 'work_sessions', 'parking_permits', 'garage_entries'],
    refresh: '实时',
    description: '企业、雇佣关系、上下班记录、员工停车许可与车库进出记录。',
    color: '#f29fb8',
  },
  {
    id: 'community',
    name: '社区应用',
    system: 'PostgreSQL（社区 App）',
    catalog: 'community',
    tables: ['residents', 'events', 'event_attendance'],
    refresh: '实时',
    description: '居民住址、社区活动与报名记录。',
    color: '#c9a0f0',
  },
];

export const sourceById = new Map(SOURCES.map((source) => [source.id, source]));
export const ALL_SOURCES = SOURCES.map((source) => source.id);
