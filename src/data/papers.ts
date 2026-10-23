import type { Lang } from '../i18n';

export const PAPER_TOPICS = [
  'intro',
  'foundations',
  'systems',
  'construction',
  'evolution',
  'temporal',
  'qa',
  'benchmarks',
  'applications',
] as const;

export type PaperTopic = (typeof PAPER_TOPICS)[number];

export const REPO_GROUPS = ['system', 'examples', 'benchmarks', 'research'] as const;

export type RepoGroup = (typeof REPO_GROUPS)[number];

interface Section<T> {
  id: T;
  label: string;
  /** 图表中使用的短名，缺省时使用 label。 */
  short?: string;
  description: string;
}

const TOPICS: Record<Lang, Section<PaperTopic>[]> = {
  zh: [
    { id: 'intro', label: '讲义与综述', description: '入门讲义、设计教程与领域综述。' },
    {
      id: 'foundations',
      label: '理论基础',
      description: '数据集成与 DL-Lite 的理论，查询改写与优化，以及跨源实体的标识。',
    },
    {
      id: 'systems',
      label: '系统与平台',
      description: 'OBDA/VKG 系统，以及对空间数据、文档数据库、数据湖与联邦的扩展。',
    },
    {
      id: 'construction',
      label: '构建与映射',
      description: '本体与映射的生成、分析与映射模式，以及借助大语言模型构建与扩展 VKG。',
    },
    {
      id: 'evolution',
      label: '演化与更新',
      description: '本体与映射的演化和修复，以及经由本体写回数据源的更新。',
    },
    {
      id: 'temporal',
      label: '时态与流数据',
      description: '流数据上的 OBDA、时态本体与时态查询。',
    },
    { id: 'qa', label: '问答', description: '基于 VKG 与本体的自然语言问答及其基准。' },
    {
      id: 'benchmarks',
      label: '基准测试',
      description: '查询回答、数据扩展、本体学习与知识图谱构建的评测基准。',
    },
    {
      id: 'applications',
      label: '应用案例',
      description: '能源、制造、医疗、交通、历史与地理信息等领域的 VKG 应用。',
    },
  ],
  en: [
    {
      id: 'intro',
      label: 'Lectures and surveys',
      short: 'Surveys',
      description: 'Introductory lectures, a design tutorial and surveys of the field.',
    },
    {
      id: 'foundations',
      label: 'Foundations',
      description:
        'Theory of data integration and DL-Lite, query rewriting and optimization, and identity across sources.',
    },
    {
      id: 'systems',
      label: 'Systems and platforms',
      short: 'Systems',
      description:
        'OBDA/VKG systems and their extensions to spatial data, document databases, data lakes and federation.',
    },
    {
      id: 'construction',
      label: 'Construction and mappings',
      short: 'Construction',
      description:
        'Generating and analyzing ontologies and mappings, mapping patterns, and building and extending VKGs with large language models.',
    },
    {
      id: 'evolution',
      label: 'Evolution and updates',
      short: 'Evolution',
      description:
        'Evolution and repair of ontologies and mappings, and updates written back to the sources through the ontology.',
    },
    {
      id: 'temporal',
      label: 'Temporal and streaming data',
      short: 'Temporal',
      description: 'OBDA over streams, temporal ontologies and temporal queries.',
    },
    {
      id: 'qa',
      label: 'Question answering',
      short: 'QA',
      description:
        'Natural language question answering over VKGs and ontologies, and its benchmarks.',
    },
    {
      id: 'benchmarks',
      label: 'Benchmarks',
      description:
        'Benchmarks for query answering, data scaling, ontology learning and knowledge graph construction.',
    },
    {
      id: 'applications',
      label: 'Applications',
      description:
        'VKG applications in energy, manufacturing, healthcare, transport, history and geographic information.',
    },
  ],
};

const GROUPS: Record<Lang, Section<RepoGroup>[]> = {
  zh: [
    { id: 'system', label: '系统与工具', description: '' },
    { id: 'examples', label: '教程与案例', description: '' },
    { id: 'benchmarks', label: '基准', description: '' },
    { id: 'research', label: '论文代码', description: '' },
  ],
  en: [
    { id: 'system', label: 'Systems and tools', description: '' },
    { id: 'examples', label: 'Tutorials and case studies', description: '' },
    { id: 'benchmarks', label: 'Benchmarks', description: '' },
    { id: 'research', label: 'Research code', description: '' },
  ],
};

export const paperTopics = (lang: Lang) => TOPICS[lang];
export const repoGroups = (lang: Lang) => GROUPS[lang];
