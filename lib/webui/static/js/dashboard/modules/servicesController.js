export function createServicesController({
  dom,
  servicesState,
  servicesDialogState,
  apiClient,
  SERVICES_ENDPOINT,
  SERVICE_REFRESH_INTERVAL_MS,
  SERVICE_RESULT_TTL_MS,
  ensureOfflineStateOnError,
  normalizeErrorMessage,
  handleFetchFailure,
  updateRecorderUptimeFromServices,
  updateLiveToggleAvailabilityFromServices,
  setRecorderUptimeStatus,
  isRecorderUptimeKnown,
  setServicesStatus,
  timeFormatter,
}) {
  if (!dom) {
    throw new Error("createServicesController requires dashboard DOM references");
  }
  if (!servicesState || typeof servicesState !== "object") {
    throw new Error("createServicesController requires a services state object");
  }
  if (!servicesDialogState || typeof servicesDialogState !== "object") {
    throw new Error("createServicesController requires a services dialog state object");
  }
  if (!apiClient || typeof apiClient.fetch !== "function") {
    throw new Error("createServicesController requires an apiClient with fetch()");
  }
  if (typeof SERVICES_ENDPOINT !== "string") {
    throw new Error("createServicesController requires a services endpoint");
  }
  if (typeof SERVICE_REFRESH_INTERVAL_MS !== "number") {
    throw new Error("createServicesController requires a service refresh interval");
  }
  if (typeof SERVICE_RESULT_TTL_MS !== "number") {
    throw new Error("createServicesController requires a service result TTL");
  }
  if (typeof setServicesStatus !== "function") {
    throw new Error("createServicesController requires a setServicesStatus helper");
  }
  if (typeof updateRecorderUptimeFromServices !== "function") {
    throw new Error("createServicesController requires an uptime update helper");
  }
  if (typeof updateLiveToggleAvailabilityFromServices !== "function") {
    throw new Error("createServicesController requires a live toggle update helper");
  }
  if (typeof setRecorderUptimeStatus !== "function") {
    throw new Error("createServicesController requires a recorder uptime status helper");
  }
  if (typeof isRecorderUptimeKnown !== "function") {
    throw new Error("createServicesController requires an uptime check helper");
  }
  if (typeof timeFormatter !== "object" || typeof timeFormatter.format !== "function") {
    throw new Error("createServicesController requires a time formatter");
  }

  function serviceActionEndpoint(unit) {
    return `${SERVICES_ENDPOINT}/${encodeURIComponent(unit)}/action`;
  }

  function normalizeServiceAction(action) {
    if (!action || typeof action !== "object") {
      return null;
    }
    const name = typeof action.name === "string" ? action.name : "";
    if (!name) {
      return null;
    }
    return {
      name,
      label: typeof action.label === "string" && action.label ? action.label : name,
      description: typeof action.description === "string" ? action.description : "",
      confirm: action.confirm === true,
    };
  }

  function normalizeServiceEntry(entry) {
    if (!entry || typeof entry !== "object") {
      return null;
    }
    const unit = typeof entry.unit === "string" ? entry.unit : "";
    if (!unit) {
      return null;
    }
    const available = entry.available !== false;
    const statusText =
      typeof entry.status_text === "string" && entry.status_text
        ? entry.status_text
        : available
        ? "Unknown"
        : "Unavailable";
    const fallbackState = available
      ? entry.is_active === true
        ? "active"
        : "inactive"
      : "error";
    const statusState =
      typeof entry.status_state === "string" && entry.status_state
        ? entry.status_state
        : fallbackState;
    const relatedUnits = Array.isArray(entry.related_units)
      ? entry.related_units
          .map((item) => {
            if (!item || typeof item !== "object") {
              return null;
            }
            const relatedUnit = typeof item.unit === "string" ? item.unit : "";
            if (!relatedUnit) {
              return null;
            }
            const relatedAvailable = item.available !== false;
            const relatedFallbackState = relatedAvailable
              ? item.is_active === true
                ? "active"
                : "inactive"
              : "error";
            return {
              unit: relatedUnit,
              label:
                typeof item.label === "string" && item.label ? item.label : relatedUnit,
              relation:
                typeof item.relation === "string" && item.relation
                  ? item.relation
                  : "triggered-by",
              status_text:
                typeof item.status_text === "string" && item.status_text
                  ? item.status_text
                  : relatedAvailable
                  ? "Unknown"
                  : "Unavailable",
              status_state:
                typeof item.status_state === "string" && item.status_state
                  ? item.status_state
                  : relatedFallbackState,
              available: relatedAvailable,
              is_active: item.is_active === true,
              system_description:
                typeof item.system_description === "string" ? item.system_description : "",
            };
          })
          .filter((item) => item !== null)
      : [];
    return {
      unit,
      label: typeof entry.label === "string" && entry.label ? entry.label : unit,
      description: typeof entry.description === "string" ? entry.description : "",
      available,
      status_text: statusText,
      status_state: statusState,
      is_active: entry.is_active === true,
      auto_restart: entry.auto_restart === true,
      can_start: entry.can_start === true,
      can_stop: entry.can_stop === true,
      related_units: relatedUnits,
      actions: Array.isArray(entry.actions)
        ? entry.actions.map((action) => normalizeServiceAction(action)).filter(Boolean)
        : [],
      system_description:
        typeof entry.system_description === "string" ? entry.system_description : "",
      activeEnterEpoch: Number.isFinite(entry.active_enter_epoch)
        ? Number(entry.active_enter_epoch)
        : Number.isFinite(entry.activeEnterEpoch)
          ? Number(entry.activeEnterEpoch)
          : null,
    };
  }

  function createServiceActionButton(service, action, label, className, disabled) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `${className} small`;
    button.dataset.serviceUnit = service.unit;
    button.dataset.action = action;
    button.textContent = label;
    button.disabled = Boolean(disabled);
    button.setAttribute("aria-label", `${label} ${service.label}`);
    button.addEventListener("click", (event) => {
      if (button.disabled) {
        return;
      }
      event.preventDefault();
      const unit = button.dataset.serviceUnit || "";
      const buttonAction = button.dataset.action || "";
      if (!unit || !buttonAction) {
        return;
      }
      handleServiceAction(unit, buttonAction);
    });
    return button;
  }

  function pruneExpiredServiceResults(now) {
    const ttl = SERVICE_RESULT_TTL_MS;
    for (const [unit, result] of servicesState.lastResults.entries()) {
      if (!result || typeof result !== "object") {
        servicesState.lastResults.delete(unit);
        continue;
      }
      const timestamp = Number(result.timestamp);
      if (!Number.isFinite(timestamp) || now - timestamp > ttl) {
        servicesState.lastResults.delete(unit);
      }
    }
  }

  function renderServices() {
    if (!dom.servicesList) {
      return;
    }

    const hasItems = servicesState.items.length > 0;
    if (dom.servicesEmpty) {
      dom.servicesEmpty.hidden = hasItems;
      dom.servicesEmpty.setAttribute("aria-hidden", hasItems ? "true" : "false");
    }

    if (servicesState.error) {
      setServicesStatus(servicesState.error, "error");
    } else if (hasItems && servicesState.lastUpdated instanceof Date) {
      setServicesStatus(`Updated ${timeFormatter.format(servicesState.lastUpdated)}`, "info");
    } else if (!hasItems) {
      setServicesStatus("", "");
    }

    dom.servicesList.textContent = "";
    pruneExpiredServiceResults(Date.now());

    if (!hasItems) {
      updateLiveToggleAvailabilityFromServices();
      return;
    }

    const fragment = document.createDocumentFragment();

    for (const service of servicesState.items) {
      const row = document.createElement("div");
      row.className = "service-row";
      row.dataset.unit = service.unit;
      row.dataset.available = service.available ? "true" : "false";
      row.dataset.active = service.is_active ? "true" : "false";
      row.dataset.autoRestart = service.auto_restart ? "true" : "false";

      const header = document.createElement("div");
      header.className = "service-row-header";

      const titles = document.createElement("div");
      titles.className = "service-row-titles";

      const label = document.createElement("div");
      label.className = "service-label";
      label.textContent = service.label;

      const unitText = document.createElement("div");
      unitText.className = "service-unit";
      unitText.textContent = service.unit;

      titles.append(label, unitText);

      const status = document.createElement("span");
      status.className = "service-status";
      const statusState =
        typeof service.status_state === "string" && service.status_state
          ? service.status_state
          : !service.available
          ? "error"
          : service.is_active
          ? "active"
          : "inactive";
      status.dataset.state = statusState;
      status.textContent = service.status_text;

      header.append(titles, status);

      const actions = document.createElement("div");
      actions.className = "service-row-actions";

      const startButton = createServiceActionButton(
        service,
        "start",
        "Start",
        "service-action",
        !service.can_start || servicesState.pending.has(service.unit),
      );
      actions.append(startButton);

      const stopButton = createServiceActionButton(
        service,
        "stop",
        "Stop",
        "service-action",
        !service.can_stop || servicesState.pending.has(service.unit),
      );
      actions.append(stopButton);

      const reloadButton = createServiceActionButton(
        service,
        "reload",
        "Reload",
        "service-action",
        !service.can_reload || servicesState.pending.has(service.unit),
      );
      actions.append(reloadButton);

      const meta = document.createElement("div");
      meta.className = "service-row-meta";

      const details = [];
      if (service.system_description) {
        details.push(service.system_description);
      }
      if (service.load_state) {
        details.push(service.load_state);
      }
      if (service.unit_file_state && service.unit_file_state !== service.load_state) {
        details.push(service.unit_file_state);
      }
      if (service.auto_restart) {
        details.push("Auto-restart");
      }
      if (!service.available && service.error) {
        details.push(service.error);
      }

      if (details.length > 0) {
        const detailLine = document.createElement("div");
        detailLine.className = "service-details";
        detailLine.textContent = details.join(" · ");
        meta.append(detailLine);
      }

      if (Array.isArray(service.related_units) && service.related_units.length > 0) {
        const relatedContainer = document.createElement("div");
        relatedContainer.className = "service-related";
        relatedContainer.setAttribute("role", "group");
        relatedContainer.setAttribute("aria-label", "Related units");

        const heading = document.createElement("div");
        heading.className = "service-related-heading";
        heading.textContent = "Related units";
        relatedContainer.append(heading);

        const list = document.createElement("ul");
        list.className = "service-related-list";

        for (const related of service.related_units) {
          const item = document.createElement("li");
          item.className = "service-related-item";
          if (related.status_state) {
            item.dataset.state = related.status_state;
          }

          const name = document.createElement("span");
          name.className = "service-related-name";
          const displayName = related.label || related.unit;
          name.textContent = displayName;
          if (related.system_description) {
            name.title = related.system_description;
          }

          const summary = document.createElement("span");
          summary.className = "service-related-status";
          summary.textContent = related.status_text;
          if (related.unit && !related.system_description) {
            summary.title = related.unit;
          }

          item.append(name, summary);
          list.append(item);
        }

        relatedContainer.append(list);
        meta.append(relatedContainer);
      }

      const message = document.createElement("div");
      message.className = "service-message";
      message.dataset.visible = "false";

      let messageText = "";
      let messageState = "info";
      let showMessage = false;

      if (servicesState.pending.has(service.unit)) {
        messageText = "Applying action…";
        messageState = "pending";
        showMessage = true;
      } else if (!service.available && service.error) {
        messageText = service.error;
        messageState = "error";
        showMessage = true;
      } else {
        const result = servicesState.lastResults.get(service.unit);
        if (result) {
          messageText = typeof result.message === "string" ? result.message : "";
          messageState = result.ok ? "ok" : "error";
          showMessage = Boolean(messageText);
        }
      }

      if (showMessage) {
        message.dataset.visible = "true";
        message.dataset.state = messageState;
        message.textContent = messageText;
      }

      row.append(header, actions, meta, message);
      fragment.append(row);
    }

    dom.servicesList.append(fragment);
    updateLiveToggleAvailabilityFromServices();
  }

  async function fetchServices(options = {}) {
    if (!dom.servicesList) {
      return;
    }
    const { silent = false } = options;
    if (servicesState.fetchInFlight) {
      servicesState.fetchQueued = true;
      return;
    }
    servicesState.fetchInFlight = true;
    if (!silent) {
      setServicesStatus("Loading services…", "loading");
    }
    try {
      const response = await apiClient.fetch(SERVICES_ENDPOINT, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }
      const payload = await response.json();
      const items = Array.isArray(payload.services) ? payload.services : [];
      const normalized = items
        .map((entry) => normalizeServiceEntry(entry))
        .filter((entry) => entry !== null);
      servicesState.items = normalized;
      updateRecorderUptimeFromServices();
      const updatedAt = Number(payload.updated_at);
      if (Number.isFinite(updatedAt) && updatedAt > 0) {
        servicesState.lastUpdated = new Date(updatedAt * 1000);
      } else {
        servicesState.lastUpdated = new Date();
      }
      servicesState.error = null;
      renderServices();
    } catch (error) {
      console.error("Failed to load services", error);
      const offline = ensureOfflineStateOnError(error, handleFetchFailure);
      if (offline) {
        servicesState.error = "Recorder unreachable. Unable to load services.";
      } else {
        servicesState.error = normalizeErrorMessage(error, "Unable to load services.");
      }
      if (!isRecorderUptimeKnown()) {
        const hint = servicesState.error || "";
        setRecorderUptimeStatus("Offline", { hint });
      }
      renderServices();
    } finally {
      servicesState.fetchInFlight = false;
      if (servicesState.fetchQueued) {
        servicesState.fetchQueued = false;
        fetchServices({ silent: true });
      }
    }
  }

  function stopServicesRefresh() {
    if (servicesState.timerId) {
      window.clearInterval(servicesState.timerId);
      servicesState.timerId = null;
    }
  }

  function startServicesRefresh() {
    if (servicesState.timerId || !dom.servicesList || !servicesDialogState.open) {
      return;
    }
    servicesState.timerId = window.setInterval(() => {
      fetchServices({ silent: true });
    }, SERVICE_REFRESH_INTERVAL_MS);
  }

  function capitalizeAction(action) {
    if (typeof action !== "string" || !action) {
      return "Action";
    }
    return action.charAt(0).toUpperCase() + action.slice(1);
  }

  async function handleServiceAction(unit, action) {
    if (!unit || !action) {
      return;
    }
    if (servicesState.pending.has(unit)) {
      return;
    }

    servicesState.pending.add(unit);
    renderServices();

    try {
      const response = await apiClient.fetch(serviceActionEndpoint(unit), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }
      const payload = await response.json();
      const ok = payload.ok !== false;
      const executed =
        typeof payload.executed_action === "string" && payload.executed_action
          ? payload.executed_action
          : action;
      let message = "";
      if (typeof payload.message === "string" && payload.message.trim()) {
        message = payload.message.trim();
      } else {
        message = ok
          ? `${capitalizeAction(executed)} succeeded.`
          : `${capitalizeAction(executed)} failed.`;
      }
      servicesState.lastResults.set(unit, {
        ok,
        message,
        executedAction: executed,
        timestamp: Date.now(),
        scheduledActions: Array.isArray(payload.scheduled_actions)
          ? payload.scheduled_actions.slice()
          : [],
      });
    } catch (error) {
      console.error("Service action failed", error);
      const offline = ensureOfflineStateOnError(error, handleFetchFailure);
      const fallback = `${capitalizeAction(action)} failed.`;
      let message = normalizeErrorMessage(error, fallback);
      if (offline) {
        message = `${capitalizeAction(action)} failed: recorder unreachable.`;
      }
      servicesState.lastResults.set(unit, {
        ok: false,
        message: message || fallback,
        executedAction: action,
        timestamp: Date.now(),
        scheduledActions: [],
      });
    } finally {
      servicesState.pending.delete(unit);
      renderServices();
      if (servicesState.refreshAfterActionId) {
        window.clearTimeout(servicesState.refreshAfterActionId);
      }
      servicesState.refreshAfterActionId = window.setTimeout(() => {
        servicesState.refreshAfterActionId = null;
        fetchServices({ silent: true });
      }, 800);
    }
  }

  return {
    fetchServices,
    renderServices,
    startServicesRefresh,
    stopServicesRefresh,
    handleServiceAction,
  };
}
