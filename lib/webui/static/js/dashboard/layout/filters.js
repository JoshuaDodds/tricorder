import { FILTER_PANEL_STORAGE_KEY } from "../../config.js";

function readStoredPreference() {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return null;
    }
  } catch (error) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(FILTER_PANEL_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (typeof parsed.expanded === "boolean") {
      return parsed.expanded;
    }
    return null;
  } catch (error) {
    return null;
  }
}

function persistPreference(expanded) {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }
  } catch (error) {
    return;
  }
  try {
    window.localStorage.setItem(
      FILTER_PANEL_STORAGE_KEY,
      JSON.stringify({ expanded: Boolean(expanded) })
    );
  } catch (error) {
    /* ignore persistence errors */
  }
}

function defaultReducedMotionCheck() {
  return false;
}

function createFiltersLayoutManager(options) {
  const { dom, filtersLayoutQuery, prefersReducedMotion } = options;
  const state = {
    isMobile: false,
    expanded: true,
    userOverride: false,
  };
  const checkReducedMotion =
    typeof prefersReducedMotion === "function" ? prefersReducedMotion : defaultReducedMotionCheck;

  function restorePreference() {
    const stored = readStoredPreference();
    if (typeof stored !== "boolean") {
      return;
    }
    state.expanded = stored;
    state.userOverride = true;
    if (dom.filtersPanel) {
      dom.filtersPanel.dataset.state = stored ? "expanded" : "collapsed";
    }
  }

  function setExpanded(expanded, options = {}) {
    if (!dom.filtersPanel) {
      return;
    }
    const { fromUser = false, focusPanel = false } = options;
    state.expanded = expanded;
    if (!state.isMobile) {
      state.userOverride = false;
    } else if (fromUser) {
      state.userOverride = true;
    }
    if (fromUser) {
      persistPreference(expanded);
    }
    const stateValue = expanded ? "expanded" : "collapsed";
    dom.filtersPanel.dataset.state = stateValue;
    dom.filtersPanel.setAttribute("aria-hidden", expanded ? "false" : "true");
    if (dom.filtersToggle) {
      dom.filtersToggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    }
    if (!expanded || !state.isMobile || !focusPanel) {
      return;
    }
    window.requestAnimationFrame(() => {
      if (dom.filtersPanel) {
        const behavior = checkReducedMotion() ? "auto" : "smooth";
        try {
          dom.filtersPanel.scrollIntoView({ block: "start", behavior });
        } catch (error) {
          dom.filtersPanel.scrollIntoView({ block: "start" });
        }
      }
      if (dom.filterSearch && typeof dom.filterSearch.focus === "function") {
        try {
          dom.filterSearch.focus({ preventScroll: true });
        } catch (error) {
          dom.filterSearch.focus();
        }
      }
    });
  }

  function updateLayout() {
    const isMobile = Boolean(filtersLayoutQuery && filtersLayoutQuery.matches);
    const changed = state.isMobile !== isMobile;
    state.isMobile = isMobile;
    if (!dom.filtersPanel) {
      return;
    }
    if (!isMobile) {
      state.userOverride = false;
      setExpanded(true);
      return;
    }
    if (changed && !state.userOverride) {
      setExpanded(false);
      return;
    }
    if (!state.userOverride) {
      setExpanded(false);
    } else {
      setExpanded(state.expanded);
    }
  }

  function setupResponsiveFilters() {
    if (!dom.filtersPanel) {
      return;
    }
    const initialState = dom.filtersPanel.dataset.state === "collapsed" ? "collapsed" : "expanded";
    state.expanded = initialState !== "collapsed";
    updateLayout();
    if (filtersLayoutQuery) {
      const handleChange = () => {
        updateLayout();
      };
      if (typeof filtersLayoutQuery.addEventListener === "function") {
        filtersLayoutQuery.addEventListener("change", handleChange);
      } else if (typeof filtersLayoutQuery.addListener === "function") {
        filtersLayoutQuery.addListener(handleChange);
      }
    }
    if (dom.filtersToggle) {
      dom.filtersToggle.addEventListener("click", () => {
        if (!state.isMobile) {
          if (dom.filtersPanel) {
            const behavior = checkReducedMotion() ? "auto" : "smooth";
            try {
              dom.filtersPanel.scrollIntoView({ block: "start", behavior });
            } catch (error) {
              dom.filtersPanel.scrollIntoView({ block: "start" });
            }
          }
          if (dom.filterSearch && typeof dom.filterSearch.focus === "function") {
            window.requestAnimationFrame(() => {
              try {
                dom.filterSearch.focus({ preventScroll: true });
              } catch (error) {
                dom.filterSearch.focus();
              }
            });
          }
          return;
        }
        const next = !state.expanded;
        setExpanded(next, { fromUser: true, focusPanel: next });
      });
    }
    if (dom.filtersClose) {
      dom.filtersClose.addEventListener("click", () => {
        if (!state.isMobile) {
          return;
        }
        setExpanded(false, { fromUser: true });
        if (dom.filtersToggle && typeof dom.filtersToggle.focus === "function") {
          dom.filtersToggle.focus();
        }
      });
    }
  }

  return {
    state,
    restorePreference,
    setExpanded,
    updateLayout,
    setupResponsiveFilters,
  };
}

export { createFiltersLayoutManager };
