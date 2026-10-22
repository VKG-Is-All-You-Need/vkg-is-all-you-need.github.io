import type { Lang } from '../i18n';

export const CATEGORY_IDS = [
  'standards',
  'tools',
  'tutorials',
  'benchmarks',
  'papers',
  'adjacent',
] as const;

export type CategoryId = (typeof CATEGORY_IDS)[number];

export interface Category {
  id: CategoryId;
  label: string;
  description: string;
}

const CATEGORIES: Record<Lang, readonly Category[]> = {
  zh: [
    { id: 'standards', label: '标准规范', description: '与映射和查询相关的 W3C 规范。' },
    {
      id: 'tools',
      label: '工具',
      description: '以 Ontop 为核心，覆盖部署、命令行、映射编辑与标准兼容性。',
    },
    {
      id: 'tutorials',
      label: '教程与案例',
      description: '附带数据与映射的教程和领域案例。入门建议从 Ontop 官方教程开始。',
    },
    {
      id: 'benchmarks',
      label: '基准测试',
      description: '评测对象各不相同，分别针对映射质量、查询性能与数据生成。选用前请确认评测目标。',
    },
    { id: 'papers', label: '论文', description: '两篇领域综述，以及 Ontop 论文目录与近期研究。' },
    {
      id: 'adjacent',
      label: '相关生态',
      description:
        'RML 系列映射工具，主要用于将数据转换为 RDF，而非 VKG 查询引擎；其映射设计方法与 VKG 相通。',
    },
  ],
  en: [
    {
      id: 'standards',
      label: 'Standards',
      description: 'W3C specifications for mappings and queries.',
    },
    {
      id: 'tools',
      label: 'Tools',
      description:
        'Centered on Ontop: deployment, the command line, mapping editors and standards compliance.',
    },
    {
      id: 'tutorials',
      label: 'Tutorials and case studies',
      description:
        'Tutorials and domain case studies that ship with data and mappings. The official Ontop tutorial is the recommended starting point.',
    },
    {
      id: 'benchmarks',
      label: 'Benchmarks',
      description:
        'Each benchmark evaluates something different: mapping quality, query performance or data generation. Confirm the evaluation target before choosing one.',
    },
    {
      id: 'papers',
      label: 'Papers',
      description: 'Two surveys of the field, the Ontop publication list and recent research.',
    },
    {
      id: 'adjacent',
      label: 'Related ecosystem',
      description:
        'The RML family of mapping tools. They mainly convert data to RDF and are not VKG query engines, but their mapping design carries over to VKG.',
    },
  ],
};

export const categoriesOf = (lang: Lang): readonly Category[] => CATEGORIES[lang];

export const categoryOf = (id: CategoryId, lang: Lang): Category =>
  CATEGORIES[lang].find((category) => category.id === id)!;
