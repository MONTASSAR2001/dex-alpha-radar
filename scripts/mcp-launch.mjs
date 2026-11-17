#!/usr/bin/env node
/**
 * Zero-config launcher for the dex-alpha-radar MCP server (stdio).
 *
 * On first cold start it installs dependencies and compiles mcp-server/dist/index.js,
 * then runs the server. All build output goes to stderr so stdout stays a clean
 * JSON-RPC channel for the MCP client.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = join(root, "mcp-server");
const entry = join(serverDir, "dist", "index.js");
const sdkMarker = join(serverDir, "node_modules", "@modelcontextprotocol", "sdk", "package.json");
const tscMarker = join(serverDir, "node_modules", "typescript", "package.json");
const lockDir = join(serverDir, ".build-lock");

const log = (msg) => process.stderr.write(`[dex-alpha-radar] ${msg}\n`);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  log(`Node.js 20+ is required (found ${process.versions.node}).`);
  process.exit(1);
}

function run(args) {
  const res = spawnSync(npm, args, {
    cwd: serverDir,
    // stdout -> stderr: never pollute the MCP channel.
    stdio: ["ignore", process.stderr, process.stderr],
    shell: process.platform === "win32",
    env: { ...process.env, NODE_ENV: "development", npm_config_loglevel: "error", npm_config_audit: "false", npm_config_fund: "false" },
  });
  if (res.status !== 0) {
    log(`"npm ${args.join(" ")}" failed (exit ${res.status ?? res.error?.message}).`);
    process.exit(1);
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ensureBuilt() {
  if (existsSync(entry) && existsSync(sdkMarker)) return;

  // Several agents may start the server at once: let only one build.
  let waited = 0;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch {
      if (existsSync(entry) && existsSync(sdkMarker)) return;
      if (waited > 180_000) {
        rmSync(lockDir, { recursive: true, force: true }); // stale lock
        waited = 0;
        continue;
      }
      sleepSync(500);
      waited += 500;
    }
  }
  try {
    if (!existsSync(entry) || !existsSync(sdkMarker)) {
      log("First start: installing dependencies and building (one-time, ~30s)...");
      if (!existsSync(sdkMarker) || !existsSync(tscMarker)) run(["install", "--include=dev"]);
      run(["run", "build"]);
      if (!existsSync(entry)) {
        log(`Build finished but ${entry} is missing.`);
        process.exit(1);
      }
      log("Build complete.");
    }
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

ensureBuilt();

if (process.argv.includes("--build-only")) process.exit(0);

const child = spawn(process.execPath, [entry], { stdio: "inherit", cwd: serverDir });
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => child.kill(sig));
child.on("error", (e) => {
  log(`Failed to start server: ${e.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
