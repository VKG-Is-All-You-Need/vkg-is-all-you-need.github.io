/**
 * 城市示例中数据源、各层与本体类的介绍，显示在详情卡片中。
 * 卡片中带 data-info-* 与 data-query 的元素可以点击跳转。
 */
import { tr } from '../../i18n/runtime';
import { CITY_MAPPING, CITY_ONTOLOGY, type CityResult } from '../../lib/city/queries';
import { SOURCES, sourceById, type SourceId } from '../../lib/city/sources';
import type { InfoTarget, LayerKey } from './scene';

const escape = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface QueryRef {
  id: string;
  title: string;
  sources: SourceId[];
}

interface SourceInfo {
  identifies: string;
  classes: string[];
}

const SOURCE_INFO = (): Record<SourceId, SourceInfo> => ({
  gis: {
    identifies: tr(
      '建筑编号、道路编号与路口编号；保存几何形状与名称',
      'Building, road and intersection IDs, with geometries and names',
    ),
    classes: [':Building', ':Intersection', ':RoadSegment', ':Station', ':BusStop'],
  },
  traffic: {
    identifies: tr(
      '车牌号与路口编号；车辆位置每 5 秒一条',
      'License plates and intersection IDs; one vehicle position every 5 seconds',
    ),
    classes: [':Vehicle', ':Bus', ':Taxi', ':TrafficLight', ':RoadSegment'],
  },
  mobility: {
    identifies: tr(
      '乘客以居民编号登记，网约车以车牌登记',
      'Passengers by resident ID, ride-hailing cars by license plate',
    ),
    classes: [':TransitTap', ':RideOrder', ':TravelRecord', ':Person', ':BusStop'],
  },
  iot: {
    identifies: tr(
      '设备编号与坐标；客流计数器额外记录所在建筑的 building_id',
      'Device IDs and coordinates; footfall counters also record the building_id they sit in',
    ),
    classes: [':EnvSensor', ':FootfallCount', ':TemperatureObservation', ':Shop'],
  },
  weather: {
    identifies: tr(
      '气象站与观测时间，不涉及街区中的对象',
      'Weather station and observation time; no district objects',
    ),
    classes: [':WeatherObservation'],
  },
  commerce: {
    identifies: tr(
      '商店以 building_id 登记，会员消费以居民编号登记',
      'Shops by building_id, member purchases by resident ID',
    ),
    classes: [':Shop', ':Cafe', ':Purchase'],
  },
  hr: {
    identifies: tr(
      '员工以居民编号登记；停车许可记录车牌',
      'Employees by resident ID; parking permits record license plates',
    ),
    classes: [':Company', ':Employee', ':ParkingPermit', ':Vehicle'],
  },
  community: {
    identifies: tr(
      '居民编号与住址所在的 building_id',
      'Resident IDs and the building_id of each home',
    ),
    classes: [':Person', ':SocialEvent', ':Building'],
  },
});

interface ClassInfo {
  text: string;
  sources: SourceId[];
}

const CLASS_INFO = (): Record<string, ClassInfo> => ({
  ':Building': {
    text: tr(
      '街区中的建筑，带轮廓与楼层数。',
      'A building in the district, with footprint and floors.',
    ),
    sources: ['gis', 'community'],
  },
  ':Intersection': {
    text: tr('路口，由信号灯控制。', 'An intersection controlled by traffic lights.'),
    sources: ['gis', 'traffic'],
  },
  ':RoadSegment': {
    text: tr(
      '两个路口之间的路段，带实时车速。',
      'A road segment between two intersections, with live speeds.',
    ),
    sources: ['gis', 'traffic'],
  },
  ':Station': { text: tr('地铁站。', 'A metro station.'), sources: ['gis'] },
  ':BusStop': { text: tr('公交站。', 'A bus stop.'), sources: ['gis', 'mobility'] },
  ':TrafficLight': {
    text: tr(
      '信号灯，每个时刻处于红、黄或绿灯相位。',
      'A traffic light, red, yellow or green at each moment.',
    ),
    sources: ['traffic'],
  },
  ':Vehicle': {
    text: tr('车辆，带车牌与实时位置。', 'A vehicle with a license plate and live position.'),
    sources: ['traffic', 'hr'],
  },
  ':ServiceVehicle': {
    text: tr(
      '提供运营服务的车辆，公交与出租车的上位类。',
      'A vehicle in public service; superclass of buses and taxis.',
    ),
    sources: ['traffic'],
  },
  ':Bus': {
    text: tr('公交车，既是车辆也是运营车辆。', 'A bus: both a vehicle and a service vehicle.'),
    sources: ['traffic', 'mobility'],
  },
  ':Taxi': { text: tr('出租车与网约车。', 'A taxi or ride-hailing car.'), sources: ['traffic'] },
  ':EnvSensor': {
    text: tr(
      '街区中的温湿度传感器，是 sosa:Sensor 的子类。',
      'A temperature and humidity sensor in the district; a subclass of sosa:Sensor.',
    ),
    sources: ['iot', 'gis'],
  },
  'sosa:Sensor': { text: tr('W3C SOSA 中的传感器。', 'A sensor in W3C SOSA.'), sources: ['iot'] },
  'sosa:Observation': {
    text: tr(
      'W3C SOSA 中的观测：一次测量及其结果与时间。',
      'An observation in W3C SOSA: one measurement with its result and time.',
    ),
    sources: ['iot', 'weather'],
  },
  ':WeatherObservation': {
    text: tr(
      '气象站的一次观测：气温、湿度、降水、能见度与风速。',
      'One weather station observation: temperature, humidity, precipitation, visibility and wind.',
    ),
    sources: ['weather'],
  },
  ':TemperatureObservation': {
    text: tr(
      '街区传感器的一次温湿度读数。',
      'One temperature and humidity reading from a district sensor.',
    ),
    sources: ['iot'],
  },
  ':FootfallCount': {
    text: tr(
      '商店门口计数器的一次客流计数。',
      'One footfall count from a counter at a shop entrance.',
    ),
    sources: ['iot'],
  },
  ':Shop': {
    text: tr(
      '商店；客流计数器与商户系统通过 building_id 汇合到同一家店。',
      'A shop; footfall counters and the merchant system meet at the same shop through building_id.',
    ),
    sources: ['gis', 'iot', 'commerce'],
  },
  ':Cafe': {
    text: tr('咖啡馆，商店的子类。', 'A café; a subclass of shop.'),
    sources: ['gis', 'iot', 'commerce'],
  },
  ':Purchase': { text: tr('一笔会员消费。', 'One member purchase.'), sources: ['commerce'] },
  ':Person': {
    text: tr(
      '居民。社区应用与企业系统中的记录使用同一个 IRI 模板，汇合为同一个人。',
      'A resident. Records in the community app and the company system use the same IRI template and merge into one person.',
    ),
    sources: ['community', 'mobility', 'hr'],
  },
  ':Employee': {
    text: tr(
      '在某家企业工作的居民，是 :Person 的子类。',
      'A resident who works for a company; a subclass of :Person.',
    ),
    sources: ['hr', 'community'],
  },
  ':Company': { text: tr('企业。', 'A company.'), sources: ['hr'] },
  ':ParkingPermit': {
    text: tr(
      '员工停车许可，把车牌对应到员工。',
      'An employee parking permit linking a license plate to an employee.',
    ),
    sources: ['hr'],
  },
  ':SocialEvent': {
    text: tr('社区活动与报名记录。', 'A community event with its sign-ups.'),
    sources: ['community'],
  },
  ':TravelRecord': {
    text: tr(
      '一次出行记录，公交刷卡与网约车订单的上位类。',
      'A trip record; superclass of transit taps and ride orders.',
    ),
    sources: ['mobility'],
  },
  ':TransitTap': { text: tr('一次公交刷卡。', 'One transit card tap.'), sources: ['mobility'] },
  ':RideOrder': { text: tr('一笔网约车订单。', 'One ride-hailing order.'), sources: ['mobility'] },
});

const SUBCLASS: [string, string][] = [
  [':Bus', ':Vehicle'],
  [':Taxi', ':Vehicle'],
  [':Bus', ':ServiceVehicle'],
  [':Taxi', ':ServiceVehicle'],
  [':EnvSensor', 'sosa:Sensor'],
  [':WeatherObservation', 'sosa:Observation'],
  [':TemperatureObservation', 'sosa:Observation'],
  [':FootfallCount', 'sosa:Observation'],
  [':Cafe', ':Shop'],
  [':Employee', ':Person'],
  [':RideOrder', ':TravelRecord'],
  [':TransitTap', ':TravelRecord'],
];

/** 查询结果中出现过的类与对应的查询，打开类的介绍时用到。 */
export type ClassUsage = Map<string, string[]>;

/** 映射中以某个数据源为来源的条目。 */
function mappingsOf(id: SourceId): string[] {
  const catalog = sourceById.get(id)!.catalog;
  return CITY_MAPPING.split('\n\n').filter((block) => block.includes(` ${catalog}.`));
}

const head = (kind: string, title: string, swatch?: string) => `
  <div class="card-head">
    <div>
      <p class="card-kind">${swatch ? `<i class="card-swatch" style="--source:${swatch}"></i>` : ''}${escape(kind)}</p>
      <h3 class="card-title">${escape(title)}</h3>
    </div>
    <div class="card-actions">
      <button type="button" class="card-close" data-card-close aria-label="${escape(tr('关闭', 'Close'))}">×</button>
    </div>
  </div>`;

const label = (text: string) => `<p class="card-label">${escape(text)}</p>`;
const sourceChip = (id: SourceId, on: boolean) => {
  const source = sourceById.get(id)!;
  return `<button type="button" class="card-chip${on ? '' : ' is-off'}" data-info-source="${id}"><i style="--c:${source.color}"></i>${escape(source.name)}</button>`;
};
const classChip = (name: string) =>
  `<button type="button" class="card-chip" data-info-class="${escape(name)}"><code>${escape(name)}</code></button>`;
const queryChips = (list: QueryRef[]) =>
  list
    .map(
      (q) =>
        `<button type="button" class="card-chip" data-query="${q.id}">${escape(q.title)}</button>`,
    )
    .join('');
const layerChips = (except?: LayerKey) =>
  (
    [
      ['data', tr('数据源层', 'Source layer')],
      ['mapping', tr('映射层', 'Mapping layer')],
      ['graph', tr('知识图谱层', 'Graph layer')],
      ['ontology', tr('本体层', 'Ontology layer')],
    ] as [LayerKey, string][]
  )
    .filter(([id]) => id !== except)
    .map(
      ([id, text]) =>
        `<button type="button" class="card-chip" data-info-layer="${id}">${escape(text)}</button>`,
    )
    .join('');

function sourceCard(id: SourceId, on: ReadonlySet<SourceId>, queries: QueryRef[]): string {
  const source = sourceById.get(id)!;
  const info = SOURCE_INFO()[id];
  const connected = on.has(id);
  const used = queries.filter((q) => q.sources.includes(id));
  const mappings = mappingsOf(id);
  return `
    ${head(`${tr('数据源', 'Data source')} · ${source.system}`, source.name, source.color)}
    <p class="card-desc">${escape(source.description)}</p>
    <div class="card-facts">
      <p><span>${escape(tr('更新', 'Updates'))}</span>${escape(source.refresh)}</p>
      <p><span>catalog</span><code>${source.catalog}</code></p>
      <p><span>${escape(tr('标识方式', 'Identifiers'))}</span>${escape(info.identifies)}</p>
    </div>
    <button type="button" class="card-toggle${connected ? '' : ' is-off'}" data-toggle-source="${id}">${escape(
      connected
        ? tr('已接入 · 点击断开', 'Connected · click to disconnect')
        : tr('未接入 · 点击接入', 'Not connected · click to connect'),
    )}</button>
    ${label(tr('表', 'Tables'))}
    <div class="card-chips">${source.tables.map((t) => `<span class="card-chip is-static"><code>${source.catalog}.${t}</code></span>`).join('')}</div>
    ${label(tr('在本体中映射为', 'Mapped to'))}
    <div class="card-chips">${info.classes.map(classChip).join('')}</div>
    ${mappings.length ? `${label(tr('映射（节选）', 'Mappings (excerpt)'))}<pre class="card-code">${escape(mappings.join('\n\n'))}</pre>` : ''}
    ${label(tr(`用到它的查询（${used.length} 条）`, `Queries that use it (${used.length})`))}
    <div class="card-chips">${queryChips(used)}</div>
    ${label(tr('其他数据源', 'Other sources'))}
    <div class="card-chips">${SOURCES.filter((s) => s.id !== id)
      .map((s) => sourceChip(s.id, on.has(s.id)))
      .join('')}</div>`;
}

function classCard(
  name: string,
  on: ReadonlySet<SourceId>,
  queries: QueryRef[],
  usage: ClassUsage,
): string {
  const info = CLASS_INFO()[name];
  const parents = SUBCLASS.filter(([c]) => c === name).map(([, p]) => p);
  const children = SUBCLASS.filter(([, p]) => p === name).map(([c]) => c);
  const used = queries.filter((q) => usage.get(name)?.includes(q.id));
  const iri = name.startsWith('sosa:') ? `http://www.w3.org/ns/sosa/${name.slice(5)}` : name;
  return `
    ${head(tr('本体中的类', 'Ontology class'), name)}
    <p class="card-desc">${escape(info?.text ?? '')}</p>
    ${name.startsWith('sosa:') ? `<p class="card-iri"><code>${escape(iri)}</code></p>` : ''}
    ${parents.length ? `${label(tr('上位类', 'Superclasses'))}<div class="card-chips">${parents.map(classChip).join('')}</div>` : ''}
    ${children.length ? `${label(tr('子类（查询上位类时一并返回）', 'Subclasses (returned when the superclass is queried)'))}<div class="card-chips">${children.map(classChip).join('')}</div>` : ''}
    ${info ? `${label(tr('实例来自', 'Instances come from'))}<div class="card-chips">${info.sources.map((s) => sourceChip(s, on.has(s))).join('')}</div>` : ''}
    ${used.length ? `${label(tr('出现在这些查询中', 'Appears in these queries'))}<div class="card-chips">${queryChips(used)}</div>` : ''}
    ${label(tr('各层', 'Layers'))}
    <div class="card-chips">${layerChips()}</div>`;
}

function layerCard(
  id: LayerKey,
  on: ReadonlySet<SourceId>,
  result: CityResult | null,
  usage: ClassUsage,
): string {
  if (id === 'data') {
    return `
      ${head(tr('分层视图', 'Layered view'), tr('数据源层', 'Source layer'))}
      <p class="card-desc">${escape(
        tr(
          '底层是八个独立的系统，各自由不同的部门维护，结构与更新频率各不相同。VKG 不把它们复制到一起，查询时由联邦查询引擎直接访问每个数据源。',
          'The bottom layer holds eight independent systems, each maintained by a different team with its own structure and update rate. The VKG does not copy them together; at query time the federated query engine accesses each source directly.',
        ),
      )}</p>
      ${label(tr(`数据源（${on.size} / ${SOURCES.length} 已接入，点击查看）`, `Sources (${on.size} / ${SOURCES.length} connected, click to inspect)`))}
      <div class="card-chips">${SOURCES.map((s) => sourceChip(s.id, on.has(s.id))).join('')}</div>
      ${label(tr('其他层', 'Other layers'))}
      <div class="card-chips">${layerChips('data')}</div>`;
  }
  if (id === 'mapping') {
    const counts = SOURCES.map((s) => [s, mappingsOf(s.id).length] as const).filter(([, n]) => n);
    return `
      ${head(tr('分层视图', 'Layered view'), tr('映射层', 'Mapping layer'))}
      <p class="card-desc">${escape(
        tr(
          '映射说明本体中的每个类和属性对应哪个数据源的哪些表与列。每条映射由 IRI 模板（target）和一条 SQL（source）组成；不同数据源的记录只要生成同一个 IRI，就在图谱中合并为同一个实体。',
          'Mappings state which tables and columns in which source correspond to each class and property of the ontology. Each mapping has an IRI template (target) and an SQL query (source); records from different sources that produce the same IRI merge into one entity in the graph.',
        ),
      )}</p>
      ${label(tr('节选中各数据源的映射条数', 'Mappings per source in the excerpt'))}
      <div class="card-chips">${counts.map(([s, n]) => `<button type="button" class="card-chip" data-info-source="${s.id}"><i style="--c:${s.color}"></i>${escape(s.name)}<em>${n}</em></button>`).join('')}</div>
      ${label(tr('Ontop 映射（节选）', 'Ontop mappings (excerpt)'))}
      <pre class="card-code">${escape(CITY_MAPPING)}</pre>
      ${label(tr('其他层', 'Other layers'))}
      <div class="card-chips">${layerChips('mapping')}</div>`;
  }
  if (id === 'graph') {
    const entities = result?.entities ?? [];
    const merged = entities.filter((e) => e.sources.length >= 2);
    return `
      ${head(tr('分层视图', 'Layered view'), tr('虚拟知识图谱层', 'Virtual knowledge graph layer'))}
      <p class="card-desc">${escape(
        tr(
          '这一层的实体并不存储在任何地方，只在查询时由映射生成。每个实体连到描述它的数据源；连到多个数据源的实体，就是融合的结果。',
          'Entities in this layer are not stored anywhere; the mappings produce them at query time. Each entity links to the sources that describe it, and an entity linked to several sources is the result of fusion.',
        ),
      )}</p>
      <div class="card-stats">
        <p><b>${entities.length}</b><span>${escape(tr('当前查询中的实体', 'Entities in this query'))}</span></p>
        <p><b>${merged.length}</b><span>${escape(tr('由多个数据源描述', 'Described by several sources'))}</span></p>
      </div>
      ${
        merged.length
          ? `${label(tr('融合的实体（节选）', 'Fused entities (excerpt)'))}<ul class="card-list">${merged
              .slice(0, 6)
              .map(
                (e) =>
                  `<li><span>${escape(e.label)}</span><span class="card-dots">${e.sources.map((s) => `<i style="--c:${sourceById.get(s)!.color}" title="${escape(sourceById.get(s)!.name)}"></i>`).join('')}</span></li>`,
              )
              .join('')}</ul>`
          : ''
      }
      ${label(tr('其他层', 'Other layers'))}
      <div class="card-chips">${layerChips('graph')}</div>`;
  }
  const classes = [...new Set([...Object.keys(CLASS_INFO()), ...usage.keys()])];
  return `
    ${head(tr('分层视图', 'Layered view'), tr('本体层', 'Ontology layer'))}
    <p class="card-desc">${escape(
      tr(
        '本体（TBox）定义街区中有哪些类以及类之间的关系，例如公交车与出租车都是运营车辆，咖啡馆是商店。查询写在这些类上；查询上位类时，子类的实例会通过推理一并返回。场景中只显示当前查询用到的类。',
        'The ontology (TBox) defines which classes exist in the district and how they relate: buses and taxis are both service vehicles, a café is a shop. Queries are written over these classes; querying a superclass also returns instances of its subclasses through reasoning. The scene shows only the classes used by the current query.',
      ),
    )}</p>
    ${label(tr(`类（${classes.length} 个，点击查看）`, `Classes (${classes.length}, click to inspect)`))}
    <div class="card-chips">${classes.map(classChip).join('')}</div>
    ${label(tr('本体（Turtle，节选）', 'Ontology (Turtle, excerpt)'))}
    <pre class="card-code">${escape(CITY_ONTOLOGY)}</pre>
    ${label(tr('其他层', 'Other layers'))}
    <div class="card-chips">${layerChips('ontology')}</div>`;
}

export function infoCard(
  target: InfoTarget,
  on: ReadonlySet<SourceId>,
  queries: QueryRef[],
  result: CityResult | null,
  usage: ClassUsage,
): string {
  if (target.type === 'source') return sourceCard(target.id, on, queries);
  if (target.type === 'class') return classCard(target.name, on, queries, usage);
  return layerCard(target.id, on, result, usage);
}
