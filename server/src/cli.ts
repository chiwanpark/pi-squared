#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { createPiSquaredServer } from "./http-server.js";
import { SessionStore } from "./session-store.js";

const config = loadConfig();
const store = new SessionStore(config.sessionsDir);
const { server } = createPiSquaredServer({ secret: config.secret, store });

server.listen(config.port, config.host, () => {
  console.log(`pi-squared server listening on http://${config.host}:${config.port}`);
  console.log(`recording agent sessions in ${config.sessionsDir}`);
});

function shutdown(signal: NodeJS.Signals): void {
  console.log(`received ${signal}; shutting down pi-squared server`);
  server.close((error) => {
    if (error !== undefined) {
      console.error(error);
      process.exitCode = 1;
    }

    process.exit();
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
