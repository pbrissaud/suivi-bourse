"""Is the store on something that outlives the container? (issue #741, ADR-0015)

Every observation here is made against a **real** ``/proc/self/mountinfo``,
captured in a container and committed under ``tests/fixtures/mountinfo/`` with
the ``docker run`` that produced it (see the README there). That is not a
stylistic preference: the fact ADR-0015's amendment rests on — *a mounted path
is distinguished from the writable layer with certainty* — was asserted **false**
in session before it was verified, and the fixture is the verification.

The module takes the **text**, so none of this needs a container to run.
"""
from pathlib import Path

import pytest

import mounts

FIXTURES = Path(__file__).parent / 'fixtures' / 'mountinfo'


def sample(name: str) -> str:
    return (FIXTURES / f'{name}.mountinfo').read_text()


def identity(path: str) -> str:
    """A resolver that resolves nothing — the seam :func:`mounts.observe` opens.

    Handed in where the production one would follow symlinks, so a test states
    what it means about *comparison* without building a tree for it.
    """
    return path


# --------------------------------------------------------------------- #
# The three answers, on real samples
# --------------------------------------------------------------------- #

def test_a_bare_container_has_its_store_in_the_writable_layer():
    """``docker run`` with no volume: ``/data`` does not figure in the table at
    all, and what does is ``/`` — the overlay. This is the observation that
    replaces #677/D12's refusal to boot."""
    assert mounts.observe(sample('bare'), '/data', resolve=identity) \
        == mounts.EPHEMERAL


def test_a_named_volume_on_the_store_directory_is_persistent():
    assert mounts.observe(sample('named-volume'), '/data', resolve=identity) \
        == mounts.PERSISTENT


def test_the_read_only_import_bind_is_persistent_too():
    """ADR-0015's second mount. A bind and a named volume are two different
    filesystems in the real sample (``virtiofs`` and ``btrfs``), and one rule
    covers both because neither is volatile."""
    assert mounts.observe(sample('named-volume'), '/import', resolve=identity) \
        == mounts.PERSISTENT


def test_a_bind_of_an_ancestor_is_persistent():
    """**Never equality.** The store directory is not required to be a mount
    point of its own: a bind of ``/srv`` keeps a store at ``/srv/suivi-bourse``
    exactly as well as a bind of that path would."""
    assert mounts.observe(sample('ancestor-bind'), '/srv/suivi-bourse',
                          resolve=identity) == mounts.PERSISTENT


def test_a_sibling_of_the_bind_is_not_covered_by_it():
    """The prefix is on **components**. ``/srv`` does not contain ``/srvo``, and
    a character-wise ``startswith`` would report a store in the writable layer
    as kept because some unrelated volume's name starts with the same letters."""
    assert mounts.observe(sample('ancestor-bind'), '/srvo', resolve=identity) \
        == mounts.EPHEMERAL


def test_the_longest_mount_point_wins_over_the_ancestor():
    """Two real mounts, one prefixing the other. Both answer *persistent* here,
    so the assertion that carries the rule is :func:`mounts.enclosing`'s pick —
    the volume, not the bind it sits inside."""
    table = mounts.parse(sample('nested-mounts'))

    assert mounts.enclosing(table, '/srv/data').point == '/srv/data'
    assert mounts.enclosing(table, '/srv/other').point == '/srv'
    assert mounts.enclosing(table, '/data').point == '/'


# --------------------------------------------------------------------- #
# Unknown, and what it protects
# --------------------------------------------------------------------- #

def test_an_absent_mountinfo_is_unknown_and_never_ephemeral():
    """Off Linux there is no such file. The observation is a property of the
    kernel, and a missing ``/proc`` must not manufacture a false *ephemeral* on
    a macOS developer's machine — the one platform this app cannot run natively
    on at all (#657)."""
    assert mounts.observe(None, '/data') == mounts.UNKNOWN


def test_an_unreadable_mountinfo_reads_as_absent(tmp_path):
    assert mounts.read_mountinfo(str(tmp_path / 'nowhere')) is None
    # A directory is not a file either, and neither case is worth an error of
    # its own: the caller says nothing on unknown.
    assert mounts.read_mountinfo(str(tmp_path)) is None


def test_a_table_naming_nothing_that_contains_the_path_is_unknown():
    """Not *ephemeral*: a table with no root mount is not a container's, and the
    honest reading of a table that says nothing about the path is silence."""
    table = '30 25 0:5 / /proc rw,relatime - proc proc rw'

    assert mounts.observe(table, '/data', resolve=identity) == mounts.UNKNOWN


def test_a_relative_path_is_unknown_rather_than_matched_on_the_root():
    """A relative path names nothing a mount table can be asked about. The
    production resolver never produces one; a fake may, and ``/`` would
    otherwise swallow it."""
    assert mounts.observe(sample('bare'), 'data', resolve=identity) \
        == mounts.UNKNOWN


# --------------------------------------------------------------------- #
# The comparison is made on the resolved path
# --------------------------------------------------------------------- #

def test_dot_dot_is_collapsed_before_the_comparison():
    """Collapsed by the module itself, so an identity resolver still compares
    something meaningful — ``/data/..`` is ``/``, the writable layer, and
    ``/var/../data`` is the volume."""
    assert mounts.observe(sample('named-volume'), '/var/../data',
                          resolve=identity) == mounts.PERSISTENT
    assert mounts.observe(sample('named-volume'), '/data/..',
                          resolve=identity) == mounts.EPHEMERAL


def test_a_symbolic_link_is_followed_before_the_comparison(tmp_path):
    """With the production resolver, against a real link on the filesystem: what
    the kernel mounts is the target, so that is what has to be compared. The
    table is rewritten onto ``tmp_path`` so the link has somewhere real to point
    — the sample's ``/srv`` does not exist on the machine running the tests."""
    target = tmp_path / 'volume'
    target.mkdir()
    link = tmp_path / 'store'
    link.symlink_to(target)
    table = (f'30 25 0:5 / / rw,relatime - overlay overlay rw\n'
             f'31 30 0:6 / {target} rw,relatime - btrfs /dev/vda1 rw\n')

    # Followed: the link's target is the mount, so the store is kept.
    assert mounts.observe(table, str(link)) == mounts.PERSISTENT
    # Not followed, it would land on the writable layer instead — which is the
    # answer this test exists to forbid.
    assert mounts.observe(table, str(link), resolve=identity) \
        == mounts.EPHEMERAL


# --------------------------------------------------------------------- #
# What the filesystem field decides
# --------------------------------------------------------------------- #

def test_a_docker_less_install_keeps_its_store_on_the_root_filesystem():
    """The reason the rule reads the **filesystem** and not the mount point.

    *"The longest match is ``/``, therefore ephemeral"* is right in a container
    and false everywhere else: a Docker-less install (ADR-0015's own
    counterpart, where the defaults are overridden) has ``/`` on an ordinary
    filesystem that survives everything. Constructed rather than captured — this
    machine has no ext4-rooted Linux on it — and it is the one sample here that
    is."""
    table = ('30 25 259:1 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw\n'
             '31 30 0:22 / /proc rw,relatime shared:5 - proc proc rw\n')

    assert mounts.observe(table, '/var/lib/suivi-bourse', resolve=identity) \
        == mounts.PERSISTENT


def test_a_tmpfs_mount_is_a_mount_and_is_still_ephemeral():
    """A store on ``--tmpfs /data`` **is** a mount, so the mount test alone
    would call it kept while it is the most ephemeral thing there is."""
    table = ('30 25 259:1 / / rw,relatime - ext4 /dev/nvme0n1p2 rw\n'
             '31 30 0:44 / /data rw,relatime - tmpfs tmpfs rw,size=65536k\n')

    assert mounts.observe(table, '/data', resolve=identity) == mounts.EPHEMERAL


# --------------------------------------------------------------------- #
# Parsing
# --------------------------------------------------------------------- #

def test_every_real_sample_parses_whole():
    """No line of a real table is skipped: a parser that silently dropped the
    root mount would answer *unknown* on the bare container and print nothing —
    the failure this ticket exists to prevent, wearing the shape of caution."""
    for name in ('bare', 'named-volume', 'ancestor-bind', 'nested-mounts'):
        text = sample(name)
        assert len(mounts.parse(text)) == len(text.splitlines())


def test_the_octal_escapes_are_undone_in_one_pass():
    """``mountinfo`` escapes space, tab, newline and backslash in octal.
    Substituting them one after another turns a literal backslash followed by
    ``040`` into a space, which is why the substitution is a single pass."""
    table = ('30 25 0:5 / / rw - overlay overlay rw\n'
             '31 30 0:6 / /my\\040volume rw - btrfs /dev/vda1 rw\n'
             '32 30 0:7 / /back\\134040slash rw - btrfs /dev/vda1 rw\n')
    points = [mount.point for mount in mounts.parse(table)]

    assert points == ['/', '/my volume', '/back\\040slash']
    assert mounts.observe(table, '/my volume', resolve=identity) \
        == mounts.PERSISTENT


def test_a_mount_point_named_dash_does_not_pass_for_the_separator():
    """The separator is searched from index 6, after the six fixed fields. A
    search from the start would find a directory literally named ``-`` and read
    the mount options as a filesystem type."""
    table = '30 25 0:6 / /- rw,relatime - btrfs /dev/vda1 rw'

    assert mounts.parse(table) == (mounts.Mount(point='/-',
                                                filesystem='btrfs'),)


def test_a_line_that_cannot_be_read_is_skipped_and_never_raises():
    """This runs at boot, before anything has been started. A kernel that grew
    a field must not be able to take the boot down over a diagnostic."""
    table = ('nonsense\n'
             '\n'
             '30 25 0:5 / / rw,relatime - overlay overlay rw\n'
             '31 30 0:6 / /data rw,relatime -\n')
    parsed = mounts.parse(table)

    assert [mount.point for mount in parsed] == ['/']
    assert mounts.observe(table, '/data', resolve=identity) == mounts.EPHEMERAL


def test_the_last_mount_over_one_point_shadows_the_first():
    """Two mounts on the same point: the one you reach is the later one."""
    table = ('30 25 0:5 / / rw - overlay overlay rw\n'
             '31 30 0:6 / /data rw - btrfs /dev/vda1 rw\n'
             '32 30 0:7 / /data rw - tmpfs tmpfs rw\n')

    assert mounts.observe(table, '/data', resolve=identity) == mounts.EPHEMERAL


# --------------------------------------------------------------------- #
# The one impure line
# --------------------------------------------------------------------- #

@pytest.mark.parametrize('name,path,expected', [
    ('bare', '/data', mounts.EPHEMERAL),
    ('named-volume', '/data', mounts.PERSISTENT),
])
def test_store_persistence_reads_the_table_it_is_pointed_at(
        tmp_path, name, path, expected):
    """``store_persistence`` is the whole gesture in one call: read the table,
    observe the directory. Pointed at a file rather than at ``/proc``, which is
    what lets the seam be exercised on a machine that has no ``/proc`` at all."""
    table = tmp_path / 'mountinfo'
    table.write_text(sample(name))

    assert mounts.store_persistence(path, str(table)) == expected


def test_store_persistence_answers_unknown_where_there_is_no_table(tmp_path):
    assert mounts.store_persistence('/data', str(tmp_path / 'nowhere')) \
        == mounts.UNKNOWN
