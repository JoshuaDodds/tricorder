      transcriptionSection.modelApply.addEventListener("click", () => {
        applySelectedTranscriptionModel();
      });
    }
    if (transcriptionSection.modelDismiss instanceof HTMLButtonElement) {
      transcriptionSection.modelDismiss.addEventListener("click", () => {
        transcriptionModelState.models = [];
        hideTranscriptionModelDiscovery();
        setTranscriptionModelStatus("", "info");
      });
    }
    if (transcriptionSection.modelOptions instanceof HTMLSelectElement) {
      transcriptionSection.modelOptions.addEventListener("change", () => {
        const value = transcriptionSection.modelOptions.value;
        const selected = transcriptionModelState.models.find((entry) => entry && entry.path === value);
        if (selected && selected.label) {
          setTranscriptionModelStatus(`Selected ${selected.label}.`, "info");
        } else {
          setTranscriptionModelStatus("", "info");
        }
      });
      transcriptionSection.modelOptions.addEventListener("dblclick", () => {
        applySelectedTranscriptionModel();
      });
    }
  }

  if (dom.filtersPanel) {
    const handleFiltersFocusOut = (event) => {
      const next =
        event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null;
      if (next && dom.filtersPanel.contains(next)) {
        return;
      }
      window.requestAnimationFrame(() => {
        const active =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        if (!active || !dom.filtersPanel.contains(active)) {
          resumeAutoRefresh();
        }
      });
    };

    dom.filtersPanel.addEventListener("focusin", suspendAutoRefresh);
    dom.filtersPanel.addEventListener("pointerdown", suspendAutoRefresh);
    dom.filtersPanel.addEventListener("focusout", handleFiltersFocusOut);
  }

  dom.applyFilters.addEventListener("click", () => {
    applyFiltersFromInputs();
    state.selections.clear();
    state.selectionAnchor = "";
    state.selectionFocus = "";
    fetchRecordings({ silent: false, force: true });
    updateSelectionUI();
    resumeAutoRefresh();
  });

  dom.filterSearch.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      dom.applyFilters.click();
    }
  });

  dom.clearFilters.addEventListener("click", () => {
    clearFilters();
    state.selections.clear();
    state.selectionAnchor = "";
    state.selectionFocus = "";
    fetchRecordings({ silent: false, force: true });
    updateSelectionUI();
    resumeAutoRefresh();
  });

  if (dom.themeToggle) {
    dom.themeToggle.addEventListener("click", () => {
      themeManager.toggle();
    });
  }

  if (dom.appMenuToggle && dom.appMenu) {
    dom.appMenuToggle.addEventListener("click", () => {
      toggleAppMenu();
    });
    dom.appMenuToggle.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        openAppMenu();
      } else if (event.key === "Escape" && isAppMenuOpen()) {
        event.preventDefault();
        closeAppMenu();
      }
    });
  }

  if (recorderDom.menuItems && typeof recorderDom.menuItems.length === "number") {
    for (const item of recorderDom.menuItems) {
      if (!(item instanceof HTMLElement)) {
        continue;
      }
      item.addEventListener("click", () => {
        const section = item.getAttribute("data-recorder-section") || "";
        closeAppMenu({ restoreFocus: false });
        openRecorderDialog({ section });
      });
    }
  }

  if (recorderDom.close) {
    recorderDom.close.addEventListener("click", () => {
      closeRecorderDialog();
    });
  }

  if (recorderDom.saveAll) {
    recorderDom.saveAll.addEventListener("click", () => {
      void saveAllRecorderSections();
    });
  }

  if (recorderDom.modal) {
    recorderDom.modal.addEventListener("mousedown", (event) => {
      if (event.target === recorderDom.modal) {
        event.preventDefault();
      }
    });
    recorderDom.modal.addEventListener("click", (event) => {
      if (event.target === recorderDom.modal) {
        closeRecorderDialog();
      }
    });
  }

  if (dom.configOpen) {
    dom.configOpen.addEventListener("click", () => {
      closeAppMenu({ restoreFocus: false });
      openConfigModal();
    });
  }

  if (dom.configClose) {
    dom.configClose.addEventListener("click", () => {
      closeConfigModal();
    });
  }

  if (dom.configModal) {
    dom.configModal.addEventListener("mousedown", (event) => {
      if (event.target === dom.configModal) {
        event.preventDefault();
      }
    });
    dom.configModal.addEventListener("click", (event) => {
      if (event.target === dom.configModal) {
        closeConfigModal();
      }
    });
  }

  attachWebServerEventListeners();
  attachArchivalEventListeners();

  if (dom.servicesOpen) {
    dom.servicesOpen.addEventListener("click", () => {
      closeAppMenu({ restoreFocus: false });
      if (servicesDialogState.open) {
        closeServicesModal();
      } else {
        openServicesModal();
      }
    });
  }

  if (dom.servicesClose) {
    dom.servicesClose.addEventListener("click", () => {
      closeServicesModal();
    });
  }

  if (dom.servicesModal) {
    dom.servicesModal.addEventListener("mousedown", (event) => {
      if (event.target === dom.servicesModal) {
        event.preventDefault();
      }
    });
    dom.servicesModal.addEventListener("click", (event) => {
      if (event.target === dom.servicesModal) {
        closeServicesModal();
      }
    });
  }

  if (dom.servicesRefresh) {
    dom.servicesRefresh.addEventListener("click", () => {
      fetchServices({ silent: false });
    });
  }

  if (dom.pagePrev) {
    dom.pagePrev.addEventListener("click", () => {
      if (dom.pagePrev.disabled) {
        return;
      }
      const limitValue = clampLimitValue(state.filters.limit);
      const currentOffset = Number.isFinite(state.offset) ? Math.trunc(state.offset) : 0;
      const nextOffset = Math.max(0, currentOffset - limitValue);
      if (nextOffset === currentOffset) {
        return;
      }
      state.offset = nextOffset;
      fetchRecordings({ silent: false, force: true });
      updatePaginationControls();
    });
  }

  if (dom.pageNext) {
    dom.pageNext.addEventListener("click", () => {
      if (dom.pageNext.disabled) {
        return;
      }
      const limitValue = clampLimitValue(state.filters.limit);
      const currentOffset = Number.isFinite(state.offset) ? Math.trunc(state.offset) : 0;
      const nextOffset = Math.max(0, currentOffset + limitValue);
      if (nextOffset === currentOffset) {
        return;
      }
      state.offset = nextOffset;
      fetchRecordings({ silent: false, force: true });
      updatePaginationControls();
    });

  }

  for (const button of dom.sortButtons) {
    button.addEventListener("click", () => {
      const key = button.dataset.sortKey;
      if (!key) {
        return;
      }
      if (state.sort.key === key) {
        state.sort.direction = state.sort.direction === "asc" ? "desc" : "asc";
      } else {
        state.sort.key = key;
        state.sort.direction = "asc";
      }
      updateSortIndicators();
      persistSortPreference(state.sort);
      renderRecords({ force: true });
    });
  }

  dom.toggleAll.addEventListener("change", (event) => {
    const records = getVisibleRecords().filter((record) => !record.isPartial);
    if (event.target.checked) {
      for (const record of records) {
        state.selections.add(record.path);
      }
      if (records.length > 0) {
        state.selectionAnchor = records[records.length - 1].path;
        state.selectionFocus = records[records.length - 1].path;
      }
    } else {
      for (const record of records) {
        state.selections.delete(record.path);
      }
      state.selectionAnchor = "";
      state.selectionFocus = "";
    }
    renderRecords({ force: true });
  });

  dom.selectAll.addEventListener("click", () => {
    const records = getVisibleRecords().filter((record) => !record.isPartial);
    for (const record of records) {
      state.selections.add(record.path);
    }
    if (records.length > 0) {
      state.selectionAnchor = records[records.length - 1].path;
      state.selectionFocus = records[records.length - 1].path;
    }
    renderRecords({ force: true });
  });

  dom.clearSelection.addEventListener("click", () => {
    state.selections.clear();
    state.selectionAnchor = "";
    state.selectionFocus = "";
    renderRecords({ force: true });
  });

  if (dom.recycleBinOpen) {
    dom.recycleBinOpen.addEventListener("click", () => {
      openRecycleBinModal({ focus: true });
    });
  }

  if (dom.recycleBinClose) {
    dom.recycleBinClose.addEventListener("click", () => {
      closeRecycleBinModal();
    });
  }

  if (dom.recycleBinRefresh) {
    dom.recycleBinRefresh.addEventListener("click", () => {
      fetchRecycleBin({ silent: false });
    });
  }

  if (dom.recycleBinRestore) {
    dom.recycleBinRestore.addEventListener("click", async () => {
      await restoreRecycleBinSelection();
    });
  }

  if (dom.recycleBinPurge) {
    dom.recycleBinPurge.addEventListener("click", async () => {
      await purgeRecycleBinSelection();
    });
  }

  if (dom.recycleBinToggleAll) {
    dom.recycleBinToggleAll.addEventListener("change", (event) => {
      if (event.target instanceof HTMLInputElement && event.target.checked) {
        const updated = new Set();
        for (const entry of state.recycleBin.items) {
          if (entry && typeof entry.id === "string" && entry.id) {
            updated.add(entry.id);
          }
        }
        state.recycleBin.selected = updated;
        if (!recycleBinContainsId(state.recycleBin.activeId)) {
          state.recycleBin.activeId = "";
        }
        if (!recycleBinContainsId(state.recycleBin.anchorId)) {
          let anchor = "";
          for (const value of updated.values()) {
            anchor = value;
          }
          state.recycleBin.anchorId = typeof anchor === "string" ? anchor : "";
        }
      } else {
        state.recycleBin.selected = new Set();
        state.recycleBin.activeId = "";
        state.recycleBin.anchorId = "";
      }
      persistRecycleBinState();
      renderRecycleBinItems();
    });
  }

  if (dom.recycleBinModal) {
    dom.recycleBinModal.addEventListener("mousedown", (event) => {
      if (event.target === dom.recycleBinModal) {
        event.preventDefault();
      }
    });
    dom.recycleBinModal.addEventListener("click", (event) => {
      if (event.target === dom.recycleBinModal) {
        closeRecycleBinModal();
      }
    });
  }

  dom.deleteSelected.addEventListener("click", async () => {
    if (!state.selections.size) {
      return;
    }
    const count = state.selections.size;
    const message = `Move ${count} selected recording${count === 1 ? "" : "s"} to the recycle bin?`;
    const title =
      count === 1 ? "Move recording to recycle bin" : "Move recordings to recycle bin";
    const confirmed = await confirmDeletionPrompt(message, title);
    if (!confirmed) {
      return;
    }
    const paths = Array.from(state.selections.values());
    await deleteRecordings(paths);
  });

  if (dom.downloadSelected) {
    dom.downloadSelected.addEventListener("click", async () => {
      if (!state.selections.size) {
        return;
      }
      const paths = Array.from(state.selections.values());
      dom.downloadSelected.disabled = true;
      try {
        await downloadRecordingsArchive(paths);
      } catch (error) {
        console.error("Bulk download failed", error);
        const message =
          error instanceof Error && error.message
            ? error.message
            : "Unable to download recordings.";
        if (typeof window !== "undefined" && typeof window.alert === "function") {
          window.alert(message);
        }
      } finally {
        updateSelectionUI();
      }
    });
  }

  if (dom.renameSelected) {
    dom.renameSelected.addEventListener("click", () => {
      if (isRenameDialogPending() || state.selections.size !== 1) {
        return;
      }
      const [selectedPath] = Array.from(state.selections.values());
      if (typeof selectedPath !== "string" || !selectedPath) {
        return;
      }
      const record = state.records.find((entry) => entry.path === selectedPath);
      if (record) {
        openRenameDialog(record);
      }
    });
  }

  if (dom.waveformZoomInput instanceof HTMLInputElement) {
    const storedValue = Number.isFinite(waveformState.amplitudeScale)
      ? waveformState.amplitudeScale
      : Number.parseFloat(dom.waveformZoomInput.value);
    const initial = normalizeWaveformZoom(storedValue);
    waveformState.amplitudeScale = initial;
    dom.waveformZoomInput.value = initial.toString();
    updateWaveformZoomDisplay(initial);
    const handleWaveformZoomChange = (event) => {
      if (!(event.target instanceof HTMLInputElement)) {
        return;
      }
      const normalized = normalizeWaveformZoom(Number.parseFloat(event.target.value));
      waveformState.amplitudeScale = normalized;
      event.target.value = normalized.toString();
      updateWaveformZoomDisplay(normalized);
      persistWaveformPreferences(normalizeWaveformZoom(waveformState.amplitudeScale));
      redrawWaveform();
    };
    dom.waveformZoomInput.addEventListener("input", handleWaveformZoomChange);
    dom.waveformZoomInput.addEventListener("change", handleWaveformZoomChange);
  } else {
    updateWaveformZoomDisplay(normalizeWaveformZoom(waveformState.amplitudeScale));
  }

  if (dom.waveformContainer) {
    dom.waveformContainer.addEventListener("pointerdown", handleWaveformPointerDown);
    dom.waveformContainer.addEventListener("pointermove", handleWaveformPointerMove);
    dom.waveformContainer.addEventListener("pointerup", handleWaveformPointerUp);
    dom.waveformContainer.addEventListener("pointercancel", handleWaveformPointerUp);
    dom.waveformContainer.addEventListener("click", (event) => {
      event.stopPropagation();
    });
  }

  window.addEventListener("resize", redrawWaveform);
  window.addEventListener("resize", syncPlayerPlacement);
  window.addEventListener("keydown", handleTransportKeydown);
  window.addEventListener("keyup", handleTransportKeyup);
  window.addEventListener("blur", cancelKeyboardJog);
  window.addEventListener("keydown", handleSpacebarShortcut);

  const handlePreviewPointerReset = () => {
    focusState.previewPointer = false;
  };

  dom.player.addEventListener("pointerdown", () => {
    focusState.previewPointer = true;
  });
  dom.player.addEventListener("pointerup", handlePreviewPointerReset);
  dom.player.addEventListener("pointercancel", handlePreviewPointerReset);
  dom.player.addEventListener("focus", () => {
    if (!focusState.previewPointer) {
      return;
    }
    focusState.previewPointer = false;
    window.requestAnimationFrame(() => {
      if (!focusPreviewSurface()) {
        try {
          dom.player.blur();
        } catch (error) {
          /* ignore blur errors */
        }
      }
    });
  });
  dom.player.addEventListener("blur", handlePreviewPointerReset);

  const suppressPlayerPropagation = (event) => {
    event.stopPropagation();
  };

  dom.player.addEventListener("click", suppressPlayerPropagation);
  dom.player.addEventListener("dblclick", suppressPlayerPropagation);
  dom.player.addEventListener("pointerdown", suppressPlayerPropagation);
  dom.player.addEventListener("pointerup", suppressPlayerPropagation);

  dom.player.addEventListener("play", () => {
    playbackState.pausedViaSpacebar.delete(dom.player);
    startCursorAnimation();
    updateTransportPlayState();
    updateTransportProgressUI();
  });
  dom.player.addEventListener("pause", () => {
    stopCursorAnimation();
    updateCursorFromPlayer();
    updateTransportPlayState();
    updateTransportProgressUI();
  });
  dom.player.addEventListener("timeupdate", () => {
    updateCursorFromPlayer();
    if (!transportState.scrubbing) {
      updateTransportProgressUI();
    }
  });
  dom.player.addEventListener("seeked", () => {
    updateCursorFromPlayer();
    updateTransportProgressUI();
  });
  dom.player.addEventListener("loadedmetadata", (event) => {
    handlePlayerLoadedMetadata(event);
    updateTransportAvailability();
  });
  dom.player.addEventListener("durationchange", updateTransportProgressUI);
  dom.player.addEventListener("ended", () => {
    applyNowPlayingHighlight();
    stopCursorAnimation();
    updateCursorFromPlayer();
    updateTransportProgressUI();
    updateTransportPlayState();
    playbackState.pausedViaSpacebar.delete(dom.player);
  });
  dom.player.addEventListener("emptied", () => {
    playbackState.pausedViaSpacebar.delete(dom.player);
    playbackState.resetOnLoad = false;
    playbackState.enforcePauseOnLoad = false;
    if (!playbackSourceState.suppressTransportReset) {
      resetTransportUi();
    }
    updateTransportAvailability();
  });
  dom.player.addEventListener("volumechange", handlePlayerVolumeChange);
  dom.player.addEventListener("ratechange", handlePlayerRateChange);

  if (dom.transportPlay) {
    dom.transportPlay.addEventListener("click", handleTransportPlayToggle);
  }
  if (dom.transportRestart) {
    dom.transportRestart.addEventListener("click", () => {
      restartTransport();
    });
  }
  if (dom.transportRewind) {
    dom.transportRewind.addEventListener("click", () => {
      skipTransportBy(-TRANSPORT_SKIP_BACK_SECONDS);
    });
  }
  if (dom.transportForward) {
    dom.transportForward.addEventListener("click", () => {
      skipTransportBy(TRANSPORT_SKIP_FORWARD_SECONDS);
    });
  }
  if (dom.transportEnd) {
    dom.transportEnd.addEventListener("click", () => {
      jumpToTransportEnd();
    });
  }
  if (dom.transportMute) {
    dom.transportMute.addEventListener("click", handleTransportMuteToggle);
  }
  if (dom.transportVolume) {
    dom.transportVolume.addEventListener("input", handleTransportVolumeInput);
  }
  if (dom.transportSpeed) {
    dom.transportSpeed.addEventListener("change", handleTransportSpeedChange);
  }
  if (dom.transportScrubber) {
    dom.transportScrubber.addEventListener("input", handleTransportScrubberInput);
    dom.transportScrubber.addEventListener("change", handleTransportScrubberCommit);
    dom.transportScrubber.addEventListener("pointerdown", handleTransportScrubberPointerDown);
    dom.transportScrubber.addEventListener("pointerup", handleTransportScrubberPointerUp);
    dom.transportScrubber.addEventListener("pointercancel", handleTransportScrubberPointerUp);
    dom.transportScrubber.addEventListener("blur", handleTransportScrubberBlur);
  }

  if (dom.playbackSourceProcessed) {
    dom.playbackSourceProcessed.addEventListener("click", () => {
      setPlaybackSource("processed", { userInitiated: true });
    });
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
