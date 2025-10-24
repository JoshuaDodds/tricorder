function requireFunction(fn, name) {
  if (typeof fn !== "function") {
    throw new Error(`${name} must be a function.`);
  }
  return fn;
}

function requireDom(dom, property) {
  if (!dom || typeof dom !== "object") {
    throw new Error("Rename dialog controller requires dashboard DOM references.");
  }
  const value = dom[property];
  if (!value) {
    return null;
  }
  return value;
}

export function createRenameDialogController(options = {}) {
  const { dom, state, renameRecording, updateSelectionUI } = options;

  if (!dom) {
    throw new Error("Rename dialog controller requires dashboard DOM references.");
  }
  if (!state) {
    throw new Error("Rename dialog controller requires dashboard state references.");
  }

  const performRename = requireFunction(renameRecording, "renameRecording");
  const refreshSelection = requireFunction(updateSelectionUI, "updateSelectionUI");

  const renameDialogState = {
    open: false,
    target: null,
    pending: false,
    previouslyFocused: null,
  };

  function isDialogElementAvailable() {
    return (
      requireDom(dom, "renameModal") &&
      requireDom(dom, "renameDialog") &&
      requireDom(dom, "renameForm") &&
      requireDom(dom, "renameInput") &&
      requireDom(dom, "renameConfirm") &&
      requireDom(dom, "renameCancel")
    );
  }

  function setRenameModalVisible(visible) {
    const modal = requireDom(dom, "renameModal");
    if (!modal) {
      return;
    }
    if (visible) {
      modal.hidden = false;
      modal.dataset.visible = "true";
      modal.setAttribute("aria-hidden", "false");
    } else {
      modal.dataset.visible = "false";
      modal.setAttribute("aria-hidden", "true");
      modal.hidden = true;
    }
  }

  function setRenameDialogError(message) {
    const errorTarget = requireDom(dom, "renameError");
    if (!errorTarget) {
      return;
    }
    if (typeof message === "string" && message) {
      errorTarget.textContent = message;
      errorTarget.hidden = false;
    } else {
      errorTarget.textContent = "";
      errorTarget.hidden = true;
    }
  }

  function setRenameDialogPending(pending) {
    renameDialogState.pending = Boolean(pending);
    const confirmButton = requireDom(dom, "renameConfirm");
    const inputField = requireDom(dom, "renameInput");
    const cancelButton = requireDom(dom, "renameCancel");
    if (confirmButton) {
      confirmButton.disabled = pending === true;
    }
    if (inputField) {
      inputField.disabled = pending === true;
    }
    if (cancelButton) {
      cancelButton.disabled = pending === true;
    }
    refreshSelection();
    const renameButton = requireDom(dom, "renameSelected");
    if (renameButton) {
      renameButton.disabled = pending === true;
    }
  }

  function closeRenameDialog() {
    if (!renameDialogState.open) {
      return;
    }
    renameDialogState.open = false;
    const previous = renameDialogState.previouslyFocused;
    renameDialogState.previouslyFocused = null;
    renameDialogState.target = null;
    setRenameDialogPending(false);
    setRenameDialogError("");
    setRenameModalVisible(false);
    if (previous && typeof previous.focus === "function") {
      if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(() => {
          previous.focus();
        });
      } else {
        previous.focus();
      }
    }
  }

  function renameDialogFocusableElements() {
    const dialog = requireDom(dom, "renameDialog");
    if (!dialog) {
      return [];
    }
    const nodes = dialog.querySelectorAll('button:not([disabled]), input:not([disabled])');
    return Array.from(nodes).filter((element) => element instanceof HTMLElement);
  }

  function fallbackPromptRename(record) {
    if (
      !record ||
      typeof record.path !== "string" ||
      typeof window === "undefined" ||
      typeof window.prompt !== "function"
    ) {
      return;
    }
    const promptValue = window.prompt(
      "Enter a new name for the recording",
      typeof record.name === "string" && record.name ? record.name : record.path,
    );
    const trimmed = promptValue ? promptValue.trim() : "";
    if (!trimmed) {
      return;
    }
    const extensionValue =
      typeof record.extension === "string" && record.extension ? record.extension : "";
    const hasSuffix = trimmed.includes(".");
    const options = {};
    if (!hasSuffix && extensionValue) {
      options.extension = extensionValue;
    }
    void performRename(record.path, trimmed, options);
  }

  function openRenameDialog(record) {
    if (!isDialogElementAvailable()) {
      fallbackPromptRename(record);
      return;
    }

    renameDialogState.open = true;
    renameDialogState.target = record || null;
    renameDialogState.previouslyFocused =
      typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setRenameDialogPending(false);
    setRenameDialogError("");

    const inputField = requireDom(dom, "renameInput");
    if (record && typeof record.name === "string") {
      inputField.value = record.name;
    } else if (record && typeof record.path === "string") {
      const parts = record.path.split("/");
      inputField.value = parts.length ? parts[parts.length - 1] : record.path;
    } else {
      inputField.value = "";
    }
    inputField.dataset.extension =
      record && typeof record.extension === "string" ? record.extension : "";

    setRenameModalVisible(true);

    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const dialog = requireDom(dom, "renameDialog");
          const field = requireDom(dom, "renameInput");
          if (dialog && typeof dialog.focus === "function") {
            dialog.focus();
          }
          if (field && typeof field.focus === "function") {
            field.focus();
            if (typeof field.select === "function") {
              field.select();
            }
          }
        });
      });
    }
  }

  async function handleRenameSubmit(event) {
    event.preventDefault();
    if (!renameDialogState.open || renameDialogState.pending) {
      return;
    }
    const inputField = requireDom(dom, "renameInput");
    if (!inputField) {
      return;
    }
    const value = inputField.value.trim();
    if (!value) {
      setRenameDialogError("Enter a new name.");
      return;
    }
    const target = renameDialogState.target;
    if (!target || typeof target.path !== "string") {
      setRenameDialogError("Unable to rename this recording.");
      return;
    }

    const hasSuffix = value.includes(".");
    const extensionValue = inputField.dataset.extension || target.extension || "";
    const options = {};
    if (!hasSuffix && extensionValue) {
      options.extension = extensionValue;
    }

    setRenameDialogPending(true);
    try {
      await performRename(target.path, value, options);
      closeRenameDialog();
    } catch (error) {
      console.error("Rename request failed", error);
      const message =
        error instanceof Error && error.message
          ? error.message
          : "Unable to rename recording.";
      setRenameDialogError(message);
      setRenameDialogPending(false);
    }
  }

  function handleRenameCancel() {
    if (!renameDialogState.pending) {
      closeRenameDialog();
    }
  }

  function handleRenameModalClick(event) {
    const modal = requireDom(dom, "renameModal");
    if (!modal) {
      return;
    }
    if (!renameDialogState.pending && event.target === modal) {
      closeRenameDialog();
    }
  }

  function handleRenameModalKeydown(event) {
    if (!renameDialogState.open) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (!renameDialogState.pending) {
        closeRenameDialog();
      }
      return;
    }
    if (event.key === "Tab") {
      const focusable = renameDialogFocusableElements();
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const active =
        typeof document !== "undefined" && document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      let index = focusable.indexOf(active);
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

  const form = requireDom(dom, "renameForm");
  if (form) {
    form.addEventListener("submit", handleRenameSubmit);
  }

  const cancelButton = requireDom(dom, "renameCancel");
  if (cancelButton) {
    cancelButton.addEventListener("click", handleRenameCancel);
  }

  const modal = requireDom(dom, "renameModal");
  if (modal) {
    modal.addEventListener("click", handleRenameModalClick);
    modal.addEventListener("keydown", handleRenameModalKeydown);
  }

  return {
    openRenameDialog,
    closeRenameDialog,
    isPending: () => renameDialogState.pending,
  };
}

export default createRenameDialogController;
