"""Which SuiviBourse is this? (:mod:`application.build_info`)

The whole of the reading is a mapping and an optional string, so every state a
deployment can be in is one call here: an image built from a tag, an image a
PaaS built from a branch, a checkout, and a build nobody stamped.

The one impure function is exercised against **this** repository, which is a
checkout by definition when the suite runs — and skipped rather than faked when
it is not.
"""
import subprocess
from pathlib import Path

from application import build_info


# --------------------------------------------------------------------- #
# The four answers
# --------------------------------------------------------------------- #

def test_a_release_image_carries_the_version_it_was_published_under():
    """Both facts, and the word is ``release``: the workflow passes the tag the
    two registries publish under, so the string on the page is the string
    somebody would ``docker pull``."""
    build = build_info.describe({
        'RELEASE_VERSION': '5.0.0',
        'SOURCE_COMMIT': '8f0a02e1c0ffee00',
    })

    assert build.version == '5.0.0'
    assert build.revision == '8f0a02e1c0ffee00'
    assert build.source == build_info.RELEASE


def test_a_build_from_a_branch_has_a_revision_and_no_version():
    """What a PaaS building on every push produces, and it is a **complete**
    state rather than a release with a missing half — which is why ``version``
    is ``None`` and not a word invented for the hole."""
    build = build_info.describe({'SOURCE_COMMIT': '8f0a02e1c0ffee00'})

    assert build.version is None
    assert build.revision == '8f0a02e1c0ffee00'
    assert build.source == build_info.COMMIT


def test_a_checkout_says_so_rather_than_claiming_to_be_that_commit():
    """The fourth word earns its place here: a working tree may differ from the
    commit it names, so the revision says where the code *came from* and
    ``source`` refuses to let a reader take it for proof of what is running."""
    build = build_info.describe({}, checkout='8f0a02e1c0ffee00')

    assert build.version is None
    assert build.revision == '8f0a02e1c0ffee00'
    assert build.source == build_info.CHECKOUT


def test_an_unstamped_build_invents_neither_half():
    """No ``dev``, no ``0.0.0``, no ``unknown`` sitting in the version field:
    the two facts are absent and the derived word is the only thing that
    speaks (#845's rule, one edge further out)."""
    build = build_info.describe({})

    assert build == build_info.UNSTAMPED
    assert build.to_dict() == {
        'version': None, 'revision': None, 'source': 'unknown'}


# --------------------------------------------------------------------- #
# Blank counts as unset — the Dockerfile's empty defaults
# --------------------------------------------------------------------- #

def test_the_empty_defaults_of_a_plain_docker_build_are_not_a_stamp():
    """``ARG SOURCE_COMMIT=""`` means the variable is *always set* in the image
    and usually empty. A bare mapping lookup would report every hand-built
    image as stamped with the empty string; ``boot_env.text`` is why it does
    not, and this is the test that holds the reuse."""
    build = build_info.describe({'RELEASE_VERSION': '', 'SOURCE_COMMIT': '  '})

    assert build == build_info.UNSTAMPED


def test_a_blank_stamp_still_falls_through_to_the_checkout():
    """The image's empty defaults must not mask the tree a contributor is
    running from — *set but blank* is *unset* all the way through, not only at
    the first read."""
    build = build_info.describe(
        {'SOURCE_COMMIT': ''}, checkout='8f0a02e1c0ffee00')

    assert build.revision == '8f0a02e1c0ffee00'
    assert build.source == build_info.CHECKOUT


def test_the_stamp_wins_over_the_checkout():
    """The only case where the order matters: a contributor running the image's
    own environment against a source tree. What the build says about itself is
    what shipped."""
    build = build_info.describe(
        {'SOURCE_COMMIT': 'deadbeef'}, checkout='8f0a02e1c0ffee00')

    assert build.revision == 'deadbeef'
    assert build.source == build_info.COMMIT


# --------------------------------------------------------------------- #
# The line the boot writes
# --------------------------------------------------------------------- #

def test_the_boot_line_says_the_two_facts_and_not_the_derived_word():
    """``docker logs`` is where the question is asked most often. The sentence
    carries the version and an abbreviated commit; the word ``release`` is for
    a client that branches, not for a person reading a terminal."""
    assert build_info.said(build_info.describe({
        'RELEASE_VERSION': '5.0.0',
        'SOURCE_COMMIT': '8f0a02e1c0ffee00deadbeef',
    })) == '5.0.0 (8f0a02e1c0ff)'


def test_the_boot_line_of_an_unstamped_build_says_unknown_once():
    assert build_info.said(build_info.UNSTAMPED) == 'unknown'
    assert build_info.said(build_info.describe({}, checkout='8f0a02e1c0ffee00')) \
        == 'checkout 8f0a02e1c0ff'


# --------------------------------------------------------------------- #
# The one impure function
# --------------------------------------------------------------------- #

def test_the_checkout_revision_is_this_repository_s_own_head():
    """Against the real tree the suite runs in, and asserted **against git
    itself** rather than against a hash written down here — which would be a
    fixture that expires at the next commit."""
    expected = subprocess.run(
        ['git', 'rev-parse', 'HEAD'],
        cwd=str(Path(__file__).resolve().parents[1]),
        capture_output=True, text=True).stdout.strip()

    assert build_info.checkout_revision() == expected


def test_no_repository_above_it_is_not_a_failure(tmp_path):
    """The image's own state: two Python packages and no repository anywhere
    above them. The gate is what keeps the subprocess from ever being spawned
    there, and ``None`` is the honest answer rather than a caught exception."""
    assert build_info.checkout_revision(tmp_path / 'nowhere' / 'boot.py') is None
