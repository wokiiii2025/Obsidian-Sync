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


def github_repo_from_text(text):
    match = re.search(r"https?://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)(?:[/?#\s]|$)", text)
    if not match:
        return None
    return match.group(1), match.group(2).removesuffix(".git")


def http_json(url):
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/vnd.github+json", "User-Agent": "Obsidian-Sync-Hermes"},
    )
    with urllib.request.urlopen(request, timeout=25) as response:
        return json.loads(response.read().decode("utf-8"))


def http_text(url):
    request = urllib.request.Request(url, headers={"User-Agent": "Obsidian-Sync-Hermes"})
    with urllib.request.urlopen(request, timeout=25) as response:
        return response.read().decode("utf-8", errors="replace")


def compact_markdown(markdown, limit=1800):
    lines = []
    for line in markdown.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith(("!", "[![", "<p", "</p>", "<img", "<picture", "<source")):
            continue
        stripped = re.sub(r"<[^>]+>", "", stripped)
        stripped = re.sub(r"!\[[^\]]*]\([^)]*\)", "", stripped)
        stripped = re.sub(r"\[([^\]]+)]\([^)]*\)", r"\1", stripped)
        lines.append(stripped)
        if sum(len(item) for item in lines) >= limit:
            break
    return "\n".join(lines)[:limit].rstrip()


def markdown_title(markdown):
    for line in markdown.splitlines():
        match = re.match(r"^#\s+(.+?)\s*$", line.strip())
        if match:
            return match.group(1).strip()
    return ""


def fetch_readme(owner, repo, branch):
    for filename in ("README.md", "readme.md", "README.rst", "README.MD"):
        url = f"https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{filename}"
        try:
            text = http_text(url)
        except Exception:
            continue
        if text.strip():
            return compact_markdown(text)
    return ""


def fetch_github_context(item):
    text = " ".join(str(item.get(key) or "") for key in ("target_note_path", "merge_content", "source_url"))
    repo_match = github_repo_from_text(text)
    if not repo_match:
        return None
    owner, repo = repo_match
    repo_data = http_json(f"https://api.github.com/repos/{owner}/{repo}")
    branch = repo_data.get("default_branch") or "main"
    readme = fetch_readme(owner, repo, branch)
    return {
        "owner": owner,
        "repo": repo,
        "full_name": repo_data.get("full_name") or f"{owner}/{repo}",
        "url": repo_data.get("html_url") or f"https://github.com/{owner}/{repo}",
        "description": repo_data.get("description") or "",
        "language": repo_data.get("language") or "",
        "stars": repo_data.get("stargazers_count") or 0,
        "forks": repo_data.get("forks_count") or 0,
        "open_issues": repo_data.get("open_issues_count") or 0,
        "license": (repo_data.get("license") or {}).get("name") or "",
        "topics": repo_data.get("topics") or [],
        "homepage": repo_data.get("homepage") or "",
        "default_branch": branch,
        "updated_at": repo_data.get("updated_at") or "",
        "created_at": repo_data.get("created_at") or "",
        "archived": bool(repo_data.get("archived")),
        "readme_title": markdown_title(readme),
        "readme_excerpt": readme,
    }


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


def ask_hermes(item, candidates, github_context):
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
- If GitHub context is provided, use it as factual source material. Do not write "待进一步查看 README", "后续补充", or vague guesses.
- For GitHub project notes, the first Markdown heading must be the README title when available, otherwise use the repository description or a clear Chinese title. Do not use only the repository slug as the H1 unless no better title exists.
- Keep GitHub project notes useful but not verbose: title, URL, description, tech stack, key features, architecture, deployment hints, why it is worth tracking, and source.
- Do not merge unrelated projects into an existing note.
- Never include secrets.

Queue item:
{json.dumps(item, ensure_ascii=False)}

Candidate notes:
{json.dumps(candidates, ensure_ascii=False)}

GitHub context:
{json.dumps(github_context, ensure_ascii=False)}
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
        result, error = api_write("POST", "/api/v1/hermes/tools/notes/update", {"path": path, "content": content})
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
    github_context = fetch_github_context(item)
    decision = ask_hermes(item, search.get("notes", []), github_context)
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
