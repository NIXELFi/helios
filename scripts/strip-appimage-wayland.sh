#!/usr/bin/env bash
# Remove the bundled libwayland-* libraries from the Linux AppImage, then
# re-sign it, so the host's own Wayland/Mesa stack is used (issue #48).
#
# Why: linuxdeploy (run by the Tauri bundler) copies libwayland-client,
# libwayland-egl, libwayland-server and libwayland-cursor into usr/lib of the
# AppImage. On rolling-release hosts (CachyOS/Arch, KDE Wayland) they clash with
# the host Mesa/Wayland libraries and the WebKitGTK window renders blank. Neither
# Tauri nor linuxdeploy offers a supported way to exclude them, so we post-process
# the finished AppImage.
#
# Order matters for the updater: tauri-action has already built, signed and
# uploaded the original AppImage + .sig. This script rewrites the AppImage IN
# PLACE (same path, same file name) and replaces the .sig next to it with a
# fresh signature of the new bytes, using the same TAURI_SIGNING_PRIVATE_KEY the
# build used. The workflow then re-uploads both files with --clobber and builds
# the updater fragment from the (now updated) .sig. A stale signature would make
# every Linux client reject the update, so this script never leaves the file and
# the .sig out of step: any failure exits non-zero and the release stays a draft.
#
# Inputs (env):
#   ARTIFACT_PATHS                      JSON array of files tauri-action produced
#   TAURI_SIGNING_PRIVATE_KEY           updater signing key (read by tauri signer)
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD  its password
#   SIGNER_DIR                          dir to run `pnpm exec tauri` from
#                                       (default apps/desktop)
# Output: the .AppImage and .AppImage.sig named in ARTIFACT_PATHS, rewritten.
set -euo pipefail

# Pinned. appimagetool 1.9.0 (2024-08-08). Bump both lines together.
APPIMAGETOOL_URL="https://github.com/AppImage/appimagetool/releases/download/1.9.0/appimagetool-x86_64.AppImage"
APPIMAGETOOL_SHA256="46fdd785094c7f6e545b61afcfb0f3d98d8eab243f644b4b17698c01d06083d1"

# Exactly the libraries named in the issue. Matched as name + optional version
# suffix so a symlink or a differently versioned soname is caught too.
WAYLAND_LIBS=(libwayland-client libwayland-egl libwayland-server libwayland-cursor)

SIGNER_DIR="${SIGNER_DIR:-apps/desktop}"

die() { echo "strip-appimage-wayland: $*" >&2; exit 1; }

# Print every bundled libwayland-* file/symlink under $1.
find_wayland_libs() {
  local root="$1" lib
  for lib in "${WAYLAND_LIBS[@]}"; do
    find "$root" \( -type f -o -type l \) \( -name "${lib}.so" -o -name "${lib}.so.*" \)
  done
}

[ -n "${ARTIFACT_PATHS:-}" ] || die "ARTIFACT_PATHS is required"
[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ] || die "TAURI_SIGNING_PRIVATE_KEY is required"
command -v jq >/dev/null || die "jq is required"

mapfile -t appimages < <(printf '%s' "$ARTIFACT_PATHS" | jq -r '.[] | select(endswith(".AppImage"))')
[ "${#appimages[@]}" -eq 1 ] || die "expected exactly one .AppImage in ARTIFACT_PATHS, got ${#appimages[@]}"
bundle="$(readlink -f "${appimages[0]}")"
[ -f "$bundle" ] || die "AppImage not found: $bundle"
[ -f "$bundle.sig" ] || die "no updater signature next to the AppImage: $bundle.sig"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# 1. Unpack the original. --appimage-extract needs no FUSE.
cp "$bundle" "$work/orig.AppImage"
chmod +x "$work/orig.AppImage"
( cd "$work" && ./orig.AppImage --appimage-extract >/dev/null )
[ -d "$work/squashfs-root" ] || die "extraction produced no squashfs-root"

found="$(find_wayland_libs "$work/squashfs-root")"
if [ -z "$found" ]; then
  echo "strip-appimage-wayland: no bundled libwayland-* libraries found; leaving the AppImage and its signature untouched."
  exit 0
fi
echo "strip-appimage-wayland: removing:"
echo "$found"
echo "$found" | while IFS= read -r f; do rm -f -- "$f"; done
[ -z "$(find_wayland_libs "$work/squashfs-root")" ] || die "failed to remove bundled libwayland-* libraries"

# 2. Repack. Reuse the ELF runtime of the original AppImage (the first
# `--appimage-offset` bytes) so appimagetool does not download one.
offset="$("$work/orig.AppImage" --appimage-offset)"
case "$offset" in ''|*[!0-9]*) die "bad --appimage-offset output: '$offset'" ;; esac
head -c "$offset" "$work/orig.AppImage" > "$work/runtime"

curl -fsSL --retry 3 -o "$work/appimagetool" "$APPIMAGETOOL_URL"
echo "$APPIMAGETOOL_SHA256  $work/appimagetool" | sha256sum -c - || die "appimagetool checksum mismatch"
chmod +x "$work/appimagetool"

ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 "$work/appimagetool" \
  --no-appstream --runtime-file "$work/runtime" \
  "$work/squashfs-root" "$work/new.AppImage"
chmod +x "$work/new.AppImage"

# 3. Check the REPACKED file (not our working tree): it must unpack, still hold
# the app entry point, and contain no libwayland-* at all.
mkdir "$work/verify"
( cd "$work/verify" && "$work/new.AppImage" --appimage-extract >/dev/null )
[ -e "$work/verify/squashfs-root/AppRun" ] || die "repacked AppImage has no AppRun"
leftover="$(find_wayland_libs "$work/verify/squashfs-root")"
[ -z "$leftover" ] || die "repacked AppImage still bundles: $leftover"

# 4. Swap it in and re-sign. tauri signer reads the key and password from the
# environment and writes <file>.sig, replacing the stale signature.
cp "$work/new.AppImage" "$bundle"
rm -f "$bundle.sig"
( cd "$SIGNER_DIR" && pnpm exec tauri signer sign "$bundle" )
[ -s "$bundle.sig" ] || die "re-signing produced no signature: $bundle.sig"

echo "strip-appimage-wayland: done; re-signed $(basename "$bundle")"
