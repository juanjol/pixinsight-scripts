# PixInsight Scripts

A PixInsight update repository with a couple of PJSR scripts.

## Adding the repository

1. In PixInsight, open `RESOURCES > Updates > Manage Repositories > Add`.
2. Paste this URL, trailing slash included:

   ```
   https://juanjol.github.io/pixinsight-scripts/
   ```

3. Run `RESOURCES > Updates > Check for Updates`, apply the updates and
   restart PixInsight.

Everything is a single package, so all the scripts are installed at once.

## What is in the repository

### Processing Checklist

An interactive processing cheat sheet: keep several workflows, tick off each
step as you go, and open the PixInsight process linked to every step.
Workflows can be created, edited, exported and imported, and progress is
saved automatically.

Installs under `SCRIPT > Utilities > Processing Checklist`.

### Add Suffix

Appends a configurable suffix to the identifier of an image. Run it from the
Script menu, or save it as a process icon and drop that icon on any image to
rename it without opening a dialog. It can also duplicate the image instead of
renaming it.

Installs under `SCRIPT > AAOC > Add Suffix`.

Both scripts require PixInsight 1.8.8 or later.

## License

MIT. See `LICENSE`.
