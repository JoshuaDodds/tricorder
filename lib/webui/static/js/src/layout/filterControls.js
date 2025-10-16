export function createFilterControls(deps = {}) {
  const {
    dom,
    state,
    clampLimitValue,
    persistFilters,
    clearStoredFilters,
    defaultLimit,
    validTimeRanges,
  } = deps;

  if (!dom || typeof dom !== "object") {
    throw new Error("createFilterControls requires dashboard DOM references");
  }
  if (!state || typeof state !== "object") {
    throw new Error("createFilterControls requires dashboard state");
  }
  if (typeof clampLimitValue !== "function") {
    throw new Error("createFilterControls requires clampLimitValue");
  }
  if (typeof persistFilters !== "function") {
    throw new Error("createFilterControls requires persistFilters");
  }
  if (typeof clearStoredFilters !== "function") {
    throw new Error("createFilterControls requires clearStoredFilters");
  }
  if (typeof defaultLimit !== "number") {
    throw new Error("createFilterControls requires a defaultLimit number");
  }
  if (!validTimeRanges || typeof validTimeRanges.has !== "function") {
    throw new Error("createFilterControls requires validTimeRanges set");
  }

  function applyFiltersFromInputs() {
    const search = dom.filterSearch ? dom.filterSearch.value.trim() : "";
    const day = dom.filterDay ? dom.filterDay.value.trim() : "";
    let timeRange = state.filters.timeRange;
    if (dom.filterTimeRange) {
      const raw = dom.filterTimeRange.value.trim();
      timeRange = validTimeRanges.has(raw) ? raw : "";
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
    }
    if (dom.filterTimeRange) {
      dom.filterTimeRange.value = "";
    }
    if (dom.filterLimit) {
      dom.filterLimit.value = String(defaultLimit);
    }
    state.filters = { search: "", day: "", limit: defaultLimit, timeRange: "" };
    state.offset = 0;
    clearStoredFilters();
  }

  return {
    applyFiltersFromInputs,
    clearFilters,
  };
}
