# Dashboard Refactor Step Tasks

This plan breaks the dashboard refactor proposal into six incremental engineering tasks sized for reviewable pull requests. Each task should target the shared integration branch and follow the `step-N` naming guidance provided in the proposal. All work must maintain compatibility with Raspberry Pi browsers (Chromium 116 and Firefox ESR 115) which reliably support ES2019 JavaScript, so avoid newer language features unless a build step transpiles them.

## Step 1 – Establish Baseline & Module Scaffolding
- **Branch / PR**: `step-1-baseline-scaffolding` (e.g., `TR-XXX-step-1-baseline-scaffolding`).
- **Goal**: Add `lib/webui/static/js/dashboard/bootstrap.js` that re-exports the existing dashboard bootstrap so behavior remains unchanged.
- **Deliverables**:
  - Create the new module and import the legacy bootstrap.
  - Add a smoke test (e.g., bundle hash snapshot or lightweight UI load) that locks current behavior.
  - Wire the new file without modifying `dashboard.js` internals.
- **Testing**: `pytest tests/test_25_web_streamer.py tests/test_37_web_dashboard.py`; manual `/dashboard` load check.
- **Risks**: Ensure the new module loads in Chromium/Firefox on Raspberry Pi OS; avoid introducing syntax beyond ES2019.

## Step 2 – Extract Configuration & Constants
- **Branch / PR**: `step-2-config-constants`.
- **Goal**: Move pure constants and formatting helpers into new modules consumed by both the bootstrap and legacy code.
- **Deliverables**:
  - Add `config.js` and `formatters.js` with side-effect-free exports.
  - Update imports in the bootstrap and existing dashboard code.
  - Provide unit coverage (e.g., pytest JS harness) ensuring outputs match legacy values.
- **Testing**: Baseline pytest command plus any new JS-focused tests.
- **Risks**: Guard against global mutations; maintain ES2019 compatibility for Raspberry Pi browsers.

## Step 3 – Introduce State Store Module
- **Branch / PR**: `step-3-state-store`.
- **Goal**: Centralize application state management in `state.js` with explicit update methods.
- **Deliverables**:
  - Extract state variables and mutators from `dashboard.js` into the new module.
  - Add adapter functions so the legacy UI keeps existing call signatures.
  - Document state transitions and events inline.
- **Testing**: Baseline pytest suite plus targeted JS state-transition tests.
- **Risks**: Maintain event ordering parity, especially for EventSource callbacks.

## Step 4 – Componentize UI Rendering
- **Branch / PR**: `step-4-components`.
- **Goal**: Split DOM rendering into modules under `lib/webui/static/js/dashboard/components/` and have the bootstrap orchestrate them.
- **Deliverables**:
  - Create component modules for clip list, filters, and playback panes.
  - Migrate template strings and event bindings incrementally.
  - Keep CSS selectors stable and untouched.
- **Testing**: Baseline pytest suite; manual UI smoke tests with seeded recordings.
- **Risks**: Event handler misbinding; ensure modules avoid syntax exceeding ES2019.

## Step 5 – Event & Network Layer Cleanup
- **Branch / PR**: `step-5-events-network`.
- **Goal**: Formalize API clients and EventSource handling in dedicated modules to improve error handling.
- **Deliverables**:
  - Add `api.js` and `events.js` with retry/backoff utilities gated by configuration.
  - Inject dependencies via the bootstrap when wiring components and state.
  - Increase logging and reconnection safeguards.
- **Testing**: Baseline pytest suite; manual SSE disconnect check.
- **Risks**: Connection stability; verify compatibility with constrained Raspberry Pi browsers.

## Step 6 – Final Integration & Cleanup
- **Branch / PR**: `step-6-integration-cleanup`.
- **Goal**: Remove the monolithic `dashboard.js` legacy paths once modules are in place.
- **Deliverables**:
  - Delete dead code, leaving only necessary exports.
  - Update README and docs to reflect the modular structure.
  - Add final integration tests covering the happy path.
- **Testing**: Full pytest run; manual dashboard smoke checklist; review browser console.
- **Risks**: Regression from deletions; confirm integration branch stability before mainline merge.

## Shared Requirements
- Follow the naming/branching guidance (`step-N` and integration branch targeting).
- Ensure every module stays within ES2019 syntax/features (no optional chaining, nullish coalescing, or top-level await) for Raspberry Pi Chromium 116 / Firefox ESR 115.
- Run `pytest tests/test_25_web_streamer.py tests/test_37_web_dashboard.py` for every step, alongside any new targeted tests.
- Document any deviations from these requirements directly in the relevant PR description.

