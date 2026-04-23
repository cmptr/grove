{
  description = "Grove — hosted MCP knowledge API for Obsidian vaults";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    let
      systemOutputs = flake-utils.lib.eachSystem [ "x86_64-linux" "aarch64-linux" ] (system:
      let
        pkgs = import nixpkgs { inherit system; };

        nodejs = pkgs.nodejs_22;

        # Runtime PATH for all grove entrypoints.
        # Note: qmd is expected on the host PATH (installed via system nixos config),
        # so it is not pinned here.
        runtimeDeps = [ nodejs pkgs.git ];

        # Build-time deps required to compile better-sqlite3 from source.
        nativeBuildDeps = with pkgs; [
          python3
          nodejs
          pkg-config
          gnumake
          gcc
          node-gyp
        ];

        grove = pkgs.buildNpmPackage {
          pname = "grove";
          version = "1.0.0";

          src = ./.;

          # First build will fail and print the correct hash; paste it back here.
          npmDepsHash = "sha256-dO81ywHQtSvQGirGXijoF75+l4vnLiwqCKpBmmGVH+Y=";

          nativeBuildInputs = nativeBuildDeps ++ [ pkgs.makeWrapper ];

          # Force native compile of better-sqlite3 against nixpkgs libs;
          # the upstream prebuilt binaries target a different glibc.
          npmFlags = [ "--ignore-scripts=false" ];
          env.npm_config_build_from_source = "true";

          # No "build" script in package.json — runtime uses tsx directly.
          dontNpmBuild = true;

          # tsx lives in devDependencies and is required at runtime (wrappers
          # launch node with --import tsx). Default prune strips devDeps, which
          # breaks the wrappers with ERR_MODULE_NOT_FOUND for 'tsx'.
          dontNpmPrune = true;

          installPhase = ''
            runHook preInstall

            mkdir -p $out/lib/grove $out/bin
            cp -r src scripts bin package.json package-lock.json tsconfig.json $out/lib/grove/
            cp -r node_modules $out/lib/grove/

            # Wrap each entrypoint so they launch with a controlled PATH.
            makeWrapper ${nodejs}/bin/node $out/bin/grove-server \
              --add-flags "--import file://$out/lib/grove/node_modules/tsx/dist/loader.mjs $out/lib/grove/src/server.ts" \
              --prefix PATH : ${pkgs.lib.makeBinPath runtimeDeps} \
              --set NODE_PATH $out/lib/grove/node_modules

            makeWrapper ${nodejs}/bin/node $out/bin/grove-proxy \
              --add-flags "--import file://$out/lib/grove/node_modules/tsx/dist/loader.mjs $out/lib/grove/src/proxy.ts" \
              --prefix PATH : ${pkgs.lib.makeBinPath runtimeDeps} \
              --set NODE_PATH $out/lib/grove/node_modules

            makeWrapper ${nodejs}/bin/node $out/bin/grove-discovery \
              --add-flags "--import file://$out/lib/grove/node_modules/tsx/dist/loader.mjs $out/lib/grove/src/discovery-worker.ts" \
              --prefix PATH : ${pkgs.lib.makeBinPath runtimeDeps} \
              --set NODE_PATH $out/lib/grove/node_modules

            makeWrapper ${nodejs}/bin/node $out/bin/grove-keys \
              --add-flags "--import file://$out/lib/grove/node_modules/tsx/dist/loader.mjs $out/lib/grove/src/keys.ts" \
              --prefix PATH : ${pkgs.lib.makeBinPath runtimeDeps} \
              --set NODE_PATH $out/lib/grove/node_modules

            makeWrapper ${nodejs}/bin/node $out/bin/grove \
              --add-flags "--import file://$out/lib/grove/node_modules/tsx/dist/loader.mjs $out/lib/grove/src/cli.ts" \
              --prefix PATH : ${pkgs.lib.makeBinPath runtimeDeps} \
              --set NODE_PATH $out/lib/grove/node_modules

            runHook postInstall
          '';

          meta = with pkgs.lib; {
            description = "Hosted MCP knowledge API for Obsidian vaults";
            homepage = "https://grove.md";
            license = licenses.mit;
            platforms = [ "x86_64-linux" "aarch64-linux" ];
            mainProgram = "grove-proxy";
          };
        };
      in
      {
        packages = {
          default = grove;
          grove = grove;
        };

        apps = {
          default = {
            type = "app";
            program = "${grove}/bin/grove-proxy";
          };
          grove-server = {
            type = "app";
            program = "${grove}/bin/grove-server";
          };
          grove-proxy = {
            type = "app";
            program = "${grove}/bin/grove-proxy";
          };
          grove-discovery = {
            type = "app";
            program = "${grove}/bin/grove-discovery";
          };
          grove-keys = {
            type = "app";
            program = "${grove}/bin/grove-keys";
          };
          grove = {
            type = "app";
            program = "${grove}/bin/grove";
          };
        };

        devShells.default = pkgs.mkShell {
          packages = runtimeDeps ++ nativeBuildDeps ++ (with pkgs; [
            sqlite
            bats
          ]);

          # Force source build of better-sqlite3 so it links against
          # nixpkgs' glibc instead of the upstream prebuilt.
          env.npm_config_build_from_source = "true";

          shellHook = ''
            echo "grove devShell — node $(node --version), git $(git --version | cut -d' ' -f3)"
            echo "qmd: $(command -v qmd || echo 'NOT FOUND on PATH — install via nixos config')"
            echo ""
            echo "Env vars you may need:"
            echo "  GROVE_VAULT           path to obsidian vault (required)"
            echo "  GROVE_ADMIN_EMAIL     admin email for key management"
            echo "  GROVE_ADMIN_KEY       admin bearer token"
            echo "  VOYAGE_API_KEY        optional; BM25-only if absent"
            echo "  QMD_PORT              default 8177"
            echo "  GROVE_PORT            proxy port, default 8420"
            echo "  GROVE_SERVER_PORT     server port, default 8190"
            echo ""
            echo "Common commands:"
            echo "  npm install           install deps (compiles better-sqlite3)"
            echo "  npm run proxy         start auth proxy"
            echo "  npm run typecheck     tsc --noEmit"
            echo "  npm test              vitest"
          '';
        };

        checks = {
          typecheck = pkgs.runCommand "grove-typecheck" {
            buildInputs = [ nodejs ];
          } ''
            cp -r ${grove}/lib/grove/* .
            chmod -R +w .
            ${nodejs}/bin/node node_modules/.bin/tsc --noEmit
            touch $out
          '';
        };
      });
    in
    systemOutputs // {
      nixosModules.grove = import ./nix/module.nix { inherit self; };
      nixosModules.default = import ./nix/module.nix { inherit self; };
      overlays.default = final: prev: {
        grove = systemOutputs.packages.${prev.system}.grove;
      };
    };
}
