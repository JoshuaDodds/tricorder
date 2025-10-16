  }
  if (section.modelPath) {
    section.modelPath.value = data.vosk_model_path ?? "";
  }
  if (section.targetSampleRate) {
    section.targetSampleRate.value = String(data.target_sample_rate);
  }
  if (section.includeWords) {
    section.includeWords.checked = Boolean(data.include_words);
  }
  if (section.maxAlternatives) {
    section.maxAlternatives.value = String(data.max_alternatives);
  }
}

function readTranscriptionForm() {
  const section = recorderDom.sections.transcription;
  if (!section) {
    return transcriptionDefaults();
  }
  const payload = {
    enabled: section.enabled ? section.enabled.checked : false,
    engine: section.engine ? section.engine.value : undefined,
    types: section.types ? section.types.value : undefined,
    vosk_model_path: section.modelPath ? section.modelPath.value : undefined,
    target_sample_rate: section.targetSampleRate
      ? Number(section.targetSampleRate.value)
      : undefined,
    include_words: section.includeWords ? section.includeWords.checked : false,
    max_alternatives: section.maxAlternatives
      ? Number(section.maxAlternatives.value)
      : undefined,
  };
  return canonicalTranscriptionSettings(payload);
}

function setTranscriptionModelStatus(message, state = "info") {
  const section = recorderDom.sections.transcription;
  const element = section && section.modelStatus instanceof HTMLElement ? section.modelStatus : null;
  if (!element) {
    return;
  }
  if (message) {
    element.textContent = message;
    element.dataset.state = state;
    element.setAttribute("aria-hidden", "false");
  } else {
    element.textContent = "";
    delete element.dataset.state;
    element.setAttribute("aria-hidden", "true");
  }
}

function setTranscriptionModelLoading(loading) {
  const section = recorderDom.sections.transcription;
  if (!section || !(section.modelRefresh instanceof HTMLButtonElement)) {
    return;
  }
  section.modelRefresh.disabled = Boolean(loading);
  section.modelRefresh.setAttribute("aria-busy", loading ? "true" : "false");
}

function hideTranscriptionModelDiscovery() {
  const section = recorderDom.sections.transcription;
  if (!section) {
    return;
  }
  if (section.modelOptions instanceof HTMLSelectElement) {
    section.modelOptions.innerHTML = "";
  }
  if (section.modelDiscovery instanceof HTMLElement) {
    section.modelDiscovery.hidden = true;
  }
}

function showTranscriptionModelDiscovery(models, configuredPath = "") {
  const section = recorderDom.sections.transcription;
  if (!section || !(section.modelOptions instanceof HTMLSelectElement)) {
    return;
  }

  section.modelOptions.innerHTML = "";
  const entries = Array.isArray(models) ? models : [];
  let selectedValue = "";
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const path = typeof entry.path === "string" ? entry.path : "";
    if (!path) {
      continue;
    }
    const label =
      typeof entry.label === "string" && entry.label
        ? entry.label
        : typeof entry.name === "string" && entry.name
        ? entry.name
        : path;
    if (!label) {
      continue;
    }
    const option = document.createElement("option");
    option.value = path;
    option.textContent = label;
    if (typeof entry.language === "string" && entry.language) {
      option.dataset.language = entry.language;
    }
    section.modelOptions.append(option);
    if (!selectedValue && typeof configuredPath === "string" && configuredPath === path) {
      selectedValue = path;
    }
  }

  if (section.modelDiscovery instanceof HTMLElement) {
    section.modelDiscovery.hidden = section.modelOptions.options.length === 0;
  }

  if (section.modelOptions.options.length > 0) {
    section.modelOptions.value = selectedValue || section.modelOptions.options[0].value;
  }
}

function applySelectedTranscriptionModel() {
  const section = recorderDom.sections.transcription;
  if (!section) {
    return;
  }
  if (!(section.modelOptions instanceof HTMLSelectElement) || !(section.modelPath instanceof HTMLInputElement)) {
    return;
  }
  const value = section.modelOptions.value;
  if (!value) {
    return;
  }
  section.modelPath.value = value;
  markRecorderSectionDirty("transcription");
  const selected = transcriptionModelState.models.find((entry) => entry && entry.path === value);
  if (selected && selected.label) {
    setTranscriptionModelStatus(`Selected ${selected.label}.`, "info");
  } else {
    setTranscriptionModelStatus("Updated model path from detected entry.", "info");
  }
  try {
    section.modelPath.focus({ preventScroll: true });
  } catch (error) {
    /* ignore focus errors */
  }
}

async function refreshTranscriptionModels() {
  if (transcriptionModelState.loading) {
    return;
  }
  const section = recorderDom.sections.transcription;
  if (!section) {
    return;
  }

  transcriptionModelState.loading = true;
  setTranscriptionModelLoading(true);
  hideTranscriptionModelDiscovery();
  setTranscriptionModelStatus("Scanning for installed models…", "pending");

  try {
    const response = await apiClient.fetch("/api/transcription/models", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Request failed (${response.status})`);
    }
    const payload = await response.json();
    const models = Array.isArray(payload?.models) ? payload.models : [];
    const sanitized = [];
    for (const entry of models) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const path = typeof entry.path === "string" ? entry.path : "";
      if (!path) {
        continue;
      }
      const label =
        typeof entry.label === "string" && entry.label
          ? entry.label
          : typeof entry.name === "string" && entry.name
          ? entry.name
          : path;
      const language =
        typeof entry.language === "string" && entry.language ? entry.language : null;
      sanitized.push({ path, label, language });
    }

    transcriptionModelState.models = sanitized;
    const configuredPath =
      typeof payload?.configured_path === "string" ? payload.configured_path : "";
    showTranscriptionModelDiscovery(sanitized, configuredPath);

    const searched = Array.isArray(payload?.searched) ? payload.searched : [];
    const configuredExists = Boolean(payload && payload.configured_exists);
    let message = "";
    let state = "success";
    if (sanitized.length > 0) {
      const count = sanitized.length;
      message = count === 1 ? "Found 1 Vosk model." : `Found ${count} Vosk models.`;
    } else {
      message = "No Vosk models were found.";
      if (searched.length > 0) {
        const display = searched.slice(0, 3);
        const remainder = searched.length - display.length;
        const joined = display.join(", ");
        const suffix = remainder > 0 ? `, … (+${remainder} more)` : "";
        message += ` Checked ${joined}${suffix}.`;
      }
      state = "warning";
    }

    if (configuredPath && !configuredExists) {
      message += ` Current configured path is missing (${configuredPath}).`;
      state = sanitized.length > 0 ? "warning" : "error";
    }

    setTranscriptionModelStatus(message, state);

    if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
      console.warn("Model discovery reported issues", payload.errors);
    }
  } catch (error) {
    const message =
      error instanceof Error && error.message
        ? error.message
        : "Unable to discover Vosk models.";
    setTranscriptionModelStatus(message, "error");
    transcriptionModelState.models = [];
    hideTranscriptionModelDiscovery();
  } finally {
    transcriptionModelState.loading = false;
    setTranscriptionModelLoading(false);
  }
}

function applyLoggingForm(data) {
  const section = recorderDom.sections.logging;
  if (!section) {
    return;
  }
  if (section.devMode) {
    section.devMode.checked = data.dev_mode;
  }
}

function readLoggingForm() {
  const section = recorderDom.sections.logging;
  if (!section) {
    return loggingDefaults();
  }
  const payload = {
    dev_mode: section.devMode ? section.devMode.checked : false,
  };
  return canonicalLoggingSettings(payload);
}

function applyStreamingForm(data) {
  const section = recorderDom.sections.streaming;
  if (!section) {
    return;
  }
  if (section.mode) {
    section.mode.value = data.mode;
  }
  if (section.history) {
    section.history.value = String(data.webrtc_history_seconds);
  }
}

function readStreamingForm() {
  const section = recorderDom.sections.streaming;
  if (!section) {
    return streamingDefaults();
  }
  const payload = {
    mode: section.mode ? section.mode.value : undefined,
    webrtc_history_seconds: section.history ? Number(section.history.value) : undefined,
  };
  return canonicalStreamingSettings(payload);
}

function applyDashboardForm(data) {
  const section = recorderDom.sections.dashboard;
  if (!section) {
    return;
  }
  if (section.apiBase) {
    section.apiBase.value = data.api_base ?? "";
  }
}

function readDashboardForm() {
  const section = recorderDom.sections.dashboard;
  if (!section) {
    return dashboardDefaults();
  }
  const payload = {
    api_base: section.apiBase ? section.apiBase.value : "",
  };
  return canonicalDashboardSettings(payload);
}

function configModalFocusableElements() {
  if (!dom.configDialog) {
    return [];
  }
  const selectors =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const nodes = dom.configDialog.querySelectorAll(selectors);
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

function setConfigModalVisible(visible) {
  if (!dom.configModal) {
    return;
  }
  dom.configModal.dataset.visible = visible ? "true" : "false";
  dom.configModal.setAttribute("aria-hidden", visible ? "false" : "true");
  if (visible) {
    dom.configModal.removeAttribute("hidden");
    lockDocumentScroll("config-snapshot");
  } else {
    dom.configModal.setAttribute("hidden", "hidden");
    unlockDocumentScroll("config-snapshot");
  }
}

function attachConfigDialogKeydown() {
  if (configDialogState.keydownHandler) {
    return;
  }
  configDialogState.keydownHandler = (event) => {
    if (!configDialogState.open) {
      return;
    }
    const target = event.target;
    const withinModal =
      dom.configModal &&
      target instanceof Node &&
      (target === dom.configModal || dom.configModal.contains(target));
    if (event.key === "Escape") {
      if (withinModal) {
        event.preventDefault();
      }
      closeConfigModal();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    if (!withinModal) {
      return;
    }
    const focusable = configModalFocusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      if (dom.configDialog) {
        dom.configDialog.focus();
      }
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey) {
      if (!active || active === first || active === dom.configDialog) {
        event.preventDefault();
        last.focus();
      }
    } else if (!active || active === last) {
      event.preventDefault();
      first.focus();
    }
  };
  document.addEventListener("keydown", configDialogState.keydownHandler, true);
}

function detachConfigDialogKeydown() {
  if (!configDialogState.keydownHandler) {
    return;
  }
  document.removeEventListener("keydown", configDialogState.keydownHandler, true);
  configDialogState.keydownHandler = null;
}

function focusConfigDialog() {
  if (!dom.configDialog) {
    return;
  }
  window.requestAnimationFrame(() => {
    const focusable = configModalFocusableElements();
    if (focusable.length > 0) {
      focusable[0].focus();
    } else {
      dom.configDialog.focus();
    }
  });
}

function openConfigModal(options = {}) {
  if (!dom.configModal || !dom.configDialog) {
    return;
  }
  const { focus = true } = options;
  if (dom.configOpen) {
    dom.configOpen.setAttribute("aria-expanded", "true");
  }
  if (configDialogState.open) {
    if (focus) {
      focusConfigDialog();
    }
    fetchConfig({ silent: true });
    return;
  }
  configDialogState.open = true;
  configDialogState.previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  setConfigModalVisible(true);
  attachConfigDialogKeydown();
  if (dom.configViewer) {
    dom.configViewer.scrollTop = 0;
  }
  fetchConfig({ silent: true });
  if (focus) {
    focusConfigDialog();
  }
}

function closeConfigModal(options = {}) {
  if (!configDialogState.open) {
    return;
  }
  const { restoreFocus = true } = options;
  configDialogState.open = false;
  setConfigModalVisible(false);
  if (dom.configOpen) {
    dom.configOpen.setAttribute("aria-expanded", "false");
  }
  detachConfigDialogKeydown();
  const previous = configDialogState.previouslyFocused;
  configDialogState.previouslyFocused = null;
  if (restoreFocus && previous && typeof previous.focus === "function") {
    previous.focus();
  }
}

function servicesModalFocusableElements() {
  if (!dom.servicesDialog) {
    return [];
  }
  const selectors =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const nodes = dom.servicesDialog.querySelectorAll(selectors);
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

function setServicesModalVisible(visible) {
  if (!dom.servicesModal) {
    return;
  }
  dom.servicesModal.dataset.visible = visible ? "true" : "false";
  dom.servicesModal.setAttribute("aria-hidden", visible ? "false" : "true");
  if (visible) {
    dom.servicesModal.removeAttribute("hidden");
    lockDocumentScroll("services");
  } else {
    dom.servicesModal.setAttribute("hidden", "hidden");
    unlockDocumentScroll("services");
  }
}

function attachServicesDialogKeydown() {
  if (servicesDialogState.keydownHandler) {
    return;
  }
  servicesDialogState.keydownHandler = (event) => {
    if (!servicesDialogState.open) {
      return;
    }
    const target = event.target;
    const withinModal =
      dom.servicesModal &&
      target instanceof Node &&
      (target === dom.servicesModal || dom.servicesModal.contains(target));
    if (event.key === "Escape") {
      event.preventDefault();
      closeServicesModal();
      return;
    }
    if (event.key !== "Tab" || !withinModal) {
      return;
    }
    const focusable = servicesModalFocusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      if (dom.servicesDialog) {
        dom.servicesDialog.focus();
      }
      return;
    }
    const [first] = focusable;
    const last = focusable[focusable.length - 1];
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (event.shiftKey) {
      if (!active || active === first || active === dom.servicesDialog) {
        event.preventDefault();
        last.focus();
      }
    } else if (!active || active === last) {
      event.preventDefault();
      first.focus();
    }
  };
  document.addEventListener("keydown", servicesDialogState.keydownHandler, true);
}

function detachServicesDialogKeydown() {
  if (!servicesDialogState.keydownHandler) {
    return;
  }
  document.removeEventListener("keydown", servicesDialogState.keydownHandler, true);
  servicesDialogState.keydownHandler = null;
}

function focusServicesDialog() {
  if (!dom.servicesDialog) {
    return;
  }
  window.requestAnimationFrame(() => {
    const focusable = servicesModalFocusableElements();
    if (focusable.length > 0) {
      focusable[0].focus();
    } else {
      dom.servicesDialog.focus();
    }
  });
}

function openServicesModal(options = {}) {
  if (!dom.servicesModal || !dom.servicesDialog) {
    return;
  }
  const { focus = true } = options;
  if (dom.servicesOpen) {
    dom.servicesOpen.setAttribute("aria-expanded", "true");
  }
  if (servicesDialogState.open) {
    if (focus) {
      focusServicesDialog();
    }
    fetchServices({ silent: false });
    startServicesRefresh();
    return;
  }
  servicesDialogState.open = true;
  servicesDialogState.previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  setServicesModalVisible(true);
  if (dom.servicesBody) {
    dom.servicesBody.scrollTop = 0;
  }
  fetchServices({ silent: false });
  attachServicesDialogKeydown();
  startServicesRefresh();
  if (focus) {
    focusServicesDialog();
  }
}

function closeServicesModal(options = {}) {
  if (!servicesDialogState.open) {
    return;
  }
  const { restoreFocus = true } = options;
  servicesDialogState.open = false;
  stopServicesRefresh();
  setServicesModalVisible(false);
  if (dom.servicesOpen) {
    dom.servicesOpen.setAttribute("aria-expanded", "false");
  }
  detachServicesDialogKeydown();
  const previous = servicesDialogState.previouslyFocused;
  servicesDialogState.previouslyFocused = null;
  if (restoreFocus && previous && typeof previous.focus === "function") {
    previous.focus();
  }
}

function recycleBinModalFocusableElements() {
  if (!dom.recycleBinDialog) {
    return [];
  }
  const selectors =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const nodes = dom.recycleBinDialog.querySelectorAll(selectors);
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

function setRecycleBinModalVisible(visible) {
  if (!dom.recycleBinModal) {
    return;
  }
  dom.recycleBinModal.dataset.visible = visible ? "true" : "false";
  dom.recycleBinModal.setAttribute("aria-hidden", visible ? "false" : "true");
  if (visible) {
    dom.recycleBinModal.removeAttribute("hidden");
    lockDocumentScroll("recycle-bin");
  } else {
    dom.recycleBinModal.setAttribute("hidden", "hidden");
    unlockDocumentScroll("recycle-bin");
  }
}

function attachRecycleBinDialogKeydown() {
  if (recycleBinDialogState.keydownHandler) {
    return;
  }
  recycleBinDialogState.keydownHandler = (event) => {
    if (!recycleBinDialogState.open) {
      return;
    }
    const target = event.target;
    const withinModal =
      dom.recycleBinModal &&
      target instanceof Node &&
      (target === dom.recycleBinModal || dom.recycleBinModal.contains(target));
    if (event.key === "Escape") {
      event.preventDefault();
      closeRecycleBinModal();
      return;
    }
    if (event.key !== "Tab" || !withinModal) {
      return;
    }
    const focusable = recycleBinModalFocusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      if (dom.recycleBinDialog) {
        dom.recycleBinDialog.focus();
      }
      return;
    }
    const [first] = focusable;
    const last = focusable[focusable.length - 1];
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (event.shiftKey) {
      if (!active || active === first || active === dom.recycleBinDialog) {
        event.preventDefault();
        last.focus();
      }
    } else if (!active || active === last) {
      event.preventDefault();
      first.focus();
    }
  };
  document.addEventListener("keydown", recycleBinDialogState.keydownHandler, true);
}

function detachRecycleBinDialogKeydown() {
  if (!recycleBinDialogState.keydownHandler) {
    return;
  }
  document.removeEventListener("keydown", recycleBinDialogState.keydownHandler, true);
  recycleBinDialogState.keydownHandler = null;
}

function focusRecycleBinDialog() {
  if (!dom.recycleBinDialog) {
    return;
  }
  window.requestAnimationFrame(() => {
    const focusable = recycleBinModalFocusableElements();
    if (focusable.length > 0) {
      focusable[0].focus();
    } else {
      dom.recycleBinDialog.focus();
    }
  });
}

function openRecycleBinModal(options = {}) {
  if (!dom.recycleBinModal || !dom.recycleBinDialog) {
    return;
  }
  const { focus = true } = options;
  suspendAutoRefresh();
  if (dom.recycleBinOpen) {
    dom.recycleBinOpen.setAttribute("aria-expanded", "true");
  }
  if (recycleBinDialogState.open) {
    if (focus) {
      focusRecycleBinDialog();
    }
    fetchRecycleBin({ silent: false });
    return;
  }
  recycleBinDialogState.open = true;
  state.recycleBin.open = true;
  recycleBinDialogState.previewing = false;
  recycleBinDialogState.previousRecord = null;
  recycleBinDialogState.previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  setRecycleBinModalVisible(true);
  attachRecycleBinDialogKeydown();
  fetchRecycleBin({ silent: false });
  if (focus) {
    focusRecycleBinDialog();
  }
}

function closeRecycleBinModal(options = {}) {
  if (!recycleBinDialogState.open) {
    return;
  }
  const { restoreFocus = true } = options;
  const shouldRefreshRecordings = recordingsRefreshDeferred;
  recordingsRefreshDeferred = false;
  recycleBinDialogState.open = false;
  state.recycleBin.open = false;
  setRecycleBinModalVisible(false);
  detachRecycleBinDialogKeydown();
  if (dom.recycleBinOpen) {
    dom.recycleBinOpen.setAttribute("aria-expanded", "false");
  }
  restoreRecycleBinPreview();
  if (shouldRefreshRecordings) {
    fetchRecordings({ silent: true, force: true });
  }
  resumeAutoRefresh();
  const previous = recycleBinDialogState.previouslyFocused;
  recycleBinDialogState.previouslyFocused = null;
  if (restoreFocus && previous && typeof previous.focus === "function") {
    previous.focus();
  }
}

function restoreRecycleBinPreview() {
  if (!recycleBinDialogState.previewing) {
    return;
  }
  recycleBinDialogState.previewing = false;
  const previous = recycleBinDialogState.previousRecord || null;
  recycleBinDialogState.previousRecord = null;
  if (isRecycleBinRecord(state.current)) {
    if (previous) {
      setNowPlaying(previous, { autoplay: false, resetToStart: false });
    } else {
      setNowPlaying(null, { autoplay: false, resetToStart: true });
    }
  }
}

function updateRecycleBinControls() {
  const selectedCount = state.recycleBin.selected.size;
  const totalCount = state.recycleBin.items.length;
  if (dom.recycleBinTotalCount) {
    dom.recycleBinTotalCount.textContent = totalCount.toString();
  }
  if (dom.recycleBinSelectedCount) {
    dom.recycleBinSelectedCount.textContent = selectedCount.toString();
  }
  if (dom.recycleBinRestore) {
    dom.recycleBinRestore.disabled =
      !selectedCount || state.recycleBin.loading || state.recycleBin.items.length === 0;
  }
  if (dom.recycleBinPurge) {
    dom.recycleBinPurge.disabled =
      !selectedCount || state.recycleBin.loading || state.recycleBin.items.length === 0;
  }
  if (dom.recycleBinRefresh) {
    dom.recycleBinRefresh.disabled = state.recycleBin.loading;
  }
  if (dom.recycleBinToggleAll) {
    const total = state.recycleBin.items.length;
    const selected = selectedCount;
    dom.recycleBinToggleAll.disabled = total === 0;
    dom.recycleBinToggleAll.checked = total > 0 && selected === total;
    dom.recycleBinToggleAll.indeterminate = selected > 0 && selected < total;
  }
}

function updateRecycleBinPreview() {
  if (!state.recycleBin.open) {
    return;
  }
  const item = getRecycleBinItem(state.recycleBin.activeId);
  if (!item) {
    restoreRecycleBinPreview();
    return;
  }
  const row = getRecycleBinRow(item.id);
  if (!row) {
    return;
  }
  if (!recycleBinDialogState.previewing) {
    recycleBinDialogState.previousRecord = isRecycleBinRecord(state.current)
      ? null
      : state.current;
    recycleBinDialogState.previewing = true;
  }
  if (isRecycleBinRecord(state.current) && state.current.recycleBinId === item.id) {
    placePlayerCard(state.current, row);
    return;
  }
  const record = recycleBinRecordFromItem(item);
  if (!record) {
    return;
  }
  setNowPlaying(record, { autoplay: false, resetToStart: true, sourceRow: row });
}

function renderRecycleBinItems() {
  if (!dom.recycleBinTableBody) {
    return;
  }
  dom.recycleBinTableBody.textContent = "";
  const fragment = document.createDocumentFragment();
  for (const item of state.recycleBin.items) {
    if (!item || typeof item.id !== "string" || !item.id) {
      continue;
    }
    const row = document.createElement("tr");
    row.dataset.id = item.id;
    row.dataset.restorable = item.restorable === false ? "false" : "true";
    const isSelected = state.recycleBin.selected.has(item.id);
    const isActive = state.recycleBin.activeId === item.id;
    const isMotion = isMotionTriggeredEvent(item);
    if (isSelected) {
      row.dataset.selected = "true";
    } else {
      delete row.dataset.selected;
    }
    if (isActive) {
      row.dataset.active = "true";
    } else {
      delete row.dataset.active;
    }
    if (isMotion) {
      row.dataset.motion = "true";
    } else {
      delete row.dataset.motion;
    }

    const checkboxCell = document.createElement("td");
    checkboxCell.className = "checkbox-cell";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = isSelected;
    checkbox.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!(event instanceof MouseEvent)) {
        return;
      }
      if (event.shiftKey && typeof state.recycleBin.anchorId === "string" && state.recycleBin.anchorId) {
        event.preventDefault();
        const shouldSelect = !checkbox.checked;
        const changed = applyRecycleBinRangeSelection(state.recycleBin.anchorId, item.id, shouldSelect);
        state.recycleBin.anchorId = item.id;
        checkbox.checked = state.recycleBin.selected.has(item.id);
        if (changed) {
          if (
            !shouldSelect &&
            typeof state.recycleBin.activeId === "string" &&
            state.recycleBin.activeId &&
            !state.recycleBin.selected.has(state.recycleBin.activeId)
          ) {
            state.recycleBin.activeId = "";
          }
          persistRecycleBinState();
          renderRecycleBinItems();
        }
        return;
      }
      state.recycleBin.anchorId = item.id;
    });
    checkbox.addEventListener("change", () => {
      const updated = new Set(state.recycleBin.selected);
      if (checkbox.checked) {
        updated.add(item.id);
      } else {
        updated.delete(item.id);
        if (state.recycleBin.activeId === item.id) {
          state.recycleBin.activeId = "";
        }
      }
      state.recycleBin.selected = updated;
      state.recycleBin.anchorId = item.id;
      persistRecycleBinState();
      renderRecycleBinItems();
    });
    checkboxCell.append(checkbox);
    row.append(checkboxCell);

    const nameCell = document.createElement("td");
    const displayName = item.name && item.name.trim() ? item.name : item.original_path || item.id;
    const nameWrapper = document.createElement("div");
    nameWrapper.className = "recycle-bin-name";
    const nameText = document.createElement("span");
    nameText.className = "recycle-bin-name-text";
    nameText.textContent = displayName;
    nameWrapper.append(nameText);
    if (isMotion) {
      const motionBadge = document.createElement("span");
      motionBadge.className = "badge badge-motion";
      motionBadge.textContent = "Motion";
      nameWrapper.append(motionBadge);
    }
    nameCell.append(nameWrapper);
    if (item.original_path) {
      nameCell.title = item.original_path;
    }
    row.append(nameCell);

    const lengthCell = document.createElement("td");
    if (typeof item.duration_seconds === "number" && Number.isFinite(item.duration_seconds)) {
      lengthCell.textContent = formatDuration(item.duration_seconds);
    } else {
      lengthCell.textContent = "--";
    }
    row.append(lengthCell);

    const labelCell = document.createElement("td");
    labelCell.className = "recycle-bin-label-cell";
    if (item.autoMoved) {
      const autoLabel = document.createElement("span");
      autoLabel.className = "badge recycle-bin-auto-label";
      autoLabel.textContent = "Auto (short clip)";
      labelCell.append(autoLabel);
    }
    if (item.restorable === false) {
      const conflict = document.createElement("span");
      conflict.className = "recycle-bin-conflict";
      conflict.textContent = "In use";
      labelCell.append(conflict);
    }
    row.append(labelCell);

    const deletedCell = document.createElement("td");
    deletedCell.textContent = formatIsoDateTime(item.deleted_at) || "--";
    row.append(deletedCell);

    const sizeCell = document.createElement("td");
    sizeCell.textContent = formatBytes(Number(item.size_bytes) || 0);
    row.append(sizeCell);

    row.addEventListener("click", (event) => {
      if (event.target instanceof HTMLElement) {
        if (event.target.closest("input, button, a")) {
          return;
        }
      }
      state.recycleBin.selected = new Set([item.id]);
      state.recycleBin.activeId = item.id;
      state.recycleBin.anchorId = item.id;
      persistRecycleBinState();
      renderRecycleBinItems();
    });

    fragment.append(row);
  }
  dom.recycleBinTableBody.append(fragment);
  if (dom.recycleBinEmpty) {
    dom.recycleBinEmpty.hidden = state.recycleBin.items.length !== 0;
  }
  updateRecycleBinControls();
  updateRecycleBinPreview();
}

async function fetchRecycleBin(options = {}) {
  const { silent = false } = options;
  if (state.recycleBin.loading) {
    return;
  }
  state.recycleBin.loading = true;
  updateRecycleBinControls();
  try {
    const response = await apiClient.fetch(apiPath("/api/recycle-bin"));
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    const rawItems = Array.isArray(payload.items) ? payload.items : [];
    const normalized = [];
    for (const entry of rawItems) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const idValue = typeof entry.id === "string" ? entry.id.trim() : "";
      if (!idValue) {
        continue;
      }
      const sizeValue = Number(entry.size_bytes);
      const rawDuration = entry.duration_seconds;
      const durationValue = typeof rawDuration === "number" ? rawDuration : null;
      const { startEpoch, startedEpoch, startedAt } = normalizeStartTimestamps(entry);
      const reason =
        typeof entry.reason === "string" && entry.reason ? entry.reason.trim() : "";
      const autoMoved = reason === "short_clip";

      normalized.push({
        id: idValue,
        name: typeof entry.name === "string" ? entry.name : "",
        original_path: typeof entry.original_path === "string" ? entry.original_path : "",
        deleted_at: typeof entry.deleted_at === "string" ? entry.deleted_at : "",
        deleted_at_epoch: Number.isFinite(Number(entry.deleted_at_epoch))
          ? Number(entry.deleted_at_epoch)
          : null,
        size_bytes: Number.isFinite(sizeValue) && sizeValue >= 0 ? sizeValue : 0,
        duration_seconds:
          typeof durationValue === "number" && Number.isFinite(durationValue) && durationValue > 0
            ? durationValue
            : null,
        restorable: entry.restorable !== false,
        extension:
          typeof entry.extension === "string" && entry.extension ? entry.extension : "",
        waveform_available: entry.waveform_available !== false && Boolean(entry.waveform_available),
        start_epoch: startEpoch,
        started_epoch: startedEpoch,
        started_at: startedAt,
        reason,
        autoMoved,
        motion_trigger_offset_seconds: toFiniteOrNull(entry.motion_trigger_offset_seconds),
        motion_release_offset_seconds: toFiniteOrNull(entry.motion_release_offset_seconds),
        motion_started_epoch: toFiniteOrNull(entry.motion_started_epoch),
        motion_released_epoch: toFiniteOrNull(entry.motion_released_epoch),
      });
    }

    const previousSelected = new Set(state.recycleBin.selected);
    state.recycleBin.items = normalized;
    const nextSelected = new Set();
    for (const id of previousSelected) {
      if (recycleBinContainsId(id)) {
        nextSelected.add(id);
      }
    }
    state.recycleBin.selected = nextSelected;
    const hadActive = typeof state.recycleBin.activeId === "string" && state.recycleBin.activeId;
    if (!recycleBinContainsId(state.recycleBin.activeId)) {
      if (hadActive && nextSelected.size > 0) {
        const nextValue = nextSelected.values().next().value;
        state.recycleBin.activeId = typeof nextValue === "string" ? nextValue : "";
      } else if (hadActive) {
        state.recycleBin.activeId = "";
      }
    }
    if (!recycleBinContainsId(state.recycleBin.anchorId)) {
      if (nextSelected.size > 0) {
        let replacement = "";
        for (const value of nextSelected.values()) {
          replacement = value;
        }
        state.recycleBin.anchorId = typeof replacement === "string" ? replacement : "";
      } else if (state.recycleBin.activeId && recycleBinContainsId(state.recycleBin.activeId)) {
        state.recycleBin.anchorId = state.recycleBin.activeId;
      } else {
        state.recycleBin.anchorId = "";
      }
    }
    persistRecycleBinState();
    renderRecycleBinItems();
  } catch (error) {
    console.error("Unable to load recycle bin", error);
    const offline = ensureOfflineStateOnError(error, handleFetchFailure);
    if (!silent) {
      const message = offline
        ? "Recorder unreachable. Unable to load recycle bin entries."
        : "Unable to load recycle bin entries.";
      window.alert(message);
    }
  } finally {
    state.recycleBin.loading = false;
    updateRecycleBinControls();
  }
}

async function restoreRecycleBinSelection() {
  if (state.recycleBin.loading) {
    return;
  }
  const ids = Array.from(state.recycleBin.selected);
  if (ids.length === 0) {
    return;
  }
  state.recycleBin.loading = true;
  updateRecycleBinControls();
  try {
    const response = await apiClient.fetch(apiPath("/api/recycle-bin/restore"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: ids }),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    const restored = Array.isArray(payload.restored) ? payload.restored : [];
    const errors = Array.isArray(payload.errors) ? payload.errors : [];
    if (errors.length > 0) {
      const message = errors
        .map((entry) => {
          const item = typeof entry?.item === "string" ? entry.item : "";
          const errorText = typeof entry?.error === "string" ? entry.error : "unknown error";
          return item ? `${item}: ${errorText}` : errorText;
        })
        .join("\n");
      if (message) {
        window.alert(`Some recordings could not be restored:\n${message}`);
      }
    }
    if (restored.length === 0 && errors.length > 0) {
      return;
    }
    state.recycleBin.selected = new Set();
    state.recycleBin.activeId = "";
    state.recycleBin.anchorId = "";
    persistRecycleBinState();
    state.recycleBin.loading = false;
    updateRecycleBinControls();
    await fetchRecycleBin({ silent: false });
    fetchRecordings({ silent: false, force: true });
  } catch (error) {
    console.error("Unable to restore recycle bin entries", error);
    window.alert("Unable to restore selected recordings.");
  } finally {
    state.recycleBin.loading = false;
    updateRecycleBinControls();
  }
}

async function purgeRecycleBinSelection() {
  if (state.recycleBin.loading) {
    return;
  }
  const ids = Array.from(state.recycleBin.selected);
  if (ids.length === 0) {
    return;
  }
  const confirmed = await confirmRecycleBinPurgePrompt(ids.length);
  if (!confirmed) {
    return;
  }

  state.recycleBin.loading = true;
  updateRecycleBinControls();

  let shouldReload = false;
  try {
    const response = await apiClient.fetch(apiPath("/api/recycle-bin/purge"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: ids }),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    const purged = Array.isArray(payload.purged) ? payload.purged : [];
    const errors = Array.isArray(payload.errors) ? payload.errors : [];

    if (errors.length > 0) {
      const message = errors
        .map((entry) => {
          const item = typeof entry?.item === "string" ? entry.item : "";
          const errorText = typeof entry?.error === "string" ? entry.error : "unknown error";
          return item ? `${item}: ${errorText}` : errorText;
        })
        .join("\n");
      if (message) {
        window.alert(`Some recordings could not be deleted:\n${message}`);
      }
    }

    if (purged.length > 0) {
      state.recycleBin.selected = new Set();
      state.recycleBin.activeId = "";
      state.recycleBin.anchorId = "";
      persistRecycleBinState();
    }

    shouldReload = purged.length > 0 || errors.length > 0;
  } catch (error) {
    console.error("Unable to purge recycle bin entries", error);
    window.alert("Unable to delete selected recordings permanently.");
  } finally {
    state.recycleBin.loading = false;
    updateRecycleBinControls();
  }

  if (shouldReload) {
    await fetchRecycleBin({ silent: false });
    fetchRecordings({ silent: false, force: true });
  }
}

async function requestRecordDeletion(record, options = {}) {
  const { bypassConfirm = false } = options;
  if (!record || typeof record.path !== "string" || record.path.trim() === "") {
    return;
  }

  if (!bypassConfirm) {
    const baseName =
      typeof record.name === "string" && record.name ? record.name : record.path;
    const extLabel = record.extension ? `.${record.extension}` : "";
    const confirmed = await confirmDeletionPrompt(
      `Delete ${baseName}${extLabel}?`,
      "Delete recording",
    );
    if (!confirmed) {
      return;
    }
  }

  await deleteRecordings([record.path]);
}

function findNextSelectionPath(paths) {
  if (!state.current || !Array.isArray(paths) || paths.length !== 1) {
    return null;
  }

  const [targetPath] = paths;
  if (typeof targetPath !== "string" || targetPath !== state.current.path) {
    return null;
  }

  const visible = getVisibleRecords();
  if (!visible.length) {
    return null;
  }

  const currentIndex = visible.findIndex((record) => record.path === targetPath);
  if (currentIndex === -1) {
    return null;
  }

  for (let index = currentIndex + 1; index < visible.length; index += 1) {
    const candidate = visible[index];
    if (candidate.path !== targetPath) {
      return candidate.path;
    }
  }

  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const candidate = visible[index];
    if (candidate.path !== targetPath) {
      return candidate.path;
    }
  }

  return null;
}

async function deleteRecordings(paths) {
  if (!paths || !paths.length) {
    return;
  }
  const nextSelectionPath = findNextSelectionPath(paths);
  try {
  const response = await apiClient.fetch(apiPath("/api/recordings/delete"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ items: paths }),
    });
    if (!response.ok) {
      throw new Error(`Delete failed with status ${response.status}`);
    }
    const payload = await response.json();
    const deleted = Array.isArray(payload.deleted) ? payload.deleted : [];
    if (
      nextSelectionPath &&
      paths.length === 1 &&
      typeof paths[0] === "string" &&
      deleted.includes(paths[0])
    ) {
      updatePendingSelectionPath(nextSelectionPath);
    }
    for (const path of deleted) {
      state.selections.delete(path);
      if (state.selectionAnchor === path) {
        state.selectionAnchor = "";
        if (state.selectionFocus === path) {
          state.selectionFocus = "";
        }
      }
      if (state.current && state.current.path === path) {
        setNowPlaying(null);
      }
    }
    if (Array.isArray(payload.errors) && payload.errors.length) {
      const message = payload.errors.map((entry) => `${entry.item}: ${entry.error}`).join("\n");
      window.alert(`Some files could not be deleted:\n${message}`);
    }
  } catch (error) {
    console.error("Deletion request failed", error);
    window.alert("Unable to delete selected recordings.");
  } finally {
    await fetchRecordings({ silent: false, force: true });
  }
}

function extractFilenameFromDisposition(disposition) {
  if (typeof disposition !== "string" || !disposition) {
    return null;
  }
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match && utf8Match[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch (error) {
      return utf8Match[1];
    }
  }
  const simpleMatch = disposition.match(/filename="?([^";]+)"?/i);
  if (simpleMatch && simpleMatch[1]) {
    return simpleMatch[1];
  }
  return null;
}

async function renameRecording(path, newName, options = {}) {
  if (typeof path !== "string" || !path || typeof newName !== "string" || !newName) {
    throw new Error("Invalid rename request");
  }
  const payload = {
    item: path,
    name: newName,
  };
  const extensionValue =
    options && typeof options.extension === "string" ? options.extension.trim() : "";
  if (extensionValue) {
    payload.extension = extensionValue;
  }

  const response = await apiClient.fetch(apiPath("/api/recordings/rename"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let message = `Rename failed with status ${response.status}`;
    try {
      const errorPayload = await response.json();
      if (typeof errorPayload.error === "string" && errorPayload.error) {
        message = errorPayload.error;
      } else if (Array.isArray(errorPayload.errors) && errorPayload.errors.length) {
        const combined = errorPayload.errors
          .map((entry) => {
            const item = typeof entry.item === "string" ? entry.item : "";
            const errorText = typeof entry.error === "string" ? entry.error : "";
            return item ? `${item}: ${errorText}` : errorText;
          })
          .filter(Boolean)
          .join("\n");
        if (combined) {
          message = combined;
        }
      }
    } catch (error) {
      // ignore parse errors
    }
    throw new Error(message);
  }

  const payloadJson = await response.json();
  const oldPath = typeof payloadJson.old_path === "string" ? payloadJson.old_path : path;
  const newPath = typeof payloadJson.new_path === "string" ? payloadJson.new_path : path;

  if (state.selections.has(oldPath)) {
    state.selections.delete(oldPath);
    state.selections.add(newPath);
  }
  if (state.selectionAnchor === oldPath) {
    state.selectionAnchor = newPath;
    state.selectionFocus = newPath;
  } else if (state.selectionFocus === oldPath) {
    state.selectionFocus = newPath;
  }
  if (state.current && state.current.path === oldPath) {
    updatePendingSelectionPath(newPath);
  }

  updateSelectionUI();
  await fetchRecordings({ silent: false, force: true });

  return payloadJson;
}

function applyFiltersFromInputs() {
  const search = dom.filterSearch ? dom.filterSearch.value.trim() : "";
  const day = dom.filterDay ? dom.filterDay.value.trim() : "";
  let timeRange = state.filters.timeRange;
  if (dom.filterTimeRange) {
    const raw = dom.filterTimeRange.value.trim();
    timeRange = VALID_TIME_RANGES.has(raw) ? raw : "";
  }
  let limit = state.filters.limit;
  if (dom.filterLimit) {
    const parsed = Number.parseInt(dom.filterLimit.value, 10);
    if (!Number.isNaN(parsed)) {
      limit = clampLimitValue(parsed);
    }
  }
  const nextFilters = {
    search,
    day,
    timeRange,
    limit: clampLimitValue(limit),
  };
  const changed =
    nextFilters.search !== state.filters.search ||
    nextFilters.day !== state.filters.day ||
    nextFilters.timeRange !== state.filters.timeRange ||
    nextFilters.limit !== state.filters.limit;

  state.filters = nextFilters;

  if (dom.filterSearch) {
    dom.filterSearch.value = nextFilters.search;
  }
  if (dom.filterDay && dom.filterDay.value !== nextFilters.day) {
    dom.filterDay.value = nextFilters.day;
  }
  if (dom.filterTimeRange && dom.filterTimeRange.value !== nextFilters.timeRange) {
    dom.filterTimeRange.value = nextFilters.timeRange;
  }
  if (dom.filterLimit) {
    dom.filterLimit.value = String(nextFilters.limit);
  }

  if (changed) {
    state.offset = 0;
  }

  persistFilters(state.filters);
}

function clearFilters() {
  if (dom.filterSearch) {
    dom.filterSearch.value = "";
  }
  if (dom.filterDay) {
    dom.filterDay.value = "";
