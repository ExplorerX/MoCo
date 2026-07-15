import assert from "node:assert/strict";
import test from "node:test";
import { InputEngine, keyboardSignal, pointerSignal } from "@learning-morse/input-engine";

test("classifies a single-key press from monotonic input signals", () => {
  const engine = new InputEngine({ characterWpm: 20, thresholdUnits: 2 });
  assert.deepEqual(engine.consume(keyboardSignal("single", "down", 1000)), {
    kind: "press-start",
    source: "keyboard",
    timestampMs: 1000,
  });
  assert.deepEqual(engine.consume(keyboardSignal("single", "up", 1119)), {
    kind: "symbol",
    source: "keyboard",
    symbol: ".",
    durationMs: 119,
    timestampMs: 1119,
  });
});

test("emits direct dot and dash symbols in dual-key mode", () => {
  const engine = new InputEngine({ characterWpm: 20, thresholdUnits: 2 });
  assert.equal(engine.consume(pointerSignal("dot", "down", 10)).kind, "symbol");
  assert.deepEqual(engine.consume(pointerSignal("dash", "down", 20)), {
    kind: "symbol",
    source: "pointer",
    symbol: "-",
    durationMs: 180,
    timestampMs: 20,
  });
});

test("cancels an active press without producing a Morse symbol", () => {
  const engine = new InputEngine({ characterWpm: 20, thresholdUnits: 2 });
  engine.consume(pointerSignal("single", "down", 100));
  assert.deepEqual(engine.cancel("pointer", 150), {
    kind: "cancel",
    source: "pointer",
    durationMs: 50,
    timestampMs: 150,
  });
  assert.equal(engine.isActive, false);
});
