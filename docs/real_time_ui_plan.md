# Real-time UI Refresh Strategy

## Context
- The current dashboard relies on aggressive polling to discover changes in recorder state.
- Polling blocks or delays user interactions because refreshes race with user-initiated actions, forcing workarounds in the UI layer.
- We need a responsive, low-latency experience that keeps widgets up to date without blocking the main thread or losing user intent.

## Goals
1. Decouple user input handling from background data refreshes so the UI never freezes while state sync happens.
2. Deliver near-real-time updates for specific components (recorder status, ingest jobs, alerts) without refreshing the entire page.
3. Preserve our lightweight deployment story (static assets + simple Python backend) and avoid large new dependencies.
4. Provide a migration plan that lets us keep polling as a fallback for legacy browsers or incremental rollout.

## Observations and Constraints
- The backend already emits meaningful state transitions (segmenter events, ingest results, room tuner status) that polling scrapes from REST endpoints.
- The Raspberry Pi deployment favors single-process services and low CPU overhead; introducing heavyweight asynchronous stacks should be avoided.
- Browser clients run on Chromium/Firefox; both support Server-Sent Events (SSE) and WebSockets.
- Multi-user coordination is limited; the UI primarily serves a single operator per device, so we can focus on broadcast updates.

## Option Analysis

### Keep Polling but Rate Limit / Diff
- **Pros:** No protocol changes, zero backend work beyond smarter throttling.
- **Cons:** Still couples user actions with refresh cadence, difficult to guarantee the UI is fresh, wastes bandwidth/CPU.
- **Verdict:** Insufficient — addresses symptoms but not root cause.

### Long-Polling / Conditional Requests
- **Pros:** Slightly reduces chatter, easy to bolt onto existing endpoints.
- **Cons:** Still ties up HTTP connections and complicates concurrency limits on constrained hardware; user actions can still collide with refresh cycles.
- **Verdict:** Marginal win; complexity similar to better alternatives without their benefits.

### WebSockets Event Bus
- **Pros:** Full duplex; can support future interactive controls (live log streaming, remote commands). Efficient for frequent updates.
- **Cons:** Requires dedicated event loop or third-party lib, more complex handshake/keepalive logic, higher maintenance overhead for reconnect/backoff.
- **Verdict:** Powerful but heavier than needed for one-way status pushes today. Worth considering if two-way control is on the roadmap.

### Server-Sent Events (SSE)
- **Pros:** Simple HTTP response stream; easy to implement with standard library (`wsgiref` or `BaseHTTPRequestHandler`) + thread. Native support in browsers via `EventSource`. Naturally one-way, matching our current needs.
- **Cons:** No binary frames; reconnect/backoff logic handled by browser but needs retry-safe server code. Not ideal if we later require bi-directional messaging (though we can layer POST endpoints for control events).
- **Verdict:** Best balance for near-term goal — minimal dependency footprint, straightforward to bolt onto existing web streamer, push-only semantics align with requirement.

## Recommendation
Adopt an SSE-based push channel that streams granular state updates to the dashboard. Keep REST endpoints for manual fetches and as a fallback. Encapsulate updates as small JSON payloads keyed by component so the UI can surgically update only the affected widgets.

## High-Level Architecture
1. **Backend Event Publisher**
   - Introduce an in-process `EventBus` abstraction that components (segmenter, ingest pipeline, tuner) can post structured events to.
   - Maintain a bounded queue per SSE client with drop-oldest semantics to prevent slow consumers from stalling producers.
   - Serialize events as JSON objects with `type`, `payload`, and `timestamp` fields.

2. **SSE Endpoint**
   - Extend `lib/web_streamer.py` to expose `/events` that holds an HTTP connection open and streams `event: <type>\ndata: <json>\n\n` frames.
   - Reuse existing auth/session checks. Add heartbeat comment frames every ~20s to keep proxies alive.
   - Implement reconnection tokens (last-event-id) so clients can resume missed events.

3. **Frontend Event Layer**
   - Add a lightweight event router (e.g., module-level singleton) that consumes `EventSource` messages and dispatches them to subscribed components.
   - Refactor widgets currently relying on polling to update their internal state when relevant events arrive. Preserve manual refresh button as a fallback.
   - Handle connection lifecycle: exponential backoff on errors, switch to polling if SSE fails after N attempts.

4. **Fallback and Telemetry**
   - Keep existing polling endpoints but reduce their frequency once SSE is confirmed stable.
   - Emit basic metrics/logs when SSE reconnects or drops to aid debugging.

## Implementation Plan
1. **Design Event Contracts**
   - Inventory state changes that need pushes (recorder status, active job progress, health alerts) and define schema for each.
   - Document payload formats in `docs/api.md` (new or existing).

2. **Backend Infrastructure**
   - Implement the in-process publisher and wire initial producers (recorder state tracker, ingest pipeline).
   - Add `/events` SSE endpoint and integrate authentication + heartbeat.
   - Unit test producer/consumer flow with mocked slow clients.

3. **Frontend Integration**
   - Add `eventSource.js` helper to manage connection + dispatch.
   - Update affected components to subscribe/unsubscribe cleanly, ensuring UI remains responsive during reconnects.
   - Provide feature flag or config toggle so we can enable SSE gradually.

4. **Fallback + Documentation**
   - Retain polling as fallback but gate it behind SSE availability detection.
   - Update `README.md` and operator docs describing the new live updates and configuration.
   - Add monitoring hooks/log messages so field units can troubleshoot connectivity.

5. **Validation**
   - Manual tests: simulate backend updates, verify UI components update instantly without blocking inputs.
   - Automated tests: extend dashboard test suite with SSE mocks to ensure front-end handlers process events correctly.

## Current implementation snapshot

- `lib.dashboard_events.DashboardEventBus` and the `/api/events` SSE endpoint in `lib/web_streamer.py` now supply the live update channel described above.
- `lib/webui/static/js/dashboard.js` is segmented into helper utilities, state containers, and feature controllers (recordings list, waveform/transport, configuration modals, services panel) so each module stays testable in isolation.
- The Node sandbox (`tests/helpers/dashboard_node_env.js`) plus integration coverage in `tests/test_37_web_dashboard.py::test_dashboard_happy_path_serves_recording` exercise the “load dashboard → fetch recordings → download assets” happy path without launching a browser.

## Risks and Mitigations
- **Slow Clients:** Use per-client queues with size caps; log and drop oldest events when necessary.
- **Connection Limits:** SSE uses a single HTTP connection per client; ensure server thread pool can handle expected concurrency (likely small).
- **Browser Compatibility:** Chromium/Firefox supported; document fallback to polling if SSE unsupported.
- **Future Bi-Directional Needs:** If remote control becomes necessary, we can either upgrade to WebSockets or pair SSE with targeted POST endpoints; design EventBus with abstraction to ease migration.

## Open Questions
- Which specific dashboard widgets require live updates first? (Prioritize recorder status + ingest progress.)
- Are there backend components currently unaware of state changes (e.g., offline detection) that need to emit events?
- Do we require authentication tokens for SSE beyond existing session cookies? (Clarify security model.)

## Definition of Done (for follow-up implementation story)
- SSE endpoint deployed, documented, and guarded by tests.
- UI receives pushed updates and user interactions (button clicks, modal forms) are never blocked by background refreshes.
- Polling downgraded to fallback mode with configurable interval.
- Documentation and monitoring updated to reflect new push channel.
