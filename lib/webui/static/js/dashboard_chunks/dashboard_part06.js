  }
  if (dom.playbackSourceRaw) {
    dom.playbackSourceRaw.addEventListener("click", () => {
      setPlaybackSource("raw", { userInitiated: true });
    });
  }

  applyPlaybackSourceUi();

  if (dom.clipperSetStart) {
    dom.clipperSetStart.addEventListener("click", () => {
      clipper.setStartFromPlayhead();
    });
  }

  if (dom.clipperSetEnd) {
    dom.clipperSetEnd.addEventListener("click", () => {
      clipper.setEndFromPlayhead();
    });
  }

  if (dom.clipperReset) {
    dom.clipperReset.addEventListener("click", clipper.handleReset);
  }

  if (dom.clipperUndo) {
    dom.clipperUndo.addEventListener("click", clipper.handleUndo);
  }

  if (dom.clipperStartInput) {
    dom.clipperStartInput.addEventListener("change", clipper.handleStartChange);
  }

  if (dom.clipperEndInput) {
    dom.clipperEndInput.addEventListener("change", clipper.handleEndChange);
  }

  if (dom.clipperNameInput) {
    dom.clipperNameInput.addEventListener("input", clipper.handleNameInput);
    dom.clipperNameInput.addEventListener("blur", clipper.handleNameBlur);
  }

  if (dom.clipperOverwriteToggle) {
    dom.clipperOverwriteToggle.addEventListener("change", clipper.handleOverwriteChange);
  }

  if (dom.recordingsTabRecent) {
    dom.recordingsTabRecent.addEventListener("click", () => {
      setCollection("recent");
    });
  }

  if (dom.recordingsTabSaved) {
    dom.recordingsTabSaved.addEventListener("click", () => {
      setCollection("saved");
    });
  }

  if (dom.clipperForm) {
    dom.clipperForm.addEventListener("submit", clipper.submitForm);
  }

  if (dom.clipperToggle) {
    dom.clipperToggle.addEventListener("click", () => {
      const next = !clipper.state.enabled;
      clipper.setEnabled(next, { focus: next });
    });
  }

  if (dom.splitEvent) {
    dom.splitEvent.addEventListener("click", () => {
      requestSplitEvent();
    });
  }

  if (dom.autoToggle) {
    setAutoRecordButtonState(autoRecordState.enabled);
    setAutoRecordDisabled(true, "Recorder status unavailable.");
    dom.autoToggle.addEventListener("click", async () => {
      if (autoRecordState.pending || dom.autoToggle.disabled) {
        return;
      }
      const nextEnabled = !autoRecordState.enabled;
      const pendingMessage = nextEnabled
        ? "Enabling auto capture…"
        : "Pausing auto capture…";
      setAutoRecordPending(true, pendingMessage);
      try {
        const response = await apiClient.fetch(AUTO_RECORD_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: nextEnabled }),
        });
        if (!response.ok) {
          let message = `Auto capture request failed (status ${response.status})`;
          try {
            const errorPayload = await response.json();
            if (errorPayload && typeof errorPayload === "object") {
              if (typeof errorPayload.error === "string" && errorPayload.error) {
                message = errorPayload.error;
              } else if (typeof errorPayload.reason === "string" && errorPayload.reason) {
                message = errorPayload.reason;
              }
            }
          } catch (jsonError) {
            try {
              const text = await response.text();
              if (text && text.trim()) {
                message = text.trim();
              }
            } catch (textError) {
              /* ignore text parse errors */
            }
          }
          throw new Error(message);
        }
        let enabledResult = nextEnabled;
        try {
          const payload = await response.json();
          if (payload && typeof payload === "object" && "enabled" in payload) {
            enabledResult = parseBoolean(payload.enabled);
          }
        } catch (parseError) {
          enabledResult = nextEnabled;
        }
        autoRecordState.enabled = Boolean(enabledResult);
        autoRecordState.reason = "";
        setAutoRecordButtonState(autoRecordState.enabled);
        updateAutoRecordButton(state.captureStatus);
      } catch (autoError) {
        const message =
          autoError instanceof Error && autoError.message
            ? autoError.message
            : "Auto capture toggle failed";
        console.error("Auto record toggle failed", autoError);
        setAutoRecordPending(false);
        autoRecordState.pending = false;
        autoRecordState.reason = "";
        if (dom.autoToggle) {
          dom.autoToggle.removeAttribute("aria-busy");
          dom.autoToggle.title = message;
        }
        return;
      }
      setAutoRecordPending(false);
    });
  }

  if (dom.manualToggle) {
    dom.manualToggle.addEventListener("click", async () => {
      if (manualRecordState.pending || dom.manualToggle.disabled) {
        return;
      }
      const nextEnabled = !manualRecordState.enabled;
      const pendingMessage = nextEnabled
        ? "Enabling manual recording…"
        : "Stopping manual recording…";
      setManualRecordPending(true, pendingMessage);
      try {
        const response = await apiClient.fetch(MANUAL_RECORD_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: nextEnabled }),
        });
        if (!response.ok) {
          let message = `Manual record request failed (status ${response.status})`;
          try {
            const errorPayload = await response.json();
            if (errorPayload && typeof errorPayload === "object") {
              if (typeof errorPayload.error === "string" && errorPayload.error) {
                message = errorPayload.error;
              } else if (typeof errorPayload.reason === "string" && errorPayload.reason) {
                message = errorPayload.reason;
              }
            }
          } catch (jsonError) {
            try {
              const text = await response.text();
              if (text && text.trim()) {
                message = text.trim();
              }
            } catch (textError) {
              /* ignore text parse errors */
            }
          }
          throw new Error(message);
        }
        let enabledResult = nextEnabled;
        try {
          const payload = await response.json();
          if (payload && typeof payload === "object" && "enabled" in payload) {
            enabledResult = parseBoolean(payload.enabled);
          }
        } catch (parseError) {
          enabledResult = nextEnabled;
        }
        manualRecordState.enabled = Boolean(enabledResult);
        manualRecordState.reason = "";
        setManualRecordButtonState(manualRecordState.enabled);
        updateAutoRecordButton(state.captureStatus);
        updateManualRecordButton(state.captureStatus);
      } catch (manualError) {
        const message =
          manualError instanceof Error && manualError.message
            ? manualError.message
            : "Manual record toggle failed";
        console.error("Manual record toggle failed", manualError);
        setManualRecordPending(false);
        manualRecordState.pending = false;
        manualRecordState.reason = "";
        if (dom.manualToggle) {
          dom.manualToggle.removeAttribute("aria-busy");
          dom.manualToggle.title = message;
        }
        return;
      }
      setManualRecordPending(false);
    });
  }

  if (dom.liveToggle) {
    dom.liveToggle.addEventListener("click", () => {
      if (liveState.open) {
        closeLiveStreamPanel();
      } else {
        openLiveStreamPanel();
      }
    });
  }

  if (dom.liveClose) {
    dom.liveClose.addEventListener("click", () => {
      closeLiveStreamPanel();
    });
  }

  if (dom.previewClose) {
    dom.previewClose.addEventListener("click", () => {
      setNowPlaying(null);
    });
  }

  if (dom.playerRename) {
    dom.playerRename.addEventListener("click", () => {
      if (isRenameDialogPending() || !state.current) {
        return;
      }
      openRenameDialog(state.current);
    });
  }

  if (dom.playerDelete) {
    dom.playerDelete.addEventListener("click", async () => {
      if (!state.current) {
        return;
      }
      await requestRecordDeletion(state.current);
    });
  }

  if (dom.playerCard) {
    dom.playerCard.addEventListener("keydown", handlePreviewKeydown);
    dom.playerCard.addEventListener("pointerdown", (event) => {
      if (findInteractiveElement(event.target, event)) {
        return;
      }
      focusPreviewSurface();
    });
  }

  if (dom.liveAudio) {
    dom.liveAudio.addEventListener("playing", () => {
      playbackState.pausedViaSpacebar.delete(dom.liveAudio);
      if (liveState.open) {
        setLiveStatus("Live");
      }
    });
    dom.liveAudio.addEventListener("waiting", () => {
      if (liveState.open) {
        setLiveStatus("Buffering…");
      }
    });
    dom.liveAudio.addEventListener("pause", () => {
      if (!liveState.open) {
        return;
      }
      if (liveState.active) {
        setLiveStatus("Paused");
      } else {
        setLiveStatus("Idle");
      }
    });
    dom.liveAudio.addEventListener("error", () => {
      setLiveStatus("Unavailable");
    });
    dom.liveAudio.addEventListener("stalled", () => {
      if (liveState.open) {
        setLiveStatus("Buffering…");
      }
    });
    dom.liveAudio.addEventListener("ended", () => {
      playbackState.pausedViaSpacebar.delete(dom.liveAudio);
    });
    const handleLivePointerReset = () => {
      focusState.livePointer = false;
    };
    dom.liveAudio.addEventListener("pointerdown", () => {
      focusState.livePointer = true;
    });
    dom.liveAudio.addEventListener("pointerup", handleLivePointerReset);
    dom.liveAudio.addEventListener("pointercancel", handleLivePointerReset);
    dom.liveAudio.addEventListener("focus", () => {
      if (!focusState.livePointer) {
        return;
      }
      focusState.livePointer = false;
      window.requestAnimationFrame(() => {
        if (!focusLiveStreamPanel()) {
          try {
            dom.liveAudio.blur();
          } catch (error) {
            /* ignore blur errors */
          }
        }
      });
    });
    dom.liveAudio.addEventListener("blur", handleLivePointerReset);
  }

  window.addEventListener("beforeunload", () => {
    stopAutoRefresh();
    stopServicesRefresh();
    stopHealthRefresh();
    stopConfigRefresh();
    closeEventStream();
    if (liveState.open || liveState.active) {
      stopLiveStream({ sendSignal: true, useBeacon: true });
    }
  });

  window.addEventListener("pagehide", () => {
    stopAutoRefresh();
    stopServicesRefresh();
    stopHealthRefresh();
    stopConfigRefresh();
    closeEventStream();
    if (liveState.open || liveState.active) {
      stopLiveStream({ sendSignal: true, useBeacon: true });
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      stopAutoRefresh();
      stopServicesRefresh();
      stopHealthRefresh();
      stopConfigRefresh();
      if (liveState.open && liveState.active) {
        cancelLiveStats();
      }
    } else {
      startAutoRefresh();
      startServicesRefresh();
      startHealthRefresh();
      startConfigRefresh();
      fetchServices({ silent: true });
      fetchConfig({ silent: true });
      if (liveState.open && liveState.active) {
        scheduleLiveStats();
        if (dom.liveAudio) {
          dom.liveAudio.play().catch(() => undefined);
        }
      }
    }
    refreshTabRecordingTitleIndicator();
  });

  if (mobileLayoutQuery) {
    const handleLayoutChange = () => {
      syncPlayerPlacement();
    };
    if (typeof mobileLayoutQuery.addEventListener === "function") {
      mobileLayoutQuery.addEventListener("change", handleLayoutChange);
    } else if (typeof mobileLayoutQuery.addListener === "function") {
      mobileLayoutQuery.addListener(handleLayoutChange);
    }
  }
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
  if (!EVENT_STREAM_SUPPORTED) {
    enablePollingFallback();
  }
}

const dashboardPublicApi = {
  renderRecords,
  setRecordingIndicatorStatus,
  __setEventStreamConnectedForTests,
  requestRecordingsRefresh,
  updateSelectionUI,
  applyNowPlayingHighlight,
  syncPlayerPlacement,
  updateRmsIndicator,
  updateRecordingMeta,
  updateEncodingStatus,
  updateSplitEventButton,
  updateAutoRecordButton,
  updateManualRecordButton,
  applyCaptureStatusPush,
  resolveNextMotionState,
  isMotionTriggeredEvent,
  resolveSelectionAnchor,
  applySelectionRange,
  updatePlaybackSourceForRecord,
  getPlaybackSourceState,
  setPlaybackSource,
};

if (typeof window !== "undefined") {
  Object.assign(window, dashboardPublicApi);
}

export {
  renderRecords,
  setRecordingIndicatorStatus,
  __setEventStreamConnectedForTests,
  requestRecordingsRefresh,
  updateSelectionUI,
  applyNowPlayingHighlight,
  syncPlayerPlacement,
  updateRmsIndicator,
  updateRecordingMeta,
  updateEncodingStatus,
  updateSplitEventButton,
  updateAutoRecordButton,
  updateManualRecordButton,
  applyCaptureStatusPush,
  resolveNextMotionState,
  isMotionTriggeredEvent,
  resolveSelectionAnchor,
  applySelectionRange,
  updatePlaybackSourceForRecord,
  getPlaybackSourceState,
  setPlaybackSource,
};

let hasInitialized = false;

function initializeOnce() {
  if (hasInitialized) {
    return dashboardPublicApi;
  }
  hasInitialized = true;
  initialize();
  return dashboardPublicApi;
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeOnce, { once: true });
  } else {
    initializeOnce();
  }
} else {
  initializeOnce();
}

function bootstrapDashboard() {
  return initializeOnce();
}

export { bootstrapDashboard };
export default bootstrapDashboard;
