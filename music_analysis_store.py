"""Small transactional result database. No audio/model imports in the API process."""
from contextlib import closing, contextmanager
from pathlib import Path
from resource_runtime import asset_path, source_path
import json,sqlite3,time,hashlib
from analysis_vocab import VERSION
from analysis_visibility import visible_payload
from recipe_compatibility import equivalent_recipes, accepted_recipes

def source_version(path):
    stat=Path(path).stat()
    return f'{stat.st_size}:{stat.st_mtime_ns}'

class AnalysisStore:
    def __init__(self,path):self.path=Path(path)
    def project(self,payload):return visible_payload(payload)
    def summary(self,payload):return {k:payload[k] for k in ('duration','tags','segments_count','energy_status')}
    @contextmanager
    def connect(self):
        self.path.parent.mkdir(parents=True,exist_ok=True)
        con=sqlite3.connect(str(self.path),timeout=10)
        try:
            con.execute('PRAGMA journal_mode=WAL')
            con.execute('CREATE TABLE IF NOT EXISTS results (id TEXT PRIMARY KEY, source TEXT NOT NULL, recipe TEXT NOT NULL, summary TEXT NOT NULL, payload TEXT NOT NULL, vectors BLOB, updated REAL NOT NULL)')
            self._ensure_query_index(con)
            con.execute('CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)')
            con.execute('CREATE TABLE IF NOT EXISTS recipe_compatibility (old TEXT PRIMARY KEY, new TEXT NOT NULL)')
            yield con;con.commit()
        except Exception:con.rollback();raise
        finally:con.close()
    @staticmethod
    def _ensure_query_index(con):
        # A covering index keeps freshness checks off the large payload/blob pages.
        columns = {row[1] for row in con.execute('PRAGMA table_info(results)')}
        if {'id', 'source', 'recipe', 'updated'} <= columns:
            con.execute('CREATE INDEX IF NOT EXISTS results_metadata_v1 ON results(id,source,recipe,updated)')
    def prepare_query_index(self):
        """Upgrade an existing store for lightweight consumers without creating an empty DB."""
        if not self.path.is_file():
            return
        with closing(sqlite3.connect(self.path.resolve().as_uri()+'?mode=rw', uri=True, timeout=5)) as con:
            self._ensure_query_index(con)
            con.commit()
    def task(self,value=None):
        with self.connect() as con:
            if value is not None:con.execute('INSERT OR REPLACE INTO tasks VALUES (1,?)',(json.dumps(value,ensure_ascii=False),))
            row=con.execute('SELECT payload FROM tasks WHERE id=1').fetchone()
        return json.loads(row[0]) if row else {'state':'idle'}
    def accepted_recipes(self,current,*,root=None,target='tags'):
        with self.connect() as con:rows=con.execute('SELECT old,new FROM recipe_compatibility').fetchall()
        equivalents=equivalent_recipes(root,current,target) if root is not None else ()
        return accepted_recipes(current,rows,equivalents)
    def accept_recipe(self,old,new):
        # Explicit, reviewed optimization compatibility; never rewrite result provenance.
        if old==new:return
        with self.connect() as con:con.execute('INSERT OR REPLACE INTO recipe_compatibility VALUES (?,?)',(old,new))
    def catalog(self):
        with self.connect() as con:rows=con.execute('SELECT id,source,recipe,summary,updated FROM results').fetchall()
        return {r[0]:{'source':r[1],'recipe':r[2],**self.project(json.loads(r[3])),'updated':r[4]} for r in rows}
    def get(self,rid):
        with self.connect() as con:row=con.execute('SELECT source,recipe,payload FROM results WHERE id=?',(rid,)).fetchone()
        return {'source':row[0],'recipe':row[1],**self.project(json.loads(row[2]))} if row else None
    def publish(self,rid,source,recipe,payload,vectors):
        # One SQLite transaction publishes summary, timeline and reusable vectors together.
        summary=self.summary(payload)
        with self.connect() as con:
            con.execute('INSERT OR REPLACE INTO results VALUES (?,?,?,?,?,?,?)',
                (rid,source,recipe,json.dumps(summary,ensure_ascii=False),json.dumps(payload,ensure_ascii=False,allow_nan=False),vectors,time.time()))
    def backup(self):
        # SQLite's backup API includes committed WAL data, unlike copying a live file.
        target=self.path.with_suffix('.sqlite3.backup-pending')
        with self.connect() as source:
            if source.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise sqlite3.DatabaseError('analysis integrity check failed')
            destination=sqlite3.connect(str(target))
            try:source.backup(destination)
            finally:destination.close()
        target.replace(self.path.with_suffix('.sqlite3.previous'))

def recipe_version(root):
    """Fingerprint implementation + exact model manifests without loading neural weights."""
    root=Path(root);digest=hashlib.sha256(VERSION.encode())
    for name in ('analysis_features.py','analysis_vocab.py','analysis_audio.py','music_analysis_worker.py','models/Essentia-tagging/download-manifest.json','models/MuQ-MuLan-download.json'):
        digest.update((asset_path(root,name) if name.startswith('models/') else source_path(root,name)).read_bytes())
    component=asset_path(root,'data/components/music-analysis/manifest.json')
    if component.is_file():digest.update(component.read_bytes())
    return digest.hexdigest()
