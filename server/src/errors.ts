export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }

  if (error instanceof SyntaxError) {
    return new HttpError(400, "invalid_json", "Request body must be valid JSON.");
  }

  return new HttpError(500, "internal_server_error", "Internal server error.");
}
