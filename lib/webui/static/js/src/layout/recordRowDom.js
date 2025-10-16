import { findChildByDataset } from "../../dashboard/dom.js";

export function ensureTriggerBadge(container, role, label, className, present) {
  if (!container) {
    return;
  }
  const existing = findChildByDataset(container, "triggerRole", role);
  if (present) {
    if (existing) {
      existing.textContent = label;
      if (typeof existing.className === "string") {
        existing.className = `badge badge-trigger ${className}`.trim();
      }
      existing.hidden = false;
    } else if (typeof document !== "undefined" && document.createElement) {
      const badge = document.createElement("span");
      badge.className = `badge badge-trigger ${className}`.trim();
      if (badge.dataset) {
        badge.dataset.triggerRole = role;
      }
      badge.textContent = label;
      if (typeof container.append === "function") {
        container.append(badge);
      } else if (typeof container.appendChild === "function") {
        container.appendChild(badge);
      }
    }
  } else if (existing) {
    if (typeof container.removeChild === "function") {
      try {
        container.removeChild(existing);
      } catch (error) {
        existing.hidden = true;
      }
    } else if (typeof existing.remove === "function") {
      existing.remove();
    } else {
      existing.hidden = true;
    }
  }
}

export function updateMetaPill(container, role, text, className = "meta-pill") {
  if (!container) {
    return;
  }
  const normalized = typeof text === "string" ? text.trim() : "";
  const existing = findChildByDataset(container, "metaRole", role);
  if (normalized) {
    if (existing) {
      existing.textContent = normalized;
      existing.hidden = false;
      existing.className = className;
    } else {
      const pill = document.createElement("span");
      pill.className = className;
      pill.dataset.metaRole = role;
      pill.textContent = normalized;
      container.append(pill);
    }
  } else if (existing) {
    if (typeof container.removeChild === "function") {
      try {
        container.removeChild(existing);
      } catch (error) {
        existing.hidden = true;
      }
    } else if (typeof existing.remove === "function") {
      existing.remove();
    } else {
      existing.hidden = true;
    }
  }
}

export function updateSubtextSpan(container, role, text) {
  if (!container) {
    return;
  }
  const normalized = typeof text === "string" ? text.trim() : "";
  const existing = findChildByDataset(container, "subtextRole", role);
  if (normalized) {
    if (existing) {
      existing.textContent = normalized;
    } else {
      const span = document.createElement("span");
      span.dataset.subtextRole = role;
      span.textContent = normalized;
      container.append(span);
    }
  } else if (existing) {
    if (typeof container.removeChild === "function") {
      try {
        container.removeChild(existing);
      } catch (error) {
        existing.hidden = true;
      }
    } else if (typeof existing.remove === "function") {
      existing.remove();
    } else {
      existing.hidden = true;
    }
  }
}
