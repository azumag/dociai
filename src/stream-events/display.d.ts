// Hand-maintained type declaration for display.js — see contract.d.ts's doc comment for why this
// repo's usual "@ts-expect-error + no declaration build" pattern isn't used for src/stream-events.
import type { StreamEvent } from "./contract.js";

export type StreamEventDisplay = {
  icon: string;
  label: string;
  summary: string;
  value: number;
};

export declare function formatStreamEvent(event: StreamEvent): StreamEventDisplay;
