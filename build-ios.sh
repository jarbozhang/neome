#!/bin/bash
# Fix Ruby/CocoaPods environment for Expo builds
export GEM_HOME="$HOME/.gem/ruby/4.0.0"
export GEM_PATH="$HOME/.gem/ruby/4.0.0:/opt/homebrew/Cellar/ruby/4.0.1/lib/ruby/gems/4.0.0"
export PATH="/opt/homebrew/opt/ruby/bin:$HOME/.gem/ruby/4.0.0/bin:$PATH"

cd "$(dirname "$0")"
exec npx expo run:ios "$@"
