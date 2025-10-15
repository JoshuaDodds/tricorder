(() => {
  function ensureComponentRegistry() {
    const root =
      typeof globalThis !== "undefined"
        ? globalThis
        : typeof window !== "undefined"
          ? window
          : {};
    if (!root.__TRICORDER_COMPONENTS__) {
      root.__TRICORDER_COMPONENTS__ = {};
    }
    return root.__TRICORDER_COMPONENTS__;
  }

  const componentRegistry = ensureComponentRegistry();

  function syncFiltersPanel(options) {
  const {
    dom,
    state,
    validTimeRanges,
    clampLimitValue,
    persistFilters,
  } = options;

  if (dom.filterSearch) {
    dom.filterSearch.value = state.filters.search;
  }

  const daySelect = dom.filterDay;
  if (daySelect) {
    const previousValue = daySelect.value;
    daySelect.innerHTML = "";
    const dayOptions = ["", ...state.availableDays];
    let matched = false;
    for (const day of dayOptions) {
      const option = document.createElement("option");
      option.value = day;
      option.textContent = day || "All days";
      if (!matched && day === state.filters.day) {
        option.selected = true;
        matched = true;
      } else if (!matched && !state.filters.day && day === previousValue) {
        option.selected = true;
        matched = true;
      }
      daySelect.append(option);
    }
    if (!matched && daySelect.options.length > 0) {
      daySelect.options[0].selected = true;
    }
    if (state.filters.day && daySelect.value !== state.filters.day) {
      daySelect.value = state.filters.day;
    }
  }

  if (dom.filterTimeRange) {
    const sanitized = validTimeRanges.has(state.filters.timeRange)
      ? state.filters.timeRange
      : "";
    if (dom.filterTimeRange.value !== sanitized) {
      dom.filterTimeRange.value = sanitized;
    }
  }

  if (dom.filterLimit) {
    const limit = clampLimitValue(state.filters.limit);
    if (limit !== state.filters.limit) {
      state.filters.limit = limit;
      persistFilters();
    }
    dom.filterLimit.value = String(limit);
  }
  }

  componentRegistry.syncFiltersPanel = syncFiltersPanel;
})();
