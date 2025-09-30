import os
import shutil
import subprocess
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = REPO_ROOT / "bin" / "tricorder_auto_update.sh"


pytestmark = pytest.mark.skipif(
    shutil.which("git") is None,
    reason="git command unavailable; auto-update integration tests require git",
)


GIT_ENV = {
    "GIT_AUTHOR_NAME": "Tricorder Test",
    "GIT_AUTHOR_EMAIL": "tricorder@example.com",
    "GIT_COMMITTER_NAME": "Tricorder Test",
    "GIT_COMMITTER_EMAIL": "tricorder@example.com",
}


def run_git(*args, cwd=None):
    env = os.environ.copy()
    env.update(GIT_ENV)
    subprocess.run(["git", *args], cwd=cwd, check=True, env=env)


def create_remote_repo(tmp_path, install_script_contents=None):
    remote_path = tmp_path / "remote.git"
    subprocess.run(["git", "init", "--bare", remote_path], check=True)

    worktree = tmp_path / "worktree"
    worktree.mkdir()
    run_git("init", cwd=worktree)
    run_git("checkout", "-b", "main", cwd=worktree)

    install_script = worktree / "install.sh"
    if install_script_contents is None:
        install_script_contents = """#!/usr/bin/env bash
set -euo pipefail
mkdir -p "${BASE}"
echo "install run DEV=${DEV:-unset}" >> "${BASE}/install.log"
"""
    install_script.write_text(install_script_contents)
    install_script.chmod(0o755)

    run_git("add", "install.sh", cwd=worktree)
    run_git("commit", "-m", "initial installer", cwd=worktree)
    run_git("remote", "add", "origin", str(remote_path), cwd=worktree)
    run_git("push", "-u", "origin", "main", cwd=worktree)

    return remote_path, worktree


def push_remote_change(worktree, filename, content):
    target = worktree / filename
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)
    run_git("add", str(target.relative_to(worktree)), cwd=worktree)
    run_git("commit", "-m", f"update {filename}", cwd=worktree)
    run_git("push", "origin", "main", cwd=worktree)


def make_env(remote, update_dir, install_base, extra=None):
    env = os.environ.copy()
    env.update(
        {
            "TRICORDER_UPDATE_REMOTE": str(remote),
            "TRICORDER_UPDATE_BRANCH": "main",
            "TRICORDER_UPDATE_DIR": str(update_dir),
            "TRICORDER_INSTALL_BASE": str(install_base),
            "TRICORDER_INSTALL_SCRIPT": "install.sh",
            "TRICORDER_UPDATE_SERVICES": "",
        }
    )

    stub_dir = update_dir / "bin"
    stub_dir.mkdir(parents=True, exist_ok=True)
    systemctl = stub_dir / "systemctl"
    systemctl.write_text("#!/usr/bin/env bash\nexit 0\n")
    systemctl.chmod(0o755)
    env["PATH"] = f"{stub_dir}:{env.get('PATH', '')}"

    if extra:
        env.update(extra)

    return env


def run_auto_update(env, *, expect_failure=False):
    result = subprocess.run(
        [str(SCRIPT_PATH)],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )
    if result.returncode != 0:
        if expect_failure:
            return result
        raise AssertionError(
            f"auto update failed with code {result.returncode}: {result.stderr}"
        )
    return result


def test_auto_update_skips_install_when_no_changes(tmp_path):
    remote, worktree = create_remote_repo(tmp_path)
    update_dir = tmp_path / "update"
    install_base = tmp_path / "install"
    env = make_env(remote, update_dir, install_base)

    run_auto_update(env)
    log_path = install_base / "install.log"
    assert log_path.exists(), "installer did not run on initial checkout"
    initial_lines = log_path.read_text().strip().splitlines()
    assert len(initial_lines) == 1

    run_auto_update(env)
    second_lines = log_path.read_text().strip().splitlines()
    assert second_lines == initial_lines, "installer reran without remote changes"

    push_remote_change(worktree, "version.txt", "1")
    run_auto_update(env)
    final_lines = log_path.read_text().strip().splitlines()
    assert len(final_lines) == 2


def test_auto_update_propagates_dev_flag(tmp_path):
    remote, _ = create_remote_repo(tmp_path)
    update_dir = tmp_path / "update"
    install_base = tmp_path / "install"
    install_base.mkdir()
    (install_base / ".dev-mode").write_text("dev mode enabled")

    env = make_env(remote, update_dir, install_base)

    run_auto_update(env)
    log_path = install_base / "install.log"
    assert log_path.exists()
    entry = log_path.read_text().strip().splitlines()[-1]
    assert entry.endswith("DEV=1"), f"expected DEV=1 in install log, got {entry!r}"
    assert (install_base / ".dev-mode").exists()


def test_auto_update_retries_after_failed_install(tmp_path):
    failing_script = """#!/usr/bin/env bash
set -euo pipefail
mkdir -p "${BASE}"
attempts_file="${BASE}/attempts"
count=0
if [[ -f "${attempts_file}" ]]; then
  count=$(<"${attempts_file}")
fi
count=$((count + 1))
printf '%s\n' "${count}" >"${attempts_file}"
if [[ ! -f "${BASE}/allow-success" ]]; then
  echo "failing on attempt ${count}" >&2
  exit 3
fi
echo "install run DEV=${DEV:-unset}" >> "${BASE}/install.log"
"""
    remote, _ = create_remote_repo(tmp_path, install_script_contents=failing_script)
    update_dir = tmp_path / "update"
    install_base = tmp_path / "install"
    env = make_env(remote, update_dir, install_base)

    result = run_auto_update(env, expect_failure=True)
    assert result.returncode != 0
    attempts_file = install_base / "attempts"
    assert attempts_file.exists()
    assert attempts_file.read_text().strip() == "1"
    sentinel = update_dir / ".last_install_failed"
    assert sentinel.exists(), "failure sentinel should be present after install failure"

    (install_base / "allow-success").write_text("ok")

    run_auto_update(env)

    assert attempts_file.read_text().strip() == "2"
    log_path = install_base / "install.log"
    assert log_path.exists()
    entries = log_path.read_text().strip().splitlines()
    assert len(entries) == 1
    assert not sentinel.exists(), "failure sentinel should be cleared after successful install"
