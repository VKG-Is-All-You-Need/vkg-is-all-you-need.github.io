import { defineCollection } from 'astro:content';
import { file } from 'astro/loaders';
import { z } from 'astro/zod';
import { CATEGORY_IDS } from './data/categories';
import { PAPER_TOPICS, REPO_GROUPS } from './data/papers';

/** 英文字段以 _en 结尾；名称本身为英文时可省略 title_en 与 label_en。 */
const link = z.object({ label: z.string(), label_en: z.string().optional(), url: z.url() });

const resources = defineCollection({
  loader: file('src/data/resources.yaml'),
  schema: z.object({
    title: z.string(),
    title_en: z.string().optional(),
    url: z.url(),
    category: z.enum(CATEGORY_IDS),
    /** 论文的发表场合，如 “IJCAI 2018”。 */
    venue: z.string().optional(),
    summary: z.string(),
    summary_en: z.string(),
    /** 次要链接，如文档、源码或论文 PDF。 */
    links: z.array(link).default([]),
  }),
});

const papers = defineCollection({
  loader: file('src/data/papers.yaml'),
  schema: z.object({
    topic: z.enum(PAPER_TOPICS),
    title: z.string(),
    /** 作者，超过六位时写前几位加 “et al.”。 */
    authors: z.string(),
    year: z.number().int(),
    /** 发表场合，不含年份，如 “ISWC”“Semantic Web”。 */
    venue: z.string(),
    url: z.url(),
    /** 代码仓库或示例目录。 */
    code: z.url().optional(),
    /**
     * 本文引用的文献库内论文 id。引用关系主要由 npm run citations 从 OpenAlex、
     * Semantic Scholar 与 Crossref 抓取（src/data/citations.json）；这里只补充三者都缺的引用。
     */
    cites: z.array(z.string()).optional(),
    summary: z.string(),
    summary_en: z.string(),
  }),
});

const repos = defineCollection({
  loader: file('src/data/repos.yaml'),
  schema: z.object({
    group: z.enum(REPO_GROUPS),
    /** GitHub 上的 “owner/name”。 */
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    summary: z.string(),
    summary_en: z.string(),
    /** 对应的论文（papers.yaml 中的 id）。 */
    paper: z.string().optional(),
  }),
});

export const collections = { resources, papers, repos };
