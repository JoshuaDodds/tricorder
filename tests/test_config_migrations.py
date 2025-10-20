import math
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


def test_apply_config_migrations_normalizes_segmenter_types(monkeypatch, tmp_path):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        """
segmenter:
  pre_pad_ms: "1500"
  post_pad_ms: "2500"
  rms_threshold: "450"
  keep_window_frames: "40"
  start_consecutive: "35"
  keep_consecutive: "30"
  flush_threshold_bytes: "65536"
  max_queue_frames: "256"
  filter_chain_metrics_window: "75"
  max_pending_encodes: "12"
  motion_release_padding_minutes: "1.5"
  min_clip_seconds: "2.25"
  autosplit_interval_minutes: "45"
  filter_chain_avg_budget_ms: "5.5"
  filter_chain_peak_budget_ms: "12.5"
  filter_chain_log_throttle_sec: "120"
  use_rnnoise: "yes"
  use_noisereduce: "no"
  denoise_before_vad: "0"
  auto_record_motion_override: "false"
  streaming_encode: "1"
  parallel_encode:
    enabled: "false"
    load_avg_per_cpu: "0.5"
    min_event_seconds: "3.75"
    cpu_check_interval_sec: "2"
    offline_load_avg_per_cpu: "0.25"
    offline_cpu_check_interval_sec: "5"
    live_waveform_update_interval_sec: "0.5"
    offline_max_workers: "4"
    live_waveform_buckets: "512"
""".strip()
    )

    monkeypatch.setenv("TRICORDER_CONFIG", str(config_path))
    _reset_config_state(monkeypatch)

    changed = config_module.apply_config_migrations()
    assert changed is True

    loaded = yaml.safe_load(config_path.read_text())
    segmenter = loaded["segmenter"]
    assert isinstance(segmenter["filter_chain_metrics_window"], int)
    assert segmenter["filter_chain_metrics_window"] == 75
    assert isinstance(segmenter["motion_release_padding_minutes"], float)
    assert math.isclose(segmenter["motion_release_padding_minutes"], 1.5)
    assert segmenter["use_rnnoise"] is True
    assert segmenter["use_noisereduce"] is False
    assert segmenter["auto_record_motion_override"] is False
    assert segmenter["streaming_encode"] is True
    assert isinstance(segmenter["parallel_encode"], dict)
    assert segmenter["parallel_encode"]["enabled"] is False
    assert isinstance(segmenter["parallel_encode"]["offline_max_workers"], int)

    _reset_config_state(monkeypatch)
    changed_again = config_module.apply_config_migrations()
    assert changed_again is False
