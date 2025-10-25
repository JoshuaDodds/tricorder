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

    voicecard_state = repo_root / "drivers" / "seeed-voicecard" / "asound.state"
    target_state_dir = base_dir / "drivers" / "seeed-voicecard"
    assert target_state_dir.exists(), "Voicecard bundle should be copied"
    assert (target_state_dir / "asound.state").exists(), "ALSA baseline should be installed"
    assert (target_state_dir / "asound.state.default").exists(), "Default ALSA snapshot should be present"
    assert (target_state_dir / "asound.state").read_bytes() == voicecard_state.read_bytes()


def test_install_skips_service_restart_for_web_only(tmp_path):
    repo_root = Path(__file__).resolve().parents[1]
    script = repo_root / "install.sh"

    base_dir = tmp_path / "tricorder_test"
    log_path = tmp_path / "sudo.log"

    stub_dir = tmp_path / "stub_bin"
    stub_dir.mkdir()
    sudo_stub = stub_dir / "sudo"
    sudo_stub.write_text(
        "#!/usr/bin/env bash\n"
        "printf '%s\\n' \"$*\" >> \"$SUDO_LOG\"\n"
        "exit 0\n"
    )
    sudo_stub.chmod(0o755)

    env = os.environ.copy()
    env.update(
        {
            "DEV": "1",
            "BASE": str(base_dir),
            "PATH": f"{stub_dir}:{env.get('PATH', '')}",
            "SUDO_LOG": str(log_path),
        }
    )

    first = subprocess.run(
        ["bash", str(script)],
        env=env,
        cwd=repo_root,
        capture_output=True,
        text=True,
    )
    assert first.returncode == 0, first.stderr

    log_path.write_text("")

    web_asset = repo_root / "lib" / "webui" / "static" / "js" / "dashboard.js"
    original = web_asset.read_text()

    try:
        web_asset.write_text(original + "\n// test change\n")
        result = subprocess.run(
            ["bash", str(script)],
            env=env,
            cwd=repo_root,
            capture_output=True,
            text=True,
        )
    finally:
        web_asset.write_text(original)

    assert result.returncode == 0, result.stderr
    assert "Web asset-only update detected" in result.stdout
    assert "Recorder/dropbox restarts skipped" in result.stdout

    commands = [line.strip() for line in log_path.read_text().splitlines() if line.strip()]
    assert any("systemctl restart web-streamer.service" in line for line in commands)
    assert all("systemctl restart voice-recorder.service" not in line for line in commands)
    assert all("systemctl restart dropbox.service" not in line for line in commands)
    assert all("systemctl restart dropbox.path" not in line for line in commands)
