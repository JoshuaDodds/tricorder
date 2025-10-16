export function createConfirmDialogController({ dom }) {
  const state = {
    open: false,
    resolve: null,
    previouslyFocused: null,
    globalKeydown: null,
  };

  function confirmDialogFocusableElements() {
    const focusable = [];
    if (dom.confirmConfirm instanceof HTMLElement && !dom.confirmConfirm.disabled) {
      focusable.push(dom.confirmConfirm);
    }
    if (dom.confirmCancel instanceof HTMLElement && !dom.confirmCancel.disabled) {
      focusable.push(dom.confirmCancel);
    }
    return focusable;
  }

  function setConfirmDialogVisibility(visible) {
    if (!dom.confirmModal) {
      return;
    }
    dom.confirmModal.dataset.visible = visible ? "true" : "false";
    dom.confirmModal.setAttribute("aria-hidden", visible ? "false" : "true");
    if (visible) {
      dom.confirmModal.removeAttribute("hidden");
    } else {
      dom.confirmModal.setAttribute("hidden", "hidden");
    }
  }

  function detachConfirmGlobalKeyHandlers() {
    if (!state.globalKeydown) {
      return;
    }
    document.removeEventListener("keydown", state.globalKeydown, true);
    state.globalKeydown = null;
  }

  function resolveConfirmDialog(result) {
    if (!state.open) {
      return;
    }
    state.open = false;
    detachConfirmGlobalKeyHandlers();
    const resolver = state.resolve;
    state.resolve = null;
    const previousFocus = state.previouslyFocused;
    state.previouslyFocused = null;
    setConfirmDialogVisibility(false);
    if (typeof resolver === "function") {
      resolver(result);
    }
    if (previousFocus && typeof previousFocus.focus === "function") {
      window.requestAnimationFrame(() => previousFocus.focus());
    }
  }

  function attachConfirmGlobalKeyHandlers() {
    if (state.globalKeydown) {
      return;
    }
    state.globalKeydown = (event) => {
      if (!state.open) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        resolveConfirmDialog(false);
        return;
      }
      if (event.key === "Enter") {
        if (event.target === dom.confirmCancel) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        resolveConfirmDialog(true);
      }
    };
    document.addEventListener("keydown", state.globalKeydown, true);
  }

  function showConfirmDialog({
    title = "Confirm",
    message = "",
    confirmText = "OK",
    cancelText = "Cancel",
  } = {}) {
    if (
      !dom.confirmModal ||
      !dom.confirmDialog ||
      !dom.confirmTitle ||
      !dom.confirmMessage ||
      !dom.confirmConfirm ||
      !dom.confirmCancel
    ) {
      if (typeof window !== "undefined" && typeof window.confirm === "function") {
        return Promise.resolve(window.confirm(message));
      }
      return Promise.resolve(false);
    }

    if (state.open) {
      return Promise.resolve(false);
    }

    dom.confirmTitle.textContent = title;
    dom.confirmMessage.textContent = message;
    dom.confirmConfirm.textContent = confirmText;
    dom.confirmCancel.textContent = cancelText;

    state.open = true;
    state.previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    setConfirmDialogVisibility(true);
    attachConfirmGlobalKeyHandlers();

    return new Promise((resolve) => {
      state.resolve = (result) => {
        resolve(result);
      };

      if (document.activeElement && typeof document.activeElement.blur === "function") {
        document.activeElement.blur();
      }

      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          if (dom.confirmDialog) {
            dom.confirmDialog.focus();
          }
          if (dom.confirmConfirm) {
            dom.confirmConfirm.focus();
          }
        });
      });
    });
  }

  function handleConfirmDialogKeydown(event) {
    if (!state.open) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      resolveConfirmDialog(false);
      return;
    }
    if (event.key === "Enter") {
      if (event.target === dom.confirmCancel) {
        return;
      }
      event.preventDefault();
      resolveConfirmDialog(true);
      return;
    }
    if (event.key === "Tab") {
      const focusable = confirmDialogFocusableElements();
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const activeElement =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      let index = focusable.indexOf(activeElement);
      if (index === -1) {
        index = 0;
      }
      if (event.shiftKey) {
        index = index <= 0 ? focusable.length - 1 : index - 1;
      } else {
        index = index >= focusable.length - 1 ? 0 : index + 1;
      }
      event.preventDefault();
      focusable[index].focus();
    }
  }

  function confirmDeletionPrompt(message, title = "Move recordings to recycle bin") {
    return showConfirmDialog({
      title,
      message,
      confirmText: "Move",
      cancelText: "Cancel",
    });
  }

  function confirmRecycleBinPurgePrompt(count) {
    const total = Number(count) || 0;
    const title = total === 1 ? "Delete recording permanently" : "Delete recordings permanently";
    const message =
      total === 1
        ? "Permanently delete the selected recording? This cannot be undone."
        : `Permanently delete ${total} selected recordings? This cannot be undone.`;
    return showConfirmDialog({
      title,
      message,
      confirmText: "Delete permanently",
      cancelText: "Cancel",
    });
  }

  function initialize() {
    if (dom.confirmConfirm) {
      dom.confirmConfirm.addEventListener("click", () => {
        resolveConfirmDialog(true);
      });
    }

    if (dom.confirmCancel) {
      dom.confirmCancel.addEventListener("click", () => {
        resolveConfirmDialog(false);
      });
    }

    if (dom.confirmModal) {
      dom.confirmModal.addEventListener("click", (event) => {
        if (event.target === dom.confirmModal) {
          resolveConfirmDialog(false);
        }
      });
      dom.confirmModal.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          resolveConfirmDialog(false);
          return;
        }

        if (event.target === dom.confirmModal) {
          resolveConfirmDialog(false);
          return;
        }

        handleConfirmDialogKeydown(event);
      });
    }
  }

  function isOpen() {
    return state.open;
  }

  return {
    showConfirmDialog,
    confirmDeletionPrompt,
    confirmRecycleBinPurgePrompt,
    initialize,
    isOpen,
  };
}
