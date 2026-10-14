# Pick an Android device: honors ANDROID_SERIAL, otherwise prompts with fzf.
[private]
_pick-device:
    #!/usr/bin/env bash
    set -eu
    if [[ -n "${ANDROID_SERIAL:-}" ]]; then
      printf '%s\n' "$ANDROID_SERIAL"
      exit 0
    fi
    devices=()
    while IFS= read -r serial; do
      devices+=("$serial")
    done < <(adb devices | awk 'NR > 1 && $2 == "device" { print $1 }')
    if (( ${#devices[@]} == 0 )); then
      echo "No authorized adb devices. Allow USB debugging / plug in a device, or start Waydroid." >&2
      exit 1
    fi
    if (( ${#devices[@]} == 1 )); then
      printf '%s\n' "${devices[0]}"
      exit 0
    fi
    menu=""
    for serial in "${devices[@]}"; do
      model=$(adb -s "$serial" shell getprop ro.product.model 2>/dev/null | tr -d '\r') || true
      menu+="$serial"$'\t'"${model:-unknown}"$'\n'
    done
    choice=$(printf '%s' "$menu" | fzf --delimiter=$'\t' --with-nth=1,2 --prompt='Select device> ' --height=~20 --reverse || true)
    if [[ -z "$choice" ]]; then
      echo "No device selected." >&2
      exit 1
    fi
    cut -f1 <<<"$choice"

# Capture a screenshot from the selected Android device.
android-screenshot output="screenshot.png":
    #!/usr/bin/env bash
    set -euo pipefail
    serial=$(just _pick-device)
    echo "Using device: $serial" >&2
    adb -s "$serial" exec-out screencap -p > "{{output}}"
    echo "Saved screenshot to {{output}}" >&2

# Build/install the development client on the selected Android device (run once).
android-install:
    #!/usr/bin/env bash
    set -euo pipefail
    serial=$(just _pick-device)
    echo "Using device: $serial" >&2
    pnpm --dir apps/expo run android --device "$serial"

# Forward local dev services (AT Protocol + tRPC API) to the selected device.
reverse:
    #!/usr/bin/env bash
    set -euo pipefail
    serial=$(just _pick-device)
    echo "Using device: $serial" >&2
    for port in 2582 2583 2584 3000 8081; do
      adb -s "$serial" reverse "tcp:$port" "tcp:$port"
    done

alias waydroid-reverse := reverse

# Start Expo and open the app on the selected device.
expo:
    #!/usr/bin/env bash
    set -euo pipefail
    serial=$(just _pick-device)
    export ANDROID_SERIAL="$serial"
    echo "Using device: $serial" >&2
    for port in 2582 2583 2584 3000; do
      adb -s "$serial" reverse "tcp:$port" "tcp:$port"
    done
    exec pnpm --dir apps/expo dev:android

# Run the market bot against the local ATProto stack as bob.test.
market-bot-local:
    #!/usr/bin/env bash
    export MARKET_BOT_HANDLE="${MARKET_BOT_HANDLE:-bob.test}"
    export MARKET_BOT_APP_PASSWORD="${MARKET_BOT_APP_PASSWORD:-hunter2}"
    export ATPROTO_SERVICE_URL="${ATPROTO_SERVICE_URL:-http://localhost:2583}"
    export MARKET_BOT_DRY_RUN="${MARKET_BOT_DRY_RUN:-true}"
    exec pnpm dev:market-bot

expo-client:
    pnpm --dir apps/expo build:dev-client:android

# Build the ARM APK through the Nix-provided build script.
build-apk-arm:
    nix build .#android-apk
    ./result/bin/build-android-apk

# Build the x86_64 APK through the Nix-provided build script.
build-apk-x86:
    nix build .#android-apk-host
    ./result/bin/build-android-apk-host

# Build both ARM and x86_64 APKs.
build-apk: build-apk-arm build-apk-x86

# Override with ANDROID_KEYSTORE, ANDROID_KEY_ALIAS, ANDROID_KEYSTORE_PASSWORD,
# and ANDROID_KEY_PASSWORD to target a release/upload keystore.
# Print the SHA-256 fingerprint of an Android signing cert (debug by default).
android-cert-sha256:
    #!/usr/bin/env bash
    set -euo pipefail
    keystore="${ANDROID_KEYSTORE:-apps/expo/android/app/debug.keystore}"
    alias="${ANDROID_KEY_ALIAS:-androiddebugkey}"
    storepass="${ANDROID_KEYSTORE_PASSWORD:-android}"
    keypass="${ANDROID_KEY_PASSWORD:-android}"
    if [[ ! -f "$keystore" ]]; then
      echo "No keystore at $keystore." >&2
      echo "Run 'pnpm --filter @kites-social/app prebuild' first, or set ANDROID_KEYSTORE." >&2
      exit 1
    fi
    if ! output=$(keytool -list -v \
      -keystore "$keystore" \
      -alias "$alias" \
      -storepass "$storepass" \
      -keypass "$keypass" 2>&1); then
      echo "$output" >&2
      exit 1
    fi
    printf '%s\n' "$output" \
      | awk -F': +' '/SHA256:/ { print $2; found=1 } END { exit found ? 0 : 1 }'

# Export the committed repository and atomically replace the remote checkout.
# Set DEPLOY_HOST, and optionally DEPLOY_USER, DEPLOY_PATH, DEPLOY_KEY, and DEPLOY_REF.
deploy:
    #!/usr/bin/env bash
    set -euo pipefail
    : "${DEPLOY_HOST:?Set DEPLOY_HOST to the server hostname or IP}"
    deploy_user="${DEPLOY_USER:-ubuntu}"
    deploy_path="${DEPLOY_PATH:-/home/ubuntu/kites}"
    deploy_ref="${DEPLOY_REF:-HEAD}"
    remote_archive="/tmp/kites-deploy-$$.tar.gz"
    archive=$(mktemp --suffix=.tar.gz)
    ssh_opts=(-F /dev/null -o BatchMode=yes)
    if [[ -n "${DEPLOY_KEY:-}" ]]; then
      ssh_opts+=(-i "$DEPLOY_KEY")
    fi
    remote="$deploy_user@$DEPLOY_HOST"
    commit=$(git rev-parse "$deploy_ref^{commit}")
    commit_short=$(git rev-parse --short "$commit")
    commit_subject=$(git log -1 --format=%s "$commit")

    cleanup() {
      rm -f "$archive"
      ssh "${ssh_opts[@]}" "$remote" rm -f "$remote_archive" >/dev/null 2>&1 || true
    }
    trap cleanup EXIT

    printf '[deploy] commit: %s %s\n' "$commit_short" "$commit_subject"
    printf '[deploy] target: %s:%s\n' "$remote" "$deploy_path"
    printf '[deploy] creating tar archive...\n'
    git archive --format=tar.gz --prefix=repo/ "$deploy_ref" >"$archive"
    printf '[deploy] archive size: %s\n' "$(du -h "$archive" | cut -f1)"
    printf '[deploy] copying archive to server...\n'
    scp "${ssh_opts[@]}" "$archive" "$remote:$remote_archive"
    printf '[deploy] archive copied\n'
    ssh "${ssh_opts[@]}" "$remote" bash -s -- "$remote_archive" "$deploy_path" <<'REMOTE'
    set -euo pipefail
    archive=$1
    target=$2
    staging="${target}.staging.$$"
    previous="${target}.previous.$$"
    printf '[deploy] preparing staging directory: %s\n' "$staging"
    rm -rf "$staging" "$previous"
    mkdir -p "$staging"
    printf '[deploy] extracting archive...\n'
    tar -xzf "$archive" -C "$staging" --strip-components=1
    if [ -f "$target/.env" ]; then
      printf '[deploy] preserving remote .env\n'
      install -m 600 "$target/.env" "$staging/.env"
    fi
    cd "$staging"
    printf '[deploy] installing dependencies with pnpm...\n'
    pnpm install --frozen-lockfile
    printf '[deploy] generating Prisma client...\n'
    pnpm --filter '@kites-social/db' db:generate
    printf '[deploy] building Next.js application...\n'
    CI=1 NODE_OPTIONS=--max-old-space-size=384 pnpm --filter '@kites-social/nextjs' build
    standalone="$staging/apps/nextjs/.next/standalone"
    standalone_app="$standalone/apps/nextjs"
    printf '[deploy] preparing standalone runtime...\n'
    test -f "$standalone_app/server.js"
    mkdir -p "$standalone_app/.next"
    rm -rf "$standalone_app/.next/static"
    cp -a "$staging/apps/nextjs/.next/static" "$standalone_app/.next/static"
    if [ -d "$staging/apps/nextjs/public" ]; then
      rm -rf "$standalone_app/public"
      cp -a "$staging/apps/nextjs/public" "$standalone_app/public"
    fi
    printf '[deploy] activating new checkout...\n'
    if [ -e "$target" ]; then
      mv "$target" "$previous"
    fi
    mv "$staging" "$target"
    mkdir -p "$HOME/.config/systemd/user"
    {
      printf '%s\n' \
        '[Unit]' \
        'Description=Kites Next.js application' \
        'Wants=network-online.target' \
        'After=network-online.target' \
        '' \
        '[Service]' \
        'Type=simple' \
        "WorkingDirectory=$target/apps/nextjs/.next/standalone/apps/nextjs" \
        'Environment=NODE_ENV=production' \
        'Environment=NODE_USE_ENV_PROXY=1' \
        'Environment=NODE_OPTIONS=--max-old-space-size=384' \
        'Environment=HOSTNAME=127.0.0.1' \
        'Environment=PORT=3000' \
        "EnvironmentFile=-$target/.env" \
        "ExecStart=/usr/bin/node $target/apps/nextjs/.next/standalone/apps/nextjs/server.js" \
        'Restart=on-failure' \
        'RestartSec=5' \
        '' \
        '[Install]' \
        'WantedBy=default.target'
    } > "$HOME/.config/systemd/user/kites-nextjs.service"
    systemctl --user daemon-reload
    systemctl --user enable kites-nextjs.service >/dev/null
    printf '[deploy] restarting systemd user service...\n'
    if ! systemctl --user restart kites-nextjs.service; then
      printf '[deploy] service failed; rolling back checkout\n' >&2
      rm -rf "$target"
      if [ -e "$previous" ]; then
        mv "$previous" "$target"
        systemctl --user restart kites-nextjs.service || true
      fi
      exit 1
    fi
    if ! systemctl --user is-active --quiet kites-nextjs.service; then
      printf '[deploy] service is not active; rolling back checkout\n' >&2
      systemctl --user status kites-nextjs.service --no-pager || true
      rm -rf "$target"
      if [ -e "$previous" ]; then
        mv "$previous" "$target"
        systemctl --user restart kites-nextjs.service || true
      fi
      exit 1
    fi
    rm -rf "$previous"
    rm -f "$archive"
    printf '[deploy] remote extraction, build, and restart complete\n'
    REMOTE

    printf '[deploy] deployment complete: %s:%s\n' "$remote" "$deploy_path"

# Build the standalone Next.js runtime locally in a Linux container and deploy it.
# Set DEPLOY_HOST, and optionally DEPLOY_USER, DEPLOY_PATH, DEPLOY_KEY, DEPLOY_REF, and DEPLOY_DOCKER.
deploy-local:
    #!/usr/bin/env bash
    set -euo pipefail
    : "${DEPLOY_HOST:?Set DEPLOY_HOST to the server hostname or IP}"
    deploy_user="${DEPLOY_USER:-ubuntu}"
    deploy_path="${DEPLOY_PATH:-/home/ubuntu/kites}"
    deploy_ref="${DEPLOY_REF:-HEAD}"
    docker_bin="${DEPLOY_DOCKER:-docker}"
    remote_archive="/tmp/kites-nextjs-standalone-$$.tar.gz"
    source_dir=$(mktemp -d)
    archive=$(mktemp --suffix=.tar.gz)
    ssh_opts=(-F /dev/null -o BatchMode=yes)
    if [[ -n "${DEPLOY_KEY:-}" ]]; then
      ssh_opts+=(-i "$DEPLOY_KEY")
    fi
    remote="$deploy_user@$DEPLOY_HOST"

    cleanup() {
      rm -rf "$source_dir" "$archive"
      ssh "${ssh_opts[@]}" "$remote" rm -f "$remote_archive" >/dev/null 2>&1 || true
    }
    trap cleanup EXIT

    commit=$(git rev-parse "$deploy_ref^{commit}")
    commit_short=$(git rev-parse --short "$commit")
    commit_subject=$(git log -1 --format=%s "$commit")
    printf '[deploy-local] commit: %s %s\n' "$commit_short" "$commit_subject"
    printf '[deploy-local] exporting source for container build...\n'
    git archive "$deploy_ref" | tar -x -C "$source_dir"
    if [[ -f .env ]]; then
      install -m 600 .env "$source_dir/.env"
    else
      printf '%s\n' 'NODE_ENV=production' 'SKIP_ENV_VALIDATION=1' >"$source_dir/.env"
      chmod 600 "$source_dir/.env"
    fi
    printf '[deploy-local] building in Node 22 Linux container...\n'
    "$docker_bin" run --rm \
      --user "$(id -u):$(id -g)" \
      -e HOME=/tmp/kites-home \
      -e COREPACK_HOME=/tmp/kites-corepack \
      -e SKIP_ENV_VALIDATION=1 \
      -v "$source_dir:/workspace" \
      -w /workspace \
      node:22-bookworm \
      bash -lc '
        set -euo pipefail
        mkdir -p "$HOME" "$COREPACK_HOME" /tmp/kites-bin
        corepack enable --install-directory /tmp/kites-bin
        export PATH="/tmp/kites-bin:$PATH"
        pnpm install --frozen-lockfile
        pnpm --filter "@kites-social/db" db:generate
        CI=1 NODE_OPTIONS=--max-old-space-size=1024 pnpm --filter "@kites-social/nextjs" build
      '
    standalone="$source_dir/apps/nextjs/.next/standalone"
    standalone_app="$standalone/apps/nextjs"
    test -f "$standalone_app/server.js"
    mkdir -p "$standalone_app/.next"
    rm -rf "$standalone_app/.next/static"
    cp -a "$source_dir/apps/nextjs/.next/static" "$standalone_app/.next/static"
    if [[ -d "$source_dir/apps/nextjs/public" ]]; then
      rm -rf "$standalone_app/public"
      cp -a "$source_dir/apps/nextjs/public" "$standalone_app/public"
    fi
    printf '[deploy-local] packaging standalone runtime...\n'
    tar -C "$standalone" -czf "$archive" .
    printf '[deploy-local] artifact size: %s\n' "$(du -h "$archive" | cut -f1)"
    printf '[deploy-local] copying artifact to server...\n'
    scp "${ssh_opts[@]}" "$archive" "$remote:$remote_archive"
    ssh "${ssh_opts[@]}" "$remote" bash -s -- "$remote_archive" "$deploy_path" <<'REMOTE'
    set -euo pipefail
    archive=$1
    target=$2
    artifact="$target/apps/nextjs/.next/standalone"
    staging="${artifact}.staging.$$"
    previous="${artifact}.previous.$$"
    printf '[deploy-local] preparing artifact directory: %s\n' "$staging"
    rm -rf "$staging" "$previous"
    mkdir -p "$staging"
    printf '[deploy-local] extracting standalone artifact...\n'
    tar -xzf "$archive" -C "$staging"
    if [ -e "$artifact" ]; then
      mv "$artifact" "$previous"
    fi
    mv "$staging" "$artifact"
    mkdir -p "$HOME/.config/systemd/user"
    {
      printf '%s\n' \
        '[Unit]' \
        'Description=Kites Next.js application' \
        'Wants=network-online.target' \
        'After=network-online.target' \
        '' \
        '[Service]' \
        'Type=simple' \
        "WorkingDirectory=$artifact/apps/nextjs" \
        'Environment=NODE_ENV=production' \
        'Environment=NODE_USE_ENV_PROXY=1' \
        'Environment=NODE_OPTIONS=--max-old-space-size=384' \
        'Environment=HOSTNAME=127.0.0.1' \
        'Environment=PORT=3000' \
        "EnvironmentFile=-$target/.env" \
        "ExecStart=/usr/bin/node $artifact/apps/nextjs/server.js" \
        'Restart=on-failure' \
        'RestartSec=5' \
        '' \
        '[Install]' \
        'WantedBy=default.target'
    } > "$HOME/.config/systemd/user/kites-nextjs.service"
    systemctl --user daemon-reload
    systemctl --user enable kites-nextjs.service >/dev/null
    printf '[deploy-local] restarting systemd user service...\n'
    if ! systemctl --user restart kites-nextjs.service || ! systemctl --user is-active --quiet kites-nextjs.service; then
      printf '[deploy-local] service failed; rolling back artifact\n' >&2
      systemctl --user status kites-nextjs.service --no-pager || true
      rm -rf "$artifact"
      if [ -e "$previous" ]; then
        mv "$previous" "$artifact"
        systemctl --user restart kites-nextjs.service || true
      fi
      exit 1
    fi
    rm -rf "$previous"
    rm -f "$archive"
    printf '[deploy-local] standalone artifact and service restart complete\n'
    REMOTE

    printf '[deploy-local] deployment complete: %s:%s\n' "$remote" "$deploy_path"

# Build the market bot locally in a Linux container and deploy its bundled worker.
# Set DEPLOY_HOST, and optionally DEPLOY_USER, DEPLOY_PATH, DEPLOY_KEY, DEPLOY_REF, and DEPLOY_DOCKER.
deploy-market-bot-local:
    #!/usr/bin/env bash
    set -euo pipefail
    : "${DEPLOY_HOST:?Set DEPLOY_HOST to the server hostname or IP}"
    deploy_user="${DEPLOY_USER:-ubuntu}"
    deploy_path="${DEPLOY_PATH:-/home/ubuntu/kites}"
    deploy_ref="${DEPLOY_REF:-HEAD}"
    docker_bin="${DEPLOY_DOCKER:-docker}"
    remote_archive="/tmp/kites-market-bot-$$.tar.gz"
    source_dir=$(mktemp -d)
    archive=$(mktemp --suffix=.tar.gz)
    ssh_opts=(-F /dev/null -o BatchMode=yes)
    if [[ -n "${DEPLOY_KEY:-}" ]]; then
      ssh_opts+=(-i "$DEPLOY_KEY")
    fi
    remote="$deploy_user@$DEPLOY_HOST"

    cleanup() {
      rm -rf "$source_dir" "$archive"
      ssh "${ssh_opts[@]}" "$remote" rm -f "$remote_archive" >/dev/null 2>&1 || true
    }
    trap cleanup EXIT

    commit=$(git rev-parse "$deploy_ref^{commit}")
    commit_short=$(git rev-parse --short "$commit")
    commit_subject=$(git log -1 --format=%s "$commit")
    printf '[deploy-market-bot] commit: %s %s\n' "$commit_short" "$commit_subject"
    printf '[deploy-market-bot] exporting source for container build...\n'
    git archive "$deploy_ref" | tar -x -C "$source_dir"
    printf '[deploy-market-bot] building in Node 24 Linux container...\n'
    "$docker_bin" run --rm \
      --user "$(id -u):$(id -g)" \
      -e HOME=/tmp/kites-home \
      -e COREPACK_HOME=/tmp/kites-corepack \
      -v "$source_dir:/workspace" \
      -w /workspace \
      node:24-bookworm \
      bash -lc '
        set -euo pipefail
        mkdir -p "$HOME" "$COREPACK_HOME" /tmp/kites-bin
        corepack enable --install-directory /tmp/kites-bin
        export PATH="/tmp/kites-bin:$PATH"
        pnpm install --filter "@kites-social/market-bot..." --frozen-lockfile
        pnpm --filter "@kites-social/market-bot" build
      '
    test -f "$source_dir/apps/market-bot/dist/index.cjs"
    printf '[deploy-market-bot] packaging bundled worker...\n'
    tar -C "$source_dir/apps/market-bot/dist" -czf "$archive" .
    printf '[deploy-market-bot] artifact size: %s\n' "$(du -h "$archive" | cut -f1)"
    printf '[deploy-market-bot] copying artifact to server...\n'
    scp "${ssh_opts[@]}" "$archive" "$remote:$remote_archive"
    ssh "${ssh_opts[@]}" "$remote" bash -s -- "$remote_archive" "$deploy_path" <<'REMOTE'
    set -euo pipefail
    archive=$1
    target=$2
    artifact="$target/apps/market-bot/dist"
    staging="${artifact}.staging.$$"
    previous="${artifact}.previous.$$"
    data_dir="$HOME/.local/share/kites"
    printf '[deploy-market-bot] preparing artifact directory: %s\n' "$staging"
    rm -rf "$staging" "$previous"
    mkdir -p "$staging" "$data_dir"
    printf '[deploy-market-bot] extracting bundled worker...\n'
    tar -xzf "$archive" -C "$staging"
    if [ -e "$artifact" ]; then
      mv "$artifact" "$previous"
    fi
    mv "$staging" "$artifact"
    if [ -f "$target/apps/market-bot/market-bot.sqlite" ] && [ ! -f "$data_dir/market-bot.sqlite" ]; then
      printf '[deploy-market-bot] migrating existing SQLite database...\n'
      cp -a "$target/apps/market-bot/market-bot.sqlite" "$data_dir/market-bot.sqlite"
      for suffix in -shm -wal; do
        if [ -f "$target/apps/market-bot/market-bot.sqlite$suffix" ]; then
          cp -a "$target/apps/market-bot/market-bot.sqlite$suffix" "$data_dir/market-bot.sqlite$suffix"
        fi
      done
    fi
    mkdir -p "$HOME/.config/systemd/user"
    {
      printf '%s\n' \
        '[Unit]' \
        'Description=Kites market bot' \
        'Wants=network-online.target' \
        'After=network-online.target' \
        '' \
        '[Service]' \
        'Type=simple' \
        "WorkingDirectory=$target/apps/market-bot" \
        "EnvironmentFile=-$target/.env" \
        "Environment=MARKET_BOT_DATABASE_PATH=$data_dir/market-bot.sqlite" \
        "ExecStart=/usr/bin/node $artifact/index.cjs" \
        'Restart=on-failure' \
        'RestartSec=10' \
        '' \
        '[Install]' \
        'WantedBy=default.target'
    } > "$HOME/.config/systemd/user/kites-market-bot.service"
    systemctl --user daemon-reload
    systemctl --user enable kites-market-bot.service >/dev/null
    printf '[deploy-market-bot] restarting systemd user service...\n'
    if ! systemctl --user restart kites-market-bot.service || ! systemctl --user is-active --quiet kites-market-bot.service; then
      printf '[deploy-market-bot] service failed; rolling back artifact\n' >&2
      systemctl --user status kites-market-bot.service --no-pager || true
      rm -rf "$artifact"
      if [ -e "$previous" ]; then
        mv "$previous" "$artifact"
        systemctl --user restart kites-market-bot.service || true
      fi
      exit 1
    fi
    rm -rf "$previous"
    rm -f "$archive"
    printf '[deploy-market-bot] artifact and service restart complete\n'
    REMOTE

    printf '[deploy-market-bot] deployment complete: %s:%s\n' "$remote" "$deploy_path"

# Export HEAD to a zip, then create a one-commit Git repository beside this one.
single-commit:
    #!/usr/bin/env bash
    set -euo pipefail
    root=$(git rev-parse --show-toplevel)
    archive="${SINGLE_COMMIT_ARCHIVE:-$root/../single-commit.zip}"
    target="${SINGLE_COMMIT_TARGET:-$root/../single-commit}"
    author_name="${SINGLE_COMMIT_AUTHOR_NAME:-Cantaloupe Bob}"
    author_email="${SINGLE_COMMIT_AUTHOR_EMAIL:-cantaloupebob@proton.me}"
    coauthor_name="${SINGLE_COMMIT_COAUTHOR_NAME:-0xferrous}"
    coauthor_email="${SINGLE_COMMIT_COAUTHOR_EMAIL:-0xferrous@proton.me}"

    rm -rf "$target"
    rm -f "$archive"
    git archive --format=zip --output="$archive" HEAD
    mkdir -p "$target"
    unzip -q "$archive" -d "$target"
    git -C "$target" init -q
    git -C "$target" add --all
    GIT_AUTHOR_NAME="$author_name" \
    GIT_AUTHOR_EMAIL="$author_email" \
    GIT_COMMITTER_NAME="$author_name" \
    GIT_COMMITTER_EMAIL="$author_email" \
      git -C "$target" commit -q \
        -m 'init' \
        -m "Co-authored-by: $coauthor_name <$coauthor_email>"
    printf 'Created %s from %s\n' "$target" "$archive"
