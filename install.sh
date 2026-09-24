#!/bin/sh
# =============================================================================
#  ais installer for macOS and Linux
#
#    curl -fsSL https://github.com/j-ts/ai-switcher/releases/latest/download/install.sh | sh
#
#  From a private repository (token with read access, or a signed-in gh):
#    curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" \
#         https://raw.githubusercontent.com/j-ts/ai-switcher/main/install.sh | sh
#    gh api -H 'Accept: application/vnd.github.raw' repos/j-ts/ai-switcher/contents/install.sh | sh
#
#  Installs (or updates) ais into ~/.ais and links ~/.local/bin/ais. Needs only
#  curl or wget, tar and a sha256 tool - no git, Go or Node: ais fetches its
#  own pinned Node on first run and ships agm prebuilt.
#
#  Updating replaces the program files only; app/ (runtimes) and profiles/
#  (accounts, sessions, the agm store) are never touched.
#
#  Environment knobs:
#    AIS_HOME=<dir>         install location              (default ~/.ais)
#    AIS_BIN_DIR=<dir>      where the `ais` link goes     (default ~/.local/bin)
#    AIS_VERSION=<tag>      a specific release tag        (default: latest)
#    AIS_CHANNEL=nightly    newest build, prereleases included
#    AIS_ARCHIVE=<file|url> install this archive instead of downloading
#    AIS_REPO=<owner/name>  release source                (default j-ts/ai-switcher)
#    AIS_GITHUB_TOKEN / GITHUB_TOKEN / GH_TOKEN  token for a private repository
#                           (else `gh auth token` when the GitHub CLI is signed in)
#    AIS_NO_MODIFY_PATH=1   do not touch shell rc files
#    AIS_NO_BOOTSTRAP=1     do not fetch Node right away
# =============================================================================

set -eu

REPO="${AIS_REPO:-j-ts/ai-switcher}"
AIS_HOME="${AIS_HOME:-$HOME/.ais}"
BIN_DIR="${AIS_BIN_DIR:-$HOME/.local/bin}"

say()  { printf '%s\n' "$*"; }
warn() { printf 'ais-install: %s\n' "$*" >&2; }
die()  { warn "$*"; exit 1; }

fetch() {   # fetch <url> <dest>
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL --retry 3 "$1" -o "$2"
    elif command -v wget >/dev/null 2>&1; then
        wget -q "$1" -O "$2"
    else
        die "need curl or wget"
    fi
}

gh_get() {   # gh_get <url> <accept> <dest|->  (GitHub API; token-authenticated when set)
    if command -v curl >/dev/null 2>&1; then
        # curl drops the Authorization header on the cross-host redirect to
        # the asset storage, which rejects a second credential.
        if [ -n "${TOKEN:-}" ]; then
            curl -fsSL --retry 3 -H "Accept: $2" -H "Authorization: Bearer $TOKEN" -o "$3" "$1"
        else
            curl -fsSL --retry 3 -H "Accept: $2" -o "$3" "$1"
        fi
    elif [ -z "${TOKEN:-}" ] && command -v wget >/dev/null 2>&1; then
        wget -q --header="Accept: $2" -O "$3" "$1"
    else
        die "need curl (or wget, for public repositories)"
    fi
}

asset_url() {   # asset_url <name> <release.json>: the API url of that release asset
    grep -oE '"(url|name)"[[:space:]]*:[[:space:]]*"[^"]*"' "$2" | awk -F'"' -v want="$1" '
        $2 == "url" && $4 ~ /\/releases\/assets\/[0-9]+$/ { u = $4; next }
        $2 == "name" { if ($4 == want && u != "") { print u; exit } u = "" }'
}

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
    else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# --- platform ----------------------------------------------------------------
case "$(uname -s)" in
    Darwin) os=macos ;;
    Linux)  os=linux ;;
    *) die "unsupported OS $(uname -s) - on Windows use install.ps1" ;;
esac
case "$(uname -m)" in
    x86_64|amd64)  arch=x64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) die "unsupported CPU $(uname -m)" ;;
esac
ASSET="ais-$os-$arch.tar.gz"

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t ais)
trap 'rm -rf "$tmp"' EXIT INT TERM

# --- download ----------------------------------------------------------------
if [ -n "${AIS_ARCHIVE:-}" ]; then
    case "$AIS_ARCHIVE" in
        http://*|https://*) fetch "$AIS_ARCHIVE" "$tmp/$ASSET" ;;
        *) [ -f "$AIS_ARCHIVE" ] || die "no such archive: $AIS_ARCHIVE"; cp "$AIS_ARCHIVE" "$tmp/$ASSET" ;;
    esac
    say "Installing ais from $AIS_ARCHIVE"
else
    # Everything goes through the releases API, which also serves private
    # repositories when a token is at hand: $AIS_GITHUB_TOKEN, $GITHUB_TOKEN,
    # $GH_TOKEN, or a signed-in GitHub CLI.
    TOKEN="${AIS_GITHUB_TOKEN:-${GITHUB_TOKEN:-${GH_TOKEN:-}}}"
    if [ -z "$TOKEN" ] && command -v gh >/dev/null 2>&1; then
        TOKEN=$(gh auth token 2>/dev/null || true)
    fi
    API="https://api.github.com/repos/$REPO"
    tag="${AIS_VERSION:-}"
    tag_of() { sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1; }
    if [ -z "$tag" ] && [ "${AIS_CHANNEL:-}" != "nightly" ]; then
        tag=$(gh_get "$API/releases/latest" application/vnd.github+json - 2>/dev/null | tag_of || true)
    fi
    if [ -z "$tag" ]; then
        # No stable release yet (or nightly asked for): newest one, prereleases included.
        tag=$(gh_get "$API/releases?per_page=5" application/vnd.github+json - 2>/dev/null | tag_of || true)
    fi
    [ -n "$tag" ] || die "no release found for $REPO (private repository? set GITHUB_TOKEN or run: gh auth login)"
    gh_get "$API/releases/tags/$tag" application/vnd.github+json "$tmp/release.json" \
        || die "cannot read release $tag of $REPO"
    say "Installing ais $tag ($os-$arch)"
    for name in "$ASSET" SHA256SUMS; do
        url=$(asset_url "$name" "$tmp/release.json")
        [ -n "$url" ] || die "$name is missing from release $tag"
        gh_get "$url" application/octet-stream "$tmp/$name" || die "download failed: $name"
    done
    want=$(awk -v f="$ASSET" '$2 == f {print $1}' "$tmp/SHA256SUMS")
    [ -n "$want" ] || die "$ASSET is not listed in SHA256SUMS"
    got=$(sha256_of "$tmp/$ASSET")
    [ "$want" = "$got" ] || die "checksum mismatch for $ASSET (expected $want, got $got)"
fi

# --- unpack + replace program files, keep app/ and profiles/ ----------------
mkdir -p "$tmp/x"
tar -xzf "$tmp/$ASSET" -C "$tmp/x"
[ -f "$tmp/x/ais/bin/ais" ] || die "archive does not look like an ais release"

mkdir -p "$AIS_HOME"
for entry in "$tmp/x/ais"/* "$tmp/x/ais"/.[!.]*; do
    [ -e "$entry" ] || continue
    name=$(basename "$entry")
    case "$name" in app|profiles) continue ;; esac
    rm -rf "${AIS_HOME:?}/$name"
    mv "$entry" "$AIS_HOME/$name"
done
chmod +x "$AIS_HOME/bin/ais"
for f in "$AIS_HOME"/bin/*/agm; do [ -f "$f" ] && chmod +x "$f"; done
if [ "$os" = macos ] && command -v xattr >/dev/null 2>&1; then
    xattr -dr com.apple.quarantine "$AIS_HOME" 2>/dev/null || true
fi

# --- put `ais` on PATH ---------------------------------------------------------
mkdir -p "$BIN_DIR"
ln -sf "$AIS_HOME/bin/ais" "$BIN_DIR/ais"

path_note=""
case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
        if [ -z "${AIS_NO_MODIFY_PATH:-}" ]; then
            line="export PATH=\"$BIN_DIR:\$PATH\"  # added by the ais installer"
            rcs=""
            if [ -f "$HOME/.zshrc" ] || [ "$(basename "${SHELL:-}")" = zsh ]; then rcs="$rcs $HOME/.zshrc"; fi
            [ -f "$HOME/.bashrc" ]       && rcs="$rcs $HOME/.bashrc"
            [ -f "$HOME/.bash_profile" ] && rcs="$rcs $HOME/.bash_profile"
            [ -n "$rcs" ] || rcs="$HOME/.profile"
            for rc in $rcs; do
                grep -qs "added by the ais installer" "$rc" || printf '\n%s\n' "$line" >> "$rc"
            done
            if [ -d "$HOME/.config/fish" ]; then
                mkdir -p "$HOME/.config/fish/conf.d"
                printf 'fish_add_path -g %s  # added by the ais installer\n' "$BIN_DIR" > "$HOME/.config/fish/conf.d/ais.fish"
            fi
            path_note="Open a new terminal (or run: export PATH=\"$BIN_DIR:\$PATH\") so \`ais\` is found."
        else
            path_note="Add $BIN_DIR to your PATH to run \`ais\` by name."
        fi
        ;;
esac

# --- fetch the pinned Node now, so the first `ais` is instant ---------------
version=""
if [ -z "${AIS_NO_BOOTSTRAP:-}" ]; then
    version=$("$AIS_HOME/bin/ais" --version) || warn "Node bootstrap failed; it will be retried on first run"
fi

say ""
say "ais installed in $AIS_HOME${version:+ ($version)}"
[ -n "$path_note" ] && say "$path_note"
if [ "$os" = linux ] && ! command -v secret-tool >/dev/null 2>&1; then
    say "Note: Antigravity logins need secret-tool (Debian/Ubuntu: sudo apt install libsecret-tools)."
fi
say ""
say "Next:  ais setup"
