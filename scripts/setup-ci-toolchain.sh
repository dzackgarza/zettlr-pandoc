#!/usr/bin/env bash
set -euo pipefail

readonly pandoc_version='3.9.0.2'
readonly pandoc_sha256='ce4ac48f48aa7eadc1f5dbdf3449a1739f188ecb8c5421c5adc070fe7479e567'
readonly pandoc_reference_version='3.10.2'
readonly pandoc_reference_sha256='6c06b69b49ae95087573631a6fcafb233ab7ab51e5cfa73f7539d6c964a2640d'
readonly crossref_release='0.3.24a'
readonly crossref_sha256='afaa8867ab8d908b7e5ad1b96f62eedea6a5d3e89ee14e152cd72e67f535a728'
readonly pandoc_config_dir="${HOME}/.pandoc"
# The LanguageTool CLI backend of the editor's grammar checker runs
# `languagetool --json`; the release is the one the workstation uses.
readonly languagetool_version='6.6'
readonly languagetool_sha256='53600506b399bb5ffe1e4c8dec794fd378212f14aaf38ccef9b6f89314d11631'

if [[ "$(uname -m)" != 'x86_64' ]]; then
  printf 'Unsupported CI architecture: %s\n' "$(uname -m)" >&2
  exit 1
fi

for command_name in curl dpkg-deb git java sha256sum sudo tar unzip; do
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
sudo apt-get install --yes biber latexmk pdf2svg texlive-latex-extra texlive-pictures xvfb

readonly pandoc_package="${setup_dir}/pandoc.deb"
curl --fail --location --silent --show-error \
  "https://github.com/jgm/pandoc/releases/download/${pandoc_version}/pandoc-${pandoc_version}-1-amd64.deb" \
  --output "${pandoc_package}"
printf '%s  %s\n' "${pandoc_sha256}" "${pandoc_package}" | sha256sum --check
sudo dpkg --install "${pandoc_package}"

# Parser differential tests are locked to the vendored grammar's exact Pandoc
# reference release. Keep that oracle separate from the export toolchain above:
# pandoc-crossref must match the runtime pandoc ABI, while grammar tests must not
# silently change meaning when the export toolchain changes.
readonly pandoc_reference_package="${setup_dir}/pandoc-reference.deb"
readonly pandoc_reference_root="${setup_dir}/pandoc-reference"
curl --fail --location --silent --show-error \
  "https://github.com/jgm/pandoc/releases/download/${pandoc_reference_version}/pandoc-${pandoc_reference_version}-1-amd64.deb" \
  --output "${pandoc_reference_package}"
printf '%s  %s\n' "${pandoc_reference_sha256}" "${pandoc_reference_package}" | sha256sum --check
mkdir --parents "${pandoc_reference_root}"
dpkg-deb --extract "${pandoc_reference_package}" "${pandoc_reference_root}"
sudo install --mode 0755 "${pandoc_reference_root}/usr/bin/pandoc" /usr/local/bin/pandoc-reference

readonly crossref_archive="${setup_dir}/pandoc-crossref.tar.xz"
curl --fail --location --silent --show-error \
  "https://github.com/lierdakil/pandoc-crossref/releases/download/v${crossref_release}/pandoc-crossref-Linux-X64.tar.xz" \
  --output "${crossref_archive}"
printf '%s  %s\n' "${crossref_sha256}" "${crossref_archive}" | sha256sum --check
sudo tar --extract --xz --file "${crossref_archive}" --directory /usr/local/bin pandoc-crossref

readonly languagetool_archive="${setup_dir}/LanguageTool.zip"
curl --fail --location --silent --show-error \
  "https://languagetool.org/download/LanguageTool-${languagetool_version}.zip" \
  --output "${languagetool_archive}"
printf '%s  %s\n' "${languagetool_sha256}" "${languagetool_archive}" | sha256sum --check
sudo unzip -q "${languagetool_archive}" -d /opt
printf '#!/bin/sh\nexec java -jar /opt/LanguageTool-%s/languagetool-commandline.jar "$@"\n' \
  "${languagetool_version}" | sudo tee /usr/local/bin/languagetool >/dev/null
sudo chmod 0755 /usr/local/bin/languagetool

git clone --depth 1 https://github.com/dzackgarza/pandoc-config.git "${pandoc_config_dir}"

actual_pandoc_version="$(pandoc --version | head -1 | cut -d ' ' -f2)"
readonly actual_pandoc_version
actual_pandoc_reference_version="$(pandoc-reference --version | head -1 | cut -d ' ' -f2)"
readonly actual_pandoc_reference_version
actual_crossref_version="$(pandoc-crossref --version | sed -nE 's/.*built with Pandoc v([^,]+),.*/\1/p')"
readonly actual_crossref_version
test "${actual_pandoc_version}" = "${pandoc_version}"
test "${actual_pandoc_reference_version}" = "${pandoc_reference_version}"
test "${actual_crossref_version}" = "${pandoc_version}"
command -v just >/dev/null
command -v latexmk >/dev/null
command -v pdflatex >/dev/null
command -v biber >/dev/null
command -v pdf2svg >/dev/null
command -v xvfb-run >/dev/null
languagetool --list | grep -q '^en-US '
test -f "${pandoc_config_dir}/justfile"
