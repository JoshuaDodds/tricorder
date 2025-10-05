import yaml

from lib import config as config_module


def _reset_config_state(monkeypatch):
    monkeypatch.setattr(config_module, "_cfg_cache", None, raising=False)
    monkeypatch.setattr(config_module, "_search_paths", [], raising=False)
    monkeypatch.setattr(config_module, "_active_config_path", None, raising=False)
    monkeypatch.setattr(config_module, "_primary_config_path", None, raising=False)


def test_apply_config_migrations_normalizes_rsync_lists(monkeypatch, tmp_path):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        """
archival:
  rsync:
    options: "-az"
    ssh_options: "-oStrictHostKeyChecking=no"
""".strip()
    )

    monkeypatch.setenv("TRICORDER_CONFIG", str(config_path))
    _reset_config_state(monkeypatch)

    changed = config_module.apply_config_migrations()
    assert changed is True

    data = yaml.safe_load(config_path.read_text())
    assert data["archival"]["rsync"]["options"] == ["-az"]
    assert data["archival"]["rsync"]["ssh_options"] == ["-oStrictHostKeyChecking=no"]

    cfg = config_module.get_cfg()
    assert cfg["archival"]["rsync"]["options"] == ["-az"]
    assert cfg["archival"]["rsync"]["ssh_options"] == ["-oStrictHostKeyChecking=no"]


def test_apply_config_migrations_is_idempotent(monkeypatch, tmp_path):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        """
archival:
  rsync:
    options:
      - -az
    ssh_options:
      - -oStrictHostKeyChecking=no
""".strip()
    )

    monkeypatch.setenv("TRICORDER_CONFIG", str(config_path))
    _reset_config_state(monkeypatch)

    changed = config_module.apply_config_migrations()
    assert changed is False

    cfg = config_module.get_cfg()
    assert cfg["archival"]["rsync"]["options"] == ["-az"]
    assert cfg["archival"]["rsync"]["ssh_options"] == ["-oStrictHostKeyChecking=no"]
