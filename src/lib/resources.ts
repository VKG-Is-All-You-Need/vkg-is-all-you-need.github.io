import { getCollection, type CollectionEntry } from 'astro:content';
import { categoriesOf, type Category } from '../data/categories';
import type { Lang } from '../i18n';
import resourcesYaml from '../data/resources.yaml?raw';

export type Resource = CollectionEntry<'resources'>;

export interface ResourceGroup {
  category: Category;
  items: Resource[];
}

/** 资源在某一语言下显示的文字。 */
export interface ResourceText {
  title: string;
  summary: string;
  links: { label: string; url: string }[];
}

/** 条目在 resources.yaml 中的书写顺序（file() 加载器不保证保留该顺序）。 */
const ORDER = new Map(
  [...resourcesYaml.matchAll(/^- id: (\S+)/gm)].map((match, index) => [match[1], index]),
);

/** 按 resources.yaml 中的书写顺序返回全部资源。 */
export async function getResources(): Promise<Resource[]> {
  const resources = await getCollection('resources');
  return resources.sort((a, b) => (ORDER.get(a.id) ?? 0) - (ORDER.get(b.id) ?? 0));
}

export async function getResourceGroups(lang: Lang): Promise<ResourceGroup[]> {
  const resources = await getResources();
  return categoriesOf(lang).map((category) => ({
    category,
    items: resources.filter((resource) => resource.data.category === category.id),
  }));
}

export async function getResourcesById(ids: readonly string[]): Promise<Resource[]> {
  const resources = await getResources();
  return ids.map((id) => {
    const resource = resources.find((entry) => entry.id === id);
    if (!resource) throw new Error(`未知资源 id：${id}`);
    return resource;
  });
}

export function resourceText({ data }: Resource, lang: Lang): ResourceText {
  if (lang === 'zh') return data;
  return {
    title: data.title_en ?? data.title,
    summary: data.summary_en,
    links: data.links.map((link) => ({ label: link.label_en ?? link.label, url: link.url })),
  };
}

/** 用于卡片角标的来源标识，如 “w3.org”“github.com/ontop”。 */
export function sourceLabel(url: string): string {
  const { hostname, pathname } = new URL(url);
  const host = hostname.replace(/^www\./, '');
  if (host === 'github.com') return `github.com/${pathname.split('/')[1]}`;
  return host;
}
