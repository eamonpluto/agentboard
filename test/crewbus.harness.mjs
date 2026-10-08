import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = fileURLToPath(new URL("../bin/crewbus.js", import.meta.url));
const HOOK = fileURLToPath(new URL("../bin/crewbus-hook.js", import.meta.url));
const MCP = fileURLToPath(new URL("../bin/crewbus-mcp.js", import.meta.url));
import { buildSpawnTarget, buildSpawnPrompt, buildRespawnTarget, buildRespawnBrief, extractHarnessSessionId, isPidStale, readWorkerSession, syncWorkerSession, workerStatus, bootWorker, pidStartTime, parsePsEtime } from "../bin/lib/spawn.js";
import { ensureBoard } from "../bin/lib/store.js";

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const TOK = {};
const tokKey = (env, who) => `${(env && env.CREWBUS_DIR) || ""}\n${who}`;
const run = (args, env, cwd) => {
  const merged = { ...env };
  const fi = args.indexOf("--from");
  const who = fi !== -1 && args[fi + 1] && !String(args[fi + 1]).startsWith("--") ? args[fi + 1] : null;
  if (who && TOK[tokKey(merged, who)] && !merged.CREWBUS_TOKEN) merged.CREWBUS_TOKEN = TOK[tokKey(merged, who)];
  const out = execFileSync("node", [args[0] === "hook" ? HOOK : CLI, ...args.slice(1)], {
    env: merged,
    cwd: cwd || process.cwd(),
  }).toString();
  const m = out.match(/token (abt-[0-9a-f]+)/);
  if (m && who && !TOK[tokKey(merged, who)]) TOK[tokKey(merged, who)] = m[1];
  return out;
};

// ---------------------------------------------------------------- MCP server
const mcpBoard = fs.mkdtempSync(path.join(os.tmpdir(), "cb-mcp-"));
const srv = spawn("node", [MCP], { env: { ...process.env, CREWBUS_DIR: mcpBoard }, stdio: ["pipe", "pipe", "inherit"] });
let mcpBuf = "";
const mcpPending = [];
srv.stdout.on("data", (d) => {
  mcpBuf += d.toString();
  let i;
  while ((i = mcpBuf.indexOf("\n")) !== -1) {
    const line = mcpBuf.slice(0, i).trim();
    mcpBuf = mcpBuf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const w = mcpPending.find((p) => p.id === msg.id);
    if (w) {
      mcpPending.splice(mcpPending.indexOf(w), 1);
      w.res(msg);
    }
  }
});
let mcpId = 1;
const mcpReq = (method, params) =>
  new Promise((res) => {
    const id = mcpId++;
    mcpPending.push({ id, res });
    srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

const init1 = await mcpReq("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });
check("mcp: initialize negotiates", init1.result.protocolVersion === "2024-11-05" && init1.result.serverInfo.name === "crewbus");
const init2 = await mcpReq("initialize", { protocolVersion: "9999-99-99" });
check("mcp: unknown version falls back", init2.result.protocolVersion === "2024-11-05");
const tools = await mcpReq("tools/list", {});
check(
  "mcp: 8 tools listed",
  JSON.stringify(tools.result.tools.map((t) => t.name).sort()) === JSON.stringify(["dm_ack", "dm_agents", "dm_channel_post", "dm_channel_tail", "dm_gather", "dm_inbox", "dm_register", "dm_send"])
);
const mcpReg = await mcpReq("tools/call", { name: "dm_register", arguments: { agent: "alice", session: "s1" } });
check("mcp: register ok + mints token", mcpReg.result.content[0].text.includes("registered alice") && /token abt-[0-9a-f]+/.test(mcpReg.result.content[0].text));
const aliceTok = mcpReg.result.content[0].text.match(/token (abt-[0-9a-f]+)/)[1];
const bobTok = (await mcpReq("tools/call", { name: "dm_register", arguments: { agent: "bob" } })).result.content[0].text.match(/token (abt-[0-9a-f]+)/)[1];
const nobodyTok = (await mcpReq("tools/call", { name: "dm_register", arguments: { agent: "nobody" } })).result.content[0].text.match(/token (abt-[0-9a-f]+)/)[1];
const sent = await mcpReq("tools/call", { name: "dm_send", arguments: { from: "alice", to: "bob", body: "hi via mcp", token: aliceTok } });
check("mcp: send ok", /sent \S+ -> bob/.test(sent.result.content[0].text));
check("mcp: send with wrong token isError", (await mcpReq("tools/call", { name: "dm_send", arguments: { from: "alice", to: "bob", body: "forged", token: "abt-0" } })).result.isError === true);
check("mcp: inbox sees mail", (await mcpReq("tools/call", { name: "dm_inbox", arguments: { agent: "bob", token: bobTok } })).result.content[0].text.includes("hi via mcp"));
check("mcp: empty inbox", (await mcpReq("tools/call", { name: "dm_inbox", arguments: { agent: "nobody", token: nobodyTok } })).result.content[0].text.includes("no messages"));
check("mcp: agents lists alice", (await mcpReq("tools/call", { name: "dm_agents", arguments: {} })).result.content[0].text.includes("alice"));
check("mcp: inbox heartbeats (bob active)", (await mcpReq("tools/call", { name: "dm_agents", arguments: { active: true } })).result.content[0].text.includes("bob"));
const mcpAck = await mcpReq("tools/call", { name: "dm_ack", arguments: { agent: "bob", all: true, token: bobTok } });
check("mcp: ack works", mcpAck.result.content[0].text.includes("acked"));
const mcpUnacked = await mcpReq("tools/call", { name: "dm_inbox", arguments: { agent: "bob", unacked: true, token: bobTok } });
check("mcp: unacked hides acked", mcpUnacked.result.content[0].text.includes("no messages"));
// mcp artifact + verifier hook (§4.2 item 5)
const mcpArt = await mcpReq("tools/call", { name: "dm_send", arguments: { from: "alice", to: "bob", body: "mcp artifact mail", artifact: "out/mcp.json", token: aliceTok } });
check("mcp: send with artifact ok", /sent \S+ -> bob/.test(mcpArt.result.content[0].text));
const mcpArtId = mcpArt.result.content[0].text.match(/sent (\S+) -> bob/)[1];
check("mcp: artifact shown in inbox", (await mcpReq("tools/call", { name: "dm_inbox", arguments: { agent: "bob", token: bobTok } })).result.content[0].text.includes("artifact: out/mcp.json"));
const mcpVer = await mcpReq("tools/call", { name: "dm_ack", arguments: { agent: "bob", id: mcpArtId, verify: "node -e process.exit(0)", token: bobTok } });
check("mcp: dm_ack verify acks on exit 0", mcpVer.result.content[0].text.includes("acked+verified"));
const mcpArt2 = await mcpReq("tools/call", { name: "dm_send", arguments: { from: "alice", to: "bob", body: "mcp artifact mail 2", token: aliceTok } });
const mcpArtId2 = mcpArt2.result.content[0].text.match(/sent (\S+) -> bob/)[1];
const mcpBad = await mcpReq("tools/call", { name: "dm_ack", arguments: { agent: "bob", id: mcpArtId2, verify: "node -e process.exit(3)", token: bobTok } });
check("mcp: dm_ack verify fails on non-zero exit", mcpBad.result.isError === true);
check("mcp: unknown tool isError", (await mcpReq("tools/call", { name: "nope", arguments: {} })).result.isError === true);
check("mcp: missing body isError", (await mcpReq("tools/call", { name: "dm_send", arguments: { from: "a", to: "b" } })).result.isError === true);
check("mcp: unknown method -32601", (await mcpReq("bogus/method", {})).error.code === -32601);
check("mcp: ping", JSON.stringify((await mcpReq("ping", {})).result) === "{}");
srv.kill();
fs.rmSync(mcpBoard, { recursive: true, force: true });

// mcp walk-up: server started in a subdirectory still uses the project board
// (realpath: os.tmpdir() is a symlink on macOS, and the server echoes the
// canonical path it resolved via process.cwd()).
const mcpWalk = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cb-mcpwalk-")));
fs.mkdirSync(path.join(mcpWalk, ".crewbus", "dm"), { recursive: true });
fs.writeFileSync(path.join(mcpWalk, ".crewbus", "board.json"), JSON.stringify({ name: "board", version: 2 }) + "\n");
const mcpDeep = path.join(mcpWalk, "sub");
fs.mkdirSync(mcpDeep, { recursive: true });
const srv2Env = { ...process.env };
delete srv2Env.CREWBUS_DIR;
const srv2 = spawn("node", [MCP], { env: srv2Env, cwd: mcpDeep, stdio: ["pipe", "pipe", "inherit"] });
let buf2 = "";
const pend2 = [];
srv2.stdout.on("data", (d) => {
  buf2 += d.toString();
  let i;
  while ((i = buf2.indexOf("\n")) !== -1) {
    const line = buf2.slice(0, i).trim();
    buf2 = buf2.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const w = pend2.find((p) => p.id === msg.id);
    if (w) {
      pend2.splice(pend2.indexOf(w), 1);
      w.res(msg);
    }
  }
});
let id2 = 1;
const req2 = (method, params) =>
  new Promise((res) => {
    const id = id2++;
    pend2.push({ id, res });
    srv2.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
await req2("initialize", { protocolVersion: "2024-11-05" });
const wsend = await req2("tools/call", { name: "dm_send", arguments: { from: "w1", to: "w2", body: "deep mail" } });
check("mcp: subdir send echoes project board", wsend.result.content[0].text.includes(`[board ${path.join(mcpWalk, ".crewbus")}]`));
check("mcp: subdir send lands on project board", fs.existsSync(path.join(mcpWalk, ".crewbus", "dm", "w2")) && !fs.existsSync(path.join(mcpDeep, ".crewbus")));
// mcp board override: explicit absolute path wins over cwd
const mcpOver = fs.mkdtempSync(path.join(os.tmpdir(), "cb-mcpover-"));
const overSend = await req2("tools/call", { name: "dm_send", arguments: { from: "o1", to: "o2", body: "override mail", board: path.join(mcpOver, "custom") } });
check("mcp: board override honored + echoed", overSend.result.content[0].text.includes(`[board ${path.join(mcpOver, "custom")}]`) && fs.existsSync(path.join(mcpOver, "custom", "dm", "o2")));
fs.rmSync(mcpOver, { recursive: true, force: true });
// mcp broadcast + subject threading on the project board
const bcRes = await req2("tools/call", { name: "dm_send", arguments: { from: "b1", to: "b2,b3", subject: "fanout subj", body: "fanout body" } });
check("mcp: broadcast reports count", bcRes.result.content[0].text.includes("sent 2 messages"));
const b2Tok = (await req2("tools/call", { name: "dm_register", arguments: { agent: "b2" } })).result.content[0].text.match(/token (abt-[0-9a-f]+)/)[1];
const b3Tok = (await req2("tools/call", { name: "dm_register", arguments: { agent: "b3" } })).result.content[0].text.match(/token (abt-[0-9a-f]+)/)[1];
const b2 = await req2("tools/call", { name: "dm_inbox", arguments: { agent: "b2", token: b2Tok } });
check("mcp: broadcast inbox shows subject", b2.result.content[0].text.includes("subj: fanout subj"));
const b3 = await req2("tools/call", { name: "dm_inbox", arguments: { agent: "b3", token: b3Tok } });
check("mcp: broadcast reaches every recipient", b3.result.content[0].text.includes("fanout body"));
// mcp groups + gather (group files planted directly; management is CLI-only)
fs.mkdirSync(path.join(mcpWalk, ".crewbus", "groups"), { recursive: true });
fs.writeFileSync(path.join(mcpWalk, ".crewbus", "groups", "mcp-team.json"), JSON.stringify({ name: "mcp-team", members: ["m1", "m2"], createdAt: new Date().toISOString() }));
const b1Tok = bcRes.result.content[0].text.match(/token (abt-[0-9a-f]+)/)[1]; // minted by b1's first send above
const gRes = await req2("tools/call", { name: "dm_send", arguments: { from: "b1", to_group: "mcp-team", body: "group brief", token: b1Tok } });
check("mcp: to_group fans out", gRes.result.content[0].text.includes("sent 2 messages"));
const gBatch = gRes.result.content[0].text.match(/batch (batch-[0-9a-z-]+)/)[1];
const m1Tok = (await req2("tools/call", { name: "dm_register", arguments: { agent: "m1" } })).result.content[0].text.match(/token (abt-[0-9a-f]+)/)[1];
check("mcp: group member got brief", (await req2("tools/call", { name: "dm_inbox", arguments: { agent: "m1", token: m1Tok } })).result.content[0].text.includes("group brief"));
const gth = await req2("tools/call", { name: "dm_gather", arguments: { batch: gBatch } });
check("mcp: gather reduces batch", gth.result.content[0].text.includes("group brief") && gth.result.content[0].text.includes("2 brief(s)"));
let gUnknown = false;
try {
  const r = await req2("tools/call", { name: "dm_send", arguments: { from: "b1", to_group: "nope", body: "x", token: b1Tok } });
  gUnknown = r.result.isError === true;
} catch {
  gUnknown = true;
}
check("mcp: to_group unknown refused", gUnknown);
// mcp read with no board: loud error, plants nothing
const missBoard = path.join(os.tmpdir(), "cb-mcpmiss-" + Date.now());
const missRes = await req2("tools/call", { name: "dm_inbox", arguments: { agent: "ghost", board: missBoard } });
check("mcp: inbox with no board isError", missRes.result.isError === true && missRes.result.content[0].text.includes("no board"));
check("mcp: read planted no board", !fs.existsSync(missBoard));
srv2.kill();
await new Promise((res) => {
  const t = setTimeout(res, 5000);
  srv2.on("exit", () => {
    clearTimeout(t);
    res();
  });
});
fs.rmSync(mcpWalk, { recursive: true, force: true });

// dm-send tool: walk-up + board echo (stub @opencode-ai/plugin SDK)
const toolDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-tool-"));
const stubDir = path.join(toolDir, "node_modules", "@opencode-ai", "plugin");
fs.mkdirSync(stubDir, { recursive: true });
fs.writeFileSync(path.join(toolDir, "package.json"), JSON.stringify({ type: "module" }));
fs.writeFileSync(path.join(stubDir, "package.json"), JSON.stringify({ type: "module", main: "index.js" }));
fs.writeFileSync(
  path.join(stubDir, "index.js"),
  "const s = () => ({ describe: () => s(), optional: () => s() });\nexport function tool(def) { return def; }\ntool.schema = { string: s, number: s, boolean: s };\n"
);
const toolDest = path.join(toolDir, "dm-send.js");
fs.copyFileSync(fileURLToPath(new URL("../opencode/tools/dm-send.js", import.meta.url)), toolDest);
const toolMod = await import(pathToFileURL(toolDest).href);
const toolProj = fs.mkdtempSync(path.join(os.tmpdir(), "cb-toolproj-"));
fs.mkdirSync(path.join(toolProj, ".crewbus", "dm"), { recursive: true });
fs.writeFileSync(path.join(toolProj, ".crewbus", "board.json"), JSON.stringify({ name: "board", version: 2 }) + "\n");
const toolSub = path.join(toolProj, "sub");
fs.mkdirSync(toolSub, { recursive: true });
const toolOut = await toolMod.default.execute(
  { from: "t1", to: "t2", body: "tool deep mail" },
  { sessionID: "ses_t", worktree: toolSub, directory: toolSub }
);
check("tool: echoes project board", toolOut.includes(`[board ${path.join(toolProj, ".crewbus")}]`));
check("tool: first send mints token", /token abt-[0-9a-f]+/.test(toolOut));
const t1Tok = toolOut.match(/token (abt-[0-9a-f]+)/)[1];
check("tool: subdir send lands on project board", fs.existsSync(path.join(toolProj, ".crewbus", "dm", "t2")));
const toolAgent = JSON.parse(fs.readFileSync(path.join(toolProj, ".crewbus", "agents", "t1.json"), "utf8"));
check("tool: sender session captured", toolAgent.sessionId === "ses_t");
const toolOver = await toolMod.default.execute(
  { from: "t1", to: "t9", body: "override mail", board: path.join(toolProj, "custom"), token: t1Tok },
  { sessionID: "ses_t", worktree: toolSub, directory: toolSub }
);
check("tool: board override honored + echoed", toolOver.includes(`[board ${path.join(toolProj, "custom")}]`) && fs.existsSync(path.join(toolProj, "custom", "dm", "t9")));
// tool broadcast: one copy each, shared batch + subject
const toolBc = await toolMod.default.execute(
  { from: "t1", to: "t3,t4", subject: "brief: x", body: "fanout", token: t1Tok },
  { sessionID: "ses_t", worktree: toolSub, directory: toolSub }
);
check("tool: broadcast reports count", toolBc.includes("sent 2 messages"));
const readFirst = (dir) => {
  const fs0 = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  return JSON.parse(fs.readFileSync(path.join(dir, fs0[0]), "utf8"));
};
const t3msg = readFirst(path.join(toolProj, ".crewbus", "dm", "t3"));
const t4msg = readFirst(path.join(toolProj, ".crewbus", "dm", "t4"));
check(
  "tool: broadcast shared batch + subject, unique ids",
  !!t3msg.batch && t3msg.batch === t4msg.batch && t3msg.subject === "brief: x" && t3msg.id !== t4msg.id
);
// tool to_group: group file + to_group arg fans out (token from first send)
fs.mkdirSync(path.join(toolProj, ".crewbus", "groups"), { recursive: true });
fs.writeFileSync(path.join(toolProj, ".crewbus", "groups", "tg.json"), JSON.stringify({ name: "tg", members: ["t5", "t6"] }));
const toolGrp = await toolMod.default.execute(
  { from: "t1", to_group: "tg", body: "group brief", token: t1Tok },
  { sessionID: "ses_t", worktree: toolSub, directory: toolSub }
);
check("tool: to_group fans out", toolGrp.includes("sent 2 messages") && fs.existsSync(path.join(toolProj, ".crewbus", "dm", "t5")));
fs.rmSync(toolDir, { recursive: true, force: true });
fs.rmSync(toolProj, { recursive: true, force: true });

// ------------------------------------------------------- hook helper (poll)
const hookBoard = fs.mkdtempSync(path.join(os.tmpdir(), "cb-hook-"));
const henv = { ...process.env, CREWBUS_DIR: hookBoard };
run(["cli", "send", "--from", "alice", "--to", "bob", "--body", "hook mail one"], henv);
const started = run(["hook", "session-start", "--from", "bob"], henv);
check("hook: session-start registers + backlog", started.includes("registered bob") && started.includes("hook mail one"));
check("hook: first poll silent (cursor drained)", run(["hook", "poll", "--from", "bob", "--style", "grok"], henv).trim() === "");
run(["cli", "send", "--from", "alice", "--to", "bob", "--body", "hook mail two"], henv);
for (const [style, want] of [
  ["grok", '"decision":"block"'],
  ["claude", '"decision":"block"'],
  ["codex", '"decision":"block"'],
  ["antigravity-stop", '"decision":"continue"'],
]) {
  run(["cli", "send", "--from", "alice", "--to", "bob", "--body", `mail for ${style}`], henv);
  const out = run(["hook", "poll", "--from", "bob", "--style", style], henv);
  const parsed = JSON.parse(out);
  check(`hook: poll --style ${style} envelope`, out.includes(want) && JSON.stringify(parsed).includes(`mail for ${style}`));
}
run(["cli", "send", "--from", "alice", "--to", "bob", "--body", "pre-invocation mail"], henv);
const pre = JSON.parse(run(["hook", "poll", "--from", "bob", "--style", "antigravity-pre"], henv));
check("hook: antigravity-pre injectSteps", Array.isArray(pre.injectSteps) && pre.injectSteps[0].ephemeralMessage.includes("pre-invocation mail"));
check("hook: poll silent when no mail", run(["hook", "poll", "--from", "bob", "--style", "grok"], henv).trim() === "");
check("hook: poll heartbeats presence", Date.parse(JSON.parse(fs.readFileSync(path.join(hookBoard, "agents", "bob.json"), "utf8")).lastSeen) > Date.now() - 60000);
// hook surfaces subject threading lines
run(["cli", "send", "--from", "alice", "--to", "bob", "--subject", "mission line", "--body", "subject mail"], henv);
check("hook: poll shows subject", run(["hook", "poll", "--from", "bob", "--style", "grok"], henv).includes("subj: mission line"));
let badStyle = false;
try {
  run(["hook", "poll", "--from", "bob", "--style", "nope"], henv);
} catch {
  badStyle = true;
}
check("hook: bad style rejected", badStyle);

// batch cap: 7 fresh DMs -> first poll delivers 5, cursor at 5th, rest follows
for (let i = 1; i <= 7; i++) run(["cli", "send", "--from", "alice", "--to", "bob", "--body", `batch mail ${i}`], henv);
const batch1 = JSON.parse(run(["hook", "poll", "--from", "bob", "--style", "grok"], henv));
check("hook: batch capped at 5", (batch1.reason.match(/batch mail/g) || []).length === 5 && batch1.reason.includes("more waiting"));
const batch2 = JSON.parse(run(["hook", "poll", "--from", "bob", "--style", "grok"], henv));
check("hook: remainder follows next poll", (batch2.reason.match(/batch mail/g) || []).length === 2 && batch2.reason.includes("batch mail 7"));
check("hook: quiet after drain", run(["hook", "poll", "--from", "bob", "--style", "grok"], henv).trim() === "");

// wait: long-poll exit contract (Claude Code asyncRewake — exit 2 wakes,
// stderr carries the DMs, exit 0 is silent)
const runWait = (args, env) => {
  try {
    const out = execFileSync("node", [HOOK, ...args], { env });
    return { status: 0, stdout: out.toString(), stderr: "" };
  } catch (e) {
    return { status: e.status, stdout: (e.stdout || "").toString(), stderr: (e.stderr || "").toString() };
  }
};
run(["cli", "send", "--from", "alice", "--to", "bob", "--body", "wait mail one"], henv);
const w1 = runWait(["wait", "--from", "bob", "--timeout", "5", "--interval", "1"], henv);
check("hook: wait exits 2 with mail on stderr", w1.status === 2 && w1.stderr.includes("wait mail one") && !w1.stdout.includes("wait mail one"));
check("hook: poll silent after wait delivery", run(["hook", "poll", "--from", "bob", "--style", "grok"], henv).trim() === "");
const w2 = runWait(["wait", "--from", "bob", "--timeout", "1", "--interval", "1"], henv);
check("hook: wait exits 0 silent on timeout", w2.status === 0 && w2.stdout.trim() === "" && w2.stderr.trim() === "");
run(["cli", "send", "--from", "alice", "--to", "bob", "--body", "wait cap A"], henv);
run(["cli", "send", "--from", "alice", "--to", "bob", "--body", "wait cap B"], henv);
const w3 = runWait(["wait", "--from", "bob", "--timeout", "5", "--interval", "1", "--max", "1"], henv);
check("hook: wait --max caps delivery", w3.status === 2 && (w3.stderr.includes("wait cap A") !== w3.stderr.includes("wait cap B")));
check("hook: remainder follows wait via poll", run(["hook", "poll", "--from", "bob", "--style", "grok"], henv).includes("wait cap"));
check("hook: wait rejects bad timeout", runWait(["wait", "--from", "bob", "--timeout", "-1"], henv).status === 1);

// monitor: blocking event stream for grok's monitor tool (prints on
// arrival, silent otherwise, exits 0 on timeout)
const runMonitor = (args, env) =>
  new Promise((resolve) => {
    const child = spawn("node", [HOOK, ...args], { env });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("close", (code) => resolve({ code, out, err }));
  });
run(["cli", "send", "--from", "alice", "--to", "bob", "--body", "monitor mail one"], henv);
const m1 = await runMonitor(["monitor", "--from", "bob", "--timeout", "6", "--interval", "1"], henv);
check("hook: monitor prints arrival then exits 0", m1.code === 0 && m1.out.includes("monitor mail one"));
check("hook: poll silent after monitor delivery", run(["hook", "poll", "--from", "bob", "--style", "grok"], henv).trim() === "");
const m2 = await runMonitor(["monitor", "--from", "bob", "--timeout", "2", "--interval", "1"], henv);
check("hook: monitor exits 0 silent on timeout", m2.code === 0 && m2.out.trim() === "");
const m3 = await runMonitor(["monitor", "--from", "bob", "--timeout", "2"], { ...henv, CREWBUS_DIR: path.join(henv.CREWBUS_DIR, "nope") });
check("hook: monitor refuses missing board", m3.code === 1 && (m3.out + m3.err).includes("no board"));

// unified tracking: hook-delivered mail is skipped by marker-aware readers,
// and a foreign delivered marker suppresses re-delivery
run(["cli", "send", "--from", "alice", "--to", "bob", "--body", "already seen elsewhere"], henv);
run(["cli", "register", "--from", "bob"], henv); // claim (session-start record predates tokens)
const bobDMs = JSON.parse(run(["cli", "inbox", "--from", "bob", "--json"], henv));
const foreignId = bobDMs[bobDMs.length - 1].id;
fs.mkdirSync(`${hookBoard}/delivered/bob`, { recursive: true });
fs.writeFileSync(`${hookBoard}/delivered/bob/${foreignId}.json`, JSON.stringify({ by: "external", at: new Date().toISOString() }) + "\n");
check("hook: foreign marker suppresses poll", run(["hook", "poll", "--from", "bob", "--style", "grok"], henv).trim() === "");

// idle gate: fresh mail within the window stays silent, then delivers
run(["cli", "send", "--from", "alice", "--to", "bob", "--body", "idle gated mail"], henv);
check("hook: --idle-after suppresses when recent", run(["hook", "poll", "--from", "bob", "--style", "grok", "--idle-after", "3600"], henv).trim() === "");
const cursorP = `${hookBoard}/cursors/bob.json`;
const cursorDoc = JSON.parse(fs.readFileSync(cursorP, "utf8"));
cursorDoc.at = new Date(Date.now() - 7200 * 1000).toISOString();
fs.writeFileSync(cursorP, JSON.stringify(cursorDoc, null, 2) + "\n");
check("hook: --idle-after delivers when stale", run(["hook", "poll", "--from", "bob", "--style", "grok", "--idle-after", "3600"], henv).includes("idle gated mail"));
fs.rmSync(hookBoard, { recursive: true, force: true });

// cross-direction: plugin push suppresses hook poll and vice versa
const xBoard = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cross-"));
const xenv = { ...process.env, CREWBUS_DIR: xBoard };
run(["cli", "register", "--from", "bob", "--session", "ses_bob"], xenv);
run(["cli", "send", "--from", "alice", "--to", "bob", "--body", "cross one"], xenv);
const pushes = [];
const stubClient = { session: { promptAsync: async (a) => { pushes.push(a); } }, app: { log: async () => true } };
const watchMod = await import(pathToFileURL(fileURLToPath(new URL("../opencode/plugins/dm-watch.js", import.meta.url))).href);
// the plugin resolves the board like the live runtime: CREWBUS_DIR env of
// its own process, else <directory>/.crewbus
const savedBoardDir = process.env.CREWBUS_DIR;
process.env.CREWBUS_DIR = xBoard;
const watcher = await watchMod.DmWatchPlugin({ client: stubClient, directory: xBoard });
await new Promise((r) => setTimeout(r, 1600));
check("cross: plugin pushes first mail", pushes.length === 1);
check("cross: hook silent after plugin delivery", run(["hook", "poll", "--from", "bob", "--style", "grok"], xenv).trim() === "");
run(["cli", "send", "--from", "alice", "--to", "bob", "--body", "cross two"], xenv);
check("cross: hook delivers second mail", run(["hook", "poll", "--from", "bob", "--style", "grok"], xenv).includes("cross two"));
await new Promise((r) => setTimeout(r, 1600));
check("cross: plugin skips hook-delivered mail", pushes.length === 1);
await watcher.dispose();
if (savedBoardDir === undefined) delete process.env.CREWBUS_DIR;
else process.env.CREWBUS_DIR = savedBoardDir;
fs.rmSync(xBoard, { recursive: true, force: true });

// ------------------------------------------------------- harness session-id capture (respawn slice 1)
const tO = buildSpawnTarget({ harness: "opencode", cwd: "/tmp", name: "w", promptPath: "/tmp/x.md", prompt: "p" });
check("capture: opencode --format json", tO.args.includes("--format") && tO.args[tO.args.indexOf("--format") + 1] === "json");
const tC = buildSpawnTarget({ harness: "claude", cwd: "/tmp", name: "w", promptPath: "/tmp/x.md", prompt: "p" });
check("capture: claude --output-format json", tC.args.includes("--output-format") && tC.args[tC.args.indexOf("--output-format") + 1] === "json");
const tG = buildSpawnTarget({ harness: "grok", cwd: "/tmp", name: "w", promptPath: "/tmp/x.md", prompt: "p" });
check("capture: grok --output-format json", tG.args.includes("--output-format") && tG.args[tG.args.indexOf("--output-format") + 1] === "json");
const tX = buildSpawnTarget({ harness: "codex", cwd: "/tmp", name: "w", promptPath: "/tmp/x.md", prompt: "p" });
check("capture: codex exec --json", tX.args.includes("--json"));
check("capture: codex thread.started", extractHarnessSessionId("codex", JSON.stringify({ type: "thread.started", thread_id: "thread-abc" })) === "thread-abc");
check("capture: claude session_id", extractHarnessSessionId("claude", JSON.stringify({ type: "result", session_id: "abc-123" })) === "abc-123");
check("capture: opencode step_start", extractHarnessSessionId("opencode", "junk line\n" + JSON.stringify({ type: "step_start", sessionID: "ses_abc" })) === "ses_abc");
check("capture: grok sessionId", extractHarnessSessionId("grok", JSON.stringify({ sessionId: "xyz", foo: 1 })) === "xyz");
check("capture: nested session.id", extractHarnessSessionId("opencode", JSON.stringify({ session: { id: "nested-1" } })) === "nested-1");
const PRE_UUID = "11111111-2222-4333-8444-555555555555";
const tCp = buildSpawnTarget({ harness: "claude", cwd: "/tmp", name: "w", promptPath: "/tmp/x.md", prompt: "p", sessionId: PRE_UUID });
check("capture: claude --session-id preassign", tCp.args.includes("--session-id") && tCp.args[tCp.args.indexOf("--session-id") + 1] === PRE_UUID);
const tGp = buildSpawnTarget({ harness: "grok", cwd: "/tmp", name: "w", promptPath: "/tmp/x.md", prompt: "p", sessionId: PRE_UUID });
check("capture: grok -s preassign", tGp.args.includes("-s") && tGp.args[tGp.args.indexOf("-s") + 1] === PRE_UUID);
check("capture: no preassign without id", !buildSpawnTarget({ harness: "claude", cwd: "/tmp", name: "w", promptPath: "/tmp/x.md", prompt: "p" }).args.includes("--session-id"));
check("capture: junk null", extractHarnessSessionId("codex", "plain text\nnot json") === null);
check("capture: empty null", extractHarnessSessionId("claude", "") === null && extractHarnessSessionId("claude", null) === null);
check("capture: non-string ignored", extractHarnessSessionId("claude", JSON.stringify({ session_id: 42 })) === null);
const capBoard = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cap-"));
const capD = ensureBoard(capBoard);
check("capture: board has worker-sessions dir", fs.existsSync(path.join(capBoard, "worker-sessions")));
fs.writeFileSync(path.join(capBoard, "agents", "cap1.json"), JSON.stringify({ name: "cap1", spawnedPid: 999999999, spawnedBy: "lead", briefId: "msg-x" }));
fs.mkdirSync(path.join(capBoard, "logs"), { recursive: true });
fs.writeFileSync(path.join(capBoard, "logs", "cap1-261004-000000.log"), "booting\n" + JSON.stringify({ type: "result", session_id: "sess-cap-1" }) + "\n");
const synced = syncWorkerSession(capD, "cap1");
check("capture: sync extracts id from log", !!synced && synced.harnessSessionId === "sess-cap-1");
check("capture: doc persists", readWorkerSession(capD, "cap1").harnessSessionId === "sess-cap-1");
check("capture: workerStatus carries id", workerStatus(capD, "cap1", 5).harnessSessionId === "sess-cap-1");
fs.writeFileSync(path.join(capBoard, "agents", "cap2.json"), JSON.stringify({ name: "cap2", spawnedPid: 999999998, spawnedBy: "lead", briefId: "msg-y" }));
fs.writeFileSync(path.join(capBoard, "logs", "cap2-261004-000000.log"), "plain text, no json here\n");
check("capture: null when no id", (syncWorkerSession(capD, "cap2") || {}).harnessSessionId === undefined);
const cap2doc = readWorkerSession(capD, "cap2");
check("capture: guard recorded", !!cap2doc && typeof cap2doc.checkedSize === "number");
bootWorker(capD, { harness: "generic", cmd: 'node -e "process.exit(0)"', cwd: capBoard, root: capD.root }, { to: "cap3", id: "msg-z", from: "lead", body: "b", logDir: path.join(capBoard, "logs") });
check("capture: boot writes binding doc", readWorkerSession(capD, "cap3").harness === "generic");
bootWorker(capD, { harness: "generic", cmd: 'node -e "process.exit(0)"', cwd: capBoard, root: capD.root }, { to: "cap4", id: "msg-w", from: "lead", body: "b", logDir: path.join(capBoard, "logs"), sessionId: PRE_UUID });
const cap4doc = readWorkerSession(capD, "cap4");
check("capture: boot records preassigned id", cap4doc.harnessSessionId === PRE_UUID && cap4doc.idSource === "preassigned");
fs.appendFileSync(cap4doc.logPath, JSON.stringify({ type: "result", session_id: PRE_UUID }) + "\n");
check("capture: log corroboration confirms", syncWorkerSession(capD, "cap4").idSource === "preassigned-confirmed");
bootWorker(capD, { harness: "generic", cmd: 'node -e "process.exit(0)"', cwd: capBoard, root: capD.root }, { to: "cap5", id: "msg-v", from: "lead", body: "b", logDir: path.join(capBoard, "logs"), sessionId: PRE_UUID });
const cap5doc = readWorkerSession(capD, "cap5");
fs.appendFileSync(cap5doc.logPath, JSON.stringify({ session_id: "other-id-9" }) + "\n");
const cap5synced = syncWorkerSession(capD, "cap5");
check("capture: log disagreement overrides", cap5synced.harnessSessionId === "other-id-9" && cap5synced.idSource === "log-override");
// the detached boot child can hold its log file briefly on Windows — retry
for (let i = 0; i < 10; i++) {
  try {
    fs.rmSync(capBoard, { recursive: true, force: true });
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ------------------------------------------------------- respawn targets (slice 2)
const rtO = buildRespawnTarget({ harness: "opencode", cwd: "/tmp", name: "w", promptPath: "/p.md", prompt: "c", sessionId: "SID" });
check("respawn: opencode --session", rtO.args.includes("--session") && rtO.args[rtO.args.indexOf("--session") + 1] === "SID" && rtO.args.includes("--file"));
const rtC = buildRespawnTarget({ harness: "claude", cwd: "/tmp", name: "w", promptPath: "/p.md", prompt: "c", sessionId: "SID" });
check("respawn: claude --resume, no --session-id", rtC.args.includes("--resume") && rtC.args[rtC.args.indexOf("--resume") + 1] === "SID" && !rtC.args.includes("--session-id") && rtC.stdinPath === "/p.md");
const rtX = buildRespawnTarget({ harness: "codex", cwd: "/tmp", name: "w", promptPath: "/p.md", prompt: "hello", sessionId: "SID" });
const rxi = rtX.args.indexOf("resume");
check("respawn: codex resume placement", rxi !== -1 && rtX.args[rxi + 1] === "SID" && rtX.args[rtX.args.length - 1].includes("catch-up brief at /p.md") && rtX.args.indexOf("--sandbox") < rxi);
const rtG = buildRespawnTarget({ harness: "grok", cwd: "/tmp", name: "w", promptPath: "/p.md", prompt: "c", sessionId: "SID" });
check("respawn: grok -r", rtG.args.includes("-r") && rtG.args[rtG.args.indexOf("-r") + 1] === "SID");
const rtA = buildRespawnTarget({ harness: "antigravity", cwd: "/tmp", name: "w", promptPath: "/p.md", prompt: "c", sessionId: "SID" });
check("respawn: agy --conversation", rtA.args.includes("--conversation") && rtA.args[rtA.args.indexOf("--conversation") + 1] === "SID");
const rtCu = buildRespawnTarget({ harness: "cursor", cwd: "/tmp", name: "w", promptPath: "/p.md", prompt: "c", sessionId: "SID" });
check("respawn: cursor --resume", rtCu.args.includes("--resume") && rtCu.args[rtCu.args.indexOf("--resume") + 1] === "SID");
const rtN = buildRespawnTarget({ harness: "generic", cmd: "do-work", cwd: "/tmp", name: "w", promptPath: "/p.md", prompt: "c", sessionId: null });
check("respawn: generic fresh (no resume flags)", !rtN.args.join(" ").includes("resume") && !rtN.args.join(" ").includes("session"));
const brief = buildRespawnBrief({ name: "w", attempt: 2, origPromptPath: "/l/w.prompt.md", briefId: "msg-1", harnessSessionId: "SID", harness: "claude", lead: "boss", extraBody: "hurry" });
check("respawn: brief threads + attempt", brief.includes("attempt 2") && brief.includes("/l/w.prompt.md") && brief.includes("--reply msg-1") && brief.includes("hurry") && brief.includes("SID"));
const briefG = buildRespawnBrief({ name: "w", attempt: 1, origPromptPath: "/l/w.prompt.md", briefId: "msg-1", harnessSessionId: null, harness: "generic", lead: "boss" });
check("respawn: generic brief fresh", briefG.includes("fresh session"));

// ------------------------------------------------------- init adapters
const mkproj = () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), "cb-proj-"));
  const e = { ...process.env };
  delete e.CREWBUS_DIR;
  delete e.CREWBUS_AGENT;
  return { p, e };
};

const full = mkproj();
run(["cli", "init", "--harness", "claude,codex,antigravity,grok,cursor"], full.e, full.p);
for (const f of [".claude/settings.json", ".codex/hooks.json", ".agents/hooks.json", ".agents/mcp_config.json", ".mcp.json", ".grok/hooks/crewbus.json", ".cursor/hooks.json", ".cursor/mcp.json", "AGENTS.md"]) {
  check(`init: writes ${f}`, fs.existsSync(path.join(full.p, f)));
}
const claudeHooks = JSON.parse(fs.readFileSync(path.join(full.p, ".claude", "settings.json"), "utf8"));
check("init: claude SessionStart+Stop", !!claudeHooks.hooks.SessionStart && !!claudeHooks.hooks.Stop);
const claudeWaiter = (claudeHooks.hooks.PostToolUse || []).flatMap((g) => g.hooks || []).find((h) => String(h.command || "").includes("crewbus-hook") && String(h.command || "").includes(" wait "));
check("init: claude PostToolUse asyncRewake waiter", !!claudeWaiter && claudeWaiter.asyncRewake === true && claudeWaiter.timeout === 150);
check("init: claude SessionStart waiter", (claudeHooks.hooks.SessionStart || []).flatMap((g) => g.hooks || []).some((h) => String(h.command || "").includes(" wait ")));
const agHooks = JSON.parse(fs.readFileSync(path.join(full.p, ".agents", "hooks.json"), "utf8"));
check("init: antigravity keyed block", !!agHooks["crewbus-dm"].Stop && !!agHooks["crewbus-dm"].PreInvocation);
const grokHooks = JSON.parse(fs.readFileSync(path.join(full.p, ".grok", "hooks", "crewbus.json"), "utf8"));
check("init: grok SessionStart+Stop+PostToolUse", !!grokHooks.hooks.SessionStart && !!grokHooks.hooks.Stop && !!grokHooks.hooks.PostToolUse);
check("init: grok inbox skill", fs.existsSync(path.join(full.p, ".grok", "skills", "crewbus-inbox", "SKILL.md")));
const curHooks = JSON.parse(fs.readFileSync(path.join(full.p, ".cursor", "hooks.json"), "utf8"));
check("init: cursor flat hooks", curHooks.version === 1 && Array.isArray(curHooks.hooks.sessionStart) && Array.isArray(curHooks.hooks.stop));
const curMcp = JSON.parse(fs.readFileSync(path.join(full.p, ".cursor", "mcp.json"), "utf8"));
check("init: cursor MCP server", !!(curMcp.mcpServers && curMcp.mcpServers.crewbus && curMcp.mcpServers.crewbus.command));
check("init: board.json records harnesses", JSON.parse(fs.readFileSync(path.join(full.p, ".crewbus", "board.json"), "utf8")).harnesses.length === 5);
const md = fs.readFileSync(path.join(full.p, "AGENTS.md"), "utf8");
check("init: AGENTS harness notes", md.includes("crewbus:harness:claude") && md.includes("crewbus:harness:grok"));
// idempotent re-init, preserves user hooks
const before = fs.readFileSync(path.join(full.p, ".claude", "settings.json"), "utf8");
const beforeCur = fs.readFileSync(path.join(full.p, ".cursor", "hooks.json"), "utf8");
const beforeGrok = fs.readFileSync(path.join(full.p, ".grok", "hooks", "crewbus.json"), "utf8");
const beforeSkill = fs.readFileSync(path.join(full.p, ".grok", "skills", "crewbus-inbox", "SKILL.md"), "utf8");
run(["cli", "init", "--harness", "claude,codex,antigravity,grok,cursor"], full.e, full.p);
check("init: re-run byte-identical cursor hooks", fs.readFileSync(path.join(full.p, ".cursor", "hooks.json"), "utf8") === beforeCur);
check("init: re-run byte-identical hooks", fs.readFileSync(path.join(full.p, ".claude", "settings.json"), "utf8") === before);
check("init: re-run byte-identical grok hooks", fs.readFileSync(path.join(full.p, ".grok", "hooks", "crewbus.json"), "utf8") === beforeGrok);
check("init: re-run keeps grok skill", fs.readFileSync(path.join(full.p, ".grok", "skills", "crewbus-inbox", "SKILL.md"), "utf8") === beforeSkill);
fs.writeFileSync(path.join(full.p, ".claude", "settings.json"), JSON.stringify({ hooks: { ...claudeHooks.hooks, PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "prettier" }] }, ...(claudeHooks.hooks.PostToolUse || [])] } }));
run(["cli", "init", "--harness", "claude"], full.e, full.p);
const merged = JSON.parse(fs.readFileSync(path.join(full.p, ".claude", "settings.json"), "utf8"));
const mergedCmds = (merged.hooks.PostToolUse || []).flatMap((g) => g.hooks || []).map((h) => h.command || "");
check("init: preserves user hooks", !!merged.hooks.Stop && mergedCmds.some((c) => c === "prettier") && mergedCmds.some((c) => c.includes("crewbus-hook") && c.includes(" wait ")));
fs.rmSync(full.p, { recursive: true, force: true });

// auto-detect: .agents marker -> antigravity only
const det = mkproj();
fs.mkdirSync(path.join(det.p, ".agents"), { recursive: true });
const detOut = run(["cli", "init"], det.e, det.p);
check("init: auto-detects antigravity", detOut.includes("Detected harness markers: antigravity") && fs.existsSync(path.join(det.p, ".agents", "hooks.json")));
check("init: no opencode files when not detected", !fs.existsSync(path.join(det.p, ".opencode")));
fs.rmSync(det.p, { recursive: true, force: true });

// legacy default: no markers -> opencode
const leg = mkproj();
run(["cli", "init"], leg.e, leg.p);
check("init: legacy default installs opencode", fs.existsSync(path.join(leg.p, ".opencode", "tools", "dm-send.js")));
fs.rmSync(leg.p, { recursive: true, force: true });

// --portable: PATH-based MCP entries for global installs
const port = mkproj();
run(["cli", "init", "--harness", "claude,codex", "--portable"], port.e, port.p);
check(
  "init: --portable writes binary MCP entry",
  JSON.parse(fs.readFileSync(path.join(port.p, ".mcp.json"), "utf8")).mcpServers.crewbus.command === "crewbus-mcp"
);
fs.rmSync(port.p, { recursive: true, force: true });

// claude-plugin bundle: marketplace-ready, PATH-based (no absolute paths)
const plugDir = path.join(HERE, "..", "claude-plugin");
const plugJson = JSON.parse(fs.readFileSync(path.join(plugDir, ".claude-plugin", "plugin.json"), "utf8"));
check("plugin: manifest name/version", plugJson.name === "crewbus" && !!plugJson.version);
const plugHooks = JSON.parse(fs.readFileSync(path.join(plugDir, "hooks", "hooks.json"), "utf8"));
check("plugin: hooks events", !!plugHooks.hooks.SessionStart && !!plugHooks.hooks.Stop && !!plugHooks.hooks.PostToolUse);
const plugWaiters = ["SessionStart", "PostToolUse"].every((ev) =>
  (plugHooks.hooks[ev] || []).flatMap((g) => g.hooks || []).some((h) => h.asyncRewake === true && String(h.command || "").includes("crewbus-hook wait"))
);
check("plugin: asyncRewake waiters", plugWaiters);
const plugCmds = ["SessionStart", "Stop", "PostToolUse"].flatMap((ev) => (plugHooks.hooks[ev] || []).flatMap((g) => g.hooks || []).map((h) => h.command || ""));
check("plugin: no absolute paths", plugCmds.length > 0 && plugCmds.every((c) => !path.isAbsolute(c) && !c.includes("C:/") && !c.startsWith("/")));
const plugMcp = JSON.parse(fs.readFileSync(path.join(plugDir, ".mcp.json"), "utf8"));
check("plugin: MCP server", !!(plugMcp.mcpServers && plugMcp.mcpServers.crewbus && plugMcp.mcpServers.crewbus.command));
check("plugin: skill", fs.existsSync(path.join(plugDir, "skills", "crewbus", "SKILL.md")));

// respawn e2e (generic harness — real processes, no vendor binary needed)
const rsp = mkproj();
run(["cli", "init", "--harness", "generic"], rsp.e, rsp.p);
run(["cli", "register", "--from", "boss"], rsp.e, rsp.p);
run(["cli", "register", "--from", "work1"], rsp.e, rsp.p);
run(["cli", "spawn", "--from", "boss", "--harness", "generic", "--cmd", 'node -e "setTimeout(()=>{},60000)"', "--to", "rs1", "--body", "sleep brief"], rsp.e, rsp.p);
const mustFail = (label, args) => {
  let bad = false;
  try {
    run(["cli", ...args], rsp.e, rsp.p);
  } catch {
    bad = true;
  }
  check(label, bad);
};
mustFail("respawn: refuses live worker", ["respawn", "--from", "boss", "--to", "rs1"]);
mustFail("respawn: worker role refused", ["respawn", "--from", "work1", "--to", "rs1"]);
mustFail("respawn: unknown worker refused", ["respawn", "--from", "boss", "--to", "ghost-rs"]);
mustFail("respawn: multi --to refused", ["respawn", "--from", "boss", "--to", "rs1,rs2"]);
const dryRs = run(["cli", "respawn", "--from", "boss", "--to", "rs1", "--dry-run"], rsp.e, rsp.p);
check("respawn: dry-run previews", dryRs.includes("would respawn rs1") && dryRs.includes("catch-up brief"));
run(["cli", "spawn-kill", "--from", "boss", "--to", "rs1"], rsp.e, rsp.p);
const r1 = run(["cli", "respawn", "--from", "boss", "--to", "rs1"], rsp.e, rsp.p);
check("respawn: reboots dead generic", r1.includes("respawned rs1") && r1.includes("attempt 1") && r1.includes("fresh boot"));
const rdoc = JSON.parse(fs.readFileSync(path.join(rsp.p, ".crewbus", "worker-sessions", "rs1.json"), "utf8"));
check("respawn: binding attempt counted", rdoc.respawnCount === 1 && typeof rdoc.spawnedPid === "number" && !!rdoc.lastRespawnAt);
check("respawn: status carries respawns", JSON.parse(run(["cli", "spawn-status", "--to", "rs1", "--json"], rsp.e, rsp.p))[0].respawnCount === 1);
run(["cli", "spawn-kill", "--from", "boss", "--to", "rs1"], rsp.e, rsp.p);
const r2 = run(["cli", "respawn", "--from", "boss", "--to", "rs1", "--body", "extra nudge"], rsp.e, rsp.p);
check("respawn: attempt increments", r2.includes("attempt 2"));
// no-id harness worker: crafted binding without a captured session id
fs.writeFileSync(path.join(rsp.p, ".crewbus", "agents", "rs2.json"), JSON.stringify({ name: "rs2", spawnedPid: 999999997, spawnedBy: "boss", briefId: "msg-rs2" }));
fs.writeFileSync(path.join(rsp.p, ".crewbus", "worker-sessions", "rs2.json"), JSON.stringify({ name: "rs2", harness: "claude", spawnedPid: 999999997, briefId: "msg-rs2", logPath: path.join(rsp.p, ".crewbus", "logs", "rs2-x.log") }));
mustFail("respawn: no-id refused with guidance", ["respawn", "--from", "boss", "--to", "rs2"]);
// cleanup: kill sleepers (Windows holds log handles briefly — retry rm)
run(["cli", "spawn-kill", "--from", "boss", "--to", "rs1"], rsp.e, rsp.p);
for (let i = 0; i < 10; i++) {
  try {
    fs.rmSync(rsp.p, { recursive: true, force: true });
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}

// presence (item 1: recycled-pid guard)
const meStart = pidStartTime(process.pid);
check("presence: own start time sane", typeof meStart === "number" && meStart > 0 && meStart <= Date.now());
check("presence: dead pid null", pidStartTime(999999999) === null);
check("presence: invalid null", pidStartTime(0) === null && pidStartTime(-1) === null && pidStartTime("x") === null);
check("presence: etime mm:ss", parsePsEtime("10:23") === 623000);
check("presence: etime hh:mm:ss", parsePsEtime("02:03:04") === 7384000);
check("presence: etime dd-hh:mm:ss", parsePsEtime("1-02:03:04") === 93784000);
check("presence: etime junk null", parsePsEtime("bogus") === null && parsePsEtime("") === null);
const pv = mkproj();
run(["cli", "init", "--harness", "generic"], pv.e, pv.p);
run(["cli", "register", "--from", "pvboss"], pv.e, pv.p);
run(["cli", "spawn", "--from", "pvboss", "--harness", "generic", "--cmd", 'node -e "setTimeout(()=>{},60000)"', "--to", "pv1", "--body", "presence probe"], pv.e, pv.p);
const pvLive = JSON.parse(run(["cli", "spawn-status", "--to", "pv1", "--json"], pv.e, pv.p))[0];
check("presence: live worker verified", pvLive.alive === true && pvLive.aliveVerified === true);
run(["cli", "spawn-kill", "--from", "pvboss", "--to", "pv1"], pv.e, pv.p);
const pvDead = JSON.parse(run(["cli", "spawn-status", "--to", "pv1", "--json"], pv.e, pv.p))[0];
check("presence: dead worker unverified", pvDead.alive === false && pvDead.aliveVerified === null);
for (let i = 0; i < 10; i++) {
  try {
    fs.rmSync(pv.p, { recursive: true, force: true });
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}

// checkpoints (item 3: flagged thread replies, progress not work)
const cpj = mkproj();
run(["cli", "init", "--harness", "generic"], cpj.e, cpj.p);
run(["cli", "register", "--from", "cplead"], cpj.e, cpj.p);
run(["cli", "register", "--from", "cpw"], cpj.e, cpj.p);
const cpBrief = run(["cli", "send", "--from", "cpw", "--to", "cplead", "--body", "work brief"], cpj.e, cpj.p).match(/sent (\S+) ->/)[1];
run(["cli", "send", "--from", "cpw", "--to", "cplead", "--reply", cpBrief, "--checkpoint", "--body", "done X / next Y"], cpj.e, cpj.p);
const cpInbox = JSON.parse(run(["cli", "inbox", "--from", "cplead", "--json"], cpj.e, cpj.p));
check("checkpoint: stored flag", cpInbox.some((m) => m.replyTo === cpBrief && m.checkpoint === true));
check("checkpoint: labeled in text", run(["cli", "inbox", "--from", "cplead"], cpj.e, cpj.p).includes("checkpoint: progress"));
check("checkpoint: digest labeled", run(["cli", "inbox", "--from", "cplead", "--digest"], cpj.e, cpj.p).includes("[checkpoint]"));
const cpUnacked = run(["cli", "inbox", "--from", "cplead", "--unacked"], cpj.e, cpj.p);
check("checkpoint: unacked excludes", cpUnacked.includes("work brief") && !cpUnacked.includes("done X"));
await new Promise((r) => setTimeout(r, 1100));
const cpStale = run(["cli", "ack", "--from", "cplead", "--timeout", "1s"], cpj.e, cpj.p);
check("checkpoint: ack-timeout excludes", cpStale.includes("1 message(s)") && cpStale.includes(cpBrief) && !cpStale.includes("done X"));
check("checkpoint: thread shows", run(["cli", "thread", "--id", cpBrief], cpj.e, cpj.p).includes("done X"));
check("checkpoint: prompt discipline", buildSpawnPrompt({ name: "w", from: "lead", body: "b", replyId: "msg-1", cwd: "/tmp", root: "/tmp/.crewbus" }).includes("--checkpoint"));
// spawn-status reply detection ignores checkpoints (lib-level, no binary needed)
const cpD = ensureBoard(path.join(cpj.p, ".crewbus"));
fs.writeFileSync(path.join(cpj.p, ".crewbus", "agents", "cpw2.json"), JSON.stringify({ name: "cpw2", spawnedPid: 999999995, spawnedBy: "cplead", briefId: "b-ck" }));
run(["cli", "send", "--from", "cpw2", "--to", "cplead", "--reply", "b-ck", "--checkpoint", "--body", "still working"], cpj.e, cpj.p);
check("checkpoint: no false reply", workerStatus(cpD, "cpw2", 5).reply === null);
run(["cli", "send", "--from", "cpw2", "--to", "cplead", "--reply", "b-ck", "--body", "final summary"], cpj.e, cpj.p);
check("checkpoint: real reply detected", (workerStatus(cpD, "cpw2", 5).reply || {}).head.includes("final summary"));
for (let i = 0; i < 10; i++) {
  try {
    fs.rmSync(cpj.p, { recursive: true, force: true });
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}
// MCP: dm_send checkpoint + unacked exclusion + label (dedicated server —
// the top-level one is killed after the MCP section)
const cpMcpBoard = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cpmcp-"));
const cpSrv = spawn("node", [MCP], { env: { ...process.env, CREWBUS_DIR: cpMcpBoard }, stdio: ["pipe", "pipe", "inherit"] });
let cpBuf = "";
const cpPending = [];
cpSrv.stdout.on("data", (d) => {
  cpBuf += d.toString();
  let i;
  while ((i = cpBuf.indexOf("\n")) !== -1) {
    const line = cpBuf.slice(0, i).trim();
    cpBuf = cpBuf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const w = cpPending.find((p) => p.id === msg.id);
    if (w) {
      cpPending.splice(cpPending.indexOf(w), 1);
      w.res(msg);
    }
  }
});
let cpId = 1;
const cpReq = (method, params) =>
  new Promise((res) => {
    const id = cpId++;
    cpPending.push({ id, res });
    cpSrv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
await cpReq("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });
const eveReg = await cpReq("tools/call", { name: "dm_register", arguments: { agent: "eve" } });
const eveTok = eveReg.result.content[0].text.match(/token (abt-[0-9a-f]+)/)[1];
const aliceReg = await cpReq("tools/call", { name: "dm_register", arguments: { agent: "alice" } });
const cpAliceTok = aliceReg.result.content[0].text.match(/token (abt-[0-9a-f]+)/)[1];
await cpReq("tools/call", { name: "dm_send", arguments: { from: "alice", to: "eve", body: "eve brief", token: cpAliceTok } });
const mcpCk = await cpReq("tools/call", { name: "dm_send", arguments: { from: "alice", to: "eve", body: "eve progress", checkpoint: true, token: cpAliceTok } });
check("checkpoint: mcp send ok", /sent \S+ -> eve/.test(mcpCk.result.content[0].text));
const eveUnacked = await cpReq("tools/call", { name: "dm_inbox", arguments: { agent: "eve", token: eveTok, unacked: true } });
check("checkpoint: mcp unacked excludes", eveUnacked.result.content[0].text.includes("eve brief") && !eveUnacked.result.content[0].text.includes("eve progress"));
const eveFull = await cpReq("tools/call", { name: "dm_inbox", arguments: { agent: "eve", token: eveTok } });
check("checkpoint: mcp labeled", eveFull.result.content[0].text.includes("[checkpoint: progress"));
cpSrv.kill();
for (let i = 0; i < 10; i++) {
  try {
    fs.rmSync(cpMcpBoard, { recursive: true, force: true });
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}

// pool resume (supervisor re-attach) + reconcile wiring
const pl = mkproj();
run(["cli", "init", "--harness", "generic"], pl.e, pl.p);
const plBossTok = run(["cli", "register", "--from", "plboss"], pl.e, pl.p).match(/token (abt-[0-9a-f]+)/)[1];
const supEnv = { ...pl.e, CREWBUS_TOKEN: plBossTok };
const bgCli = (args, outName) => {
  const fd = fs.openSync(path.join(pl.p, outName), "a");
  const child = spawn("node", [CLI, ...args], { env: supEnv, cwd: pl.p, stdio: ["ignore", fd, fd], detached: true });
  child.unref();
  return { child, fd, outName };
};
const waitForLog = async (name, needle, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      if (fs.readFileSync(path.join(pl.p, name), "utf8").includes(needle)) return true;
    } catch {}
  }
  return false;
};
const stopBg = (h) => {
  try { h.child.kill(); } catch {}
  try { fs.closeSync(h.fd); } catch {}
};
const readPoolState = (id) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(pl.p, ".crewbus", "pool-state", id + ".json"), "utf8"));
  } catch {
    return null;
  }
};
const waitPoolState = async (id, pred, tries = 120) => {
  for (let i = 0; i < tries; i++) {
    const st = readPoolState(id);
    if (st && pred(st)) return st;
    await new Promise((r) => setTimeout(r, 500));
  }
  return readPoolState(id);
};
const waitPoolFile = async (exclude = [], tries = 60) => {
  for (let i = 0; i < tries; i++) {
    const files = fs.readdirSync(path.join(pl.p, ".crewbus", "pool-state")).filter((f) => f.endsWith(".json") && !exclude.includes(f));
    if (files.length > 0) return files[0].replace(/\.json$/, "");
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
};
// Pool A (schema): background supervisor boots 60s sleepers so the pool is
// still mid-run when read — instant-exit workers would already be finished
// on fast boxes (and linger ~60s on Windows detached shells), making any
// mid-run snapshot assertion platform-flaky either way.
const supA = bgCli(["pool", "--from", "plboss", "--count", "3", "--pool-size", "2", "--harness", "generic", "--cmd", 'node -e "setTimeout(()=>{},60000)"', "--prefix", "plw", "--body", "pool brief", "--json"], "supA.log");
const poolId = await waitPoolFile();
check("pool: one state file", !!poolId);
const poolFiles = poolId ? [poolId + ".json"] : [];
const pst = await waitPoolState(poolId, (st) => st.launched === 2);
check("pool: resumable schema", !!pst && Array.isArray(pst.queue) && pst.queue.length === 3 && pst.cursor === 2 && pst.idByName && Object.keys(pst.idByName).length === 3 && !!pst.spawnOpts && pst.body === "pool brief");
check("pool: results carry prompt", !!pst && (pst.results || []).every((r) => r.error || r.promptPath));
check("pool: launched pair", !!pst && pst.launched === 2);
stopBg(supA);
const plMustFail = (label, args) => {
  let bad = false;
  try {
    run(["cli", ...args], pl.e, pl.p);
  } catch {
    bad = true;
  }
  check(label, bad);
};
plMustFail("pool-resume: unknown refused", ["pool-resume", "--from", "plboss", "--id", "pool-nope"]);
fs.writeFileSync(path.join(pl.p, ".crewbus", "pool-state", "legacy.json"), JSON.stringify({ id: "legacy", from: "plboss", total: 1, poolSize: 1, harness: "generic", done: 0, active: {}, results: [] }));
plMustFail("pool-resume: legacy refused", ["pool-resume", "--from", "plboss", "--id", "legacy"]);
fs.rmSync(path.join(pl.p, ".crewbus", "pool-state", "legacy.json"));
// single-flight: crafted live lock refuses a second supervisor
const lockFile = path.join(pl.p, ".crewbus", "locks", crypto.createHash("sha256").update(`pool/${poolId}`).digest("hex").slice(0, 16) + ".json");
fs.mkdirSync(path.join(pl.p, ".crewbus", "locks"), { recursive: true });
fs.writeFileSync(lockFile, JSON.stringify({ scope: `pool/${poolId}`, owner: "someone-else", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() }) + "\n");
plMustFail("pool-resume: locked refused", ["pool-resume", "--from", "plboss", "--id", poolId]);
fs.rmSync(lockFile, { force: true });
// Pool B (reconcile-finish): supervisor dies, both replies land, resume
// finishes immediately — no launches, no waiting on exits.
const supB = bgCli(["pool", "--from", "plboss", "--count", "2", "--pool-size", "2", "--harness", "generic", "--cmd", 'node -e "setTimeout(()=>{},60000)"', "--prefix", "plq", "--body", "sleep pair"], "supB.log");
const resumeIdB = await waitPoolFile([poolFiles[0]]);
check("pool B: state file appears", !!resumeIdB);
const bBooted = resumeIdB ? await waitPoolState(resumeIdB, (st) => st.launched === 2) : null;
check("pool B: workers booted", !!bBooted);
stopBg(supB);
const qState = JSON.parse(fs.readFileSync(path.join(pl.p, ".crewbus", "pool-state", resumeIdB + ".json"), "utf8"));
for (const w of ["plq-1", "plq-2"]) {
  run(["cli", "register", "--from", w], pl.e, pl.p);
  run(["cli", "send", "--from", w, "--to", "plboss", "--reply", qState.idByName[w], "--body", `done ${w}`], pl.e, pl.p);
}
const finOut = run(["cli", "pool-resume", "--from", "plboss", "--id", resumeIdB], supEnv, pl.p);
check("pool-resume: replied counted, none relaunched", finOut.includes("already replied") && finOut.includes("done 2"));
const fst = JSON.parse(fs.readFileSync(path.join(pl.p, ".crewbus", "pool-state", resumeIdB + ".json"), "utf8"));
check("pool-resume: finished + lock released", !!fst.finishedAt && fst.done === 2 && fst.results.length === 2 && !fs.existsSync(path.join(pl.p, ".crewbus", "locks", crypto.createHash("sha256").update(`pool/${resumeIdB}`).digest("hex").slice(0, 16) + ".json")));
plMustFail("pool-resume: finished refused", ["pool-resume", "--from", "plboss", "--id", resumeIdB]);
// Pool C (adopt + relaunch): supervisor dies with one live worker; resume
// adopts it, then a kill triggers the second boot — all transitions forced,
// no natural-exit waits.
const supC = bgCli(["pool", "--from", "plboss", "--count", "2", "--pool-size", "1", "--harness", "generic", "--cmd", 'node -e "setTimeout(()=>{},60000)"', "--prefix", "plr", "--body", "sleep crew"], "supC.log");
const resumeId = await waitPoolFile([poolFiles[0], resumeIdB + ".json"]);
check("pool C: state file appears", !!resumeId);
const cBooted = resumeId ? await waitPoolState(resumeId, (st) => st.launched >= 1) : null;
check("pool C: first worker booted", !!cBooted);
stopBg(supC);
const supR = bgCli(["pool-resume", "--from", "plboss", "--id", resumeId], "supR.log");
check("pool-resume: adopts live worker", await waitForLog("supR.log", "adopted live plr-1"));
run(["cli", "spawn-kill", "--from", "plboss", "--to", "plr-1"], pl.e, pl.p);
check("pool-resume: relaunches after kill", await waitForLog("supR.log", "spawned plr-2"));
stopBg(supR);
const rst = JSON.parse(fs.readFileSync(path.join(pl.p, ".crewbus", "pool-state", resumeId + ".json"), "utf8"));
check("pool-resume: adopted once, second booted", rst.results.filter((r) => r.to === "plr-1").length === 1 && rst.results.filter((r) => r.to === "plr-2").length === 1 && rst.results.some((r) => r.to === "plr-2" && r.resumed === true) && !rst.finishedAt && rst.done === 1);
check("pool-resume: killed supervisor holds lock", fs.existsSync(path.join(pl.p, ".crewbus", "locks", crypto.createHash("sha256").update(`pool/${resumeId}`).digest("hex").slice(0, 16) + ".json")));
// reconcile: stale pid (live test-process pid + ancient spawn) reads dead
fs.writeFileSync(path.join(pl.p, ".crewbus", "agents", "stalew.json"), JSON.stringify({ name: "stalew", spawnedPid: process.pid, spawnedBy: "plboss", spawnedAt: "2020-01-01T00:00:00.000Z", briefId: "b-s" }));
check("reconcile: isPidStale unit", isPidStale(process.pid, "2020-01-01T00:00:00.000Z") === true && isPidStale(process.pid, new Date().toISOString()) === false && isPidStale(999999999, "2020-01-01T00:00:00.000Z") === false);
const plD = ensureBoard(path.join(pl.p, ".crewbus"));
check("reconcile: stale reads dead", workerStatus(plD, "stalew", 1).alive === false && workerStatus(plD, "stalew", 1).pidStale === true);
check("reconcile: text marks stale", run(["cli", "spawn-status", "--to", "stalew"], pl.e, pl.p).includes("stale pid"));
const plDoc = run(["cli", "doctor"], pl.e, pl.p);
check("reconcile: doctor notes stale, stays healthy", plDoc.includes("stale pids") && plDoc.includes("doctor: healthy"));
run(["cli", "spawn-kill", "--from", "plboss", "--to", "plw-1,plw-2,plw-3,plq-1,plq-2,plr-1,plr-2"], pl.e, pl.p);
for (let i = 0; i < 15; i++) {
  try {
    fs.rmSync(pl.p, { recursive: true, force: true });
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}

// self-hosted Claude marketplace: repo root marketplace.json -> ./claude-plugin
const market = JSON.parse(fs.readFileSync(path.join(HERE, "..", ".claude-plugin", "marketplace.json"), "utf8"));
check("marketplace: lists crewbus plugin", market.name === "crewbus" && Array.isArray(market.plugins) && market.plugins.some((p) => p.name === "crewbus" && p.source === "./claude-plugin"));
check("marketplace: source dir resolves", market.plugins.every((p) => fs.existsSync(path.join(HERE, "..", p.source, ".claude-plugin", "plugin.json"))));

// unknown harness fails
const bad = mkproj();
let unknownFails = false;
try {
  run(["cli", "init", "--harness", "wat"], bad.e, bad.p);
} catch {
  unknownFails = true;
}
check("init: unknown harness rejected", unknownFails);
fs.rmSync(bad.p, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall harness tests passed");
