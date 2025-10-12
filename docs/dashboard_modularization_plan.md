# Dashboard Modularization Plan of Action

## Context
- The current dashboard client lives in `lib/webui/static/js/dashboard.js` (~9000 LOC) and blends API clients, state management, DOM rendering, and playback logic in a single module.
- The monolith complicates onboarding, testing, and targeted fixes; code review and regression risk increase as unrelated changes share the same file.
- Existing automated coverage lives in `tests/test_25_web_streamer.py` and `tests/test_37_web_dashboard.py`, which exercise API helpers and selected UI behaviors through Python-side harnesses.

## Objectives
1. Split the dashboard into cohesive ES modules grouped by responsibility (data services, state, view components, utilities).
2. Preserve backwards-compatible behavior for API consumers and templates while enabling incremental rollout.
3. Improve testability by aligning modules with unit- and integration-test seams.
4. Document the new structure so maintainers can locate functionality quickly.

## Current Pain Points
- **Mixed Concerns:** network fetches, WebSocket/EventSource logic, rendering, and feature toggles are interwoven, making it hard to reason about side effects.
- **Implicit Globals:** many helpers rely on shared mutable state with no clear ownership, complicating dependency injection for tests.
- **Limited Test Hooks:** UI logic lacks granular exports, forcing large fixture setups.
- **Deployment Constraints:** Dashboard must remain a static bundle served without a build step; any modularization must keep compatibility with ES module loading on Chromium/Firefox for Raspberry Pi OS.

## Proposed Target Architecture
- `dashboard/boot.js`: entry point referenced by the template; imports the modules below and wires them together.
- `dashboard/config.js`: normalizes environment-derived settings (API base, feature flags) and exports constants.
- `dashboard/services/api.js`: fetch/event-stream helpers for recordings, motion, health; encapsulates retry/backoff.
- `dashboard/state/store.js`: central reactive state container (plain objects + event emitters) with scoped setters/getters.
- `dashboard/components/`: small view/controller modules (e.g., clip list, waveform viewer, live monitor, motion timeline).
- `dashboard/utils/`: shared helpers (time formatting, DOM utilities, sanitizer, error reporting).
- `dashboard/testing/fixtures.js`: exports deterministic fakes for state/services used by Jest/pytest harnesses.

## Phased Refactor Plan
1. **Discovery (This ticket)**
   - Inventory major functional regions inside `dashboard.js` (data fetching, UI binding, playback, layout).
   - Map dependencies between sections and annotate high-risk areas (e.g., recording playback, live stream events).
   - Identify existing template/HTML hooks and confirm they can import ES modules without bundling.
   - Produce this plan plus suggested module boundaries and migration steps.

2. **Enable ES Module Structure**
   - Confirm `templates/dashboard.html` (or equivalent) can reference `type="module"` scripts.
   - Introduce new directory `lib/webui/static/js/dashboard/` with placeholder modules exporting existing helpers.
   - Add lint/test scaffolding if needed (e.g., `npm` independent? ensure no bundler requirement).

3. **Extract Pure Utilities**
   - Move standalone helper functions (formatting, normalizers) into `utils/` modules.
   - Update references via named imports; ensure exports remain accessible for tests.
   - Run `pytest tests/test_25_web_streamer.py tests/test_37_web_dashboard.py` to validate behavior.

4. **Isolate API Services**
   - Wrap fetch/EventSource logic into `services/api.js`, returning promises/observables.
   - Provide thin adapter used by existing event handlers to reduce coupling.
   - Introduce integration tests covering reconnection/backoff to catch regressions.

5. **Introduce State Store**
   - Define a `createDashboardStore()` that encapsulates shared state and exposes subscribe/update methods.
   - Replace implicit globals with store usage; update components to listen for state changes.
   - Add unit tests for store transitions (recording selection, playback status).

6. **Componentize UI Regions**
   - Extract DOM-manipulating sections into modules receiving dependencies (store, services, config).
   - Each component owns its DOM query/initialization and registers event handlers.
   - Document initialization order in `boot.js` to keep startup deterministic.

7. **Cleanup and Documentation**
   - Remove deprecated code paths left in the monolith after migration.
   - Update README and `docs/` with architecture diagram reflecting new module tree.
   - Provide migration guide for downstream deployments referencing old globals.

## Risk Mitigation
- **Incremental commits:** keep each extraction small, with targeted tests, to reduce regression risk.
- **Feature flags:** gate new components behind config toggles if needed for gradual rollout.
- **Performance monitoring:** ensure modularization does not increase bundle size or initialization latency beyond Pi Zero 2 W limits.
- **Fallback plan:** maintain a temporary compatibility layer exporting legacy globals until downstream templates adapt.

## Testing Strategy
- Continue running `pytest tests/test_25_web_streamer.py tests/test_37_web_dashboard.py` for dashboard coverage.
- Add browser-based smoke tests (Playwright or Selenium) targeting critical workflows (clip playback, live monitor, motion view).
- Incorporate linting/formatting (e.g., `eslint` with no-build configuration) to keep modules consistent.

## Definition of Done
- Dashboard JavaScript split into logical modules with clear responsibilities.
- Updated documentation describing module layout and extension guidelines.
- Automated tests cover critical behaviors with module-level granularity.
- Team alignment on rollout plan, with risk assessment and rollback steps captured in docs/README.
