"""The four workspace members, held at the import (#1199).

uv members share one environment, so an import a member never declared still
succeeds at runtime: the boundary is this test, not the venv. It reads every
module of every member with `ast` — deferred imports inside a function included
— and refuses two things:

- an import from a higher member. Dependencies point down: app → store,
  market → core; store and market are independent of each other;
- a heavy third-party import the member may not make.

Known limits: an `importlib.import_module` call is not an import statement, and
a library that pulls `pandas` through its own `__init__` is not read.
"""
import ast
from pathlib import Path

PACKAGES = Path(__file__).resolve().parents[1] / 'packages'

#: What each member may import from, itself included.
BELOW = {
    'core': {'core'},
    'store': {'core', 'store'},
    'market': {'core', 'market'},
    'app': {'core', 'store', 'market', 'app'},
}

#: The heavy edges, and the member that may reach each one.
HEAVY = {
    'duckdb': {'store', 'app'},
    'pyarrow': {'store', 'app'},
    'yfinance': {'market', 'app'},
    'pandas': {'market', 'app'},
    'openpyxl': {'app'},
}


def _modules():
    """``{dotted name: (member, path)}`` over the four members."""
    found = {}
    for member in BELOW:
        root = PACKAGES / member / 'src'
        for path in root.rglob('*.py'):
            parts = path.relative_to(root).with_suffix('').parts
            if parts[-1] == '__init__':
                parts = parts[:-1]
            name = '.'.join(parts)
            assert name not in found, f'{name} is in two members'
            found[name] = (member, path)
    return found


def _imported(name, path, tree):
    """Every module name ``tree`` imports, relative imports resolved."""
    package = name if path.name == '__init__.py' else name.rpartition('.')[0]
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            yield from (alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ''
            if node.level:
                anchor = package.split('.')[:len(package.split('.')) - node.level + 1]
                base = '.'.join(anchor + ([base] if base else []))
            yield base
            yield from (f'{base}.{alias.name}' for alias in node.names)


def violations():
    modules = _modules()
    refused = []
    for name, (member, path) in sorted(modules.items()):
        for target in _imported(name, path, ast.parse(path.read_text(encoding='utf-8'))):
            owner = modules.get(target, (None,))[0]
            if owner is not None and owner not in BELOW[member]:
                refused.append(f'{name} ({member}) imports {target} ({owner})')
            reach = HEAVY.get(target.split('.')[0])
            if reach is not None and member not in reach:
                refused.append(f'{name} ({member}) imports {target}')
    return sorted(set(refused))


def test_every_member_holds_modules():
    """A wrong path would make the test below pass on nothing."""
    assert {member for member, _ in _modules().values()} == set(BELOW)


def test_no_member_imports_above_itself_nor_a_heavy_edge_it_may_not_reach():
    assert violations() == []
