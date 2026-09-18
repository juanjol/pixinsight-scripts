# PixInsight Scripts

A PixInsight update repository with a few PJSR scripts, all of them
under the `SCRIPT > Toolbox` menu.

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

### Subframe Culler

Loads a folder of lights, measures every frame with SubframeSelector (FWHM,
eccentricity, SNR, background, noise, star count, star residual, altitude...)
and lets you cull them interactively. Each variable can filter with absolute
limits or with a k-sigma clip around the median of the batch, the file list is
coloured green or red in real time, and the panel shows how many frames survive
and how the median quality improves. Frames can be pinned so the filters never
touch them. Accepting moves the rejected files to a `rejects` subfolder and
writes a CSV with every measurement.

Installs under `SCRIPT > Toolbox > Subframe Culler`.

### Processing Checklist

An interactive processing cheat sheet: keep several workflows, tick off each
step as you go, and open the PixInsight process linked to every step.
Workflows can be created, edited, exported and imported, and progress is
saved automatically.

Installs under `SCRIPT > Toolbox > Processing Checklist`.

### Add Prefix and Add Suffix

Prepend or append a configurable string to the identifier of an image. Run
them from the Script menu, or save one as a process icon and drop that icon on
any image to rename it without opening a dialog. They can also duplicate the
image instead of renaming it.

Install under `SCRIPT > Toolbox > Add Prefix` and `SCRIPT > Toolbox > Add
Suffix`.

All the scripts require PixInsight 1.8.8 or later.

## License

MIT. See `LICENSE`.
