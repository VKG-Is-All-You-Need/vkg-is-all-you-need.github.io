// 抓取文献库内论文之间的引用关系，写入 src/data/citations.json。
//
// 用法：npm run citations              只查询缓存中还没有的论文（新增的、上次没查到的）
//       npm run citations -- --refresh  全部重新查询
//
// 数据来自 OpenAlex、Semantic Scholar 与 Crossref，三者的参考文献列表互相补充，结果取并集。
// Crossref 的参考文献由出版社提交，对 IEEE、Springer、ACM 等出版的论文最全；其中带 DOI 的
// 按 DOI 对应到文献库，不带 DOI 的按文献库论文的完整标题在引文文本中查找。
// 每篇论文先按 DOI（或 arXiv 号）查找，查不到时按标题检索；无论哪种方式都核对标题，
// 避免数据库中挂错的 DOI 造成误匹配。被引论文比引用它的论文晚一年以上的边视为错误并丢弃。
// 三个数据源都缺的引用，可在 papers.yaml 中用 cites 字段手工补充，构建时与本文件合并。
//
// 查询结果（含完整的参考文献列表）缓存在 scripts/citations-cache.json 并提交到仓库，
// 这样文献库更新时只需查询新增的论文。OpenAlex 按额度限流，额度不足时可设置环境变量
// OPENALEX_API_KEY；没查到的论文不写入缓存，下次运行会再次尝试。

import { readFile, writeFile } from 'node:fs/promises';
import { parse } from 'yaml';

const PAPERS = new URL('../src/data/papers.yaml', import.meta.url);
const OUTPUT = new URL('../src/data/citations.json', import.meta.url);
const CACHE = new URL('./citations-cache.json', import.meta.url);
const refresh = process.argv.includes('--refresh');
const OA_KEY = process.env.OPENALEX_API_KEY ? `&api_key=${process.env.OPENALEX_API_KEY}` : '';
const UA = 'vkg-is-all-you-need site (https://github.com/VKG-Is-All-You-Need)';

const papers = parse(await readFile(PAPERS, 'utf8'));
const byId = new Map(papers.map((paper) => [paper.id, paper]));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 额度耗尽（需要等待很久才能重试）的服务，本次运行中不再请求。 */
const exhausted = new Set();

/** 请求 JSON；遇到限流（429）或服务器错误时按 Retry-After 或指数退避重试。 */
async function getJson(url, init = {}, tries = 6) {
  const host = new URL(url).host;
  for (let i = 0; i < tries; i++) {
    if (exhausted.has(host)) return null;
    let wait = 2000 * 2 ** i;
    try {
      const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, ...init.headers } });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after'));
        if (retryAfter > 300) {
          exhausted.add(host);
          console.warn(`  ${host}: quota exhausted, retry in ${Math.round(retryAfter / 3600)} h`);
          return null;
        }
        if (retryAfter > 0) wait = retryAfter * 1000;
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) return null;
      return await res.json();
    } catch (error) {
      if (i === tries - 1) {
        console.warn(`  ${url.slice(0, 90)}… ${error.message}`);
        return null;
      }
      await sleep(wait);
    }
  }
  return null;
}

const words = (title) =>
  (title ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

/** 标题相似度：词集合的 Dice 系数；较短标题是较长标题的开头（如省略副标题）时视为相同。 */
function similarity(a, b) {
  const wa = words(a);
  const wb = words(b);
  if (!wa.length || !wb.length) return 0;
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  if (short.length >= 2 && short.every((w, i) => long[i] === w)) return 1;
  const sa = new Set(wa);
  const sb = new Set(wb);
  let common = 0;
  for (const w of sa) if (sb.has(w)) common++;
  return (2 * common) / (sa.size + sb.size);
}

function identifiers(paper) {
  const doi = paper.url.match(/doi\.org\/(.+)$/)?.[1];
  const arxiv = paper.url.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/)?.[1];
  return { doi: doi ?? (arxiv ? `10.48550/arXiv.${arxiv}` : null), arxiv };
}

// ── OpenAlex ──
async function openAlex(paper) {
  const { doi } = identifiers(paper);
  if (doi) {
    const work = await getJson(
      `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?select=id,title,referenced_works${OA_KEY}`,
    );
    if (work && similarity(work.title, paper.title) >= 0.5) return work;
  }
  const query = encodeURIComponent(words(paper.title).join(' '));
  const found = await getJson(
    `https://api.openalex.org/works?search=${query}&per-page=5&select=id,title,publication_year,referenced_works${OA_KEY}`,
  );
  return (
    found?.results?.find(
      (work) =>
        Math.abs((work.publication_year ?? 0) - paper.year) <= 1 &&
        similarity(work.title, paper.title) >= 0.85,
    ) ?? null
  );
}

// ── Semantic Scholar ──
const S2_FIELDS = 'title,year,references.paperId';

/** 批量查询缓存中没有的论文；批量未命中或没有标识符的，再按标题逐条匹配（接口限速）。 */
async function semanticScholar(todo) {
  const results = new Map();
  const withIds = todo
    .map((paper) => {
      const { doi, arxiv } = identifiers(paper);
      return { paper, id: arxiv ? `ARXIV:${arxiv}` : doi ? `DOI:${doi}` : null };
    })
    .filter((item) => item.id);
  if (withIds.length) {
    const batch = await getJson(
      `https://api.semanticscholar.org/graph/v1/paper/batch?fields=${S2_FIELDS}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: withIds.map((item) => item.id) }),
      },
      8,
    );
    withIds.forEach(({ paper }, i) => {
      const work = batch?.[i];
      if (work && similarity(work.title, paper.title) >= 0.5) results.set(paper.id, work);
    });
  }
  for (const paper of todo) {
    if (results.has(paper.id)) continue;
    await sleep(1200);
    const found = await getJson(
      `https://api.semanticscholar.org/graph/v1/paper/search/match?query=${encodeURIComponent(paper.title)}&fields=${S2_FIELDS}`,
      {},
      3,
    );
    const work = found?.data?.[0];
    if (work && similarity(work.title, paper.title) >= 0.85) results.set(paper.id, work);
  }
  return results;
}

// ── Crossref ──
async function crossref(paper) {
  const doi = paper.url.match(/doi\.org\/(.+)$/)?.[1];
  if (!doi) return null;
  const found = await getJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
  const work = found?.message;
  if (!work || similarity(work.title?.[0], paper.title) < 0.5) return null;
  const refs = work.reference ?? [];
  return {
    id: doi.toLowerCase(),
    title: work.title[0],
    refs: refs.map((ref) => ref.DOI?.toLowerCase()).filter(Boolean),
    texts: refs
      .filter((ref) => !ref.DOI)
      .map((ref) => ref['article-title'] ?? ref.unstructured)
      .filter(Boolean),
  };
}

let cache = { openalex: {}, semanticscholar: {}, crossref: {} };
if (!refresh) {
  try {
    cache = JSON.parse(await readFile(CACHE, 'utf8'));
  } catch {}
}
// 缓存中只保留仍在文献库中的论文
for (const source of Object.values(cache)) {
  for (const id of Object.keys(source)) if (!byId.has(id)) delete source[id];
}

const oaTodo = papers.filter((paper) => !cache.openalex[paper.id]);
console.log(`OpenAlex: ${oaTodo.length} to query, ${papers.length - oaTodo.length} cached`);
for (const paper of oaTodo) {
  const work = await openAlex(paper);
  if (work) {
    cache.openalex[paper.id] = {
      id: work.id.split('/').pop(),
      title: work.title,
      refs: (work.referenced_works ?? []).map((ref) => ref.split('/').pop()),
    };
  }
  await sleep(250);
}

const s2Todo = papers.filter((paper) => !cache.semanticscholar[paper.id]);
console.log(`Semantic Scholar: ${s2Todo.length} to query, ${papers.length - s2Todo.length} cached`);
for (const [id, work] of await semanticScholar(s2Todo)) {
  cache.semanticscholar[id] = {
    id: work.paperId,
    title: work.title,
    refs: (work.references ?? []).map((ref) => ref?.paperId).filter(Boolean),
  };
}

cache.crossref ??= {};
const crTodo = papers.filter((paper) => !cache.crossref[paper.id] && /doi\.org\//.test(paper.url));
console.log(`Crossref: ${crTodo.length} to query`);
for (const paper of crTodo) {
  const work = await crossref(paper);
  if (work) cache.crossref[paper.id] = work;
  await sleep(150);
}

const sortKeys = (object) => Object.fromEntries(Object.entries(object).sort());
cache = Object.fromEntries(
  Object.entries(cache).map(([source, works]) => [source, sortKeys(works)]),
);
await writeFile(CACHE, `${JSON.stringify(cache)}\n`);

const cites = new Map(papers.map((paper) => [paper.id, new Set()]));
// OpenAlex、Semantic Scholar 的参考文献是各自的作品 id；Crossref 的是 DOI，直接对应文献库的 DOI
const libraryDoi = new Map(
  papers.flatMap((paper) => {
    const { doi } = identifiers(paper);
    return doi ? [[doi.toLowerCase(), paper.id]] : [];
  }),
);
for (const [source, works] of Object.entries(cache)) {
  const toPaper =
    source === 'crossref'
      ? libraryDoi
      : new Map(Object.entries(works).map(([id, work]) => [work.id, id]));
  for (const [id, work] of Object.entries(works)) {
    for (const ref of work.refs) {
      const target = toPaper.get(ref);
      if (target) cites.get(id).add(target);
    }
  }
}
// 不带 DOI 的引文：文献库论文的完整标题（至少四个词）出现在引文文本中即视为引用
const titled = papers
  .map((paper) => ({ id: paper.id, words: words(paper.title).join(' ') }))
  .filter((paper) => paper.words.split(' ').length >= 4);
for (const [id, work] of Object.entries(cache.crossref)) {
  for (const text of work.texts ?? []) {
    const haystack = ` ${words(text).join(' ')} `;
    for (const paper of titled) {
      if (paper.id !== id && haystack.includes(` ${paper.words} `)) cites.get(id).add(paper.id);
    }
  }
}

let dropped = 0;
for (const [id, targets] of cites) {
  for (const target of targets) {
    if (target === id || byId.get(target).year > byId.get(id).year + 1) {
      targets.delete(target);
      dropped++;
    }
  }
}

const sorted = (set) => [...set].sort();
const result = {
  note: '由 npm run citations 生成，请勿手工编辑；补充引用请在 papers.yaml 中使用 cites 字段。',
  generated: new Date().toISOString().slice(0, 10),
  cites: Object.fromEntries(
    [...cites]
      .filter(([, targets]) => targets.size)
      .sort()
      .map(([id, t]) => [id, sorted(t)]),
  ),
};
await writeFile(OUTPUT, `${JSON.stringify(result, null, 2)}\n`);

const edges = Object.values(result.cites).reduce((n, targets) => n + targets.length, 0);
const linked = new Set(Object.entries(result.cites).flatMap(([id, t]) => [id, ...t]));
console.log(
  `${edges} citations among ${linked.size} of ${papers.length} papers` +
    (dropped ? ` (${dropped} dropped)` : ''),
);
const missing = papers
  .filter((paper) => Object.values(cache).every((works) => !works[paper.id]))
  .map((p) => p.id);
if (missing.length) console.log(`Not found in any source: ${missing.join(', ')}`);
const isolated = papers.filter((paper) => !linked.has(paper.id)).map((p) => p.id);
if (isolated.length) console.log(`No citations within the library: ${isolated.join(', ')}`);
