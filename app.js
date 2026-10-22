'use strict';
(() => {
  const input = document.querySelector('#search-input');
  const cards = [...document.querySelectorAll('.resource')];
  const buttons = [...document.querySelectorAll('[data-filter]')];
  const counter = document.querySelector('#result-count');
  let category = 'all';
  const normalize = value => value.normalize('NFKC').toLocaleLowerCase().trim();
  function update() {
    const terms = normalize(input.value).split(/\s+/).filter(Boolean);
    let count = 0;
    cards.forEach(card => {
      const text = normalize(card.dataset.search + ' ' + card.dataset.category);
      const match = (category === 'all' || card.dataset.category === category) && terms.every(term => text.includes(term));
      card.hidden = !match;
      if (match) count++;
    });
    counter.textContent = `${count} 项资源${category === 'all' ? '' : ' / ' + category}`;
    document.querySelector('#empty-state').hidden = count !== 0;
    buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === category)));
  }
  input.addEventListener('input', update);
  document.querySelector('.search').addEventListener('submit', event => event.preventDefault());
  buttons.forEach(button => button.addEventListener('click', () => { category = button.dataset.filter; update(); }));
  document.querySelector('#clear-search').addEventListener('click', () => { input.value = ''; update(); input.focus(); });
  document.querySelector('#reset-filters').addEventListener('click', () => { input.value = ''; category = 'all'; update(); input.focus(); });
  update();
})();
