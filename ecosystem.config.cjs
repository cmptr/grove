module.exports = {
  apps: [
    {
      name: "grove-server",
      script: "src/server.ts",
      interpreter: "npx",
      interpreter_args: "tsx",
      kill_timeout: 15000,
      env: {
        GROVE_VAULT: process.env.HOME + "/life",
        GROVE_SERVER_PORT: 8190,
      },
    },
    {
      name: "grove-proxy",
      script: "src/proxy.ts",
      interpreter: "npx",
      interpreter_args: "tsx",
      kill_timeout: 15000,
      env: {
        GROVE_PORT: 8420,
        QMD_PORT: 8181,
        GROVE_SERVER_PORT: 8190,
      },
    },
  ],
};
