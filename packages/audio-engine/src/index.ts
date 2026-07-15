import type { ToneEvent } from "@learning-morse/morse-core";
import type { AudioWaveform } from "@learning-morse/shared-types";

export type AudioEngineState = "locked" | "running" | "suspended" | "recovering" | "failed" | "closed";

export type AudioEngineConfig = {
  frequencyHz: number;
  volume: number;
  waveform: AudioWaveform;
  attackMs: number;
  releaseMs: number;
};

export type AudioEngineOptions = {
  contextFactory?: () => AudioContext;
  onStateChange?: (state: AudioEngineState) => void;
  config?: Partial<AudioEngineConfig>;
};

const DEFAULT_CONFIG: AudioEngineConfig = {
  frequencyHz: 600,
  volume: 0.6,
  waveform: "sine",
  attackMs: 6,
  releaseMs: 8,
};

function validateConfig(config: AudioEngineConfig): void {
  if (!Number.isFinite(config.frequencyHz) || config.frequencyHz <= 0) {
    throw new RangeError("Frequency must be greater than zero");
  }
  if (!Number.isFinite(config.volume) || config.volume < 0 || config.volume > 1) {
    throw new RangeError("Volume must stay between zero and one");
  }
  if (!Number.isFinite(config.attackMs) || config.attackMs < 0) {
    throw new RangeError("Attack time cannot be negative");
  }
  if (!Number.isFinite(config.releaseMs) || config.releaseMs < 0) {
    throw new RangeError("Release time cannot be negative");
  }
}

export class AudioEngine {
  private readonly contextFactory: () => AudioContext;
  private readonly onStateChange?: (state: AudioEngineState) => void;
  private context: AudioContext | null = null;
  private config: AudioEngineConfig;
  private playbackNodes = new Set<OscillatorNode>();
  private liveTone: { oscillator: OscillatorNode; gain: GainNode } | null = null;
  private currentState: AudioEngineState = "locked";

  constructor(options: AudioEngineOptions = {}) {
    this.contextFactory = options.contextFactory ?? (() => new AudioContext({ latencyHint: "interactive" }));
    this.onStateChange = options.onStateChange;
    this.config = { ...DEFAULT_CONFIG, ...options.config };
    validateConfig(this.config);
  }

  get state(): AudioEngineState {
    return this.currentState;
  }

  setConfig(changes: Partial<AudioEngineConfig>): void {
    const next = { ...this.config, ...changes };
    validateConfig(next);
    this.config = next;
  }

  private setState(state: AudioEngineState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.onStateChange?.(state);
  }

  async ensureRunning(): Promise<AudioContext> {
    if (this.currentState === "closed") throw new Error("Audio engine is closed");
    try {
      if (!this.context) this.context = this.contextFactory();
      if (this.context.state === "suspended") {
        this.setState("recovering");
        await this.context.resume();
      }
      this.setState(this.context.state === "running" ? "running" : "suspended");
      return this.context;
    } catch (error) {
      this.setState("failed");
      throw error;
    }
  }

  private createScheduledTone(
    context: AudioContext,
    start: number,
    durationMs: number,
  ): OscillatorNode {
    const end = start + durationMs / 1000;
    const attackEnd = Math.min(end, start + this.config.attackMs / 1000);
    const releaseStart = Math.max(attackEnd, end - this.config.releaseMs / 1000);
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const audibleVolume = Math.max(0.001, this.config.volume);

    oscillator.type = this.config.waveform;
    oscillator.frequency.setValueAtTime(this.config.frequencyHz, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(audibleVolume, attackEnd);
    gain.gain.setValueAtTime(audibleVolume, releaseStart);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(end + 0.012);
    return oscillator;
  }

  async playTimeline(events: readonly ToneEvent[], leadInMs = 30): Promise<number> {
    if (!Number.isFinite(leadInMs) || leadInMs < 0) throw new RangeError("Lead-in cannot be negative");
    if (events.length === 0) return 0;
    const context = await this.ensureRunning();
    this.stopPlayback();
    const baseTime = context.currentTime + leadInMs / 1000;
    let durationMs = 0;

    for (const event of events) {
      const oscillator = this.createScheduledTone(
        context,
        baseTime + event.startMs / 1000,
        event.durationMs,
      );
      this.playbackNodes.add(oscillator);
      oscillator.onended = () => this.playbackNodes.delete(oscillator);
      durationMs = Math.max(durationMs, event.startMs + event.durationMs);
    }
    return durationMs;
  }

  async playTone(durationMs: number): Promise<number> {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new RangeError("Tone duration must be greater than zero");
    }
    const context = await this.ensureRunning();
    const oscillator = this.createScheduledTone(context, context.currentTime + 0.025, durationMs);
    this.playbackNodes.add(oscillator);
    oscillator.onended = () => this.playbackNodes.delete(oscillator);
    return durationMs;
  }

  stopPlayback(): void {
    const now = this.context?.currentTime ?? 0;
    for (const oscillator of this.playbackNodes) {
      try {
        oscillator.stop(now);
      } catch {
        // A node may already have ended between iteration and stop().
      }
    }
    this.playbackNodes.clear();
  }

  async startLiveTone(): Promise<void> {
    if (this.liveTone) return;
    const context = await this.ensureRunning();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const now = context.currentTime;
    const audibleVolume = Math.max(0.001, this.config.volume);

    oscillator.type = this.config.waveform;
    oscillator.frequency.setValueAtTime(this.config.frequencyHz, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(audibleVolume, now + this.config.attackMs / 1000);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(now);
    this.liveTone = { oscillator, gain };
  }

  stopLiveTone(): void {
    if (!this.liveTone || !this.context) return;
    const now = this.context.currentTime;
    const releaseSeconds = this.config.releaseMs / 1000;
    this.liveTone.gain.gain.cancelScheduledValues(now);
    this.liveTone.gain.gain.setValueAtTime(Math.max(0.001, this.liveTone.gain.gain.value), now);
    this.liveTone.gain.gain.exponentialRampToValueAtTime(0.0001, now + releaseSeconds);
    this.liveTone.oscillator.stop(now + releaseSeconds + 0.006);
    this.liveTone = null;
  }

  async close(): Promise<void> {
    this.stopPlayback();
    this.stopLiveTone();
    if (this.context && this.context.state !== "closed") await this.context.close();
    this.context = null;
    this.setState("closed");
  }
}
