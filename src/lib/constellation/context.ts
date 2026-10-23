import citations from '../../data/citations.json';
import { ERAS, LINKS, MILESTONES } from '../../data/history';
import { PAPER_TOPICS, paperTopics } from '../../data/papers';
import type { Lang } from '../../i18n';
import type { Paper, Repo } from '../papers';
import type { SkyContext, SkyLink, SkyStar } from './types';

/** 主题颜色，按主题顺序取用；主题多于颜色数时循环使用。 */
const PALETTE = [
  '#f5d77a',
  '#9aa8ff',
  '#49bbdd',
  '#7fd38a',
  '#f29fb8',
  '#ffad6b',
  '#c99bff',
  '#6ee7d8',
  '#ff8a8a',
  '#b8e06a',
  '#7aa8ff',
  '#e6a8ff',
];

const ERA_SHORT: Record<string, Record<Lang, string>> = {
  origins: { zh: '前史与奠基', en: 'Origins' },
  systems: { zh: '系统化', en: 'Systems' },
  industry: { zh: '工业落地', en: 'Industry' },
  federation: { zh: '联邦与视图', en: 'Federation' },
  now: { zh: '写回与大模型', en: 'Now' },
};

/** 给每一项标上它在所属分组中的序号与分组大小。 */
function indexWithin<T>(items: T[], key: (item: T) => string): Map<T, [number, number]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  const result = new Map<T, [number, number]>();
  for (const group of groups.values()) {
    group.forEach((item, i) => result.set(item, [i, group.length]));
  }
  return result;
}

/**
 * 论文之间的关系：发展历程页的传承关系（里程碑换算为论文），加上抓取到的引用与 papers.yaml 中
 * 手工补充的引用。同一对论文只保留一条，传承优先；方向统一为从较早的论文指向较晚的论文。
 */
function buildLinks(papers: Paper[]): SkyLink[] {
  const ids = new Set(papers.map((paper) => paper.id));
  const year = new Map(papers.map((paper) => [paper.id, paper.data.year]));
  const links = new Map<string, SkyLink>();
  const key = (a: string, b: string) => [a, b].sort().join(' ');
  const add = (from: string, to: string, kind: SkyLink['kind']) => {
    if (from === to || !ids.has(from) || !ids.has(to) || links.has(key(from, to))) return;
    const [a, b] = year.get(from)! <= year.get(to)! ? [from, to] : [to, from];
    links.set(key(from, to), { from: a, to: b, kind });
  };

  const paperOf = new Map(MILESTONES.filter((m) => m.paper).map((m) => [m.id, m.paper!]));
  for (const [from, to, kind] of LINKS) {
    const a = paperOf.get(from);
    const b = paperOf.get(to);
    if (a && b) add(a, b, kind);
  }
  const fetched = citations.cites as Record<string, string[]>;
  for (const paper of papers) {
    for (const cited of [...(fetched[paper.id] ?? []), ...(paper.data.cites ?? [])]) {
      add(cited, paper.id, 'citation');
    }
  }
  return [...links.values()];
}

export function buildContext(papers: Paper[], repos: Repo[], lang: Lang): SkyContext {
  const withRepo = new Set(repos.map((repo) => repo.data.paper).filter(Boolean));
  const topics = paperTopics(lang).map((topic, i) => ({
    label: topic.label,
    short: topic.short ?? topic.label,
    color: PALETTE[i % PALETTE.length],
  }));
  const topicOf = (paper: Paper) => PAPER_TOPICS.indexOf(paper.data.topic);

  // 稳定排序：先按年份，再按主题，同组内保持文献库中的顺序
  const ordered = papers
    .map((paper, order) => ({ paper, order }))
    .sort(
      (a, b) =>
        a.paper.data.year - b.paper.data.year ||
        topicOf(a.paper) - topicOf(b.paper) ||
        a.order - b.order,
    )
    .map(({ paper }) => paper);

  const links = buildLinks(papers);
  // 被库内引用的次数：引用与明确的传承都计入，同一问题线不计
  const cited = new Map<string, number>();
  for (const link of links) {
    if (link.kind !== 'thread') cited.set(link.from, (cited.get(link.from) ?? 0) + 1);
  }

  const cell = indexWithin(ordered, (p) => `${p.data.topic}:${p.data.year}`);
  const byYear = indexWithin(ordered, (p) => String(p.data.year));
  const byTopic = indexWithin(ordered, (p) => p.data.topic);

  const stars: SkyStar[] = ordered.map((paper) => ({
    id: paper.id,
    topic: topicOf(paper),
    year: paper.data.year,
    code: Boolean(paper.data.code) || withRepo.has(paper.id),
    cellIndex: cell.get(paper)![0],
    cellSize: cell.get(paper)![1],
    yearIndex: byYear.get(paper)![0],
    yearSize: byYear.get(paper)![1],
    topicIndex: byTopic.get(paper)![0],
    topicSize: byTopic.get(paper)![1],
    cited: cited.get(paper.id) ?? 0,
  }));

  const from = Math.min(...stars.map((s) => s.year));
  const to = Math.max(...stars.map((s) => s.year));
  const eras = ERAS.filter((era) => era.to >= from && era.from <= to).map((era) => ({
    from: Math.max(era.from, from),
    to: Math.min(era.to, to),
    label: ERA_SHORT[era.id]?.[lang] ?? era.title[lang],
  }));
  const perYear = Array.from(
    { length: to - from + 1 },
    (_, i) => stars.filter((s) => s.year === from + i).length,
  );

  return { lang, stars, topics, from, to, eras, perYear, links };
}
