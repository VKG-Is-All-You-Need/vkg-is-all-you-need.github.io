import { onPageLoad } from './lifecycle';
import { setLang } from '../i18n/runtime';

// 仅在设备诊断示例页加载控制器。
onPageLoad((signal) => {
  const root = document.querySelector<HTMLElement>('[data-turbine]');
  if (!root) return;
  setLang(document.documentElement.lang === 'en' ? 'en' : 'zh');
  void import('./turbine/controller').then(({ initTurbine }) => {
    if (!signal.aborted) initTurbine(root, signal);
  });
});
