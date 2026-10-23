import type { Lang } from '../i18n';

export const site = {
  name: 'VKG is all you need',
  /** 资源信息最近一次核对的日期（ISO 8601）。 */
  verifiedAt: '2026-10-22',
  links: {
    org: 'https://github.com/VKG-Is-All-You-Need',
    repo: 'https://github.com/VKG-Is-All-You-Need/vkg-is-all-you-need.github.io',
    resources: 'https://github.com/VKG-Is-All-You-Need/vkg-resources',
    issues: 'https://github.com/VKG-Is-All-You-Need/vkg-resources/issues',
    profile: 'https://github.com/VKG-Is-All-You-Need/.github',
    distinction:
      'https://github.com/VKG-Is-All-You-Need/vkg-resources#1-vkgontop-与-ontopic-的区别',
  },
} as const;

/** 首页标题与默认页面描述。 */
export const siteText: Record<Lang, { title: string; description: string }> = {
  zh: {
    title: 'VKG is all you need · 虚拟知识图谱资源索引',
    description:
      '虚拟知识图谱（VKG）与基于本体的数据访问（OBDA）资源索引，涵盖标准规范、工具、教程、基准测试与论文。',
  },
  en: {
    title: 'VKG is all you need · Virtual Knowledge Graph Resources',
    description:
      'An index of resources on virtual knowledge graphs (VKG) and ontology-based data access (OBDA): standards, tools, tutorials, benchmarks and papers.',
  },
};

/** 导航项。href 为中文路径，渲染时按语言加前缀。 */
export const nav: { href: string; match: string | null; label: Record<Lang, string> }[] = [
  { href: '/#how', match: null, label: { zh: '原理', en: 'How it works' } },
  { href: '/resources/', match: '/resources', label: { zh: '资源', en: 'Resources' } },
  { href: '/papers/', match: '/papers', label: { zh: '文献', en: 'Papers' } },
  { href: '/learn/', match: '/learn', label: { zh: '学习', en: 'Learn' } },
  { href: '/examples/', match: '/examples', label: { zh: '示例', en: 'Examples' } },
  { href: '/about/', match: '/about', label: { zh: '关于', en: 'About' } },
];
