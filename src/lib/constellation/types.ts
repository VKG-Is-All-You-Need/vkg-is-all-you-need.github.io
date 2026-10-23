import type { Lang } from '../../i18n';

export interface Point {
  x: number;
  y: number;
}

/** 一篇论文在星图中的输入数据；各种分组内的序号由 buildContext 预先算好。 */
export interface SkyStar {
  id: string;
  /** 主题序号，对应 SkyContext.topics。 */
  topic: number;
  year: number;
  code: boolean;
  /** 同主题、同年份的一簇中的序号与数量。 */
  cellIndex: number;
  cellSize: number;
  /** 同年份中的序号与数量（按主题，再按文献库中的顺序）。 */
  yearIndex: number;
  yearSize: number;
  /** 同主题中按年份排列的序号与数量。 */
  topicIndex: number;
  topicSize: number;
}

export interface SkyTopic {
  label: string;
  short: string;
  color: string;
}

export interface SkyEra {
  from: number;
  to: number;
  label: string;
}

export interface SkyContext {
  lang: Lang;
  stars: SkyStar[];
  topics: SkyTopic[];
  /** 文献库中最早与最晚的年份。 */
  from: number;
  to: number;
  /** 与年份范围有交集的时期，年份已截取到范围内。 */
  eras: SkyEra[];
  /** 每年的论文数，下标为 year - from。 */
  perYear: number[];
}

/** 背景图形：按 tag 原样渲染为 SVG 元素；带 data-p 的元素会随扫描进度出现。 */
export interface Shape {
  tag: 'circle' | 'line' | 'path' | 'rect' | 'text';
  class: string;
  text?: string;
  [attr: string]: string | number | undefined;
}

/** 扫描动画的形式：竖线横扫、光环扩散、沿路径描绘，或只按进度依次点亮。 */
export type Sweep =
  | { kind: 'line' }
  | { kind: 'ripple'; cx: number; cy: number; r: number }
  | { kind: 'trace'; d: string }
  | { kind: 'none' };

export interface LayoutResult {
  width: number;
  height: number;
  /** true 时缩放到容器宽度；false 时按原尺寸绘制，在容器内横向滚动。 */
  fit: boolean;
  positions: Record<string, Point>;
  /** 扫描进度（0–1），决定点亮顺序与布局切换时的出发顺序。 */
  progress: Record<string, number>;
  /** 两颗星之间连线的路径。 */
  link(a: Point, b: Point): string;
  sweep: Sweep;
  shapes: Shape[];
  /** 主题标签与画布中的行对齐时给出每行的位置；缺省时标签显示为图例。 */
  rows?: { top: number; height: number }[];
  /** 标签栏中的附加说明，如“每年论文数”。 */
  notes?: { top: number; height: number; text: string }[];
}

export interface LayoutDef {
  id: string;
  label: Record<Lang, string>;
  /** 切换按钮的图标：16×16 视图框内的 SVG 内容，以描边绘制。 */
  icon: string;
  build(ctx: SkyContext): LayoutResult;
}
