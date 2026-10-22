/**
 * 站点语言。中文页面位于根路径，英文页面位于 /en/ 下，两者路径一一对应。
 */
export const LANGS = ['zh', 'en'] as const;

export type Lang = (typeof LANGS)[number];

/** <html lang> 与 hreflang 使用的语言标签。 */
export const LANG_TAGS: Record<Lang, string> = { zh: 'zh-CN', en: 'en' };

/** 语言切换按钮上显示的名称（以目标语言书写）。 */
export const LANG_NAMES: Record<Lang, string> = { zh: '中文', en: 'English' };

/** 已有英文版的页面（中文路径）。不在此列的页面切换到英文时转到英文版示例目录。 */
const TRANSLATED = new Set(['/', '/resources/', '/learn/', '/about/', '/examples/']);

/** 供 [...lang] 动态路由的 getStaticPaths 使用：根路径为中文，en 为英文。 */
export const langPaths = () =>
  LANGS.map((lang) => ({ params: { lang: lang === 'zh' ? undefined : lang } }));

export function langOf(pathname: string): Lang {
  return pathname === '/en' || pathname.startsWith('/en/') ? 'en' : 'zh';
}

/** 去掉语言前缀后的中文路径，如 “/en/learn/” → “/learn/”；统一以 “/” 结尾。 */
export function basePath(pathname: string): string {
  const path = langOf(pathname) === 'zh' ? pathname : pathname.slice(3) || '/';
  return path.endsWith('/') ? path : `${path}/`;
}

/**
 * 站内链接加上语言前缀，如 localize('/learn/', 'en') → “/en/learn/”；支持查询参数与锚点。
 * 尚无英文版的页面保留中文地址。
 */
export function localize(href: string, lang: Lang): string {
  if (lang === 'zh' || !href.startsWith('/')) return href;
  const path = href.replace(/[?#].*$/, '');
  return TRANSLATED.has(path) ? `/en${href}` : href;
}

export const hasTranslation = (pathname: string): boolean => TRANSLATED.has(basePath(pathname));

/** 当前页面在另一语言下的对应地址。 */
export function switchTarget(pathname: string, lang: Lang): string {
  const base = basePath(pathname);
  return localize(TRANSLATED.has(base) ? base : '/examples/', lang);
}
