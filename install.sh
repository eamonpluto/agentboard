#!/usr/bin/env bash
# CrewBus Desktop Installer for macOS & Linux
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/eamonpluto/crewbus/master/install.sh | bash
# Or:
#   curl -fsSL https://eamonpluto.github.io/crewbus/install.sh | bash

set -euo pipefail

REPO="eamonpluto/crewbus"
API_URL="https://api.github.com/repos/${REPO}/releases"

echo ""
echo "  ========================================"
echo "    CrewBus Desktop Installer            "
echo "  ========================================"
echo ""

OS="$(uname -s)"
ARCH="$(uname -m)"

echo "==> Detected OS: ${OS} (${ARCH})"

# Query GitHub API for latest desktop release
echo "==> Fetching latest release information..."
RELEASE_JSON=$(curl -fsSL -H "User-Agent: CrewBus-Installer" "${API_URL}")
TAG_NAME=$(echo "${RELEASE_JSON}" | grep -m1 '"tag_name":' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')

if [ -z "${TAG_NAME}" ]; then
  echo "Error: Could not retrieve latest desktop release." >&2
  exit 1
fi

echo "==> Found release: ${TAG_NAME}"

case "${OS}" in
  Darwin*)
    # macOS: Download DMG
    if [ "${ARCH}" = "arm64" ]; then
      ASSET_PATTERN="_aarch64\.dmg$"
    else
      ASSET_PATTERN="_x64\.dmg$|\.dmg$"
    fi

    DOWNLOAD_URL=$(echo "${RELEASE_JSON}" | grep -E '"browser_download_url":.*'${ASSET_PATTERN} | head -n1 | sed -E 's/.*"browser_download_url": *"([^"]+)".*/\1/')

    if [ -z "${DOWNLOAD_URL}" ]; then
      # Fallback to any DMG in the release
      DOWNLOAD_URL=$(echo "${RELEASE_JSON}" | grep -E '"browser_download_url":.*\.dmg"' | head -n1 | sed -E 's/.*"browser_download_url": *"([^"]+)".*/\1/')
    fi

    if [ -z "${DOWNLOAD_URL}" ]; then
      echo "Error: No macOS DMG asset found in release ${TAG_NAME}." >&2
      exit 1
    fi

    DMG_NAME="$(basename "${DOWNLOAD_URL}")"
    TMP_DMG="/tmp/${DMG_NAME}"

    echo "==> Downloading ${DMG_NAME}..."
    curl -fSL "${DOWNLOAD_URL}" -o "${TMP_DMG}"

    echo "==> Mounting ${DMG_NAME}..."
    MOUNT_DIR=$(mktemp -d -t crewbus-mount)
    hdiutil attach "${TMP_DMG}" -mountpoint "${MOUNT_DIR}" -quiet -nobrowse

    echo "==> Installing CrewBus.app to /Applications..."
    if [ -d "/Applications/CrewBus.app" ]; then
      rm -rf "/Applications/CrewBus.app"
    fi
    cp -R "${MOUNT_DIR}/CrewBus.app" "/Applications/"

    echo "==> Unmounting and cleaning up..."
    hdiutil detach "${MOUNT_DIR}" -quiet || true
    rm -f "${TMP_DMG}"
    rmdir "${MOUNT_DIR}" 2>/dev/null || true

    echo ""
    echo "  [+] CrewBus ${TAG_NAME} installed to /Applications/CrewBus.app!"
    echo "  [+] You can open it from Launchpad, Spotlight, or: open /Applications/CrewBus.app"
    echo ""
    ;;

  Linux*)
    # Linux: AppImage or deb
    if command -v dpkg >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
      # Debian / Ubuntu: check for .deb asset
      DEB_URL=$(echo "${RELEASE_JSON}" | grep -E '"browser_download_url":.*_amd64\.deb"' | head -n1 | sed -E 's/.*"browser_download_url": *"([^"]+)".*/\1/')
      if [ -n "${DEB_URL}" ]; then
        DEB_NAME="$(basename "${DEB_URL}")"
        TMP_DEB="/tmp/${DEB_NAME}"
        echo "==> Downloading ${DEB_NAME}..."
        curl -fSL "${DEB_URL}" -o "${TMP_DEB}"
        echo "==> Installing via dpkg (may prompt for sudo password)..."
        sudo dpkg -i "${TMP_DEB}" || sudo apt-get install -f -y
        rm -f "${TMP_DEB}"
        echo ""
        echo "  [+] CrewBus ${TAG_NAME} installed successfully!"
        echo "  [+] You can launch it with: crewbus-desktop"
        echo ""
        exit 0
      fi
    fi

    # Fallback to AppImage
    APPIMAGE_URL=$(echo "${RELEASE_JSON}" | grep -E '"browser_download_url":.*\.AppImage"' | head -n1 | sed -E 's/.*"browser_download_url": *"([^"]+)".*/\1/')
    if [ -z "${APPIMAGE_URL}" ]; then
      echo "Error: No Linux AppImage or deb asset found in release ${TAG_NAME}." >&2
      exit 1
    fi

    INSTALL_DIR="${HOME}/.local/bin"
    mkdir -p "${INSTALL_DIR}"
    TARGET="${INSTALL_DIR}/crewbus-desktop"

    echo "==> Downloading AppImage to ${TARGET}..."
    curl -fSL "${APPIMAGE_URL}" -o "${TARGET}"
    chmod +x "${TARGET}"

    echo ""
    echo "  [+] CrewBus ${TAG_NAME} installed to ${TARGET}!"
    echo "  [+] Ensure ~/.local/bin is in your PATH, then run: crewbus-desktop"
    echo ""
    ;;

  *)
    echo "Error: Unsupported operating system: ${OS}." >&2
    exit 1
    ;;
esac
