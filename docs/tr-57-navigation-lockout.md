# TR-57 navigation lockout bug report

## Summary
- Refreshing while a dropdown, modal, or other apply-confirming field is focused traps the UI in that element.
- Global keyboard shortcuts are not rebound after the re-render and remain unusable until the page is hard refreshed.
- Users lose the ability to exit the element gracefully, making navigation impossible without reloading the entire app.

## Steps to reproduce
1. Open the dashboard and focus an interactive widget that requires input (dropdown, expandable form, modal with **Apply** button, etc.).
2. Trigger a refresh or hot re-render (manually reload or wait for the automatic cycle).
3. Attempt to dismiss the element or interact with global keyboard shortcuts.

## Expected behaviour
- Focused controls should close, blur, or otherwise reset when the page is refreshed.
- Global shortcuts should be rebound automatically and remain available at all times.
- Users should always be able to recover with keyboard navigation (e.g., <kbd>Esc</kbd>) without performing a full page reload.

## Actual behaviour
- The element remains focused and cannot be dismissed through normal interactions.
- Application-level shortcuts are no longer active while the element is "stuck".
- The only recovery path is a full page refresh.

## Environment
- Browser: (fill in exact browser + version observed).
- OS: (fill in operating system).
- App version / commit: (fill in current release hash or semantic version).

## Impact and severity
High. This defect blocks end-to-end navigation flows and prevents power users from relying on keyboard shortcuts, forcing disruptive reloads during routine operations.

## Acceptance criteria for QA
- Dropdown → refresh: the element blurs automatically and <kbd>Esc</kbd> dismisses it after the reload.
- Modal with **Apply** button → refresh: modal closes or reopens in a neutral state and global shortcuts (e.g., `?`, `g` bindings) respond immediately.
- Expandable form field → auto-refresh: focus is released and the user can tab through the page without reloading.
- Regression sweep across other form components confirms no control traps focus or disables shortcuts after refresh.

## Follow-up notes
- Audit interactive components to ensure they tear down correctly on refresh and rebind the shortcut manager.
- Add automated smoke tests (if available) covering the scenarios above to prevent regressions.
