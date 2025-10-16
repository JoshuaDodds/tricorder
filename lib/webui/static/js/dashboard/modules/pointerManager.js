export function createPointerInteractionManager({
  pointerIdleDelayMs,
  nowMilliseconds,
  onHoverStateCleared,
} = {}) {
  const hoveredInteractiveElements = new Set();
  let pointerIdleTimerId = null;
  let lastPointerActivityMs = 0;

  const INTERACTIVE_ROLE_NAMES = new Set([
    "button",
    "checkbox",
    "combobox",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "radio",
    "slider",
    "spinbutton",
    "switch",
    "tab",
    "textbox",
  ]);

  function getPointerIdleDelayMs() {
    return Number.isFinite(pointerIdleDelayMs) && pointerIdleDelayMs > 0
      ? pointerIdleDelayMs
      : 1000;
  }

  function getNowMilliseconds() {
    if (typeof nowMilliseconds === "function") {
      return nowMilliseconds();
    }
    return Date.now();
  }

  function notifyHoverCleared() {
    if (typeof onHoverStateCleared === "function") {
      try {
        onHoverStateCleared();
      } catch (error) {
        console.error("pointerManager:onHoverStateCleared failed", error);
      }
    }
  }

  function stopPointerIdleTimer() {
    if (pointerIdleTimerId === null) {
      return;
    }
    window.clearTimeout(pointerIdleTimerId);
    pointerIdleTimerId = null;
  }

  function clearHoveredInteractiveElements() {
    if (hoveredInteractiveElements.size === 0) {
      stopPointerIdleTimer();
      return;
    }
    hoveredInteractiveElements.clear();
    stopPointerIdleTimer();
    notifyHoverCleared();
  }

  function pruneHoveredInteractiveElements() {
    if (hoveredInteractiveElements.size === 0) {
      stopPointerIdleTimer();
      return;
    }
    let removed = false;
    for (const element of Array.from(hoveredInteractiveElements)) {
      if (!(element instanceof Element) || !element.isConnected) {
        hoveredInteractiveElements.delete(element);
        removed = true;
      }
    }
    if (hoveredInteractiveElements.size === 0) {
      stopPointerIdleTimer();
      if (removed) {
        notifyHoverCleared();
      }
    }
  }

  function handlePointerIdleTimeout() {
    pointerIdleTimerId = null;
    if (hoveredInteractiveElements.size === 0) {
      return;
    }
    const idleDuration = getNowMilliseconds() - lastPointerActivityMs;
    const delay = getPointerIdleDelayMs();
    if (idleDuration + 5 < delay) {
      const remaining = Math.max(delay - idleDuration, 0);
      pointerIdleTimerId = window.setTimeout(handlePointerIdleTimeout, remaining);
      return;
    }
    clearHoveredInteractiveElements();
  }

  function recordPointerActivity() {
    lastPointerActivityMs = getNowMilliseconds();
    if (hoveredInteractiveElements.size === 0) {
      stopPointerIdleTimer();
      return;
    }
    if (pointerIdleTimerId !== null) {
      window.clearTimeout(pointerIdleTimerId);
    }
    pointerIdleTimerId = window.setTimeout(
      handlePointerIdleTimeout,
      getPointerIdleDelayMs(),
    );
  }

  function isInteractiveFormField(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    if (element.isContentEditable) {
      return true;
    }

    const role = element.getAttribute("role");
    if (role && INTERACTIVE_ROLE_NAMES.has(role)) {
      return true;
    }

    const tagName = element.tagName;
    if (tagName === "AUDIO" || tagName === "VIDEO") {
      return true;
    }
    if (tagName === "TEXTAREA" || tagName === "SELECT") {
      return true;
    }
    if (tagName === "BUTTON") {
      return true;
    }

    if (tagName === "INPUT") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (type === "hidden") {
        return false;
      }
      return true;
    }

    return false;
  }

  function closestInteractiveFormField(element) {
    let current = element instanceof Element ? element : null;
    while (current) {
      if (isInteractiveFormField(current)) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  function findInteractiveElement(target, event = null) {
    const candidate = closestInteractiveFormField(target);
    if (candidate) {
      return candidate;
    }
    if (event && typeof event.composedPath === "function") {
      const path = event.composedPath();
      for (const node of path) {
        if (node instanceof HTMLElement && isInteractiveFormField(node)) {
          return node;
        }
      }
    }
    return null;
  }

  function escapeSelector(value) {
    const text = String(value);
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(text);
    }
    return text.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
  }

  function hasHoveredInteractiveElements() {
    return hoveredInteractiveElements.size > 0;
  }

  return {
    hoveredInteractiveElements,
    stopPointerIdleTimer,
    clearHoveredInteractiveElements,
    pruneHoveredInteractiveElements,
    recordPointerActivity,
    findInteractiveElement,
    escapeSelector,
    hasHoveredInteractiveElements,
  };
}
