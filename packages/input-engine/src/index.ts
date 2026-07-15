import { classifyPress, dotUnitMs, type MorseSymbol } from "@learning-morse/morse-core";
import type { InputSource, KeySignal } from "@learning-morse/shared-types";

export type InputEngineConfig = {
  characterWpm: number;
  thresholdUnits: number;
};

export type InputInterpretation =
  | { kind: "press-start"; source: InputSource; timestampMs: number }
  | { kind: "symbol"; source: InputSource; symbol: MorseSymbol; durationMs: number; timestampMs: number }
  | { kind: "cancel"; source: InputSource; durationMs: number; timestampMs: number }
  | { kind: "ignored"; reason: "already-active" | "not-active" | "phase-not-applicable" };

function validateConfig(config: InputEngineConfig): void {
  dotUnitMs(config.characterWpm);
  if (!Number.isFinite(config.thresholdUnits) || config.thresholdUnits <= 1 || config.thresholdUnits >= 3) {
    throw new RangeError("Threshold must stay between one and three dot units");
  }
}

function validateTimestamp(timestampMs: number): void {
  if (!Number.isFinite(timestampMs) || timestampMs < 0) {
    throw new RangeError("Input timestamp cannot be negative or non-finite");
  }
}

export class InputEngine {
  private config: InputEngineConfig;
  private activeSingle: { source: InputSource; startedAtMs: number } | null = null;

  constructor(config: InputEngineConfig) {
    validateConfig(config);
    this.config = { ...config };
  }

  get isActive(): boolean {
    return this.activeSingle !== null;
  }

  setConfig(changes: Partial<InputEngineConfig>): void {
    const next = { ...this.config, ...changes };
    validateConfig(next);
    this.config = next;
  }

  consume(signal: KeySignal): InputInterpretation {
    validateTimestamp(signal.timestampMs);

    if (signal.control === "single") {
      if (signal.phase === "down") {
        if (this.activeSingle) return { kind: "ignored", reason: "already-active" };
        this.activeSingle = { source: signal.source, startedAtMs: signal.timestampMs };
        return { kind: "press-start", source: signal.source, timestampMs: signal.timestampMs };
      }
      if (!this.activeSingle) return { kind: "ignored", reason: "not-active" };

      const active = this.activeSingle;
      this.activeSingle = null;
      const durationMs = Math.max(1, signal.timestampMs - active.startedAtMs);
      if (signal.phase === "cancel") {
        return { kind: "cancel", source: active.source, durationMs, timestampMs: signal.timestampMs };
      }
      return {
        kind: "symbol",
        source: active.source,
        symbol: classifyPress(durationMs, this.config.characterWpm, this.config.thresholdUnits),
        durationMs,
        timestampMs: signal.timestampMs,
      };
    }

    if (signal.phase !== "down") return { kind: "ignored", reason: "phase-not-applicable" };
    const symbol: MorseSymbol = signal.control === "dot" ? "." : "-";
    return {
      kind: "symbol",
      source: signal.source,
      symbol,
      durationMs: symbol === "." ? dotUnitMs(this.config.characterWpm) : dotUnitMs(this.config.characterWpm) * 3,
      timestampMs: signal.timestampMs,
    };
  }

  cancel(source: InputSource, timestampMs: number): InputInterpretation {
    return this.consume({ source, control: "single", phase: "cancel", timestampMs });
  }
}

export function keyboardSignal(
  sourceControl: "single" | "dot" | "dash",
  phase: "down" | "up" | "cancel",
  timestampMs: number,
): KeySignal {
  return { source: "keyboard", control: sourceControl, phase, timestampMs };
}

export function pointerSignal(
  control: "single" | "dot" | "dash",
  phase: "down" | "up" | "cancel",
  timestampMs: number,
): KeySignal {
  return { source: "pointer", control, phase, timestampMs };
}
