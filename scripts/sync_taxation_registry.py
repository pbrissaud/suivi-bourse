"""Write ``website/static/taxation.json`` from ``website/taxation/<cc>.json`` (#1290).

    uv run python scripts/sync_taxation_registry.py

The country files (#1289) stay the one place a rate is written. The app reads
this flat list from the documentation site when its owner asks to import a model;
a wrapper whose ``model`` is ``null`` has no shape and is not importable.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COUNTRIES = ROOT / 'website' / 'taxation'
REGISTRY = ROOT / 'website' / 'static' / 'taxation.json'


def render() -> str:
    """The registry file's content, one wrapper per item."""
    items = []
    for path in sorted(COUNTRIES.glob('*.json')):
        country = json.loads(path.read_text(encoding='utf-8'))
        for wrapper in country['wrappers']:
            if wrapper['model'] is not None:
                items.append({'id': wrapper['id'], 'country': country['country'],
                              'name': wrapper['name'], **wrapper['model']})
    return json.dumps(items, indent=2, ensure_ascii=False) + '\n'


if __name__ == '__main__':
    REGISTRY.write_text(render(), encoding='utf-8')
