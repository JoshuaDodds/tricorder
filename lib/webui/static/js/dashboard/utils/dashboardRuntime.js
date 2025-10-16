const registryRoot =
  typeof globalThis !== "undefined"
    ? globalThis
    : typeof window !== "undefined"
      ? window
      : {};

if (!registryRoot.__TRICORDER_COMPONENTS__) {
  registryRoot.__TRICORDER_COMPONENTS__ = {};
}

export const COMPONENTS_REGISTRY = registryRoot.__TRICORDER_COMPONENTS__;

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
