'use strict';
const fs = require('node:fs');
const path = require('node:path');

function releaseInfo(root) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  try {
    const file = path.join(root, 'build-info.json');
    if (fs.statSync(file).size > 16384) throw Error('Invalid build information');
    const build = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (build.version !== version || !/^[0-9a-f]{40}$/.test(build.commit)) throw Error('Invalid build identity');
    return {version, commit:build.commit, builtAt:build.builtAt, channel:build.channel,
      modified:!!build.modified, development:false};
  } catch {
    return {version, commit:'', builtAt:'', development:true};
  }
}

module.exports = {releaseInfo};
