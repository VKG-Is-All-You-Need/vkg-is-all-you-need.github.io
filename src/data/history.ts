/**
 * 发展历程页的数据：OBDA / OBDI / OBDM / VKG / OBDF 一系的里程碑、五个时期与名称的演变。
 * 依据综述写作中整理的时间线（书目经 Crossref、出版方、CEUR 与 W3C 页面核对），
 * 传承关系中 cite 表示后者在原文中明确建立在前者之上，thread 表示同一问题线。
 */
import type { Lang } from '../i18n';

type Text = Record<Lang, string>;

export const LANE_IDS = ['paradigm', 'systems', 'theory', 'sources', 'evolution'] as const;
export type LaneId = (typeof LANE_IDS)[number];

export interface Lane {
  id: LaneId;
  label: Text;
}

export const LANES: Lane[] = [
  { id: 'paradigm', label: { zh: '范式与名称', en: 'Paradigms' } },
  { id: 'systems', label: { zh: '系统与产业', en: 'Systems and industry' } },
  { id: 'theory', label: { zh: '理论、标准与基准', en: 'Theory and standards' } },
  { id: 'sources', label: { zh: '多源与时空数据', en: 'Sources, time and space' } },
  { id: 'evolution', label: { zh: '演化、更新与大模型', en: 'Evolution, updates, LLMs' } },
];

export interface Era {
  id: string;
  from: number;
  to: number;
  title: Text;
  lead: Text;
}

export const ERAS: Era[] = [
  {
    id: 'origins',
    from: 2002,
    to: 2009,
    title: { zh: '前史与奠基', en: 'Origins' },
    lead: {
      zh: '数据集成理论给出了全局模式与映射的框架，DL-Lite 使本体上的查询可以改写为 SQL，两者在 2008 年汇合为 OBDA。D2RQ 与 Mastro-I 是最早的一批系统，OWL 2 QL 把 DL-Lite 写进了 W3C 标准。',
      en: 'Data integration theory supplied the framework of a global schema and mappings, and DL-Lite made queries over an ontology rewritable into SQL; the two came together as OBDA in 2008. D2RQ and Mastro-I were among the first systems, and OWL 2 QL brought DL-Lite into a W3C standard.',
    },
  },
  {
    id: 'systems',
    from: 2010,
    to: 2014,
    title: { zh: '系统化', en: 'Systems' },
    lead: {
      zh: '改写结果过大的问题推动了一系列优化，最终把推理挪进映射（T-mappings）。Ontop 与 Mastro 走向成熟，R2RML 成为标准；Lenzerini 提出 OBDM，把视野从查询扩展到数据管理。本体演化、动态 TBox 与流数据也在这一时期进入 OBDA。',
      en: 'Rewritings that grew too large led to a series of optimizations and finally to moving reasoning into the mappings (T-mappings). Ontop and Mastro matured and R2RML became a standard; Lenzerini proposed OBDM, widening the scope from queries to data management. Ontology evolution, dynamic TBoxes and streaming data entered OBDA in the same period.',
    },
  },
  {
    id: 'industry',
    from: 2015,
    to: 2019,
    title: { zh: '工业落地与多源', en: 'Industry and many sources' },
    lead: {
      zh: 'Optique 把 OBDA 带进 Statoil 与 Siemens，NPD 基准提供了贴近真实的评测。数据源从单个关系数据库扩展到关联数据集、MongoDB、空间数据库与数据湖；映射修复与 write-also OBDA 回应了系统演化与更新的需求。2019 年，“虚拟知识图谱”的名称开始流行，Ontopic 公司成立。',
      en: 'Optique brought OBDA to Statoil and Siemens, and the NPD benchmark offered a realistic evaluation. Sources grew from a single relational database to cross-linked datasets, MongoDB, spatial databases and data lakes; mapping repair and write-also OBDA addressed evolving systems and updates. In 2019 the name "virtual knowledge graph" took hold and Ontopic was founded.',
    },
  },
  {
    id: 'federation',
    from: 2020,
    to: 2023,
    title: { zh: '联邦与视图层', en: 'Federation and views' },
    lead: {
      zh: 'Ontop v4 以新的查询代数重新设计，完整支持 SPARQL 1.1。OBDF 把 OBDA 放到数据联邦引擎之上，Chimera 把它带到 Spark 与 Flink，LinkedGeoData 以 VKG 重建；映射中的视图在 Ontop 5 中被命名为 lens。',
      en: 'Ontop v4 was redesigned on a new query algebra with full SPARQL 1.1 support. OBDF placed OBDA on top of data federation engines, Chimera brought it to Spark and Flink, and LinkedGeoData was rebuilt as a VKG; views inside mappings were named lenses in Ontop 5.',
    },
  },
  {
    id: 'now',
    from: 2024,
    to: 2026,
    title: { zh: '写回、大模型与动态本体', en: 'Write-back, LLMs and dynamic ontologies' },
    lead: {
      zh: '经由 VKG 写回数据源从理论走向 Ontop 中的实现；大语言模型开始参与本体与映射的构建和扩展。工业界以“语义层”“动态本体”称呼同样的思路，Ontopic 并入 Digital Science。',
      en: 'Writing back to the sources through a VKG moved from theory to an implementation in Ontop, and large language models began to help build and extend ontologies and mappings. Industry speaks of "semantic layers" and "dynamic ontologies" for the same idea, and Ontopic joined Digital Science.',
    },
  },
];

export interface Milestone {
  id: string;
  year: number;
  lane: LaneId;
  label: Text;
  text: Text;
  /** 出处的简短写法，如 “Lenzerini, PODS 2002”。 */
  cite: string;
  url: string;
  /** 文献页中对应论文的 id。 */
  paper?: string;
  /** 主要节点：在全景图中以较大的节点显示，标签始终可见。 */
  major?: boolean;
}

const same = (text: string): Text => ({ zh: text, en: text });

export const MILESTONES: Milestone[] = [
  // ── 范式与名称
  {
    id: 'data-integration',
    year: 2002,
    lane: 'paradigm',
    label: { zh: '数据集成理论', en: 'Data integration' },
    text: {
      zh: '系统阐述由全局模式、数据源与映射构成的数据集成系统，以及 GAV、LAV 映射下的确定答案。OBDA 的〈本体, 映射, 数据源〉结构由此而来。',
      en: 'Sets out data integration systems made of a global schema, sources and mappings, with certain answers under GAV and LAV mappings. The ⟨ontology, mapping, source⟩ structure of OBDA comes from here.',
    },
    cite: 'M. Lenzerini, PODS 2002',
    url: 'https://doi.org/10.1145/543613.543644',
    paper: 'data-integration',
    major: true,
  },
  {
    id: 'obda',
    year: 2008,
    lane: 'paradigm',
    label: same('OBDA'),
    text: {
      zh: '给出 OBDA 的标准表述：本体、带 IRI 构造的映射与数据源；查询先按本体改写，再经映射展开为 SQL。此后的工作几乎都引用这篇论文。',
      en: 'The standard formulation of OBDA: an ontology, mappings that construct IRIs, and a data source; queries are first rewritten with the ontology and then unfolded into SQL through the mappings. Nearly all later work cites it.',
    },
    cite: 'A. Poggi et al., J. on Data Semantics 2008',
    url: 'https://doi.org/10.1007/978-3-540-77688-8_5',
    paper: 'linking-data',
    major: true,
  },
  {
    id: 'obdm',
    year: 2011,
    lane: 'paradigm',
    label: same('OBDM'),
    text: {
      zh: '提出基于本体的数据管理，把 OBDA 从查询扩展到数据管理的各个方面：数据质量、治理、开放数据与更新。',
      en: 'Proposes ontology-based data management, extending OBDA from queries to every aspect of data management: quality, governance, open data and updates.',
    },
    cite: 'M. Lenzerini, CIKM 2011',
    url: 'https://doi.org/10.1145/2063576.2063582',
    paper: 'obdm',
    major: true,
  },
  {
    id: 'omqa',
    year: 2014,
    lane: 'paradigm',
    label: same('OMQA'),
    text: {
      zh: '理论界把（本体, 查询）对作为研究对象，称为本体中介查询，研究更具表达力的本体下查询回答的复杂度。',
      en: 'Theory takes the (ontology, query) pair as its object of study, the ontology-mediated query, and analyzes the complexity of query answering under more expressive ontologies.',
    },
    cite: 'M. Bienvenu, B. ten Cate, C. Lutz, F. Wolter, ACM TODS 2014',
    url: 'https://doi.org/10.1145/2661643',
  },
  {
    id: 'obdi',
    year: 2018,
    lane: 'paradigm',
    label: same('OBDI'),
    text: {
      zh: '系统阐述基于本体的多源数据集成，区别于面向单一数据源的 OBDA。这一叫法在 2008 年前后已经出现。',
      en: 'A systematic account of ontology-based integration of several sources, as distinct from single-source OBDA. The term was already in use around 2008.',
    },
    cite: 'G. De Giacomo et al., Studies in Big Data 2018',
    url: 'https://doi.org/10.1007/978-3-319-61893-7_11',
  },
  {
    id: 'vkg',
    year: 2019,
    lane: 'paradigm',
    label: same('VKG'),
    text: {
      zh: '以“虚拟知识图谱”称呼这一方法，指出它就是 OBDA，并梳理代表性系统与应用。随着知识图谱的普及，VKG 成为系统与应用侧的常用名称。',
      en: 'Calls the approach a virtual knowledge graph, states that it is OBDA, and reviews representative systems and applications. As knowledge graphs spread, VKG became the common name on the systems and applications side.',
    },
    cite: 'G. Xiao, L. Ding, B. Cogrel, D. Calvanese, Data Intelligence 2019',
    url: 'https://doi.org/10.1162/dint_a_00011',
    paper: 'vkg-overview',
    major: true,
  },
  {
    id: 'obdf',
    year: 2022,
    lane: 'paradigm',
    label: same('OBDF'),
    text: {
      zh: '在数据联邦引擎之上做 OBDA：多个异构数据源先经 Teiid、Denodo、Dremio 等引擎汇成一个虚拟数据库，再由 Ontop 提供本体视图。',
      en: 'OBDA on top of a data federation engine: heterogeneous sources are first combined into one virtual database by engines such as Teiid, Denodo or Dremio, and Ontop then provides the ontology view.',
    },
    cite: 'Z. Gu et al., IJCKG 2022',
    url: 'https://doi.org/10.1145/3579051.3579070',
    paper: 'obdf',
    major: true,
  },
  {
    id: 'dynamic-ontology',
    year: 2025,
    lane: 'paradigm',
    label: { zh: '动态本体', en: 'Dynamic ontology' },
    text: {
      zh: '工业平台与大模型智能体研究使用“动态本体”的说法：本体直接连接业务数据、随时间演化，并支持对数据的操作。这一用法可追溯到 Palantir 2006 年申请的专利，所指的场景正是 OBDA 长期研究的问题。',
      en: 'Industrial platforms and research on LLM agents speak of dynamic ontologies: ontologies that connect directly to operational data, evolve over time and support actions on the data. The usage goes back to a Palantir patent filed in 2006, and the setting is the one OBDA has long studied.',
    },
    cite: 'Palantir Foundry Ontology; US Patent 7,962,495',
    url: 'https://www.palantir.com/docs/foundry/ontology/overview/',
  },
  // ── 系统与产业
  {
    id: 'd2rq',
    year: 2004,
    lane: 'systems',
    label: same('D2RQ'),
    text: {
      zh: '把关系数据库当作虚拟 RDF 图访问的早期系统，开启了 RDB2RDF 系统一脉，不涉及本体推理。',
      en: 'An early system that accesses relational databases as virtual RDF graphs, starting the line of RDB2RDF systems; it does not reason with ontologies.',
    },
    cite: 'C. Bizer, A. Seaborne, ISWC 2004 poster',
    url: 'https://files.ifi.uzh.ch/ddis/iswc_archive/iswc/pps/web/iswc2004.semanticweb.org/posters/PID-SMCVRKBT-1089637165.pdf',
  },
  {
    id: 'mastro-i',
    year: 2007,
    lane: 'systems',
    label: same('Mastro-I'),
    text: {
      zh: '最早基于 DL-Lite 本体与 GAV 映射的 OBDA 系统之一，建立在 QuOnto 推理机之上。',
      en: 'One of the first OBDA systems built on a DL-Lite ontology and GAV mappings, on top of the QuOnto reasoner.',
    },
    cite: 'D. Calvanese et al., DL 2007',
    url: 'https://ceur-ws.org/Vol-250/paper_76.pdf',
  },
  {
    id: 'quest',
    year: 2010,
    lane: 'systems',
    label: same('Quest'),
    text: {
      zh: 'Ontop 的第一个版本，当时名为 Quest，最早实现了语义查询优化与 T-mappings。',
      en: 'The first version of Ontop, then called Quest, which first implemented semantic query optimization and T-mappings.',
    },
    cite: 'D. Calvanese et al., Semantic Web 2017 (§7)',
    url: 'https://doi.org/10.3233/SW-160217',
    paper: 'ontop-swj',
  },
  {
    id: 'mastro',
    year: 2011,
    lane: 'systems',
    label: same('Mastro'),
    text: {
      zh: '成熟的 OBDA 引擎，此后 Sapienza 团队的案例都基于它，后由 OBDA Systems 公司商业化。',
      en: 'A mature OBDA engine used in the later case studies of the Sapienza group, and later commercialized by OBDA Systems.',
    },
    cite: 'D. Calvanese et al., Semantic Web 2011',
    url: 'https://doi.org/10.3233/SW-2011-0029',
    paper: 'mastro',
  },
  {
    id: 'ontop',
    year: 2013,
    lane: 'systems',
    label: same('Ontop'),
    text: {
      zh: 'Ontop 的第一篇系统论文：tree-witness 改写、T-mappings 与 SQL 上的语义查询优化。Ontop 自 2013 年起以 Apache 2 许可开源。',
      en: 'The first system paper on Ontop: tree-witness rewriting, T-mappings and semantic query optimization over SQL. Ontop has been open source under the Apache 2 license since 2013.',
    },
    cite: 'M. Rodríguez-Muro, R. Kontchakov, M. Zakharyaschev, ISWC 2013',
    url: 'https://doi.org/10.1007/978-3-642-41335-3_35',
    paper: 'ontop-of-databases',
    major: true,
  },
  {
    id: 'ultrawrap',
    year: 2013,
    lane: 'systems',
    label: same('Ultrawrap'),
    text: {
      zh: '以 SQL 视图实现虚拟 RDF，依靠关系数据库的优化器执行查询，后由 Capsenta 公司商业化。',
      en: 'Implements virtual RDF with SQL views and relies on the relational optimizer, later commercialized by Capsenta.',
    },
    cite: 'J. F. Sequeda, D. P. Miranker, J. Web Semantics 2013',
    url: 'https://doi.org/10.1016/j.websem.2013.08.002',
    paper: 'ultrawrap',
  },
  {
    id: 'optique',
    year: 2013,
    lane: 'systems',
    label: same('Optique'),
    text: {
      zh: '欧盟 FP7 项目（2013–2016），把 OBDA 带到 Statoil 与 Siemens 的实际场景，也推动了 Ontop 对 W3C 标准的完整支持。',
      en: 'An EU FP7 project (2013–2016) that brought OBDA to real settings at Statoil and Siemens and pushed Ontop toward full W3C compliance.',
    },
    cite: 'E. Kharlamov et al., ESWC 2013 Satellite Events',
    url: 'https://doi.org/10.1007/978-3-642-41242-4_11',
  },
  {
    id: 'stardog',
    year: 2015,
    lane: 'systems',
    label: { zh: 'Stardog 虚拟图', en: 'Stardog virtual graphs' },
    text: {
      zh: '商业图数据库 Stardog 自 2015 年起支持关系数据库上的虚拟图。',
      en: 'The commercial graph database Stardog has supported virtual graphs over relational databases since 2015.',
    },
    cite: 'G. Xiao et al., Data Intelligence 2019 (§3.1)',
    url: 'https://doi.org/10.1162/dint_a_00011',
    paper: 'vkg-overview',
  },
  {
    id: 'statoil',
    year: 2017,
    lane: 'systems',
    label: { zh: 'Statoil 部署', en: 'Statoil' },
    text: {
      zh: 'Optique 在 Statoil 的部署，覆盖多个勘探数据库，工程师通过可视化界面构建查询。',
      en: 'The Optique deployment at Statoil over several exploration databases, where engineers build queries in a visual interface.',
    },
    cite: 'E. Kharlamov et al., J. Web Semantics 2017',
    url: 'https://doi.org/10.1016/j.websem.2017.05.005',
    paper: 'statoil',
  },
  {
    id: 'ontopic',
    year: 2019,
    lane: 'systems',
    label: { zh: 'Ontopic 成立', en: 'Ontopic' },
    text: {
      zh: 'Ontop 团队成立 Ontopic 公司，作为博尔扎诺自由大学的首个衍生企业提供 VKG 产品与服务。同年，data.world 收购 Ultrawrap 背后的 Capsenta，用于“知识图谱虚拟化”。',
      en: 'The Ontop team founded Ontopic, the first spin-off of the Free University of Bozen-Bolzano, to offer VKG products and services. In the same year data.world acquired Capsenta, the company behind Ultrawrap, for "knowledge graph virtualization".',
    },
    cite: 'G. Xiao et al., ISWC 2020 (§5)',
    url: 'https://doi.org/10.1007/978-3-030-62466-8_17',
    paper: 'ontop-iswc',
  },
  {
    id: 'ontop-v4',
    year: 2020,
    lane: 'systems',
    label: same('Ontop v4'),
    text: {
      zh: '以中间查询代数（IQ）重新设计，完整支持 SPARQL 1.1 与 R2RML。',
      en: 'Redesigned on an intermediate query algebra (IQ), with full support for SPARQL 1.1 and R2RML.',
    },
    cite: 'G. Xiao et al., ISWC 2020',
    url: 'https://doi.org/10.1007/978-3-030-62466-8_17',
    paper: 'ontop-iswc',
    major: true,
  },
  {
    id: 'digital-science',
    year: 2026,
    lane: 'systems',
    label: { zh: 'Ontopic 并入 Digital Science', en: 'Ontopic joins Digital Science' },
    text: {
      zh: 'Digital Science 收购 Ontopic，把 Ontopic Studio 整合进 metaphactory，作为不复制数据的统一语义层。',
      en: 'Digital Science acquired Ontopic and integrated Ontopic Studio into metaphactory as a unified semantic layer that does not copy the data.',
    },
    cite: 'Digital Science press release, 2026',
    url: 'https://www.digital-science.com/press-releases/digital-science-acquires-ontopic/',
  },
  // ── 理论、标准与基准
  {
    id: 'dl-lite',
    year: 2005,
    lane: 'theory',
    label: same('DL-Lite'),
    text: {
      zh: '轻量级描述逻辑，合取查询的回答可以一阶改写，数据复杂度为 AC0；期刊版给出了第一个改写算法 PerfectRef。',
      en: 'A lightweight description logic in which conjunctive query answering is first-order rewritable, with AC0 data complexity; the journal version gives the first rewriting algorithm, PerfectRef.',
    },
    cite: 'D. Calvanese et al., AAAI 2005; J. Automated Reasoning 2007',
    url: 'https://doi.org/10.1007/s10817-007-9078-x',
    paper: 'dl-lite',
    major: true,
  },
  {
    id: 'owl2ql',
    year: 2009,
    lane: 'theory',
    label: same('OWL 2 QL'),
    text: {
      zh: '基于 DL-Lite 的 W3C 本体语言子集，专为 OBDA 设计；2012 年发布第二版。',
      en: 'A W3C profile of OWL based on DL-Lite and designed for OBDA; the second edition appeared in 2012.',
    },
    cite: 'W3C Recommendation, 2009',
    url: 'https://www.w3.org/TR/2009/REC-owl2-profiles-20091027/',
  },
  {
    id: 't-mappings',
    year: 2012,
    lane: 'theory',
    label: same('T-mappings'),
    text: {
      zh: '把本体离线编译进映射（饱和映射），使在线改写保持紧凑。Ultrawrap 几乎同时采用了离线饱和映射的做法。',
      en: 'Compiles the ontology into the mappings offline (saturated mappings) so that online rewriting stays compact. Ultrawrap adopted offline saturation at almost the same time.',
    },
    cite: 'M. Rodríguez-Muro, D. Calvanese, KR 2012',
    url: 'https://cdn.aaai.org/ocs/4547/4547-21819-1-PB.pdf',
    paper: 't-mappings',
  },
  {
    id: 'r2rml',
    year: 2012,
    lane: 'theory',
    label: same('R2RML'),
    text: {
      zh: 'W3C 的关系数据库到 RDF 映射语言，与 Direct Mapping 同日成为推荐标准；Ontop、Morph、Ultrawrap 与 Stardog 都采用它。',
      en: 'The W3C mapping language from relational databases to RDF, published as a Recommendation on the same day as Direct Mapping and used by Ontop, Morph, Ultrawrap and Stardog.',
    },
    cite: 'W3C Recommendation, 2012',
    url: 'https://www.w3.org/TR/r2rml/',
    major: true,
  },
  {
    id: 'sparql-owl2ql',
    year: 2014,
    lane: 'theory',
    label: { zh: 'OWL 2 QL 下的 SPARQL', en: 'SPARQL under OWL 2 QL' },
    text: {
      zh: '给出 OWL 2 QL 蕴涵语义下 SPARQL 到 SQL 的翻译，Ontop 的查询改写以此为基础。',
      en: 'Gives the translation of SPARQL into SQL under the OWL 2 QL entailment regime, the basis of query rewriting in Ontop.',
    },
    cite: 'R. Kontchakov et al., ISWC 2014',
    url: 'https://doi.org/10.1007/978-3-319-11964-9_35',
    paper: 'sparql-owl2ql',
  },
  {
    id: 'rewriting-price',
    year: 2014,
    lane: 'theory',
    label: { zh: '改写的代价', en: 'Price of rewriting' },
    text: {
      zh: '证明改写结果的规模可能呈指数增长，从理论上解释了实用系统为何把优化挪进映射。',
      en: 'Proves that rewritings can grow exponentially, explaining in theory why practical systems moved optimization into the mappings.',
    },
    cite: 'G. Gottlob et al., Artificial Intelligence 2014',
    url: 'https://doi.org/10.1016/j.artint.2014.04.004',
  },
  {
    id: 'rml',
    year: 2014,
    lane: 'theory',
    label: same('RML'),
    text: {
      zh: '把 R2RML 的映射方法扩展到 CSV、JSON、XML 等异构数据，多数 RML 引擎采用物化路线。',
      en: 'Extends the R2RML approach to heterogeneous data such as CSV, JSON and XML; most RML engines materialize the graph.',
    },
    cite: 'A. Dimou et al., LDOW 2014',
    url: 'https://ceur-ws.org/Vol-1184/ldow2014_paper_01.pdf',
  },
  {
    id: 'npd',
    year: 2015,
    lane: 'theory',
    label: { zh: 'NPD 基准', en: 'NPD benchmark' },
    text: {
      zh: '第一个专为 OBDA 设计的基准，基于挪威石油管理局的真实数据、本体与映射。',
      en: 'The first benchmark designed for OBDA, built on real data, an ontology and mappings from the Norwegian Petroleum Directorate.',
    },
    cite: 'D. Lanti et al., EDBT 2015',
    url: 'https://openproceedings.org/2015/conf/edbt/paper-350.pdf',
    paper: 'npd',
  },
  {
    id: 'ontop-lenses',
    year: 2022,
    lane: 'theory',
    label: same('Ontop lenses'),
    text: {
      zh: 'Ontop 5.0 把映射中的视图正式命名为 lens：在 Ontop 层定义、数据库并不知道的关系视图，可以补充声明约束。',
      en: 'Ontop 5.0 named the views inside mappings lenses: relational views defined in Ontop and unknown to the database, on which extra constraints can be declared.',
    },
    cite: 'Ontop documentation, 5.0 (2022)',
    url: 'https://ontop-vkg.org/guide/advanced/lenses.html',
  },
  {
    id: 'rml-lv',
    year: 2026,
    lane: 'theory',
    label: { zh: 'RML 逻辑视图', en: 'RML logical views' },
    text: {
      zh: 'W3C 知识图谱构建社区组起草 RML Logical Views，为 RML 加入可复用、可带结构注解的视图层。',
      en: 'The W3C Knowledge Graph Construction Community Group drafts RML Logical Views, adding a reusable view layer with structural annotations to RML.',
    },
    cite: 'W3C KG-Construct CG draft report, 2026',
    url: 'https://w3id.org/rml/lv/spec',
  },
  // ── 多源与时空数据
  {
    id: 'sparqlstream',
    year: 2010,
    lane: 'sources',
    label: same('SPARQLStream'),
    text: {
      zh: '提出 SPARQLStream 与流到本体的映射，在流数据源上构造虚拟 RDF 流。',
      en: 'Introduces SPARQLStream and stream-to-ontology mappings that build virtual RDF streams over streaming sources.',
    },
    cite: 'J.-P. Calbimonte, O. Corcho, A. J. G. Gray, ISWC 2010',
    url: 'https://doi.org/10.1007/978-3-642-17746-0_7',
    paper: 'sparqlstream',
  },
  {
    id: 'starql',
    year: 2014,
    lane: 'sources',
    label: same('STARQL'),
    text: {
      zh: '面向 OBDA 的流与时态查询语言，用于 Optique 的流数据处理。',
      en: 'A stream-temporal query language for OBDA, used for stream processing in Optique.',
    },
    cite: 'Ö. L. Özçep, R. Möller, C. Neuenstadt, KI 2014',
    url: 'https://doi.org/10.1007/978-3-319-11206-0_18',
    paper: 'starql',
  },
  {
    id: 'cross-linked',
    year: 2015,
    lane: 'sources',
    label: { zh: '跨数据集链接', en: 'Cross-linked datasets' },
    text: {
      zh: '多源 OBDI：数据源之间以关联表相连，关联表经映射暴露为 owl:sameAs，查询仍可改写为 SQL。',
      en: 'Multi-source OBDI: sources are connected by linking tables, which mappings expose as owl:sameAs while queries stay rewritable into SQL.',
    },
    cite: 'D. Calvanese et al., ISWC 2015',
    url: 'https://doi.org/10.1007/978-3-319-25007-6_12',
    paper: 'cross-linked',
  },
  {
    id: 'mongodb',
    year: 2016,
    lane: 'sources',
    label: { zh: 'MongoDB 上的 OBDA', en: 'OBDA over MongoDB' },
    text: {
      zh: '首次把 OBDA 框架推广到关系数据库以外的数据源，研究 SPARQL 到 MongoDB 查询的转换。',
      en: 'The first generalization of the OBDA framework beyond relational databases, translating SPARQL into MongoDB queries.',
    },
    cite: 'E. Botoeva et al., DL 2016',
    url: 'https://ceur-ws.org/Vol-1577/paper_40.pdf',
    paper: 'obda-mongodb',
  },
  {
    id: 'ontop-spatial',
    year: 2016,
    lane: 'sources',
    label: same('Ontop-spatial'),
    text: {
      zh: '为 Ontop 加入 GeoSPARQL 支持，在空间数据库上回答空间查询，是最早的空间 VKG。',
      en: 'Adds GeoSPARQL support to Ontop to answer spatial queries over spatial databases, the first spatial VKG.',
    },
    cite: 'K. Bereta, M. Koubarakis, ISWC 2016',
    url: 'https://doi.org/10.1007/978-3-319-46523-4_3',
    paper: 'ontop-spatial',
  },
  {
    id: 'siemens',
    year: 2017,
    lane: 'sources',
    label: { zh: 'Siemens 流数据', en: 'Siemens streams' },
    text: {
      zh: 'Optique 在 Siemens 统一访问涡轮机的流数据与静态数据。',
      en: 'Optique gives Siemens unified access to streaming and static turbine data.',
    },
    cite: 'E. Kharlamov et al., J. Web Semantics 2017',
    url: 'https://doi.org/10.1016/j.websem.2017.02.001',
    paper: 'siemens',
  },
  {
    id: 'ontop-temporal',
    year: 2018,
    lane: 'sources',
    label: same('Ontop-temporal'),
    text: {
      zh: 'Ontop 的时态扩展，在带时间戳的日志数据上回答时态查询。',
      en: 'A temporal extension of Ontop that answers temporal queries over timestamped log data.',
    },
    cite: 'E. Güzel Kalayci et al., CIKM 2018',
    url: 'https://doi.org/10.1145/3269206.3269230',
    paper: 'ontop-temporal',
  },
  {
    id: 'squerall',
    year: 2019,
    lane: 'sources',
    label: same('Squerall'),
    text: {
      zh: '语义数据湖上的虚拟 OBDA，覆盖 Cassandra、MongoDB、Parquet、CSV 与 MySQL。',
      en: 'Virtual OBDA over a semantic data lake spanning Cassandra, MongoDB, Parquet, CSV and MySQL.',
    },
    cite: 'M. N. Mami et al., ISWC 2019',
    url: 'https://doi.org/10.1007/978-3-030-30796-7_15',
    paper: 'squerall',
  },
  {
    id: 'chimera',
    year: 2021,
    lane: 'sources',
    label: same('Chimera'),
    text: {
      zh: '把 Ontop 与 Spark、Flink 结合，在数据湖上做语义分析与流处理。',
      en: 'Combines Ontop with Spark and Flink for semantic analytics and stream processing on data lakes.',
    },
    cite: 'M. Belcao et al., ISWC 2021',
    url: 'https://doi.org/10.1007/978-3-030-88361-4_27',
    paper: 'chimera',
  },
  {
    id: 'linkedgeodata',
    year: 2021,
    lane: 'sources',
    label: same('LinkedGeoData-VKG'),
    text: {
      zh: '为 Ontop v4 加入 GeoSPARQL，以 VKG 重建 LinkedGeoData。',
      en: 'Adds GeoSPARQL to Ontop v4 and rebuilds LinkedGeoData as a VKG.',
    },
    cite: 'L. Ding et al., J. Web Semantics 2021',
    url: 'https://doi.org/10.1016/j.websem.2021.100662',
    paper: 'linkedgeodata',
  },
  {
    id: 'eo-vkg',
    year: 2025,
    lane: 'sources',
    label: { zh: '对地观测 VKG', en: 'Earth observation VKG' },
    text: {
      zh: '把 openEO 地球观测数据立方体与关系数据组合进同一个 VKG。',
      en: 'Combines openEO Earth observation datacubes and relational data in one VKG.',
    },
    cite: 'A. Pano, D. Lanti, D. Calvanese, ISWC 2025',
    url: 'https://doi.org/10.1007/978-3-032-09530-5_9',
    paper: 'vkg-eo',
  },
  // ── 演化、更新与大模型
  {
    id: 'instance-update',
    year: 2006,
    lane: 'evolution',
    label: { zh: '实例级更新', en: 'Instance-level update' },
    text: {
      zh: '给出 DL 本体实例层插入与删除的语义和算法（期刊版 2009），开启经由本体更新数据的理论线。',
      en: 'Gives semantics and algorithms for insertion into and deletion from the instance level of DL ontologies (journal version 2009), starting the theory of updating data through the ontology.',
    },
    cite: 'G. De Giacomo et al., AAAI 2006; J. Logic and Computation 2009',
    url: 'https://cdn.aaai.org/AAAI/2006/AAAI06-199.pdf',
  },
  {
    id: 'dl-lite-evolution',
    year: 2010,
    lane: 'evolution',
    label: { zh: 'DL-Lite 演化', en: 'DL-Lite evolution' },
    text: {
      zh: '研究 DL-Lite 知识库演化的语义，给出可在多项式时间内计算的 bold 与 careful 两种语义。',
      en: 'Studies the semantics of evolution for DL-Lite knowledge bases, with two semantics, bold and careful, computable in polynomial time.',
    },
    cite: 'D. Calvanese et al., ISWC 2010',
    url: 'https://doi.org/10.1007/978-3-642-17746-0_8',
    paper: 'dl-lite-evolution',
  },
  {
    id: 'dynamic-tbox',
    year: 2012,
    lane: 'evolution',
    label: { zh: '动态 TBox', en: 'Dynamic TBoxes' },
    text: {
      zh: '映射同时从数据中产生概念与关系，本体层随数据而变，查询回答仍可改写为 SQL。',
      en: 'Mappings also produce concepts and relations from the data, so the ontology level changes with the data while query answering stays rewritable into SQL.',
    },
    cite: 'F. Di Pinto et al., AAAI 2012',
    url: 'https://doi.org/10.1609/aaai.v26i1.8223',
    paper: 'dynamic-tboxes',
  },
  {
    id: 'mapping-repair',
    year: 2017,
    lane: 'evolution',
    label: { zh: '映射修复', en: 'Mapping repair' },
    text: {
      zh: '在映射分析（2014、2015）的基础上，研究本体或源模式变化后如何修复映射。',
      en: 'Building on mapping analysis (2014, 2015), studies how to repair mappings after the ontology or the source schema changes.',
    },
    cite: 'D. Lembo et al., IJCAI 2017',
    url: 'https://doi.org/10.24963/ijcai.2017/161',
    paper: 'mapping-repair',
  },
  {
    id: 'write-also',
    year: 2017,
    lane: 'evolution',
    label: same('Write-also OBDA'),
    text: {
      zh: '本体上的更新与源端的更新都通过一阶可改写的规则处理，插入与删除记录在辅助表中。',
      en: 'Handles updates posed on the ontology and updates at the sources with first-order rewritable rules, recording insertions and deletions in auxiliary tables.',
    },
    cite: 'G. De Giacomo et al., ISWC 2017',
    url: 'https://doi.org/10.1007/978-3-319-68288-4_14',
    paper: 'write-also-obda',
  },
  {
    id: 'vkg-update',
    year: 2024,
    lane: 'evolution',
    label: { zh: 'VKG 更新', en: 'VKG updates' },
    text: {
      zh: '借助最大恢复与数据血缘，把 VKG 上的更新直接翻译为数据源上的更新。',
      en: 'Translates updates on a VKG directly into updates of the sources using maximum recovery and data lineage.',
    },
    cite: 'R. E. Wandji, D. Calvanese, RuleML+RR 2024',
    url: 'https://doi.org/10.1007/978-3-031-72407-7_6',
    paper: 'mapping-recovery-update',
  },
  {
    id: 'bidirectional',
    year: 2025,
    lane: 'evolution',
    label: { zh: '双向 VKG', en: 'Bidirectional VKG' },
    text: {
      zh: '在 Ontop 中实现 SPARQL Update 到 SQL 的翻译，VKG 从只读变为可读写。',
      en: 'Implements the translation of SPARQL Update into SQL in Ontop, turning a read-only VKG into one that can also be written.',
    },
    cite: 'R. E. Wandji, D. Calvanese, IJCKG 2025',
    url: 'https://doi.org/10.1007/978-981-95-5009-8_15',
    paper: 'bidirectional-vkg',
    major: true,
  },
  {
    id: 'llm4vkg',
    year: 2025,
    lane: 'evolution',
    label: same('LLM4VKG'),
    text: {
      zh: '大语言模型结合映射模式，补全本体并生成映射。',
      en: 'Large language models combined with mapping patterns complete the ontology and generate the mappings.',
    },
    cite: 'G. Xiao et al., IJCAI 2025',
    url: 'https://www.ijcai.org/proceedings/2025/0525.pdf',
    paper: 'llm4vkg',
    major: true,
  },
  {
    id: 'in-vkge',
    year: 2026,
    lane: 'evolution',
    label: same('IN-VKGE'),
    text: {
      zh: '部署后由新的信息需求驱动本体与映射的增补，以 SPARQL 执行反馈检验需求是否得到支持。',
      en: 'Enriches the ontology and mappings of a deployed VKG for new information needs, using SPARQL execution feedback to check that a need is supported.',
    },
    cite: 'L. Ren et al., IJCAI 2026',
    url: 'https://doi.org/10.24963/ijcai.2026/448',
    paper: 'in-vkge',
  },
];

/** 传承关系：[前者, 后者, 类型]。 */
export const LINKS: [string, string, 'cite' | 'thread'][] = [
  ['data-integration', 'mastro-i', 'cite'],
  ['data-integration', 'obda', 'cite'],
  ['dl-lite', 'obda', 'cite'],
  ['dl-lite', 'owl2ql', 'cite'],
  ['mastro-i', 'mastro', 'cite'],
  ['obda', 'mastro', 'cite'],
  ['obda', 'obdm', 'thread'],
  ['obdm', 'obdi', 'thread'],
  ['obda', 'vkg', 'thread'],
  ['vkg', 'dynamic-ontology', 'thread'],
  ['quest', 'ontop', 'cite'],
  ['t-mappings', 'ontop', 'cite'],
  ['mastro', 'ontop', 'cite'],
  ['sparql-owl2ql', 'ontop-v4', 'cite'],
  ['ontop', 'ontop-v4', 'cite'],
  ['ontop-v4', 'obdf', 'cite'],
  ['ontop-v4', 'ontop-lenses', 'thread'],
  ['ontop-lenses', 'rml-lv', 'thread'],
  ['r2rml', 'rml', 'cite'],
  ['optique', 'statoil', 'cite'],
  ['optique', 'siemens', 'cite'],
  ['optique', 'npd', 'thread'],
  ['ontopic', 'digital-science', 'cite'],
  ['sparqlstream', 'starql', 'thread'],
  ['starql', 'siemens', 'cite'],
  ['mongodb', 'obdf', 'cite'],
  ['squerall', 'chimera', 'thread'],
  ['chimera', 'obdf', 'thread'],
  ['ontop-spatial', 'linkedgeodata', 'cite'],
  ['linkedgeodata', 'eo-vkg', 'cite'],
  ['cross-linked', 'obdi', 'thread'],
  ['instance-update', 'write-also', 'cite'],
  ['write-also', 'vkg-update', 'thread'],
  ['vkg-update', 'bidirectional', 'cite'],
  ['dl-lite-evolution', 'mapping-repair', 'thread'],
  ['llm4vkg', 'in-vkge', 'cite'],
];

/** 同一个想法的不同名称。 */
export const NAMES: { term: Text; year: string; focus: Text; milestone: string }[] = [
  {
    term: { zh: '数据集成', en: 'Data integration' },
    year: '2002',
    focus: { zh: '多个数据源，一个全局模式', en: 'Many sources, one global schema' },
    milestone: 'data-integration',
  },
  {
    term: { zh: '虚拟 RDF 图', en: 'Virtual RDF graph' },
    year: '2004',
    focus: {
      zh: '把关系数据库发布为 RDF，不带推理',
      en: 'Relational data published as RDF, without reasoning',
    },
    milestone: 'd2rq',
  },
  {
    term: same('OBDA'),
    year: '2008',
    focus: { zh: '本体、映射与关系数据库', en: 'Ontology, mappings and a relational database' },
    milestone: 'obda',
  },
  {
    term: same('OBDI'),
    year: '2008',
    focus: { zh: '以本体集成多个数据源', en: 'Integrating several sources through an ontology' },
    milestone: 'obdi',
  },
  {
    term: same('OBDM'),
    year: '2011',
    focus: { zh: '从查询扩展到数据管理', en: 'From queries to data management' },
    milestone: 'obdm',
  },
  {
    term: same('OMQA'),
    year: '2014',
    focus: { zh: '理论侧：本体中介查询', en: 'Theory: ontology-mediated queries' },
    milestone: 'omqa',
  },
  {
    term: same('VKG'),
    year: '2019',
    focus: { zh: '知识图谱视角下的名称', en: 'The name from the knowledge graph perspective' },
    milestone: 'vkg',
  },
  {
    term: same('OBDF'),
    year: '2022',
    focus: { zh: '数据联邦引擎之上的 OBDA', en: 'OBDA over a data federation engine' },
    milestone: 'obdf',
  },
  {
    term: { zh: '语义层', en: 'Semantic layer' },
    year: '2019–',
    focus: { zh: '工业侧的叫法', en: 'The industry term' },
    milestone: 'ontopic',
  },
  {
    term: { zh: '动态本体', en: 'Dynamic ontology' },
    year: '2025–',
    focus: {
      zh: '本体连接数据、随时间演化并支持操作',
      en: 'Ontologies that connect to data, evolve and support actions',
    },
    milestone: 'dynamic-ontology',
  },
];

export const YEAR_FROM = 2002;
export const YEAR_TO = 2026;

export const eraOf = (year: number): Era => ERAS.find((era) => year >= era.from && year <= era.to)!;
