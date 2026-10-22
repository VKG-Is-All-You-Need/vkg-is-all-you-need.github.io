import { defineCollection } from 'astro:content';
import { file } from 'astro/loaders';
import { z } from 'astro/zod';
import { CATEGORY_IDS } from './data/categories';

/** 英文字段以 _en 结尾；名称本身为英文时可省略 title_en 与 label_en。 */
const link = z.object({ label: z.string(), label_en: z.string().optional(), url: z.url() });

const resources = defineCollection({
  loader: file('src/data/resources.yaml'),
  schema: z
    .object({
      title: z.string(),
      title_en: z.string().optional(),
      url: z.url(),
      category: z.enum(CATEGORY_IDS),
      /** 论文的发表场合，如 “IJCAI 2018”。 */
      venue: z.string().optional(),
      summary: z.string(),
      summary_en: z.string(),
      /** 使用限制或注意事项。 */
      note: z.string().optional(),
      note_en: z.string().optional(),
      /** 次要链接，如文档、源码或论文 PDF。 */
      links: z.array(link).default([]),
    })
    .refine((data) => !data.note === !data.note_en, {
      message: 'note 与 note_en 需同时填写或同时省略',
    }),
});

export const collections = { resources };
