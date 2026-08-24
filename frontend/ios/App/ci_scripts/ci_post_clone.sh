#!/bin/sh
# Xcode Cloud — runs immediately after the repo is cloned, before dependency resolution
# (pod install) and before xcodebuild. Location matters: Xcode Cloud only runs ci_scripts that
# sit next to the built project, i.e. ios/App/ci_scripts/, alongside App.xcworkspace.
#
# The Capacitor shell is a native iOS project, but its web content is built by Vite and copied
# in by `cap sync`. The runner has none of that: no node_modules, no dist/, no synced
# App/public. So this does the JS half of the build here, so that when Xcode Cloud reaches
# `pod install` and then xcodebuild, the project is exactly what it is on a developer's Mac
# right after `npm run build:mobile`.
#
# None of the EAS bridge symlinks (ios/App.xcodeproj, ios/Podfile, the plist/entitlements
# links) are touched or needed here: Xcode Cloud builds ios/App/App.xcworkspace directly and
# reads the real paths, which is the whole reason for coming here instead.
set -e

# Xcode Cloud starts in the ci_scripts directory. The repo root is two levels above frontend/.
FRONTEND="$CI_PRIMARY_REPOSITORY_PATH/frontend"
echo "post-clone: building the web app in $FRONTEND"

# Node is not preinstalled on the runner. Homebrew is; install a pinned major so a runner image
# refresh cannot silently change the toolchain under us.
if ! command -v node >/dev/null 2>&1; then
  echo "post-clone: installing Node via Homebrew"
  export HOMEBREW_NO_AUTO_UPDATE=1
  export HOMEBREW_NO_INSTALL_CLEANUP=1
  brew install node@22
  # brew keeps versioned formulae off the PATH; add it for this build.
  export PATH="$(brew --prefix node@22)/bin:$PATH"
fi
echo "post-clone: node $(node -v), npm $(npm -v)"

cd "$FRONTEND"

# npm ci, not install: reproducible from the lockfile, and it fails rather than silently
# resolving a different tree if package.json and the lock disagree.
npm ci --no-audit --no-fund

# The same build the App Store flavour uses: talks to the deployed API, pulls media off the CDN
# instead of shipping ~140 MB into the app, then `cap sync` copies dist/ into App/public and
# runs pod install inside ios/App. Keep these in step with the build:mobile script in
# package.json — they are the same variables on purpose.
export VITE_MOBILE=1
export VITE_API_BASE=https://mygym.rlz.cl
export VITE_IMG_BASE=https://cdn.jsdelivr.net/gh/hasaneyldrm/exercises-dataset@7455efae41b330c265e7cd4b78dfa848e7ce5ebd/images/
export VITE_GIF_BASE=https://cdn.jsdelivr.net/gh/hasaneyldrm/exercises-dataset@7455efae41b330c265e7cd4b78dfa848e7ce5ebd/videos/

npx vite build
npx cap sync ios

echo "post-clone: done — App/public and Pods are in place for xcodebuild"
