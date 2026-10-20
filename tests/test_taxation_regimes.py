"""The taxation regimes are a JSON per country, and the docs page is rendered from them (#1289)."""
import json
import re
from collections import Counter
from datetime import date
from pathlib import Path

import pytest

from application import taxation

WEBSITE = Path(__file__).resolve().parents[1] / 'website'
FILES = sorted((WEBSITE / 'taxation').glob('*.json'))
PAGE = (WEBSITE / 'docs' / 'taxation-models-in-europe.mdx').read_text(encoding='utf-8')
COUNTRIES = {path: json.loads(path.read_text(encoding='utf-8')) for path in FILES}
WRAPPERS = [wrapper for country in COUNTRIES.values() for wrapper in country['wrappers']]


def test_there_is_a_file_per_country_and_it_names_its_country():
    assert FILES
    for path, country in COUNTRIES.items():
        assert country['country'].lower() == path.stem
        assert country['wrappers'], path.name


def test_ids_are_unique_and_prefixed_with_the_country():
    for path, country in COUNTRIES.items():
        for wrapper in country['wrappers']:
            assert re.fullmatch(rf'{path.stem}/[a-z0-9-]+', wrapper['id']), wrapper['id']
    assert not [i for i, n in Counter(w['id'] for w in WRAPPERS).items() if n > 1]


@pytest.mark.parametrize('wrapper', WRAPPERS, ids=lambda w: w['id'])
def test_a_model_is_one_the_app_accepts_unchanged(wrapper):
    model = wrapper['model']
    if model is None:
        return
    assert taxation.validate(model['kind'], model['parameters']) == model['parameters']


@pytest.mark.parametrize('wrapper', WRAPPERS, ids=lambda w: w['id'])
def test_a_regime_has_official_sources_consulted_in_the_past(wrapper):
    assert wrapper['name'] and wrapper['sources']
    for source in wrapper['sources']:
        assert source['url'].startswith('https://') and source['title']
        assert date.fromisoformat(source['consulted']) <= date.today()


def test_the_ids_in_the_json_are_the_ids_on_the_page_once_each():
    rendered = re.findall(r'<TaxationRegime id="([^"]+)" />', PAGE)
    assert Counter(rendered) == Counter(w['id'] for w in WRAPPERS)
