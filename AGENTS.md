# AGENTS

> Quick purpose: this file captures repository-wide rules, developer expectations, and design context so humans and machine agents make consistent, low-risk changes for an embedded, real-time recorder.

---

## For Automated AI/LLM Agents
IMPORTANT:
You have full ADMIN level privileges to the Jira project this task is linked to.  For details on how to use this API refer to the documentation here:
    https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/#about
You will probably mostly be interacting with:
    https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-group-issues

Naming discipline when tickets are referenced:
- Detect Jira keys in the format `<PROJECT>-<int>` using regex `\b[A-Z][A-Z0-9]+-\d+\b` across instructions, attachments, or assets.
- If a key is present, immediately transition the Jira issue from **To Do** to **In Progress**, comment “Agent started work on this ticket.”, assign the ticket to yourself, and log setup time.
- If no key is present, create a new issue for this request using the API and include Title and description, and set the sprint field to the currently active sprint so it shows on the board. Set any other appropriate fields on the issue that enrich transparency.
- When a key exists, always create the working branch and PR title prefixed with that identifier (e.g., `TR-1234-description`); recommended branch format: `tr-<num>-<short-slug>`.
- When a key exists always use the Jira key in the PR title and your own Task name in the CODEX web ui task list.  
- Branch names must begin with the Jira key (e.g., `TR-1234-description`).
- Task names must begin with the Jira key (e.g., `TR-1234-description`).

Smart commit policy:
- All commit messages must include the Jira key(s) and smart commit tags.
- Format: `git commit -m "<PROJECT>-<int> <imperative summary> #comment <concise what/why> #time <duration you spent working since the last commit was made> #transition In Review"`.
- The summary must be ≤72 chars and describe the outcome.
- `#comment` is a one-line reviewer-friendly note describing what changed and why.
- `#time` logs the actual duration you spent working rounded to the neared minute (for example, `12m`, `45m`, `1h 30m`).
- On your very last commit before you stop the task and wait for permission to push the change your final commit muct include `#transition In Review`; keep intermediate commits in **In Progress**.
- Multiple tickets can be referenced by listing each key once (e.g., `TR-101 AUDIO-202 ...`).
- Ensure the Git author email matches a Jira user for smart-commit linkage.

Ticket lifecycle expectations (Board: To Do → In Progress → In Review):
1. **Start/pickup** – transition to **In Progress** and assign yourself to this ticket using the Jira API and env credentials available to you, add the startup comment, start a timer so you can log total time spent working on this task, Update the ticket title and description to be a well written description a developer can understand, estimate the complexity and update the ticket story points, then continue with your implementation task.
2. **During work** – keep the ticket **In Progress**, post incremental commits with `<PROJECT>-<int>` keys and `#comment` tags, and perform Jira API updates to add time tracking information between commits and comments if applicable..
3. **Complete** – final commit transitions to **In Review** using the smart commit format. Post a Jira comment summarizing work, update the jira time tracking field with actually mins for your task, current status (**In Review**), and links back to this CODEX task run and PR/commit diff, and finally include testing criteria and testing steps that a human can do to verify functionalilty. Do **not** move to Done.
4. **Failures** – if transitions fail, comment the error, retry with backoff (5 attempts), and proceed with manual follow-up instructions.
5. **Fallback** – if Smart Commit automations are unavailable (permissions/workflow), explicitly post Jira comments, worklogs, and transitions using the Jira API.

Jira API usage requires `JIRA_EMAIL` and `JIRA_PAT` is available to you and they are preconfigured for codex agents in their work environments already; derive the base URL as `https://mfisbv.atlassian.net` each run instead of reading a `JIRA_BASE_URL` variable. Read tokens from the environment only, redact PAT values in logs, and scope credentials minimally (issue read/write, worklog, transitions). Resolve transition IDs dynamically by name (“In Progress”, “In Review”), and verify capabilities (`/myself`, read issue, list transitions, add comment/worklog) before first use. Remember that Jira ticket keys already embed the project prefix (`ABC-123` ⇒ project key `ABC`, `TR-456` ⇒ project key `TR`). Perform a self-check at startup to confirm transitions map correctly and permissions allow commenting/worklogging. On closeout, ensure total time logged and final status are reported in Jira comments.
You are expected to strictly adhere to Jira API usage guidelines and not make any changes to the Jira UI. You are expected to send Jira API regularly to keep your work tracked.
The ENV vars mentioned above are already configured for you. 

Regarding time, we want actual duration between commits rounded to the minute and not an estimate of what it would have taken a human to complete the task. This means that you need to track your time spent working by starting a timer at your very first start of work and at your very last step before pushing your work check time elapsed so you know how long this task too you.

### Time tracking discipline (enforced for all agents)
- Start a real timer (e.g., `time.perf_counter()` in a scratch Python shell or a physical stopwatch) **before** you run any repo command. Record the start timestamp in your scratchpad so you can recompute elapsed wall time at any moment.
- Every time you make a commit, compute the actual minutes spent since the previous commit (or task start) and copy that exact rounded value into the `#time` smart-commit tag. Never reuse values from earlier worklogs or guess; always recompute from the timer.
- Pause the timer and subtract any time you are idle or waiting on unrelated tasks. The value you log must reflect focused, hands-on work on this ticket only.
- Maintain a small running log in your scratchpad (e.g., `notes/time_tracking.txt` in your workspace or your terminal notes) that lists timestamp checkpoints and the cumulative elapsed minutes. Use it to double-check that Jira worklogs and `#time` values reconcile before you finish.
- Before your final commit, add Jira worklog entries that sum to the same total minutes as your scratch timer. If you discover a mismatch, update the worklog to the correct value and mention the adjustment in your closing Jira comment.
- Prior to calling `make_pr`, re-read the time tracking log and confirm the total duration you plan to report matches the wall-clock elapsed time for the session (rounded to the nearest minute). If there is a discrepancy, correct the worklog and amend the commit message before proceeding.

### Imperative for when Frontend changes are made!!! Local dev backend + dashboard smoke checklist
Follow this playbook whenever you need an end-to-end dashboard demo on a dev workstation or if you have made any changes to the frontend then this becomes imperative. 
When you have made visual changes you must show visuals of the changes so that means running an actual browser client for snapshots after the steps below are run and a backend is running.

1. **Bootstrap the Python env**
   - `python -m venv .venv && source .venv/bin/activate`
   - `pip install --upgrade pip`
   - `pip install -r requirements-dev.txt`
   - Ensure `ffmpeg`, `alsa-utils`, and `sox` are installed on the host (`sudo apt install ffmpeg alsa-utils sox`).
2. **Point runtime paths at a writable sandbox**
   - `mkdir -p .dev_env/{config,recordings,tmp,dropbox}`
   - `cp config.yaml .dev_env/config/dev-config.yaml`
   - `export TRICORDER_CONFIG=$(pwd)/.dev_env/config/dev-config.yaml`
   - `export REC_DIR=$(pwd)/.dev_env/recordings`
   - `export TMP_DIR=$(pwd)/.dev_env/tmp`
   - `export DROPBOX_DIR=$(pwd)/.dev_env/dropbox`
   - `export TRICORDER_TMP=$TMP_DIR`
   - For machines without a physical microphone, load ALSA’s loopback module (`sudo modprobe snd-aloop`) and set `export AUDIO_DEV=hw:Loopback,1,0` so `arecord` has a live device.
3. **Launch the backend in dev mode**
   - `DEV=1 python main.py`
   - Wait for `[dev] Running live_stream_daemon` and confirm `http://localhost:8080/healthz` returns `ok`.
4. **Seed a sample clip for the dashboard list**
   - Run the snippet below in a separate shell after step 3 so the `/recordings` API has content:
     ```bash
     python - <<'PY'
     import json, os, time
     from pathlib import Path

     rec_root = Path(os.environ["REC_DIR"])
     day_dir = rec_root / time.strftime("%Y%m%d")
     day_dir.mkdir(parents=True, exist_ok=True)

     clip_path = day_dir / "dev-sample.opus"
     clip_path.write_bytes(b"OpusHead\x01dev-sample")

     waveform = clip_path.with_suffix(clip_path.suffix + ".waveform.json")
     payload = {
         "version": 1,
         "channels": 1,
         "sample_rate": 48000,
         "frame_count": 48000,
         "duration_seconds": 1.0,
         "peak_scale": 32767,
         "peaks": [0, 0],
         "rms_values": [0],
         "start_epoch": time.time() - 5,
         "started_epoch": time.time() - 5,
         "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
     }
     waveform.write_text(json.dumps(payload), encoding="utf-8")
     print(f"Seeded {clip_path.relative_to(rec_root)}")
     PY
     ```
   - Refresh `http://localhost:8080/dashboard` and confirm the “dev-sample” clip appears.
5. **Front-end regression checks**
   - With the backend still running, execute `pytest tests/test_25_web_streamer.py tests/test_37_web_dashboard.py` to cover the dashboard API + UI helpers.
   - Optionally run `curl http://localhost:8080/api/recordings?limit=5` to sanity-check the API payload that powers the clip list.

Before final commit with smart commit messages pushing:
1. Run tests (export DEV=1 && pytest -q). All tests must pass.
2. Empty Commit (Fallback)
If no files are changed and no doc is needed:
3. Push Workflow
At the end of the run, the orchestration system should reattach `origin` with credentials and push the `work` branch.  
    git commit --allow-empty -m "TR-52 Finalization #comment trigger pipeline #time 2m #transition In Review"

Pull request hygiene:
- PR titles must begin with the Jira key (e.g., `TR-123: Fix …`, `AUDIO-45: Update mixer`).
- Use the template sections: **What / Why**, **How (high-level)**, **Risk / Rollback**, **Human Testing Criteria**, **Links** (Jira issue, task run, preview URL).
- Keep commits small and logically grouped; document test coverage changes in `#comment`.

If you are reviewing another agent's PR:
- Always leave a short review comment summarizing what you did, test results, and risk assessment.
- If all tests pass and the PR is safe to merge, submit a formal GitHub PR review with “Approve” status (not just a 👍 reaction).
- If there are issues or risks, submit a “Comment” or “Request changes” review instead, explaining why.
- Reactions (👍) alone are not sufficient; every PR must have a visible comment and, when ready, a formal approval.

---

## Design & Architecture Impression (high-level guidance)
Tricorder is a moderately complex system where the complexity arises from its domain (real-time audio capture, concurrency, subprocess orchestration, and resource-constrained embedded deployment) rather than from ad-hoc structure. The project intentionally manages complexity by separating responsibilities into dedicated components (capture/segmenter, encoder, HLS tee, web streamer, ingest pipeline) and by using clear inter-process or inter-thread boundaries (queues, helper threads, subprocesses).

Contributors and automated agents should assume the codebase favors:
- explicit concurrency (threads + queues) and small, well-scoped modules rather than monolithic services;
- defensive error handling around IO and subprocesses (ffmpeg, ALSA, disk operations);
- proactive resource management to avoid memory or disk exhaustion on Pi Zero class hardware (tmpfs rotation, bounded queues, drop-oldest strategies);
- minimal, well-documented dependencies to keep deployments small and robust.

When modifying architecture or adding features, preserve these qualities: keep modules focused, prefer push-button diagnosticability, and avoid solutions that require heavy runtime resources unless gated by a config toggle and justified in `README.md`.

---

## Repository-wide guidelines
- Target Python **3.10** for compatibility with Raspberry Pi Zero 2 W; avoid language/runtime features that require newer interpreters.
- Keep dependencies lean. Prefer the standard library; document and justify any new third-party package in `README.md`, and update `requirements.txt` and `requirements-dev.txt`.
- Preserve existing logging approach (use `print(..., flush=True)` for critical runtime logs to keep `journalctl` ordering consistent). Helper log wrappers are OK if they do not hide boot logs.
- When modifying long-running daemons, ensure signal handling is clean and that subprocess pipes are closed. Mirror patterns in `lib/live_stream_daemon.py` and `lib/segmenter.py`.
- Update `README.md`, `config.yaml` (inline comments), and `updater.env-example` for any new tunables, services, or environment variables. Prefer tables/bulleted lists for discoverability.
- The web dashboard (`lib/web_streamer.py` and `lib/webui/`) is supported — document UI/API changes in `README.md` and keep waveform generation details current.

---

## Design & Implementation Rules (practical)
- Respect module boundaries. If you need to add functionality that crosses components, introduce small, explicit APIs rather than inlining cross-cutting logic.
- Avoid blocking the main capture loop. Offload CPU or IO heavy tasks to background threads/processes and communicate via bounded queues.
- Use idempotent operations for storage and external effects where possible; prefer write-then-rename semantics for recorded files.
- When adding subprocess usage (eg. `ffmpeg`), include robust respawn/cleanup logic and failure telemetry.
- Be conservative with memory and CPU: assume Pi Zero class constraints by default. Add performance or feature gates for heavier processing (e.g., RNNoise/noisereduce).

---

## Things to always think about when editing code
- Understand the module’s runtime context (daemon, web UI, encoding pipeline) before proposing or committing changes.
- Prioritize safety: prefer non-breaking, reversible edits, and create tests for behavior changes.
- Preserve resource constraints and signal handling semantics. Do *not* introduce background threads or long-running tasks without an opt-in config.
- When proposing refactors, produce small PRs with clear tests and a short risk assessment (what can go wrong, how to rollback).
- Prefer to add feature flags / config knobs for expensive options and document default behavior.

---

## Python code style
- Module constants: `UPPER_SNAKE_CASE`. Functions/variables: `snake_case`.
- Type hints welcome when consistent; avoid mixing hinted/unhinted signatures without reason.
- Avoid broad `except:` blocks. Always log exceptions and scope `try/except` narrowly.
- Add docstrings where behavior is non-obvious (audio math, buffer semantics, filesystem guarantees).

---

## Frontend assets (lib/webui)
- Static assets are vanilla ES modules + plain CSS to remain compatible with Chromium/Firefox on Raspberry Pi OS.
- When editing dashboard JS/HTML/CSS run the UI tests: `pytest tests/test_37_web_dashboard.py` and `pytest tests/test_25_web_streamer.py`.
- Prefer small, testable modules and lazy load heavyweight UI pieces (waveform renderers, HLS player). Avoid introducing build steps that prevent the one-file static deploy model unless you also update install scripts and README.
- Document any UI/API changes in `README.md`.

---

## Shell scripts and systemd units
- Start scripts with `#!/usr/bin/env bash` and `set -euo pipefail`.
- Keep scripts POSIX-friendly; avoid GNU-only flags unless already used in the repo. Document exceptions.
- When editing units, keep matching `.service`/`.timer` pairs and document variables in `config.yaml`.

---

## Testing and validation
- Run `export DEV=1; pytest -q` before submitting changes. If making a targeted change, run the specific module tests as well as the full suite.
- If changes affect installation/uninstallation, run `pytest tests/test_00_install.py` and/or `pytest tests/test_50_uninstall.py`.
- If touching shell scripts/systemd, prefer a dry run on a Raspberry Pi or document why that isn’t feasible.
- When adding features, add tests in `tests/` and document their intent in `README.md` and `tests/README.md`.
- New dependencies must be compatible with Ubuntu 24.04 LTS and Python 3.10.

---

## Documentation
- Keep `README.md` and `config.yaml` synchronized with code. Add release notes for behavior-changing edits.
- Document new configuration options inline in `config.yaml` and summarize them in `README.md`.
- When changing runtime behavior, update the architecture diagram and the “Operations” section in the README.

---

## Contribution workflow & PR guidance
- Small, focused PRs. Large architectural changes should be prefaced with an issue describing the proposed design, tradeoffs, and rollback plan.
- PRs must include:
  - a short description of the change,
  - a risk statement (how this impacts the recorder runtime),
  - test steps (local dev + Raspberry Pi when necessary),
  - updated docs for configs or runtime behavior.
- For high-risk changes (capture loop, encoding pipeline, HLS stream lifecycle), require at least one approval from a core maintainer and a successful run of the end-to-end audio test (if available).

---

## Appendix: Suggested developer mindset
- Be conservative: prefer clarity over cleverness when working on concurrency or IO code.
- Test in a hardware-like environment before shipping (Pi Zero 2 W or similar). [If you are an AI/LLM powered agent, this does not apply to you!]
- When adding heuristics (adaptive thresholding, VAD tuning), provide sane defaults, expose tunables, and document expected behavior and failure modes.
- When in doubt, open an issue describing the problem and a proposed minimal fix or experiment before changing production code. [If you are an AI/LLM powered agent, pause work and consult with the human who set you to task.]

---

End of file.
