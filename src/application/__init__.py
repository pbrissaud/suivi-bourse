"""The application: the boot sequence, the store, the four workloads, the views.

A package marker and nothing else — there is no re-export here, because a name
worth importing is worth importing from the module that defines it, and a façade
in this file would be a second place to look for every one of them.

It exists all the same rather than leaning on an implicit namespace package: the
sibling `api` is a package with a body, `src/` is the import root in a checkout
(`pythonpath = ["src"]`) and in the image (`PYTHONPATH=/home/appuser/src`) alike,
and one convention across the two beats two spellings of the same idea.
"""
