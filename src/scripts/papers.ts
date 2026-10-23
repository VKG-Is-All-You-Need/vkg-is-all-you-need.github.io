import { onPageLoad } from './lifecycle';

const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase();

// 文献页：按关键词与“只看有代码”筛选论文和仓库。
onPageLoad((signal) => {
  const root = document.querySelector<HTMLElement>('[data-papers]');
  if (!root) return;

  const input = root.querySelector<HTMLInputElement>('[data-papers-search]')!;
  const toggle = root.querySelector<HTMLButtonElement>('[data-papers-code]')!;
  const counter = root.querySelector<HTMLElement>('[data-papers-count]')!;
  const empty = root.querySelector<HTMLElement>('[data-papers-empty]')!;
  const sections = [...root.querySelectorAll<HTMLElement>('[data-topic]')];
  const papers = [...root.querySelectorAll<HTMLElement>('[data-paper]')];
  const repos = [...root.querySelectorAll<HTMLElement>('[data-repo]')];
  const repoGroups = [...root.querySelectorAll<HTMLElement>('[data-repo-group]')];
  const en = document.documentElement.lang === 'en';
  const total = papers.length;

  // 检索文本包括所在分区的标题，便于按主题搜索
  const haystack = new Map(
    [...papers, ...repos].map((item) => {
      const topic = item.closest('[data-topic]')?.querySelector('h2')?.textContent ?? '';
      return [item, normalize(`${item.textContent} ${topic}`)];
    }),
  );

  const apply = () => {
    const terms = normalize(input.value).split(/\s+/).filter(Boolean);
    const codeOnly = toggle.getAttribute('aria-pressed') === 'true';
    const matches = (item: HTMLElement) =>
      terms.every((term) => haystack.get(item)!.includes(term));

    let shown = 0;
    for (const paper of papers) {
      const visible = matches(paper) && (!codeOnly || paper.hasAttribute('data-code'));
      paper.hidden = !visible;
      if (visible) shown++;
    }
    let shownRepos = 0;
    for (const repo of repos) {
      repo.hidden = !matches(repo);
      if (!repo.hidden) shownRepos++;
    }
    for (const group of repoGroups) {
      group.hidden = !group.querySelector('[data-repo]:not([hidden])');
    }
    for (const section of sections) {
      section.hidden = !section.querySelector(
        '[data-paper]:not([hidden]), [data-repo]:not([hidden])',
      );
    }
    empty.hidden = shown + shownRepos > 0;
    const filtered = shown !== total;
    counter.textContent = en
      ? filtered
        ? `${shown} of ${total} papers`
        : `${total} papers`
      : filtered
        ? `${shown} / ${total} 篇论文`
        : `${total} 篇论文`;
  };

  input.addEventListener('input', apply, { signal });
  toggle.addEventListener(
    'click',
    () => {
      toggle.setAttribute('aria-pressed', String(toggle.getAttribute('aria-pressed') !== 'true'));
      apply();
    },
    { signal },
  );
});
