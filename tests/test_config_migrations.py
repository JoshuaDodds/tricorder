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


def test_apply_config_migrations_normalizes_all_sections(monkeypatch, tmp_path):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        """
audio:
  sample_rate: "44100"
  frame_ms: "30"
  gain: "1.5"
  vad_aggressiveness: "2"
  filter_chain:
    highpass:
      enabled: "1"
      cutoff_hz: "120"
    denoise:
      enabled: "true"
      noise_floor_db: "-25.5"
    spectral_gate:
      sensitivity: "1.25"
      reduction_db: "-15.0"
      noise_update: "0.2"
      noise_decay: "0.9"
  calibration:
    auto_noise_profile: "yes"
    auto_gain: "0"
paths:
  tmp_dir: /custom/tmp
archival:
  enabled: "true"
  include_waveform_sidecars: "yes"
  include_transcript_sidecars: "0"
  rsync:
    options: "-az"
    ssh_options: "-oStrictHostKeyChecking=no"
segmenter:
  pre_pad_ms: "1500"
  motion_release_padding_minutes: "1.5"
  event_tags:
    human: HUMAN
adaptive_rms:
  enabled: "1"
  min_thresh: "0.2"
  max_rms: "400"
  max_thresh: "0.75"
  margin: "1.1"
  update_interval_sec: "6.5"
  window_sec: "9.5"
  hysteresis_tolerance: "0.3"
  release_percentile: "0.8"
ingest:
  stable_checks: "5"
  stable_interval_sec: "2.5"
  allowed_ext: ".wav, .mp3"
  ignore_suffixes: ".tmp, .partial"
transcription:
  enabled: "yes"
  include_words: "no"
  max_alternatives: "3"
  target_sample_rate: "22050"
  types: "Human, Other"
logging:
  dev_mode: "true"
streaming:
  mode: hls
  webrtc_history_seconds: "12.5"
  webrtc_ice_servers:
    - urls: "stun:example.com:3478, stun:example.org:3478"
dashboard:
  web_service: web-streamer.service
web_server:
  mode: http
  listen_port: "8443"
  lets_encrypt:
    enabled: "true"
    email: admin@example.com
    domains: "example.com, example.org"
    staging: "0"
    http_port: "8081"
    renew_before_days: "45"
notifications:
  enabled: "1"
  allowed_event_types: "Human,Other"
  min_trigger_rms: ""
""".strip()
    )

    monkeypatch.setenv("TRICORDER_CONFIG", str(config_path))
    _reset_config_state(monkeypatch)

    changed = config_module.apply_config_migrations()
    assert changed is True

    data = yaml.safe_load(config_path.read_text())
    assert isinstance(data["audio"]["sample_rate"], int)
    assert data["audio"]["sample_rate"] == 44100
    assert isinstance(data["audio"]["gain"], float)
    assert math.isclose(data["audio"]["gain"], 1.5)
    assert data["audio"]["filter_chain"]["highpass"]["enabled"] is True
    assert math.isclose(data["audio"]["filter_chain"]["highpass"]["cutoff_hz"], 120.0)
    assert data["audio"]["calibration"]["auto_gain"] is False
    assert data["archival"]["enabled"] is True
    assert data["archival"]["include_waveform_sidecars"] is True
    assert data["archival"]["include_transcript_sidecars"] is False
    assert data["archival"]["rsync"]["options"] == ["-az"]
    assert data["archival"]["rsync"]["ssh_options"] == ["-oStrictHostKeyChecking=no"]
    assert isinstance(data["adaptive_rms"]["max_rms"], int)
    assert data["adaptive_rms"]["max_rms"] == 400
    assert isinstance(data["ingest"]["stable_interval_sec"], float)
    assert data["ingest"]["allowed_ext"] == [".wav", ".mp3"]
    assert data["ingest"]["ignore_suffixes"] == [".tmp", ".partial"]
    assert data["transcription"]["types"] == ["Human", "Other"]
    assert data["logging"]["dev_mode"] is True
    assert isinstance(data["streaming"]["webrtc_history_seconds"], float)
    assert data["streaming"]["webrtc_ice_servers"][0]["urls"] == [
        "stun:example.com:3478",
        "stun:example.org:3478",
    ]
    assert data["notifications"]["allowed_event_types"] == ["Human", "Other"]
    assert data["notifications"]["min_trigger_rms"] is None
    assert isinstance(data["web_server"]["listen_port"], int)
    assert data["web_server"]["lets_encrypt"]["enabled"] is True
    assert data["web_server"]["lets_encrypt"]["domains"] == [
        "example.com",
        "example.org",
    ]

    _reset_config_state(monkeypatch)
    cfg = config_module.get_cfg()
    assert isinstance(cfg["adaptive_rms"]["max_rms"], int)
    assert cfg["notifications"]["min_trigger_rms"] is None
    assert isinstance(cfg["streaming"]["webrtc_ice_servers"][0]["urls"], list)
    assert cfg["streaming"]["webrtc_ice_servers"][0]["urls"][0] == "stun:example.com:3478"
