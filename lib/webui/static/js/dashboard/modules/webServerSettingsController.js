export function createWebServerSettingsController({
  dom,
  apiClient,
  lockDocumentScroll,
  unlockDocumentScroll,
  parseBoolean,
  parseListInput,
  closeAppMenu,
  webServerEndpoint,
  webServerTlsProviders,
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

  function webServerDefaults() {
    return {
      mode: "http",
      listen_host: "0.0.0.0",
      listen_port: 8080,
      tls_provider: "letsencrypt",
      certificate_path: "",
      private_key_path: "",
      lets_encrypt: {
        enabled: false,
        email: "",
        domains: [],
        cache_dir: "/apps/tricorder/letsencrypt",
        staging: false,
        certbot_path: "certbot",
        http_port: 80,
        renew_before_days: 30,
      },
    };
  }

  function canonicalWebServerSettings(settings) {
    const defaults = webServerDefaults();
    if (!settings || typeof settings !== "object") {
      return defaults;
    }

    const canonical = {
      mode: defaults.mode,
      listen_host: defaults.listen_host,
      listen_port: defaults.listen_port,
      tls_provider: defaults.tls_provider,
      certificate_path: "",
      private_key_path: "",
      lets_encrypt: {
        enabled: false,
        email: "",
        domains: [],
        cache_dir: defaults.lets_encrypt.cache_dir,
        staging: false,
        certbot_path: defaults.lets_encrypt.certbot_path,
        http_port: defaults.lets_encrypt.http_port,
        renew_before_days: defaults.lets_encrypt.renew_before_days,
      },
    };

    if (typeof settings.mode === "string") {
      const mode = settings.mode.trim().toLowerCase();
      if (mode === "https" || mode === "http") {
        canonical.mode = mode;
      }
    }

    if (typeof settings.listen_host === "string") {
      const host = settings.listen_host.trim();
      canonical.listen_host = host || defaults.listen_host;
    }

    const portValue = settings.listen_port;
    if (typeof portValue === "number" && Number.isFinite(portValue)) {
      const normalized = Math.min(65535, Math.max(1, Math.round(portValue)));
      canonical.listen_port = normalized;
    } else if (typeof portValue === "string" && portValue.trim() !== "") {
      const parsed = Number(portValue);
      if (Number.isFinite(parsed)) {
        const normalized = Math.min(65535, Math.max(1, Math.round(parsed)));
        canonical.listen_port = normalized;
      }
    }

    if (typeof settings.tls_provider === "string") {
      const provider = settings.tls_provider.trim().toLowerCase();
      if (webServerTlsProviders.has(provider)) {
        canonical.tls_provider = provider;
      }
    }

    if (typeof settings.certificate_path === "string") {
      canonical.certificate_path = settings.certificate_path.trim();
    }
    if (typeof settings.private_key_path === "string") {
      canonical.private_key_path = settings.private_key_path.trim();
    }

    const letsEncrypt =
      settings.lets_encrypt && typeof settings.lets_encrypt === "object"
        ? settings.lets_encrypt
        : {};
    canonical.lets_encrypt.enabled = parseBoolean(letsEncrypt.enabled);
    if (typeof letsEncrypt.email === "string") {
      canonical.lets_encrypt.email = letsEncrypt.email.trim();
    }
    if (Array.isArray(letsEncrypt.domains)) {
      canonical.lets_encrypt.domains = letsEncrypt.domains
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter((item) => item);
    } else if (typeof letsEncrypt.domains === "string") {
      canonical.lets_encrypt.domains = parseListInput(letsEncrypt.domains);
    }
    if (typeof letsEncrypt.cache_dir === "string") {
      canonical.lets_encrypt.cache_dir = letsEncrypt.cache_dir.trim() || defaults.lets_encrypt.cache_dir;
    }
    canonical.lets_encrypt.staging = parseBoolean(letsEncrypt.staging);
    if (typeof letsEncrypt.certbot_path === "string") {
      canonical.lets_encrypt.certbot_path = letsEncrypt.certbot_path.trim() || defaults.lets_encrypt.certbot_path;
    }
    const httpPortValue = letsEncrypt.http_port;
    if (typeof httpPortValue === "number" && Number.isFinite(httpPortValue)) {
      canonical.lets_encrypt.http_port = Math.min(65535, Math.max(1, Math.round(httpPortValue)));
    } else if (typeof httpPortValue === "string" && httpPortValue.trim() !== "") {
      const parsed = Number(httpPortValue);
      if (Number.isFinite(parsed)) {
        canonical.lets_encrypt.http_port = Math.min(65535, Math.max(1, Math.round(parsed)));
      }
    }
    const renewValue = letsEncrypt.renew_before_days;
    if (typeof renewValue === "number" && Number.isFinite(renewValue)) {
      canonical.lets_encrypt.renew_before_days = Math.max(1, Math.round(renewValue));
    } else if (typeof renewValue === "string" && renewValue.trim() !== "") {
      const parsed = Number(renewValue);
      if (Number.isFinite(parsed)) {
        canonical.lets_encrypt.renew_before_days = Math.max(1, Math.round(parsed));
      }
    }

    if (canonical.mode !== "https") {
      canonical.tls_provider = defaults.tls_provider;
      canonical.lets_encrypt.enabled = false;
    } else if (!webServerTlsProviders.has(canonical.tls_provider)) {
      canonical.tls_provider = "letsencrypt";
    }

    return canonical;
  }

  function computeWebServerFingerprint(settings) {
    return JSON.stringify(canonicalWebServerSettings(settings));
  }

  function normalizeWebServerResponse(payload) {
    const settings =
      payload && typeof payload === "object"
        ? canonicalWebServerSettings(payload["web_server"])
        : webServerDefaults();
    const configPath =
      payload && typeof payload === "object" && typeof payload.config_path === "string"
        ? payload.config_path
        : "";
    return { settings, configPath };
  }

  function updateConfigPath(path) {
    const text = typeof path === "string" ? path : "";
    state.configPath = text;
    if (dom.webServerConfigPath) {
      dom.webServerConfigPath.textContent = text || "(unknown)";
    }
  }

  function updateVisibility() {
    const mode = dom.webServerMode ? dom.webServerMode.value : "http";
    const provider = dom.webServerTlsProvider ? dom.webServerTlsProvider.value : "letsencrypt";
    const showTls = mode === "https";
    const showLetsEncrypt = showTls && provider === "letsencrypt";
    const showManual = showTls && provider === "manual";
    if (dom.webServerLetsEncryptSection) {
      dom.webServerLetsEncryptSection.hidden = !showLetsEncrypt;
      dom.webServerLetsEncryptSection.dataset.active = showLetsEncrypt ? "true" : "false";
      dom.webServerLetsEncryptSection.setAttribute("aria-hidden", showLetsEncrypt ? "false" : "true");
    }
    if (dom.webServerManualSection) {
      dom.webServerManualSection.hidden = !showManual;
      dom.webServerManualSection.dataset.active = showManual ? "true" : "false";
      dom.webServerManualSection.setAttribute("aria-hidden", showManual ? "false" : "true");
    }
  }

  function setStatus(message, stateName = "", options = {}) {
    if (!dom.webServerStatus) {
      return;
    }
    if (state.statusTimeoutId) {
      window.clearTimeout(state.statusTimeoutId);
      state.statusTimeoutId = null;
    }
    const text = typeof message === "string" ? message : "";
    dom.webServerStatus.textContent = text;
    if (stateName) {
      dom.webServerStatus.dataset.state = stateName;
    } else {
      delete dom.webServerStatus.dataset.state;
    }
    dom.webServerStatus.setAttribute("aria-hidden", text ? "false" : "true");

    const { autoHide = false, duration = 2000 } = options;
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
    if (dom.webServerSave) {
      dom.webServerSave.disabled = state.saving || !state.dirty;
    }
    if (dom.webServerReset) {
      const disableReset =
        state.saving || (!state.dirty && !state.pendingSnapshot && !state.hasExternalUpdate);
      dom.webServerReset.disabled = disableReset;
    }
    if (dom.webServerDialog) {
      dom.webServerDialog.dataset.dirty = state.dirty ? "true" : "false";
      dom.webServerDialog.dataset.saving = state.saving ? "true" : "false";
      dom.webServerDialog.dataset.externalUpdate = state.hasExternalUpdate ? "true" : "false";
    }
  }

  function setSaving(saving) {
    state.saving = saving;
    if (dom.webServerForm) {
      dom.webServerForm.setAttribute("aria-busy", saving ? "true" : "false");
    }
    updateButtons();
  }

  function applyData(settings, options = {}) {
    const canonical = canonicalWebServerSettings(settings);
    state.current = canonical;
    if (dom.webServerMode) {
      dom.webServerMode.value = canonical.mode;
    }
    if (dom.webServerHost) {
      dom.webServerHost.value = canonical.listen_host;
    }
    if (dom.webServerPort) {
      dom.webServerPort.value = String(canonical.listen_port);
    }
    if (dom.webServerTlsProvider) {
      dom.webServerTlsProvider.value = canonical.tls_provider;
    }
    if (dom.webServerManualCert) {
      dom.webServerManualCert.value = canonical.certificate_path || "";
    }
    if (dom.webServerManualKey) {
      dom.webServerManualKey.value = canonical.private_key_path || "";
    }
    if (dom.webServerLetsEncryptDomains) {
      dom.webServerLetsEncryptDomains.value = canonical.lets_encrypt.domains.join("\n");
    }
    if (dom.webServerLetsEncryptEmail) {
      dom.webServerLetsEncryptEmail.value = canonical.lets_encrypt.email || "";
    }
    if (dom.webServerLetsEncryptStaging) {
      dom.webServerLetsEncryptStaging.checked = Boolean(canonical.lets_encrypt.staging);
    }
    if (dom.webServerLetsEncryptHttpPort) {
      dom.webServerLetsEncryptHttpPort.value = String(canonical.lets_encrypt.http_port);
    }
    if (dom.webServerLetsEncryptCacheDir) {
      dom.webServerLetsEncryptCacheDir.value = canonical.lets_encrypt.cache_dir || "";
    }
    if (dom.webServerLetsEncryptCertbot) {
      dom.webServerLetsEncryptCertbot.value = canonical.lets_encrypt.certbot_path || "";
    }
    if (dom.webServerLetsEncryptRenewBefore) {
      dom.webServerLetsEncryptRenewBefore.value = String(canonical.lets_encrypt.renew_before_days);
    }
    updateVisibility();

    if (options.markPristine) {
      state.lastAppliedFingerprint = computeWebServerFingerprint(canonical);
      state.dirty = false;
      state.pendingSnapshot = null;
      state.hasExternalUpdate = false;
    }
    updateButtons();
  }

  function readFormValues() {
    return {
      mode: dom.webServerMode ? dom.webServerMode.value : "http",
      listen_host: dom.webServerHost ? dom.webServerHost.value : "",
      listen_port: dom.webServerPort ? dom.webServerPort.value : "",
      tls_provider: dom.webServerTlsProvider ? dom.webServerTlsProvider.value : "letsencrypt",
      certificate_path: dom.webServerManualCert ? dom.webServerManualCert.value : "",
      private_key_path: dom.webServerManualKey ? dom.webServerManualKey.value : "",
      lets_encrypt: {
        email: dom.webServerLetsEncryptEmail ? dom.webServerLetsEncryptEmail.value : "",
        domains: dom.webServerLetsEncryptDomains ? dom.webServerLetsEncryptDomains.value : "",
        staging: dom.webServerLetsEncryptStaging ? dom.webServerLetsEncryptStaging.checked : false,
        http_port: dom.webServerLetsEncryptHttpPort ? dom.webServerLetsEncryptHttpPort.value : "",
        cache_dir: dom.webServerLetsEncryptCacheDir ? dom.webServerLetsEncryptCacheDir.value : "",
        certbot_path: dom.webServerLetsEncryptCertbot ? dom.webServerLetsEncryptCertbot.value : "",
        renew_before_days: dom.webServerLetsEncryptRenewBefore
          ? dom.webServerLetsEncryptRenewBefore.value
          : "",
      },
    };
  }

  function updateDirtyState() {
    const values = readFormValues();
    const fingerprint = computeWebServerFingerprint(values);
    state.dirty = fingerprint !== state.lastAppliedFingerprint;
    updateButtons();
  }

  function notifyExternalUpdate() {
    state.hasExternalUpdate = true;
    if (!state.dirty) {
      setStatus("Web server settings changed on disk. Reset to load the new values.", "warning");
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
      setStatus("Loading web server settings…", "info");
    }

    try {
      const response = await apiClient.fetch(webServerEndpoint, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Request failed with ${response.status}`);
      }
      const payload = await response.json();
      const { settings, configPath } = normalizeWebServerResponse(payload);
      state.loaded = true;
      updateConfigPath(configPath);
      applyData(settings, { markPristine: true });
      if (!silent) {
        setStatus("Loaded web server settings.", "success", { autoHide: true, duration: 1800 });
      } else if (!state.dirty) {
        setStatus("", "");
      }
    } catch (error) {
      console.error("Failed to fetch web server settings", error);
      const message = error && error.message ? error.message : "Unable to load web server settings.";
      setStatus(message, "error");
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

  function applySnapshot(snapshot) {
    const canonical = canonicalWebServerSettings(snapshot);
    if (!state.loaded) {
      applyData(canonical, { markPristine: true });
      state.loaded = true;
      return;
    }
    const fingerprint = computeWebServerFingerprint(canonical);
    if (fingerprint === state.lastAppliedFingerprint) {
      setStatus("Web server settings updated from config file.", "info", {
        autoHide: true,
        duration: 2000,
      });
      state.hasExternalUpdate = false;
      state.pendingSnapshot = null;
      applyData(canonical, { markPristine: true });
      return;
    }
    if (!state.dirty) {
      applyData(canonical, { markPristine: true });
      setStatus("Web server settings updated from config file.", "info", {
        autoHide: true,
        duration: 2000,
      });
      return;
    }
    state.pendingSnapshot = snapshot;
    state.hasExternalUpdate = true;
    setStatus("Web server settings changed on disk. Reset to load the new values.", "warning");
    updateButtons();
  }

  async function saveSettings() {
    if (!dom.webServerForm) {
      return;
    }
    if (state.saving) {
      return;
    }
    setSaving(true);
    setStatus("Saving web server settings…", "info");
    const payload = canonicalWebServerSettings(readFormValues());

    try {
      const response = await apiClient.fetch(webServerEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const message = await extractErrorMessage(response);
        throw new Error(message || `Request failed with ${response.status}`);
      }
      state.loaded = true;
      setStatus("Saved web server settings.", "success", { autoHide: true, duration: 2000 });
      const body = await response.json();
      const { settings, configPath } = normalizeWebServerResponse(body);
      applyData(settings, { markPristine: true });
      updateConfigPath(configPath);
    } catch (error) {
      console.error("Failed to save web server settings", error);
      const message = error && error.message ? error.message : "Unable to save web server settings.";
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
    if (!dom.webServerDialog) {
      return [];
    }
    const selectors =
      'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';
    const nodes = dom.webServerDialog.querySelectorAll(selectors);
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
    if (!dom.webServerModal) {
      return;
    }
    dom.webServerModal.dataset.visible = visible ? "true" : "false";
    dom.webServerModal.setAttribute("aria-hidden", visible ? "false" : "true");
    if (visible) {
      dom.webServerModal.removeAttribute("hidden");
      lockDocumentScroll("web-server-settings");
    } else {
      dom.webServerModal.setAttribute("hidden", "hidden");
      unlockDocumentScroll("web-server-settings");
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
      const target = event.target instanceof Element ? event.target : null;
      const withinModal =
        dom.webServerModal && (target === dom.webServerModal || dom.webServerModal.contains(target));
      if (event.key === "Escape" && withinModal) {
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
        if (dom.webServerDialog) {
          dom.webServerDialog.focus();
        }
        return;
      }
      const [first] = focusable;
      const last = focusable[focusable.length - 1];
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (event.shiftKey) {
        if (!active || active === first || active === dom.webServerDialog) {
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
    if (!dom.webServerDialog) {
      return;
    }
    window.requestAnimationFrame(() => {
      const focusable = modalFocusableElements();
      if (focusable.length > 0) {
        focusable[0].focus();
      } else {
        dom.webServerDialog.focus();
      }
    });
  }

  function openModal(options = {}) {
    if (!dom.webServerModal || !dom.webServerDialog) {
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
    if (dom.webServerOpen) {
      dom.webServerOpen.setAttribute("aria-expanded", "true");
    }
    attachDialogKeydown();
    if (!state.loaded && !state.fetchInFlight) {
      fetchSettings({ silent: false });
    } else if (state.hasExternalUpdate && state.pendingSnapshot && !state.saving) {
      setStatus("Web server settings changed on disk. Reset to load the new values.", "warning");
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
    if (dom.webServerOpen) {
      dom.webServerOpen.setAttribute("aria-expanded", "false");
    }
    detachDialogKeydown();
    const previous = dialogState.previouslyFocused;
    dialogState.previouslyFocused = null;
    if (restoreFocus && previous && typeof previous.focus === "function") {
      previous.focus();
    }
  }

  function attachEventListeners() {
    if (dom.webServerOpen) {
      dom.webServerOpen.addEventListener("click", () => {
        if (typeof closeAppMenu === "function") {
          closeAppMenu({ restoreFocus: false });
        }
        openModal();
      });
    }

    if (dom.webServerClose) {
      dom.webServerClose.addEventListener("click", () => {
        closeModal();
      });
    }

    if (dom.webServerModal) {
      dom.webServerModal.addEventListener("mousedown", (event) => {
        if (event.target === dom.webServerModal) {
          event.preventDefault();
        }
      });
      dom.webServerModal.addEventListener("click", (event) => {
        if (event.target === dom.webServerModal) {
          closeModal();
        }
      });
    }

    if (dom.webServerForm) {
      dom.webServerForm.addEventListener("submit", (event) => {
        event.preventDefault();
        saveSettings();
      });

      const handleChange = (event) => {
        if (event && (event.target === dom.webServerMode || event.target === dom.webServerTlsProvider)) {
          updateVisibility();
        }
        updateDirtyState();
      };

      dom.webServerForm.addEventListener("input", handleChange);
      dom.webServerForm.addEventListener("change", handleChange);
    }

    if (dom.webServerReset) {
      dom.webServerReset.addEventListener("click", () => {
        handleReset();
      });
    }
  }

  function initializeDom() {
    setModalVisible(false);
    applyData(webServerDefaults(), { markPristine: true });
    updateConfigPath(state.configPath);
  }

  return {
    state,
    webServerDefaults,
    canonicalWebServerSettings,
    computeWebServerFingerprint,
    normalizeWebServerResponse,
    updateConfigPath,
    updateVisibility,
    setStatus,
    updateButtons,
    setSaving,
    applyData,
    readFormValues,
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
