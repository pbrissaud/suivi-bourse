# Contributing Guidelines

Contributions are welcome via GitHub pull requests. This document outlines the process to help get your contribution accepted.

## Sign off Your Work

The Developer Certificate of Origin (DCO) is a lightweight way for contributors to certify that they wrote or otherwise have the right to submit the code they are contributing to the project.
Here is the full text of the [DCO](http://developercertificate.org/).
Contributors must sign-off that they adhere to these requirements by adding a `Signed-off-by` line to commit messages.

```text
This is my commit message

Signed-off-by: Random J Developer <random@developer.example.org>
```

See `git help commit`:

```text
-s, --signoff
    Add Signed-off-by line by the committer at the end of the commit log
    message. The meaning of a signoff depends on the project, but it typically
    certifies that committer has the rights to submit this work under the same
    license and agrees to a Developer Certificate of Origin (see
    http://developercertificate.org/ for more information).
```

## How to Contribute

1. Fork this repository, develop, and test your changes
2. Remember to sign off your commits as described above
3. Submit a pull request

### Technical Requirements

* Must pass [DCO check](#sign-off-your-work)
* Must pass CI jobs for linting, security analysis and unit testing 

**You don't need to bump any version number, this will be done automatically once PR merged**

## Releasing

Release Please cuts the releases from the conventional commits landed on
`master`. `version.txt` and `.release-please-manifest.json` are its files: they
are bumped by `release-type: simple`, never edited by hand.

Two gestures happen at merge time rather than in a file, which is why they are
written down here:

* **A major is declared, not deduced.** A `!` on a commit makes the version
  number depend on one character in a commit message. When the next version is
  a decision rather than a consequence — v5 is — the merge commit carries the
  trailer instead:

  ```text
  Release-As: 5.0.0
  ```

* **An integration branch reaches `master` as a merge, not a squash.**
  `preview/v5` holds the history of the rewrite, and that history has value;
  squashing trades twenty-three commits for one line.

`docs:` commits are hidden from the generated `CHANGELOG.md`
(`release-please-config.json`). On a branch where twelve of them are the map's
own ADRs, the generated notes would serve the journal of the work as the
release notes of the product. The hand-written release-notes page of the
documentation is the surface that tells a reader what the release changes.

