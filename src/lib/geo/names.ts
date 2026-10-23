/**
 * 示例街区中名称与类别的英文写法。数据内部始终使用中文作为标识（如 kind === '咖啡馆'），
 * 显示时经 term() 转换为当前语言，英文版的源表、SPARQL 与 SQL 中也使用转换后的写法。
 */
import { isEnglish } from '../../i18n/runtime';

const ESTATES: Record<string, string> = {
  梧桐里: 'Parasol Lane',
  云杉苑: 'Spruce Garden',
  银杏坊: 'Ginkgo Court',
  枫林居: 'Maple Grove',
  青檀苑: 'Sandalwood Garden',
  松风里: 'Pine Breeze Lane',
  竹溪坊: 'Bamboo Creek Court',
  桂园: 'Osmanthus Garden',
  柳岸居: 'Willow Bank',
  槐荫里: 'Acacia Lane',
  樱花苑: 'Cherry Garden',
  杏林坊: 'Apricot Court',
  榆园: 'Elm Garden',
  楠溪里: 'Cedar Creek Lane',
  枫桥苑: 'Maple Bridge Garden',
  柏庐: 'Cypress Lodge',
  海棠里: 'Crabapple Lane',
  丁香苑: 'Lilac Garden',
  玉兰坊: 'Magnolia Court',
  紫藤居: 'Wisteria Grove',
  芙蓉里: 'Hibiscus Lane',
  蔷薇苑: 'Rose Garden',
  茉莉坊: 'Jasmine Court',
  栀子居: 'Gardenia Grove',
};

const TERMS: Record<string, string> = {
  // 具名建筑
  拾光咖啡: 'Glimmer Cafe',
  街角咖啡: 'Corner Cafe',
  梧桐咖啡: 'Parasol Cafe',
  云朵咖啡: 'Cloud Cafe',
  北窗咖啡: 'North Window Cafe',
  河岸咖啡: 'Riverbank Cafe',
  码头咖啡: 'Pier Cafe',
  第一中学: 'No. 1 Middle School',
  实验小学: 'Experimental Primary School',
  市立医院: 'City Hospital',
  市图书馆: 'City Library',
  城市博物馆: 'City Museum',
  湖心茶室: 'Lakeheart Teahouse',
  游客中心: 'Visitor Center',
  星河商场: 'Galaxy Mall',
  中央大厦: 'Central Tower',
  湖畔公寓: 'Lakeside Apartments',
  // 建筑类别（buildings.kind）
  住宅: 'residential',
  办公: 'office',
  商店: 'shop',
  商场: 'mall',
  咖啡馆: 'cafe',
  学校: 'school',
  医院: 'hospital',
  图书馆: 'library',
  博物馆: 'museum',
  茶室: 'teahouse',
  // 地铁站、线路与公园
  中心站: 'Central Station',
  湖滨站: 'Lakeside Station',
  北站: 'North Station',
  '1 号线、2 号线': 'Line 1, Line 2',
  '1 号线': 'Line 1',
  '2 号线': 'Line 2',
  湖滨公园: 'Lakeside Park',
  湖滨公园气象站: 'Lakeside Park weather station',
  // 道路
  银杏路: 'Ginkgo Road',
  梧桐路: 'Parasol Road',
  中央大道: 'Central Avenue',
  星河路: 'Galaxy Road',
  湖滨路: 'Lakeside Road',
  文华街: 'Culture Street',
  人民路: "People's Road",
  北园街: 'North Garden Street',
  // 企业
  星河科技: 'Galaxy Tech',
  云杉设计: 'Spruce Design',
  畅行出行: 'SmoothRide',
  // 人物与职业
  林晓: 'Lin Xiao',
  周宁: 'Zhou Ning',
  孙浩: 'Sun Hao',
  陈雨: 'Chen Yu',
  王磊: 'Wang Lei',
  赵敏: 'Zhao Min',
  软件工程师: 'Software engineer',
  产品经理: 'Product manager',
  后端工程师: 'Backend engineer',
  护士: 'Nurse',
  网约车司机: 'Ride-hailing driver',
  街角咖啡店主: 'Owner of Corner Cafe',
  上班族: 'Office worker',
  公交司机: 'Bus driver',
  配送员: 'Courier',
  驾车路过: 'Driving through',
  // 社区活动
  读书会: 'Book club',
  夜跑: 'Night run',
  周末市集筹备会: 'Weekend market planning meeting',
  周末市集: 'Weekend market',
  // 商店类别（shops.category）
  咖啡: 'coffee',
  便利店: 'convenience store',
  花店: 'florist',
  面包店: 'bakery',
  // 传感器安装位置
  路灯杆: 'lamp post',
  屋顶: 'rooftop',
  公园: 'park',
  // 天气
  晴: 'Clear',
  多云: 'Cloudy',
  阴: 'Overcast',
  小雨: 'Light rain',
  中雨: 'Moderate rain',
  大雨: 'Heavy rain',
  雷阵雨: 'Thunderstorm',
  雾: 'Fog',
  大雾: 'Dense fog',
  大风: 'Strong wind',
  降雨: 'Rain',
  早高峰: 'Morning rush',
  晚高峰: 'Evening rush',
  多云转中雨: 'Cloudy, then moderate rain',
  晨雾转多云: 'Morning fog, then cloudy',
  晴热: 'Hot and clear',
  午后雷阵雨: 'Afternoon thunderstorms',
  大风降温: 'Windy and cooler',
  // 星期
  周一: 'Mon',
  周二: 'Tue',
  周三: 'Wed',
  周四: 'Thu',
  周五: 'Fri',
  周六: 'Sat',
  周日: 'Sun',
};

const GATE_SIDES: Record<string, string> = {
  南口: 'south end',
  北口: 'north end',
  西口: 'west end',
  东口: 'east end',
};

const SHOP_SUFFIXES: Record<string, string> = {
  商铺: 'Shops',
  便利店: 'Convenience Store',
  花店: 'Florist',
  面包房: 'Bakery',
};

const ESTATE_PATTERN = new RegExp(`^(${Object.keys(ESTATES).join('|')})(.+)$`);
const GATE_PATTERN = new RegExp(`^(.+?)(${Object.keys(GATE_SIDES).join('|')})$`);

function translate(zh: string): string | undefined {
  const exact = TERMS[zh] ?? ESTATES[zh];
  if (exact) return exact;

  // 路口 “湖滨路 × 文华街”、路段 “湖滨路（文华街—人民路）”，路段终点可能是边缘出入口（如 “南口”）
  if (zh.includes(' × ')) return zh.split(' × ').map(term).join(' × ');
  const segment = /^(.+)（(.+)—(.+)）$/.exec(zh);
  if (segment) {
    const end = GATE_SIDES[segment[3]] ?? term(segment[3]);
    return `${term(segment[1])} (${term(segment[2])}–${end})`;
  }
  const plate = /^沪A·(\d+)$/.exec(zh);
  if (plate) return `SH-A ${plate[1]}`;
  const bus = /^公交 (\d+)$/.exec(zh);
  if (bus) return `Bus ${bus[1]}`;

  const estate = ESTATE_PATTERN.exec(zh);
  if (estate) {
    const name = ESTATES[estate[1]];
    const rest = estate[2];
    const home = /^(\d+)号楼$/.exec(rest);
    if (home) return `${name} No. ${home[1]}`;
    const office = /^办公楼([A-D])座$/.exec(rest);
    if (office) return `${name} Office ${office[1]}`;
    if (SHOP_SUFFIXES[rest]) return `${name} ${SHOP_SUFFIXES[rest]}`;
  }

  const gate = GATE_PATTERN.exec(zh);
  if (gate && TERMS[gate[1]]) return `${TERMS[gate[1]]} (${GATE_SIDES[gate[2]]})`;
  return undefined;
}

const cache = new Map<string, string>();

/** 名称或类别在当前语言下的写法；英文中没有对应写法时原样返回。 */
export function term(zh: string): string {
  if (!isEnglish()) return zh;
  let en = cache.get(zh);
  if (en === undefined) {
    en = translate(zh) ?? zh;
    cache.set(zh, en);
  }
  return en;
}

/** 首字母大写，用于句首的类别名，如 “cafe” → “Cafe”。 */
export const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
