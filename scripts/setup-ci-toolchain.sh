#!/usr/bin/env bash
set -euo pipefail

readonly pandoc_version='3.9.0.2'
readonly pandoc_sha256='ce4ac48f48aa7eadc1f5dbdf3449a1739f188ecb8c5421c5adc070fe7479e567'
# The grammar oracle's release is owned by scripts/pandoc-reference.json,
# which also pins the Pandoc sources the editor grammar is generated from.
pandoc_reference_manifest="$(dirname "${BASH_SOURCE[0]}")/pandoc-reference.json"
readonly pandoc_reference_manifest
pandoc_reference_version="$(jq --exit-status --raw-output '.version' "${pandoc_reference_manifest}")"
readonly pandoc_reference_version
pandoc_reference_sha256="$(jq --exit-status --raw-output '.linuxAmd64DebSha256' "${pandoc_reference_manifest}")"
readonly pandoc_reference_sha256
readonly crossref_release='0.3.24a'
readonly crossref_sha256='afaa8867ab8d908b7e5ad1b96f62eedea6a5d3e89ee14e152cd72e67f535a728'
# Flowmark reads Markdown through `pandoc-flowmark`, the source-position Pandoc
# fork (dzackgarza/pandoc, branch flowmark-sourcepos), published as a static
# Linux executable by its `flowmark-*` release workflow.
readonly pandoc_flowmark_release='flowmark-3.10.2-4'
readonly pandoc_flowmark_sha256='49df5719dd44f23e9d36250ee3b98265bca91908ad488e5cd2e9dbd16b0b02e7'
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

# The check workflow caches ${downloads_dir} and ${texlive_dir}, keyed by
# this script. Every download below is pinned by its checksum, so a cached
# file is reused only when it still matches.
readonly downloads_dir="${HOME}/ci-downloads"
mkdir --parents "${downloads_dir}"

# fetch URL SHA256 NAME: print the path of the verified file NAME in the
# download cache, and download it first when it is absent or does not match.
fetch() {
  local -r url="$1" sha256="$2" file="${downloads_dir}/$3"
  if [[ ! -f "${file}" ]] || ! printf '%s  %s\n' "${sha256}" "${file}" | sha256sum --check --status; then
    curl --fail --location --silent --show-error "${url}" --output "${file}" || return
    printf '%s  %s\n' "${sha256}" "${file}" | sha256sum --check >&2 || return
  fi
  printf '%s\n' "${file}"
}

sudo apt-get update
sudo apt-get install --yes pdf2svg xvfb

# TeX comes from upstream TeX Live, as on the workstation: the central
# preamble loads packages (luahyperbolic among them) that the distribution's
# frozen TeX Live does not ship. The repository is rolling, so it has no
# checksum to pin; tlmgr verifies each package's signature instead. The
# repository is one fixed mirror: mirror.ctan.org redirects to a random
# mirror, and some of those serve a certificate curl cannot verify.
#
# A ${texlive_dir} that the check workflow restored from its cache only
# needs its paths linked.
readonly texlive_repository='https://mirrors.mit.edu/CTAN/systems/texlive/tlnet'
readonly texlive_dir="${HOME}/texlive"
readonly tlmgr="${texlive_dir}/bin/x86_64-linux/tlmgr"
if [[ ! -x "${tlmgr}" ]]; then
curl --fail --location --silent --show-error \
  "${texlive_repository}/install-tl-unx.tar.gz" \
  --output "${setup_dir}/install-tl.tar.gz"
mkdir "${setup_dir}/install-tl"
tar --extract --gzip --file "${setup_dir}/install-tl.tar.gz" --directory "${setup_dir}/install-tl" --strip-components 1
cat > "${setup_dir}/texlive.profile" <<PROFILE
selected_scheme scheme-infraonly
TEXDIR ${texlive_dir}
TEXMFSYSVAR ${texlive_dir}/texmf-var
TEXMFSYSCONFIG ${texlive_dir}/texmf-config
TEXMFLOCAL ${texlive_dir}/texmf-local
collection-basic 1
collection-bibtexextra 1
collection-fontsrecommended 1
collection-latexextra 1
collection-luatex 1
collection-mathscience 1
collection-pictures 1
tlpdbopt_install_docfiles 0
tlpdbopt_install_srcfiles 0
tlpdbopt_autobackup 0
instopt_adjustpath 0
PROFILE
"${setup_dir}/install-tl/install-tl" --no-interaction --repository "${texlive_repository}" --profile "${setup_dir}/texlive.profile"
"${tlmgr}" install bbm bbm-macros latexmk
fi
sudo "${tlmgr}" path add

pandoc_package="$(fetch \
  "https://github.com/jgm/pandoc/releases/download/${pandoc_version}/pandoc-${pandoc_version}-1-amd64.deb" \
  "${pandoc_sha256}" "pandoc-${pandoc_version}.deb")"
readonly pandoc_package
sudo dpkg --install "${pandoc_package}"

# Parser differential tests are locked to the vendored grammar's exact Pandoc
# reference release. Keep that oracle separate from the export toolchain above:
# pandoc-crossref must match the runtime pandoc ABI, while grammar tests must not
# silently change meaning when the export toolchain changes.
pandoc_reference_package="$(fetch \
  "https://github.com/jgm/pandoc/releases/download/${pandoc_reference_version}/pandoc-${pandoc_reference_version}-1-amd64.deb" \
  "${pandoc_reference_sha256}" "pandoc-${pandoc_reference_version}.deb")"
readonly pandoc_reference_package
readonly pandoc_reference_root="${setup_dir}/pandoc-reference"
mkdir --parents "${pandoc_reference_root}"
dpkg-deb --extract "${pandoc_reference_package}" "${pandoc_reference_root}"
sudo install --mode 0755 "${pandoc_reference_root}/usr/bin/pandoc" /usr/local/bin/pandoc-reference

crossref_archive="$(fetch \
  "https://github.com/lierdakil/pandoc-crossref/releases/download/v${crossref_release}/pandoc-crossref-Linux-X64.tar.xz" \
  "${crossref_sha256}" "pandoc-crossref-${crossref_release}.tar.xz")"
readonly crossref_archive
sudo tar --extract --xz --file "${crossref_archive}" --directory /usr/local/bin pandoc-crossref

pandoc_flowmark_binary="$(fetch \
  "https://github.com/dzackgarza/pandoc/releases/download/${pandoc_flowmark_release}/pandoc-flowmark" \
  "${pandoc_flowmark_sha256}" "pandoc-flowmark-${pandoc_flowmark_release}")"
readonly pandoc_flowmark_binary
sudo install --mode 0755 "${pandoc_flowmark_binary}" /usr/local/bin/pandoc-flowmark

languagetool_archive="$(fetch \
  "https://languagetool.org/download/LanguageTool-${languagetool_version}.zip" \
  "${languagetool_sha256}" "LanguageTool-${languagetool_version}.zip")"
readonly languagetool_archive
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
pandoc-flowmark --version | grep -q '+server +lua'
printf '$x$\n' | pandoc-flowmark -f markdown+sourcepos -t json | grep -q '"data-pos"'
command -v just >/dev/null
command -v latexmk >/dev/null
command -v pdflatex >/dev/null
command -v lualatex >/dev/null
command -v biber >/dev/null
command -v pdf2svg >/dev/null
command -v xvfb-run >/dev/null
languagetool --list | grep -q '^en-US '
test -f "${pandoc_config_dir}/justfile"
