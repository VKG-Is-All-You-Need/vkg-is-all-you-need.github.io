import { onPageLoad, prefersReducedMotion } from './lifecycle';

const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase();

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

// 资源页：搜索、分类筛选与 URL 参数同步（?category=…&q=…）。
onPageLoad((signal) => {
  const explorer = document.querySelector<HTMLElement>('[data-explorer]');
  if (!explorer) return;

  const toolbar = explorer.querySelector<HTMLElement>('[data-toolbar]')!;
  const input = explorer.querySelector<HTMLInputElement>('[data-explorer-search]')!;
  const buttons = [...explorer.querySelectorAll<HTMLButtonElement>('[data-filter]')];
  const groups = [...explorer.querySelectorAll<HTMLElement>('[data-group]')];
  const cards = [...explorer.querySelectorAll<HTMLElement>('[data-resource]')];
  const counter = explorer.querySelector<HTMLElement>('[data-count]')!;
  const empty = explorer.querySelector<HTMLElement>('[data-empty]')!;
  const total = cards.length;

  const haystack = new Map(
    cards.map((card) => {
      const groupLabel = card.closest('[data-group]')?.querySelector('h2')?.textContent ?? '';
      return [card, normalize(`${card.textContent} ${groupLabel}`)];
    }),
  );

  const params = new URLSearchParams(location.search);
  let category = params.get('category') ?? 'all';
  if (!buttons.some((button) => button.dataset.filter === category)) category = 'all';
  input.value = params.get('q') ?? '';

  const apply = () => {
    const terms = normalize(input.value).split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const group of groups) {
      const inCategory = category === 'all' || group.dataset.group === category;
      let visible = 0;
      group.querySelectorAll<HTMLElement>('[data-resource]').forEach((card) => {
        const match = inCategory && terms.every((term) => haystack.get(card)!.includes(term));
        card.hidden = !match;
        if (match) visible++;
      });
      group.hidden = visible === 0;
      shown += visible;
    }
    counter.textContent = shown === total ? `共 ${total} 项` : `${shown} / ${total} 项`;
    empty.hidden = shown > 0;
    buttons.forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset.filter === category)),
    );
  };

  const syncUrl = () => {
    const url = new URL(location.href);
    const query = input.value.trim();
    if (category === 'all') url.searchParams.delete('category');
    else url.searchParams.set('category', category);
    if (query) url.searchParams.set('q', query);
    else url.searchParams.delete('q');
    history.replaceState(history.state, '', url);
  };

  // 切换分类时用 View Transitions 让卡片平滑重排。
  const update = (animate = false) => {
    const run = () => {
      apply();
      syncUrl();
    };
    if (!animate || !('startViewTransition' in document) || prefersReducedMotion()) {
      run();
      return;
    }
    cards.forEach((card) => (card.style.viewTransitionName = `card-${card.dataset.resource}`));
    document
      .startViewTransition(run)
      .finished.finally(() => cards.forEach((card) => (card.style.viewTransitionName = '')));
  };

  const revealTop = () => {
    if (explorer.getBoundingClientRect().top < 0) explorer.scrollIntoView({ block: 'start' });
  };

  toolbar.hidden = false;
  apply();

  input.addEventListener('input', () => update(), { signal });
  buttons.forEach((button) =>
    button.addEventListener(
      'click',
      () => {
        category = button.dataset.filter ?? 'all';
        update(true);
        revealTop();
      },
      { signal },
    ),
  );
  explorer.querySelector('[data-reset]')?.addEventListener(
    'click',
    () => {
      input.value = '';
      category = 'all';
      update(true);
      input.focus();
    },
    { signal },
  );

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === '/' && !isTyping(event.target)) {
        event.preventDefault();
        input.focus();
      }
    },
    { signal },
  );

  // 站内跳转（ClientRouter）不会触发 :target，手动高亮锚点卡片。
  const target = location.hash
    ? document.getElementById(decodeURIComponent(location.hash.slice(1)))
    : null;
  if (target?.matches('[data-resource]')) {
    target.hidden = false;
    target.classList.add('is-target');
    window.setTimeout(() => target.classList.remove('is-target'), 3600);
  }
});
