import json
import os
import urllib.error
import urllib.parse
import urllib.request


API_URL = os.environ.get("OBSIDIAN_SYNC_API_URL", "http://127.0.0.1:46990").rstrip("/")
API_KEY = os.environ.get("HERMES_API_KEY", "")


def register(ctx):
    register_tool(ctx, "obsidian_sync_queue_next", "Get the next pending Obsidian Sync Hermes queue item.", {}, lambda params: request_json("GET", "/api/v1/hermes/tools/queue/next"))
    register_tool(
        ctx,
        "obsidian_sync_search_notes",
        "Search Obsidian notes before deciding where to write new content.",
        {
            "query": {"type": "string", "description": "Search text or topic."},
            "limit": {"type": "integer", "description": "Maximum notes to return.", "default": 8},
        },
        lambda params: request_json("GET", "/api/v1/hermes/tools/notes/search", query=params),
    )
    register_tool(
        ctx,
        "obsidian_sync_read_note",
        "Read one Obsidian note by path.",
        {"path": {"type": "string", "description": "Vault-relative note path."}},
        lambda params: request_json("GET", "/api/v1/hermes/tools/notes/read", query=params),
        required=["path"],
    )
    register_tool(
        ctx,
        "obsidian_sync_create_note",
        "Create a new Obsidian markdown note.",
        {"path": {"type": "string"}, "content": {"type": "string"}},
        lambda params: request_json("POST", "/api/v1/hermes/tools/notes/create", body=params),
        required=["path", "content"],
    )
    register_tool(
        ctx,
        "obsidian_sync_update_note",
        "Replace an existing Obsidian markdown note.",
        {"path": {"type": "string"}, "content": {"type": "string"}},
        lambda params: request_json("POST", "/api/v1/hermes/tools/notes/update", body=params),
        required=["path", "content"],
    )
    register_tool(
        ctx,
        "obsidian_sync_append_note",
        "Append content to an existing Obsidian markdown note under a heading.",
        {"path": {"type": "string"}, "content": {"type": "string"}, "heading": {"type": "string", "default": "Hermes"}},
        lambda params: request_json("POST", "/api/v1/hermes/tools/notes/append", body=params),
        required=["path", "content"],
    )
    register_tool(
        ctx,
        "obsidian_sync_complete_queue",
        "Mark a Hermes queue item as completed after writing the note.",
        {"item_id": {"type": "integer"}},
        lambda params: request_json("POST", f"/api/v1/hermes/tools/queue/{int(params.get('item_id', params.get('id')))}/complete", body={}),
        required=["item_id"],
    )
    register_tool(
        ctx,
        "obsidian_sync_fail_queue",
        "Mark a Hermes queue item as failed when processing cannot be completed.",
        {"item_id": {"type": "integer"}, "error": {"type": "string"}},
        lambda params: request_json("POST", f"/api/v1/hermes/tools/queue/{int(params.get('item_id', params.get('id')))}/fail", body={"error": params["error"]}),
        required=["item_id", "error"],
    )


def register_tool(ctx, name, description, properties, handler, required=None):
    schema = {
        "name": name,
        "description": description,
        "parameters": {
            "type": "object",
            "properties": properties,
            "required": required or [],
        },
    }
    ctx.register_tool(name=name, toolset="obsidian_sync", schema=schema, handler=lambda params, **kwargs: json.dumps(handler(params), ensure_ascii=False), description=description)


def request_json(method, path, query=None, body=None):
    if not API_KEY:
        return {"success": False, "error": "HERMES_API_KEY is not configured"}
    url = f"{API_URL}{path}"
    if query:
        clean_query = {key: value for key, value in query.items() if value is not None}
        url = f"{url}?{urllib.parse.urlencode(clean_query)}"
    data = None
    headers = {"X-API-Key": API_KEY, "Accept": "application/json"}
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = response.read().decode("utf-8")
            return {"success": True, "data": json.loads(payload) if payload else None}
    except urllib.error.HTTPError as exc:
        return {"success": False, "status": exc.code, "error": exc.read().decode("utf-8", "replace")}
    except Exception as exc:
        return {"success": False, "error": str(exc)}
