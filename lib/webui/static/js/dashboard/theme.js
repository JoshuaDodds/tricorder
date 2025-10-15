// Theme manager for the dashboard UI. Handles system preference detection,
// persistence, and toggle button label updates without leaking globals.
const VALID_THEMES = new Set(["dark", "light"]);

function readStoredTheme(storageKey) {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (typeof raw === "string") {
      const normalized = raw.trim().toLowerCase();
      if (VALID_THEMES.has(normalized)) {
        return normalized;
      }
    }
  } catch (error) {
    return null;
  }
  return null;
}

function writeStoredTheme(storageKey, theme) {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(storageKey, theme);
  } catch (error) {
    /* ignore storage errors */
  }
}

function ensureSystemThemeSubscription(state, handleChange) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    state.mediaQuery = null;
    state.mediaListener = null;
    return "dark";
  }
  if (state.mediaQuery && state.mediaListener) {
    return state.mediaQuery.matches ? "dark" : "light";
  }
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const listener = (event) => {
    handleChange(event);
  };
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", listener);
  } else if (typeof query.addListener === "function") {
    query.addListener(listener);
  }
  state.mediaQuery = query;
  state.mediaListener = listener;
  return query.matches ? "dark" : "light";
}

function updateThemeToggle(toggleElement, theme) {
  if (!toggleElement) {
    return;
  }
  const nextTheme = theme === "dark" ? "light" : "dark";
  const label = nextTheme === "light" ? "Switch to light theme" : "Switch to dark theme";
  toggleElement.textContent = label;
  toggleElement.setAttribute("aria-label", label);
  toggleElement.setAttribute("title", label);
  toggleElement.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
  toggleElement.dataset.currentTheme = theme;
}

function applyTheme(theme, state, toggleElement, defaultTheme) {
  const nextTheme = VALID_THEMES.has(theme) ? theme : defaultTheme;
  state.current = nextTheme;
  if (typeof document !== "undefined" && document.body) {
    document.body.setAttribute("data-theme", nextTheme);
  }
  updateThemeToggle(toggleElement, nextTheme);
}

function createThemeManager({ storageKey, toggleElement, defaultTheme = "dark" }) {
  const state = {
    current: defaultTheme,
    manual: false,
    mediaQuery: null,
    mediaListener: null,
  };

  function handleSystemThemeChange(event) {
    if (state.manual) {
      return;
    }
    applyTheme(event.matches ? "dark" : "light", state, toggleElement, defaultTheme);
  }

  function initialize() {
    const storedTheme = readStoredTheme(storageKey);
    if (storedTheme) {
      state.manual = true;
      applyTheme(storedTheme, state, toggleElement, defaultTheme);
      return;
    }
    state.manual = false;
    const systemTheme = ensureSystemThemeSubscription(state, handleSystemThemeChange);
    applyTheme(systemTheme, state, toggleElement, defaultTheme);
  }

  function toggle() {
    const nextTheme = state.current === "dark" ? "light" : "dark";
    state.manual = true;
    applyTheme(nextTheme, state, toggleElement, defaultTheme);
    writeStoredTheme(storageKey, nextTheme);
  }

  function setManual(enabled) {
    state.manual = Boolean(enabled);
  }

  return {
    initialize,
    toggle,
    applyTheme: (theme) => applyTheme(theme, state, toggleElement, defaultTheme),
    setManual,
    get currentTheme() {
      return state.current;
    },
  };
}

export { createThemeManager };
