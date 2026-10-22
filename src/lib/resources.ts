import { getCollection, type CollectionEntry } from 'astro:content';
import { categories, type Category } from '../data/categories';

export type Resource = CollectionEntry<'resources'>;

export interface ResourceGroup {
  category: Category;
  items: Resource[];
}

/** 按 resources.yaml 中的书写顺序返回全部资源。 */
export function getResources(): Promise<Resource[]> {
  return getCollection('resources');
}

export async function getResourceGroups(): Promise<ResourceGroup[]> {
  const resources = await getResources();
  return categories.map((category) => ({
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

/** 用于卡片角标的来源标识，如 “w3.org”“github.com/ontop”。 */
export function sourceLabel(url: string): string {
  const { hostname, pathname } = new URL(url);
  const host = hostname.replace(/^www\./, '');
  if (host === 'github.com') return `github.com/${pathname.split('/')[1]}`;
  return host;
}
