"""Small real-model delivery check using official services and an isolated store."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--audio', type=Path, required=True)
    parser.add_argument('--start', type=float, default=45)
    parser.add_argument('--seconds', type=float, default=24)
    parser.add_argument('--stage', choices=('tags', 'structure', 'practice', 'consumers', 'all'), default='all')
    parser.add_argument('--resources', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    data = (args.output or root / 'build/model-validation').resolve()
    assert data.is_relative_to(root / 'build'), 'Output must stay in the isolated build directory'
    resources = (args.resources or root / 'data/components/resources').resolve()
    assert args.audio.is_file() and 5 <= args.seconds <= 40
    assert resources.is_dir(), 'Install the pinned delivery resources first'
    data.mkdir(parents=True, exist_ok=True)
    link = data / 'components/resources'
    link.parent.mkdir(exist_ok=True)
    if not link.exists():
        subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
                        'New-Item -ItemType Junction -Path $env:FLOWAVE_CHECK_LINK -Target $env:FLOWAVE_CHECK_RESOURCES | Out-Null'],
                       env={**os.environ, 'FLOWAVE_CHECK_LINK':str(link), 'FLOWAVE_CHECK_RESOURCES':str(resources)},
                       creationflags=subprocess.CREATE_NO_WINDOW, check=True)
    assert link.resolve() == resources.resolve(), 'Unexpected shared resource location'
    os.environ.update(KUMIKO_APP_HOME=str(root), KUMIKO_DATA_DIR=str(data), PYTHONIOENCODING='utf-8')
    sys.path.insert(0, str(root))
    from music_analysis_service import MusicAnalysisService
    from music_analysis_store import source_version
    from practice_analysis import PracticeAnalysisStore, validate
    from practice_service import PracticeService
    from resource_runtime import asset_path
    from stem_service import StemService

    row = {'id':'delivery-vocal-sample', 'path':str(data / 'vocal-sample.wav')}
    sample_file = data / 'sample.json'
    sample = {'audio':str(args.audio.resolve()), 'start':args.start, 'seconds':args.seconds}
    if sample_file.exists():
        assert json.loads(sample_file.read_text(encoding='utf-8')) == sample, 'Use a new output folder for a different sample'
    rows = [row]
    snapshot = lambda rid=None: [item for item in rows if rid is None or item['id'] == rid]
    stems = StemService(root, data, snapshot)
    folder, manifest, _ = stems.assets()
    encoder = folder / manifest['encoder']['name']
    if not Path(row['path']).exists():
        subprocess.run([str(encoder), '-nostdin', '-v', 'error', '-ss', str(args.start), '-i', str(args.audio),
                        '-t', str(args.seconds), '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', row['path']],
                       creationflags=subprocess.CREATE_NO_WINDOW, check=True)
    sample_file.write_text(json.dumps(sample, ensure_ascii=False), encoding='utf-8')
    row['source'] = source_version(row['path'])
    analysis = MusicAnalysisService(root, data, snapshot)
    store = PracticeAnalysisStore(data / 'library/practice-analysis')
    practice = PracticeService(root, data, snapshot, stems, store)
    report_path = data / 'report.json'
    report = json.loads(report_path.read_text(encoding='utf-8')) if report_path.exists() else {}

    def save():
        temporary = report_path.with_suffix('.tmp')
        temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
        temporary.replace(report_path)

    def run(stage, service, start, verify):
        began = time.monotonic()
        report[stage] = {'status':'running'}
        save()
        try:
            start()
            previous = None
            while service.running:
                status = service.status()
                current = status.get('stage')
                if current != previous:
                    print(json.dumps({'stage':stage, 'phase':current}, ensure_ascii=False), flush=True)
                    previous = current
                if time.monotonic() - began > 900:
                    if stage == 'practice': service.cancel()
                    else: service.control('cancel')
                    raise TimeoutError('Model stage exceeded 15 minutes')
                time.sleep(.5)
            status = service.status()
            if status['state'] != 'completed':
                raise AssertionError(json.dumps(status, ensure_ascii=False))
            details = verify()
            report[stage] = {'status':'passed', 'seconds':round(time.monotonic()-began, 2), 'device':status.get('device'), **details}
            print(json.dumps({stage:report[stage]}, ensure_ascii=False), flush=True)
        except Exception as error:
            report[stage] = {'status':'failed', 'seconds':round(time.monotonic()-began, 2), 'error':str(error)}
            raise
        finally:
            save()

    def tags():
        value = analysis.store.get(row['id'])
        assert value and value['source'] == row['source'] and value['segments']
        assert abs(value['duration'] - args.seconds) < .1
        assert any(value['tags'].values()), 'No visible tags on vocal sample'
        return {'segments':len(value['segments']), 'tags':value['tags']}

    def structure():
        value = analysis.structure_store.get(row['id'])
        assert value and value['source'] == row['source']
        payload = value.get('payload', value)
        assert abs(payload['duration'] - args.seconds) < .1 and payload['segments']
        assert payload['segments'][0]['start'] == 0 and abs(payload['segments'][-1]['end']-args.seconds) < .1
        json.dumps(payload, allow_nan=False)
        return {'result':payload}

    def performance():
        value = store.read(row['id'], row['source'])
        assert value['status'] == 'ready', value
        validate(value['analysis'])
        result = value['analysis']
        assert result['beats'] and result['notes'], 'Sample must exercise beat and melody models'
        saved = stems.store.get(row['id'])
        assert saved['source'] == row['source'] and len(saved['stems']) == 6
        assert all(stems.media(row['id'], saved['generation'], name).is_file() for name in saved['stems'])
        return {'duration':result['duration'], 'beats':len(result['beats']), 'notes':len(result['notes']),
                'chords':len(result['chords']), 'keys':len(result['keys']), 'stems':len(saved['stems'])}

    if args.stage in ('tags', 'all'):
        run('tags', analysis, lambda:analysis.start('selected', [row['id']], 'tags'), tags)
    if args.stage in ('structure', 'all'):
        run('structure', analysis, lambda:analysis.start('selected', [row['id']], 'structure'), structure)
    if args.stage in ('practice', 'all'):
        run('practice', practice, lambda:practice.start(row['id']), performance)
    if args.stage in ('consumers', 'all'):
        from semantic_library import SemanticLibrary
        semantic = SemanticLibrary(root, data / 'library/track-analysis/results.sqlite3')
        vectors, state = semantic.get([(row['id'], row['path'])])
        deadline = time.monotonic() + 10
        while state == 'building' and time.monotonic() < deadline:
            time.sleep(.05)
            vectors, state = semantic.get([(row['id'], row['path'])])
        assert state == 'ready' and vectors[row['id']].shape == (512,), state
        assert semantic.features(vectors)[row['id']], 'No trusted tag features reached recommendation'
        detail = analysis.track(row['id'])
        assert detail['status'] == 'ready' and detail['structure']['status'] == 'ready'
        assert practice.track(row['id'])['analysis']['status'] == 'ready'
        report['consumers'] = {'status':'passed', 'muq_vectors':len(vectors), 'muq_dimension':512,
                               'catalog_rows':len(analysis.catalog()['rows'])}
        save()
        print(json.dumps({'consumers':report['consumers']}), flush=True)
    print('PASS: isolated model stages', flush=True)


if __name__ == '__main__':
    main()
