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
streaming:
  mode: hls
dashboard:
  services: []
  web_service: web-streamer.service
web_server:
  mode: http
  listen_host: 0.0.0.0
  listen_port: 8080
  tls_provider: letsencrypt
  certificate_path: ""
  private_key_path: ""
  lets_encrypt:
    enabled: false
    email: ""
    domains: []
    cache_dir: /apps/tricorder/letsencrypt
    staging: false
    certbot_path: certbot
    http_port: 80
    renew_before_days: 30
""".strip()
    )

    monkeypatch.setenv("TRICORDER_CONFIG", str(config_path))
    _reset_config_state(monkeypatch)

    changed = config_module.apply_config_migrations()
    assert changed is False

    cfg = config_module.get_cfg()
    assert cfg["archival"]["rsync"]["options"] == ["-az"]
    assert cfg["archival"]["rsync"]["ssh_options"] == ["-oStrictHostKeyChecking=no"]


def test_apply_config_migrations_adds_new_sections(monkeypatch, tmp_path):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        """
audio:
  device: hw:CARD=Device,DEV=0
""".strip()
    )

    monkeypatch.setenv("TRICORDER_CONFIG", str(config_path))
    _reset_config_state(monkeypatch)

    changed = config_module.apply_config_migrations()
    assert changed is True

    data = yaml.safe_load(config_path.read_text())
    assert "streaming" in data
    assert data["streaming"]["mode"] == "hls"
    assert "dashboard" in data
    assert data["dashboard"]["web_service"] == "web-streamer.service"
    assert "web_server" in data
    assert data["web_server"]["mode"] in {"http", "https"}

    _reset_config_state(monkeypatch)
    changed_again = config_module.apply_config_migrations()
    assert changed_again is False
