#!/usr/bin/env node
/**
 * Offline sanity check for every manifest, SKILL.md frontmatter and version agreement.
 * For the authoritative Claude Code check also run: claude plugin validate .
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const read = (p) => readFileSync(join(root, p), "utf8");
const json = (p) => {
  try {
    return JSON.parse(read(p));
  } catch (e) {
    errors.push(`${p}: ${e.message}`);
    return undefined;
  }
};
const check = (cond, msg) => cond || errors.push(msg);

const pkg = json("package.json");
const plugin = json(".claude-plugin/plugin.json");
const market = json(".claude-plugin/marketplace.json");
const gemini = json("gemini-extension.json");
const server = json("mcp-server/package.json");

const AUTHOR = "Montassar Zarai";
const SEMVER = /^\d+\.\d+\.\d+$/;

if (plugin) {
  check(plugin.name === "dex-alpha-radar", "plugin.json: name must be dex-alpha-radar");
  check(SEMVER.test(plugin.version ?? ""), "plugin.json: version must be semver");
  check(plugin.author?.name === AUTHOR, `plugin.json: author.name must be ${AUTHOR}`);
  check(plugin.mcpServers?.["dex-alpha-radar"]?.args?.[0]?.includes("${CLAUDE_PLUGIN_ROOT}/scripts/mcp-launch.mjs"), "plugin.json: mcpServers must launch scripts/mcp-launch.mjs via ${CLAUDE_PLUGIN_ROOT}");
}
if (market) {
  check(market.owner?.name === AUTHOR, `marketplace.json: owner.name must be ${AUTHOR}`);
  const entry = market.plugins?.find((p) => p.name === "dex-alpha-radar");
  check(!!entry, "marketplace.json: missing dex-alpha-radar plugin entry");
  check(entry?.source === "./", 'marketplace.json: plugin source must be "./"');
  check(entry?.version === plugin?.version, "marketplace.json: version differs from plugin.json");
}
if (gemini) {
  check(gemini.name === "dex-alpha-radar", "gemini-extension.json: name");
  check(gemini.version === plugin?.version, "gemini-extension.json: version differs from plugin.json");
  check(gemini.mcpServers?.["dex-alpha-radar"]?.command === "node", "gemini-extension.json: mcpServers command must be node");
  check(gemini.contextFileName === "SKILL.md" && existsSync(join(root, "SKILL.md")), "gemini-extension.json: contextFileName must point to SKILL.md");
}
check(pkg?.version === plugin?.version, "package.json: version differs from plugin.json");
check(server?.version === plugin?.version, "mcp-server/package.json: version differs from plugin.json");
check(pkg?.author === AUTHOR, "package.json: author");

// SKILL.md frontmatter
const skill = read("SKILL.md");
const fm = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1];
check(!!fm, "SKILL.md: missing YAML frontmatter");
if (fm) {
  // Agent Skills spec (agentskills.io): name <=64 chars [a-z0-9-], description <=1024,
  // compatibility <=500, only the documented top-level keys, metadata is a flat string map.
  const lines = fm.split("\n");
  const topKeys = lines.filter((l) => /^[A-Za-z][\w-]*:/.test(l)).map((l) => l.split(":")[0]);
  const ALLOWED = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);
  for (const k of topKeys) check(ALLOWED.has(k), `SKILL.md: unknown frontmatter key "${k}"`);
  const name = /^name:\s*(.+)$/m.exec(fm)?.[1]?.trim();
  const desc = /^description:\s*(.+)$/m.exec(fm)?.[1]?.trim();
  const compat = /^compatibility:\s*(.+)$/m.exec(fm)?.[1]?.trim();
  check(name === "dex-alpha-radar", "SKILL.md: name must be dex-alpha-radar");
  check(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name ?? "") && (name ?? "").length <= 64, "SKILL.md: name must be lowercase letters/digits/hyphens, <= 64 chars");
  check(!!desc && desc.length >= 80 && desc.length <= 1024, "SKILL.md: description must be 80-1024 chars");
  check(!compat || compat.length <= 500, "SKILL.md: compatibility must be <= 500 chars");
  check(!/^description:\s*[>|]/m.test(fm), "SKILL.md: keep description on a single line (portable across skill loaders)");
  const metaLines = lines.slice(lines.findIndex((l) => l.startsWith("metadata:")) + 1).filter((l) => /^\s+\S/.test(l));
  for (const l of metaLines) check(/^\s+[\w-]+:\s*"?[^\n]*"?$/.test(l), `SKILL.md: metadata must be a flat key/value map (${l.trim()})`);
  const metaVersion = /^\s+version:\s*"?([\d.]+)"?/m.exec(fm)?.[1];
  check(metaVersion === plugin?.version, `SKILL.md: metadata.version (${metaVersion}) differs from plugin.json (${plugin?.version})`);
  check(skill.split("\n").length <= 500, "SKILL.md: should stay under 500 lines (progressive disclosure)");
}
for (const f of ["README.md", "LICENSE", "assets/architecture.svg", "scripts/mcp-launch.mjs", ".gitignore"]) check(existsSync(join(root, f)), `missing file: ${f}`);
check(/Montassar Zarai/.test(read("LICENSE")), "LICENSE: must name Montassar Zarai");
check(/MIT License/.test(read("LICENSE")), "LICENSE: must be MIT");

if (errors.length) {
  console.error("Manifest validation FAILED:\n - " + errors.join("\n - "));
  process.exit(1);
}
console.log("Manifest validation passed (plugin.json, marketplace.json, gemini-extension.json, SKILL.md, versions, license).");
