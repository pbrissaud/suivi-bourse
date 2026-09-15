"""The pure modules, held at the import rather than on the source.

`.github/scripts/conventions.sh` used to run this as the last of twelve greps.
Eleven of those twelve were properties of the *text* and moved to CodeRabbit's
`path_instructions`, where a reviewer reads them on every pull request. This one
is not a property of the text: a module pulls `pandas` through three levels of
someone else's `__init__`, and no amount of reading the diff shows it. It has to
run, so it lives here.

**It asks a subprocess**, on the same reasoning as `test_the_call_survives_the_
dead_name` in `test_log_level.py`: by the time pytest reaches this file the
suite has imported the store, the market and half of `pandas`, so
`sys.modules` in *this* process answers for the suite and not for the module.
A fresh interpreter answers for the module alone.
"""
import subprocess
import sys
from pathlib import Path


#: The modules that touch neither the store nor the market and take `now`
#: injected. A module joining them joins this tuple, and nothing else changes.
PURE_MODULES = (
    'scheduling', 'performance', 'carrying', 'retention', 'fx', 'boot_env',
    'mounts', 'market_info', 'build_info', 'rhythm', 'taxation',
    'taxation_projection',
)

#: The four edges a pure module may not reach, directly or through anybody.
HEAVY = ('duckdb', 'yfinance', 'pandas', 'openpyxl')


def test_the_pure_modules_are_pure_at_the_import():
    """Each one imported alone, in order, and the first to pull a heavy edge
    names itself and what it pulled.

    Imported *cumulatively* on purpose: the eleventh is read after the ten
    before it, so a module that only pulls `duckdb` when another has already
    loaded is caught too, and the report still names the one that did it.
    """
    program = (
        'import sys; sys.path.insert(0, %r)\n'
        'import importlib\n'
        'heavy = set(%r)\n'
        'for name in %r:\n'
        '    importlib.import_module("application." + name)\n'
        '    pulled = sorted({m.split(".")[0] for m in sys.modules} & heavy)\n'
        '    if pulled:\n'
        '        print(name + " pulled " + ", ".join(pulled))\n'
        '        break\n'
        'else:\n'
        '    print("pure")\n'
    ) % (str(Path(__file__).resolve().parents[1] / 'src'), HEAVY, PURE_MODULES)

    result = subprocess.run([sys.executable, '-c', program],
                            capture_output=True, text=True)

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == 'pure', result.stdout.strip()
