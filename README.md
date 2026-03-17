# openapi-mcp-server

Convert any standard **OpenAPI 3.x / Swagger 2.0** JSON endpoint into an **MCP (Model Context Protocol) tools server** — automatically.

Every API endpoint becomes an MCP tool that LLMs can call directly.

## Quick Start

### Option 1: npx (No Python needed on your machine)

```bash
npx swagger-to-mcp <swagger_json_url>
npx swagger-to-mcp http://localhost:5244/swagger/v1/swagger.json
npx swagger-to-mcp http://localhost:5244/swagger/v1/swagger.json --base-url http://localhost:5244
```

### Option 2: uv run (Direct from GitHub)

```bash
uv run https://raw.githubusercontent.com/JinArO/openapi-mcp-server/master/openapi_to_mcp.py <swagger_json_url>
```

### Example

```bash
# Start your API server, then:
uv run https://raw.githubusercontent.com/JinArO/openapi-mcp-server/master/openapi_to_mcp.py http://localhost:5244/swagger/v1/swagger.json
```

### Override base URL

```bash
uv run https://raw.githubusercontent.com/JinArO/openapi-mcp-server/master/openapi_to_mcp.py http://localhost:5244/swagger/v1/swagger.json --base-url http://localhost:5244
```

## MCP Configuration

### VS Code / Copilot (`mcp.json`) — npx

```json
{
  "servers": {
    "my-api": {
      "command": "npx",
      "args": [
        "-y",
        "swagger-to-mcp",
        "http://localhost:5244/swagger/v1/swagger.json",
        "--base-url",
        "http://localhost:5244"
      ]
    }
  }
}
```

### VS Code / Copilot (`mcp.json`) — uv

```json
{
  "servers": {
    "my-api": {
      "command": "uv",
      "args": [
        "run",
        "https://raw.githubusercontent.com/JinArO/openapi-mcp-server/master/openapi_to_mcp.py",
        "http://localhost:5244/swagger/v1/swagger.json",
        "--base-url",
        "http://localhost:5244"
      ]
    }
  }
}
```

### AIP Platform (Startup Command)

```
uv run https://raw.githubusercontent.com/JinArO/openapi-mcp-server/master/openapi_to_mcp.py <swagger_json_url>
```

## How It Works

1. Fetches the OpenAPI/Swagger JSON from the given URL
2. Parses all paths, methods, parameters, and request bodies
3. Registers each endpoint as an MCP tool with proper descriptions
4. Runs as an MCP server via stdio transport

## Features

- Supports **OpenAPI 3.x** and **Swagger 2.0**
- Handles **path params**, **query params**, and **JSON request bodies**
- Auto-detects base URL from the spec (or override with `--base-url`)
- Zero config — just point to any Swagger JSON
- Works with `uv run` — no installation needed

## Requirements

- Python >= 3.11
- Dependencies are declared inline (PEP 723), `uv` handles them automatically
