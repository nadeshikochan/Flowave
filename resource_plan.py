"""Pinned download/space planning and CUDA driver preflight without neural imports."""
from pathlib import Path
import ctypes
import hashlib
import json
import os
import shutil
import tempfile

from resource_runtime import catalog, managed_dir, ready
from runtime_paths import resolve_data_dir


def install_plan(root, data=None):
    data = data or catalog(root)
    item = data.get('installation_plan')
    if not item:
        return {'profiles':{}, 'archives':{}}
    raw = (Path(root) / item['file']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('安装资源预算清单校验失败，请更新软件。')
    return json.loads(raw)


def runtime_files(root, name, data=None, plan=None):
    data = data or catalog(root)
    plan = plan or install_plan(root, data)
    profile = data['profiles'][name]
    row = plan['profiles'].get(name)
    if not row or row['lock_sha256'] != profile['lock_sha256']:
        raise ValueError('计算环境的安装清单不完整，请更新软件。')
    return row['files']


def module_plan(root, module, data=None, *, hardlinks=False):
    data = data or catalog(root)
    item = data['modules'][module]
    plan = install_plan(root, data)
    files = {}
    entries = []
    expanded = 0
    for name in item['profiles']:
        profile = data['profiles'][name]
        installed = ready(managed_dir(root, 'runtimes', name, profile), profile)
        rows = runtime_files(root, name, data, plan)
        entries.append({'id':name, 'name':profile['name'], 'ready':installed,
                        'bytes':sum(row['bytes'] for row in rows)})
        if not installed:
            files.update((row['sha256'], row) for row in rows)
            expanded += plan['profiles'][name]['expandedBytes'] * (1 if hardlinks else 2)
    for name in item['groups']:
        group = data['groups'][name]
        installed = ready(managed_dir(root, 'assets', name, group), group)
        entries.append({'id':name, 'name':group['name'], 'ready':installed,
                        'bytes':sum(row['bytes'] for row in group['files'])})
        if not installed:
            files.update((row['sha256'], row) for row in group['files'])
            for row in group['files']:
                if row.get('extract_files'):
                    expanded += sum(file['bytes'] for file in row['extract_files'])
                elif row.get('extract_to') or row.get('extract_member_suffix'):
                    expanded += plan['archives'][row['sha256']]
                elif not hardlinks:
                    expanded += row['bytes']
    download = sum(row['bytes'] for row in files.values())
    largest = max((row['bytes'] for row in files.values()), default=0)
    return {'ready':all(row['ready'] for row in entries), 'items':entries,
            'license':item.get('license', ''), 'downloadBytes':download,
            'spaceBudgetBytes':download + expanded + largest,
            'expandedBytes':expanded, 'largestFileBytes':largest}


def gpu_devices():
    """Use NVIDIA's installed CUDA Driver API before downloading a runtime."""
    if os.name != 'nt':
        raise ValueError('当前计算资源面向 Windows x64。')
    try:
        driver = ctypes.WinDLL('nvcuda.dll')
    except OSError as error:
        raise ValueError('未发现 NVIDIA CUDA 驱动。基础播放可使用，请安装受支持显卡的官方驱动后再安装此计算功能。') from error
    if driver.cuInit(0) != 0:
        raise ValueError('NVIDIA CUDA 驱动未就绪，请更新驱动或重启电脑后重试。')
    version = ctypes.c_int()
    driver.cuDriverGetVersion(ctypes.byref(version))
    if version.value < 12000:
        raise ValueError('当前驱动不支持 CUDA 12 系列，请更新 NVIDIA 驱动后重试。')
    count = ctypes.c_int()
    if driver.cuDeviceGetCount(ctypes.byref(count)) != 0 or count.value < 1:
        raise ValueError('未发现可用的 NVIDIA CUDA 显卡。')
    devices = []
    for index in range(count.value):
        name = ctypes.create_string_buffer(256)
        major, minor = ctypes.c_int(), ctypes.c_int()
        total = ctypes.c_size_t()
        if driver.cuDeviceGetName(name, len(name), index) != 0:
            continue
        driver.cuDeviceGetAttribute(ctypes.byref(major), 75, index)
        driver.cuDeviceGetAttribute(ctypes.byref(minor), 76, index)
        driver.cuDeviceTotalMem_v2(ctypes.byref(total), index)
        devices.append({'name':name.value.decode('utf-8', errors='replace'),
                        'computeMajor':major.value, 'computeMinor':minor.value,
                        'memoryBytes':total.value, 'driverCudaVersion':version.value})
    if not devices:
        raise ValueError('无法读取 NVIDIA 显卡信息，请检查驱动。')
    return devices


def preflight(root, module, *, devices=None, disk_usage=shutil.disk_usage):
    result = module_plan(root, module)
    if result['ready']:
        return result
    devices = gpu_devices() if devices is None else devices
    eligible = devices[:1]
    if not eligible or eligible[0]['computeMajor'] < 5:
        raise ValueError('默认 CUDA 显卡不支持当前计算环境，请检查 NVIDIA 驱动与显卡兼容性。')
    if module == 'analysis':
        if eligible[0]['computeMajor'] < 8 or eligible[0]['memoryBytes'] < 2000 * 1024**2:
            raise ValueError('歌曲段落分析需要支持 BF16 的 NVIDIA 显卡和至少 2000 MiB 显存。推荐功能可以独立安装。')
    elif module == 'practice':
        if eligible[0]['memoryBytes'] < 3800 * 1024**2:
            raise ValueError('完整演奏分析需要至少 3800 MiB 显存，基础播放与已有成果可继续使用。')
    target = resolve_data_dir(root)
    existing = target
    while not existing.exists():
        existing = existing.parent
    with tempfile.TemporaryDirectory(prefix='.flowave-space-', dir=existing) as temporary:
        first, second = Path(temporary) / 'source', Path(temporary) / 'linked'
        first.write_bytes(b'1')
        try:
            os.link(first, second)
            hardlinks = True
        except OSError:
            hardlinks = False
    result = module_plan(root, module, hardlinks=hardlinks)
    available = disk_usage(existing).free
    result.update(devices=eligible, availableBytes=available)
    if available < result['spaceBudgetBytes']:
        budget = result['spaceBudgetBytes'] / 1024**3
        free = available / 1024**3
        raise ValueError(f'工作区所在磁盘可用 {free:.2f} GiB，本次下载、解压和暂存预算为 {budget:.2f} GiB。请释放空间或切换到空间充足的工作区。')
    return result
