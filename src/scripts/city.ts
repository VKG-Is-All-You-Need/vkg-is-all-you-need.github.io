import { onPageLoad } from './lifecycle';
import { setLang } from '../i18n/runtime';

// 仅在城市数据融合示例页加载控制器；three.js 由控制器在场景进入视口后再加载。
onPageLoad((signal) => {
  const root = document.querySelector<HTMLElement>('[data-city]');
  if (!root) return;
  setLang(document.documentElement.lang === 'en' ? 'en' : 'zh');
  void import('./city/controller').then(({ initCity }) => {
    if (!signal.aborted) initCity(root, signal);
  });
});
