import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("web app manifest contains installable app metadata", async () => {
  const manifest = JSON.parse(await readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/home");
  assert.ok(manifest.icons.some((icon) => icon.sizes === "192x192"));
  assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512"));
});

test("service worker preserves user-controlled updates and navigation fallback", async () => {
  const worker = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.match(worker, /request\.mode === "navigate"/);
  assert.match(worker, /SKIP_WAITING/);
  assert.doesNotMatch(worker, /install[\s\S]{0,160}skipWaiting/);
  assert.match(worker, /caches\.match\("\/"\)/);
});
