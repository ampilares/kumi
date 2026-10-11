"""End-to-end tests for the Kumi CLI-Anything harness.

Every test drives the harness as a real subprocess against a real, temporary
Kumi workspace. There is no mocking and no fallback: if node or the built
backend is missing, the suite fails loudly with instructions rather than
skipping or degrading.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from kumi_harness import backend

BUILD_HINT = "Build the backend first: pnpm --filter @kumi/cli build"


@pytest.fixture(scope="session", autouse=True)
def backend_available() -> None:
    """Fail the whole suite loudly when the real backend cannot be reached."""
    assert shutil.which("node") is not None, (
        "node was not found on PATH; Node.js >= 22 is required to run these tests."
    )
    try:
        entry = backend.find_backend_entry()
    except backend.BackendUnavailable as exc:  # pragma: no cover - env failure
        pytest.fail(f"{exc}\n{BUILD_HINT}")
    assert Path(entry).is_file(), f"backend entry {entry} is missing. {BUILD_HINT}"


@pytest.fixture(scope="session")
def workspace(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """A fresh, throwaway Kumi workspace shared by the suite."""
    return tmp_path_factory.mktemp("kumi-ws")


def env_for(workspace: Path) -> dict[str, str]:
    """Process environment pointing the harness at ``workspace``."""
    env = dict(os.environ)
    env["KUMI_WORKSPACE"] = str(workspace)
    env["PYTHONIOENCODING"] = "utf-8"
    return env


def harness(
    workspace: Path,
    *args: str,
    stdin: str | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    """Run ``python -m kumi_harness`` with the given arguments."""
    proc = subprocess.run(
        [sys.executable, "-m", "kumi_harness", *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=env_for(workspace),
        input=stdin,
    )
    if check:
        assert proc.returncode == 0, (
            f"harness {args} failed (exit {proc.returncode})\n"
            f"stdout: {proc.stdout}\nstderr: {proc.stderr}"
        )
    return proc


def data(workspace: Path, *args: str) -> Any:
    """Run the harness in --json mode and return the parsed payload."""
    proc = harness(workspace, "--json", *args)
    return json.loads(proc.stdout)


# ---------------------------------------------------------------------------


def test_doctor_reports_a_healthy_backend(workspace: Path) -> None:
    report = data(workspace, "doctor")
    assert report["ok"] is True, report
    assert report["workspaceReachable"] is True
    assert Path(report["entry"]).is_file()
    assert report["nodeVersion"].startswith("v")
    assert Path(report["workspaceResolvedPath"]).resolve() == workspace.resolve()


def test_page_create_and_list_round_trip(workspace: Path) -> None:
    page = data(workspace, "page", "create", "-t", "Harness Root")
    assert page["title"] == "Harness Root"
    nodes = data(workspace, "page", "list")
    ids = [node["page"]["id"] for node in nodes]
    assert page["id"] in ids

    child = data(workspace, "page", "create", "-t", "Child", "-p", page["id"])
    children = data(workspace, "page", "list", page["id"])
    assert [n["page"]["id"] for n in children] == [child["id"]]

    plain = harness(workspace, "page", "show", page["id"]).stdout
    assert "Harness Root" in plain and page["id"] in plain


def test_block_append_is_found_by_search(workspace: Path) -> None:
    page = data(workspace, "page", "create", "-t", "Searchable")
    appended = data(
        workspace, "block", "append", page["id"], "quokkas eat pellucid leaves"
    )
    assert appended["blockId"]

    blocks = data(workspace, "block", "list", page["id"])
    assert any(b["id"] == appended["blockId"] for b in blocks)

    results = data(workspace, "search", "pellucid")
    assert any(r["pageId"] == page["id"] for r in results), results


def test_database_schema_row_and_filtered_query(workspace: Path) -> None:
    owner = data(workspace, "page", "create", "-t", "DB Owner")
    created = data(workspace, "db", "create", owner["id"], "-t", "Tasks")
    ds_id = created["dataSource"]["id"]
    title_prop = next(p for p in created["properties"] if p["type"] == "title")["id"]

    status = data(
        workspace, "prop", "add", ds_id, "Status", "-t", "select",
        "--options", "Todo,Doing,Done",
    )
    options = {o["name"]: o["id"] for o in status["config"]["options"]}
    assert set(options) == {"Todo", "Doing", "Done"}

    def add_row(title: str, option: str) -> str:
        values = {
            title_prop: {"type": "title", "richText": [{"type": "text", "text": title}]},
            status["id"]: {"type": "select", "optionId": options[option]},
        }
        row = data(workspace, "row", "add", ds_id, "--values", json.dumps(values))
        return row["page"]["id"]

    done_id = add_row("Ship it", "Done")
    add_row("Later", "Todo")

    all_rows = data(workspace, "db", "query", ds_id)
    assert len(all_rows["rows"]) == 2

    filter_json = json.dumps(
        {
            "kind": "group",
            "op": "and",
            "children": [
                {
                    "kind": "condition",
                    "propertyId": status["id"],
                    "op": "equals",
                    "value": options["Done"],
                }
            ],
        }
    )
    filtered = data(workspace, "db", "query", ds_id, "--filter", filter_json)
    assert [r["page"]["id"] for r in filtered["rows"]] == [done_id]


def test_history_save_and_restore(workspace: Path) -> None:
    page = data(workspace, "page", "create", "-t", "Versioned")
    data(workspace, "block", "append", page["id"], "original text")
    snapshot = data(workspace, "history", "save", page["id"])
    assert snapshot["cause"] == "manual"

    data(workspace, "page", "rename", page["id"], "Renamed")
    assert data(workspace, "page", "show", page["id"])["title"] == "Renamed"

    restored = data(workspace, "history", "restore", snapshot["id"])
    assert restored["restored"] == snapshot["id"]
    assert data(workspace, "page", "show", page["id"])["title"] == "Versioned"

    snapshots = data(workspace, "history", "list", page["id"])
    assert snapshot["id"] in [s["id"] for s in snapshots]


def test_export_md_writes_files(workspace: Path, tmp_path: Path) -> None:
    page = data(workspace, "page", "create", "-t", "Exportable")
    data(workspace, "block", "append", page["id"], "exported body text")
    out_dir = tmp_path / "export"
    result = data(workspace, "export", "md", page["id"], str(out_dir))
    assert result["files"], result
    written = [Path(f) for f in result["files"]]
    assert all(p.is_file() for p in written), written
    markdown = next(p for p in written if p.suffix == ".md").read_text(encoding="utf-8")
    assert "exported body text" in markdown


def test_unknown_page_id_surfaces_not_found_and_exit_1(workspace: Path) -> None:
    proc = harness(
        workspace,
        "page",
        "show",
        "00000000-0000-0000-0000-000000000000",
        check=False,
    )
    assert proc.returncode == 1, proc
    assert "error (not_found)" in proc.stderr, proc.stderr


def test_backend_error_is_raised_as_kumi_backend_error(workspace: Path) -> None:
    with pytest.raises(backend.KumiBackendError) as excinfo:
        backend.run(
            ["page", "show", "00000000-0000-0000-0000-000000000000"],
            workspace=str(workspace),
        )
    assert excinfo.value.code == "not_found"


def test_repl_session(workspace: Path) -> None:
    script = "\n".join(
        [
            f"use {workspace}",
            'page create -t "Repl Page"',
            "page list",
            "page show nope",
            "exit",
            "",
        ]
    )
    proc = harness(workspace, "repl", stdin=script)
    assert "Repl Page" in proc.stdout, proc.stdout
    assert "error (not_found)" in proc.stdout, proc.stdout
    # `use` took effect and the listing came from the same workspace.
    assert str(workspace) in proc.stdout


def test_repl_help_lists_commands(workspace: Path) -> None:
    proc = harness(workspace, "repl", stdin="help\nexit\n")
    for name in ("page", "block", "db", "search", "export", "history"):
        assert name in proc.stdout, proc.stdout


def test_backend_unavailable_when_entry_missing(
    workspace: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("KUMI_CLI_PATH", str(tmp_path / "not-built.js"))
    with pytest.raises(backend.BackendUnavailable):
        backend.find_backend_entry()
