# AGENTS

## Repository-wide guidelines
- Target Python 3.10 for compatibility with the Raspberry Pi Zero 2 W deployment environment; avoid features that require newer runtimes.
- Keep dependencies lean. Prefer the standard library first, and justify any new third-party packages by documenting why they are needed for the embedded deployment. Update `requirements.txt` and `requirements-dev.txt` together if you add Python dependencies.
- Preserve the existing logging approach that relies on `print(..., flush=True)` so journalctl/systemd logs stay chronological. Use structured helper functions only when they do not hide log messages during boot.
- When modifying long-running daemons, ensure they handle signals cleanly and always close subprocess pipes. Mirror the patterns already used in `lib/live_stream_daemon.py` and `lib/segmenter.py`.

## Python code style
- Match the current imperative style: module-level constants are `UPPER_SNAKE_CASE`, functions and variables use `snake_case`.
- Type hints are welcome where they improve readability, but stay consistent within a module. Do not mix hinted and unhinted function signatures in the same file without good reason.
- Avoid introducing broad exception handlers; always log the exception and limit the scope of `try/except` blocks.
- Keep public functions well documented with docstrings when behavior is non-obvious, especially around audio frame math or filesystem paths.

## Shell scripts and systemd units
- Write shell scripts for `bash` and start them with `#!/usr/bin/env bash` followed by `set -euo pipefail`.
- Ensure scripts remain POSIX-friendly enough to run on Raspberry Pi OS. Avoid GNU-only extensions unless they are already used in the project.
- When editing systemd unit files, maintain matching `.service`/`.timer` pairs and document any new environment variables in `config.yaml`.

## Testing and validation
- Run `pytest -q` before submitting changes. If you touch only a subset of functionality, run the most relevant module-specific tests in addition to the full suite to catch regressions early.
- If your change alters install or uninstall behavior, run `pytest tests/test_00_install.py` and/or `pytest tests/test_50_uninstall.py` in addition to the full run.
- When changes impact shell scripts or systemd units, perform a dry run on a Raspberry Pi if possible, or document why that is not feasible.
