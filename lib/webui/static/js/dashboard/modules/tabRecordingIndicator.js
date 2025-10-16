const TAB_RECORDING_FLASH_INTERVAL_MS = 1200;

export function createTabRecordingIndicator({ prefersReducedMotion } = {}) {
  const prefersMotionReduction =
    typeof prefersReducedMotion === "function" ? prefersReducedMotion : () => false;

  const tabRecordingTitleState = {
    baseTitle:
      typeof document !== "undefined" && typeof document.title === "string" && document.title
        ? document.title
        : "Tricorder",
    active: false,
    motionActive: false,
    flashHandle: null,
    showIndicator: false,
  };

  function stopTabRecordingTitleIndicator() {
    if (typeof window === "undefined") {
      return;
    }
    if (tabRecordingTitleState.flashHandle !== null) {
      window.clearInterval(tabRecordingTitleState.flashHandle);
      tabRecordingTitleState.flashHandle = null;
    }
    tabRecordingTitleState.showIndicator = false;
    if (typeof document !== "undefined" && typeof document.title === "string") {
      document.title = tabRecordingTitleState.baseTitle;
    }
  }

  function getTabRecordingIndicatorLabel() {
    if (tabRecordingTitleState.motionActive) {
      return "● Motion";
    }
    if (tabRecordingTitleState.active) {
      return "● Recording";
    }
    return "";
  }

  function applyTabRecordingIndicatorTitle(showIndicator) {
    if (typeof document === "undefined" || typeof document.title !== "string") {
      return;
    }
    const baseTitle = tabRecordingTitleState.baseTitle || "Tricorder";
    if (!showIndicator) {
      document.title = baseTitle;
      return;
    }
    const indicatorLabel = getTabRecordingIndicatorLabel();
    document.title = indicatorLabel ? `${indicatorLabel} • ${baseTitle}` : baseTitle;
  }

  function shouldUseTabTitleFlash() {
    if (prefersMotionReduction()) {
      return false;
    }
    if (typeof navigator === "undefined" || typeof navigator.userAgent !== "string") {
      return false;
    }
    const userAgent = navigator.userAgent;
    if (userAgent.includes("Firefox/")) {
      return true;
    }
    if (
      userAgent.includes("Safari/") &&
      !userAgent.includes("Chrome/") &&
      !userAgent.includes("Chromium/") &&
      !userAgent.includes("Edg/")
    ) {
      return true;
    }
    return false;
  }

  function refreshTabRecordingTitleIndicator() {
    if (typeof document === "undefined") {
      return;
    }
    const visibilityState = typeof document.visibilityState === "string" ? document.visibilityState : "visible";
    const shouldShow = tabRecordingTitleState.motionActive && visibilityState === "hidden";
    if (!shouldShow) {
      stopTabRecordingTitleIndicator();
      return;
    }
    if (typeof document.title === "string" && document.title && !tabRecordingTitleState.showIndicator) {
      tabRecordingTitleState.baseTitle = document.title;
    }
    tabRecordingTitleState.showIndicator = true;
    applyTabRecordingIndicatorTitle(true);
    if (typeof window === "undefined") {
      return;
    }
    if (!shouldUseTabTitleFlash()) {
      if (tabRecordingTitleState.flashHandle !== null) {
        window.clearInterval(tabRecordingTitleState.flashHandle);
        tabRecordingTitleState.flashHandle = null;
      }
      return;
    }
    if (tabRecordingTitleState.flashHandle !== null) {
      return;
    }
    tabRecordingTitleState.flashHandle = window.setInterval(() => {
      tabRecordingTitleState.showIndicator = !tabRecordingTitleState.showIndicator;
      applyTabRecordingIndicatorTitle(tabRecordingTitleState.showIndicator);
    }, TAB_RECORDING_FLASH_INTERVAL_MS);
  }

  function setTabRecordingActive(active, options = {}) {
    const { motion = false } = options;
    const nextActive = Boolean(active);
    const nextMotionActive = nextActive && Boolean(motion);
    if (
      tabRecordingTitleState.active === nextActive &&
      tabRecordingTitleState.motionActive === nextMotionActive
    ) {
      refreshTabRecordingTitleIndicator();
      return;
    }
    tabRecordingTitleState.active = nextActive;
    tabRecordingTitleState.motionActive = nextMotionActive;
    if (!nextActive) {
      stopTabRecordingTitleIndicator();
      if (typeof document !== "undefined" && typeof document.title === "string" && document.title) {
        tabRecordingTitleState.baseTitle = document.title;
      }
    } else if (!nextMotionActive) {
      stopTabRecordingTitleIndicator();
      if (typeof document !== "undefined" && typeof document.title === "string" && document.title) {
        tabRecordingTitleState.baseTitle = document.title;
      }
    } else if (typeof document !== "undefined" && typeof document.title === "string" && document.title) {
      tabRecordingTitleState.baseTitle = document.title;
    }
    refreshTabRecordingTitleIndicator();
  }

  return {
    stopTabRecordingTitleIndicator,
    refreshTabRecordingTitleIndicator,
    setTabRecordingActive,
  };
}
