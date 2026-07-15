import assert from "node:assert/strict";
import test from "node:test";
import {
  MORSE,
  classifyPress,
  createFarnsworthTimeline,
  createMorseTiming,
  createStandardTimeline,
  decodeText,
  dotUnitMs,
  encodeText,
  normalizeMorse,
} from "@learning-morse/morse-core";

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

test("keeps standard spacing when effective and character speeds match", () => {
  const timing = createMorseTiming(20, 20);
  assert.equal(timing.gapScale, 1);
  assert.equal(timing.elementGapMs, 60);
  assert.equal(timing.characterGapMs, 180);
  assert.equal(timing.wordGapMs, 420);
});

test("creates the exact 20/10 WPM Farnsworth PARIS sample", () => {
  const timing = createMorseTiming(20, 10);
  assert.equal(timing.gapScale, 69 / 19);

  const timeline = createFarnsworthTimeline("PARIS", 20, 10);
  const last = timeline.at(-1);
  const durationWithTrailingWordGap =
    (last?.startMs ?? 0) + (last?.durationMs ?? 0) + timing.wordGapMs;
  assert.ok(Math.abs(durationWithTrailingWordGap - 6000) < 1e-9);
});

test("rejects an effective speed above the character speed", () => {
  assert.throws(() => createMorseTiming(15, 20), RangeError);
});
