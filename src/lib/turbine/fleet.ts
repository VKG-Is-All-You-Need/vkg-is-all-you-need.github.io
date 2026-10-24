/**
 * 设备诊断示例中的机组：两座电厂、两种型号、八台燃气轮机，以及它们的部件与传感器。
 * 型号、部件层级与阈值参数记录在设备主数据中；传感器与部件的对应关系分别记录在两座电厂的历史库中。
 * 部件代号参照电厂标识系统（KKS）的写法，传感器编号沿用 sigRL 论文中的格式（如 S21R1T1）。
 */
import { tr } from '../../i18n/runtime';

export type PlantId = 'A' | 'B';
export type ModelId = 'GT-A' | 'GT-B';
export type TurbineId = 'A1' | 'A2' | 'A3' | 'A4' | 'B1' | 'B2' | 'B3' | 'B4';
export type SensorKind =
  | 'speed'
  | 'flame'
  | 'tip'
  | 'exhaust'
  | 'power'
  | 'vibration'
  | 'inlet'
  | 'pressure'
  | 'fuel'
  | 'bearingTemp';
export type ComponentKind =
  'rotor' | 'compressor' | 'combustor' | 'tip' | 'exhaust' | 'bearing' | 'generator';

export interface Plant {
  id: PlantId;
  name: string;
  /** 存放该电厂归档信号的历史库。 */
  historian: 'hist_a' | 'hist_b';
}

export interface Model {
  id: ModelId;
  /** 额定出力（MW）。 */
  capacity: number;
  speedSensors: number;
  tips: number;
  /** 清吹开始与结束的转速阈值（rpm），取自 sigRL 论文的例子。 */
  purgingSpeed: number;
  nonPurgingSpeed: number;
  /** 判定静止的转速上限（rpm）。 */
  standStillSpeed: number;
  /** 判定高速与低速的转速阈值（rpm）。 */
  fastSpeed: number;
  slowSpeed: number;
  /** 喷嘴温度上限（°C）。 */
  tipLimit: number;
  /** 排气温度参考曲线：15 °C 环境温度下，exhaustBase + exhaustSlope × 负荷率。 */
  exhaustBase: number;
  exhaustSlope: number;
  /** 环境温度每升高 1 °C，排气温度的升高量。 */
  ambientCoef: number;
}

export interface Turbine {
  id: TurbineId;
  /** 论文中的机组编号写法（T1–T6），用于传感器编号。 */
  no: number;
  plant: PlantId;
  model: ModelId;
  /** 设备主数据中的序列号。 */
  serial: string;
  /** 控制系统（DCS）事件日志中的机组代号，两座电厂的命名规则不同。 */
  dcs: string;
  /** 维修管理系统中的设备号。 */
  equipmentNo: string;
}

export interface Component {
  id: string;
  turbine: TurbineId;
  kind: ComponentKind;
  /** KKS 风格的部件代号。 */
  code: string;
  index: number;
}

export interface Sensor {
  tag: string;
  turbine: TurbineId;
  component: string;
  kind: SensorKind;
  /** 同一机组内同类传感器的序号（从 1 起）。 */
  index: number;
  /** 历史库中的数值主键。 */
  dbId: number;
}

export const PLANTS: Record<PlantId, Plant> = {
  A: {
    id: 'A',
    get name() {
      return tr('北港电厂', 'North Harbor plant');
    },
    historian: 'hist_a',
  },
  B: {
    id: 'B',
    get name() {
      return tr('西岭电厂', 'Westridge plant');
    },
    historian: 'hist_b',
  },
};

export const MODELS: Record<ModelId, Model> = {
  'GT-A': {
    id: 'GT-A',
    capacity: 60,
    speedSensors: 3,
    tips: 6,
    purgingSpeed: 1300,
    nonPurgingSpeed: 800,
    standStillSpeed: 60,
    fastSpeed: 2900,
    slowSpeed: 1000,
    tipLimit: 650,
    exhaustBase: 330,
    exhaustSlope: 190,
    ambientCoef: 1.6,
  },
  'GT-B': {
    id: 'GT-B',
    capacity: 40,
    speedSensors: 4,
    tips: 4,
    purgingSpeed: 1000,
    nonPurgingSpeed: 700,
    standStillSpeed: 60,
    fastSpeed: 2900,
    slowSpeed: 1000,
    tipLimit: 640,
    exhaustBase: 320,
    exhaustSlope: 200,
    ambientCoef: 1.6,
  },
};

export const TURBINES: Turbine[] = [
  {
    id: 'A1',
    no: 1,
    plant: 'A',
    model: 'GT-A',
    serial: 'GA-60-0418',
    dcs: 'NH-GT1',
    equipmentNo: '10004711',
  },
  {
    id: 'A2',
    no: 2,
    plant: 'A',
    model: 'GT-B',
    serial: 'GB-40-0233',
    dcs: 'NH-GT2',
    equipmentNo: '10004712',
  },
  {
    id: 'A3',
    no: 3,
    plant: 'A',
    model: 'GT-A',
    serial: 'GA-60-0207',
    dcs: 'NH-GT3',
    equipmentNo: '10004713',
  },
  {
    id: 'A4',
    no: 7,
    plant: 'A',
    model: 'GT-B',
    serial: 'GB-40-0302',
    dcs: 'NH-GT4',
    equipmentNo: '10004714',
  },
  {
    id: 'B1',
    no: 4,
    plant: 'B',
    model: 'GT-A',
    serial: 'GA-60-0452',
    dcs: '11MBA',
    equipmentNo: '20007301',
  },
  {
    id: 'B2',
    no: 5,
    plant: 'B',
    model: 'GT-B',
    serial: 'GB-40-0281',
    dcs: '12MBA',
    equipmentNo: '20007302',
  },
  {
    id: 'B3',
    no: 6,
    plant: 'B',
    model: 'GT-A',
    serial: 'GA-60-0390',
    dcs: '13MBA',
    equipmentNo: '20007303',
  },
  {
    id: 'B4',
    no: 8,
    plant: 'B',
    model: 'GT-B',
    serial: 'GB-40-0317',
    dcs: '14MBA',
    equipmentNo: '20007304',
  },
];

export const turbineById = new Map(TURBINES.map((t) => [t.id, t]));
export const modelOf = (id: TurbineId) => MODELS[turbineById.get(id)!.model];
export const plantOf = (id: TurbineId) => PLANTS[turbineById.get(id)!.plant];

const COMPONENT_CODES: Record<ComponentKind, string> = {
  rotor: 'MBA10',
  compressor: 'MBA20',
  combustor: 'MBM10',
  tip: 'MBM1',
  exhaust: 'MBR10',
  bearing: 'MBD',
  generator: 'MKA10',
};

/** 喷嘴的部件代号：MBM11、MBM12…；轴承：MBD10、MBD20。 */
function componentCode(kind: ComponentKind, index: number) {
  if (kind === 'tip') return `${COMPONENT_CODES.tip}${index}`;
  if (kind === 'bearing') return `${COMPONENT_CODES.bearing}${index}0`;
  return COMPONENT_CODES[kind];
}

export const COMPONENTS: Component[] = [];
export const SENSORS: Sensor[] = [];

for (const turbine of TURBINES) {
  const model = MODELS[turbine.model];
  const add = (kind: ComponentKind, index = 1) => {
    const code = componentCode(kind, index);
    const component = { id: `${turbine.id}/${code}`, turbine: turbine.id, kind, code, index };
    COMPONENTS.push(component);
    return component;
  };
  const sense = (kind: SensorKind, component: Component, index: number, tag: string) => {
    SENSORS.push({
      tag,
      turbine: turbine.id,
      component: component.id,
      kind,
      index,
      dbId: turbine.no * 1000 + SENSORS.filter((s) => s.turbine === turbine.id).length + 1,
    });
  };
  const n = turbine.no;
  const rotor = add('rotor');
  for (let i = 1; i <= model.speedSensors; i++) sense('speed', rotor, i, `S2${i}R1T${n}`);
  const combustor = add('combustor');
  sense('flame', combustor, 1, `F01C1T${n}`);
  for (let i = 1; i <= model.tips; i++) sense('tip', add('tip', i), i, `T4${i}B1T${n}`);
  sense('exhaust', add('exhaust'), 1, `T51E1T${n}`);
  const bearings = [1, 2].map((i) => add('bearing', i));
  bearings.forEach((bearing, i) => sense('vibration', bearing, i + 1, `V6${i + 1}D${i + 1}T${n}`));
  sense('power', add('generator'), 1, `P01G1T${n}`);
  // 更细粒度的传感器：进气温度、压气机出口压力、燃料流量与轴承温度
  const compressor = add('compressor');
  sense('inlet', compressor, 1, `T11K1T${n}`);
  sense('pressure', compressor, 1, `P21K1T${n}`);
  sense('fuel', combustor, 1, `Q31C1T${n}`);
  bearings.forEach((bearing, i) =>
    sense('bearingTemp', bearing, i + 1, `T7${i + 1}D${i + 1}T${n}`),
  );
}

export const sensorByTag = new Map(SENSORS.map((s) => [s.tag, s]));
export const componentById = new Map(COMPONENTS.map((c) => [c.id, c]));

export const sensorsOf = (turbine: TurbineId, kind?: SensorKind) =>
  SENSORS.filter((s) => s.turbine === turbine && (!kind || s.kind === kind));

export const componentsOf = (turbine: TurbineId, kind?: ComponentKind) =>
  COMPONENTS.filter((c) => c.turbine === turbine && (!kind || c.kind === kind));

export const SENSOR_UNITS: Record<SensorKind, string> = {
  speed: 'rpm',
  flame: '',
  tip: '°C',
  exhaust: '°C',
  power: 'MW',
  vibration: 'mm/s',
  inlet: '°C',
  pressure: 'bar',
  fuel: 'kg/s',
  bearingTemp: '°C',
};

/** 本体中的传感器类。 */
export const SENSOR_CLASSES: Record<SensorKind, string> = {
  speed: ':RotorSpeedSensor',
  flame: ':FlameSensor',
  tip: ':TemperatureSensor',
  exhaust: ':TemperatureSensor',
  power: ':PowerMeter',
  vibration: ':VibrationSensor',
  inlet: ':TemperatureSensor',
  pressure: ':PressureSensor',
  fuel: ':FlowSensor',
  bearingTemp: ':TemperatureSensor',
};

export const sensorKindLabel = (kind: SensorKind) =>
  ({
    speed: tr('转速', 'Rotor speed'),
    flame: tr('火焰', 'Flame'),
    tip: tr('喷嘴温度', 'Burner tip temperature'),
    exhaust: tr('排气温度', 'Exhaust temperature'),
    power: tr('有功出力', 'Active power'),
    vibration: tr('轴承振动', 'Bearing vibration'),
    inlet: tr('进气温度', 'Inlet temperature'),
    pressure: tr('压气机出口压力', 'Compressor discharge pressure'),
    fuel: tr('燃料流量', 'Fuel flow'),
    bearingTemp: tr('轴承温度', 'Bearing temperature'),
  })[kind];

export const componentLabel = (component: Component) =>
  ({
    rotor: tr('转子', 'Rotor'),
    compressor: tr('压气机', 'Compressor'),
    combustor: tr('燃烧室', 'Combustor'),
    tip: tr(`${component.index} 号喷嘴`, `Burner tip ${component.index}`),
    exhaust: tr('排气段', 'Exhaust'),
    bearing: tr(`${component.index} 号轴承`, `Bearing ${component.index}`),
    generator: tr('发电机', 'Generator'),
  })[component.kind];

/** 简短的部件名，如 BT4、BR2。 */
export const componentShort = (component: Component) =>
  ({
    rotor: 'R1',
    compressor: 'CP',
    combustor: 'CB',
    tip: `BT${component.index}`,
    exhaust: 'EX',
    bearing: `BR${component.index}`,
    generator: 'GN',
  })[component.kind];
