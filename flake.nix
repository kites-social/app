{
  description = "Kites - Bluesky client monorepo development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config = {
            # The Android SDK is unfree and its license must be accepted.
            allowUnfree = true;
            android_sdk.accept_license = true;
          };
        };

        inherit (pkgs) lib stdenv;
        isLinux = stdenv.hostPlatform.isLinux;
        isX86_64Linux = isLinux && stdenv.hostPlatform.isx86_64;

        # NixOS isn't a Prisma download target. Use Prisma's compatible Debian
        # OpenSSL 3 engines in the dev shell.
        prismaEngineTarget = "debian-openssl-3.0.x";

        # The monorepo targets Node 22 (.nvmrc says 22); Effect 4 requires
        # Node >= 22.18, and this current LTS package satisfies that.
        nodejs = pkgs.nodejs_22;

        # The repo pins the package manager in package.json (`packageManager`:
        # pnpm@9.15.4). pnpm 9 is EOL and flagged insecure in nixpkgs, and
        # pnpm 10 no longer runs dependency lifecycle scripts (Expo's
        # postinstall, native builds) by default. So let corepack provision the
        # exact pinned version instead of shipping a pnpm from nixpkgs.
        corepack = pkgs.corepack;
        pnpm = pkgs.writeShellScriptBin "pnpm" ''
          export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
          exec ${corepack}/bin/corepack pnpm "$@"
        '';
        pnpx = pkgs.writeShellScriptBin "pnpx" ''
          export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
          exec ${corepack}/bin/corepack pnpm dlx "$@"
        '';

        # Browser automation for rendering every screen in the design
        # reference. Keep Chromium in Nix and use puppeteer-core so npm does
        # not download a second browser into the checkout.
        mockupCapture = pkgs.writeShellApplication {
          name = "capture-kites-mockup";
          runtimeInputs = [
            nodejs
            pkgs.chromium
          ];
          text = ''
            project_root="$PWD"
            script="$project_root/tooling/capture-kites-mockup.mjs"
            if [ ! -f "$script" ]; then
              echo "error: run this command from the Kites repository root." >&2
              exit 2
            fi

            export PUPPETEER_EXECUTABLE_PATH="${pkgs.chromium}/bin/chromium"
            exec node "$script" "$@"
          '';
        };

        # Android SDK pinned to the versions Expo SDK 54 / React Native 0.81
        # expect (compileSdk 36, build-tools 36.0.0, NDK 27.1.12297006,
        # CMake 3.22.1).
        androidSdk = pkgs.androidenv.composeAndroidPackages {
          cmdLineToolsVersion = "latest";
          platformToolsVersion = "36.0.1";
          # AGP defaults some modules to build-tools 35.0.0 even when the app
          # itself uses 36.0.0, so ship both (plus 34.0.0 for older libs).
          buildToolsVersions = [
            "34.0.0"
            "35.0.0"
            "36.0.0"
          ];
          platformVersions = [
            "34"
            "35"
            "36"
          ];
          includeNDK = true;
          ndkVersions = [ "27.1.12297006" ];
          includeCmake = true;
          cmakeVersions = [ "3.22.1" ];
          includeEmulator = false;
          includeSystemImages = false;
        };
        androidHome = "${androidSdk.androidsdk}/libexec/android-sdk";
        androidNdk = "${androidHome}/ndk/27.1.12297006";

        # Dynamically linked native addons (Prisma's query engine, node-gyp
        # builds) need these discoverable at runtime on NixOS.
        runtimeLibs = with pkgs; [
          openssl
          zlib
          stdenv.cc.cc.lib
        ];

        androidEnv = {
          ANDROID_HOME = androidHome;
          ANDROID_SDK_ROOT = androidHome;
          ANDROID_NDK_HOME = androidNdk;
          ANDROID_NDK_ROOT = androidNdk;
          JAVA_HOME = "${pkgs.jdk17}";
        };

        # ABI a host-side emulator runs: x86_64 on Intel, arm64 on Apple
        # Silicon / ARM Linux.
        hostAbi = if stdenv.hostPlatform.isx86_64 then "x86_64" else "arm64-v8a";

        androidBuildInputs =
          with pkgs;
          [
            nodejs
            pnpm
            jdk17
            gradle_8
            git
            openssl
            unzip
            zip
            bundletool
            androidSdk.androidsdk
          ]
          ++ lib.optionals isLinux [ gcc ];

        # Locally build a (debug-signed) release APK for the generated Gradle
        # project. `architectures` selects the native ABIs baked into the APK
        # and `apkFile` is where the result is copied in the repo root. These
        # are impure convenience wrappers: they need installed JS deps,
        # network access for Gradle, and google-services.json / .env.
        mkAndroidApk =
          {
            name,
            architectures,
            apkFile,
          }:
          pkgs.writeShellApplication {
            inherit name;
            runtimeInputs = androidBuildInputs;
            text = ''
              export ANDROID_HOME="${androidHome}"
              export ANDROID_SDK_ROOT="$ANDROID_HOME"
              export ANDROID_NDK_HOME="${androidNdk}"
              export ANDROID_NDK_ROOT="$ANDROID_NDK_HOME"
              export JAVA_HOME="${pkgs.jdk17}"
              export EXPO_NO_GIT_STATUS=1

              # Sentry's Gradle plugin fails the release build when it can't
              # authenticate. Skip source-map upload unless a token is provided.
              if [ -z "''${SENTRY_AUTH_TOKEN:-}" ]; then
                echo "warning: SENTRY_AUTH_TOKEN not set; skipping Sentry source-map upload." >&2
                export SENTRY_DISABLE_AUTO_UPLOAD=true
              fi

              project_root="''${1:-$PWD}"

              if [ ! -f "$project_root/package.json" ]; then
                echo "error: no package.json found in $project_root" >&2
                echo "usage: ${name} [path-to-kites-repo]" >&2
                exit 1
              fi

              cd "$project_root" || exit 1

              # Keep Gradle's cache and the Android user home on the same
              # filesystem as the working tree instead of a possibly small or
              # ephemeral $HOME.
              export GRADLE_USER_HOME="''${GRADLE_USER_HOME:-$project_root/.gradle}"
              export ANDROID_USER_HOME="''${ANDROID_USER_HOME:-$project_root/.android}"

              # Default ABIs for this package; override with e.g.
              #   ANDROID_APK_GRADLE_ARGS="-PreactNativeArchitectures=x86_64"
              export ANDROID_APK_GRADLE_ARGS="''${ANDROID_APK_GRADLE_ARGS:--PreactNativeArchitectures=${architectures}}"
              read -r -a extra_gradle_args <<< "$ANDROID_APK_GRADLE_ARGS"

              if [ ! -d node_modules ]; then
                echo "==> Installing JS dependencies"
                pnpm install --frozen-lockfile
              fi

              cd apps/expo || exit 1

              if [ ! -f google-services.json ] && [ -z "''${GOOGLE_SERVICES_JSON:-}" ]; then
                if [ -f google-services.json.example ]; then
                  echo "warning: apps/expo/google-services.json not found;" >&2
                  echo "         using google-services.json.example (push notifications won't work)." >&2
                  export GOOGLE_SERVICES_JSON="$PWD/google-services.json.example"
                else
                  echo "error: apps/expo/google-services.json not found." >&2
                  echo "       add it or set GOOGLE_SERVICES_JSON, then retry." >&2
                  exit 1
                fi
              fi

              echo "==> Generating the native Android project (${architectures})"
              pnpm exec expo prebuild --platform android --no-install --clean

              echo "==> Building the release APK"
              # Use Nix's Gradle instead of ./gradlew: the wrapper tries to
              # download a distribution from services.gradle.org with a short
              # timeout, which is unreliable. gradle_8 (8.14.4) is patch-
              # compatible with the project's pinned 8.14.3.
              ( cd android && gradle --no-daemon \
                  -Dorg.gradle.vfs.watch=false \
                  -Dorg.gradle.jvmargs="-Xmx4g -XX:MaxMetaspaceSize=1g" \
                  "''${extra_gradle_args[@]}" \
                  :app:assembleRelease )

              apk="$project_root/apps/expo/android/app/build/outputs/apk/release/app-release.apk"
              if [ ! -f "$apk" ]; then
                echo "error: build finished but no APK was produced at $apk" >&2
                exit 1
              fi

              cp -f "$apk" "$project_root/${apkFile}"

              echo ""
              echo "APK:  $apk"
              echo "copy: $project_root/${apkFile}"
            '';
          };
      in
      {
        formatter = pkgs.nixfmt;

        packages = {
          android-sdk = androidSdk.androidsdk;

          # Generic ARM build (what CI produces).
          android-apk = mkAndroidApk {
            name = "build-android-apk";
            architectures = "arm64-v8a,armeabi-v7a";
            apkFile = "artifacts/kites-arm.apk";
          };

          # Pixel / other modern arm64 phones.
          android-apk-pixel = mkAndroidApk {
            name = "build-android-apk-pixel";
            architectures = "arm64-v8a";
            apkFile = "artifacts/kites-pixel.apk";
          };

          # Host emulator: x86_64 on Intel, arm64 on Apple Silicon / ARM.
          android-apk-host = mkAndroidApk {
            name = "build-android-apk-host";
            architectures = hostAbi;
            apkFile = "artifacts/kites-x86.apk";
          };
        }
        // lib.optionalAttrs isLinux {
          mockup-capture = mockupCapture;
        };

        apps = lib.optionalAttrs isLinux {
          mockup-capture = {
            type = "app";
            program = "${mockupCapture}/bin/capture-kites-mockup";
          };
        };

        devShells.default = pkgs.mkShell {
          name = "kites";

          packages =
            with pkgs;
            [
              # JavaScript toolchain
              nodejs
              pnpm
              pnpx
              watchman

              # General tooling
              git
              jq
              fzf

              # Native module / Prisma build deps
              python3
              pkg-config
              openssl

              # Android build toolchain
              jdk17
              gradle_8
              # The SDK-bundled adb hangs on this Linux/NixOS host; use the
              # Nix-built client instead.
              android-tools
              androidSdk.androidsdk
              eas-cli
              bundletool
              zip
              unzip
            ]
            ++ lib.optionals isLinux [
              gcc
              docker-compose # brings up redis for the push-notifs service
            ];

          env = {
            TURBO_TELEMETRY_DISABLED = "1";
            DO_NOT_TRACK = "1";
            EXPO_NO_TELEMETRY = "1";

            # Corepack provisions pnpm on first use; never prompt for it.
            COREPACK_ENABLE_DOWNLOAD_PROMPT = "0";

            # Reuse the headers shipped with the Nix nodejs derivation instead
            # of letting node-gyp download them.
            npm_config_nodedir = "${nodejs}";

            # Let dynamically linked native modules find libssl/zlib.
            LD_LIBRARY_PATH = lib.makeLibraryPath runtimeLibs;

            # Download Prisma's supported Linux engine target instead of the
            # unavailable linux-nixos artifacts.
            PRISMA_CLI_BINARY_TARGETS = lib.optionalString isX86_64Linux prismaEngineTarget;
          }
          // androidEnv;

          shellHook = ''
            ${lib.optionalString isX86_64Linux ''
              # Prisma's npm package stores the engines in its shared cache.
              # Point the CLI at the Debian-compatible engines before client
              # generation; otherwise it tries to download linux-nixos files,
              # which Prisma does not publish.
              prisma_engine_dir="$(node --input-type=module -e '
                import { enginesVersion } from "@prisma/engines-version";
                import os from "node:os";
                import path from "node:path";
                console.log(path.join(os.homedir(), ".cache", "prisma", "master", enginesVersion, "${prismaEngineTarget}"));
              ')"
              export PRISMA_SCHEMA_ENGINE_BINARY="$prisma_engine_dir/schema-engine"
              PRISMA_QUERY_ENGINE_PATH="$PWD/node_modules/.prisma/client/libquery-engine"
              if [ -f "$PRISMA_QUERY_ENGINE_PATH" ]; then
                export PRISMA_QUERY_ENGINE_LIBRARY="$PRISMA_QUERY_ENGINE_PATH"
              elif [ -f "$prisma_engine_dir/libquery-engine" ]; then
                export PRISMA_QUERY_ENGINE_LIBRARY="$prisma_engine_dir/libquery-engine"
              else
                unset PRISMA_QUERY_ENGINE_LIBRARY
              fi
            ''}

            export GRADLE_USER_HOME="''${GRADLE_USER_HOME:-$PWD/.gradle}"
            export ANDROID_USER_HOME="''${ANDROID_USER_HOME:-$PWD/.android}"

            echo ""
            echo "  Kites — Bluesky client monorepo"
            echo "  ─────────────────────────────────"
            echo "    node  $(node --version)"
            echo "    pnpm  $(pnpm --version)"
            echo "    sdk   $ANDROID_HOME"
            echo ""

            if [ ! -f .env ]; then
              echo "  ⚠  No .env found — create one from the example:"
              echo "       cp .env.example .env"
              echo ""
            fi

            if [ ! -d node_modules ]; then
              echo "  ⚠  Dependencies not installed — run:"
              echo "       pnpm install"
              echo ""
            elif ${if isX86_64Linux then "[ ! -f \"$PRISMA_SCHEMA_ENGINE_BINARY\" ] || { [ ! -f \"$PRISMA_QUERY_ENGINE_PATH\" ] && [ ! -f \"$prisma_engine_dir/libquery-engine\" ]; }" else "false"}; then
              echo "  ⚠  Prisma's Nix-compatible engines are missing — run:"
              echo "       pnpm db:generate"
              echo ""
            fi
          '';
        };
      }
    );
}
