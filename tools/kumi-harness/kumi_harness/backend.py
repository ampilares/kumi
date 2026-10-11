"""Locate and drive the real Kumi Node CLI.

Zero compromise: this module never simulates, mocks, or degrades. If `node` is
missing or the built backend entry point cannot be found, every call raises
:class:`BackendUnavailable` so the failure is loud and obvious.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Iterable, Optional, Sequence

__all__ = [
    "BackendUnavailable",
    "KumiBackendError",
    "find_repo_root",
    "find_backend_entry",
    "find_node",
    "default_workspace",
    "run",
    "backend_info",
]

_ENTRY_RELATIVE = Path("apps") / "cli" / "dist" / "index.js"


class BackendUnavailable(RuntimeError):
    """Raised when node or the built Kumi CLI cannot be located."""


class KumiBackendError(RuntimeError):
    """Raised when the Kumi CLI returns an ``{ok: false}`` envelope."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


def find_repo_root(start: Optional[Path] = None) -> Optional[Path]:
    """Return the Kumi repo root, from ``KUMI_REPO`` or by walking up from here.

    Returns ``None`` when no ancestor directory contains ``apps/cli``.
    """
    env_repo = os.environ.get("KUMI_REPO")
    if env_repo:
        candidate = Path(env_repo).expanduser().resolve()
        if (candidate / "apps" / "cli").is_dir():
            return candidate
    base = (start or Path(__file__).resolve()).resolve()
    for parent in [base, *base.parents]:
        if (parent / "apps" / "cli").is_dir():
            return parent
    return None


def find_backend_entry() -> Path:
    """Return the absolute path of the built Kumi CLI entry point.

    Honours ``KUMI_CLI_PATH`` first, then ``<repo>/apps/cli/dist/index.js``.
    Raises :class:`BackendUnavailable` if the file does not exist.
    """
    override = os.environ.get("KUMI_CLI_PATH")
    if override:
        entry = Path(override).expanduser().resolve()
        if not entry.is_file():
            raise BackendUnavailable(
                f"KUMI_CLI_PATH points at {entry}, which does not exist. "
                "Build the backend with: pnpm --filter @kumi/cli build"
            )
        return entry
    repo = find_repo_root()
    if repo is None:
        raise BackendUnavailable(
            "cannot locate the Kumi repository. Set KUMI_REPO to the repo root "
            "or KUMI_CLI_PATH to apps/cli/dist/index.js."
        )
    entry = (repo / _ENTRY_RELATIVE).resolve()
    if not entry.is_file():
        raise BackendUnavailable(
            f"the Kumi CLI is not built: {entry} is missing. "
            "Build it with: pnpm --filter @kumi/cli build"
        )
    return entry


def find_node() -> str:
    """Return the absolute path of the ``node`` executable on PATH."""
    node = shutil.which("node")
    if node is None:
        raise BackendUnavailable(
            "node was not found on PATH; Node.js >= 22 is required to run the Kumi CLI."
        )
    return node


def default_workspace() -> str:
    """Return the workspace the backend would use with no ``--workspace`` flag."""
    env_ws = os.environ.get("KUMI_WORKSPACE")
    if env_ws:
        return str(Path(env_ws).expanduser())
    return str(Path.home() / "Kumi")


def node_version() -> str:
    """Return the version string reported by ``node --version``."""
    proc = subprocess.run(
        [find_node(), "--version"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    if proc.returncode != 0:
        raise BackendUnavailable(f"`node --version` failed: {proc.stderr.strip()}")
    return proc.stdout.strip()


def backend_info(workspace: Optional[str] = None) -> dict[str, Any]:
    """Return a diagnostic snapshot: entry point, node version, workspace path."""
    return {
        "entry": str(find_backend_entry()),
        "node": find_node(),
        "nodeVersion": node_version(),
        "workspace": workspace or default_workspace(),
        "repo": str(find_repo_root() or ""),
    }


def _decode_envelope(text: str) -> Optional[dict[str, Any]]:
    """Parse a JSON envelope, returning ``None`` when the text is not JSON."""
    stripped = text.strip()
    if not stripped:
        return None
    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def run(
    args: Sequence[str],
    *,
    workspace: Optional[str] = None,
    json_mode: bool = True,
    stdin: Optional[str] = None,
    cwd: Optional[str] = None,
) -> Any:
    """Run the Kumi CLI and return the ``data`` payload of its JSON envelope.

    ``args`` are the backend's own subcommand tokens (e.g. ``["page", "list"]``).
    Raises :class:`KumiBackendError` on an ``{ok: false}`` envelope and
    :class:`BackendUnavailable` when node or the built CLI is missing.
    """
    entry = find_backend_entry()
    node = find_node()
    argv: list[str] = [node, str(entry)]
    if workspace:
        argv += ["--workspace", str(workspace)]
    if json_mode:
        argv.append("--json")
    argv += [str(a) for a in args]

    proc = subprocess.run(
        argv,
        input=stdin,
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=cwd,
        check=False,
    )

    if not json_mode:
        if proc.returncode != 0:
            raise KumiBackendError("internal", proc.stderr.strip() or "backend failed")
        return proc.stdout

    err_envelope = _decode_envelope(proc.stderr)
    if err_envelope is not None and err_envelope.get("ok") is False:
        error = err_envelope.get("error") or {}
        raise KumiBackendError(
            str(error.get("code", "internal")),
            str(error.get("message", "unknown backend error")),
        )

    if proc.returncode != 0:
        # Usage errors (exit 2) and any other non-envelope failure.
        code = "usage" if proc.returncode == 2 else "internal"
        detail = proc.stderr.strip() or proc.stdout.strip() or f"exit {proc.returncode}"
        raise KumiBackendError(code, detail)

    envelope = _decode_envelope(proc.stdout)
    if envelope is None:
        raise KumiBackendError(
            "internal", f"backend produced non-JSON output: {proc.stdout[:400]!r}"
        )
    if envelope.get("ok") is not True:
        error = envelope.get("error") or {}
        raise KumiBackendError(
            str(error.get("code", "internal")),
            str(error.get("message", "unknown backend error")),
        )
    return envelope.get("data")


def flatten(*parts: Iterable[str] | str | None) -> list[str]:
    """Build an argv list, dropping ``None`` entries (helper for callers)."""
    out: list[str] = []
    for part in parts:
        if part is None:
            continue
        if isinstance(part, str):
            out.append(part)
        else:
            out.extend(p for p in part if p is not None)
    return out
