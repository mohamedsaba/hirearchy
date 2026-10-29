import { createHash } from 'node:crypto';

export const SNAPSHOT_LOADER = String.raw`import base64, hashlib, json, os, stat, sys
def load():
    raw = sys.stdin.buffer.read(4 * 1024 * 1024 + 1)
    if len(raw) > 4 * 1024 * 1024:
        raise ValueError()
    records = json.loads(raw.decode('utf-8'))
    if type(records) is not list or not 1 <= len(records) <= 128:
        raise ValueError()
    paths = set()
    files = []
    total = 0
    for record in records:
        if type(record) is not list or len(record) != 3:
            raise ValueError()
        path, encoded, expected = record
        if type(path) is not str or type(encoded) is not str or type(expected) is not str:
            raise ValueError()
        parts = path.split('/')
        if (not path or len(path.encode('utf-8')) > 256 or path.startswith('/') or
                len(path) >= 2 and path[0].isalpha() and path[1] == ':' or
                '\\' in path or '\x00' in path or
                any(not part or part in ('.', '..') or len(part.encode('utf-8')) > 255 for part in parts)):
            raise ValueError()
        if path in paths:
            raise ValueError()
        data = base64.b64decode(encoded, validate=True)
        data.decode('utf-8')
        if len(data) > 512 * 1024 or len(expected) != 64 or hashlib.sha256(data).hexdigest() != expected:
            raise ValueError()
        total += len(data)
        if total > 2 * 1024 * 1024:
            raise ValueError()
        paths.add(path)
        files.append((parts, data))
    for parts, _ in files:
        for index in range(1, len(parts)):
            if '/'.join(parts[:index]) in paths:
                raise ValueError()
    root = '/workspace'
    root_stat = os.stat(root, follow_symlinks=False)
    if not stat.S_ISDIR(root_stat.st_mode) or root_stat.st_uid != 65534 or root_stat.st_gid != 65534 or not os.access(root, os.W_OK | os.X_OK):
        raise ValueError()
    for parts, data in files:
        directory = root
        for part in parts[:-1]:
            directory = os.path.join(directory, part)
            try:
                os.mkdir(directory, 0o755)
            except FileExistsError:
                pass
            info = os.lstat(directory)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != 65534 or info.st_gid != 65534:
                raise ValueError()
            os.chmod(directory, 0o755, follow_symlinks=False)
        destination = os.path.join(directory, parts[-1])
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o644)
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                raise ValueError()
            os.fchmod(descriptor, 0o644)
            with os.fdopen(descriptor, 'wb', closefd=False) as output:
                output.write(data)
        finally:
            os.close(descriptor)
try:
    load()
except BaseException:
    sys.exit(65)
`;

export const RECIPE = Object.freeze({
  recipeId: 'reservation-moves.pytest',
  recipeVersion: '3',
  scenarioRef: 'reservation-moves',
  scenarioVersion: 'v3',
  image:
    'assess-python@sha256:892c8fa7563e6054fb17fa6a729be7dcbeb87f9268da5533f06bde4a8e8d1b3d',
  bootstrap: Object.freeze(['/bin/sleep', 'infinity']),
  argv: Object.freeze([
    'python3',
    '-B',
    '-m',
    'pytest',
    '-q',
    '-p',
    'no:cacheprovider',
  ]),
  environment: Object.freeze([
    'HOME=/tmp',
    'TMPDIR=/tmp',
    'PYTHONDONTWRITEBYTECODE=1',
    'PYTEST_DISABLE_PLUGIN_AUTOLOAD=1',
  ]),
  snapshotLoaderSha256: createHash('sha256')
    .update(SNAPSHOT_LOADER, 'utf8')
    .digest('hex'),
  user: '65534:65534',
  workingDirectory: '/workspace',
});

export const RECIPE_DIGEST = createHash('sha256')
  .update(JSON.stringify(RECIPE), 'utf8')
  .digest('hex');
