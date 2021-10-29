"""
Version bumping script
Update changelog, docker image tag in docker-compose and Helm chart and create Github release
Paul Brissaud
"""
from __future__ import annotations

import os
import logging
import sys
import re
from typing import Optional, Tuple
from semver import VersionInfo
from github import Github, InputGitAuthor
from yaml import dump, safe_load
from mdutils.mdutils import MdUtils
from mdutils.fileutils import MarkDownFile

keywords = {
    "#MAJOR": 3,
    "#MINOR": 2,
    "#PATCH": 1,
}


def coerce(version: str) -> Tuple[VersionInfo | None, Optional[str]]:
    """
    Convert an incomplete version string into a semver-compatible Version
    object

    * Tries to detect a "basic" version string (``major.minor.patch``).
    * If not enough components can be found, missing components are
        set to zero to obtain a valid semver version.

    :param str version: the version string to convert
    :return: a tuple with a :class:`Version` instance (or ``None``
        if it's not a version) and the rest of the string which doesn't
        belong to a basic version.
    :rtype: tuple(:class:`Version` | None, str)
    """

    baseversion = re.compile(
        r"""[vV]?
            (?P<major>0|[1-9]\d*)
            (\.
            (?P<minor>0|[1-9]\d*)
            (\.
                (?P<patch>0|[1-9]\d*)
            )?
            )?
        """,
        re.VERBOSE,
    )

    match = baseversion.search(version)
    if not match:
        return None, version

    ver = {
        key: 0 if value is None else value for key, value in match.groupdict().items()
    }
    ver = VersionInfo(**ver)
    rest = match.string[match.end():]  # noqa:E203
    return ver, rest


gh = Github(os.getenv('GITHUB_TOKEN'))
repo = gh.get_repo(os.getenv('GITHUB_REPOSITORY'))
branch = repo.get_branch(os.getenv('GITHUB_BRANCH', default='master'))

last_commit = branch.commit
keyword_detection = list(map(keywords.get,
                             filter(lambda x: x in last_commit.commit.message.upper(), keywords)))

if len(keyword_detection) == 0:
    logging.warning("No semver keywords detected in last commit... Exiting")
    sys.exit(0)

if repo.get_releases().totalCount > 0:
    last_release_tag = repo.get_releases()[0].tag_name

    # Get diff commit between last release and last commit on main branch
    diff = repo.compare(last_release_tag, last_commit.sha).commits[1:]

    if last_release_tag[0] == "v":
        USE_PREFIX = True
        last_release_tag = last_release_tag[1:]
    else:
        USE_PREFIX = False

    try:
        last_version, _ = coerce(last_release_tag)
    except ValueError:
        logging.error("Tag name of last release is not in semver format")
        sys.exit(0)
else:
    USE_PREFIX = False
    last_version = VersionInfo.parse('0.0.0')
    first_commit = repo.get_commits().reversed[0]
    diff = repo.compare(first_commit.commit.sha, last_commit.sha).commits

bumping_strength = max(keyword_detection)

NEW_VERSION = last_version

if bumping_strength == 3:
    NEW_VERSION = last_version.bump_major()

if bumping_strength == 2:
    NEW_VERSION = last_version.bump_minor()

if bumping_strength == 1:
    NEW_VERSION = last_version.bump_patch()

# Return new version as string
NEW_VERSION = str(NEW_VERSION)

if USE_PREFIX:
    new_tag = 'v' + NEW_VERSION
else:
    new_tag = NEW_VERSION

# Get all commit messages from last release and last commit
diff_messages = list(map(lambda x: x.commit.message.split('\n', 1)[0], diff))

# Delete auto commit messages (generated with last release) from list
generated_commits = ['Update CHANGELOG',
                     'Update image version in Helm chart',
                     'Update image version in Docker Compose']
for message in diff_messages:
    if message in generated_commits:
        generated_commits.remove(message)

# Update CHANGELOG.md
changelog = MarkDownFile('CHANGELOG.md')
changelog_new = MdUtils(file_name='')
changelog_new.new_header(level=1, title=NEW_VERSION)
changelog_new.new_list(diff_messages)
changelog_new.write('  \n')
changelog.append_end(changelog_new.file_data_text)

changelog_contents = repo.get_contents("CHANGELOG.md")
with open('CHANGELOG.md', 'rb') as f:
    repo.update_file(changelog_contents.path,
                     'Update CHANGELOG',
                     f.read(),
                     changelog_contents.sha)

# Update appVersion in Chart.yaml file
with open('charts/suivi-bourse/Chart.yml', encoding='UTF-8') as f:
    chart_file = safe_load(f)

chart_file['appVersion'] = new_tag

with open('charts/suivi-bourse/Chart.yml', 'w', encoding='UTF-8') as f:
    dump(chart_file, f)

chart_file_contents = repo.get_contents("charts/suivi-bourse/Chart.yml")
with open('charts/suivi-bourse/Chart.yml', 'rb', encoding='UTF-8') as f:
    repo.update_file(chart_file_contents.path,
                     'Update image version in Helm chart',
                     f.read(), chart_file_contents.sha)

# Update image tag in docker-compose.yml file
with open('docker-compose/docker-compose.yaml', encoding='UTF-8') as f:
    compose_file = safe_load(f)

compose_file['services']['app']['image'] = \
    compose_file['services']['app']['image'].split(':', 1)[0] + ":" + new_tag

with open('docker-compose/docker-compose.yaml', encoding='UTF-8') as f:
    dump(compose_file, f)

compose_file_contents = repo.get_contents("docker-compose/docker-compose.yaml")
with open('docker-compose/docker-compose.yaml', 'rb') as f:
    last_update_commit = repo.update_file(compose_file_contents.path,
                                          'Update image version in Docker Compose',
                                          f.read(), compose_file_contents.sha)

# Create release
release_note = MdUtils(file_name='')
release_note.new_list(diff_messages)

repo.create_git_tag_and_release(new_tag, NEW_VERSION, NEW_VERSION, release_note.file_data_text,
                                last_update_commit['commit'].sha, 'commit',
                                InputGitAuthor(last_commit.author.name, last_commit.author.email),
                                False, False)
