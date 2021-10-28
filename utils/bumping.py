"""
Bump version, update Chart.yml and create Github Release
Paul Brissaud
"""
import os
import logging
import sys
import semver
from github import Github, InputGitAuthor
from yaml import dump, safe_load

keywords = {
    "#MAJOR": 3,
    "#MINOR": 2,
    "#PATCH": 1,
}

gh = Github(os.getenv('GITHUB_TOKEN'))
repo = gh.get_repo(os.getenv('GITHUB_REPOSITORY'))
branch = repo.get_branch(os.getenv('GITHUB_BRANCH', default='master'))

if repo.get_releases().totalCount > 0:
    last_release_tag = repo.get_releases()[0].tag_name

    if last_release_tag[0] == "v":
        USE_PREFIX = True
        last_release_tag = last_release_tag[1:]
    else:
        USE_PREFIX = False

    try:
        last_version = semver.VersionInfo.parse(last_release_tag)
    except ValueError:
        logging.error("Tag name of last release is not in semver format")
        sys.exit(0)
else:
    USE_PREFIX = False
    last_version = semver.VersionInfo.parse('0.0.0')

last_commit = branch.commit
keyword_detection = list(map(keywords.get,
                             filter(lambda x: x in last_commit.commit.message.upper(), keywords)))

if len(keyword_detection) == 0:
    logging.warning("No semver keywords detected in last commit... Exiting")
    sys.exit(0)

bumping_strength = max(keyword_detection)
new_version = last_version

if bumping_strength == 3:
    new_version = last_version.bump_major()

if bumping_strength == 2:
    new_version = last_version.bump_minor()

if bumping_strength == 1:
    new_version = last_version.bump_patch()

if USE_PREFIX:
    NEW_TAG = str("v" + new_version.__str__())
else:
    NEW_TAG = str(new_version)

# Update Chart.yaml file
with open('chart/Chart.yml', encoding='UTF-8') as f:
    chart_file = safe_load(f)

chart_file['appVersion'] = NEW_TAG

with open('chart/Chart.yml', 'w', encoding='UTF-8') as f:
    dump(chart_file, f)

contents = repo.get_contents("chart/Chart.yml")

with open('chart/Chart.yml', 'rb') as f:
    update_commit = repo.update_file(contents.path,
                                     'Update appVersion in Helm chart', f.read(), contents.sha)

repo.create_git_tag_and_release(NEW_TAG, str(new_version),
                                str(new_version), last_commit.commit.message,
                                update_commit['commit'].sha, 'commit',
                                InputGitAuthor(
                                    last_commit.author.name, last_commit.author.email),
                                False, False)
