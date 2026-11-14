// Build the offline search catalogue from the same structured chapters rendered by Vue.
const fs = require('node:fs');
const path = require('node:path');
const directory = path.resolve(__dirname, '../electron-lxplayer/renderer/help');
const order = ['start', 'library', 'recommendation', 'lyrics', 'analysis', 'practice', 'workspace', 'reference'];
const chapters = order.map(id => JSON.parse(fs.readFileSync(path.join(directory, id + '.json'), 'utf8')));
const figures = JSON.parse(fs.readFileSync(path.join(directory, 'figures.json'), 'utf8'));
const text = value => typeof value === 'string' ? value : Array.isArray(value)
  ? value.map(text).join(' ') : value && typeof value === 'object' ? Object.values(value).map(text).join(' ') : '';
const ids = new Set();
for (const chapter of chapters) for (const article of chapter.articles) {
  if (article.image && !figures[article.image]) throw Error('Unknown figure ' + article.image);
  if (ids.has(article.id)) throw Error('Duplicate article ' + article.id);
  ids.add(article.id);
}
for (const chapter of chapters) for (const article of chapter.articles) {
  const links = [...(article.related || []), ...article.sections.flatMap(section => (section.links || []).map(link => link.id))];
  for (const id of links) if (!ids.has(id)) throw Error(`Unknown article ${id} in ${article.id}`);
}
const catalogue = {
  schema: 1,
  figures: Object.fromEntries(Object.entries(figures).map(([name, figure]) => [name, {points:figure.points.map(({label})=>({label}))}])),
  chapters: chapters.map(({id, title, articles}) => ({id, title,
    articles: articles.map(article => ({id: article.id, title: article.title, summary: article.summary,
      search: text([article.keywords, article.sections])})),
  })),
};
const output = JSON.stringify(catalogue, null, 2) + '\n';
const target = path.join(directory, 'catalog.json');
if (process.argv.includes('--check')) {
  if (fs.readFileSync(target, 'utf8') !== output) throw Error('User help catalogue needs rebuilding');
} else fs.writeFileSync(target, output);
console.log(`User help catalogue: ${chapters.length} chapters, ${ids.size} articles`);
