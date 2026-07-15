import assert from "node:assert/strict";
import test from "node:test";
import { AudioEngine } from "@learning-morse/audio-engine";
import type { ToneEvent } from "@learning-morse/morse-core";

class FakeAudioParam {
  value = 0;
  events: Array<{ kind: string; value?: number; time: number }> = [];

  setValueAtTime(value: number, time: number) {
    this.value = value;
    this.events.push({ kind: "set", value, time });
    return this as unknown as AudioParam;
  }

  exponentialRampToValueAtTime(value: number, time: number) {
    this.value = value;
    this.events.push({ kind: "ramp", value, time });
    return this as unknown as AudioParam;
  }

  cancelScheduledValues(time: number) {
    this.events.push({ kind: "cancel", time });
    return this as unknown as AudioParam;
  }
}

class FakeOscillator {
  type: OscillatorType = "sine";
  frequency = new FakeAudioParam();
  starts: number[] = [];
  stops: number[] = [];
  onended: (() => void) | null = null;

  connect<T>(destination: T): T {
    return destination;
  }

  start(time: number) {
    this.starts.push(time);
  }

  stop(time: number) {
    this.stops.push(time);
  }
}

class FakeGain {
  gain = new FakeAudioParam();

  connect<T>(destination: T): T {
    return destination;
  }
}

class FakeAudioContext {
  currentTime = 10;
  state: AudioContextState = "running";
  destination = {};
  oscillators: FakeOscillator[] = [];

  createOscillator() {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator as unknown as OscillatorNode;
  }

  createGain() {
    return new FakeGain() as unknown as GainNode;
  }

  async resume() {
    this.state = "running";
  }

  async close() {
    this.state = "closed";
  }
}

test("schedules a timeline from one AudioContext base time and can cancel it", async () => {
  const context = new FakeAudioContext();
  const states: string[] = [];
  const engine = new AudioEngine({
    contextFactory: () => context as unknown as AudioContext,
    onStateChange: (state) => states.push(state),
  });
  const events: ToneEvent[] = [
    { character: "S", symbol: ".", startMs: 0, durationMs: 60 },
    { character: "S", symbol: ".", startMs: 120, durationMs: 60 },
  ];

  assert.equal(await engine.playTimeline(events), 180);
  assert.deepEqual(context.oscillators.map((oscillator) => Number(oscillator.starts[0].toFixed(3))), [10.03, 10.15]);
  assert.deepEqual(states, ["running"]);
  engine.stopPlayback();
  assert.ok(context.oscillators.every((oscillator) => oscillator.stops.includes(10)));
  await engine.close();
  assert.equal(engine.state, "closed");
});
