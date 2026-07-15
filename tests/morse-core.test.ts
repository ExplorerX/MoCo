import assert from "node:assert/strict";
import test from "node:test";
import {
  MORSE,
  classifyPress,
  createStandardTimeline,
  decodeText,
  dotUnitMs,
  encodeText,
  normalizeMorse,
} from "../lib/morse-core.ts";

test("contains the agreed MVP character set", () => {
  assert.equal(Object.keys(MORSE).length, 47);
  assert.equal(MORSE.S, "...");
  assert.equal(MORSE.O, "---");
  assert.equal(MORSE["?"], "..--..");
  assert.equal(MORSE["'"], ".----.");
});

test("round-trips supported text", () => {
  const source = "SOS 2026?";
  assert.equal(decodeText(encodeText(source)), source);
});

test("normalizes visual dot and dash glyphs", () => {
  assert.equal(normalizeMorse(" ···   ——— "), "... ---");
});

test("uses the PARIS timing unit and the configured press threshold", () => {
  assert.equal(dotUnitMs(20), 60);
  assert.equal(classifyPress(119, 20, 2), ".");
  assert.equal(classifyPress(120, 20, 2), "-");
  assert.throws(() => classifyPress(60, 20, 3), RangeError);
});

test("creates an exact SOS timeline without cumulative drift", () => {
  const timeline = createStandardTimeline("SOS", 20);
  assert.equal(timeline.length, 9);
  assert.deepEqual(timeline.map((event) => event.startMs), [0, 120, 240, 480, 720, 960, 1320, 1440, 1560]);
  assert.deepEqual(timeline.map((event) => event.durationMs), [60, 60, 60, 180, 180, 180, 60, 60, 60]);
  const last = timeline.at(-1);
  assert.equal((last?.startMs ?? 0) + (last?.durationMs ?? 0), 1620);
});
