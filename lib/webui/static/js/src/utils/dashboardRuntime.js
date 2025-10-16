export const COMPONENTS_REGISTRY =
  (typeof globalThis !== "undefined" && globalThis.__TRICORDER_COMPONENTS__)
    ? globalThis.__TRICORDER_COMPONENTS__
    : {};

export function requireDashboardComponent(component, name) {
  if (typeof component !== "function") {
    throw new Error(`Dashboard component "${name}" is unavailable.`);
  }
  return component;
}

export function nowMilliseconds() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}
