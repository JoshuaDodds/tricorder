import { focusElementSilently } from "./focusUtils.js";

export function createAppMenuController({ dom }) {
  const state = {
    open: false,
    previouslyFocused: null,
    pointerHandler: null,
    keydownHandler: null,
  };

  function setAppMenuVisible(visible) {
    if (!dom.appMenu) {
      return;
    }
    dom.appMenu.dataset.open = visible ? "true" : "false";
    dom.appMenu.dataset.visible = visible ? "true" : "false";
    dom.appMenu.setAttribute("aria-hidden", visible ? "false" : "true");
    if (visible) {
      dom.appMenu.removeAttribute("hidden");
    } else {
      dom.appMenu.setAttribute("hidden", "hidden");
    }
  }

  function appMenuFocusableElements() {
    if (!dom.appMenu) {
      return [];
    }
    const selectors = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const nodes = dom.appMenu.querySelectorAll(selectors);
    return Array.from(nodes).filter(
      (node) => node instanceof HTMLElement && !node.hasAttribute("disabled"),
    );
  }

  function detachAppMenuHandlers() {
    if (state.pointerHandler) {
      document.removeEventListener("pointerdown", state.pointerHandler, true);
      state.pointerHandler = null;
    }
    if (state.keydownHandler) {
      document.removeEventListener("keydown", state.keydownHandler, true);
      state.keydownHandler = null;
    }
  }

  function closeAppMenu(options = {}) {
    if (!state.open) {
      return;
    }
    const { restoreFocus = true } = options;
    state.open = false;
    setAppMenuVisible(false);
    if (dom.appMenuToggle) {
      dom.appMenuToggle.setAttribute("aria-expanded", "false");
    }
    detachAppMenuHandlers();
    const previous = state.previouslyFocused;
    state.previouslyFocused = null;
    if (!restoreFocus) {
      return;
    }
    if (previous && typeof previous.focus === "function") {
      if (!focusElementSilently(previous)) {
        previous.focus();
      }
    } else if (dom.appMenuToggle && typeof dom.appMenuToggle.focus === "function") {
      dom.appMenuToggle.focus();
    }
  }

  function appMenuPointerHandler(event) {
    if (!state.open) {
      return;
    }
    const target = event.target;
    if (
      (dom.appMenuToggle && target instanceof Node && dom.appMenuToggle.contains(target)) ||
      (dom.appMenu && target instanceof Node && dom.appMenu.contains(target))
    ) {
      return;
    }
    closeAppMenu({ restoreFocus: false });
  }

  function appMenuKeydownHandler(event) {
    if (!state.open) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeAppMenu();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    const target = event.target;
    if (
      !dom.appMenu ||
      !(target instanceof Node) ||
      (!dom.appMenu.contains(target) && (!dom.appMenuToggle || target !== dom.appMenuToggle))
    ) {
      return;
    }
    const focusable = appMenuFocusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      closeAppMenu();
      return;
    }
    if (dom.appMenuToggle && target === dom.appMenuToggle) {
      event.preventDefault();
      const destination = event.shiftKey ? focusable[focusable.length - 1] : focusable[0];
      if (destination instanceof HTMLElement) {
        destination.focus();
      }
      return;
    }
    const [first] = focusable;
    const last = focusable[focusable.length - 1];
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (event.shiftKey) {
      if (!active) {
        event.preventDefault();
        last.focus();
      } else if (active === first) {
        event.preventDefault();
        if (dom.appMenuToggle && typeof dom.appMenuToggle.focus === "function") {
          dom.appMenuToggle.focus();
        } else {
          last.focus();
        }
      }
    } else if (!active || active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function attachAppMenuHandlers() {
    if (!state.pointerHandler) {
      state.pointerHandler = appMenuPointerHandler;
      document.addEventListener("pointerdown", state.pointerHandler, true);
    }
    if (!state.keydownHandler) {
      state.keydownHandler = appMenuKeydownHandler;
      document.addEventListener("keydown", state.keydownHandler, true);
    }
  }

  function focusFirstAppMenuItem() {
    const focusable = appMenuFocusableElements();
    if (focusable.length > 0) {
      focusable[0].focus();
    }
  }

  function openAppMenu() {
    if (!dom.appMenu || !dom.appMenuToggle) {
      return;
    }
    if (state.open) {
      focusFirstAppMenuItem();
      return;
    }
    state.open = true;
    state.previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dom.appMenuToggle.setAttribute("aria-expanded", "true");
    setAppMenuVisible(true);
    attachAppMenuHandlers();
    window.requestAnimationFrame(() => {
      focusFirstAppMenuItem();
    });
  }

  function toggleAppMenu() {
    if (state.open) {
      closeAppMenu();
    } else {
      openAppMenu();
    }
  }

  function isOpen() {
    return state.open;
  }

  return {
    openAppMenu,
    closeAppMenu,
    toggleAppMenu,
    isOpen,
  };
}
