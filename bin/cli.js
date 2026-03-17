#!/usr/bin/env node

const { spawn, execFileSync } = require("child_process");
const path = require("path");

const scriptPath = path.join(__dirname, "..", "openapi_to_mcp.py");
const args = process.argv.slice(2);

if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.error(`
swagger-to-mcp — Convert any OpenAPI/Swagger JSON to MCP tools

Usage:
  npx swagger-to-mcp <swagger_json_url> [--base-url <url>]

Examples:
  npx swagger-to-mcp http://localhost:5244/swagger/v1/swagger.json
  npx swagger-to-mcp http://localhost:5244/swagger/v1/swagger.json --base-url http://localhost:5244
`);
  process.exit(args.length === 0 ? 1 : 0);
}

// Try uv first (fastest, handles deps automatically), fallback to python/python3
function findRunner() {
  const runners = [
    { cmd: "uv", args: ["run", scriptPath, ...args] },
    { cmd: "python3", args: [scriptPath, ...args] },
    { cmd: "python", args: [scriptPath, ...args] },
  ];

  for (const runner of runners) {
    try {
      execFileSync(runner.cmd, ["--version"], { stdio: "ignore" });
      return runner;
    } catch {
      // not found, try next
    }
  }
  return null;
}

const runner = findRunner();

if (!runner) {
  console.error(
    "Error: Could not find uv, python3, or python in PATH.\n" +
    "Install uv (recommended): https://docs.astral.sh/uv/\n" +
    "Or install Python >= 3.11: https://www.python.org/"
  );
  process.exit(1);
}

const child = spawn(runner.cmd, runner.args, {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (err) => {
  console.error(`Failed to start: ${err.message}`);
  process.exit(1);
});
