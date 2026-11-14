// Inspect the actual archive and every host-pinned local resource input.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'resources/catalog.json'), 'utf8'));
const moduleCatalog = JSON.parse(fs.readFileSync(path.join(root, 'electron-lxplayer/official-modules/catalog.json'), 'utf8'));
const definitions = require('../electron-lxplayer/official-module-definitions');
const { decode } = require('../electron-lxplayer/official-package-store');
const currentBundles = [];
const {readInstallPlan, modulePlan} = require('../electron-lxplayer/resource-plan');
const installationPlan = readInstallPlan(root, catalog);
for (const id of Object.keys(catalog.modules)) modulePlan(catalog, installationPlan, id, () => false);
for (const [id, profile] of Object.entries(installationPlan.profiles)) {
  const lock = fs.readFileSync(path.join(root, catalog.profiles[id].lock), 'utf8');
  for (const wheel of profile.wheels)
    if (!lock.includes('--hash=sha256:' + wheel.sha256)) throw Error('Unpinned planned wheel: ' + wheel.path);
}
for (const [id, definition] of Object.entries(definitions)) {
  const item = moduleCatalog.packages[id], release = item.releases.find(row => row.version === item.latest);
  const relative = 'official-modules/packages/' + release.bundle;
  const bytes = fs.readFileSync(path.join(root, 'electron-lxplayer', relative));
  const pack = decode(bytes, moduleCatalog);
  const source = id === 'history' ? path.join(root, 'electron-lxplayer/official-modules/history') : path.join(root, 'electron-lxplayer/renderer');
  for (const name of [...definition.files, ...definition.optionalFiles || []]) {
    const expected = fs.readFileSync(path.join(source, name), 'utf8').replace(/\r\n?/g, '\n').replace(/\n*$/, '\n');
    if (pack.files[name]?.toString('utf8') !== expected)
      throw Error('Official module contains stale source: ' + id + '/' + name + '; increment its version and rebuild it');
  }
  currentBundles.push({ relative, bytes });
}
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
  for (const bundle of currentBundles) {
    if (!asar.extractFile(archive, path.normalize(bundle.relative)).equals(bundle.bytes))
      throw Error('Packaged official module differs from verified source: ' + bundle.relative);
  }
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'electron-lxplayer/package-lock.json'), 'utf8'));
  for (const [relative, item] of Object.entries(lock.packages)) {
    if (!relative || item.dev || (item.os && !item.os.includes('win32')) || (item.cpu && !item.cpu.includes('x64'))) continue;
    const manifest = relative + '/package.json';
    if (!names.has(manifest)) throw Error('Missing production dependency in ASAR: ' + relative);
    const installed = JSON.parse(asar.extractFile(archive, path.normalize(manifest)).toString('utf8'));
    if (installed.version !== item.version) throw Error('Packaged dependency version differs from lock: ' + relative);
  }
  const entry = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8')).main;
  if (typeof entry !== 'string' || !names.has(entry)) throw Error('Missing Electron entry point: ' + entry);
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
