{ self }:
{ config, lib, pkgs, ... }:

let
  cfg = config.services.grove;
  defaultPackage = self.packages.${pkgs.system}.grove or null;
in
{
  options.services.grove = {
    enable = lib.mkEnableOption "Grove MCP knowledge API (user-scope systemd units)";

    user = lib.mkOption {
      type = lib.types.str;
      description = "User account to run Grove under. Units run user-scope via systemd user manager.";
      example = "atb";
    };

    package = lib.mkOption {
      type = lib.types.package;
      default = defaultPackage;
      description = "Grove package. Defaults to this flake's build for the host system.";
    };

    vault = lib.mkOption {
      type = lib.types.path;
      description = "Path to the Obsidian vault (GROVE_VAULT).";
      example = "/home/atb/life";
    };

    adminEmail = lib.mkOption {
      type = lib.types.str;
      description = "Admin email (GROVE_ADMIN_EMAIL).";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8420;
      description = "Auth proxy port (GROVE_PORT).";
    };

    serverPort = lib.mkOption {
      type = lib.types.port;
      default = 8190;
      description = "Backend server port (GROVE_SERVER_PORT).";
    };

    qmdPort = lib.mkOption {
      type = lib.types.port;
      default = 8181;
      description = "QMD MCP port (QMD_PORT). BM25 is served separately on its own port.";
    };

    qmdPackage = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = null;
      description = "Optional qmd package to put on the units' PATH. If null, qmd must be on the user's PATH.";
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        Path to a file with secret env vars (GROVE_ADMIN_KEY, VOYAGE_API_KEY,
        RESEND_API_KEY, GROVE_CSRF_SECRET, etc). File must be readable by the
        user running the unit. Not placed in the nix store.
      '';
      example = "/etc/grove.env";
    };

    discovery.enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Run the grove-discovery background worker (autowires wikilinks).";
    };

    extraEnvironment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "Extra non-secret environment variables to set on all Grove units.";
    };
  };

  config = lib.mkIf cfg.enable (
    let
      baseEnv = {
        GROVE_VAULT = toString cfg.vault;
        GROVE_ADMIN_EMAIL = cfg.adminEmail;
        GROVE_PORT = toString cfg.port;
        GROVE_SERVER_PORT = toString cfg.serverPort;
        QMD_PORT = toString cfg.qmdPort;
      } // cfg.extraEnvironment;

      pathPkgs = [ cfg.package pkgs.git ] ++ lib.optional (cfg.qmdPackage != null) cfg.qmdPackage;

      commonServiceConfig = {
        Restart = "on-failure";
        RestartSec = 5;
        StandardOutput = "journal";
        StandardError = "journal";
      } // lib.optionalAttrs (cfg.environmentFile != null) {
        EnvironmentFile = toString cfg.environmentFile;
      };

      pathSetting = { Environment = "PATH=${lib.makeBinPath pathPkgs}"; };
    in
    {
      assertions = [
        {
          assertion = cfg.package != null;
          message = "services.grove.package is null — this flake did not build for ${pkgs.system}, or you must set services.grove.package explicitly.";
        }
      ];

      users.users.${cfg.user}.linger = true;

      systemd.user.services.grove-server = {
        description = "Grove backend server";
        after = [ "network-online.target" ];
        wants = [ "network-online.target" ];
        wantedBy = [ "default.target" ];
        environment = baseEnv;
        serviceConfig = commonServiceConfig // pathSetting // {
          ExecStart = "${cfg.package}/bin/grove-server";
        };
      };

      systemd.user.services.grove-proxy = {
        description = "Grove auth proxy";
        after = [ "grove-server.service" "network-online.target" ];
        requires = [ "grove-server.service" ];
        wantedBy = [ "default.target" ];
        environment = baseEnv;
        serviceConfig = commonServiceConfig // pathSetting // {
          ExecStart = "${cfg.package}/bin/grove-proxy";
        };
      };

      systemd.user.services.grove-discovery = lib.mkIf cfg.discovery.enable {
        description = "Grove discovery worker (autowire wikilinks)";
        after = [ "grove-server.service" ];
        wantedBy = [ "default.target" ];
        environment = baseEnv;
        serviceConfig = commonServiceConfig // pathSetting // {
          ExecStart = "${cfg.package}/bin/grove-discovery";
        };
      };

      environment.systemPackages = [ cfg.package ];
    }
  );
}
