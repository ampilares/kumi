"""``cli-anything-kumi`` — a CLI-Anything harness over the real Kumi CLI.

Every command is a 1:1 mirror of a Kumi backend subcommand. The harness adds
nothing to the semantics: it forwards arguments, unwraps the ``{ok, data}``
envelope, and renders either a human summary (default) or the raw JSON data
(``--json``). The same Click group backs both standalone invocation and the
stateful REPL, so the two can never drift.
"""

from __future__ import annotations

import json as jsonlib
import shlex
import sys
from dataclasses import dataclass
from typing import Any, Callable, Optional, Sequence

import click

from . import backend
from .backend import BackendUnavailable, KumiBackendError
from .format import (
    page_line,
    plain_text,
    render_json,
    render_nodes,
    render_pages,
    render_rows,
)

__all__ = ["cli", "main"]

Human = Callable[[Any], str]


@dataclass
class Ctx:
    """Harness state shared by every command (and mutated by the REPL)."""

    workspace: str
    json: bool


pass_ctx = click.make_pass_decorator(Ctx)


def call(ctx: Ctx, args: Sequence[str], *, stdin: Optional[str] = None) -> Any:
    """Run a backend subcommand against the current workspace."""
    return backend.run(args, workspace=ctx.workspace, stdin=stdin)


def emit(ctx: Ctx, data: Any, human: Optional[Human] = None) -> None:
    """Print the payload: raw JSON in --json mode, else a human summary."""
    if ctx.json:
        click.echo(jsonlib.dumps(data, indent=2, ensure_ascii=False))
    elif human is not None:
        click.echo(human(data))
    else:
        click.echo(render_json(data))


def opt(flag: str, value: Optional[str]) -> list[str]:
    """Return ``[flag, value]`` when the value is set, else ``[]``."""
    return [] if value is None else [flag, str(value)]


# ---------------------------------------------------------------------------
# root group
# ---------------------------------------------------------------------------


@click.group(
    name="cli-anything-kumi",
    context_settings={"help_option_names": ["-h", "--help"]},
)
@click.option(
    "-w",
    "--workspace",
    envvar="KUMI_WORKSPACE",
    default=None,
    help="Kumi workspace folder (default: $KUMI_WORKSPACE or ~/Kumi).",
)
@click.option(
    "--json/--plain",
    "json_out",
    default=False,
    help="Emit the backend's raw JSON data instead of a human summary.",
)
@click.version_option(package_name="cli-anything-kumi", prog_name="cli-anything-kumi")
@click.pass_context
def cli(click_ctx: click.Context, workspace: Optional[str], json_out: bool) -> None:
    """Agent-controllable interface to a local Kumi workspace."""
    if isinstance(click_ctx.obj, Ctx):
        # REPL reuse: keep the live state object, apply per-call overrides.
        if workspace:
            click_ctx.obj.workspace = workspace
        click_ctx.obj.json = json_out or click_ctx.obj.json
    else:
        click_ctx.obj = Ctx(
            workspace=workspace or backend.default_workspace(), json=json_out
        )


# ---------------------------------------------------------------------------
# doctor
# ---------------------------------------------------------------------------


@cli.command()
@pass_ctx
def doctor(ctx: Ctx) -> None:
    """Check the backend path, node version, workspace path, and DB reachability."""
    report: dict[str, Any] = {"ok": False}
    try:
        info = backend.backend_info(ctx.workspace)
    except BackendUnavailable as exc:
        report["error"] = str(exc)
        emit(ctx, report, lambda d: f"backend unavailable: {d['error']}")
        raise SystemExit(1)
    report.update(info)
    try:
        ws = call(ctx, ["workspace", "info"])
        report["workspaceReachable"] = True
        report["workspaceName"] = ws.get("name")
        report["workspaceResolvedPath"] = ws.get("path")
        report["ok"] = True
    except KumiBackendError as exc:
        report["workspaceReachable"] = False
        report["error"] = f"{exc.code}: {exc.message}"

    def human(d: dict[str, Any]) -> str:
        lines = [
            f"backend      {d['entry']}",
            f"node         {d['nodeVersion']} ({d['node']})",
            f"repo         {d['repo'] or '(unknown)'}",
            f"workspace    {d['workspace']}",
        ]
        if d.get("workspaceReachable"):
            lines.append(f"database     reachable — {d['workspaceName']}")
            lines.append("status       OK")
        else:
            lines.append(f"database     UNREACHABLE — {d.get('error')}")
            lines.append("status       FAILED")
        return "\n".join(lines)

    emit(ctx, report, human)
    if not report["ok"]:
        raise SystemExit(1)


# ---------------------------------------------------------------------------
# workspace
# ---------------------------------------------------------------------------


@cli.group()
def workspace() -> None:
    """Workspace info and settings."""


@workspace.command("info")
@pass_ctx
def workspace_info(ctx: Ctx) -> None:
    """Show the workspace path, name, and icon."""
    emit(
        ctx,
        call(ctx, ["workspace", "info"]),
        lambda d: f"{(d.get('icon') or '').strip()} {d['name']}".strip() + f"\n{d['path']}",
    )


@workspace.command("rename")
@click.argument("name")
@pass_ctx
def workspace_rename(ctx: Ctx, name: str) -> None:
    """Rename the workspace."""
    emit(ctx, call(ctx, ["workspace", "rename", name]), lambda d: f"renamed to {d['name']}")


# ---------------------------------------------------------------------------
# pages
# ---------------------------------------------------------------------------


@cli.group()
def page() -> None:
    """Create, inspect, and organize pages."""


@page.command("create")
@click.option("-t", "--title", default="", help="Page title.")
@click.option("-p", "--parent", default=None, help="Parent page id (omit for a root page).")
@click.option("-i", "--icon", default=None, help="Page icon (emoji).")
@pass_ctx
def page_create(ctx: Ctx, title: str, parent: Optional[str], icon: Optional[str]) -> None:
    """Create a page, optionally under a parent."""
    args = ["page", "create", "-t", title, *opt("-p", parent), *opt("-i", icon)]
    emit(ctx, call(ctx, args), page_line)


@page.command("show")
@click.argument("page_id")
@pass_ctx
def page_show(ctx: Ctx, page_id: str) -> None:
    """Show a page's metadata."""
    emit(ctx, call(ctx, ["page", "show", page_id]), page_line)


@page.command("list")
@click.argument("parent_id", required=False)
@pass_ctx
def page_list(ctx: Ctx, parent_id: Optional[str]) -> None:
    """List root pages, or the children of a page."""
    args = ["page", "list"] + ([parent_id] if parent_id else [])
    emit(ctx, call(ctx, args), render_nodes)


@page.command("rename")
@click.argument("page_id")
@click.argument("title")
@pass_ctx
def page_rename(ctx: Ctx, page_id: str, title: str) -> None:
    """Set a page's title."""
    emit(ctx, call(ctx, ["page", "rename", page_id, title]), page_line)


@page.command("move")
@click.argument("page_id")
@click.option("-p", "--parent", default=None, help="New parent page id (omit for root).")
@click.option("--after", default=None, help="Position the page after this sibling.")
@pass_ctx
def page_move(ctx: Ctx, page_id: str, parent: Optional[str], after: Optional[str]) -> None:
    """Move a page to a new parent and/or position."""
    args = ["page", "move", page_id, *opt("-p", parent), *opt("--after", after)]
    emit(ctx, call(ctx, args), page_line)


@page.command("duplicate")
@click.argument("page_id")
@pass_ctx
def page_duplicate(ctx: Ctx, page_id: str) -> None:
    """Deep-copy a page and its subtree."""
    emit(ctx, call(ctx, ["page", "duplicate", page_id]), page_line)


@page.command("trash")
@click.argument("page_id")
@pass_ctx
def page_trash(ctx: Ctx, page_id: str) -> None:
    """Move a page (and its subtree) to the trash."""
    emit(ctx, call(ctx, ["page", "trash", page_id]), lambda d: f"trashed {d['trashed']}")


@page.command("restore")
@click.argument("page_id")
@pass_ctx
def page_restore(ctx: Ctx, page_id: str) -> None:
    """Restore a page from the trash."""
    emit(ctx, call(ctx, ["page", "restore", page_id]), lambda d: f"restored {d['restored']}")


@page.command("delete")
@click.argument("page_id")
@click.option("--force", is_flag=True, default=False, help="Confirm permanent deletion.")
@pass_ctx
def page_delete(ctx: Ctx, page_id: str, force: bool) -> None:
    """Permanently delete a trashed page (requires --force)."""
    args = ["page", "delete", page_id] + (["--force"] if force else [])
    emit(ctx, call(ctx, args), lambda d: f"deleted {d['deleted']}")


@page.command("breadcrumb")
@click.argument("page_id")
@pass_ctx
def page_breadcrumb(ctx: Ctx, page_id: str) -> None:
    """Show the ancestry from root to a page."""
    emit(
        ctx,
        call(ctx, ["page", "breadcrumb", page_id]),
        lambda d: " / ".join((c.get("title") or "Untitled") for c in d) or "(root)",
    )


@cli.command("trash")
@pass_ctx
def trash_list(ctx: Ctx) -> None:
    """List trashed pages."""
    emit(ctx, call(ctx, ["trash"]), lambda d: render_pages(d, "(trash is empty)"))


# ---------------------------------------------------------------------------
# blocks
# ---------------------------------------------------------------------------


@cli.group()
def block() -> None:
    """Read and edit page content."""


@block.command("list")
@click.argument("page_id")
@pass_ctx
def block_list(ctx: Ctx, page_id: str) -> None:
    """List a page's blocks in document order."""

    def human(blocks: Any) -> str:
        if not blocks:
            return "(no blocks)"
        return "\n".join(
            f"{b.get('type', ''):<20} "
            f"{plain_text((b.get('payload') or {}).get('richText'))[:80]}  [{b.get('id')}]"
            for b in blocks
        )

    emit(ctx, call(ctx, ["block", "list", page_id]), human)


@block.command("show")
@click.argument("block_id")
@pass_ctx
def block_show(ctx: Ctx, block_id: str) -> None:
    """Show one block with its full payload."""
    emit(ctx, call(ctx, ["block", "show", block_id]))


@block.command("append")
@click.argument("page_id")
@click.argument("text")
@click.option("-t", "--type", "block_type", default="paragraph", help="Block type.")
@click.option("--parent", default=None, help="Parent block id (for nesting).")
@pass_ctx
def block_append(
    ctx: Ctx, page_id: str, text: str, block_type: str, parent: Optional[str]
) -> None:
    """Append a block of text to a page."""
    args = ["block", "append", page_id, text, "-t", block_type, *opt("--parent", parent)]
    emit(ctx, call(ctx, args), lambda d: f"appended block {d['blockId']}")


@block.command("edit")
@click.argument("block_id")
@click.argument("text")
@pass_ctx
def block_edit(ctx: Ctx, block_id: str, text: str) -> None:
    """Replace a block's text."""
    emit(ctx, call(ctx, ["block", "edit", block_id, text]), lambda d: f"edited {d['blockId']}")


@block.command("delete")
@click.argument("block_id")
@pass_ctx
def block_delete(ctx: Ctx, block_id: str) -> None:
    """Delete a block."""
    emit(ctx, call(ctx, ["block", "delete", block_id]), lambda d: f"deleted {d['deleted']}")


@block.command("ops")
@click.option(
    "--file",
    "ops_file",
    type=click.Path(exists=True, dir_okay=False),
    default=None,
    help="Read the BlockOp[] JSON from a file instead of stdin.",
)
@pass_ctx
def block_ops(ctx: Ctx, ops_file: Optional[str]) -> None:
    """Apply a raw BlockOp[] batch read from stdin (or --file)."""
    if ops_file:
        with open(ops_file, "r", encoding="utf-8") as handle:
            payload = handle.read()
    else:
        payload = sys.stdin.read()
    result = call(ctx, ["block", "ops"], stdin=payload)
    emit(
        ctx,
        result,
        lambda d: f"{len(d.get('applied', []))} applied, {len(d.get('rejected', []))} rejected",
    )


# ---------------------------------------------------------------------------
# assets
# ---------------------------------------------------------------------------


@cli.group()
def asset() -> None:
    """Workspace asset store."""


@asset.command("import")
@click.argument("file", type=click.Path(exists=True, dir_okay=False))
@click.option("--name", default=None, help="Override the filename used for extension/MIME.")
@pass_ctx
def asset_import(ctx: Ctx, file: str, name: Optional[str]) -> None:
    """Copy a file into the asset store (deduplicated by content)."""
    emit(ctx, call(ctx, ["asset", "import", file, *opt("--name", name)]))


@asset.command("show")
@click.argument("asset_id")
@pass_ctx
def asset_show(ctx: Ctx, asset_id: str) -> None:
    """Show an asset's metadata."""
    emit(ctx, call(ctx, ["asset", "show", asset_id]))


@asset.command("path")
@click.argument("asset_id")
@pass_ctx
def asset_path(ctx: Ctx, asset_id: str) -> None:
    """Print the absolute path of an asset's file."""
    emit(ctx, call(ctx, ["asset", "path", asset_id]), lambda d: d["path"])


# ---------------------------------------------------------------------------
# backlinks / search
# ---------------------------------------------------------------------------


@cli.command("backlinks")
@click.argument("page_id")
@pass_ctx
def backlinks(ctx: Ctx, page_id: str) -> None:
    """List pages whose content links to or mentions this page."""

    def human(links: Any) -> str:
        if not links:
            return "(no backlinks)"
        return "\n".join(
            f"{link.get('sourcePageTitle') or 'Untitled'}  [{link.get('sourcePageId')}] "
            f"block {link.get('sourceBlockId')}"
            for link in links
        )

    emit(ctx, call(ctx, ["backlinks", page_id]), human)


@cli.command("search")
@click.argument("query")
@click.option("--title-only", is_flag=True, default=False, help="Match page titles only.")
@click.option("-n", "--limit", type=int, default=20, help="Maximum results.")
@pass_ctx
def search(ctx: Ctx, query: str, title_only: bool, limit: int) -> None:
    """Full-text search across the workspace."""
    args = ["search", query, "-n", str(limit)] + (["--title-only"] if title_only else [])

    def human(results: Any) -> str:
        if not results:
            return "(no results)"
        lines = []
        for r in results:
            crumb = " / ".join(r.get("breadcrumb") or []) or "root"
            snippet = (r.get("snippet") or "").replace("<b>", "").replace("</b>", "")
            lines.append(
                f"{r.get('title') or 'Untitled'}  - {crumb}  [{r.get('pageId')}]\n    {snippet}"
            )
        return "\n".join(lines)

    emit(ctx, call(ctx, args), human)


# ---------------------------------------------------------------------------
# databases
# ---------------------------------------------------------------------------


@cli.group()
def db() -> None:
    """Data sources (databases)."""


@db.command("create")
@click.argument("owner_page_id")
@click.option("-t", "--title", default="", help="Database title.")
@pass_ctx
def db_create(ctx: Ctx, owner_page_id: str, title: str) -> None:
    """Create a database on a page (with a Name property and Table view)."""
    emit(
        ctx,
        call(ctx, ["db", "create", owner_page_id, "-t", title]),
        lambda d: f"{d['dataSource']['title'] or 'Untitled'}  [{d['dataSource']['id']}]\n"
        + "\n".join(f"  prop {p['name']} ({p['type']})  [{p['id']}]" for p in d["properties"]),
    )


@db.command("show")
@click.argument("data_source_id")
@pass_ctx
def db_show(ctx: Ctx, data_source_id: str) -> None:
    """Show a database's schema, properties, and views."""
    emit(ctx, call(ctx, ["db", "show", data_source_id]))


@db.command("list")
@click.argument("owner_page_id", required=False)
@pass_ctx
def db_list(ctx: Ctx, owner_page_id: Optional[str]) -> None:
    """List a page's databases, or every database in the workspace."""
    args = ["db", "list"] + ([owner_page_id] if owner_page_id else [])
    emit(ctx, call(ctx, args))


@db.command("rename")
@click.argument("data_source_id")
@click.argument("title")
@pass_ctx
def db_rename(ctx: Ctx, data_source_id: str, title: str) -> None:
    """Rename a database."""
    emit(ctx, call(ctx, ["db", "rename", data_source_id, title]))


@db.command("delete")
@click.argument("data_source_id")
@click.option("--force", is_flag=True, default=False, help="Confirm deletion.")
@pass_ctx
def db_delete(ctx: Ctx, data_source_id: str, force: bool) -> None:
    """Delete a database's schema and views; its rows go to the trash."""
    args = ["db", "delete", data_source_id] + (["--force"] if force else [])
    emit(ctx, call(ctx, args), lambda d: f"deleted {d['deleted']}")


@db.command("query")
@click.argument("data_source_id")
@click.option("--filter", "filter_json", default=None, help="FilterGroup JSON.")
@click.option("--sort", default=None, help="Comma list of propertyId:asc|desc.")
@click.option("-n", "--limit", type=int, default=100, help="Maximum rows.")
@click.option("--offset", type=int, default=0, help="Rows to skip.")
@pass_ctx
def db_query(
    ctx: Ctx,
    data_source_id: str,
    filter_json: Optional[str],
    sort: Optional[str],
    limit: int,
    offset: int,
) -> None:
    """Query a database's rows with an optional filter and sort."""
    args = [
        "db",
        "query",
        data_source_id,
        "-n",
        str(limit),
        "--offset",
        str(offset),
        *opt("--filter", filter_json),
        *opt("--sort", sort),
    ]
    emit(ctx, call(ctx, args), render_rows)


# ---------------------------------------------------------------------------
# properties
# ---------------------------------------------------------------------------


@cli.group()
def prop() -> None:
    """Database properties (columns)."""


@prop.command("add")
@click.argument("data_source_id")
@click.argument("name")
@click.option("-t", "--type", "prop_type", required=True, help="Property type.")
@click.option("--options", default=None, help="Comma-separated select options.")
@click.option("--target", default=None, help="Relation: target data source id.")
@click.option("--paired-name", default=None, help="Relation: create the reverse relation.")
@click.option("--through", default=None, help="Rollup: relation property on this database.")
@click.option("--of", "of_prop", default=None, help="Rollup: target property to aggregate.")
@click.option(
    "--agg",
    default=None,
    help="Rollup: count|count_values|sum|avg|min|max|show_originals.",
)
@click.option("--config", "config_json", default=None, help="Raw PropertyConfig JSON.")
@pass_ctx
def prop_add(
    ctx: Ctx,
    data_source_id: str,
    name: str,
    prop_type: str,
    options: Optional[str],
    target: Optional[str],
    paired_name: Optional[str],
    through: Optional[str],
    of_prop: Optional[str],
    agg: Optional[str],
    config_json: Optional[str],
) -> None:
    """Add a property (column) to a database."""
    args = [
        "prop",
        "add",
        data_source_id,
        name,
        "-t",
        prop_type,
        *opt("--options", options),
        *opt("--target", target),
        *opt("--paired-name", paired_name),
        *opt("--through", through),
        *opt("--of", of_prop),
        *opt("--agg", agg),
        *opt("--config", config_json),
    ]
    emit(ctx, call(ctx, args), lambda d: f"{d['name']} ({d['type']})  [{d['id']}]")


@prop.command("update")
@click.argument("property_id")
@click.option("--name", default=None, help="New property name.")
@click.option("-t", "--type", "prop_type", default=None, help="New property type.")
@click.option("--config", "config_json", default=None, help="Raw PropertyConfig JSON.")
@pass_ctx
def prop_update(
    ctx: Ctx,
    property_id: str,
    name: Optional[str],
    prop_type: Optional[str],
    config_json: Optional[str],
) -> None:
    """Update a property's name, type, or config."""
    args = [
        "prop",
        "update",
        property_id,
        *opt("--name", name),
        *opt("-t", prop_type),
        *opt("--config", config_json),
    ]
    emit(ctx, call(ctx, args), lambda d: f"{d['name']} ({d['type']})  [{d['id']}]")


@prop.command("rm")
@click.argument("property_id")
@pass_ctx
def prop_rm(ctx: Ctx, property_id: str) -> None:
    """Remove a property from a database."""
    emit(ctx, call(ctx, ["prop", "rm", property_id]), lambda d: f"removed {d['removed']}")


# ---------------------------------------------------------------------------
# rows
# ---------------------------------------------------------------------------


@cli.group()
def row() -> None:
    """Database rows (rows are pages)."""


@row.command("add")
@click.argument("data_source_id")
@click.option("--values", "values_json", default=None, help="Record<propertyId, PropertyValue> JSON.")
@pass_ctx
def row_add(ctx: Ctx, data_source_id: str, values_json: Optional[str]) -> None:
    """Add a row to a database."""
    args = ["row", "add", data_source_id, *opt("--values", values_json)]
    emit(ctx, call(ctx, args), lambda d: page_line(d["page"]))


@row.command("show")
@click.argument("page_id")
@pass_ctx
def row_show(ctx: Ctx, page_id: str) -> None:
    """Show a row: its page plus all property values."""
    emit(ctx, call(ctx, ["row", "show", page_id]))


@row.command("set")
@click.argument("page_id")
@click.argument("values_json")
@pass_ctx
def row_set(ctx: Ctx, page_id: str, values_json: str) -> None:
    """Write property values on a row (null clears a value)."""
    emit(ctx, call(ctx, ["row", "set", page_id, values_json]), lambda d: page_line(d["page"]))


@row.command("link")
@click.argument("row_page_id")
@click.argument("property_id")
@click.option("--add", "add_id", default=None, help="Related row page id to append.")
@click.option("--remove", "remove_id", default=None, help="Related row page id to remove.")
@pass_ctx
def row_link(
    ctx: Ctx, row_page_id: str, property_id: str, add_id: Optional[str], remove_id: Optional[str]
) -> None:
    """Add or remove entries of a relation property's value."""
    args = [
        "row",
        "link",
        row_page_id,
        property_id,
        *opt("--add", add_id),
        *opt("--remove", remove_id),
    ]
    emit(ctx, call(ctx, args), lambda d: page_line(d["page"]))


# ---------------------------------------------------------------------------
# views
# ---------------------------------------------------------------------------


@cli.group()
def view() -> None:
    """Saved database views."""


@view.command("add")
@click.argument("data_source_id")
@click.argument("name")
@click.option("-t", "--type", "view_type", default="table", help="View type.")
@pass_ctx
def view_add(ctx: Ctx, data_source_id: str, name: str, view_type: str) -> None:
    """Add a saved view to a database."""
    emit(
        ctx,
        call(ctx, ["view", "add", data_source_id, name, "-t", view_type]),
        lambda d: f"{d['name']} ({d['type']})  [{d['id']}]",
    )


@view.command("update")
@click.argument("view_id")
@click.option("--name", default=None, help="New view name.")
@click.option("--config", "config_json", default=None, help="Partial ViewConfig JSON.")
@pass_ctx
def view_update(
    ctx: Ctx, view_id: str, name: Optional[str], config_json: Optional[str]
) -> None:
    """Update a view's name or config."""
    args = ["view", "update", view_id, *opt("--name", name), *opt("--config", config_json)]
    emit(ctx, call(ctx, args), lambda d: f"{d['name']} ({d['type']})  [{d['id']}]")


@view.command("rm")
@click.argument("view_id")
@pass_ctx
def view_rm(ctx: Ctx, view_id: str) -> None:
    """Delete a saved view."""
    emit(ctx, call(ctx, ["view", "rm", view_id]), lambda d: f"deleted {d['deleted']}")


# ---------------------------------------------------------------------------
# history
# ---------------------------------------------------------------------------


@cli.group()
def history() -> None:
    """Page version history."""


@history.command("list")
@click.argument("page_id")
@pass_ctx
def history_list(ctx: Ctx, page_id: str) -> None:
    """List a page's snapshots, newest first."""

    def human(snaps: Any) -> str:
        if not snaps:
            return "(no history)"
        return "\n".join(f"{s['createdAt']}  {s['cause']:<7}  [{s['id']}]" for s in snaps)

    emit(ctx, call(ctx, ["history", "list", page_id]), human)


@history.command("save")
@click.argument("page_id")
@pass_ctx
def history_save(ctx: Ctx, page_id: str) -> None:
    """Capture a manual snapshot of a page now."""
    emit(ctx, call(ctx, ["history", "save", page_id]), lambda d: f"snapshot {d['id']}")


@history.command("show")
@click.argument("snapshot_id")
@pass_ctx
def history_show(ctx: Ctx, snapshot_id: str) -> None:
    """Show a snapshot's full content."""
    emit(ctx, call(ctx, ["history", "show", snapshot_id]))


@history.command("restore")
@click.argument("snapshot_id")
@pass_ctx
def history_restore(ctx: Ctx, snapshot_id: str) -> None:
    """Restore a snapshot (the current state is snapshotted first)."""
    emit(ctx, call(ctx, ["history", "restore", snapshot_id]), lambda d: f"restored {d['restored']}")


# ---------------------------------------------------------------------------
# templates
# ---------------------------------------------------------------------------


@cli.group()
def template() -> None:
    """Page templates."""


@template.command("save")
@click.argument("page_id")
@click.option("--name", default=None, help="Template name (defaults to the page title).")
@pass_ctx
def template_save(ctx: Ctx, page_id: str, name: Optional[str]) -> None:
    """Save a page as a reusable template."""
    args = ["template", "save", page_id, *opt("--name", name)]
    emit(ctx, call(ctx, args), lambda d: f"{d['name']}  [{d['id']}]")


@template.command("list")
@pass_ctx
def template_list(ctx: Ctx) -> None:
    """List saved templates."""

    def human(items: Any) -> str:
        if not items:
            return "(no templates)"
        return "\n".join(f"{t['name']}  [{t['id']}]" for t in items)

    emit(ctx, call(ctx, ["template", "list"]), human)


@template.command("use")
@click.argument("template_id")
@click.option("-p", "--parent", default=None, help="Parent page id (omit for root).")
@pass_ctx
def template_use(ctx: Ctx, template_id: str, parent: Optional[str]) -> None:
    """Instantiate a template as a new page."""
    emit(ctx, call(ctx, ["template", "use", template_id, *opt("-p", parent)]), page_line)


@template.command("rm")
@click.argument("template_id")
@pass_ctx
def template_rm(ctx: Ctx, template_id: str) -> None:
    """Delete a template."""
    emit(ctx, call(ctx, ["template", "rm", template_id]), lambda d: f"deleted {d['deleted']}")


# ---------------------------------------------------------------------------
# export
# ---------------------------------------------------------------------------


@cli.group()
def export() -> None:
    """Export workspace content."""


@export.command("md")
@click.argument("page_id")
@click.argument("directory", type=click.Path(file_okay=False))
@click.option(
    "--recursive/--no-recursive",
    default=True,
    help="Include descendant pages (default: yes).",
)
@pass_ctx
def export_md(ctx: Ctx, page_id: str, directory: str, recursive: bool) -> None:
    """Export a page (and descendants) as Markdown + CSV + assets."""
    args = ["export", "md", page_id, directory] + ([] if recursive else ["--no-recursive"])
    emit(
        ctx,
        call(ctx, args),
        lambda d: f"{len(d['files'])} files written\n" + "\n".join(d["files"]),
    )


@export.command("workspace")
@click.argument("directory", type=click.Path(file_okay=False))
@pass_ctx
def export_workspace(ctx: Ctx, directory: str) -> None:
    """Export the whole workspace as full-fidelity JSON."""
    emit(ctx, call(ctx, ["export", "workspace", directory]), lambda d: f"{len(d['files'])} files written")


# ---------------------------------------------------------------------------
# favorites / recents
# ---------------------------------------------------------------------------


@cli.group()
def fav() -> None:
    """Favorite pages."""


@fav.command("add")
@click.argument("page_id")
@pass_ctx
def fav_add(ctx: Ctx, page_id: str) -> None:
    """Add a page to favorites."""
    emit(ctx, call(ctx, ["fav", "add", page_id]), lambda d: f"{len(d['favorites'])} favorite(s)")


@fav.command("remove")
@click.argument("page_id")
@pass_ctx
def fav_remove(ctx: Ctx, page_id: str) -> None:
    """Remove a page from favorites."""
    emit(ctx, call(ctx, ["fav", "remove", page_id]), lambda d: f"{len(d['favorites'])} favorite(s)")


@fav.command("list")
@pass_ctx
def fav_list(ctx: Ctx) -> None:
    """List favorite pages."""
    emit(ctx, call(ctx, ["fav", "list"]), lambda d: render_pages(d, "(no favorites)"))


@cli.command("recents")
@pass_ctx
def recents(ctx: Ctx) -> None:
    """List recently visited pages."""
    emit(ctx, call(ctx, ["recents"]), lambda d: render_pages(d, "(no recents)"))


# ---------------------------------------------------------------------------
# REPL
# ---------------------------------------------------------------------------

_REPL_BANNER = (
    "cli-anything-kumi REPL — same commands, without the program prefix.\n"
    "  use <workspace-path>   switch workspace\n"
    "  help                   list commands\n"
    "  exit                   quit (or Ctrl-D)"
)


def split_line(line: str) -> list[str]:
    """Split a REPL line into argv.

    Uses shlex in non-POSIX mode so Windows paths keep their backslashes, then
    strips the surrounding quotes shlex leaves on quoted tokens.
    """
    tokens = shlex.split(line, posix=False)
    out: list[str] = []
    for token in tokens:
        if len(token) >= 2 and token[0] == token[-1] and token[0] in "\"'":
            token = token[1:-1]
        out.append(token)
    return out


def _command_help_lines() -> list[str]:
    """One line per top-level command/group of the harness."""
    lines: list[str] = []
    for name, cmd in sorted(cli.commands.items()):
        if name == "repl":
            continue
        summary = (cmd.help or "").strip().splitlines()[0] if cmd.help else ""
        if isinstance(cmd, click.Group):
            subs = ", ".join(sorted(cmd.commands))
            lines.append(f"  {name:<12} {summary}  ({subs})")
        else:
            lines.append(f"  {name:<12} {summary}")
    lines.append(f"  {'use':<12} Switch the current workspace.")
    lines.append(f"  {'exit':<12} Leave the REPL.")
    return lines


def run_repl(state: Ctx, stream: Any = None, out: Any = None) -> int:
    """Run the stateful REPL loop; returns the process exit code."""
    stream = stream or sys.stdin
    write = (out or sys.stdout).write
    interactive = stream.isatty()
    if interactive:
        write(_REPL_BANNER + "\n")
        write(f"workspace: {state.workspace}\n")
    while True:
        if interactive:
            write("kumi> ")
            (out or sys.stdout).flush()
        line = stream.readline()
        if line == "":
            if interactive:
                write("\n")
            return 0
        text = line.strip()
        if not text or text.startswith("#"):
            continue
        try:
            argv = split_line(text)
        except ValueError as exc:
            write(f"error (usage): {exc}\n")
            continue
        if not argv:
            continue
        verb = argv[0]
        if verb in {"exit", "quit"}:
            return 0
        if verb == "help":
            write("\n".join(_command_help_lines()) + "\n")
            continue
        if verb == "use":
            if len(argv) != 2:
                write("error (usage): use <workspace-path>\n")
                continue
            state.workspace = argv[1]
            write(f"workspace: {state.workspace}\n")
            continue
        if verb == "repl":
            write("error (usage): already in the REPL\n")
            continue
        if verb == "workspace" and len(argv) == 1:
            argv = ["workspace", "info"]
        _dispatch(state, argv, write)


def _dispatch(state: Ctx, argv: list[str], write: Callable[[str], Any]) -> None:
    """Invoke the shared Click group for one REPL line, reporting errors inline."""
    try:
        cli.main(args=argv, obj=state, standalone_mode=False, prog_name="kumi")
    except KumiBackendError as exc:
        write(f"error ({exc.code}): {exc.message}\n")
    except BackendUnavailable as exc:
        write(f"error (backend_unavailable): {exc}\n")
    except click.ClickException as exc:
        write(f"error (usage): {exc.format_message()}\n")
    except click.exceptions.Abort:
        write("error (usage): aborted\n")
    except SystemExit as exc:
        if exc.code not in (0, None):
            write(f"error (exit): {exc.code}\n")


@cli.command("repl")
@pass_ctx
def repl(ctx: Ctx) -> None:
    """Start a stateful REPL that holds the current workspace."""
    raise SystemExit(run_repl(ctx))


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------


def _use_utf8_output() -> None:
    """Force UTF-8 on stdout/stderr so emoji icons survive the Windows console."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):
                pass


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Console-script entry point: run the harness and map errors to exit codes."""
    _use_utf8_output()
    try:
        cli.main(args=list(argv) if argv is not None else None, standalone_mode=False)
    except KumiBackendError as exc:
        click.echo(f"error ({exc.code}): {exc.message}", err=True)
        return 1
    except BackendUnavailable as exc:
        click.echo(f"error (backend_unavailable): {exc}", err=True)
        return 1
    except click.ClickException as exc:
        exc.show()
        return exc.exit_code
    except click.exceptions.Abort:
        click.echo("aborted", err=True)
        return 1
    except SystemExit as exc:
        if exc.code is None:
            return 0
        return exc.code if isinstance(exc.code, int) else 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
