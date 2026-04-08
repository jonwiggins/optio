export const EXIT_SUCCESS = 0;
export const EXIT_FAILURE = 1;
export const EXIT_AUTH = 2;
export const EXIT_FORBIDDEN = 3;
export const EXIT_NETWORK = 4;
export const EXIT_VALIDATION = 5;
export const EXIT_INTERRUPTED = 130;

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public body: Record<string, unknown>,
  ) {
    super(`HTTP ${statusCode}: ${JSON.stringify(body)}`);
    this.name = "ApiError";
  }

  get exitCode(): number {
    if (this.statusCode === 401) return EXIT_AUTH;
    if (this.statusCode === 403) return EXIT_FORBIDDEN;
    if (this.statusCode === 400) return EXIT_VALIDATION;
    if (this.statusCode >= 500) return EXIT_FAILURE;
    return EXIT_FAILURE;
  }
}

export class NetworkError extends Error {
  constructor(
    public serverUrl: string,
    cause?: Error,
  ) {
    super(`Could not reach ${serverUrl} — is the server up?`);
    this.name = "NetworkError";
    this.cause = cause;
  }
}
