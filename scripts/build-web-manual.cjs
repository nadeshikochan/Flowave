const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const renderer = path.join(root, 'electron-lxplayer/renderer');
const help = path.join(renderer, 'help');
const output = path.resolve(process.argv[2] || path.join(root, 'build/web-manual'));
const read = name => JSON.parse(fs.readFileSync(path.join(help, name + '.json'), 'utf8'));
const catalogue = read('catalog');
const chapters = catalogue.chapters.map(chapter => read(chapter.id));
const articles = chapters.flatMap(chapter => chapter.articles.map(article => ({...article, chapter: chapter.title})));
const articleById = new Map(articles.map(article => [article.id, article]));
const figureNames = new Set(articles.map(article => article.image).filter(Boolean));
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[ch]);
const articleUrl = id => {
  if (!articleById.has(id)) throw Error('Unknown article: ' + id);
  return id + '.html';
};
const sectionUrl = index => 'section-' + (index + 1);
const link = (id, label, current) =>
  '<a href="' + articleUrl(id) + '"' + (current ? ' aria-current="page"' : '') + '>' + escape(label) + '</a>';

function contents(active) {
  return '<nav aria-label="手册目录">' + chapters.map(chapter =>
    '<section><h2>' + escape(chapter.title) + '</h2><ul>' +
    chapter.articles.map(article => '<li>' + link(article.id, article.title, article.id === active) + '</li>').join('') +
    '</ul></section>').join('') + '</nav>';
}

function shell({title, description, body, page, outline = ''}) {
  const navigation = contents(page);
  return '<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="description" content="' + escape(description) + '">' +
    '<title>' + escape(title) + '</title><link rel="icon" href="flowave.png">' +
    '<link rel="stylesheet" href="manual.css"><script src="manual.js" defer></script></head>' +
    '<body><a href="#content" class="skip">跳到正文</a><header class="topbar">' +
    '<a class="brand" href="index.html"><img src="flowave.png" width="30" height="30" alt=""><span>Flowave <small>使用手册</small></span></a>' +
    '<form action="search.html" method="get" role="search"><label class="sr-only" for="search-input">搜索手册</label>' +
    '<input type="search" name="q" id="search-input" placeholder="搜索手册" required><kbd>/</kbd></form></header>' +
    '<details class="mobile-menu"><summary>章节目录</summary>' + navigation + '</details>' +
    '<div class="layout"><aside class="sidebar">' + navigation + '</aside>' +
    '<main id="content" tabindex="-1">' + body + '</main>' + outline + '</div></body></html>\n';
}

function figure(article) {
  if (!article.image) return '';
  const name = escape(article.image);
  const caption = escape(article.caption);
  const points = catalogue.figures[article.image]?.points || [];
  return '<figure><a class="figure-link" href="images/' + name + '" aria-label="查看大图">' +
    '<img src="images/' + name + '" loading="lazy" decoding="async" alt="' + caption + '"></a>' +
    '<figcaption>' + caption + '</figcaption>' +
    (points.length ? '<ol class="figure-key">' + points.map(point => '<li>' + escape(point.label) + '</li>').join('') + '</ol>' : '') +
    '</figure>';
}

function renderTable(table) {
  if (!table) return '';
  const cells = (values, tag) => values.map(value =>
    '<' + tag + (tag === 'th' ? ' scope="col"' : '') + '>' + escape(value) + '</' + tag + '>').join('');
  return '<div class="table-scroll" tabindex="0"><table><thead><tr>' + cells(table.head, 'th') +
    '</tr></thead><tbody>' + table.rows.map(row => '<tr>' + cells(row, 'td') + '</tr>').join('') +
    '</tbody></table></div>';
}

function renderArticle(article, index) {
  const toc = article.sections.map((section, i) => '<li><a href="#' + sectionUrl(i) + '">' + escape(section.title) + '</a></li>').join('');
  const sections = article.sections.map((section, i) =>
    '<section aria-labelledby="' + sectionUrl(i) + '"><h2 id="' + sectionUrl(i) + '">' + escape(section.title) + '</h2>' +
    (section.paragraphs || []).map(value => '<p>' + escape(value) + '</p>').join('') +
    (section.steps ? '<ol>' + section.steps.map(step => '<li>' + escape(step) + '</li>').join('') + '</ol>' : '') +
    renderTable(section.table) +
    (i === 0 ? figure(article) : '') +
    (section.links?.length ? '<ul class="related">' + section.links.map(item => '<li>' + link(item.id, item.label) + '</li>').join('') + '</ul>' : '') +
    '</section>').join('');
  const neighbor = (item, label, direction) => item
    ? '<a href="' + articleUrl(item.id) + '" rel="' + direction + '"><small>' + label + '</small>' + escape(item.title) + '</a>' : '<span></span>';
  const body = '<article><div class="breadcrumb"><a href="index.html">手册</a><span aria-hidden="true">/</span>' + escape(article.chapter) +
    '</div><h1>' + escape(article.title) + '</h1><p class="lead">' + escape(article.summary) + '</p>' +
    (article.entry ? '<p class="entry"><span>入口</span>' + escape(article.entry) + '</p>' : '') +
    (article.sections.length > 1 ? '<details class="inline-toc"><summary>本页目录</summary><ul>' + toc + '</ul></details>' : '') +
    sections + (article.related?.length ? '<section><h2>相关操作</h2><ul class="related">' +
    article.related.map(id => '<li>' + link(id, articleById.get(id)?.title) + '</li>').join('') + '</ul></section>' : '') +
    '<nav class="pagination" aria-label="相邻文章">' + neighbor(articles[index - 1], '上一篇', 'prev') +
    neighbor(articles[index + 1], '下一篇', 'next') + '</nav></article>';
  return shell({title: article.title + ' · Flowave 使用手册', description: article.summary, body, page: article.id,
    outline: article.sections.length > 1 ? '<aside class="outline"><nav aria-label="本页目录"><h2>本页目录</h2><ul>' + toc + '</ul></nav></aside>' : ''});
}

const common = ['add-music', 'prepare-recommendation', 'desktop-lyrics', 'song-info', 'workspace', 'troubleshooting'];
const home = '<article class="home"><h1>Flowave 使用手册</h1><p class="lead">添加音乐、调整歌词、准备歌曲推荐，或查找工作区里的数据。</p>' +
  '<h2>常用操作</h2><ul class="tasks">' + common.map(id =>
    '<li>' + link(id, articleById.get(id).title) + '<p>' + escape(articleById.get(id).summary) + '</p></li>').join('') + '</ul>' +
  '<h2>按功能浏览</h2><div class="chapter-index">' + chapters.map(chapter => '<section><h3>' + escape(chapter.title) +
    '</h3><ul>' + chapter.articles.map(article => '<li>' + link(article.id, article.title) + '</li>').join('') + '</ul></section>').join('') + '</div></article>';
const search = '<article><h1>搜索手册</h1><p id="search-status" role="status">输入功能名称或遇到的问题。</p>' +
  '<ul id="search-results" class="search-results"></ul><noscript>开启 JavaScript 后可搜索，也可以从章节目录打开文章。</noscript></article>';

fs.mkdirSync(path.join(output, 'images'), {recursive: true});
for (const name of figureNames) {
  if (!/^[a-z0-9-]+\.png$/.test(name)) throw Error('Unsupported screenshot file: ' + name);
  fs.copyFileSync(path.join(help, 'images', name), path.join(output, 'images', name));
}
for (const name of ['manual.css', 'manual.js']) {
  fs.copyFileSync(path.join(__dirname, 'web-manual', name), path.join(output, name));
}
fs.copyFileSync(path.join(renderer, 'assets/app-icon.png'), path.join(output, 'flowave.png'));
const write = (name, content) => fs.writeFileSync(path.join(output, name), content);
write('index.html', shell({title: 'Flowave 使用手册', description: 'Flowave 操作指南与常见问题。', body: home}));
write('search.html', shell({title: '搜索手册 · Flowave', description: '按关键词查找 Flowave 操作。', body: search}));
articles.forEach((article, index) => write(articleUrl(article.id), renderArticle(article, index)));
write('search.json', JSON.stringify(catalogue.chapters.flatMap(chapter => chapter.articles.map(article => ({
  ...article, keywords: articleById.get(article.id).keywords, chapter: chapter.title, url: articleUrl(article.id),
})))));
console.log('Flowave web manual: ' + articles.length + ' articles, ' + figureNames.size + ' figures.');
