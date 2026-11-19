'use strict';

const input = document.querySelector('#search-input');
document.addEventListener('keydown', event => {
  if (event.key !== '/' || event.ctrlKey || event.altKey || event.metaKey || event.isComposing
    || event.target.closest?.('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return;
  event.preventDefault();
  input.focus();
});

const status = document.querySelector('#search-status');
if (status) {
  const results = document.querySelector('#search-results');
  const normalize = value => value.normalize('NFKC').toLowerCase().trim();
  const query = new URLSearchParams(location.search).get('q') || '';
  input.value = query;
  if (query.trim()) {
    status.textContent = '正在搜索…';
    fetch('search.json').then(response => {
      if (!response.ok) throw Error('Search index is unavailable');
      return response.json();
    }).then(index => {
      const terms = normalize(query).split(/[\p{P}\s]+/u).filter(Boolean);
      const han = terms.join('').replace(/[^\p{Script=Han}]/gu, '');
      const pairs = new Set([...han].slice(1).map((char, i) => han[i] + char));
      const hits = index.map(item => {
        const title = normalize(item.title);
        const lead = normalize(item.summary);
        const words = normalize(item.search);
        const exact = terms.map(term => title.includes(term) ? 5 : lead.includes(term) ? 3 : words.includes(term) ? 1 : 0);
        if (exact.length && exact.every(Boolean)) return {item, score: exact.reduce((sum, n) => sum + n, 0)};
        const searchText = [title, lead, item.keywords || ''].join(' ');
        const partial = [...pairs].filter(pair => searchText.includes(pair)).length;
        return {item, score: partial >= 2 && partial / pairs.size >= .5 ? partial / pairs.size : 0};
      }).filter(hit => hit.score).sort((a, b) => b.score - a.score);
      status.textContent = hits.length ? '找到 ' + hits.length + ' 篇文章' : '没有匹配的文章。可以试试“索引”“字号”或“恢复”。';
      for (const {item} of hits) {
        const row = document.createElement('li');
        const chapter = document.createElement('small');
        const title = document.createElement('a');
        const summary = document.createElement('p');
        chapter.textContent = item.chapter;
        title.textContent = item.title;
        if (!/^[a-z0-9-]+\.html$/.test(item.url)) continue;
        title.href = item.url;
        summary.textContent = item.summary;
        row.append(chapter, title, summary);
        results.append(row);
      }
    }).catch(() => { status.textContent = '搜索暂不可用。可以从章节目录打开文章。'; });
  }
}

const figureLinks = document.querySelectorAll('.figure-link');
if (figureLinks.length && typeof HTMLDialogElement !== 'undefined') {
  const dialog = document.createElement('dialog');
  const img = document.createElement('img');
  const controls = document.createElement('form');
  const button = document.createElement('button');
  controls.method = 'dialog';
  button.textContent = '关闭图片';
  controls.append(button);
  dialog.append(controls, img);
  dialog.setAttribute('aria-label', '查看大图');
  document.body.append(dialog);
  for (const link of figureLinks) link.addEventListener('click', event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    img.src = link.href;
    img.alt = link.querySelector('img').alt;
    dialog.showModal();
  });
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
}
const selected = document.querySelector('.sidebar a[aria-current="page"]');
if (selected) {
  const pane = selected.closest('.sidebar');
  if (selected.offsetTop > pane.clientHeight - 48) pane.scrollTop = selected.offsetTop - 36;
}
