# Dashboard Modularization Report

Source file: `lib/webui/static/js/dashboard.js`
Chunk size: 1500 lines with ±10 overlap

## Chunk 1 (1–1500) — processed
- `dashboard/utils/dashboardRuntime.js`
  - **COMPONENTS_REGISTRY** — utils (constant)
  - **nowMilliseconds** — utils (function)
  - **requireDashboardComponent** — utils (function)

## Chunk 2 (1491–2990) — processed
- `dashboard/utils/recordingProgress.js`
  - **computePartialFingerprint** — utils (function)
  - **computeRecordsFingerprint** — utils (function)
  - **deriveInProgressRecord** — utils (function)
  - **findFinalizedRecordForPartial** — utils (function)
  - **normalizeRecordingProgressRecord** — utils (function)
  - **toFinalizedRecordingPath** — utils (function)

## Chunk 3 (2981–4480) — processed
- `dashboard/layout/recordRowDom.js`
  - **ensureTriggerBadge** — layout (function)
  - **updateMetaPill** — layout (function)
  - **updateSubtextSpan** — layout (function)
- `dashboard/utils/recordMetadata.js`
  - **recordMetadataChanged** — utils (function)
  - **resolveTriggerFlags** — utils (function)

## Chunk 4 (4471–5970) — processed
- `dashboard/layout/waveformControls.js`
  - **clearWaveformRefresh** — layout (function)
  - **drawWaveformFromPeaks** — layout (function)
  - **getWaveformAmplitudeScale** — layout (function)
  - **getWaveformZoomLimits** — layout (function)
  - **handlePlayerLoadedMetadata** — layout (function)
  - **handleWaveformPointerDown** — layout (function)
  - **handleWaveformPointerMove** — layout (function)
  - **handleWaveformPointerUp** — layout (function)
  - **layoutWaveformMarkerLabels** — layout (function)
  - **loadWaveform** — layout (function)
  - **normalizeWaveformZoom** — layout (function)
  - **redrawWaveform** — layout (function)
  - **renderMotionSegments** — layout (function)
  - **resetWaveform** — layout (function)
  - **restoreWaveformPreferences** — layout (function)
  - **scheduleWaveformRefresh** — layout (function)
  - **seekFromPointer** — layout (function)
  - **setCursorFraction** — layout (function)
  - **setWaveformMarker** — layout (function)
  - **startCursorAnimation** — layout (function)
  - **stopCursorAnimation** — layout (function)
  - **updateCursorFromPlayer** — layout (function)
  - **updateWaveformClock** — layout (function)
  - **updateWaveformMarkers** — layout (function)
  - **updateWaveformZoomDisplay** — layout (function)

## Chunk 5 (5961–7460) — processed
- `dashboard/utils/recorderSettings.js`
  - **adaptiveDefaults** — utils (function)
  - **audioDefaults** — utils (function)
  - **canonicalAdaptiveFromConfig** — utils (function)
  - **canonicalAdaptiveSettings** — utils (function)
  - **canonicalAudioFromConfig** — utils (function)
  - **canonicalAudioSettings** — utils (function)
  - **canonicalDashboardFromConfig** — utils (function)
  - **canonicalDashboardSettings** — utils (function)
  - **canonicalIngestFromConfig** — utils (function)
  - **canonicalIngestSettings** — utils (function)
  - **canonicalLoggingFromConfig** — utils (function)
  - **canonicalLoggingSettings** — utils (function)
  - **canonicalSegmenterFromConfig** — utils (function)
  - **canonicalSegmenterSettings** — utils (function)
  - **canonicalStreamingFromConfig** — utils (function)
  - **canonicalStreamingSettings** — utils (function)
  - **canonicalTranscriptionFromConfig** — utils (function)
  - **canonicalTranscriptionSettings** — utils (function)
  - **dashboardDefaults** — utils (function)
  - **extractErrorMessage** — utils (function)
  - **ingestDefaults** — utils (function)
  - **isMotionTriggeredEvent** — utils (function)
  - **loggingDefaults** — utils (function)
  - **normalizeExtensionList** — utils (function)
  - **normalizeSuffixList** — utils (function)
  - **parseBoolean** — utils (function)
  - **parseListInput** — utils (function)
  - **parseMotionFlag** — utils (function)
  - **resolveNextMotionState** — utils (function)
  - **segmenterDefaults** — utils (function)
  - **streamingDefaults** — utils (function)
  - **transcriptionDefaults** — utils (function)

## Chunk 6 (7451–7963) — processed
- `dashboard/layout/recorderConfigUi.js`
  - **applyAdaptiveForm** — layout (function)
  - **applyAudioForm** — layout (function)
  - **applyDashboardForm** — layout (function)
  - **applyIngestForm** — layout (function)
  - **applyLoggingForm** — layout (function)
  - **applySegmenterForm** — layout (function)
  - **applySelectedTranscriptionModel** — layout (function)
  - **applyStreamingForm** — layout (function)
  - **applyTranscriptionForm** — layout (function)
  - **attachConfigDialogKeydown** — layout (function)
  - **attachRecycleBinDialogKeydown** — layout (function)
  - **attachServicesDialogKeydown** — layout (function)
  - **closeConfigModal** — layout (function)
  - **closeRecycleBinModal** — layout (function)
  - **closeServicesModal** — layout (function)
  - **configModalFocusableElements** — layout (function)
  - **detachConfigDialogKeydown** — layout (function)
  - **detachRecycleBinDialogKeydown** — layout (function)
  - **detachServicesDialogKeydown** — layout (function)
  - **ensureRecorderSectionsLoaded** — layout (function)
  - **focusConfigDialog** — layout (function)
  - **focusRecycleBinDialog** — layout (function)
  - **focusServicesDialog** — layout (function)
  - **handleRecorderConfigSnapshot** — layout (function)
  - **hideTranscriptionModelDiscovery** — layout (function)
  - **openConfigModal** — layout (function)
  - **openRecycleBinModal** — layout (function)
  - **openServicesModal** — layout (function)
  - **readAdaptiveForm** — layout (function)
  - **readAudioForm** — layout (function)
  - **readDashboardForm** — layout (function)
  - **readIngestForm** — layout (function)
  - **readLoggingForm** — layout (function)
  - **readSegmenterForm** — layout (function)
  - **readStreamingForm** — layout (function)
  - **readTranscriptionForm** — layout (function)
  - **recycleBinModalFocusableElements** — layout (function)
  - **refreshTranscriptionModels** — layout (function)
  - **registerRecorderSection** — layout (function)
  - **registerRecorderSections** — layout (function)
  - **renderRecycleBinItems** — layout (function)
  - **restoreRecycleBinPreview** — layout (function)
  - **servicesModalFocusableElements** — layout (function)
  - **setConfigModalVisible** — layout (function)
  - **setRecycleBinModalVisible** — layout (function)
  - **setServicesModalVisible** — layout (function)
  - **setTranscriptionModelLoading** — layout (function)
  - **setTranscriptionModelStatus** — layout (function)
  - **showTranscriptionModelDiscovery** — layout (function)
  - **updateRecorderConfigPath** — layout (function)
  - **updateRecycleBinControls** — layout (function)
  - **updateRecycleBinPreview** — layout (function)

## Chunk 7 (8941–10440) — processed
- `dashboard/layout/filterControls.js`
  - **applyFiltersFromInputs** — layout (function)
  - **clearFilters** — layout (function)
- `dashboard/services/recycleBinService.js`
  - **deleteRecordings** — services (function)
  - **fetchRecycleBin** — services (function)
  - **findNextSelectionPath** — services (function)
  - **purgeRecycleBinSelection** — services (function)
  - **renameRecording** — services (function)
  - **requestRecordDeletion** — services (function)
  - **restoreRecycleBinSelection** — services (function)

## Chunk 8 (10431–11534) — processed
- `dashboard/layout/dashboardInitializer.js`
  - **initialize** — layout (function)
- `dashboard/layout/liveStreamControls.js`
  - **closeLiveStreamPanel** — layout (function)
  - **focusLiveStreamPanel** — layout (function)
  - **focusPreviewSurface** — layout (function)
  - **openLiveStreamPanel** — layout (function)
  - **releaseLiveAudioFocus** — layout (function)
  - **stopLiveStream** — layout (function)

No unclassified items were encountered during modularization.

## Validation

- `node --check lib/webui/static/js/dashboard.js`
- `pytest -q`
