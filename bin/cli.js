#!/usr/bin/env node

/**
 * swagger-to-mcp — Convert any OpenAPI/Swagger JSON to MCP tools server
 * Pure Node.js — no Python required.
 *
 * Usage:
 *   npx swagger-to-mcp <swagger_json_url> [--base-url <url>]
 */

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const https = require("https");
const http = require("http");
const { URL } = require("url");

// ---------------------------------------------------------------------------
// 1. Parse CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let swaggerUrl = null;
let baseUrlOverride = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--base-url" && args[i + 1]) {
    baseUrlOverride = args[i + 1];
    i++;
  } else if (args[i] === "--help" || args[i] === "-h") {
    console.error(`
swagger-to-mcp — Convert any OpenAPI/Swagger JSON to MCP tools

Usage:
  npx swagger-to-mcp <swagger_json_url> [--base-url <url>]

Examples:
  npx swagger-to-mcp http://localhost:5244/swagger/v1/swagger.json
  npx swagger-to-mcp https://demo-api-jinaro.azurewebsites.net/swagger/v1/swagger.json
`);
    process.exit(0);
  } else if (!swaggerUrl) {
    swaggerUrl = args[i];
  }
}

if (!swaggerUrl) {
  console.error("Error: swagger_json_url is required");
  console.error("Usage: npx swagger-to-mcp <swagger_json_url> [--base-url <url>]");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. HTTP helpers
// ---------------------------------------------------------------------------
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === "https:" ? https : http;
    client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location).then(resolve, reject);
      }
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function httpRequest(method, url, queryParams, jsonBody) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);

    if (queryParams) {
      for (const [key, value] of Object.entries(queryParams)) {
        if (value !== undefined && value !== null && value !== "") {
          parsedUrl.searchParams.set(key, value);
        }
      }
    }

    const client = parsedUrl.protocol === "https:" ? https : http;
    const bodyStr = jsonBody ? JSON.stringify(jsonBody) : null;

    const options = {
      method: method,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {},
    };

    if (bodyStr) {
      options.headers["Content-Type"] = "application/json";
      options.headers["Content-Length"] = Buffer.byteLength(bodyStr);
    }

    const req = client.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = data;
        }
        resolve({ status_code: res.statusCode, data: parsed });
      });
      res.on("error", reject);
    });

    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 3. OpenAPI parser
// ---------------------------------------------------------------------------
function resolveRef(spec, ref) {
  const parts = ref.replace(/^#\//, "").split("/");
  let node = spec;
  for (const p of parts) {
    node = node?.[p];
  }
  return node || {};
}

function schemaToDescription(spec, schema, depth = 0) {
  if (!schema) return "any";
  if (schema.$ref) schema = resolveRef(spec, schema.$ref);

  const props = schema.properties;
  if (!props) return schema.type || "object";

  const lines = [];
  for (const [name, prop_] of Object.entries(props)) {
    let prop = prop_;
    if (prop.$ref) prop = resolveRef(spec, prop.$ref);
    let detail = prop.type || "any";
    if (prop.format) detail += `(${prop.format})`;
    if (prop.description) detail += ` - ${prop.description}`;
    lines.push(`${"  ".repeat(depth)}  ${name}: ${detail}`);
  }
  return "object with fields:\n" + lines.join("\n");
}

function makeToolName(method, path) {
  let clean = path.replace(/^\//, "").replace(/\//g, "_").replace(/[{}]/g, "");
  clean = clean.replace(/^api_/, "");
  return `${method}_${clean}`.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
}

function parseOperations(spec) {
  const ops = [];
  const paths = spec.paths || {};

  for (const [path, pathItem] of Object.entries(paths)) {
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      if (!pathItem[method]) continue;
      const operation = pathItem[method];

      let toolName = operation.operationId || makeToolName(method, path);
      toolName = toolName.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();

      const summary = operation.summary || "";
      const description = operation.description || "";
      const tags = operation.tags || [];
      const tagStr = tags.length > 0 ? `[${tags.join(", ")}] ` : "";
      const fullDesc = `${tagStr}${summary || description || `${method.toUpperCase()} ${path}`}`;

      const params = [];
      for (let param of operation.parameters || []) {
        if (param.$ref) param = resolveRef(spec, param.$ref);
        params.push({
          name: param.name,
          in: param.in || "query",
          required: param.required || false,
          type: param.schema?.type || "string",
          description: param.description || "",
        });
      }

      let bodySchema = null;
      let bodyDesc = "";
      const requestBody = operation.requestBody;
      if (requestBody) {
        const jsonContent = requestBody.content?.["application/json"];
        if (jsonContent?.schema) {
          bodySchema = jsonContent.schema;
          bodyDesc = schemaToDescription(spec, bodySchema);
        }
      }

      ops.push({ toolName, method: method.toUpperCase(), path, description: fullDesc, params, bodySchema, bodyDescription: bodyDesc });
    }
  }
  return ops;
}

// ---------------------------------------------------------------------------
// 4. Build & run MCP server
// ---------------------------------------------------------------------------
function registerTool(server, spec, baseUrl, op) {
  const { toolName, method, path: pathTemplate, description, params, bodySchema, bodyDescription } = op;

  const descParts = [`${method} ${pathTemplate}`, description];
  if (bodyDescription) descParts.push(`Request body: ${bodyDescription}`);
  const fullDescription = descParts.join("\n");

  const pathParams = params.filter((p) => p.in === "path");
  const queryParams = params.filter((p) => p.in === "query");
  const hasBody = bodySchema !== null;

  const shape = {};
  for (const p of [...pathParams, ...queryParams]) {
    shape[p.name] = z.string().optional().describe(p.description || `${p.in} parameter: ${p.name}`);
  }
  if (hasBody) {
    shape["body"] = z.string().optional().describe("JSON request body");
  }

  server.tool(toolName, fullDescription, shape, async (paramsObj) => {
    try {
      let urlPath = pathTemplate;
      for (const p of pathParams) {
        const val = paramsObj[p.name] || "";
        urlPath = urlPath.replace(`{${p.name}}`, encodeURIComponent(val));
      }

      const url = `${baseUrl}${urlPath}`;

      const qp = {};
      for (const p of queryParams) {
        if (paramsObj[p.name] !== undefined && paramsObj[p.name] !== "") {
          qp[p.name] = paramsObj[p.name];
        }
      }

      let jsonBody = null;
      if (hasBody && paramsObj.body) {
        try { jsonBody = JSON.parse(paramsObj.body); } catch { jsonBody = paramsObj.body; }
      }

      const result = await httpRequest(method, url, qp, jsonBody);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  });

  console.error(`  ✅ ${toolName.padEnd(40)} ${method.padEnd(6)} ${pathTemplate}`);
}

async function main() {
  console.error(`📥 Fetching OpenAPI spec from ${swaggerUrl} ...`);

  let specText;
  try {
    specText = await httpGet(swaggerUrl);
  } catch (err) {
    console.error(`❌ Failed to fetch spec: ${err.message}`);
    process.exit(1);
  }

  let spec;
  try {
    spec = JSON.parse(specText);
  } catch {
    console.error("❌ Failed to parse JSON from swagger URL");
    process.exit(1);
  }

  const info = spec.info || {};
  const title = info.title || "OpenAPI MCP Server";
  console.error(`📘 ${title} v${info.version || "?"}`);

  // Determine base URL
  let baseUrl = baseUrlOverride;
  if (!baseUrl) {
    if (spec.servers?.[0]?.url?.startsWith("http")) {
      baseUrl = spec.servers[0].url.replace(/\/$/, "");
    } else if (spec.host) {
      const scheme = (spec.schemes || ["http"])[0];
      baseUrl = `${scheme}://${spec.host}${spec.basePath || ""}`.replace(/\/$/, "");
    } else {
      const u = new URL(swaggerUrl);
      baseUrl = `${u.protocol}//${u.host}`;
    }
  }

  console.error(`📡 Base URL: ${baseUrl}`);
  const operations = parseOperations(spec);
  console.error(`🔧 Registering ${operations.length} tools ...`);

  const server = new McpServer({ name: title, version: info.version || "1.0.0" });
  for (const op of operations) {
    registerTool(server, spec, baseUrl, op);
  }

  console.error(`\n🚀 MCP server ready! (${operations.length} tools)`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(`❌ Fatal error: ${err.message}`);
  process.exit(1);
});
