"""Explicit installation of host-pinned optional resources, with resumable I/O.

Only stdlib is imported in the resident distribution. No host pip/Python is used.
Existing versions and user library data are never overwritten or removed.
"""
from __future__ import annotations

import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import urllib.error
import zipfile

from resource_runtime import asset_path, catalog, ensure_runtime_path, managed_dir, ready, revision, worker_environment
from runtime_paths import resolve_data_dir

_last_progress = 0.0


def emit(**values):
    print(json.dumps(values, ensure_ascii=False), flush=True)


def digest(file):
    with Path(file).open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def within(root, relative):
    value = str(relative).replace('\\', '/')
    if not value or value.startswith('/') or ':' in value or '..' in value.split('/'):
        raise ValueError('资源文件路径无效。')
    target = (Path(root) / value).resolve()
    if not target.is_relative_to(Path(root).resolve()):
        raise ValueError('资源文件路径越界。')
    return target


def validate_url(url):
    p = urllib.parse.urlsplit(url)
    hosts = {'www.python.org', 'python.org', 'huggingface.co', 'files.pythonhosted.org',
             'download-r2.pytorch.org', 'download.pytorch.org', 'essentia.upf.edu', 'raw.githubusercontent.com', 'github.com', 'release-assets.githubusercontent.com',
             'cdn-lfs.huggingface.co', 'cdn-lfs-us-1.huggingface.co'}
    if p.scheme != 'https' or p.username or p.password or not (p.hostname in hosts or (p.hostname or '').endswith(('.hf.co', '.huggingface.co', '.amazonaws.com'))):
        raise ValueError('资源下载来源不受信任。')


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def request(url, headers=None):
    validate_url(url)
    return urllib.request.build_opener(SafeRedirect()).open(
        urllib.request.Request(url, headers={'User-Agent': 'Flowave-resource-installer/1', **(headers or {})}), timeout=90)


def download(item, cache, group, *, source=None):
    global _last_progress
    expected, size = item['sha256'], int(item['bytes'])
    if len(expected) != 64 or any(c not in '0123456789abcdef' for c in expected) or not 0 <= size <= 8 * 1024**3:
        raise ValueError('资源校验清单无效。')
    target = within(cache, expected)
    if target.is_file() and target.stat().st_size == size and digest(target) == expected:
        emit(phase='verified', group=group, file=Path(item['path']).name, done=size, total=size)
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_suffix('.partial')
    if source and source.is_file() and source.stat().st_size == size:
        emit(phase='verify-local', group=group, file='正在校验本地资源 ' + Path(item['path']).name, done=0, total=size)
        part.unlink(missing_ok=True)
        try:
            os.link(source, part)
        except OSError:
            shutil.copyfile(source, part)
        if digest(part) == expected:
            part.replace(target)
            emit(phase='verified-local', group=group, file='已复用本地资源 ' + Path(item['path']).name, done=size, total=size)
            return target
        part.unlink(missing_ok=True)
    if size > 32 * 1024**2:
        pieces = target.with_suffix('.parts')
        pieces.mkdir(exist_ok=True)
        block = 8 * 1024**2

        def fetch_range(start):
            end = min(size, start + block) - 1
            file = within(pieces, str(start))
            if file.is_file() and file.stat().st_size == end - start + 1:
                return file.stat().st_size
            for attempt in range(4):
                try:
                    sep = '&' if '?' in item['url'] else '?'
                    url = item['url'] + sep + f'flowave_range={start}&nonce={time.time_ns()}'
                    with request(url, {'Range': f'bytes={start}-{end}'}) as response:
                        if response.status != 206 or response.headers.get('Content-Range') != f'bytes {start}-{end}/{size}':
                            raise ValueError('下载服务器没有返回完整的分段。')
                        data = response.read(end - start + 2)
                    if len(data) != end - start + 1:
                        raise ValueError('资源下载尚未完整。')
                    temp = file.with_suffix('.partial')
                    temp.write_bytes(data)
                    temp.replace(file)
                    return len(data)
                except Exception:
                    if attempt == 3:
                        raise
                    time.sleep(min(3, attempt + 1))
        done = sum(within(pieces,str(start)).stat().st_size for start in range(0,size,block)
                   if within(pieces,str(start)).is_file() and within(pieces,str(start)).stat().st_size==min(block,size-start))
        emit(phase='download', group=group, file=Path(item['path']).name, done=done, total=size)
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            futures = [pool.submit(fetch_range, start) for start in range(0, size, block)
                       if not within(pieces,str(start)).is_file() or within(pieces,str(start)).stat().st_size!=min(block,size-start)]
            for future in concurrent.futures.as_completed(futures):
                done += future.result()
                if time.monotonic() - _last_progress > .4 or done == size:
                    emit(phase='download', group=group, file=Path(item['path']).name, done=done, total=size)
                    _last_progress = time.monotonic()
        with part.open('wb') as output:
            for start in range(0, size, block):
                with within(pieces, str(start)).open('rb') as source:
                    shutil.copyfileobj(source, output, 1024**2)
    else:
        for attempt in range(4):
            try:
                with request(item['url']) as response, part.open('wb') as output:
                    done = 0
                    while data := response.read(1024**2):
                        done += len(data)
                        if done > size:
                            raise ValueError('资源下载超过预期大小。')
                        output.write(data)
                        if time.monotonic() - _last_progress > .4:
                            emit(phase='download', group=group, file=Path(item['path']).name, done=done, total=size)
                            _last_progress = time.monotonic()
                if part.stat().st_size != size or digest(part) != expected:
                    raise ValueError(f"资源校验失败：{Path(item['path']).name}。请重试。")
                break
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(attempt + 1)
    emit(phase='verify', group=group, file=Path(item['path']).name, done=size, total=size)
    if part.stat().st_size != size or digest(part) != expected:
        if size > 32 * 1024**2:
            for start in range(0, size, block):
                within(pieces, str(start)).unlink(missing_ok=True)
        raise ValueError('资源校验失败，原有版本保留。重新点击可重试。')
    part.replace(target)
    if size > 32 * 1024**2:
        for start in range(0,size,block):within(pieces,str(start)).unlink(missing_ok=True)
        try:pieces.rmdir()
        except OSError:pass  # Preserve any unknown files.
    return target


def unpack(archive, target):
    with zipfile.ZipFile(archive) as z:
        rows = z.infolist()
        if sum(x.file_size for x in rows) > 512 * 1024**2 or len(rows) > 15000:
            raise ValueError('资源归档超过解包限制。')
        for row in rows:
            if row.is_dir():
                continue
            if stat.S_ISLNK(row.external_attr >> 16):
                raise ValueError('资源归档包含链接。')
            out = within(target, row.filename)
            out.parent.mkdir(parents=True, exist_ok=True)
            with z.open(row) as source, out.open('wb') as dest:
                shutil.copyfileobj(source, dest, 1024**2)


def stamp(directory, item, extra=None):
    data = {'revision': revision(item), 'finished': time.time(), **(extra or {})}
    file = directory / '.ready.json'
    temp = file.with_suffix('.partial')
    with temp.open('w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    temp.replace(file)


def install_group(root, name, item, cache):
    final = managed_dir(root, 'assets', name, item)
    if ready(final, item):
        emit(phase='ready', group=name)
        return
    work = final.with_name(final.name + '.preparing')
    tree = work / 'tree'
    tree.mkdir(parents=True, exist_ok=True)
    for index, row in enumerate(item['files']):
        emit(phase='prepare', group=name, file=Path(row['path']).name, item=index + 1, count=len(item['files']))
        file = download(row, cache, name, source=asset_path(root, row['path']))
        out = within(tree, row['path'])
        out.parent.mkdir(parents=True, exist_ok=True)
        if row.get('replacements'):
            text = file.read_text(encoding='utf-8')
            for old, new in row['replacements']:
                if old not in text:
                    raise ValueError('上游源码与已审核适配不一致。')
                text = text.replace(old, new)
            out.write_text(text, encoding='utf-8', newline='\n')
            if digest(out) != row['output_sha256']:
                raise ValueError('资源适配结果校验失败。')
        else:
            if not out.is_file() or out.stat().st_size != row['bytes'] or digest(out) != row['sha256']:
                out.unlink(missing_ok=True)
                # Immutable verified downloads can share storage. Removing the
                # cache entry later does not remove the published asset.
                try:os.link(file,out)
                except OSError:shutil.copyfile(file,out)
        if row.get('extract_to'):
            unpack(file, within(tree, row['extract_to']))
        if row.get('extract_member_suffix'):
            with zipfile.ZipFile(file) as z:
                members = [n for n in z.namelist() if n.endswith(row['extract_member_suffix'])]
                if len(members) != 1:
                    raise ValueError('音频编码归档不完整。')
                dest = within(tree, row['extract_target'])
                dest.parent.mkdir(parents=True, exist_ok=True)
                with z.open(members[0]) as source, dest.open('wb') as output:
                    shutil.copyfileobj(source, output)
                if digest(dest) != row['output_sha256']:
                    raise ValueError('音频编码组件校验失败。')
        if row.get('extract_files'):
            with zipfile.ZipFile(file) as z:
                for entry in row['extract_files']:
                    dest = within(tree, entry['path'])
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    with z.open(entry['member']) as source, dest.open('wb') as output:
                        shutil.copyfileobj(source, output)
                    if dest.stat().st_size != entry['bytes'] or digest(dest) != entry['sha256']:
                        raise ValueError('演奏模型解包校验失败。')
    for path, entry in item.get('metadata', {}).items():
        source = within(root, entry['file'])
        if digest(source) != entry['sha256']:
            raise ValueError('随软件提供的资源清单已变化。')
        dest = within(tree, path)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, dest)
    if final.exists():
        raise ValueError('资源目标存在未核验内容，已保留，请检查资源目录。')
    stamp(work, item)
    work.replace(final)
    emit(phase='ready', group=name)


def bind_downloaded_wheels(lock, wheels, wheel_cache, output):
    """Bind bootstrap wheels to verified local bytes; keep every pinned hash."""
    text = lock.read_text(encoding='utf-8')
    for wheel in wheels:
        package, version = Path(wheel['path']).name.split('-')[:2]
        package = re.sub(r'[-_.]+', '-', package).lower()
        pattern = re.compile(r'(?m)^' + re.escape(package + '==' + version) + r'(?=\s|$)')
        matches = list(pattern.finditer(text))
        if not matches and wheel.get('optional'):
            continue
        if len(matches) != 1:
            raise ValueError('已下载依赖与锁文件不匹配。')
        start = matches[0].start()
        end = re.search(r'\n(?=\S)', text[matches[0].end():])
        block = text[start:matches[0].end() + end.start() if end else len(text)]
        if '--hash=sha256:' + wheel['sha256'] not in block:
            raise ValueError('锁文件未包含已下载依赖的校验值。')
        file = Path(wheel['local_path']) if wheel.get('local_path') else within(wheel_cache, wheel['path'])
        uri = file.resolve().as_uri()
        text = pattern.sub(lambda _: package + ' @ ' + uri, text, count=1)
    # CUDA packages are now direct, hash-checked files. A global CUDA index
    # would also query that server for ordinary packages such as cloudpickle.
    text = re.sub(r'(?m)^--(?:extra-)?index-url\s+\S+\s*\n', '', text)
    if re.search(r'(?m)^[\w.-]+==[^\s]+\+cu\d+', text):
        raise ValueError('CUDA依赖尚未绑定到已校验文件，请更新资源安装器。')
    output.write_text(text, encoding='utf-8', newline='\n')
    return output


def install_profile(root, name, item, cache):
    final = managed_dir(root, 'runtimes', name, item)
    if ready(final, item):
        emit(phase='ready', group=name)
        return
    work = final.with_name(final.name + '.preparing')
    ensure_runtime_path(work)
    work.mkdir(parents=True, exist_ok=True)
    python_archive = download(item['python'], cache, name)
    python = work / 'python'
    unpack(python_archive, python)
    (python / 'python313._pth').write_text('python313.zip\n.\nLib/site-packages\nimport site\n', encoding='utf-8')
    uv_archive = download(item['uv'], cache, name)
    uv = work / 'uv.exe'
    with zipfile.ZipFile(uv_archive) as z:
        member = next(n for n in z.namelist() if n.endswith('/uv.exe'))
        with z.open(member) as source, uv.open('wb') as output:
            shutil.copyfileobj(source, output)
    lock = within(root, item['lock'])
    if digest(lock) != item['lock_sha256']:
        raise ValueError('计算环境锁文件校验失败。')
    wheel_cache=cache/'wheels';wheel_cache.mkdir(exist_ok=True)
    wheels = list(item.get('bootstrap_wheels', []))
    lock_text = lock.read_text(encoding='utf-8')
    for wheel in catalog(root).get('runtime_wheels', []):
        package, version = Path(wheel['path']).name.split('-')[:2]
        if re.search(r'(?m)^' + re.escape(package + '==' + version) + r'(?=\s|$)', lock_text):
            wheels.append(wheel)
    from resource_plan import install_plan
    plan = install_plan(root)
    if plan['profiles'][name]['lock_sha256'] != item['lock_sha256']:
        raise ValueError('计算环境安装计划与锁文件不一致。')
    wheels.extend(plan['profiles'][name]['wheels'])
    for wheel in wheels:
        file=download(wheel,cache,name);dest=within(wheel_cache,wheel['path'])
        if not dest.exists():
            try:os.link(file,dest)
            except OSError:shutil.copyfile(file,dest)
    for wheel in item.get('bundled_wheels',[]):
        if digest(within(root,wheel['file']))!=wheel['sha256']:raise ValueError('随附计算依赖校验失败。')
        wheels.append({**wheel, 'path':Path(wheel['file']).name,
                       'local_path':str(within(root,wheel['file'])), 'optional':True})
    # Index resolution can prefer a remote wheel over --find-links. Direct local
    # references prevent downloading the same multi-GB engine a second time.
    local_lock = bind_downloaded_wheels(lock, wheels, wheel_cache, work / 'requirements-local.txt')
    emit(phase='install', group=name, file='正在安装已校验计算依赖')
    env = {**worker_environment(root), 'UV_CACHE_DIR': str(cache / 'uv-cache'), 'UV_LINK_MODE': 'hardlink',
           'UV_NATIVE_TLS': 'true', 'UV_PYTHON_DOWNLOADS': 'never', 'PYTHONIOENCODING': 'utf-8',
           'PYTHONNOUSERSITE': '1', 'PYTHONPATH': ''}
    for key in ('UV_INDEX', 'UV_INDEX_URL', 'UV_EXTRA_INDEX_URL', 'UV_DEFAULT_INDEX', 'UV_TORCH_BACKEND',
                'UV_CONFIG_FILE', 'PIP_INDEX_URL', 'PIP_EXTRA_INDEX_URL'):
        env.pop(key, None)
    cmd = [str(uv), 'pip', 'install', '--python', str(python / 'python.exe'), '--target',
           str(python / 'Lib/site-packages'), '--reinstall', '--no-config', '--default-index', 'https://pypi.org/simple',
           '--find-links',str(wheel_cache),'--find-links',str(root/'resources/wheels'),'--require-hashes',
           '--index-strategy','first-index', '--only-binary', ':all:', '-r', str(local_lock)]
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace', env=env, creationflags=flags)
    lines = []
    for line in proc.stdout:
        lines.append(line.rstrip())
        if len(lines) > 30:
            lines.pop(0)
        emit(phase='install', group=name, file=line.strip()[:220])
    if proc.wait() != 0:
        raise RuntimeError('计算依赖安装失败：' + '\n'.join(lines[-10:]))
    local_lock.unlink()
    # Probe before publication. It runs in the embedded, isolated interpreter.
    emit(phase='probe',group=name,file='正在检查运行环境…')
    probe = ';'.join('import ' + module for module in item['probe'])
    probe += ';import json;assert torch.cuda.is_available(),"需要可用的NVIDIA显卡驱动";print(json.dumps({"python":list(__import__("sys").version_info[:3]),"torch":torch.__version__,"cuda":torch.version.cuda,"transformers":transformers.__version__}))'
    result = subprocess.run([str(python / 'python.exe'), '-I', '-c', probe], capture_output=True, text=True, encoding='utf-8', errors='replace', env=env, creationflags=flags, timeout=120)
    if result.returncode:
        raise RuntimeError('计算环境检查未通过：' + result.stderr[-1600:])
    stamp(work, item, {'probe': json.loads(result.stdout.strip().splitlines()[-1])})
    if final.exists():
        raise ValueError('计算环境目标已有未知内容，已保留。')
    work.replace(final)
    emit(phase='ready', group=name)


def install(root, module):
    root = Path(root).resolve()
    data = catalog(root)
    if module not in data.get('modules', {}):
        raise ValueError('未知的功能资源。')
    from resource_plan import preflight
    emit(phase='preflight', module=module, file='正在检查显卡、驱动和工作区空间')
    budget = preflight(root, module)
    emit(phase='preflight-ready', module=module, **budget)
    cache = resolve_data_dir(root) / 'cache/resource-downloads'
    cache.mkdir(parents=True, exist_ok=True)
    import msvcrt
    with (cache / 'install.lock').open('a+b') as lock:
        lock.seek(0)
        if lock.read(1) == b'':
            lock.write(b'0')
            lock.flush()
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as exc:
            raise ValueError('已有资源准备任务正在进行。') from exc
        try:
            item = data['modules'][module]
            for name in item.get('profiles', []):
                install_profile(root, name, data['profiles'][name], cache)
            for name in item.get('groups', []):
                install_group(root, name, data['groups'][name], cache)
            if module in ('recommendation', 'analysis'):
                from music_analysis_store import AnalysisStore
                store = AnalysisStore(resolve_data_dir(root) / 'library/track-analysis/results.sqlite3')
                store.preserve_recipe_compatibility(root)
        finally:
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
    emit(phase='complete', module=module)


def main(root, module):
    for attempt in range(3):
        try:
            install(root, module)
            return 0
        except Exception as exc:
            transient = isinstance(exc, (urllib.error.URLError, TimeoutError, ConnectionError))
            if isinstance(exc, urllib.error.HTTPError):
                transient = exc.code in (408, 429) or exc.code >= 500
            if transient and attempt < 2:
                emit(phase='retry', module=module, file='连接中断，正在继续下载…')
                time.sleep(2 * (attempt + 1))
                continue
            emit(phase='error', module=module, message=str(exc)[:2400])
            return 1


if __name__ == '__main__':
    raise SystemExit(main(os.environ.get('KUMIKO_APP_HOME') or Path(__file__).resolve().parent, sys.argv[1]))
