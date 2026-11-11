'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

test('isolated workers preserve Unicode output before importing models', t => {
  const repo = path.resolve(__dirname, '../..');
  const python = path.join(repo, 'build/backend-venv/Scripts/python.exe');
  if (!fs.existsSync(python)) return t.skip('Pinned backend build environment is unavailable');
  const source = fs.readFileSync(path.join(repo, 'index_worker.py'), 'utf8');
  const prefix = source.slice(0, source.indexOf('import numpy as np'));
  const code = [
    'import sys,io,json,subprocess',
    "sys.stdout=io.TextIOWrapper(sys.stdout.buffer,encoding='gbk')",
    `exec(${JSON.stringify(prefix)})`,
    "print('歌曲・一匙のお姫さま物語')",
    'from pathlib import Path',
    'import resource_runtime as resources',
    'resources.runtime_python=lambda *_:Path(sys.executable)',
    "cmd=resources.worker_command(Path.cwd(),'recommendation','index_worker.py')",
    "cmd=cmd[:cmd.index('-c')]+['-c',\"print('歌曲・一匙のお姫さま物語')\"]",
    'result=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True)',
    "assert result.stdout.decode('utf-8').strip()=='歌曲・一匙のお姫さま物語'",
    "print('worker launcher UTF-8 passed')",
  ].join('\n');
  const output = execFileSync(python, ['-I', '-c', 'import sys;sys.path.insert(0,sys.argv[1]);exec(sys.argv[2])', repo, code],
    {cwd:repo, windowsHide:true, encoding:'utf8', env:{...process.env, PYTHONIOENCODING:'gbk'}});
  assert.match(output, /歌曲・一匙のお姫さま物語/);
  assert.match(output, /worker launcher UTF-8 passed/);
});
