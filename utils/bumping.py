"""
Version bumping script
Update changelog, docker image tag in docker-compose and create Github release
Paul Brissaud
"""
from __future__ import annotations

import os
import logging
import sys
import re
from typing import Optional, Tuple
from semver import VersionInfo
from github import Github
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
    diff = repo.compare(last_release_tag, last_commit.sha).commits

    if last_release_tag[0] == "v":
        USE_PREFIX = True
        last_release_tag = last_release_tag[1:]
    else:
        USE_PREFIX = False

    try:
        last_version, _ = coerce(last_release_tag)
    except ValueError:
        logging.error("Tag name of last release is not in semver format")
        sys.exit(1)
else:
    USE_PREFIX = False
    last_version = VersionInfo.parse('0.0.0')
    first_commit = repo.get_commits().reversed[0]
    diff = repo.compare(first_commit.commit.sha, last_commit.sha).commits

bumping_strength = max(keyword_detection)

new_version = last_version

if bumping_strength == 3:
    new_version = last_version.bump_major()

if bumping_strength == 2:
    new_version = last_version.bump_minor()

if bumping_strength == 1:
    new_version = last_version.bump_patch()

# Return new version as string
new_version = str(new_version)

if USE_PREFIX:
    new_tag = 'v' + new_version
else:
    new_tag = new_version

print(new_version)

# Get all commit messages from last release and last commit
diff_messages = list(map(lambda x: x.commit.message.split('\n', 1)[0], diff))

# Delete unwanted commit messages from changelog
unwanted_commits = ['update changelog',
                    'update image tag in docker compose',
                    'merge branch.*']

temp = '(?:% s)' % '|'.join(unwanted_commits)

for message in list(diff_messages):
    if re.match(temp, message.strip().lower()):
        diff_messages.remove(message)

# Update CHANGELOG.md
changelog_new = MdUtils(file_name='')
changelog_new.new_header(level=1, title=new_version)
changelog_new.new_list(diff_messages)
changelog_new.write('  \n')
changelog_before = MdUtils(file_name='').read_md_file(file_name='CHANGELOG.md')
MarkDownFile('/tmp/CHANGELOG.md').rewrite_all_file(changelog_before + changelog_new.file_data_text)

changelog_contents = repo.get_contents("/CHANGELOG.md")
 
with open('/tmp/CHANGELOG.md', 'rb') as f:
    repo.update_file(changelog_contents.path,
                     'Update CHANGELOG',
                     f.read(),
                     changelog_contents.sha)


# Update docker-compose.yml file
with open('docker-compose/docker-compose.yaml', encoding='UTF-8') as f:
    compose_file = safe_load(f)

compose_file['services']['app']['image'] = \
    compose_file['services']['app']['image'].split(':', 1)[0] + ":" + new_tag

with open('docker-compose/docker-compose.yaml', 'w', encoding='UTF-8') as f:
    dump(compose_file, f)

compose_file_contents = repo.get_contents("docker-compose/docker-compose.yaml")
with open('docker-compose/docker-compose.yaml', 'rb') as f:
    last_update_commit = repo.update_file(compose_file_contents.path,
                                          'Update image tag in Docker Compose',
                                          f.read(), compose_file_contents.sha)

# Create release
release_note = MdUtils(file_name='')
release_note.new_list(diff_messages)

repo.create_git_tag_and_release(new_tag, new_version, new_version, release_note.file_data_text,
                                last_update_commit['commit'].sha, 'commit')
