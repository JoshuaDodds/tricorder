export function createDashboardInitializer(deps = {}) {
  const {
    dom,
    state,
    themeManager,
    restoreFiltersFromStorage,
    restoreSortFromStorage,
    restoreFilterPanelPreference,
    setupResponsiveFilters,
    populateFilters,
    updateSelectionUI,
    updateSortIndicators,
    updatePaginationControls,
    resetWaveform,
    loadTransportPreferences,
    applyTransportPreferences,
    setTransportActive,
    resetTransportUi,
    restoreWaveformPreferences,
    clipper,
    setRecordingIndicatorUnknown,
    setLiveButtonState,
    setLiveStatus,
    setLiveToggleDisabled,
    setRecorderModalVisible,
    setConfigModalVisible,
    initializeWebServerDom,
    initializeArchivalDom,
    recorderState,
    updateRecorderConfigPath,
    registerRecorderSections,
    updateAudioFilterControls,
    setServicesModalVisible,
    attachEventListeners,
    initializeEventStream,
    updateTransportAvailability,
    renderRecorderUptime,
    fetchRecordings,
    fetchConfig,
    fetchWebServerSettings,
    fetchArchivalSettings,
    fetchSystemHealth,
    fetchServices,
    enablePollingFallback,
    eventStreamSupported,
  } = deps;

  if (!dom || typeof dom !== "object") {
    throw new Error("createDashboardInitializer requires DOM references");
  }
  if (!state || typeof state !== "object") {
    throw new Error("createDashboardInitializer requires dashboard state");
  }
  if (!themeManager || typeof themeManager.initialize !== "function") {
    throw new Error("createDashboardInitializer requires themeManager");
  }
  if (typeof restoreFiltersFromStorage !== "function") {
    throw new Error("createDashboardInitializer requires restoreFiltersFromStorage");
  }
  if (typeof restoreSortFromStorage !== "function") {
    throw new Error("createDashboardInitializer requires restoreSortFromStorage");
  }
  if (typeof restoreFilterPanelPreference !== "function") {
    throw new Error("createDashboardInitializer requires restoreFilterPanelPreference");
  }
  if (typeof setupResponsiveFilters !== "function") {
    throw new Error("createDashboardInitializer requires setupResponsiveFilters");
  }
  if (typeof populateFilters !== "function") {
    throw new Error("createDashboardInitializer requires populateFilters");
  }
  if (typeof updateSelectionUI !== "function") {
    throw new Error("createDashboardInitializer requires updateSelectionUI");
  }
  if (typeof updateSortIndicators !== "function") {
    throw new Error("createDashboardInitializer requires updateSortIndicators");
  }
  if (typeof updatePaginationControls !== "function") {
    throw new Error("createDashboardInitializer requires updatePaginationControls");
  }
  if (typeof resetWaveform !== "function") {
    throw new Error("createDashboardInitializer requires resetWaveform");
  }
  if (typeof loadTransportPreferences !== "function") {
    throw new Error("createDashboardInitializer requires loadTransportPreferences");
  }
  if (typeof applyTransportPreferences !== "function") {
    throw new Error("createDashboardInitializer requires applyTransportPreferences");
  }
  if (typeof setTransportActive !== "function") {
    throw new Error("createDashboardInitializer requires setTransportActive");
  }
  if (typeof resetTransportUi !== "function") {
    throw new Error("createDashboardInitializer requires resetTransportUi");
  }
  if (typeof restoreWaveformPreferences !== "function") {
    throw new Error("createDashboardInitializer requires restoreWaveformPreferences");
  }
  if (!clipper || typeof clipper.restorePreference !== "function") {
    throw new Error("createDashboardInitializer requires clipper");
  }
  if (typeof setRecordingIndicatorUnknown !== "function") {
    throw new Error("createDashboardInitializer requires setRecordingIndicatorUnknown");
  }
  if (typeof setLiveButtonState !== "function") {
    throw new Error("createDashboardInitializer requires setLiveButtonState");
  }
  if (typeof setLiveStatus !== "function") {
    throw new Error("createDashboardInitializer requires setLiveStatus");
  }
  if (typeof setLiveToggleDisabled !== "function") {
    throw new Error("createDashboardInitializer requires setLiveToggleDisabled");
  }
  if (typeof setRecorderModalVisible !== "function") {
    throw new Error("createDashboardInitializer requires setRecorderModalVisible");
  }
  if (typeof setConfigModalVisible !== "function") {
    throw new Error("createDashboardInitializer requires setConfigModalVisible");
  }
  if (typeof initializeWebServerDom !== "function") {
    throw new Error("createDashboardInitializer requires initializeWebServerDom");
  }
  if (typeof initializeArchivalDom !== "function") {
    throw new Error("createDashboardInitializer requires initializeArchivalDom");
  }
  if (!recorderState || typeof recorderState !== "object") {
    throw new Error("createDashboardInitializer requires recorderState");
  }
  if (typeof updateRecorderConfigPath !== "function") {
    throw new Error("createDashboardInitializer requires updateRecorderConfigPath");
  }
  if (typeof registerRecorderSections !== "function") {
    throw new Error("createDashboardInitializer requires registerRecorderSections");
  }
  if (typeof updateAudioFilterControls !== "function") {
    throw new Error("createDashboardInitializer requires updateAudioFilterControls");
  }
  if (typeof setServicesModalVisible !== "function") {
    throw new Error("createDashboardInitializer requires setServicesModalVisible");
  }
  if (typeof attachEventListeners !== "function") {
    throw new Error("createDashboardInitializer requires attachEventListeners");
  }
  if (typeof initializeEventStream !== "function") {
    throw new Error("createDashboardInitializer requires initializeEventStream");
  }
  if (typeof updateTransportAvailability !== "function") {
    throw new Error("createDashboardInitializer requires updateTransportAvailability");
  }
  if (typeof renderRecorderUptime !== "function") {
    throw new Error("createDashboardInitializer requires renderRecorderUptime");
  }
  if (typeof fetchRecordings !== "function") {
    throw new Error("createDashboardInitializer requires fetchRecordings");
  }
  if (typeof fetchConfig !== "function") {
    throw new Error("createDashboardInitializer requires fetchConfig");
  }
  if (typeof fetchWebServerSettings !== "function") {
    throw new Error("createDashboardInitializer requires fetchWebServerSettings");
  }
  if (typeof fetchArchivalSettings !== "function") {
    throw new Error("createDashboardInitializer requires fetchArchivalSettings");
  }
  if (typeof fetchSystemHealth !== "function") {
    throw new Error("createDashboardInitializer requires fetchSystemHealth");
  }
  if (typeof fetchServices !== "function") {
    throw new Error("createDashboardInitializer requires fetchServices");
  }
  if (typeof enablePollingFallback !== "function") {
    throw new Error("createDashboardInitializer requires enablePollingFallback");
  }

  function initialize() {
    themeManager.initialize();
    state.filters = restoreFiltersFromStorage(state.filters);
    restoreSortFromStorage(dom.sortButtons, state.sort);
    restoreFilterPanelPreference();
    setupResponsiveFilters();
    populateFilters();
    updateSelectionUI();
    updateSortIndicators();
    updatePaginationControls();
    resetWaveform();
    loadTransportPreferences();
    applyTransportPreferences();
    setTransportActive(false);
    resetTransportUi();
    restoreWaveformPreferences();
    clipper.restorePreference();
    clipper.setVisible(false);
    setRecordingIndicatorUnknown("Loading status…");
    setLiveButtonState(false);
    setLiveStatus("Idle");
    setLiveToggleDisabled(true, "Checking recorder service status…");
    setRecorderModalVisible(false);
    setConfigModalVisible(false);
    initializeWebServerDom();
    initializeArchivalDom();
    updateRecorderConfigPath(recorderState.configPath);
    registerRecorderSections();
    updateAudioFilterControls();
    setServicesModalVisible(false);
    attachEventListeners();
    initializeEventStream();
    updateTransportAvailability();
    renderRecorderUptime();
    fetchRecordings({ silent: false });
    fetchConfig({ silent: false });
    fetchWebServerSettings({ silent: true });
    fetchArchivalSettings({ silent: true });
    fetchSystemHealth();
    fetchServices({ silent: true });
    if (!eventStreamSupported) {
      enablePollingFallback();
    }
  }

  return { initialize };
}
