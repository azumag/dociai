import type { ServiceErrorShape } from "./service-errors";

export type HealthStatus = "unknown" | "checking" | "healthy" | "degraded" | "unavailable";
export type HealthEvent =
  | { type: "changed"; serviceId: string; status: HealthStatus; at: number; latencyMs?: number; error?: ServiceErrorShape }
  | { type: "progress"; serviceId: string; requestId: string; at: number; phase: string }
  | { type: "completed"; serviceId: string; requestId: string; at: number }
  | { type: "failed"; serviceId: string; requestId: string; at: number; error: ServiceErrorShape };
