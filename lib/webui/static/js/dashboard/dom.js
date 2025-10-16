// DOM helper utilities shared across dashboard modules.
function dataAttributeFromDatasetKey(key) {
  if (typeof key !== "string" || !key) {
    return "";
  }
  return `data-${key.replace(/([A-Z])/g, "-$1").toLowerCase()}`;
}

function findChildByDataset(container, datasetKey, value) {
  if (!container || typeof datasetKey !== "string" || !datasetKey) {
    return null;
  }
  const attribute = dataAttributeFromDatasetKey(datasetKey);
  if (attribute && typeof container.querySelector === "function") {
    try {
      const selector = `[${attribute}="${value}"]`;
      const found = container.querySelector(selector);
      if (found) {
        return found;
      }
    } catch (error) {
      // ignore selector errors
    }
  }
  const children = container && container.children;
  if (children && typeof children.length === "number") {
    const iterable = Array.isArray(children) ? children : Array.from(children);
    for (const child of iterable) {
      if (child && child.dataset && child.dataset[datasetKey] === value) {
        return child;
      }
    }
  }
  const childNodes = container && container.childNodes;
  if (childNodes && typeof childNodes.length === "number") {
    const iterable = Array.isArray(childNodes) ? childNodes : Array.from(childNodes);
    for (const child of iterable) {
      if (child && child.dataset && child.dataset[datasetKey] === value) {
        return child;
      }
    }
  }
  return null;
}

export { dataAttributeFromDatasetKey, findChildByDataset };
