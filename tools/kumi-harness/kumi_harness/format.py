"""Human-readable renderings of the backend's JSON payloads."""

from __future__ import annotations

import json
from typing import Any

__all__ = [
    "page_line",
    "plain_text",
    "render_pages",
    "render_nodes",
    "render_rows",
    "render_json",
]


def plain_text(rich_text: Any) -> str:
    """Flatten a Kumi RichText array to plain text."""
    if not isinstance(rich_text, list):
        return ""
    parts: list[str] = []
    for span in rich_text:
        if not isinstance(span, dict):
            continue
        if span.get("type") == "text":
            parts.append(str(span.get("text", "")))
        elif span.get("type") == "equation":
            parts.append(str(span.get("expression", "")))
    return "".join(parts)


def page_line(page: dict[str, Any]) -> str:
    """One-line summary of a page: ``icon Title  [id]``."""
    icon = page.get("icon")
    title = page.get("title") or "Untitled"
    return f"{icon + ' ' if icon else ''}{title}  [{page.get('id')}]"


def render_pages(pages: Any, empty: str = "(empty)") -> str:
    """Render a list of page records."""
    if not pages:
        return empty
    return "\n".join(page_line(p) for p in pages)


def render_nodes(nodes: Any, empty: str = "(empty)") -> str:
    """Render ``{page, hasChildren}`` tree nodes."""
    if not nodes:
        return empty
    lines = []
    for node in nodes:
        marker = "> " if node.get("hasChildren") else "  "
        lines.append(f"{marker}{page_line(node.get('page', {}))}")
    return "\n".join(lines)


def render_rows(result: Any) -> str:
    """Render a ``db query`` result: one line per row, plus the total."""
    rows = (result or {}).get("rows", [])
    total = (result or {}).get("total", len(rows))
    if not rows:
        return "(no rows)"
    lines = [page_line(row.get("page", {})) for row in rows]
    lines.append(f"-- {len(rows)} of {total} row(s)")
    return "\n".join(lines)


def render_json(data: Any) -> str:
    """Pretty-print any payload as JSON (the fallback human rendering)."""
    if data is None:
        return "ok"
    if isinstance(data, str):
        return data
    return json.dumps(data, indent=2, ensure_ascii=False)
