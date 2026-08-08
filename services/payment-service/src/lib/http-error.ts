/**
 * An error with an HTTP status and a stable machine-readable code.
 *
 * Services throw these rather than returning result objects, because almost
 * every failure here is a refusal the caller needs to see verbatim
 * (`INSUFFICIENT_FUNDS`, `NOT_REFUNDABLE_FROM_COMPLETED`) rather than an
 * internal condition to be translated. The API layer is the only thing that
 * turns one into a response.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'HttpError';
  }
}

export const badRequest = (code: string) => new HttpError(400, code);
export const notFound = (code: string) => new HttpError(404, code);
export const conflict = (code: string) => new HttpError(409, code);
