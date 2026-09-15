#!/usr/bin/env python3
"""
build.py - Package every script and regenerate updates/updates.xri.

Usage:
    python3 tools/build.py                   # build the package
    python3 tools/build.py --keep            # keep older .zip files
    python3 tools/build.py --date 202609161200
    python3 tools/build.py --list-sources    # print the source directories

The repository ships a single package holding every script, so installing the
repository installs all of them at once. Files are stored in the archive with
their path relative to the repository root, so PixInsight extracts
src/scripts/<Name>/<Name>.js into the right place.
"""

import argparse
import datetime
import hashlib
import os
import sys
import zipfile

# --- Configuration -----------------------------------------------------------

PI_VERSIONS = "1.8.8:1.9.9"          # from_version:to_version

PACKAGE_NAME = "PixInsightScripts"
PACKAGE_TITLE = "PixInsight Scripts"
PACKAGE_SOURCE = "src/scripts"

PACKAGE_DESCRIPTION = """Processing Checklist - an interactive processing cheat sheet. Keeps
               several predefined or user-defined workflows, lets you tick off
               each step as you go, and opens the PixInsight process associated
               with every step.
            </p>
            <p>
               Add Prefix / Add Suffix - prepend or append a configurable string
               to the identifier of an image. Can be run from the Script menu or
               saved as a process icon and dragged onto an image.
            </p>
            <p>
               Everything installs under SCRIPT &gt; Toolbox."""

REPO_DESCRIPTION = """PixInsight scripts repository. A single package with every script:
         Processing Checklist, Add Prefix and Add Suffix, all under
         SCRIPT &gt; Toolbox."""

# --- Implementation ----------------------------------------------------------

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UPDATES_DIR = os.path.join(ROOT, "updates")


def collect_files():
    base = os.path.join(ROOT, PACKAGE_SOURCE)
    if not os.path.isdir(base):
        sys.exit("Missing source directory: %s" % base)
    files = []
    for dirpath, _, filenames in os.walk(base):
        for name in sorted(filenames):
            if name.startswith("."):
                continue
            full = os.path.join(dirpath, name)
            files.append((full, os.path.relpath(full, ROOT).replace(os.sep, "/")))
    if not files:
        sys.exit("No files found in %s" % PACKAGE_SOURCE)
    return sorted(files, key=lambda item: item[1])


def build_zip(path, files):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for full, arcname in files:
            zf.write(full, arcname)
            print("    + %s" % arcname)


def sha1_of(path):
    digest = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


XRI_TEMPLATE = """<?xml version="1.0" encoding="UTF-8"?>
<xri version="1.0">
   <description>
      <p>
         {repo_description}
      </p>
   </description>
   <platform os="all" arch="noarch" version="{versions}">
      <package fileName="{file_name}"
               sha1="{sha1}"
               type="script"
               releaseDate="{release_date}">
         <title>
            {title}
         </title>
         <description>
            <p>
               {description}
            </p>
         </description>
      </package>
   </platform>
</xri>
"""


def write_xri(file_name, sha1, release_date):
    xri = XRI_TEMPLATE.format(repo_description=REPO_DESCRIPTION,
                              versions=PI_VERSIONS,
                              file_name=file_name,
                              sha1=sha1,
                              release_date=release_date,
                              title=PACKAGE_TITLE,
                              description=PACKAGE_DESCRIPTION)
    path = os.path.join(UPDATES_DIR, "updates.xri")
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(xri)
    return path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--keep", action="store_true",
                        help="keep previously built packages")
    parser.add_argument("--date",
                        help="release date as YYYYMMDDhhmm (default: now, UTC)")
    parser.add_argument("--list-sources", action="store_true",
                        help="print the source directories of the package and exit")
    args = parser.parse_args()

    if args.list_sources:
        print(PACKAGE_SOURCE)
        return

    # PixInsight only offers an update when releaseDate moves forwards, and it
    # never reuses a file name, hence the timestamp in both.
    release_date = args.date or datetime.datetime.now(
        datetime.timezone.utc).strftime("%Y%m%d%H%M")

    os.makedirs(UPDATES_DIR, exist_ok=True)

    if not args.keep:
        for existing in os.listdir(UPDATES_DIR):
            if existing.endswith(".zip"):
                os.remove(os.path.join(UPDATES_DIR, existing))
                print("  - removed %s" % existing)

    zip_name = "%s-%s.zip" % (PACKAGE_NAME, release_date)
    zip_path = os.path.join(UPDATES_DIR, zip_name)
    print("building %s" % zip_name)
    build_zip(zip_path, collect_files())

    digest = sha1_of(zip_path)
    print("    sha1 %s" % digest)

    xri_path = write_xri(zip_name, digest, release_date)
    print("\nwrote %s" % os.path.relpath(xri_path, ROOT))


if __name__ == "__main__":
    main()
