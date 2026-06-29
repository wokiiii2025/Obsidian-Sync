#!/usr/bin/env bash
set -euo pipefail

HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
HERMES_BIN="${HERMES_BIN:-$HERMES_HOME/hermes-agent/venv/bin/hermes}"

if [ -f "$HERMES_HOME/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$HERMES_HOME/.env"
  set +a
fi

python3 - "$HERMES_BIN" <<'PY'
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

HERMES_BIN = sys.argv[1]
API_URL = os.environ.get("OBSIDIAN_SYNC_API_URL", "http://127.0.0.1:46990").rstrip("/")
API_KEY = os.environ.get("HERMES_API_KEY", "")


def api(method, path, query=None, body=None):
    if not API_KEY:
        raise RuntimeError("HERMES_API_KEY is not configured")
    url = f"{API_URL}{path}"
    if query:
        clean_query = {key: value for key, value in query.items() if value not in {None, ""}}
        url = f"{url}?{urllib.parse.urlencode(clean_query)}"
    data = None
    headers = {"X-API-Key": API_KEY, "Accept": "application/json"}
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=90) as response:
        payload = response.read().decode("utf-8")
        return json.loads(payload) if payload else {}


def api_write(method, path, body):
    try:
        return api(method, path, body=body), None
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        return None, (exc.code, detail)


def complete(item_id):
    return api("POST", f"/api/v1/hermes/tools/queue/{item_id}/complete", body={})


def fail(item_id, error):
    return api("POST", f"/api/v1/hermes/tools/queue/{item_id}/fail", body={"error": error[:1000]})


def build_search_query(item):
    parts = [item.get("target_note_path") or "", item.get("source_type") or "", item.get("source_url") or "", item.get("merge_content") or ""]
    text = " ".join(parts)
    github = re.search(r"github\.com/([^/\s]+)/([^/\s#?]+)", text)
    if github:
        return f"Git开源项目 github {github.group(1)} {github.group(2).removesuffix('.git')}"
    return text[:500]


def extract_json(text):
    text = text.strip()
    if text.startswith("{") and text.endswith("}"):
        return json.loads(text)
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    if fenced:
        return json.loads(fenced.group(1))
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        return json.loads(text[start : end + 1])
    raise ValueError("Hermes did not return JSON")


def ask_hermes(item, candidates):
    prompt = f"""\
You are the server-side Hermes automation for an Obsidian vault.

Analyze one queued Telegram/source item and decide how to write it into the vault.
Return only one strict JSON object, no markdown and no extra text.

Allowed JSON shape:
{{
  "operation": "create" | "append" | "update" | "fail",
  "path": "relative/path.md",
  "heading": "short heading for append",
  "content": "markdown content to write or append",
  "error": "only when operation is fail"
}}

Rules:
- Prefer append when a candidate note is clearly related.
- Create a new note when the item is a distinct topic or project.
- For GitHub repository links, use a concise project note under Git开源项目/<repo-name>.md unless a better matching candidate already exists.
- Keep GitHub project notes compact: title, URL, what it is, why it matters, possible use, tags/source.
- Do not merge unrelated projects into an existing note.
- Never include secrets.

Queue item:
{json.dumps(item, ensure_ascii=False)}

Candidate notes:
{json.dumps(candidates, ensure_ascii=False)}
"""
    process = subprocess.run(
        [HERMES_BIN, "--yolo", "-z", prompt],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=240,
    )
    if process.stdout:
        print(process.stdout, end="" if process.stdout.endswith("\n") else "\n")
    if process.returncode not in {0, 134, -6}:
        raise RuntimeError(f"Hermes exited with {process.returncode}")
    return extract_json(process.stdout or "")


def write_note(decision):
    operation = (decision.get("operation") or "").lower()
    path = (decision.get("path") or "").strip()
    content = (decision.get("content") or "").strip()
    heading = (decision.get("heading") or "Hermes").strip() or "Hermes"
    if operation == "fail":
        raise RuntimeError(decision.get("error") or "Hermes returned fail")
    if operation not in {"create", "append", "update"}:
        raise RuntimeError(f"invalid operation: {operation}")
    if not path or not content:
        raise RuntimeError("Hermes returned an empty path or content")

    if operation == "append":
        result, error = api_write("POST", "/api/v1/hermes/tools/notes/append", {"path": path, "content": content, "heading": heading})
        if error and error[0] == 404:
            result, error = api_write("POST", "/api/v1/hermes/tools/notes/create", {"path": path, "content": content})
        if error:
            raise RuntimeError(f"append failed: {error[1]}")
        return result

    result, error = api_write("POST", f"/api/v1/hermes/tools/notes/{operation}", {"path": path, "content": content})
    if error and operation == "create" and error[0] == 409:
        result, error = api_write("POST", "/api/v1/hermes/tools/notes/append", {"path": path, "content": content, "heading": heading})
    if error and operation == "update" and error[0] == 404:
        result, error = api_write("POST", "/api/v1/hermes/tools/notes/create", {"path": path, "content": content})
    if error:
        raise RuntimeError(f"{operation} failed: {error[1]}")
    return result


queue = api("GET", "/api/v1/hermes/tools/queue/next")
item = queue.get("item")
if not item:
    print("no pending item")
    raise SystemExit(0)

item_id = item["id"]
try:
    search = api("GET", "/api/v1/hermes/tools/notes/search", query={"query": build_search_query(item), "limit": "8"})
    decision = ask_hermes(item, search.get("notes", []))
    result = write_note(decision)
    complete(item_id)
    print(f"processed queue item {item_id}: {result.get('operation')} {result.get('path')}")
except Exception as exc:
    try:
        fail(item_id, str(exc))
    finally:
        print(f"failed queue item {item_id}: {exc}")
        raise
PY
