import os
import subprocess
from itertools import count
from pathlib import Path

import pytest

SCRIPT_PATH = Path(__file__).resolve().parents[1] / "bin" / "tricorder_auto_update.sh"


def run(cmd, *, cwd=None, env=None):
    subprocess.run(cmd, cwd=cwd, env=env, check=True)


@pytest.fixture
def git_env(tmp_path):
    env = os.environ.copy()
    env.update(
        {
            "GIT_AUTHOR_NAME": "Tricorder Tests",
            "GIT_AUTHOR_EMAIL": "tricorder-tests@example.com",
            "GIT_COMMITTER_NAME": "Tricorder Tests",
            "GIT_COMMITTER_EMAIL": "tricorder-tests@example.com",
        }
    )
    return env


@pytest.fixture
def auto_update_repo(tmp_path, git_env):
    repo_dir = tmp_path / "repo"
    run(["git", "init", repo_dir], env=git_env)
    run(["git", "-C", str(repo_dir), "checkout", "-b", "main"], env=git_env)

    install_script = repo_dir / "install.sh"
    install_script.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        "echo install >> \"$BASE/install.log\"\n"
    )
    install_script.chmod(0o755)

    tracked = repo_dir / "tracked.txt"
    tracked.write_text("initial\n")
    run(["git", "-C", str(repo_dir), "add", "install.sh", "tracked.txt"], env=git_env)
    run(["git", "-C", str(repo_dir), "commit", "-m", "initial commit"], env=git_env)

    run(["git", "-C", str(repo_dir), "branch", "feature"], env=git_env)
    run(["git", "-C", str(repo_dir), "checkout", "feature"], env=git_env)
    tracked.write_text("feature v1\n")
    run(["git", "-C", str(repo_dir), "commit", "-am", "feature v1"], env=git_env)
    feature_v1 = (
        subprocess.check_output(
            ["git", "-C", str(repo_dir), "rev-parse", "HEAD"], env=git_env
        )
        .decode()
        .strip()
    )
    run(["git", "-C", str(repo_dir), "checkout", "main"], env=git_env)

    bare = tmp_path / "remote.git"
    run(["git", "clone", "--bare", str(repo_dir), str(bare)] , env=git_env)

    run(["git", "-C", str(repo_dir), "remote", "add", "origin", str(bare)], env=git_env)
    run(["git", "-C", str(repo_dir), "push", "origin", "main"], env=git_env)
    run(["git", "-C", str(repo_dir), "push", "origin", "feature"], env=git_env)

    feature_counter = count(start=2)

    def make_feature_commit():
        index = next(feature_counter)
        run(["git", "-C", str(repo_dir), "checkout", "feature"], env=git_env)
        tracked.write_text(f"feature v{index}\n")
        run(["git", "-C", str(repo_dir), "commit", "-am", f"feature v{index}"], env=git_env)
        sha = (
            subprocess.check_output(
                ["git", "-C", str(repo_dir), "rev-parse", "HEAD"], env=git_env
            )
            .decode()
            .strip()
        )
        run(["git", "-C", str(repo_dir), "push", "origin", "feature"], env=git_env)
        run(["git", "-C", str(repo_dir), "checkout", "main"], env=git_env)
        return sha

    def make_main_commit(message: str):
        run(["git", "-C", str(repo_dir), "checkout", "main"], env=git_env)
        tracked.write_text(f"{message}\n")
        run(["git", "-C", str(repo_dir), "commit", "-am", message], env=git_env)
        sha = (
            subprocess.check_output(
                ["git", "-C", str(repo_dir), "rev-parse", "HEAD"], env=git_env
            )
            .decode()
            .strip()
        )
        run(["git", "-C", str(repo_dir), "push", "origin", "main"], env=git_env)
        return sha

    return {
        "remote": str(bare),
        "repo_dir": repo_dir,
        "feature_v1": feature_v1,
        "make_feature_commit": make_feature_commit,
        "make_main_commit": make_main_commit,
        "tracked_file": tracked,
        "git_env": git_env,
    }


@pytest.fixture
def base_env(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    systemctl = bin_dir / "systemctl"
    systemctl.write_text("#!/usr/bin/env bash\nexit 0\n")
    systemctl.chmod(0o755)

    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}:{env.get('PATH', '')}"
    env["TRICORDER_UPDATE_SERVICES"] = ""
    return env


def run_updater(env):
    run(["bash", str(SCRIPT_PATH)], env=env)


def git_current_branch(path, git_env):
    return (
        subprocess.check_output(
            ["git", "-C", str(path), "rev-parse", "--abbrev-ref", "HEAD"], env=git_env
        )
        .decode()
        .strip()
    )


def git_head(path, git_env):
    return (
        subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], env=git_env)
        .decode()
        .strip()
    )


def test_production_mode_clones_main_branch(auto_update_repo, base_env, tmp_path):
    update_dir = tmp_path / "prod"
    install_base = tmp_path / "install"
    install_base.mkdir()

    env = base_env.copy()
    env.update(
        {
            "TRICORDER_UPDATE_REMOTE": auto_update_repo["remote"],
            "TRICORDER_UPDATE_BRANCH": "main",
            "TRICORDER_UPDATE_DIR": str(update_dir),
            "TRICORDER_INSTALL_BASE": str(install_base),
            "DEV": "0",
            "TRICORDER_DEV_MODE": "0",
        }
    )

    run_updater(env)

    src_dir = update_dir / "src"
    assert src_dir.exists()
    assert git_current_branch(src_dir, auto_update_repo["git_env"]) == "main"
    assert git_head(src_dir, auto_update_repo["git_env"]) == (
        subprocess.check_output(
            [
                "git",
                "-C",
                auto_update_repo["repo_dir"],
                "rev-parse",
                "origin/main",
            ],
            env=auto_update_repo["git_env"],
        )
        .decode()
        .strip()
    )
    assert (install_base / "install.log").read_text().splitlines() == ["install"]


def test_production_mode_skips_when_up_to_date(
    auto_update_repo, base_env, tmp_path
):
    update_dir = tmp_path / "prod"
    install_base = tmp_path / "install"
    install_base.mkdir()

    env = base_env.copy()
    env.update(
        {
            "TRICORDER_UPDATE_REMOTE": auto_update_repo["remote"],
            "TRICORDER_UPDATE_BRANCH": "main",
            "TRICORDER_UPDATE_DIR": str(update_dir),
            "TRICORDER_INSTALL_BASE": str(install_base),
            "DEV": "0",
            "TRICORDER_DEV_MODE": "0",
        }
    )

    run_updater(env)
    log_path = install_base / "install.log"
    assert log_path.read_text().splitlines() == ["install"]

    run_updater(env)
    assert log_path.read_text().splitlines() == ["install"]

    new_head = auto_update_repo["make_main_commit"]("main update")
    run_updater(env)
    assert log_path.read_text().splitlines() == ["install", "install"]

    src_dir = update_dir / "src"
    assert git_head(src_dir, auto_update_repo["git_env"]) == new_head


def test_dev_mode_refreshes_current_branch(auto_update_repo, base_env, tmp_path):
    update_dir = tmp_path / "dev"
    install_base = tmp_path / "install"
    install_base.mkdir()

    src_dir = update_dir / "src"
    run(["git", "clone", auto_update_repo["remote"], str(src_dir)])
    run(["git", "-C", str(src_dir), "checkout", "feature"])

    original_head = git_head(src_dir, auto_update_repo["git_env"])
    new_head = auto_update_repo["make_feature_commit"]()
    assert original_head != new_head

    env = base_env.copy()
    env.update(
        {
            "TRICORDER_UPDATE_REMOTE": auto_update_repo["remote"],
            "TRICORDER_UPDATE_BRANCH": "main",
            "TRICORDER_UPDATE_DIR": str(update_dir),
            "TRICORDER_INSTALL_BASE": str(install_base),
            "DEV": "0",
            "TRICORDER_DEV_MODE": "1",
        }
    )

    run_updater(env)

    assert git_current_branch(src_dir, auto_update_repo["git_env"]) == "feature"
    assert git_head(src_dir, auto_update_repo["git_env"]) == new_head


@pytest.mark.parametrize(
    "env_overrides, create_dev_file",
    [
        ({"DEV": "1", "TRICORDER_DEV_MODE": "0"}, False),
        ({"DEV": "0", "TRICORDER_DEV_MODE": "1"}, False),
        ({"DEV": "0", "TRICORDER_DEV_MODE": "0"}, True),
    ],
)
def test_dev_mode_signals_are_consistent(
    auto_update_repo, base_env, tmp_path, env_overrides, create_dev_file
):
    update_dir = tmp_path / "dev-check"
    install_base = tmp_path / "install"
    install_base.mkdir()
    if create_dev_file:
        (install_base / ".dev-mode").write_text("\n")

    src_dir = update_dir / "src"
    run(["git", "clone", auto_update_repo["remote"], str(src_dir)])
    run(["git", "-C", str(src_dir), "checkout", "feature"])

    original_head = git_head(src_dir, auto_update_repo["git_env"])
    new_head = auto_update_repo["make_feature_commit"]()
    assert original_head != new_head

    env = base_env.copy()
    env.update(
        {
            "TRICORDER_UPDATE_REMOTE": auto_update_repo["remote"],
            "TRICORDER_UPDATE_BRANCH": "main",
            "TRICORDER_UPDATE_DIR": str(update_dir),
            "TRICORDER_INSTALL_BASE": str(install_base),
            "DEV": "0",
            "TRICORDER_DEV_MODE": "0",
        }
    )
    env.update(env_overrides)

    run_updater(env)

    assert git_current_branch(src_dir, auto_update_repo["git_env"]) == "feature"
    assert git_head(src_dir, auto_update_repo["git_env"]) == new_head


