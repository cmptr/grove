const fs = require("node:fs");
const path = require("node:path");

function loadDotenv(file) {
  try {
    const text = fs.readFileSync(path.join(__dirname, file), "utf8");
    const env = {};
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      env[key] = val;
    }
    return env;
  } catch {
    return {};
  }
}

const dotenv = loadDotenv(".env");

module.exports = {
  apps: [
    {
      name: "grove-server",
      script: "/bin/bash",
      args: "-c 'npx tsx src/server.ts'",
      cwd: __dirname,
      kill_timeout: 15000,
      env: {
        ...dotenv,
        GROVE_VAULT: process.env.HOME + "/life",
        GROVE_SERVER_PORT: 8190,
      },
    },
    {
      name: "grove-discovery",
      script: "/bin/bash",
      args: "-c 'npx tsx src/discovery-worker.ts'",
      cwd: __dirname,
      kill_timeout: 15000,
      env: {
        ...dotenv,
        GROVE_VAULT: process.env.HOME + "/life",
        ANTHROPIC_API_KEY: dotenv.ANTHROPIC_API_KEY || "",
      },
    },
    {
      name: "grove-proxy",
      script: "/bin/bash",
      args: "-c 'npx tsx src/proxy.ts'",
      cwd: __dirname,
      kill_timeout: 15000,
      env: {
        ...dotenv,
        GROVE_PORT: 8420,
        QMD_PORT: 8181,
        GROVE_SERVER_PORT: 8190,
      },
    },
  ],
};
