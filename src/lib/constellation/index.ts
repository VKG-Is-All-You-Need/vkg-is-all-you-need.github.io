/**
 * 文献星图的布局注册表。
 *
 * 新增布局：在 layouts/ 下新建一个文件，导出实现 LayoutDef 的对象，再加入下面的 LAYOUTS。
 * 布局只负责计算星点坐标、扫描进度、背景图形与连线样式（links.ts 中的 LinkStyle）；渲染、
 * 切换动画、扫描、悬停与筛选都由 components/papers/Constellation.astro 与 scripts/papers-fx.ts 统一处理。
 * 背景图形的样式写在 Constellation.astro 中，按 Shape.class 匹配。
 *
 * 布局应只依赖 SkyContext 中的数据（年份范围、主题数、每组的数量），不写死论文数或年份，
 * 这样文献库更新后无需修改布局代码。
 */
import { round } from './shared';
import type { LayoutDef, LayoutResult, SkyContext } from './types';
import { clusters } from './layouts/clusters';
import { lanes } from './layouts/lanes';
import { network } from './layouts/network';
import { radial } from './layouts/radial';
import { ring } from './layouts/ring';
import { spiral } from './layouts/spiral';
import { stack } from './layouts/stack';

/** 第一个布局为默认布局。 */
export const LAYOUTS: LayoutDef[] = [lanes, radial, spiral, clusters, network, stack, ring];

export interface BuiltLayout extends LayoutResult {
  id: string;
  label: string;
  icon: string;
}

export function buildLayouts(ctx: SkyContext): BuiltLayout[] {
  return LAYOUTS.map((def) => {
    const result = def.build(ctx);
    return {
      ...result,
      id: def.id,
      label: def.label[ctx.lang],
      icon: def.icon,
      width: round(result.width),
      height: Math.ceil(result.height),
    };
  });
}

export { buildContext } from './context';
export { linkPath } from './links';
export type { SkyContext, SkyLink } from './types';
