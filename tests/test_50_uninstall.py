import subprocess
import os
from pathlib import Path


def test_uninstall_script_runs(tmp_path):
    """
    Run install.sh --remove in DEV mode with BASE override.
    Ensures it exits cleanly without touching the real system.
    """
    repo_root = Path(__file__).resolve().parents[1]
    script = repo_root / "install.sh"

    base_dir = tmp_path / "tricorder_test"
    base_dir.mkdir()

    env = os.environ.copy()
    env["DEV"] = "1"         # safe mode
    env["BASE"] = str(base_dir)

    result = subprocess.run(
        ["bash", str(script), "--remove"],
        env=env,
        cwd=repo_root,
        capture_output=True,
        text=True,
    )

    print("UNINSTALL STDOUT:\n", result.stdout)
    print("UNINSTALL STDERR:\n", result.stderr)

    assert result.returncode == 0, f"install.sh --remove failed: {result.stderr}"
