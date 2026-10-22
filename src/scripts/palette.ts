import { navigate } from 'astro:transitions/client';
import { onPageLoad } from './lifecycle';

export interface PaletteItem {
  type: 'page' | 'category' | 'resource';
  title: string;
  subtitle?: string;
  href: string;
  keywords?: string;
}

const GROUPS: Record<PaletteItem['type'], string> = {
  page: '页面',
  category: '分类',
  resource: '资源',
};

const ICONS: Record<PaletteItem['type'], string> = {
  page: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5"/>',
  category: '<path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16"/>',
  resource:
    '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4Z"/><path d="M5 17a3 3 0 0 1 3-3h11"/>',
};

const svg = (paths: string) =>
  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase();

interface Indexed {
  item: PaletteItem;
  title: string;
  haystack: string;
}

function rank(index: Indexed[], query: string): PaletteItem[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return index.map((entry) => entry.item);

  const scored: { item: PaletteItem; score: number; order: number }[] = [];
  index.forEach((entry, order) => {
    let score = 0;
    for (const term of terms) {
      if (!entry.haystack.includes(term)) return;
      score +=
        entry.title === term
          ? 4
          : entry.title.startsWith(term)
            ? 3
            : entry.title.includes(term)
              ? 2
              : 1;
    }
    scored.push({ item: entry.item, score, order });
  });

  // 分组按组内最高分排序，标题命中的资源会排在仅描述命中的分类之前。
  const best = new Map<PaletteItem['type'], number>();
  for (const { item, score } of scored)
    best.set(item.type, Math.max(best.get(item.type) ?? 0, score));
  const typeOrder = Object.keys(GROUPS);
  return scored
    .sort(
      (a, b) =>
        best.get(b.item.type)! - best.get(a.item.type)! ||
        typeOrder.indexOf(a.item.type) - typeOrder.indexOf(b.item.type) ||
        b.score - a.score ||
        a.order - b.order,
    )
    .map((entry) => entry.item);
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

onPageLoad((signal) => {
  const dialog = document.querySelector<HTMLDialogElement>('[data-palette]');
  const input = dialog?.querySelector<HTMLInputElement>('[data-palette-input]');
  const list = dialog?.querySelector<HTMLUListElement>('[data-palette-list]');
  const empty = dialog?.querySelector<HTMLElement>('[data-palette-empty]');
  const data = document.querySelector('[data-palette-data]')?.textContent;
  if (!dialog || !input || !list || !empty || !data) return;

  const index: Indexed[] = (JSON.parse(data) as PaletteItem[]).map((item) => ({
    item,
    title: normalize(item.title),
    haystack: normalize([item.title, item.subtitle, item.keywords].filter(Boolean).join(' ')),
  }));

  let results: PaletteItem[] = [];
  let active = 0;

  const options = () => [...list.querySelectorAll<HTMLElement>('[role="option"]')];

  function setActive(next: number, scroll = true) {
    const all = options();
    if (all.length === 0) return;
    active = (next + all.length) % all.length;
    all.forEach((option, i) => option.setAttribute('aria-selected', String(i === active)));
    input!.setAttribute('aria-activedescendant', all[active].id);
    if (scroll) all[active].scrollIntoView({ block: 'nearest' });
  }

  function render() {
    results = rank(index, input!.value);
    list!.replaceChildren();
    let currentType: PaletteItem['type'] | null = null;

    results.forEach((item, i) => {
      if (item.type !== currentType) {
        currentType = item.type;
        const heading = document.createElement('li');
        heading.className = 'palette-group';
        heading.setAttribute('role', 'presentation');
        heading.textContent = GROUPS[item.type];
        list!.append(heading);
      }
      const option = document.createElement('li');
      option.id = `palette-option-${i}`;
      option.className = 'palette-option';
      option.setAttribute('role', 'option');
      option.dataset.index = String(i);
      option.innerHTML = `<span class="palette-icon">${svg(ICONS[item.type])}</span><span class="palette-text"><span class="palette-title"></span><span class="palette-subtitle"></span></span><span class="palette-enter">↵</span>`;
      option.querySelector('.palette-title')!.textContent = item.title;
      option.querySelector('.palette-subtitle')!.textContent = item.subtitle ?? '';
      list!.append(option);
    });

    empty!.hidden = results.length > 0;
    input!.removeAttribute('aria-activedescendant');
    setActive(0);
  }

  function open() {
    if (dialog!.open) return;
    input!.value = '';
    render();
    dialog!.showModal();
    input!.focus();
  }

  function close() {
    if (dialog!.open) dialog!.close();
  }

  function go(item: PaletteItem | undefined) {
    if (!item) return;
    close();
    navigate(item.href);
  }

  document.addEventListener(
    'keydown',
    (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (dialog.open) close();
        else open();
      } else if (
        event.key === '/' &&
        !isTyping(event.target) &&
        !document.querySelector('[data-explorer-search]')
      ) {
        event.preventDefault();
        open();
      }
    },
    { signal },
  );

  document.querySelectorAll('[data-palette-open]').forEach((trigger) => {
    trigger.addEventListener('click', open, { signal });
  });

  input.addEventListener('input', render, { signal });
  input.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActive(active + 1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActive(active - 1);
      } else if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        go(results[active]);
      }
    },
    { signal },
  );

  list.addEventListener(
    'pointermove',
    (event) => {
      const option = (event.target as Element).closest<HTMLElement>('[role="option"]');
      if (option && Number(option.dataset.index) !== active) {
        setActive(Number(option.dataset.index), false);
      }
    },
    { signal },
  );
  list.addEventListener(
    'click',
    (event) => {
      const option = (event.target as Element).closest<HTMLElement>('[role="option"]');
      if (option) go(results[Number(option.dataset.index)]);
    },
    { signal },
  );

  // 点击遮罩层关闭。
  dialog.addEventListener(
    'click',
    (event) => {
      if (event.target === dialog) close();
    },
    { signal },
  );
});
