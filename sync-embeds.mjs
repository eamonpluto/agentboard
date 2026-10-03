import fs from "node:fs";
const cliPath = "bin/agentboard.js";
let cli = fs.readFileSync(cliPath, "utf8");
// The embed const closes with "\n`;" (endMarker below supplies the final
// newline), so the body must not end with one — strip it here so an
// embed-installed file is byte-identical to the repo file.
function toEmbed(p) {
  let s = fs.readFileSync(p, "utf8");
  if (s.endsWith("\n")) s = s.slice(0, -1);
  s = s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$").replace(/\\\$\{/g, "\\${");
  // The line above over-escapes plain $ (turning "$env" into "\$env").
  // Undo escapes on $ not followed by {, then ensure ${ is escaped.
  s = s.replace(/\\\$(?!\{)/g, "$");
  return s;
}
function replaceConst(src, name, body) {
  const startMarker = "const " + name + " = `";
  const si = src.indexOf(startMarker);
  if (si === -1) throw new Error("start not found: " + name);
  const endMarker = "\n`;";
  const ei = src.indexOf(endMarker, si + startMarker.length);
  if (ei === -1) throw new Error("end not found: " + name);
  return src.slice(0, si + startMarker.length) + body + src.slice(ei);
}
cli = replaceConst(cli, "OPENCODE_TOOL_DM_SEND", toEmbed("opencode/tools/dm-send.js"));
cli = replaceConst(cli, "OPENCODE_PLUGIN_DM_WATCH", toEmbed("opencode/plugins/dm-watch.js"));
if (process.argv.includes("--check")) {
  const current = fs.readFileSync(cliPath, "utf8");
  if (current !== cli) {
    console.error("embeds drifted: run `node sync-embeds.mjs` and commit the result");
    process.exit(1);
  }
  console.log("embeds clean");
} else {
  fs.writeFileSync(cliPath, cli);
  console.log("embeds synced OK");
}
