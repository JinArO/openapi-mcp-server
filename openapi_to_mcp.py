# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "mcp[cli]",
#     "httpx>=0.27.0",
# ]
# ///
"""
OpenAPI/Swagger to MCP Tools Server
====================================
Takes any standard OpenAPI 3.x / Swagger 2.0 JSON URL and dynamically
creates an MCP (Model Context Protocol) server exposing every API
operation as an MCP tool.

Usage:
    uv run openapi_to_mcp.py <swagger_json_url> [--base-url <override_base_url>]

Examples:
    uv run https://raw.githubusercontent.com/JinArO/openapi-mcp-server/master/openapi_to_mcp.py http://localhost:5244/swagger/v1/swagger.json
    uv run openapi_to_mcp.py http://localhost:5244/swagger/v1/swagger.json --base-url http://localhost:5244
"""

import argparse
import json
import re
import sys
from typing import Any
from urllib.parse import urlparse

import httpx
from mcp.server.fastmcp import FastMCP


# ---------------------------------------------------------------------------
# 1. Fetch & parse the OpenAPI spec
# ---------------------------------------------------------------------------

def fetch_openapi_spec(url: str) -> dict:
    """Fetch OpenAPI/Swagger JSON from the given URL."""
    resp = httpx.get(url, timeout=30, follow_redirects=True)
    resp.raise_for_status()
    return resp.json()


def guess_base_url(spec: dict, swagger_url: str) -> str:
    """Derive the API base URL from the spec or swagger URL."""
    # OpenAPI 3.x: servers[0].url
    servers = spec.get("servers")
    if servers and isinstance(servers, list) and servers[0].get("url"):
        server_url = servers[0]["url"]
        if server_url.startswith("http"):
            return server_url.rstrip("/")

    # Swagger 2.0: host + basePath
    host = spec.get("host")
    if host:
        scheme = (spec.get("schemes") or ["http"])[0]
        base_path = spec.get("basePath", "")
        return f"{scheme}://{host}{base_path}".rstrip("/")

    # Fallback: derive from the swagger URL itself
    parsed = urlparse(swagger_url)
    return f"{parsed.scheme}://{parsed.netloc}"


# ---------------------------------------------------------------------------
# 2. Parse operations from spec
# ---------------------------------------------------------------------------

def resolve_ref(spec: dict, ref: str) -> dict:
    """Resolve a $ref pointer like '#/components/schemas/Foo'."""
    parts = ref.lstrip("#/").split("/")
    node = spec
    for p in parts:
        node = node.get(p, {})
    return node


def schema_to_description(spec: dict, schema: dict, depth: int = 0) -> str:
    """Convert a JSON schema object into a human-readable description."""
    if "$ref" in schema:
        schema = resolve_ref(spec, schema["$ref"])

    schema_type = schema.get("type", "object")
    props = schema.get("properties", {})
    if not props:
        return schema_type

    lines = []
    for name, prop in props.items():
        if "$ref" in prop:
            prop = resolve_ref(spec, prop["$ref"])
        ptype = prop.get("type", "any")
        fmt = prop.get("format", "")
        desc = prop.get("description", "")
        detail = f"{ptype}"
        if fmt:
            detail += f"({fmt})"
        if desc:
            detail += f" - {desc}"
        lines.append(f"  {'  ' * depth}{name}: {detail}")
    return "object with fields:\n" + "\n".join(lines)


def make_tool_name(method: str, path: str) -> str:
    """Generate a clean tool name from HTTP method + path."""
    # /api/Calculator/add -> Calculator_add
    clean = path.strip("/").replace("/", "_").replace("{", "").replace("}", "")
    # Remove common prefixes
    clean = re.sub(r"^api_", "", clean)
    name = f"{method}_{clean}"
    # Ensure valid Python identifier
    name = re.sub(r"[^a-zA-Z0-9_]", "_", name)
    return name.lower()


def parse_operations(spec: dict) -> list[dict]:
    """Extract all operations from the OpenAPI spec."""
    ops = []
    paths = spec.get("paths", {})

    for path, path_item in paths.items():
        for method in ("get", "post", "put", "patch", "delete"):
            if method not in path_item:
                continue
            operation = path_item[method]

            tool_name = operation.get("operationId") or make_tool_name(method, path)
            # Clean operationId to be a valid Python identifier
            tool_name = re.sub(r"[^a-zA-Z0-9_]", "_", tool_name).lower()

            summary = operation.get("summary", "")
            description = operation.get("description", "")
            tags = operation.get("tags", [])
            tag_str = f"[{', '.join(tags)}] " if tags else ""
            full_desc = f"{tag_str}{summary or description or f'{method.upper()} {path}'}"

            # Collect parameters (path + query + header)
            params = []
            for param in operation.get("parameters", []):
                if "$ref" in param:
                    param = resolve_ref(spec, param["$ref"])
                params.append({
                    "name": param["name"],
                    "in": param.get("in", "query"),
                    "required": param.get("required", False),
                    "type": param.get("schema", {}).get("type", "string"),
                    "description": param.get("description", ""),
                })

            # Request body (for POST/PUT/PATCH)
            body_schema = None
            body_desc = ""
            request_body = operation.get("requestBody", {})
            if request_body:
                content = request_body.get("content", {})
                json_content = content.get("application/json", {})
                if json_content.get("schema"):
                    body_schema = json_content["schema"]
                    body_desc = schema_to_description(spec, body_schema)

            ops.append({
                "tool_name": tool_name,
                "method": method.upper(),
                "path": path,
                "description": full_desc,
                "params": params,
                "body_schema": body_schema,
                "body_description": body_desc,
            })

    return ops


# ---------------------------------------------------------------------------
# 3. Build MCP server dynamically
# ---------------------------------------------------------------------------

def build_mcp_server(spec: dict, base_url: str) -> FastMCP:
    """Create a FastMCP server with one tool per OpenAPI operation."""
    title = spec.get("info", {}).get("title", "OpenAPI MCP Server")
    mcp = FastMCP(title)
    operations = parse_operations(spec)

    print(f"📡 Base URL: {base_url}", file=sys.stderr)
    print(f"🔧 Registering {len(operations)} tools ...", file=sys.stderr)

    for op in operations:
        _register_tool(mcp, spec, base_url, op)

    return mcp


def _register_tool(mcp: FastMCP, spec: dict, base_url: str, op: dict):
    """Register a single tool on the MCP server."""
    tool_name = op["tool_name"]
    method = op["method"]
    path_template = op["path"]
    description = op["description"]
    params = op["params"]
    body_schema = op["body_schema"]
    body_desc = op["body_description"]

    # Build the complete tool description
    desc_parts = [f"{method} {path_template}", description]
    if body_desc:
        desc_parts.append(f"Request body: {body_desc}")
    full_description = "\n".join(desc_parts)

    # Determine function parameters
    has_body = body_schema is not None
    path_params = [p for p in params if p["in"] == "path"]
    query_params = [p for p in params if p["in"] == "query"]

    # Build the parameter annotation string for the docstring
    param_docs = []
    for p in path_params + query_params:
        req = " (required)" if p["required"] else " (optional)"
        param_docs.append(f"  {p['name']}: {p['type']}{req} {p['description']}")
    if has_body:
        param_docs.append(f"  body: JSON object to send as request body")

    async def _call_api(**kwargs) -> str:
        """Generic API caller - closure captures op details."""
        # Build URL with path params
        url_path = path_template
        for p in path_params:
            val = kwargs.get(p["name"], "")
            url_path = url_path.replace("{" + p["name"] + "}", str(val))

        url = f"{base_url}{url_path}"

        # Query params
        qp = {}
        for p in query_params:
            if p["name"] in kwargs and kwargs[p["name"]] is not None:
                qp[p["name"]] = kwargs[p["name"]]

        # Body
        body = kwargs.get("body") if has_body else None
        if isinstance(body, str):
            try:
                body = json.loads(body)
            except json.JSONDecodeError:
                pass

        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.request(
                method=method,
                url=url,
                params=qp if qp else None,
                json=body if body else None,
            )
            # Return status + body
            try:
                result = response.json()
                return json.dumps({
                    "status_code": response.status_code,
                    "data": result
                }, ensure_ascii=False, indent=2)
            except Exception:
                return json.dumps({
                    "status_code": response.status_code,
                    "data": response.text
                }, ensure_ascii=False)

    # Build the parameter dict for the tool function dynamically
    # We need to create a proper function signature for MCP
    func_params = []
    for p in path_params:
        func_params.append(p["name"])
    for p in query_params:
        func_params.append(p["name"])
    if has_body:
        func_params.append("body")

    # Create wrapper with proper signature using exec
    if not func_params:
        async def tool_func() -> str:
            return await _call_api()
    else:
        # Build function dynamically to get proper parameter names
        param_str = ", ".join(
            f'{p}: str = ""' for p in func_params
        )
        kwargs_str = ", ".join(f'{p}={p}' for p in func_params)

        func_code = f"""
async def _tool_{tool_name}({param_str}) -> str:
    return await _call_api({kwargs_str})
"""
        local_ns: dict[str, Any] = {"_call_api": _call_api}
        exec(func_code, local_ns)  # noqa: S102
        tool_func = local_ns[f"_tool_{tool_name}"]

    tool_func.__name__ = tool_name
    tool_func.__doc__ = full_description

    mcp.tool(name=tool_name, description=full_description)(tool_func)

    print(f"  ✅ {tool_name:40s} {method:6s} {path_template}", file=sys.stderr)


# ---------------------------------------------------------------------------
# 4. Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Convert OpenAPI/Swagger spec to MCP tools server"
    )
    parser.add_argument("swagger_url", help="URL to swagger.json / openapi.json")
    parser.add_argument("--base-url", default=None, help="Override API base URL")
    args = parser.parse_args()

    # Fetch spec
    print(f"📥 Fetching OpenAPI spec from {args.swagger_url} ...", file=sys.stderr)
    spec = fetch_openapi_spec(args.swagger_url)

    info = spec.get("info", {})
    print(f"📘 {info.get('title', 'Unknown')} v{info.get('version', '?')}", file=sys.stderr)

    # Determine base URL
    base_url = args.base_url or guess_base_url(spec, args.swagger_url)

    # Build & run MCP server
    server = build_mcp_server(spec, base_url)
    print(f"\n🚀 MCP server ready!", file=sys.stderr)
    server.run()


if __name__ == "__main__":
    main()
