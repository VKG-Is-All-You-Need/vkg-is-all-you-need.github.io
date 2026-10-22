import { onPageLoad } from './lifecycle';

// 仅在地理信息示例页加载控制器；three.js 由控制器在场景进入视口后再加载。
onPageLoad((signal) => {
  const root = document.querySelector<HTMLElement>('[data-geo]');
  if (!root) return;
  void import('./geo/controller').then(({ initGeo }) => {
    if (!signal.aborted) initGeo(root, signal);
  });
});
