# Contributing to Tricorder

Thank you — contributions keep Tricorder healthy. This short guide explains how to contribute safely and effectively.

## Quick start
1. Fork the repo and create a branch: `git checkout -b fix/short-description`.
2. Run tests: `pytest -q`.
3. Add tests for new behavior and update docs where appropriate.
4. Open a pull request describing the change, risk, and test steps.

## Issues
- Search existing issues first; add details if you find a duplicate.
- For bug reports include: device (Pi model), OS/version, minimal reproduction steps, logs, and expected vs actual behavior.
- For feature requests describe the user problem, proposed UX, and fallback behavior.

## Pull Request Expectations
- Small focused PRs are preferred.
- Include test(s) for behavioral changes.
- Update `README.md` and `config.yaml` for new runtime options.
- Provide a short “risk statement” for runtime-impacting changes.
- If you change systemd units or install scripts, test on a Pi or document why not.

## Coding standards
- Python: target Python 3.10, follow existing module style, use `snake_case`, constants `UPPER_SNAKE_CASE`, type hints welcome.
- Frontend: ES modules + vanilla CSS; keep compatibility with Raspberry Pi OS Chromium.
- Shell: `#!/usr/bin/env bash` and `set -euo pipefail`.

## Tests & CI
- Run `pytest -q` locally.
- New dependencies must be justified and added to `requirements*.txt`.
- Ensure CI passes; if a change cannot run on CI (hardware dependency), document how maintainers can verify it.

## Security & Sensitive Data
- Do not include secrets or PII in commits.
- Follow the `SECURITY.md` policy for reporting vulnerabilities.

## Communication
- Use issues to propose large design changes before coding.
- Be respectful and patient in reviews.

Thanks — maintainers will review PRs as quickly as possible.
