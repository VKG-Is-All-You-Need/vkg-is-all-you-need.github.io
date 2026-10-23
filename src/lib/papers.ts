import { getCollection, type CollectionEntry } from 'astro:content';
import type { Lang } from '../i18n';
import papersYaml from '../data/papers.yaml?raw';
import reposYaml from '../data/repos.yaml?raw';

export type Paper = CollectionEntry<'papers'>;
export type Repo = CollectionEntry<'repos'>;

/** 条目在 YAML 文件中的书写顺序（file() 加载器不保证保留该顺序）。 */
const orderOf = (yaml: string) =>
  new Map([...yaml.matchAll(/^- id: (\S+)/gm)].map((match, index) => [match[1], index]));

const PAPER_ORDER = orderOf(papersYaml);
const REPO_ORDER = orderOf(reposYaml);

export async function getPapers(): Promise<Paper[]> {
  const papers = await getCollection('papers');
  return papers.sort((a, b) => (PAPER_ORDER.get(a.id) ?? 0) - (PAPER_ORDER.get(b.id) ?? 0));
}

export async function getRepos(): Promise<Repo[]> {
  const repos = await getCollection('repos');
  return repos.sort((a, b) => (REPO_ORDER.get(a.id) ?? 0) - (REPO_ORDER.get(b.id) ?? 0));
}

export const paperSummary = ({ data }: Paper | Repo, lang: Lang): string =>
  lang === 'zh' ? data.summary : data.summary_en;

/** 论文的简称：标题中冒号前的部分，如 “LLM4VKG”。 */
export const shortTitle = (title: string): string => title.split(':')[0];
