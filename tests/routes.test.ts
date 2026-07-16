import assert from "node:assert/strict";
import test from "node:test";
import { domainForPreset, normalizePath, pathForView, routeFromPath } from "../app/_lib/routes.ts";

test("normalizes and maps V2 primary routes", () => {
  assert.equal(normalizePath("/receive//?from=test"), "/receive");
  assert.equal(routeFromPath("/home").view, "home");
  assert.equal(routeFromPath("/learn/courses").view, "learn");
  assert.equal(routeFromPath("/receive").view, "receive");
  assert.equal(routeFromPath("/send/free").view, "send");
  assert.equal(routeFromPath("/tools/morse").view, "tools");
  assert.equal(routeFromPath("/progress/history").view, "progress");
  assert.equal(pathForView("settings"), "/settings/appearance");
});

test("extracts V2 training and detail parameters", () => {
  assert.deepEqual(routeFromPath("/training/setup/receive.character.audio"), {
    path: "/training/setup/receive.character.audio",
    view: "setup",
    presetId: "receive.character.audio",
  });
  assert.equal(routeFromPath("/training/session/session-42").sessionId, "session-42");
  assert.equal(routeFromPath("/training/result/session-42").resultSessionId, "session-42");
  assert.equal(routeFromPath("/learn/character/%3F").character, "?");
  assert.equal(routeFromPath("/settings/audio").settingsSection, "audio");
  assert.equal(domainForPreset("send.character.guided"), "send");
});

test("deletes old URLs and rejects unsupported V2 variants", () => {
  for (const path of ["/practice", "/practice/setup/sound", "/practice/session/old", "/practice/result/old", "/keyer", "/stats", "/stats/history"]) {
    assert.equal(routeFromPath(path).view, "not-found", path);
  }
  assert.equal(routeFromPath("/training/setup/unknown").view, "not-found");
  assert.equal(routeFromPath("/tools/chinese-telegraph").view, "not-found");
  assert.equal(routeFromPath("/settings/unknown").view, "not-found");
  assert.equal(routeFromPath("/missing").view, "not-found");
});
