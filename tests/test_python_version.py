"""One Python version across the image, .python-version and every requires-python.

Renovate bumps them together (renovate.json, depName ``python``); this catches a
hand edit or a new workspace member that drifts.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_python_version_is_aligned():
    pinned = (ROOT / ".python-version").read_text().strip()
    images = re.findall(r"^FROM python:(\d+\.\d+)-slim", (ROOT / "Dockerfile").read_text(), re.M)
    pyprojects = [ROOT / "pyproject.toml", *sorted((ROOT / "packages").glob("*/pyproject.toml"))]
    floors = {
        str(p.relative_to(ROOT)): m.group(1)
        for p in pyprojects
        if (m := re.search(r'requires-python\s*=\s*">=(\d+\.\d+)"', p.read_text()))
    }

    assert images, "no FROM python:X.Y-slim line in the Dockerfile"
    assert len(floors) == len(pyprojects) >= 5, f"requires-python not found in every pyproject: {floors}"
    assert set(images) | set(floors.values()) == {pinned}, f".python-version={pinned} images={images} floors={floors}"
