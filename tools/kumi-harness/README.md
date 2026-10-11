# cli-anything-kumi

A [CLI-Anything](https://github.com/HKUDS/CLI-Anything)-style agent harness for
Kumi. It exposes the whole Kumi workspace — pages, blocks, databases, search,
history, templates, export — as a Click CLI with `--json` output on every
command, plus a stateful REPL.

It drives the **real** Kumi CLI (`apps/cli/dist/index.js`) as a subprocess.
There is no mock and no fallback: if `node` or the built backend is missing,
commands fail loudly.

## Install

```bash
pnpm --filter @kumi/cli build     # build the backend (from the repo root)
pip install -e tools/kumi-harness
cli-anything-kumi doctor          # verify backend, node, workspace, database
```

## Usage

```bash
export KUMI_WORKSPACE=/path/to/workspace

# Human-readable by default
cli-anything-kumi page create -t "Engineering" -i "🛠"
#> 🛠 Engineering  [8ba12888-5883-4578-971a-828a5814dfea]

# Structured output for agents
cli-anything-kumi --json page list

# Stateful REPL
cli-anything-kumi repl
```

Environment: `KUMI_WORKSPACE` (workspace path), `KUMI_CLI_PATH` (backend entry
override), `KUMI_REPO` (repo root used to find the backend).

## Tests

```bash
python -m pytest tools/kumi-harness/tests -q
```

The suite runs against a real temporary workspace through the installed
harness; it fails — never skips — when the backend is unavailable.

## More

See [SKILL.md](SKILL.md) for the full command list, workspace concepts, and
agent recipes.
