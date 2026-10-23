import { onPageLoad } from './lifecycle';
import { decodeTitle, initConstellation } from './papers-fx';

const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase();

const VIEW_KEY = 'papers-view';

// 文献页：按关键词与“只看有代码”筛选论文和仓库；标准与动效两种显示模式。
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
  const page = document.querySelector<HTMLElement>('[data-papers-page]')!;
  const viewButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-papers-view]')];
  const sky = page.querySelector<HTMLElement>('[data-constellation]');
  const constellation = sky ? initConstellation(sky, signal) : undefined;
  const title = page.querySelector<HTMLElement>('.page-header h1');

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
    constellation?.sync(
      new Set(papers.filter((paper) => !paper.hidden).map((paper) => paper.id)),
      terms.length > 0 || codeOnly,
    );
    const filtered = shown !== total;
    counter.textContent = en
      ? filtered
        ? `${shown} of ${total} papers`
        : `${total} papers`
      : filtered
        ? `${shown} / ${total} 篇论文`
        : `${total} 篇论文`;
  };

  // 显示模式：首次绘制前已由页内脚本按本地记录设置 data-fx，这里同步按钮状态
  const setView = (fx: boolean) => {
    // 星图出现或消失会改变列表位置；读者已滚到列表中时，保持视野不跳动
    const before = root.getBoundingClientRect().top;
    page.toggleAttribute('data-fx', fx);
    const after = root.getBoundingClientRect().top;
    if (before < 0) window.scrollBy({ top: after - before, behavior: 'instant' });
    for (const button of viewButtons) {
      button.setAttribute('aria-pressed', String((button.dataset.papersView === 'fx') === fx));
    }
    if (fx) {
      constellation?.rearm();
      if (title) decodeTitle(title, signal);
    }
  };
  const initialFx = page.hasAttribute('data-fx');
  for (const button of viewButtons) {
    button.setAttribute('aria-pressed', String((button.dataset.papersView === 'fx') === initialFx));
    button.addEventListener(
      'click',
      () => {
        const fx = button.dataset.papersView === 'fx';
        if (fx === page.hasAttribute('data-fx')) return;
        try {
          localStorage.setItem(VIEW_KEY, fx ? 'fx' : 'standard');
        } catch {}
        setView(fx);
      },
      { signal },
    );
  }
  if (initialFx && title) decodeTitle(title, signal);

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
