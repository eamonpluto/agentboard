import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = fileURLToPath(new URL("../bin/agentboard.js", import.meta.url));
const HOOK = fileURLToPath(new URL("../bin/agentboard-hook.js", import.meta.url));
const MCP = fileURLToPath(new URL("../bin/agentboard-mcp.js", import.meta.url));

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const TOK = {};
const tokKey = (env, who) => `${(env && env.AGENTBOARD_DIR) || ""}\n${who}`;
const run = (args, env, cwd) => {
  const merged = { ...env };
  const fi = args.indexOf("--from");
  const who = fi !== -1 && args[fi + 1] && !String(args[fi + 1]).startsWith("--") ? args[fi + 1] : null;
  if (who && TOK[tokKey(merged, who)] && !merged.AGENTBOARD_TOKEN) merged.AGENTBOARD_TOKEN = TOK[tokKey(merged, who)];
  const out = execFileSync("node", [args[0] === "hook" ? HOOK : CLI, ...args.slice(1)], {
    env: merged,
    cwd: cwd || process.cwd(),
  }).toString();
  const m = out.match(/token (abt-[0-9a-f]+)/);
  if (m && who && !TOK[tokKey(merged, who)]) TOK[tokKey(merged, who)] = m[1];
  return out;
};

// ---------------------------------------------------------------- MCP server
const mcpBoard = fs.mkdtempSync(path.join(os.tmpdir(), "ab-mcp-"));
const srv = spawn("node", [MCP], { env: { ...process.env, AGENTBOARD_DIR: mcpBoard }, stdio: ["pipe", "pipe", "inherit"] });
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
check("mcp: initialize negotiates", init1.result.protocolVersion === "2024-11-05" && init1.result.serverInfo.name === "agentboard");
const init2 = await mcpReq("initialize", { protocolVersion: "9999-99-99" });
check("mcp: unknown version falls back", init2.result.protocolVersion === "2024-11-05");
const tools = await mcpReq("tools/list", {});
check(
  "mcp: 6 tools listed",
  JSON.stringify(tools.result.tools.map((t) => t.name).sort()) === JSON.stringify(["dm_ack", "dm_agents", "dm_gather", "dm_inbox", "dm_register", "dm_send"])
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
check("mcp: unknown tool isError", (await mcpReq("tools/call", { name: "nope", arguments: {} })).result.isError === true);
check("mcp: missing body isError", (await mcpReq("tools/call", { name: "dm_send", arguments: { from: "a", to: "b" } })).result.isError === true);
check("mcp: unknown method -32601", (await mcpReq("bogus/method", {})).error.code === -32601);
check("mcp: ping", JSON.stringify((await mcpReq("ping", {})).result) === "{}");
srv.kill();
fs.rmSync(mcpBoard, { recursive: true, force: true });

// mcp walk-up: server started in a subdirectory still uses the project board
const mcpWalk = fs.mkdtempSync(path.join(os.tmpdir(), "ab-mcpwalk-"));
fs.mkdirSync(path.join(mcpWalk, ".agentboard", "dm"), { recursive: true });
fs.writeFileSync(path.join(mcpWalk, ".agentboard", "board.json"), JSON.stringify({ name: "board", version: 2 }) + "\n");
const mcpDeep = path.join(mcpWalk, "sub");
fs.mkdirSync(mcpDeep, { recursive: true });
const srv2Env = { ...process.env };
delete srv2Env.AGENTBOARD_DIR;
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
check("mcp: subdir send echoes project board", wsend.result.content[0].text.includes(`[board ${path.join(mcpWalk, ".agentboard")}]`));
check("mcp: subdir send lands on project board", fs.existsSync(path.join(mcpWalk, ".agentboard", "dm", "w2")) && !fs.existsSync(path.join(mcpDeep, ".agentboard")));
// mcp board override: explicit absolute path wins over cwd
const mcpOver = fs.mkdtempSync(path.join(os.tmpdir(), "ab-mcpover-"));
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
fs.mkdirSync(path.join(mcpWalk, ".agentboard", "groups"), { recursive: true });
fs.writeFileSync(path.join(mcpWalk, ".agentboard", "groups", "mcp-team.json"), JSON.stringify({ name: "mcp-team", members: ["m1", "m2"], createdAt: new Date().toISOString() }));
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
const missBoard = path.join(os.tmpdir(), "ab-mcpmiss-" + Date.now());
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
const toolDir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-tool-"));
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
const toolProj = fs.mkdtempSync(path.join(os.tmpdir(), "ab-toolproj-"));
fs.mkdirSync(path.join(toolProj, ".agentboard", "dm"), { recursive: true });
fs.writeFileSync(path.join(toolProj, ".agentboard", "board.json"), JSON.stringify({ name: "board", version: 2 }) + "\n");
const toolSub = path.join(toolProj, "sub");
fs.mkdirSync(toolSub, { recursive: true });
const toolOut = await toolMod.default.execute(
  { from: "t1", to: "t2", body: "tool deep mail" },
  { sessionID: "ses_t", worktree: toolSub, directory: toolSub }
);
check("tool: echoes project board", toolOut.includes(`[board ${path.join(toolProj, ".agentboard")}]`));
check("tool: first send mints token", /token abt-[0-9a-f]+/.test(toolOut));
const t1Tok = toolOut.match(/token (abt-[0-9a-f]+)/)[1];
check("tool: subdir send lands on project board", fs.existsSync(path.join(toolProj, ".agentboard", "dm", "t2")));
const toolAgent = JSON.parse(fs.readFileSync(path.join(toolProj, ".agentboard", "agents", "t1.json"), "utf8"));
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
const t3msg = readFirst(path.join(toolProj, ".agentboard", "dm", "t3"));
const t4msg = readFirst(path.join(toolProj, ".agentboard", "dm", "t4"));
check(
  "tool: broadcast shared batch + subject, unique ids",
  !!t3msg.batch && t3msg.batch === t4msg.batch && t3msg.subject === "brief: x" && t3msg.id !== t4msg.id
);
// tool to_group: group file + to_group arg fans out (token from first send)
fs.mkdirSync(path.join(toolProj, ".agentboard", "groups"), { recursive: true });
fs.writeFileSync(path.join(toolProj, ".agentboard", "groups", "tg.json"), JSON.stringify({ name: "tg", members: ["t5", "t6"] }));
const toolGrp = await toolMod.default.execute(
  { from: "t1", to_group: "tg", body: "group brief", token: t1Tok },
  { sessionID: "ses_t", worktree: toolSub, directory: toolSub }
);
check("tool: to_group fans out", toolGrp.includes("sent 2 messages") && fs.existsSync(path.join(toolProj, ".agentboard", "dm", "t5")));
fs.rmSync(toolDir, { recursive: true, force: true });
fs.rmSync(toolProj, { recursive: true, force: true });

// ------------------------------------------------------- hook helper (poll)
const hookBoard = fs.mkdtempSync(path.join(os.tmpdir(), "ab-hook-"));
const henv = { ...process.env, AGENTBOARD_DIR: hookBoard };
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
const xBoard = fs.mkdtempSync(path.join(os.tmpdir(), "ab-cross-"));
const xenv = { ...process.env, AGENTBOARD_DIR: xBoard };
run(["cli", "register", "--from", "bob", "--session", "ses_bob"], xenv);
run(["cli", "send", "--from", "alice", "--to", "bob", "--body", "cross one"], xenv);
const pushes = [];
const stubClient = { session: { promptAsync: async (a) => { pushes.push(a); } }, app: { log: async () => true } };
const watchMod = await import(pathToFileURL(fileURLToPath(new URL("../opencode/plugins/dm-watch.js", import.meta.url))).href);
// the plugin resolves the board like the live runtime: AGENTBOARD_DIR env of
// its own process, else <directory>/.agentboard
const savedBoardDir = process.env.AGENTBOARD_DIR;
process.env.AGENTBOARD_DIR = xBoard;
const watcher = await watchMod.DmWatchPlugin({ client: stubClient, directory: xBoard });
await new Promise((r) => setTimeout(r, 1600));
check("cross: plugin pushes first mail", pushes.length === 1);
check("cross: hook silent after plugin delivery", run(["hook", "poll", "--from", "bob", "--style", "grok"], xenv).trim() === "");
run(["cli", "send", "--from", "alice", "--to", "bob", "--body", "cross two"], xenv);
check("cross: hook delivers second mail", run(["hook", "poll", "--from", "bob", "--style", "grok"], xenv).includes("cross two"));
await new Promise((r) => setTimeout(r, 1600));
check("cross: plugin skips hook-delivered mail", pushes.length === 1);
await watcher.dispose();
if (savedBoardDir === undefined) delete process.env.AGENTBOARD_DIR;
else process.env.AGENTBOARD_DIR = savedBoardDir;
fs.rmSync(xBoard, { recursive: true, force: true });

// ------------------------------------------------------- init adapters
const mkproj = () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), "ab-proj-"));
  const e = { ...process.env };
  delete e.AGENTBOARD_DIR;
  delete e.AGENTBOARD_AGENT;
  return { p, e };
};

const full = mkproj();
run(["cli", "init", "--harness", "claude,codex,antigravity,grok,cursor"], full.e, full.p);
for (const f of [".claude/settings.json", ".codex/hooks.json", ".agents/hooks.json", ".agents/mcp_config.json", ".mcp.json", ".grok/hooks/agentboard.json", ".cursor/hooks.json", ".cursor/mcp.json", "AGENTS.md"]) {
  check(`init: writes ${f}`, fs.existsSync(path.join(full.p, f)));
}
const claudeHooks = JSON.parse(fs.readFileSync(path.join(full.p, ".claude", "settings.json"), "utf8"));
check("init: claude SessionStart+Stop", !!claudeHooks.hooks.SessionStart && !!claudeHooks.hooks.Stop);
const agHooks = JSON.parse(fs.readFileSync(path.join(full.p, ".agents", "hooks.json"), "utf8"));
check("init: antigravity keyed block", !!agHooks["agentboard-dm"].Stop && !!agHooks["agentboard-dm"].PreInvocation);
const curHooks = JSON.parse(fs.readFileSync(path.join(full.p, ".cursor", "hooks.json"), "utf8"));
check("init: cursor flat hooks", curHooks.version === 1 && Array.isArray(curHooks.hooks.sessionStart) && Array.isArray(curHooks.hooks.stop));
const curMcp = JSON.parse(fs.readFileSync(path.join(full.p, ".cursor", "mcp.json"), "utf8"));
check("init: cursor MCP server", !!(curMcp.mcpServers && curMcp.mcpServers.agentboard && curMcp.mcpServers.agentboard.command));
check("init: board.json records harnesses", JSON.parse(fs.readFileSync(path.join(full.p, ".agentboard", "board.json"), "utf8")).harnesses.length === 5);
const md = fs.readFileSync(path.join(full.p, "AGENTS.md"), "utf8");
check("init: AGENTS harness notes", md.includes("agentboard:harness:claude") && md.includes("agentboard:harness:grok"));
// idempotent re-init, preserves user hooks
const before = fs.readFileSync(path.join(full.p, ".claude", "settings.json"), "utf8");
const beforeCur = fs.readFileSync(path.join(full.p, ".cursor", "hooks.json"), "utf8");
run(["cli", "init", "--harness", "claude,codex,antigravity,grok,cursor"], full.e, full.p);
check("init: re-run byte-identical cursor hooks", fs.readFileSync(path.join(full.p, ".cursor", "hooks.json"), "utf8") === beforeCur);
check("init: re-run byte-identical hooks", fs.readFileSync(path.join(full.p, ".claude", "settings.json"), "utf8") === before);
fs.writeFileSync(path.join(full.p, ".claude", "settings.json"), JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "prettier" }] }], ...claudeHooks.hooks } }));
run(["cli", "init", "--harness", "claude"], full.e, full.p);
const merged = JSON.parse(fs.readFileSync(path.join(full.p, ".claude", "settings.json"), "utf8"));
check("init: preserves user hooks", !!merged.hooks.PostToolUse && !!merged.hooks.Stop);
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
  JSON.parse(fs.readFileSync(path.join(port.p, ".mcp.json"), "utf8")).mcpServers.agentboard.command === "agentboard-mcp"
);
fs.rmSync(port.p, { recursive: true, force: true });

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
