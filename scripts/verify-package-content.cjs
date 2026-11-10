// Inspect the actual archive and every host-pinned local resource input.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'resources/catalog.json'), 'utf8'));
const check = (file, expected) => {
  const full = path.resolve(root, file);
  if (!full.startsWith(root + path.sep) || sha(fs.readFileSync(full)) !== expected) throw Error('Resource input mismatch: ' + file);
};
for (const profile of Object.values(catalog.profiles)) {
  check(profile.lock, profile.lock_sha256);
  for (const wheel of profile.bundled_wheels || []) check(wheel.file, wheel.sha256);
}
for (const group of Object.values(catalog.groups)) for (const item of Object.values(group.metadata || {})) check(item.file, item.sha256);
for (const [id, module] of Object.entries(catalog.modules)) {
  for (const key of module.groups) if (!catalog.groups[key]) throw Error('Missing group for ' + id);
  for (const key of module.profiles) if (!catalog.profiles[key]) throw Error('Missing runtime for ' + id);
}
const archive = process.argv[2];
if (archive) {
  const asar = require(require.resolve('@electron/asar', {paths: [path.join(root, 'electron-lxplayer')]}));
  const names = new Set(asar.listPackage(archive).map(file => file.replaceAll('\\', '/').replace(/^\//, '')));
  for (const name of names) {
    if (!name.endsWith('.js') || name.startsWith('node_modules/') || name.startsWith('renderer/')) continue;
    const source = asar.extractFile(archive, name).toString('utf8');
    for (const match of source.matchAll(/\brequire\(\s*(['"])(\.[^'"]+)\1\s*\)/g)) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(name), match[2]));
      if (![base, base + '.js', base + '.json', base + '/index.js'].some(file => names.has(file)))
        throw Error('Missing packaged dependency: ' + name + ' -> ' + match[2]);
    }
  }
  for (const name of ['main.js', 'preload.js', 'trace-archive.js', 'resource-manager.js'])
    if (!names.has(name)) throw Error('Missing required host file: ' + name);
}
console.log('Pinned resource inputs and packaged host dependencies verified.');
