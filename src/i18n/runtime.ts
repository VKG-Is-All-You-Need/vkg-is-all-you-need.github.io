import type { Lang } from '.';

/**
 * 示例页的当前语言，供数据模块与场景脚本生成文字时使用。
 * 浏览器中取自 <html lang>；切换语言会整页刷新（见 SiteHeader），一次页面会话只有一种语言。
 * 构建时由页面在渲染前调用 setLang 设定；Astro 逐页渲染，不会交错。
 */
let active: Lang =
  typeof document !== 'undefined' && document.documentElement.lang === 'en' ? 'en' : 'zh';

export const setLang = (lang: Lang): void => {
  active = lang;
};

export const currentLang = (): Lang => active;

export const isEnglish = (): boolean => active === 'en';

/** 按当前语言取两种写法之一。 */
export const tr = (zh: string, en: string): string => (active === 'en' ? en : zh);
