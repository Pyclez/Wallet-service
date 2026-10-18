import { randomUUID } from "node:crypto";

export interface HttpRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  correlationId?: string;
}

export interface HttpResponse {
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

export function correlationIdMiddleware(request: HttpRequest, response: HttpResponse, next: () => void): void {
  const header = request.headers["x-correlation-id"];
  const candidate = Array.isArray(header) ? header[0] : header;
  const correlationId = candidate && candidate.length <= 128 ? candidate : randomUUID();
  request.correlationId = correlationId;
  response.setHeader("x-correlation-id", correlationId);
  next();
}

export function correlationIdOf(request: HttpRequest): string {
  return request.correlationId ?? randomUUID();
}
