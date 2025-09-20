import subprocess
import os
from pathlib import Path


def test_install_script_runs(tmp_path):
    """
    Run install.sh in DEV mode with BASE override.
    This ensures we don't touch the real system (/apps/tricorder).
    """
    repo_root = Path(__file__).resolve().parents[1]
    script = repo_root / "install.sh"

    base_dir = tmp_path / "tricorder_test"
    env = os.environ.copy()
    env["DEV"] = "1"         # run in safe dev mode
    env["BASE"] = str(base_dir)

    result = subprocess.run(
        ["bash", str(script)],
        env=env,
        cwd=repo_root,
        capture_output=True,
        text=True,
    )

    print("INSTALL STDOUT:\n", result.stdout)
    print("INSTALL STDERR:\n", result.stderr)

    assert result.returncode == 0, f"install.sh failed: {result.stderr}"

    # Verify the expected directories exist in test BASE
    for d in ("bin", "lib", "recordings", "dropbox", "systemd", "tmp"):
        assert (base_dir / d).exists(), f"Missing {d} in {base_dir}"
