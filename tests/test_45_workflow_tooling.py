from __future__ import annotations

import os
import shlex
import shutil
import subprocess
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.workflow
def test_actionlint_passes() -> None:
    actionlint = shutil.which("actionlint")
    if actionlint is None:
        pytest.skip("actionlint is not installed; install it to validate workflows")

    subprocess.run([actionlint], cwd=REPO_ROOT, check=True)


@pytest.mark.workflow
def test_act_cli_available() -> None:
    act = shutil.which("act")
    if act is None:
        pytest.skip("act is not installed; install it to exercise workflow jobs locally")

    subprocess.run([act, "--version"], cwd=REPO_ROOT, check=True)


def _build_winters_command(executable: str, template: str, *, readme: Path, output: Path) -> list[str]:
    formatted = template.format(
        readme=readme,
        output=output,
    )
    args = shlex.split(formatted)
    return [executable, *args]


@pytest.mark.workflow
def test_readme_renders_with_winters(tmp_path: Path) -> None:
    winters = shutil.which("winters")
    if winters is None:
        pytest.skip("winters is not installed; install it to lint mermaid diagrams")

    readme = REPO_ROOT / "README.md"
    if not readme.exists():
        pytest.skip("README.md missing; cannot lint documentation")

    output_path = tmp_path / "README.html"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    lint_template = os.environ.get("TRICORDER_WINTERS_LINT", "lint {readme}")
    render_template = os.environ.get(
        "TRICORDER_WINTERS_RENDER", "render {readme} --output {output}"
    )

    subprocess.run(
        _build_winters_command(winters, lint_template, readme=readme, output=output_path),
        cwd=REPO_ROOT,
        check=True,
    )

    subprocess.run(
        _build_winters_command(winters, render_template, readme=readme, output=output_path),
        cwd=REPO_ROOT,
        check=True,
    )

    assert output_path.exists(), "winters render did not produce an output artifact"
