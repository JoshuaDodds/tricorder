export function createArchivalSettingsController({
  dom,
  apiClient,
  lockDocumentScroll,
  unlockDocumentScroll,
  parseBoolean,
  parseListInput,
  closeAppMenu,
  archivalEndpoint,
  archivalBackends,
  extractErrorMessage,
}) {
  const state = {
    current: null,
    lastAppliedFingerprint: "",
    dirty: false,
    saving: false,
    loading: false,
    loaded: false,
    pendingSnapshot: null,
    hasExternalUpdate: false,
    configPath: "",
    statusTimeoutId: null,
    fetchInFlight: false,
    fetchQueued: false,
  };

  const dialogState = {
    open: false,
    previouslyFocused: null,
    keydownHandler: null,
  };

  function archivalDefaults() {
    return {
      enabled: false,
      backend: "network_share",
      include_waveform_sidecars: false,
      network_share: { target_dir: "" },
      rsync: {
        destination: "",
        ssh_identity: "",
        options: ["-az"],
        ssh_options: [],
      },
    };
  }

  function canonicalArchivalSettings(settings) {
    const defaults = archivalDefaults();
    if (!settings || typeof settings !== "object") {
      return defaults;
    }

    const canonical = {
      enabled: parseBoolean(settings.enabled),
      backend: defaults.backend,
      include_waveform_sidecars: parseBoolean(settings.include_waveform_sidecars),
      network_share: { target_dir: "" },
      rsync: {
        destination: "",
        ssh_identity: "",
        options: [],
        ssh_options: [],
      },
    };

    const backendValue = typeof settings.backend === "string" ? settings.backend.trim() : "";
    if (archivalBackends.has(backendValue)) {
      canonical.backend = backendValue;
    }

    const networkShare =
      settings.network_share && typeof settings.network_share === "object"
        ? settings.network_share
        : {};
    if (typeof networkShare.target_dir === "string") {
      canonical.network_share.target_dir = networkShare.target_dir.trim();
    }

    const rsync = settings.rsync && typeof settings.rsync === "object" ? settings.rsync : {};
    if (typeof rsync.destination === "string") {
      canonical.rsync.destination = rsync.destination.trim();
    }
    if (typeof rsync.ssh_identity === "string") {
      canonical.rsync.ssh_identity = rsync.ssh_identity.trim();
    }

    if (Array.isArray(rsync.options)) {
      canonical.rsync.options = rsync.options
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter((item) => item);
    } else if (typeof rsync.options === "string") {
      canonical.rsync.options = parseListInput(rsync.options);
    } else if (rsync.options == null) {
      canonical.rsync.options = defaults.rsync.options.slice();
    }

    if (Array.isArray(rsync.ssh_options)) {
      canonical.rsync.ssh_options = rsync.ssh_options
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter((item) => item);
    } else if (typeof rsync.ssh_options === "string") {
      canonical.rsync.ssh_options = parseListInput(rsync.ssh_options);
    }

    if (canonical.rsync.options.length === 0 && rsync.options == null) {
      canonical.rsync.options = defaults.rsync.options.slice();
    }

    return canonical;
  }

  function computeArchivalFingerprint(settings) {
    return JSON.stringify(canonicalArchivalSettings(settings));
  }

  function normalizeArchivalResponse(payload) {
    const settings =
      payload && typeof payload === "object"
        ? canonicalArchivalSettings(payload.archival)
        : archivalDefaults();
    const configPath =
      payload && typeof payload === "object" && typeof payload.config_path === "string"
        ? payload.config_path
        : "";
    return { settings, configPath };
  }

  function updateConfigPath(path) {
    const text = typeof path === "string" ? path : "";
    state.configPath = text;
    if (dom.archivalConfigPath) {
      dom.archivalConfigPath.textContent = text || "(unknown)";
    }
  }

  function updateBackendVisibility(backend) {
    const mode = archivalBackends.has(backend) ? backend : "network_share";
    const showNetwork = mode === "network_share";
    const showRsync = mode === "rsync";
    if (dom.archivalNetworkShareSection) {
      dom.archivalNetworkShareSection.hidden = !showNetwork;
      dom.archivalNetworkShareSection.dataset.active = showNetwork ? "true" : "false";
      dom.archivalNetworkShareSection.setAttribute("aria-hidden", showNetwork ? "false" : "true");
    }
    if (dom.archivalRsyncSection) {
      dom.archivalRsyncSection.hidden = !showRsync;
      dom.archivalRsyncSection.dataset.active = showRsync ? "true" : "false";
      dom.archivalRsyncSection.setAttribute("aria-hidden", showRsync ? "false" : "true");
    }
  }

  function setStatus(message, stateName = "", options = {}) {
    if (!dom.archivalStatus) {
      return;
    }
    if (state.statusTimeoutId) {
      window.clearTimeout(state.statusTimeoutId);
      state.statusTimeoutId = null;
    }
    const text = typeof message === "string" ? message : "";
    dom.archivalStatus.textContent = text;
    if (stateName) {
      dom.archivalStatus.dataset.state = stateName;
    } else {
      delete dom.archivalStatus.dataset.state;
    }
    dom.archivalStatus.setAttribute("aria-hidden", text ? "false" : "true");

    const { autoHide = false, duration = 2500 } = options;
    if (!text || !autoHide) {
      return;
    }
    state.statusTimeoutId = window.setTimeout(() => {
      state.statusTimeoutId = null;
      if (!state.dirty) {
        setStatus("", "");
      }
    }, Math.max(0, duration));
  }

  function updateButtons() {
    if (dom.archivalSave) {
      dom.archivalSave.disabled = state.saving || !state.dirty;
    }
    if (dom.archivalReset) {
      const disableReset =
        state.saving || (!state.dirty && !state.pendingSnapshot && !state.hasExternalUpdate);
      dom.archivalReset.disabled = disableReset;
    }
    if (dom.archivalDialog) {
      dom.archivalDialog.dataset.dirty = state.dirty ? "true" : "false";
      dom.archivalDialog.dataset.saving = state.saving ? "true" : "false";
      dom.archivalDialog.dataset.externalUpdate = state.hasExternalUpdate ? "true" : "false";
    }
  }

  function setSaving(saving) {
    state.saving = saving;
    if (dom.archivalForm) {
      dom.archivalForm.setAttribute("aria-busy", saving ? "true" : "false");
    }
    updateButtons();
  }

  function applyData(settings, options = {}) {
    const canonical = canonicalArchivalSettings(settings);
    state.current = canonical;
    if (dom.archivalEnabled) {
      dom.archivalEnabled.checked = canonical.enabled;
    }
    if (dom.archivalBackend) {
      dom.archivalBackend.value = canonical.backend;
    }
    if (dom.archivalIncludeWaveforms) {
      dom.archivalIncludeWaveforms.checked = canonical.include_waveform_sidecars;
    }
    if (dom.archivalNetworkShareTarget) {
      dom.archivalNetworkShareTarget.value = canonical.network_share.target_dir;
    }
    if (dom.archivalRsyncDestination) {
      dom.archivalRsyncDestination.value = canonical.rsync.destination;
    }
    if (dom.archivalRsyncIdentity) {
      dom.archivalRsyncIdentity.value = canonical.rsync.ssh_identity;
    }
    if (dom.archivalRsyncOptions) {
      dom.archivalRsyncOptions.value = canonical.rsync.options.join("\n");
    }
    if (dom.archivalRsyncSshOptions) {
      dom.archivalRsyncSshOptions.value = canonical.rsync.ssh_options.join("\n");
    }
    updateBackendVisibility(canonical.backend);

    if (options.markPristine) {
      state.lastAppliedFingerprint = computeArchivalFingerprint(canonical);
      state.dirty = false;
      state.pendingSnapshot = null;
      state.hasExternalUpdate = false;
    }
    updateButtons();
  }

  function readForm() {
    return {
      enabled: dom.archivalEnabled ? dom.archivalEnabled.checked : false,
      backend: dom.archivalBackend ? dom.archivalBackend.value : "network_share",
      include_waveform_sidecars: dom.archivalIncludeWaveforms
        ? dom.archivalIncludeWaveforms.checked
        : false,
      network_share: {
        target_dir: dom.archivalNetworkShareTarget
          ? dom.archivalNetworkShareTarget.value.trim()
          : "",
      },
      rsync: {
        destination: dom.archivalRsyncDestination ? dom.archivalRsyncDestination.value.trim() : "",
        ssh_identity: dom.archivalRsyncIdentity ? dom.archivalRsyncIdentity.value.trim() : "",
        options: parseListInput(dom.archivalRsyncOptions ? dom.archivalRsyncOptions.value : ""),
        ssh_options: parseListInput(dom.archivalRsyncSshOptions ? dom.archivalRsyncSshOptions.value : ""),
      },
    };
  }

  function updateDirtyState() {
    const fingerprint = computeArchivalFingerprint(readForm());
    state.dirty = fingerprint !== state.lastAppliedFingerprint;
    updateButtons();
  }

  function notifyExternalUpdate() {
    state.hasExternalUpdate = true;
    if (!state.dirty) {
      setStatus("Updated on disk. Reset to load changes.", "info");
    }
    updateButtons();
  }

  async function fetchSettings({ silent = false } = {}) {
    if (state.fetchInFlight) {
      state.fetchQueued = true;
      return;
    }
    state.fetchInFlight = true;
    state.loading = true;
    if (!silent) {
      setStatus("Loading archival settings…", "info");
    }
    try {
      const response = await apiClient.fetch(archivalEndpoint, { cache: "no-store" });
      if (!response.ok) {
        const message = await extractErrorMessage(response);
        throw new Error(message);
      }
      const payload = await response.json();
      const { settings, configPath } = normalizeArchivalResponse(payload);
      applyData(settings, { markPristine: true });
      updateConfigPath(configPath);
      state.loaded = true;
      if (!silent) {
        setStatus("Archival settings loaded.", "success", { autoHide: true, duration: 2500 });
      } else if (state.hasExternalUpdate) {
        setStatus("Archival settings refreshed.", "info", { autoHide: true, duration: 2000 });
      }
    } catch (error) {
      console.error("Failed to fetch archival settings", error);
      if (!silent) {
        const message = error && error.message ? error.message : "Unable to load archival settings.";
        setStatus(message, "error");
      }
    } finally {
      state.fetchInFlight = false;
      state.loading = false;
      updateButtons();
      if (state.fetchQueued) {
        state.fetchQueued = false;
        fetchSettings({ silent: true });
      }
    }
  }

  function applySnapshot(cfg) {
    if (!cfg || typeof cfg !== "object") {
      return;
    }
    const snapshot = canonicalArchivalSettings(cfg.archival);
    const fingerprint = computeArchivalFingerprint(snapshot);
    if (!state.loaded) {
      applyData(snapshot, { markPristine: true });
      return;
    }
    if (fingerprint === state.lastAppliedFingerprint) {
      return;
    }
    if (!state.dirty) {
      applyData(snapshot, { markPristine: true });
      setStatus("Archival settings updated from config file.", "info", { autoHide: true, duration: 2500 });
    } else {
      state.pendingSnapshot = snapshot;
      state.hasExternalUpdate = true;
      setStatus("Archival settings changed on disk. Reset to load the new values.", "warning");
      updateButtons();
    }
  }

  async function saveSettings() {
    if (!dom.archivalForm) {
      return;
    }
    const payload = readForm();
    setStatus("Saving changes…", "pending");
    setSaving(true);
    try {
      const response = await apiClient.fetch(archivalEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const message = await extractErrorMessage(response);
        setStatus(message, "error");
        return;
      }
      const data = await response.json();
      const { settings, configPath } = normalizeArchivalResponse(data);
      applyData(settings, { markPristine: true });
      updateConfigPath(configPath);
      state.loaded = true;
      setStatus("Archival settings saved.", "success", { autoHide: true, duration: 2500 });
    } catch (error) {
      console.error("Failed to save archival settings", error);
      const message = error && error.message ? error.message : "Unable to save archival settings.";
      setStatus(message, "error");
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    if (state.saving) {
      return;
    }
    if (state.pendingSnapshot) {
      applyData(state.pendingSnapshot, { markPristine: true });
      setStatus("Loaded updated settings from disk.", "info", { autoHide: true, duration: 2500 });
      return;
    }
    if (state.current) {
      applyData(state.current, { markPristine: true });
      setStatus("Reverted unsaved changes.", "info", { autoHide: true, duration: 2000 });
    }
  }

  function modalFocusableElements() {
    if (!dom.archivalDialog) {
      return [];
    }
    const selectors =
      'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';
    const nodes = dom.archivalDialog.querySelectorAll(selectors);
    const focusable = [];
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }
      if (node.hasAttribute("disabled")) {
        continue;
      }
      if (node.getAttribute("aria-hidden") === "true") {
        continue;
      }
      if (node.offsetParent === null && node !== document.activeElement) {
        continue;
      }
      focusable.push(node);
    }
    return focusable;
  }

  function setModalVisible(visible) {
    if (!dom.archivalModal) {
      return;
    }
    dom.archivalModal.dataset.visible = visible ? "true" : "false";
    dom.archivalModal.setAttribute("aria-hidden", visible ? "false" : "true");
    if (visible) {
      dom.archivalModal.removeAttribute("hidden");
      lockDocumentScroll("archival-settings");
    } else {
      dom.archivalModal.setAttribute("hidden", "hidden");
      unlockDocumentScroll("archival-settings");
    }
  }

  function attachDialogKeydown() {
    if (dialogState.keydownHandler) {
      return;
    }
    dialogState.keydownHandler = (event) => {
      if (!dialogState.open) {
        return;
      }
      const target = event.target;
      const withinModal =
        dom.archivalModal &&
        target instanceof Node &&
        (target === dom.archivalModal || dom.archivalModal.contains(target));
      if (event.key === "Escape") {
        event.preventDefault();
        closeModal();
        return;
      }
      if (event.key !== "Tab" || !withinModal) {
        return;
      }
      const focusable = modalFocusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        if (dom.archivalDialog) {
          dom.archivalDialog.focus();
        }
        return;
      }
      const [first] = focusable;
      const last = focusable[focusable.length - 1];
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (event.shiftKey) {
        if (!active || active === first || active === dom.archivalDialog) {
          event.preventDefault();
          last.focus();
        }
      } else if (!active || active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", dialogState.keydownHandler, true);
  }

  function detachDialogKeydown() {
    if (!dialogState.keydownHandler) {
      return;
    }
    document.removeEventListener("keydown", dialogState.keydownHandler, true);
    dialogState.keydownHandler = null;
  }

  function focusDialog() {
    if (!dom.archivalDialog) {
      return;
    }
    window.requestAnimationFrame(() => {
      const focusable = modalFocusableElements();
      if (focusable.length > 0) {
        focusable[0].focus();
      } else {
        dom.archivalDialog.focus();
      }
    });
  }

  function openModal(options = {}) {
    if (!dom.archivalModal || !dom.archivalDialog) {
      return;
    }
    const { focus = true } = options;
    if (dialogState.open) {
      if (focus) {
        focusDialog();
      }
      return;
    }
    dialogState.open = true;
    dialogState.previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setModalVisible(true);
    if (dom.archivalOpen) {
      dom.archivalOpen.setAttribute("aria-expanded", "true");
    }
    attachDialogKeydown();
    if (!state.loaded && !state.fetchInFlight) {
      fetchSettings({ silent: false });
    } else if (state.hasExternalUpdate && state.pendingSnapshot && !state.saving) {
      setStatus("Archival settings changed on disk. Reset to load the new values.", "warning");
    } else {
      updateButtons();
    }
    if (focus) {
      focusDialog();
    }
  }

  function closeModal(options = {}) {
    if (!dialogState.open) {
      return;
    }
    const { restoreFocus = true } = options;
    dialogState.open = false;
    setModalVisible(false);
    if (dom.archivalOpen) {
      dom.archivalOpen.setAttribute("aria-expanded", "false");
    }
    detachDialogKeydown();
    const previous = dialogState.previouslyFocused;
    dialogState.previouslyFocused = null;
    if (restoreFocus && previous && typeof previous.focus === "function") {
      previous.focus();
    }
  }

  function attachEventListeners() {
    if (dom.archivalOpen) {
      dom.archivalOpen.addEventListener("click", () => {
        if (typeof closeAppMenu === "function") {
          closeAppMenu({ restoreFocus: false });
        }
        openModal();
      });
    }

    if (dom.archivalClose) {
      dom.archivalClose.addEventListener("click", () => {
        closeModal();
      });
    }

    if (dom.archivalModal) {
      dom.archivalModal.addEventListener("mousedown", (event) => {
        if (event.target === dom.archivalModal) {
          event.preventDefault();
        }
      });
      dom.archivalModal.addEventListener("click", (event) => {
        if (event.target === dom.archivalModal) {
          closeModal();
        }
      });
    }

    if (dom.archivalForm) {
      dom.archivalForm.addEventListener("submit", (event) => {
        event.preventDefault();
        saveSettings();
      });

      const handleChange = (event) => {
        if (event && event.target === dom.archivalBackend) {
          updateBackendVisibility(dom.archivalBackend.value);
        }
        updateDirtyState();
      };

      dom.archivalForm.addEventListener("input", handleChange);
      dom.archivalForm.addEventListener("change", handleChange);
    }

    if (dom.archivalReset) {
      dom.archivalReset.addEventListener("click", () => {
        handleReset();
      });
    }
  }

  function initializeDom() {
    setModalVisible(false);
    applyData(archivalDefaults(), { markPristine: true });
    updateConfigPath(state.configPath);
  }

  return {
    state,
    archivalDefaults,
    canonicalArchivalSettings,
    computeArchivalFingerprint,
    normalizeArchivalResponse,
    updateConfigPath,
    updateBackendVisibility,
    setStatus,
    updateButtons,
    setSaving,
    applyData,
    readForm,
    updateDirtyState,
    notifyExternalUpdate,
    fetchSettings,
    applySnapshot,
    saveSettings,
    handleReset,
    modalFocusableElements,
    setModalVisible,
    attachDialogKeydown,
    detachDialogKeydown,
    focusDialog,
    openModal,
    closeModal,
    attachEventListeners,
    initializeDom,
  };
}
