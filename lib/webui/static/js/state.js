const DEFAULT_LIMIT = 200;

const dashboardState = {
  filters: {
    search: "",
    day: "",
    limit: DEFAULT_LIMIT,
    timeRange: "",
  },
  collection: "recent",
  records: [],
  recordsFingerprint: "",
  partialFingerprint: "",
  total: 0,
  filteredSize: 0,
  offset: 0,
  availableDays: [],
  selections: new Set(),
  selectionAnchor: "",
  selectionFocus: "",
  current: null,
  partialRecord: null,
  captureStatus: null,
  motionState: null,
  lastUpdated: null,
  sort: { key: "modified", direction: "asc" },
  storage: { recordings: 0, recycleBin: 0, total: null, free: null, diskUsed: null },
  recycleBin: {
    open: false,
    items: [],
    selected: new Set(),
    activeId: "",
    loading: false,
    anchorId: "",
  },
};

const healthState = {
  sdCard: null,
  lastUpdated: null,
  resources: {
    cpu: null,
    memory: null,
    temperature: null,
  },
};

const splitEventState = {
  pending: false,
};

let pendingSelectionRange = null;

const stateEvents = [];
const MAX_EVENT_HISTORY = 20;

function recordStateEvent(event, detail) {
  if (typeof event !== "string" || !event) {
    return;
  }
  stateEvents.push({ event, detail: detail || null, timestamp: Date.now() });
  if (stateEvents.length > MAX_EVENT_HISTORY) {
    stateEvents.shift();
  }
}

function updateDashboardState(mutator, event) {
  if (typeof mutator === "function") {
    mutator(dashboardState);
    recordStateEvent(event || "dashboard:update", "dashboard");
  }
  return dashboardState;
}

function updateHealthState(mutator, event) {
  if (typeof mutator === "function") {
    mutator(healthState);
    recordStateEvent(event || "health:update", "health");
  }
  return healthState;
}

function updateSplitEventState(mutator, event) {
  if (typeof mutator === "function") {
    mutator(splitEventState);
    recordStateEvent(event || "split:update", "split");
  }
  return splitEventState;
}

function setPendingSelectionRange(range) {
  if (!range || typeof range !== "object") {
    if (pendingSelectionRange !== null) {
      pendingSelectionRange = null;
      recordStateEvent("selection:pending:clear");
    }
    return null;
  }

  const anchorPath = typeof range.anchorPath === "string" ? range.anchorPath : "";
  const targetPath = typeof range.targetPath === "string" ? range.targetPath : "";
  const shouldSelect = Boolean(range.shouldSelect);

  pendingSelectionRange = {
    anchorPath,
    targetPath,
    shouldSelect,
  };
  recordStateEvent("selection:pending:set", {
    anchorPath,
    targetPath,
    shouldSelect,
  });
  return pendingSelectionRange;
}

function clearPendingSelectionRange() {
  return setPendingSelectionRange(null);
}

function getPendingSelectionRange() {
  return pendingSelectionRange;
}

function getStateEvents() {
  return stateEvents.slice();
}

const api = {
  DEFAULT_LIMIT,
  dashboardState,
  healthState,
  splitEventState,
  updateDashboardState,
  updateHealthState,
  updateSplitEventState,
  getPendingSelectionRange,
  setPendingSelectionRange,
  clearPendingSelectionRange,
  getStateEvents,
};

if (typeof globalThis !== "undefined") {
  globalThis.TRICORDER_STATE = api;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
}

export {
  DEFAULT_LIMIT,
  dashboardState,
  healthState,
  splitEventState,
  updateDashboardState,
  updateHealthState,
  updateSplitEventState,
  getPendingSelectionRange,
  setPendingSelectionRange,
  clearPendingSelectionRange,
  getStateEvents,
};

export default api;
