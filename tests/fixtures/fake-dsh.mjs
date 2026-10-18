#!/usr/bin/env node
// rdsh headless --json の最小 fake。stdin の prompt を受け取り session/final を出す。
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const sid = args.includes("--session-id") ? args[args.indexOf("--session-id") + 1] : "session-fake-1";
  console.log(JSON.stringify({ type: "session", sessionId: sid, cwd: process.cwd() }));
  if (input.includes("FAIL_429")) { console.error("dsh: provider: 429 Too Many Requests"); process.exit(1); }
  console.log(JSON.stringify({ type: "final", text: `dsh:${process.env.OPENCODE_API_KEY ? "key" : "nokey"}:${process.env.OPENCODE_GO_API_KEY ? "leak" : "clean"}:${input}` }));
});
