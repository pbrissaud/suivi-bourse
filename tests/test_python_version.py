"""One Python version across the image, .python-version, every requires-python and uv.lock.

Renovate bumps all but uv.lock together (renovate.json, depName ``python``); this
catches a hand edit, a new workspace member that drifts, or a bump nobody relocked.
"""

import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FLOOR = re.compile(r'^requires-python\s*=\s*">=([^"]+)"', re.M)


def test_python_version_is_aligned():
    pinned = (ROOT / ".python-version").read_text().strip()

    tags = re.findall(r"^FROM\s+(?:--\S+\s+)*(?:\S+/)?python:(\S+)", (ROOT / "Dockerfile").read_text(), re.M)
    assert tags, "no FROM python:… line in the Dockerfile"
    assert set(tags) == {f"{pinned}-slim"}, f".python-version={pinned} but the Dockerfile uses python:{tags}"

    root = ROOT / "pyproject.toml"
    members = tomllib.loads(root.read_text())["tool"]["uv"]["workspace"]["members"]
    pyprojects = [root, *sorted(p for m in members for p in ROOT.glob(f"{m}/pyproject.toml"))]
    floors = {str(p.relative_to(ROOT)): (m.group(1) if (m := FLOOR.search(p.read_text())) else None) for p in pyprojects}
    assert set(floors.values()) == {pinned}, f".python-version={pinned} but requires-python is {floors}"

    lock = FLOOR.search((ROOT / "uv.lock").read_text())
    assert lock and lock.group(1) == pinned, f"uv.lock still says requires-python >={lock and lock.group(1)}: run `uv lock` with the mise uv"
