"""Allow ``python -m kumi_harness`` to run the harness."""

from __future__ import annotations

from .cli import main

if __name__ == "__main__":
    raise SystemExit(main())
