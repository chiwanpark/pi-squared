import { resolve } from "node:path";

export interface ServerConfig {
  host: string;
  port: number;
  secret: string;
  sessionsDir: string;
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);

  if (!Number.isInteger(port) || port < 1 || port > 65_535 || port.toString() !== value) {
    throw new Error(`Invalid server port: ${value}`);
  }

  return port;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const secret = env.PI_SQUARED_SERVER_SECRET;

  if (secret === undefined || secret.length === 0) {
    throw new Error("PI_SQUARED_SERVER_SECRET must be set.");
  }

  return {
    host: env.PI_SQUARED_SERVER_HOST ?? "0.0.0.0",
    port: parsePort(env.PI_SQUARED_SERVER_PORT ?? env.PORT ?? "8787"),
    secret,
    sessionsDir: resolve(env.PI_SQUARED_SESSIONS_DIR ?? "sessions"),
  };
}
