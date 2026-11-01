import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath || fs.realpathSync(path.join(path.dirname(process.execPath), process.platform === "win32" ? "node_modules/npm/bin/npm-cli.js" : "npm"));

function npm(args, cwd) {
  return execFileSync(process.execPath, [npmCli, ...args], {
    cwd, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, npm_config_ignore_scripts: "false" },
  });
}

// An installed copy must start from a foreign cwd, serve the slicing tools, and carry no printer transport.
async function assertInstalledServer(packageRoot, cwd) {
  const require = createRequire(path.join(packageRoot, "package.json"));
  for (const name of ["bambu-node", "mqtt", "basic-ftp", "patch-package"]) {
    assert.throws(() => require.resolve(`${name}/package.json`), /Cannot find module/, `${name} must not be installed`);
  }
  for (const name of ["native", "patches", "scripts"]) {
    assert.equal(fs.existsSync(path.join(packageRoot, name)), false, `${name}/ must not ship`);
  }
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(packageRoot, "dist/index.js")], cwd, stderr: "pipe",
    env: { PATH: process.env.PATH || "", MCP_TRANSPORT: "stdio", BAMBU_MODEL: "", TEMP_DIR: "" },
  });
  const client = new Client({ name: "npm-install-test", version: "1" });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes("slice_stl") && names.includes("prepare_print_project"));
    assert.ok(!names.includes("print_3mf"), "an installed copy never prints");
  } finally {
    await client.close();
  }
}

test("published tarball installs and starts in local, global, and npm-exec layouts", { timeout: 240_000 }, async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "bambu-npm-install-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const packed = JSON.parse(npm(["pack", "--ignore-scripts", "--json", "--pack-destination", fixture], ROOT));
  for (const file of packed[0].files) {
    assert.doesNotMatch(file.path, /studio-control|launch-bambu|call-bambu|cgevent|LOCAL-X2D|local-x2d/, "machine-local adapters must not ship");
    assert.doesNotMatch(file.path, /^(?:native|patches|scripts)\/|bambu-native|bambu-connect|printers\//, "no printer transport, helper or patch may ship");
  }
  const tarball = path.join(fixture, packed[0].filename);
  const local = path.join(fixture, "local");
  const global = path.join(fixture, "global");
  const execCwd = path.join(fixture, "exec-cwd");
  fs.mkdirSync(execCwd);
  fs.writeFileSync(path.join(execCwd, "user-config.json"), "DO_NOT_CHANGE");

  await t.test("local dependency install", async () => {
    npm(["install", "--prefix", local, "--no-audit", "--no-fund", tarball], fixture);
    await assertInstalledServer(path.join(local, "node_modules/bambu-printer-mcp"), execCwd);
  });

  await t.test("global install with dependencies nested under the package", async () => {
    npm(["install", "--global", "--prefix", global, "--no-audit", "--no-fund", tarball], fixture);
    const globalModules = npm(["root", "--global", "--prefix", global], fixture).trim();
    await assertInstalledServer(path.join(globalModules, "bambu-printer-mcp"), execCwd);
  });

  await t.test("npm exec installs its cached package", async () => {
    const cache = path.join(fixture, "npm-cache");
    const output = npm(["exec", "--yes", "--cache", cache, `--package=${tarball}`, "--", "node", "-e", 'console.log("NPM_EXEC_PATH=" + process.env.PATH)'], execCwd);
    const execPath = output.split(/\r?\n/).find((line) => line.startsWith("NPM_EXEC_PATH="))?.slice("NPM_EXEC_PATH=".length);
    assert.ok(execPath, output);
    const bin = execPath.split(path.delimiter).find((entry) => entry.startsWith(cache) && path.basename(entry) === ".bin");
    assert.ok(bin, "npm exec must use the isolated cache installation");
    await assertInstalledServer(path.join(path.dirname(bin), "bambu-printer-mcp"), execCwd);
  });
  assert.equal(fs.readFileSync(path.join(execCwd, "user-config.json"), "utf8"), "DO_NOT_CHANGE");
});
