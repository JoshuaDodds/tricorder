# TR-151 Step Plan: Dashboard Refactor Sequencing

This document translates the TR-150 dashboard refactor proposal into a set of reviewable, sequential implementation steps. Each step is scoped to keep risk low, enable incremental testing, and support merging into an integration branch using `-step-n-` naming for both tasks and PRs.

## Naming & Branching Guidance

* **Branch naming**: `TR-151-step-N-short-slug` (for example `TR-151-step-1-state-store`).
* **PR titles**: `TR-151-step-N: <short summary>`.
* **Integration target**: point every PR at the shared integration branch the team prepares for this refactor.
* **Testing baseline**: every step runs `pytest tests/test_25_web_streamer.py tests/test_37_web_dashboard.py` plus any new targeted tests before requesting review.

## Step Breakdown

### Step 1 – Establish Baseline & Module Scaffolding
* **Goal**: carve out an entry-point module that imports the existing monolith and exposes a thin bootstrap API without altering runtime behavior.
* **Scope**:
  * Introduce `lib/webui/static/js/dashboard/bootstrap.js` that currently just re-exports the legacy boot function.
  * Add automated smoke test(s) or snapshot of current bundle hash to lock the behavior.
  * No refactors inside `dashboard.js` yet, only wiring.
* **Risks**: minimal; verify new file loads correctly on all browsers.
* **Testing**: dashboard/web streamer pytest targets, manual load of `/dashboard`.

### Step 2 – Extract Configuration & Constants
* **Goal**: move pure constants/utility helpers (API base, feature flags, formatting helpers) into dedicated ES modules consumed by both legacy and new code.
* **Scope**:
  * Create `config.js` and `formatters.js` modules.
  * Replace direct references in the bootstrap and monolith with imports.
  * Maintain side-effect free exports; avoid UI mutations.
* **Risks**: regressions if globals mutate; rely on unit helpers to assert identical outputs.
* **Testing**: pytest targets, add focused Jest-style unit tests via `pytest`-driven JS harness if available (or add minimal QUnit-style harness under `tests/webui`).

### Step 3 – Introduce State Store Module
* **Goal**: isolate application state (recording list, filters, playback selection) into `state.js` with explicit update methods.
* **Scope**:
  * Extract existing state variables and update functions from `dashboard.js` into the new module.
  * Provide a thin adapter in the legacy file so UI code still calls through the same signatures.
  * Document state transitions and events.
* **Risks**: race conditions around EventSource callbacks; ensure locking semantics remain identical.
* **Testing**: pytest suite, add targeted JS unit tests for state transitions.

### Step 4 – Componentize UI Rendering
* **Goal**: split the DOM rendering logic into small modules (e.g., clip list, filters, playback pane) imported by the bootstrap.
* **Scope**:
  * Create modules under `lib/webui/static/js/dashboard/components/` for each major UI pane.
  * Migrate DOM template strings & event bindings gradually, leaving the bootstrap orchestrating.
  * Keep CSS untouched; ensure selectors remain stable.
* **Risks**: event handler misbinding; use integration tests or smoke tests with seeded recordings.
* **Testing**: pytest suite, manual UI click-through.

### Step 5 – Event & Network Layer Cleanup
* **Goal**: formalize API clients and EventSource handling in separate modules to simplify error handling and reconnection logic.
* **Scope**:
  * Extract fetch wrappers and SSE subscription logic into `api.js` and `events.js` modules.
  * Introduce retry/backoff utilities where appropriate, gated by config.
  * Ensure bootstrap wires modules through dependency injection to components/state.
* **Risks**: connection drops; add logging and fallbacks.
* **Testing**: pytest suite, manual SSE disconnect test (kill backend, observe reconnection).

### Step 6 – Final Integration & Cleanup
* **Goal**: remove legacy monolith file, finalize module boundaries, and update documentation.
* **Scope**:
  * Delete residual dead code from `dashboard.js`, leaving only module exports.
  * Update `README.md` and developer docs to describe module structure.
  * Add final integration tests covering happy path flow.
* **Risks**: regression due to file deletions; ensure integration branch is stable before merging to main.
* **Testing**: full `pytest` run, manual dashboard smoke checklist, review of browser console logs.

## Risk Management

* Work behind the integration branch, rebasing frequently to avoid diverging from production.
* Keep each step reviewable (<500 LOC moves where possible) and land follow-up fixes in dedicated `-step-N-` tasks.
* Document new modules inline with docstrings/comments to ease onboarding.

## Open Questions / Follow-ups

1. Should we introduce a lightweight JS test harness (e.g., uvu) to cover modules locally? Step 1 can explore options.
2. Confirm whether bundling is permissible or if we must remain plain ES modules; if bundling is needed, insert it before Step 4.
3. Determine compatibility requirements for Raspberry Pi browsers to ensure new module usage stays ES2019-compatible.

