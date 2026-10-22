export const site = {
  name: 'VKG is all you need',
  title: 'VKG is all you need · 虚拟知识图谱资源索引',
  description:
    '虚拟知识图谱（VKG）与基于本体的数据访问（OBDA）资源索引，涵盖标准规范、工具、教程、基准测试与论文。',
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

export const nav = [
  { href: '/#how', label: '原理', match: null },
  { href: '/resources/', label: '资源', match: '/resources' },
  { href: '/learn/', label: '学习', match: '/learn' },
  { href: '/examples/', label: '示例', match: '/examples' },
  { href: '/about/', label: '关于', match: '/about' },
] as const;
