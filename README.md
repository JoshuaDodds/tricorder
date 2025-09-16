Tricorder
---------

Default install location and layout
-----------------------------------
/apps/tricorder/
 ├─ venv/                  # Python virtualenv
 ├─ bin/                   # shell scripts (encode_and_store.sh, tmpfs_guard.sh)
 ├─ lib/                   # Python source (segmenter.py, live_stream_daemon.py, process_dropped_file.py)
 ├─ recordings/            # tmpfs mount or symlink target
 ├─ dropbox/               # folder for dropped audio
 ├─ systemd/               # unit files (voice-recorder.service, dropbox.path, etc.)

