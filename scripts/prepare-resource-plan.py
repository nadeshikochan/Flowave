"""Resolve pinned Windows wheels and ZIP expansion sizes for offline installation planning."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import hashlib
import io
import json
import re
import sys
import time
import urllib.request
import zipfile

from packaging.tags import cpython_tags, compatible_tags
from packaging.utils import canonicalize_name, parse_wheel_filename

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / 'build/resource-plan-metadata'


def request(url, headers=None):
    return urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=60)


class RemoteArchive(io.RawIOBase):
    def __init__(self, row):
        self.row = row
        self.position = 0

    def seek(self, offset, whence=0):
        self.position = offset + (self.position if whence == 1 else self.row['bytes'] if whence == 2 else 0)
        return self.position

    def tell(self):
        return self.position

    def read(self, size=-1):
        end = self.row['bytes'] if size < 0 else min(self.row['bytes'], self.position + size)
        if end <= self.position:
            return b''
        start = self.position
        separator = '&' if '?' in self.row['url'] else '?'
        url = self.row['url'] + separator + 'flowave_metadata=' + str(time.time_ns())
        with request(url, {'Range':f'bytes={start}-{end - 1}'}) as response:
            if response.status != 206 or response.headers.get('Content-Range') != f'bytes {start}-{end - 1}/{self.row["bytes"]}':
                raise ValueError('Archive metadata range mismatch')
            raw = response.read(end - start)
        if len(raw) != end - start:
            raise ValueError('Incomplete archive metadata')
        self.position = end
        return raw


def archive_size(row):
    file = CACHE / (row['sha256'] + '.size.json')
    if file.is_file():
        return json.loads(file.read_text())['expandedBytes']
    print('Reading archive size', row['path'], flush=True)
    candidates = [Path(folder) / row['sha256'] for folder in sys.argv[1:]]
    local = next((file for file in candidates if file.is_file() and file.stat().st_size == row['bytes']), None)
    if local:
        with local.open('rb') as handle:
            if hashlib.file_digest(handle, 'sha256').hexdigest() != row['sha256']:
                raise ValueError('Cached archive hash mismatch')
    with zipfile.ZipFile(local or RemoteArchive(row)) as archive:
        size = sum(entry.file_size for entry in archive.infolist())
    file.write_text(json.dumps({'expandedBytes':size}), encoding='utf-8')
    return size


def wheels_for(profile, known):
    lock = (ROOT / profile['lock']).read_text(encoding='utf-8')
    supported = list(cpython_tags((3, 13), ['cp313'], ['win_amd64']))
    supported += list(compatible_tags((3, 13), 'cp313', ['win_amd64']))
    rank = {tag:index for index, tag in enumerate(supported)}
    rows = []
    blocks = re.split(r'\n(?=\S)', lock)
    for block in blocks:
        match = re.match(r'([\w-]+)==([^\s\\]+)', block)
        if not match:
            continue
        name, version = match.groups()
        if canonicalize_name(name) in known:
            continue
        metadata = CACHE / (name + '-' + version + '.json')
        if not metadata.is_file():
            with request(f'https://pypi.org/pypi/{name}/{version}/json') as response:
                metadata.write_bytes(response.read())
        release = json.loads(metadata.read_text(encoding='utf-8'))
        hashes = set(re.findall(r'--hash=sha256:([0-9a-f]{64})', block))
        choices = []
        for row in release['urls']:
            if not row['filename'].endswith('.whl') or row['yanked'] or row['digests']['sha256'] not in hashes:
                continue
            tags = parse_wheel_filename(row['filename'])[3]
            positions = [rank[tag] for tag in tags if tag in rank]
            if positions:
                choices.append((min(positions), row))
        if not choices:
            raise ValueError('No pinned Windows wheel for ' + name + '==' + version)
        row = min(choices, key=lambda item:item[0])[1]
        rows.append({'path':row['filename'], 'url':row['url'], 'bytes':row['size'], 'sha256':row['digests']['sha256']})
    return rows


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    catalog_file = ROOT / 'resources/catalog.json'
    catalog = json.loads(catalog_file.read_text(encoding='utf-8'))
    plan = {'schema':1, 'platform':'win_amd64', 'python':'3.13', 'profiles':{}, 'archives':{}}
    archives = {}
    for name, profile in catalog['profiles'].items():
        lock = (ROOT / profile['lock']).read_text(encoding='utf-8')
        supplied = list(profile.get('bootstrap_wheels', []))
        supplied += [row for row in catalog.get('runtime_wheels', [])
                     if re.search(r'(?m)^' + re.escape('-'.join(Path(row['path']).name.split('-')[:2]).replace('-', '==', 1)) + r'(?=\s|$)', lock)]
        bundled = [Path(row['file']).name for row in profile.get('bundled_wheels', [])]
        known = {canonicalize_name(Path(row['path']).name.split('-')[0]) for row in supplied}
        known.update(canonicalize_name(name.split('-')[0]) for name in bundled)
        wheels = wheels_for(profile, known)
        plan['profiles'][name] = {'lock_sha256':profile['lock_sha256'], 'wheels':wheels,
                                  'files':[profile['python'], profile['uv'], *supplied, *wheels],
                                  'bundled':profile.get('bundled_wheels', [])}
        for row in [profile['python'], profile['uv'], *supplied, *wheels]:
            archives[row['sha256']] = row
        for row in profile.get('bundled_wheels', []):
            with zipfile.ZipFile(ROOT / row['file']) as archive:
                plan['archives'][row['sha256']] = sum(entry.file_size for entry in archive.infolist())
    for group in catalog['groups'].values():
        for row in group['files']:
            if row.get('extract_to') or row.get('extract_member_suffix'):
                archives[row['sha256']] = row
    with ThreadPoolExecutor(max_workers=4) as pool:
        sizes = list(pool.map(archive_size, archives.values()))
    plan['archives'].update(zip(archives, sizes))
    for profile in plan['profiles'].values():
        profile['expandedBytes'] = sum(plan['archives'][row['sha256']] for row in profile['files'])
        profile['expandedBytes'] += sum(plan['archives'][row['sha256']] for row in profile.pop('bundled'))
    output = ROOT / 'resources/install-plan.json'
    raw = (json.dumps(plan, ensure_ascii=False, indent=2) + '\n').encode()
    output.write_bytes(raw)
    catalog['installation_plan'] = {'file':'resources/install-plan.json', 'sha256':hashlib.sha256(raw).hexdigest()}
    catalog_file.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    print('Prepared pinned install plan for', len(plan['profiles']), 'runtimes and', len(archives), 'archives')


if __name__ == '__main__':
    main()
