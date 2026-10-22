/**
 * 极简语法着色：为 SPARQL、SQL、Turtle 与 Ontop 映射片段生成带 class 的 HTML。
 * k 关键字、v 变量与占位符、s 字符串、f 空间函数、c 注释。
 */

const KEYWORDS = [
  'SELECT',
  'DISTINCT',
  'WHERE',
  'FILTER',
  'BIND',
  'AS',
  'ORDER',
  'BY',
  'FROM',
  'AND',
  'IN',
  'UNION',
  'ALL',
  'mappingId',
  'target',
  'source',
  'a',
  'rdfs:subClassOf',
];

const TOKEN = new RegExp(
  [
    String.raw`(?<c>(?:--|#)[^\n]*)`,
    String.raw`(?<s>"[^"\n]*"(?:\^\^[\w:]+)?|'[^'\n]*')`,
    String.raw`(?<v>\?\w+|\{\w+\})`,
    String.raw`(?<f>geof:\w+|ST_\w+)`,
    String.raw`(?<k>(?<![\w:/.])(?:${KEYWORDS.join('|')})(?![\w:]))`,
  ].join('|'),
  'g',
);

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function highlight(code: string): string {
  let html = '';
  let last = 0;
  for (const match of code.matchAll(TOKEN)) {
    const [text] = match;
    const kind = Object.entries(match.groups ?? {}).find(([, value]) => value !== undefined)?.[0];
    html += escape(code.slice(last, match.index)) + `<span class="${kind}">${escape(text)}</span>`;
    last = match.index + text.length;
  }
  return html + escape(code.slice(last));
}
