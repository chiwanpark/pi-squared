import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export const SECRET_HEADER = "x-pi-squared-secret";

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function safeEqual(value: string, expected: string): boolean {
  const valueBytes = Buffer.from(value);
  const expectedBytes = Buffer.from(expected);

  if (valueBytes.length !== expectedBytes.length) {
    return false;
  }

  return timingSafeEqual(valueBytes, expectedBytes);
}

export function isAuthorized(headers: IncomingHttpHeaders, secret: string): boolean {
  if (secret.length === 0) {
    return false;
  }

  const authorization = firstHeaderValue(headers.authorization);
  if (authorization?.startsWith("Bearer ") === true) {
    return safeEqual(authorization.slice("Bearer ".length), secret);
  }

  const secretHeader = firstHeaderValue(headers[SECRET_HEADER]);
  if (secretHeader !== null) {
    return safeEqual(secretHeader, secret);
  }

  return false;
}
