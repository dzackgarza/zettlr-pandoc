#!/usr/bin/env bash
set -euo pipefail

readonly pandoc_version='3.9.0.2'
readonly pandoc_sha256='ce4ac48f48aa7eadc1f5dbdf3449a1739f188ecb8c5421c5adc070fe7479e567'
readonly crossref_release='0.3.24a'
readonly crossref_sha256='afaa8867ab8d908b7e5ad1b96f62eedea6a5d3e89ee14e152cd72e67f535a728'
readonly pandoc_config_commit='1871f489b6ca915e70174925ec67fc8b2818206b'
readonly pandoc_config_dir="${HOME}/.pandoc"

if [[ "$(uname -m)" != 'x86_64' ]]; then
  printf 'Unsupported CI architecture: %s\n' "$(uname -m)" >&2
  exit 1
fi

for command_name in curl git sha256sum sudo tar; do
  command -v "${command_name}" >/dev/null
done

if [[ -e "${pandoc_config_dir}" ]]; then
  printf 'Refusing to replace existing Pandoc configuration: %s\n' "${pandoc_config_dir}" >&2
  exit 1
fi

setup_dir="$(mktemp -d)"
readonly setup_dir
trap 'rm -r -- "${setup_dir}"' EXIT

sudo apt-get update
sudo apt-get install --yes biber latexmk pdf2svg texlive-latex-extra texlive-pictures

readonly pandoc_package="${setup_dir}/pandoc.deb"
curl --fail --location --silent --show-error \
  "https://github.com/jgm/pandoc/releases/download/${pandoc_version}/pandoc-${pandoc_version}-1-amd64.deb" \
  --output "${pandoc_package}"
printf '%s  %s\n' "${pandoc_sha256}" "${pandoc_package}" | sha256sum --check
sudo dpkg --install "${pandoc_package}"

readonly crossref_archive="${setup_dir}/pandoc-crossref.tar.xz"
curl --fail --location --silent --show-error \
  "https://github.com/lierdakil/pandoc-crossref/releases/download/v${crossref_release}/pandoc-crossref-Linux-X64.tar.xz" \
  --output "${crossref_archive}"
printf '%s  %s\n' "${crossref_sha256}" "${crossref_archive}" | sha256sum --check
sudo tar --extract --xz --file "${crossref_archive}" --directory /usr/local/bin pandoc-crossref

git clone --no-checkout https://github.com/dzackgarza/pandoc-config.git "${pandoc_config_dir}"
git -C "${pandoc_config_dir}" checkout --detach "${pandoc_config_commit}"

actual_pandoc_version="$(pandoc --version | head -1 | cut -d ' ' -f2)"
readonly actual_pandoc_version
actual_crossref_version="$(pandoc-crossref --version | sed -nE 's/.*built with Pandoc v([^,]+),.*/\1/p')"
readonly actual_crossref_version
test "${actual_pandoc_version}" = "${pandoc_version}"
test "${actual_crossref_version}" = "${pandoc_version}"
command -v just >/dev/null
command -v latexmk >/dev/null
command -v pdflatex >/dev/null
command -v biber >/dev/null
command -v pdf2svg >/dev/null
test -f "${pandoc_config_dir}/justfile"
