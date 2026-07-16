import assert from "node:assert/strict";
import test from "node:test";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders V2 navigation, domains and removed legacy routes", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Morse Learning Lab<\/title>/i);
  assert.match(html, /点短，划长/);
  assert.doesNotMatch(html, /<span>0[1-7]<\/span>(?:首页|基础|听抄|发报|工具|进度|设置)/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);

  const setup = await render("/training/setup/receive.character.audio");
  assert.match(await setup.text(), /自定义本轮训练/);

  const learn = await render("/learn/character/S");
  const learnHtml = await learn.text();
  assert.match(learnHtml, /新手基础练习/);
  assert.match(learnHtml, /按键练习/);
  assert.match(learnHtml, /按压时长/);
  assert.match(learnHtml, /自动判定并清空/);

  assert.match(await (await render("/receive")).text(), /让耳朵直接抵达字符/);
  assert.match(await (await render("/send/free")).text(), /自动提交等待/);
  const tools = await (await render("/tools/morse")).text();
  assert.match(tools, /文本与国际 Morse Code 双向转换/);
  assert.match(tools, /SOS MORSE/);

  for (const oldPath of ["/practice", "/keyer", "/stats"]) {
    assert.match(await (await render(oldPath)).text(), /这个频率上没有页面/);
  }
});
