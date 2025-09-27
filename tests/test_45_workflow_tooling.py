from __future__ import annotations

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
