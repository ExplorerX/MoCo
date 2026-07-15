import assert from "node:assert/strict";
import test from "node:test";
import { normalizePath, pathForView, routeFromPath } from "../app/_lib/routes.ts";

test("normalizes and maps primary routes", () => {
  assert.equal(normalizePath("/practice//?from=test"), "/practice");
  assert.equal(routeFromPath("/home").view, "home");
  assert.equal(routeFromPath("/keyer").view, "keyer");
  assert.equal(pathForView("settings"), "/settings/appearance");
});

test("extracts route parameters for deep links", () => {
  assert.deepEqual(routeFromPath("/practice/setup/sound"), {
    path: "/practice/setup/sound",
    view: "practice",
    practiceMode: "sound",
  });
  assert.equal(routeFromPath("/practice/session/session-42").sessionId, "session-42");
  assert.equal(routeFromPath("/practice/result/session-42").resultSessionId, "session-42");
  assert.equal(routeFromPath("/learn/character/%3F").character, "?");
  assert.equal(routeFromPath("/settings/audio").settingsSection, "audio");
});

test("rejects unsupported route variants", () => {
  assert.equal(routeFromPath("/practice/setup/unknown").view, "not-found");
  assert.equal(routeFromPath("/settings/unknown").view, "not-found");
  assert.equal(routeFromPath("/missing").view, "not-found");
});
