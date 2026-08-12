#!/usr/bin/env bash
# Assembles the README demo GIFs from the frames + .ffconcat timing files
# written by `capture-runner.mjs readme-demos`. The concat demuxer honours
# the per-frame durations; palettegen/paletteuse is the standard
# high-quality GIF pipeline (https://ffmpeg.org/ffmpeg-filters.html#palettegen).
set -euo pipefail

outdir="$1"
for scene in math-typing amsthm-typing review-flow; do
  ffmpeg -y -loglevel error -f concat -safe 0 -i "$outdir/$scene.ffconcat" \
    -vf "scale=760:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
    -loop 0 "$outdir/$scene.gif"
  echo "$scene.gif $(du -h "$outdir/$scene.gif" | cut -f1)"
done
