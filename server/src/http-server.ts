import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { URL } from "node:url";
import { isAgentMessage } from "@chiwanpark/pi-squared-protocol";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { isAuthorized } from "./auth.js";
import { HttpError, toHttpError } from "./errors.js";
import type { SessionStore } from "./session-store.js";

const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;

export interface ActiveAgentConnection {
  connectionId: string;
  sessionId: string;
  connectedAt: string;
  remoteAddress: string | null;
}

export interface PiSquaredServerOptions {
  secret: string;
  store: SessionStore;
  maxMessageBytes?: number;
}

export interface PiSquaredServer {
  server: Server;
  activeConnections: ReadonlyMap<string, ActiveAgentConnection>;
}

type RouteHandler = (request: IncomingMessage, response: ServerResponse, pathSegments: string[]) => Promise<void>;

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(payload)}\n`);
}

function sendNoContent(response: ServerResponse): void {
  response.writeHead(204);
  response.end();
}

function sendError(response: ServerResponse, error: HttpError): void {
  sendJson(response, error.statusCode, {
    error: {
      code: error.code,
      message: error.message,
    },
  });
}

function parsePathFromUrl(urlValue: string | undefined): string[] {
  const url = new URL(urlValue ?? "/", "http://localhost");
  return url.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));
}

function parsePath(request: IncomingMessage): string[] {
  return parsePathFromUrl(request.url);
}

function requireAuth(request: IncomingMessage, secret: string): void {
  if (!isAuthorized(request.headers, secret)) {
    throw new HttpError(401, "unauthorized", "A valid server secret is required.");
  }
}

function rejectUpgrade(socket: Duplex, statusCode: number, message: string): void {
  socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function rawDataToString(data: RawData, maxMessageBytes: number): string {
  const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);

  if (buffer.length > maxMessageBytes) {
    throw new HttpError(413, "message_too_large", "WebSocket message is too large.");
  }

  return buffer.toString("utf8");
}

function sendWebSocketJson(webSocket: WebSocket, payload: unknown): void {
  webSocket.send(JSON.stringify(payload));
}

export function createPiSquaredServer(options: PiSquaredServerOptions): PiSquaredServer {
  const activeConnections = new Map<string, ActiveAgentConnection>();
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: maxMessageBytes });

  const handleHealth: RouteHandler = async (_request, response) => {
    sendJson(response, 200, { status: "ok", activeConnections: activeConnections.size });
  };

  const routes = new Map<string, RouteHandler>([["GET /health", handleHealth]]);

  function routeKey(method: string | undefined, pathSegments: string[]): string | null {
    if (method === "GET" && pathSegments.length === 1 && pathSegments[0] === "health") {
      return "GET /health";
    }

    return null;
  }

  function webSocketSessionId(pathSegments: string[]): string | null {
    if (pathSegments.length === 2 && pathSegments[0] === "sessions") {
      return pathSegments[1] ?? null;
    }

    return null;
  }

  const server = createHttpServer((request, response) => {
    void (async () => {
      try {
        const pathSegments = parsePath(request);
        const key = routeKey(request.method, pathSegments);

        if (key === null) {
          if (request.method === "GET" && pathSegments.length === 0) {
            sendNoContent(response);
            return;
          }

          throw new HttpError(404, "not_found", "Not found.");
        }

        const handler = routes.get(key);
        if (handler === undefined) {
          throw new HttpError(404, "not_found", "Not found.");
        }

        await handler(request, response, pathSegments);
      } catch (error) {
        if (!response.headersSent) {
          sendError(response, toHttpError(error));
        } else {
          response.destroy(error instanceof Error ? error : undefined);
        }
      }
    })();
  });

  server.on("upgrade", (request, socket, head) => {
    void (async () => {
      try {
        const sessionId = webSocketSessionId(parsePath(request));
        if (sessionId === null) {
          rejectUpgrade(socket, 404, "Not Found");
          return;
        }

        requireAuth(request, options.secret);
        await options.store.createSession(sessionId);

        webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
          webSocketServer.emit("connection", webSocket, request, sessionId);
        });
      } catch (error) {
        const httpError = toHttpError(error);
        rejectUpgrade(socket, httpError.statusCode, httpError.message);
      }
    })();
  });

  webSocketServer.on("connection", (webSocket: WebSocket, request: IncomingMessage, sessionId: string) => {
    const connectionId = randomUUID();
    activeConnections.set(connectionId, {
      connectionId,
      sessionId,
      connectedAt: new Date().toISOString(),
      remoteAddress: request.socket.remoteAddress ?? null,
    });

    let received = 0;
    sendWebSocketJson(webSocket, { type: "connected", connectionId, sessionId });

    webSocket.on("message", (data: RawData) => {
      void (async () => {
        try {
          const message = JSON.parse(rawDataToString(data, maxMessageBytes)) as unknown;
          if (!isAgentMessage(message)) {
            throw new HttpError(400, "invalid_agent_message", "WebSocket messages must be AgentMessage values.");
          }

          await options.store.appendMessage(sessionId, message, { connectionId });
          received += 1;
          sendWebSocketJson(webSocket, { type: "recorded", connectionId, sessionId, received });
        } catch (error) {
          const httpError = toHttpError(error);
          sendWebSocketJson(webSocket, {
            type: "error",
            error: { code: httpError.code, message: httpError.message },
          });
          webSocket.close(httpError.statusCode === 413 ? 1009 : 1003, httpError.code);
        }
      })();
    });

    webSocket.on("error", () => {
      // The client will receive a close frame for protocol/payload errors.
    });

    webSocket.on("close", () => {
      activeConnections.delete(connectionId);
    });
  });

  server.on("close", () => {
    webSocketServer.close();
  });

  return { server, activeConnections };
}
