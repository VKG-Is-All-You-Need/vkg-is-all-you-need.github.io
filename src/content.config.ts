import { defineCollection } from 'astro:content';
import { file } from 'astro/loaders';
import { z } from 'astro/zod';
import { CATEGORY_IDS } from './data/categories';

const link = z.object({ label: z.string(), url: z.url() });

const resources = defineCollection({
  loader: file('src/data/resources.yaml'),
  schema: z.object({
    title: z.string(),
    url: z.url(),
    category: z.enum(CATEGORY_IDS),
    /** 论文的发表场合，如 “IJCAI 2018”。 */
    venue: z.string().optional(),
    summary: z.string(),
    /** 使用限制或注意事项。 */
    note: z.string().optional(),
    /** 次要链接，如文档、源码或论文 PDF。 */
    links: z.array(link).default([]),
  }),
});

export const collections = { resources };
