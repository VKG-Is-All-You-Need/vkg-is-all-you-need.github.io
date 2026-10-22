/**
 * 车辆登记，一周内不变。每辆车都有驾驶人：
 * - 网约车三辆，其中一辆的司机是王磊；
 * - 员工车辆：有停车许可的居民开车上下班，车停在公司车库；
 * - 外来车辆：开车来上班的外来上班族与开车来商场的访客，车停在街区内的车库；
 * - 配送车：青禾物流的配送员驾驶，在商店门口停靠卸货；
 * - 过境车辆：外来人员驾驶，从街区边缘驶入，穿过街区后驶出，约三成常有同乘者；
 * - 公交车四辆，每辆早晚两班司机。
 * 车辆每天怎么走见 traffic.ts。
 */
import { seededRandom } from '../geo/spatial';
import { carOwners, outsiders, staff } from './people';

export type VehicleKind = 'car' | 'van' | 'taxi' | 'bus';
export type VehicleRole = 'taxi' | 'commuter' | 'guest' | 'van' | 'through' | 'bus';

export interface Vehicle {
  id: string;
  kind: VehicleKind;
  role: VehicleRole;
  plate: string;
  color: string;
  /** 固定的驾驶人（人物编号）；公交按班次换司机，见 busCrews。 */
  driver?: string;
  /** 有停车许可的车主（居民编号）。 */
  owner?: string;
  /** 常一同乘车的人。 */
  companion?: string;
}

const COLORS = ['#e8e4dc', '#3a3f46', '#b8c2cc', '#8e2f2f', '#2f5d8e', '#c9b27a', '#556b4f'];

function buildVehicles(): Vehicle[] {
  const random = seededRandom(31);
  const list: Vehicle[] = [];
  const plates = new Set<string>();
  const plate = () => {
    let text: string;
    do text = `沪A·${String(10000 + Math.floor(random() * 89999))}`;
    while (plates.has(text));
    plates.add(text);
    return text;
  };
  const add = (role: VehicleRole, kind: VehicleKind, extra: Partial<Vehicle>) =>
    list.push({
      id: `V${String(list.length + 1).padStart(4, '0')}`,
      kind,
      role,
      plate: plate(),
      color:
        kind === 'taxi'
          ? '#e6c07b'
          : kind === 'van'
            ? '#d9dde2'
            : COLORS[Math.floor(random() * COLORS.length)],
      ...extra,
    });
  add('taxi', 'taxi', { driver: 'P05' });
  for (const driver of staff.taxi) add('taxi', 'taxi', { driver });
  for (const owner of carOwners)
    add('commuter', 'car', { owner: owner.person, driver: owner.person });
  for (const person of outsiders.filter((p) => p.drives))
    add('guest', 'car', { driver: person.id });
  for (const driver of staff.courier) add('van', 'van', { driver });
  for (const { driver, companion } of staff.through) add('through', 'car', { driver, companion });
  for (let b = 0; b < 4; b++) {
    list.push({
      id: `B${b + 1}`,
      kind: 'bus',
      role: 'bus',
      plate: `公交 ${b + 1}`,
      color: '#3f8f6a',
    });
  }
  return list;
}

export const vehicles = buildVehicles();
export const vehicleById = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));
/** 车主（居民编号）到车辆：停车许可。 */
export const vehicleByOwner = new Map(
  vehicles.filter((v) => v.owner).map((vehicle) => [vehicle.owner!, vehicle]),
);
/** 驾驶人到车辆（固定驾驶人的车）。 */
export const vehicleByDriver = new Map(
  vehicles.filter((v) => v.driver).map((vehicle) => [vehicle.driver!, vehicle]),
);
export const vehiclesOf = (role: VehicleRole) => vehicles.filter((v) => v.role === role);

/** 公交司机：早班从发车开到午后换班，晚班接着开到末班。 */
export const busCrews = vehiclesOf('bus').map((bus, i) => ({
  bus: bus.id,
  early: staff.bus[i * 2],
  late: staff.bus[i * 2 + 1],
}));
