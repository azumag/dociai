import type { ServiceErrorShape } from "./service-errors";

export type RequestContext = {
  requestId: string;
  serviceId: string;
  generation: number;
  ownerId: string;
  signal: AbortSignal;
  startedAt: number;
};

export type RequestSummary = {
  requestId: string;
  serviceId: string;
  generation: number;
  ownerId: string;
  startedAt: number;
};

export type RequestHandle<T = unknown> = {
  context: RequestContext;
  complete(value: T): boolean;
  fail(error: ServiceErrorShape | Error): boolean;
  cancel(reason?: "timeout" | "cancelled" | "generation-changed" | "owner-closed" | "disposed"): boolean;
};
