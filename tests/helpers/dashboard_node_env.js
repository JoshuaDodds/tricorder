const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { URLSearchParams } = require("url");

function createMockElement() {
  const childList = [];
  const element = {
    dataset: {},
    hidden: false,
    textContent: "",
    value: "",
    style: {
      setProperty() {},
      removeProperty() {},
    },
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false;
      },
    },
    children: childList,
    childNodes: childList,
    append(...nodes) {
      for (const node of nodes) {
        if (node !== undefined && node !== null) {
          childList.push(node);
        }
      }
      return element;
    },
    appendChild(node) {
      if (node !== undefined && node !== null) {
        childList.push(node);
      }
      return node;
    },
    insertBefore(node, reference) {
      if (node === undefined || node === null) {
        return null;
      }
      const index = childList.indexOf(reference);
      if (index === -1 || reference === undefined || reference === null) {
        childList.push(node);
      } else {
        childList.splice(index, 0, node);
      }
      return node;
    },
    removeChild(node) {
      const index = childList.indexOf(node);
      if (index !== -1) {
        childList.splice(index, 1);
      }
      return node;
    },
    get childElementCount() {
      return childList.length;
    },
    setAttribute() {},
    removeAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    getBoundingClientRect() {
      return { top: 0, left: 0, width: 0, height: 0 };
    },
  };
  Object.defineProperty(element, "innerHTML", {
    configurable: true,
    enumerable: true,
    get() {
      return element._innerHTML || "";
    },
    set(value) {
      element._innerHTML = typeof value === "string" ? value : "";
      childList.length = 0;
    },
  });
  return element;
}

function createWindowStub() {
  const elementStore = new Map();

  const ensureElement = (id, props) => {
    if (typeof id !== "string" || !id) {
      return null;
    }
    const element = createMockElement();
    if (props && typeof props === "object" && !Array.isArray(props)) {
      Object.assign(element, props);
    }
    elementStore.set(id, element);
    return element;
  };

  const defaultElementIds = [
    "toggle-all",
    "selected-count",
    "delete-selected",
    "download-selected",
    "rename-selected",
    "results-summary",
    "pagination-controls",
    "pagination-status",
    "page-prev",
    "page-next",
  ];
  for (const id of defaultElementIds) {
    ensureElement(id);
  }

  const overrides = globalThis.__DASHBOARD_ELEMENT_OVERRIDES;
  if (overrides && typeof overrides === "object" && !Array.isArray(overrides)) {
    for (const [id, props] of Object.entries(overrides)) {
      if (!props) {
        continue;
      }
      if (elementStore.has(id)) {
        continue;
      }
      if (props === true) {
        ensureElement(id);
      } else {
        ensureElement(id, props);
      }
    }
  }

  const document = {
    readyState: "loading",
    addEventListener: () => {},
    removeEventListener: () => {},
    getElementById: (id) => {
      if (elementStore.has(id)) {
        return elementStore.get(id);
      }
      return ensureElement(id);
    },
    querySelector: (selector) => {
      if (typeof selector !== "string") {
        return null;
      }
      const trimmed = selector.trim();
      if (!trimmed) {
        return null;
      }
      if (trimmed.startsWith("#")) {
        const parts = trimmed.slice(1).split(/\s+/, 2);
        const id = parts[0];
        if (!id) {
          return null;
        }
        const element = elementStore.get(id) || ensureElement(id);
        if (!element) {
          return null;
        }
        if (parts.length > 1) {
          const descendant = parts[1].toLowerCase();
          if (descendant === "tbody") {
            if (!element.__tbody) {
              const tbody = createMockElement();
              tbody.parentElement = element;
              element.__tbody = tbody;
              element.children.push(tbody);
            }
            return element.__tbody;
          }
          return null;
        }
        return element;
      }
      return null;
    },
    querySelectorAll: (selector) => {
      const single = document.querySelector(selector);
      return single ? [single] : [];
    },
    createElement: () => createMockElement(),
    body: (() => {
      const bodyElement = createMockElement();
      bodyElement.classList.contains = () => false;
      return bodyElement;
    })(),
    __setMockElement(id, props) {
      return ensureElement(id, props === true ? undefined : props);
    },
    __getMockElement(id) {
      if (typeof id !== "string" || !id) {
        return null;
      }
      return elementStore.get(id) || null;
    },
  };

  const storageStub = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };

  const noop = () => {};

  const windowStub = {
    document,
    addEventListener: noop,
    removeEventListener: noop,
    localStorage: storageStub,
    sessionStorage: { ...storageStub },
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    setTimeout: () => 0,
    clearTimeout: noop,
    setInterval: () => 0,
    clearInterval: noop,
    navigator: {
      languages: ["en-US"],
      language: "en-US",
      sendBeacon: noop,
      clipboard: { writeText: async () => {} },
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    Intl,
    performance: { now: () => 0 },
    AudioContext: function AudioContext() {},
    HTMLAudioElement: function HTMLAudioElement() {},
    Blob: function Blob() {},
    URL: { createObjectURL: () => "", revokeObjectURL: () => {} },
    alert: noop,
    confirm: () => false,
    prompt: () => null,
    CustomEvent: function CustomEvent(type, params = {}) {
      this.type = type;
      this.detail = params.detail ?? null;
    },
    history: { replaceState: noop },
    location: { href: "", replace: noop, assign: noop, reload: noop },
    devicePixelRatio: 1,
    screen: { width: 1024, height: 768 },
    crypto: { getRandomValues: (array) => array.fill(0) },
  };

  windowStub.window = windowStub;
  windowStub.document = document;
  windowStub.URLSearchParams = URLSearchParams;
  return windowStub;
}

function createSandbox() {
  const windowStub = createWindowStub();
  const sandbox = {
    console,
    module: { exports: {} },
    exports: {},
    window: windowStub,
    document: windowStub.document,
    navigator: windowStub.navigator,
    localStorage: windowStub.localStorage,
    sessionStorage: windowStub.sessionStorage,
    fetch: windowStub.fetch,
    performance: windowStub.performance,
    Intl,
    Audio: function Audio() {},
    URL: windowStub.URL,
    Headers: function Headers() {},
    Request: function Request() {},
    Response: function Response() {},
    AbortController: function AbortController() {
      this.signal = {};
      this.abort = () => {};
    },
    FormData: function FormData() {},
    FileReader: function FileReader() {
      this.readAsDataURL = () => {};
    },
    btoa: () => "",
    atob: () => "",
    CustomEvent: windowStub.CustomEvent,
    Event: function Event(type) {
      this.type = type;
    },
    Node: function Node() {},
    Element: function Element() {},
    HTMLElement: function HTMLElement() {},
    HTMLInputElement: function HTMLInputElement() {},
    HTMLSelectElement: function HTMLSelectElement() {},
    HTMLButtonElement: function HTMLButtonElement() {},
    TextEncoder,
    TextDecoder,
    setTimeout() {
      return 0;
    },
    clearTimeout() {},
    setInterval() {
      return 0;
    },
    clearInterval() {},
  };
  sandbox.URLSearchParams = URLSearchParams;

  vm.createContext(sandbox);
  return { sandbox, windowStub };
}

function loadDependency(context, filePath, key) {
  const absolutePath = path.resolve(filePath);
  const source = fs.readFileSync(absolutePath, "utf8");
  const exportEntries = [];
  const importEntries = [];

  function registerExport(localName, exportedName) {
    if (!localName) {
      return;
    }
    const exportName = exportedName || localName;
    exportEntries.push({ localName, exportName });
  }

  function normalizeImportKey(request) {
    if (typeof request !== "string" || !request) {
      return request;
    }
    if (request.startsWith(".")) {
      const baseDir = path.posix.dirname(key);
      const joined = path.posix.join(baseDir, request);
      const normalized = path.posix.normalize(joined);
      return normalized.startsWith("./") ? normalized.slice(2) : normalized;
    }
    return request;
  }

  let transformed = source.replace(/export\s+function\s+([A-Za-z0-9_]+)/g, (match, name) => {
    registerExport(name);
    return `function ${name}`;
  });
  transformed = transformed.replace(/export\s+const\s+([A-Za-z0-9_]+)/g, (match, name) => {
    registerExport(name);
    return `const ${name}`;
  });
  transformed = transformed.replace(/export\s+class\s+([A-Za-z0-9_]+)/g, (match, name) => {
    registerExport(name);
    return `class ${name}`;
  });
  transformed = transformed.replace(
    /export\s+default\s+([A-Za-z0-9_]+)/g,
    (match, name) => {
      registerExport(name, "default");
      return name;
    },
  );
  transformed = transformed.replace(
    /export\s+\{([\s\S]*?)\}\s*;?/g,
    (match, body) => {
      const entries = body
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      for (const entry of entries) {
        const [local, alias] = entry.split(/\s+as\s+/);
        const localName = (local || "").trim();
        const exportName = (alias || localName).trim();
        registerExport(localName, exportName);
      }
      return "";
    },
  );
  transformed = transformed.replace(/export\s+default\s+/g, "");
  transformed = transformed.replace(
    /import\s+([\s\S]+?)\s+from\s+["']([^"']+)["'];?/g,
    (match, specifier, request) => {
      importEntries.push({ specifier: specifier.trim(), request: request.trim() });
      return "";
    },
  );
  const lines = [];
  lines.push("(function(){");
  let importCounter = 0;
  for (const entry of importEntries) {
    const moduleKey = normalizeImportKey(entry.request);
    const refName = `__import${importCounter++}`;
    lines.push(
      `  const ${refName} = globalThis.__dashboardModules[${JSON.stringify(moduleKey)}] || {};`,
    );
    const spec = entry.specifier;
    if (spec.startsWith("{")) {
      const inner = spec.replace(/^\{/, "").replace(/\}$/, "");
      const parts = inner
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      for (const part of parts) {
        const [exported, local] = part.split(/\s+as\s+/);
        const exportName = (exported || "").trim();
        const localName = (local || exportName).trim();
        if (!localName) {
          continue;
        }
        const property = exportName || localName;
        lines.push(
          `  const ${localName} = ${refName}[${JSON.stringify(property)}];`,
        );
      }
    } else if (spec.startsWith("*")) {
      const matchNamespace = spec.match(/^\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/);
      if (matchNamespace) {
        const localName = matchNamespace[1];
        lines.push(`  const ${localName} = ${refName};`);
      }
    } else {
      const defaultMatch = spec.match(/^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*,\s*\{([\s\S]*)\})?$/);
      if (defaultMatch) {
        const defaultName = defaultMatch[1];
        if (defaultName) {
          lines.push(
            `  const ${defaultName} = ${refName}[${JSON.stringify("default")}];`,
          );
        }
        const namedSection = defaultMatch[2];
        if (namedSection) {
          const parts = namedSection
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean);
          for (const part of parts) {
            const [exported, local] = part.split(/\s+as\s+/);
            const exportName = (exported || "").trim();
            const localName = (local || exportName).trim();
            if (!localName) {
              continue;
            }
            const property = exportName || localName;
            lines.push(
              `  const ${localName} = ${refName}[${JSON.stringify(property)}];`,
            );
          }
        }
      } else if (spec) {
        const identifier = spec.trim();
        if (identifier) {
          lines.push(
            `  const ${identifier} = ${refName}[${JSON.stringify("default")}];`,
          );
        }
      }
    }
  }
  lines.push("  const exports = {};");
  const indented = transformed
    .split(/\n/)
    .map((line) => (line ? `  ${line}` : line))
    .join("\n");
  lines.push(indented);
  for (const entry of exportEntries) {
    if (!entry.localName || !entry.exportName) {
      continue;
    }
    lines.push(
      `  exports[${JSON.stringify(entry.exportName)}] = ${entry.localName};`,
    );
  }
  lines.push(
    `  globalThis.__dashboardModules[${JSON.stringify(key)}] = exports;`,
  );
  lines.push("})();");
  const wrapped = lines.join("\n");
  vm.runInContext(wrapped, context, { filename: path.basename(absolutePath) });
}

function loadScript(context, filePath) {
  const absolutePath = path.resolve(filePath);
  const source = fs.readFileSync(absolutePath, "utf8");
  vm.runInContext(source, context, { filename: path.basename(absolutePath) });
}

async function loadDashboard() {
  const { sandbox } = createSandbox();
  if (sandbox.document && typeof sandbox.document === "object") {
    sandbox.document.readyState = "complete";
  }
  sandbox.__dashboardModules = {};

  const baseDir = path.join(__dirname, "..", "..", "lib", "webui", "static", "js");
  loadDependency(sandbox, path.join(baseDir, "config.js"), "config.js");
  loadDependency(sandbox, path.join(baseDir, "api.js"), "api.js");
  loadDependency(sandbox, path.join(baseDir, "events.js"), "events.js");
  loadDependency(sandbox, path.join(baseDir, "formatters.js"), "formatters.js");
  loadDependency(sandbox, path.join(baseDir, "state.js"), "state.js");
  loadDependency(
    sandbox,
    path.join(baseDir, "dashboard", "configuration.js"),
    "dashboard/configuration.js",
  );
  loadDependency(
    sandbox,
    path.join(baseDir, "dashboard", "normalizers.js"),
    "dashboard/normalizers.js",
  );
  loadDependency(
    sandbox,
    path.join(baseDir, "dashboard", "dom.js"),
    "dashboard/dom.js",
  );
  loadDependency(
    sandbox,
    path.join(baseDir, "dashboard", "domRefs.js"),
    "dashboard/domRefs.js",
  );
  loadDependency(
    sandbox,
    path.join(baseDir, "dashboard", "theme.js"),
    "dashboard/theme.js",
  );
  loadDependency(
    sandbox,
    path.join(baseDir, "dashboard", "health.js"),
    "dashboard/health.js",
  );
  loadDependency(
    sandbox,
    path.join(baseDir, "dashboard", "layout", "filters.js"),
    "dashboard/layout/filters.js",
  );
  loadDependency(
    sandbox,
    path.join(baseDir, "dashboard", "modules", "recordingMetaController.js"),
    "dashboard/modules/recordingMetaController.js",
  );
  loadDependency(
    sandbox,
    path.join(baseDir, "dashboard", "modules", "encodingStatusController.js"),
    "dashboard/modules/encodingStatusController.js",
  );
  loadDependency(
    sandbox,
    path.join(baseDir, "dashboard", "modules", "tabRecordingIndicator.js"),
    "dashboard/modules/tabRecordingIndicator.js",
  );
  loadDependency(
    sandbox,
    path.join(baseDir, "dashboard", "modules", "webServerSettingsController.js"),
    "dashboard/modules/webServerSettingsController.js",
  );
  loadDependency(
    sandbox,
    path.join(baseDir, "dashboard", "modules", "archivalSettingsController.js"),
    "dashboard/modules/archivalSettingsController.js",
  );
  loadDependency(
    sandbox,
    path.join(baseDir, "dashboard", "modules", "clipperController.js"),
    "dashboard/modules/clipperController.js",
  );
  loadDependency(
    sandbox,
    path.join(baseDir, "dashboard", "modules", "scrollLockManager.js"),
    "dashboard/modules/scrollLockManager.js",
  );
  loadDependency(
    sandbox,
    path.join(baseDir, "dashboard", "modules", "appMenuController.js"),
    "dashboard/modules/appMenuController.js",
  );
  loadDependency(
    sandbox,
    path.join(baseDir, "dashboard", "modules", "confirmDialogController.js"),
    "dashboard/modules/confirmDialogController.js",
  );
  loadDependency(
    sandbox,
    path.join(baseDir, "dashboard", "modules", "recordingPaths.js"),
    "dashboard/modules/recordingPaths.js",
  );
  loadDependency(
    sandbox,
    path.join(baseDir, "dashboard", "modules", "focusUtils.js"),
    "dashboard/modules/focusUtils.js",
  );
  loadDependency(
    sandbox,
    path.join(baseDir, "dashboard", "modules", "commonUtils.js"),
    "dashboard/modules/commonUtils.js",
  );
  loadDependency(
    sandbox,
    path.join(baseDir, "dashboard", "modules", "preferencesStorage.js"),
    "dashboard/modules/preferencesStorage.js",
  );
  loadDependency(
    sandbox,
    path.join(baseDir, "dashboard", "modules", "pointerManager.js"),
    "dashboard/modules/pointerManager.js",
  );
  loadDependency(
    sandbox,
    path.join(baseDir, "dashboard", "modules", "recycleBinHelpers.js"),
    "dashboard/modules/recycleBinHelpers.js",
  );
  loadDependency(
    sandbox,
    path.join(baseDir, "dashboard", "modules", "servicesController.js"),
    "dashboard/modules/servicesController.js",
  );
  loadDependency(
    sandbox,
    path.join(baseDir, "dashboard", "modules", "downloads.js"),
    "dashboard/modules/downloads.js",
  );
  loadDependency(
    sandbox,
    path.join(baseDir, "dashboard", "modules", "renameDialogController.js"),
    "dashboard/modules/renameDialogController.js",
  );
  loadDependency(
    sandbox,
    path.join(baseDir, "dashboard", "recorderDom.js"),
    "dashboard/recorderDom.js",
  );
  const componentsDir = path.join(baseDir, "dashboard", "components");
  loadScript(sandbox, path.join(componentsDir, "clipList.js"));
  loadScript(sandbox, path.join(componentsDir, "filtersPanel.js"));
  loadScript(sandbox, path.join(componentsDir, "playbackPane.js"));
  loadScript(sandbox, path.join(componentsDir, "transportControls.js"));

  const dashboardPath = path.join(baseDir, "dashboard.js");
  let dashboardSource = fs.readFileSync(dashboardPath, "utf8");
  dashboardSource = dashboardSource.replace(
    /import[\s\S]+?from\s+["'][^"']+["'];?\s*/g,
    "",
  );
  dashboardSource = dashboardSource.replace(
    /(^|\n)import\s+["'][^"']+["'];?\s*/g,
    "$1",
  );
  dashboardSource = dashboardSource.replace(/(^|\n)export\s+\{[\s\S]*?\}\s*;?\s*/g, "$1");
  dashboardSource = dashboardSource.replace(/(^|\n)export\s+default\s+/g, "$1");
  const header = [
    `const { createApiClient } = globalThis.__dashboardModules[${JSON.stringify("api.js")}] || {};`,
    `const { createEventStreamFactory } = globalThis.__dashboardModules[${JSON.stringify("events.js")}] || {};`,
    `const configHelpers = globalThis.__dashboardModules[${JSON.stringify("dashboard/configuration.js")}] || {};`,
    `const { createDashboardServices: importedCreateDashboardServices } = configHelpers;`,
    `const createDashboardServices = importedCreateDashboardServices;`,
    `const normalizerHelpers = globalThis.__dashboardModules[${JSON.stringify("dashboard/normalizers.js")}] || {};`,
    `const {`,
    `  normalizeIceServerEntry = undefined,`,
    `  normalizeMotionSegments = undefined,`,
    `  normalizeStartTimestamps = undefined,`,
    `  normalizeTriggerSources = undefined,`,
    `  toFiniteOrNull = undefined,`,
    `} = normalizerHelpers;`,
    `const domHelpers = globalThis.__dashboardModules[${JSON.stringify("dashboard/dom.js")}] || {};`,
    `const {`,
    `  dataAttributeFromDatasetKey = undefined,`,
    `  findChildByDataset = undefined,`,
    `} = domHelpers;`,
    `const domRefsModule = globalThis.__dashboardModules[${JSON.stringify("dashboard/domRefs.js")}] || {};`,
    `const { createDashboardDom = undefined } = domRefsModule;`,
    `const themeHelpers = globalThis.__dashboardModules[${JSON.stringify("dashboard/theme.js")}] || {};`,
    `const { createThemeManager = undefined } = themeHelpers;`,
    `const healthHelpers = globalThis.__dashboardModules[${JSON.stringify("dashboard/health.js")}] || {};`,
    `const { createHealthManager = undefined } = healthHelpers;`,
    `const layoutHelpers = globalThis.__dashboardModules[${JSON.stringify("dashboard/layout/filters.js")}] || {};`,
    `const { createFiltersLayoutManager = undefined } = layoutHelpers;`,
    `const recordingMetaModule = globalThis.__dashboardModules[${JSON.stringify("dashboard/modules/recordingMetaController.js")}] || {};`,
    `const { createRecordingMetaController = undefined } = recordingMetaModule;`,
    `const encodingStatusModule = globalThis.__dashboardModules[${JSON.stringify("dashboard/modules/encodingStatusController.js")}] || {};`,
    `const { createEncodingStatusController = undefined } = encodingStatusModule;`,
    `const tabRecordingIndicatorModule = globalThis.__dashboardModules[${JSON.stringify("dashboard/modules/tabRecordingIndicator.js")}] || {};`,
    `const { createTabRecordingIndicator = undefined } = tabRecordingIndicatorModule;`,
    `const webServerSettingsModule = globalThis.__dashboardModules[${JSON.stringify("dashboard/modules/webServerSettingsController.js")}] || {};`,
    `const { createWebServerSettingsController = undefined } = webServerSettingsModule;`,
    `const archivalSettingsModule = globalThis.__dashboardModules[${JSON.stringify("dashboard/modules/archivalSettingsController.js")}] || {};`,
    `const { createArchivalSettingsController = undefined } = archivalSettingsModule;`,
    `const preferencesModule = globalThis.__dashboardModules[${JSON.stringify("dashboard/modules/preferencesStorage.js")}] || {};`,
    `const {`,
    `  clampLimitValue = undefined,`,
    `  clampOffsetValue = undefined,`,
    `  loadStoredCollection = undefined,`,
    `  persistCollection = undefined,`,
    `  persistFilters = undefined,`,
    `  clearStoredFilters = undefined,`,
    `  restoreFiltersFromStorage = undefined,`,
    `  persistSortPreference = undefined,`,
    `  restoreSortFromStorage = undefined,`,
    `  readStoredClipperPreference = undefined,`,
    `  persistClipperPreference = undefined,`,
    `  persistWaveformPreferences = undefined,`,
    `  getStoredWaveformAmplitude = undefined,`,
    `} = preferencesModule;`,
    `const pointerManagerModule = globalThis.__dashboardModules[${JSON.stringify("dashboard/modules/pointerManager.js")}] || {};`,
    `const { createPointerInteractionManager = undefined } = pointerManagerModule;`,
    `const recycleBinHelpersModule = globalThis.__dashboardModules[${JSON.stringify("dashboard/modules/recycleBinHelpers.js")}] || {};`,
    `const { createRecycleBinHelpers = undefined } = recycleBinHelpersModule;`,
    `const servicesControllerModule = globalThis.__dashboardModules[${JSON.stringify("dashboard/modules/servicesController.js")}] || {};`,
    `const { createServicesController = undefined } = servicesControllerModule;`,
    `const downloadsModule = globalThis.__dashboardModules[${JSON.stringify("dashboard/modules/downloads.js")}] || {};`,
    `const { createDownloadHelpers = undefined } = downloadsModule;`,
    `const scrollLockModule = globalThis.__dashboardModules[${JSON.stringify("dashboard/modules/scrollLockManager.js")}] || {};`,
    `const { createScrollLockManager = undefined } = scrollLockModule;`,
    `const appMenuModule = globalThis.__dashboardModules[${JSON.stringify("dashboard/modules/appMenuController.js")}] || {};`,
    `const { createAppMenuController = undefined } = appMenuModule;`,
    `const confirmDialogModule = globalThis.__dashboardModules[${JSON.stringify("dashboard/modules/confirmDialogController.js")}] || {};`,
    `const { createConfirmDialogController = undefined } = confirmDialogModule;`,
    `const recordingPathsModule = globalThis.__dashboardModules[${JSON.stringify("dashboard/modules/recordingPaths.js")}] || {};`,
    `const { createRecordingPathHelpers = undefined } = recordingPathsModule;`,
    `const focusUtilsModule = globalThis.__dashboardModules[${JSON.stringify("dashboard/modules/focusUtils.js")}] || {};`,
    `const { focusElementSilently = undefined } = focusUtilsModule;`,
    `const commonUtilsModule = globalThis.__dashboardModules[${JSON.stringify("dashboard/modules/commonUtils.js")}] || {};`,
    `const {`,
    `  ensureOfflineStateOnError = undefined,`,
    `  normalizeErrorMessage = undefined,`,
    `  clamp = undefined,`,
    `  numericValue = undefined,`,
    `  getRecordStartSeconds = undefined,`,
    `} = commonUtilsModule;`,
    `const renameDialogModule = globalThis.__dashboardModules[${JSON.stringify("dashboard/modules/renameDialogController.js")}] || {};`,
    `const { createRenameDialogController = undefined } = renameDialogModule;`,
    `const clipperModule = globalThis.__dashboardModules[${JSON.stringify("dashboard/modules/clipperController.js")}] || {};`,
    `const { createClipperController = undefined } = clipperModule;`,
    `const recorderDomModule = globalThis.__dashboardModules[${JSON.stringify("dashboard/recorderDom.js")}] || {};`,
    `const { createRecorderDom = undefined } = recorderDomModule;`,
    `const configModule = globalThis.__dashboardModules[${JSON.stringify("config.js")}];`,
    `const {`,
    `  ARCHIVAL_BACKENDS = new Set(),`,
    `  ARCHIVAL_ENDPOINT = undefined,`,
    `  AUTO_RECORD_ENDPOINT = undefined,`,
    `  AUTO_REFRESH_INTERVAL_MS = 1000,`,
    `  CLIPPER_STORAGE_KEY = undefined,`,
    `  COLLECTION_STORAGE_KEY = undefined,`,
    `  CONFIG_REFRESH_INTERVAL_MS = 5000,`,
    `  DEFAULT_LIMIT = 200,`,
    `  EVENTS_ENDPOINT = undefined,`,
    `  EVENT_STREAM_REQUIRES_CREDENTIALS = false,`,
    `  EVENT_STREAM_SAME_ORIGIN = true,`,
    `  EVENT_STREAM_HEARTBEAT_TIMEOUT_MS = 30000,`,
    `  EVENT_STREAM_RETRY_MAX_MS = 15000,`,
    `  EVENT_STREAM_RETRY_MIN_MS = 1000,`,
    `  EVENT_TRIGGER_DEBOUNCE_MS = 250,`,
    `  FILTER_PANEL_STORAGE_KEY = undefined,`,
    `  FILTER_STORAGE_KEY = undefined,`,
    `  HEALTH_ENDPOINT = undefined,`,
    `  HEALTH_REFRESH_MIN_INTERVAL_MS = AUTO_REFRESH_INTERVAL_MS,`,
    `  HLS_URL = undefined,`,
    `  KEYBOARD_JOG_RATE_SECONDS_PER_SECOND = 4,`,
    `  MANUAL_RECORD_ENDPOINT = undefined,`,
    `  MARKER_COLLAPSE_EPSILON_SECONDS = 0.002,`,
    `  MARKER_LABEL_BASE_OFFSET_REM = 0.95,`,
    `  MARKER_LABEL_EDGE_THRESHOLD = 0.08,`,
    `  MARKER_LABEL_SPACING_THRESHOLD = 0.04,`,
    `  MARKER_LABEL_STACK_SPACING_REM = 1.5,`,
    `  MAX_LIMIT = 1000,`,
    `  MAX_PLAYBACK_RATE = 2,`,
    `  MIN_CLIP_DURATION_SECONDS = 0.05,`,
    `  MIN_PLAYBACK_RATE = 0.25,`,
    `  OFFLINE_REFRESH_INTERVAL_MS = 5000,`,
    `  OFFER_ENDPOINT = undefined,`,
    `  POINTER_IDLE_CLEAR_DELAY_MS = 10000,`,
    `  RECYCLE_BIN_STATE_STORAGE_KEY = undefined,`,
    `  SERVICE_REFRESH_INTERVAL_MS = 5000,`,
    `  SERVICE_RESULT_TTL_MS = 15000,`,
    `  SERVICES_ENDPOINT = undefined,`,
    `  SESSION_STORAGE_KEY = undefined,`,
    `  SORT_STORAGE_KEY = undefined,`,
    `  SPLIT_ENDPOINT = undefined,`,
    `  START_ENDPOINT = undefined,`,
    `  STATS_ENDPOINT = undefined,`,
    `  STOP_ENDPOINT = undefined,`,
    `  STREAM_BASE = undefined,`,
    `  STREAM_MODE = "hls",`,
    `  THEME_STORAGE_KEY = undefined,`,
    `  TRANSPORT_SCRUB_MAX = 1000,`,
    `  TRANSPORT_SKIP_BACK_SECONDS = 10,`,
    `  TRANSPORT_SKIP_FORWARD_SECONDS = 30,`,
    `  TRANSPORT_STORAGE_KEY = undefined,`,
    `  VALID_TIME_RANGES = new Set(["", "1h", "2h", "4h", "8h", "12h", "1d"]),`,
    `  VOICE_RECORDER_SERVICE_UNIT = "voice-recorder.service",`,
    `  WAVEFORM_REFRESH_INTERVAL_MS = 3000,`,
    `  WAVEFORM_STORAGE_KEY = undefined,`,
    `  WAVEFORM_ZOOM_DEFAULT = 1,`,
    `  WAVEFORM_ZOOM_MAX = 10,`,
    `  WAVEFORM_ZOOM_MIN = 1,`,
    `  WEBRTC_ICE_SERVERS = [],`,
    `  WEB_SERVER_ENDPOINT = undefined,`,
    `  WEB_SERVER_TLS_PROVIDERS = new Set(["letsencrypt", "manual"]),`,
    `  WINDOW_NAME_PREFIX = "tricorder.session:",`,
    `  clampPlaybackRateValue = (value) => value,`,
    `} = configModule || {};`,
    `const formattersModule = globalThis.__dashboardModules[${JSON.stringify("formatters.js")}];`,
    `const {`,
    `  dateFormatter = undefined,`,
    `  formatBytes = undefined,`,
    `  formatClockTime = undefined,`,
    `  formatClipLengthText = undefined,`,
    `  formatDate = undefined,`,
    `  formatDbDisplay = undefined,`,
    `  formatDuration = undefined,`,
    `  formatEncodingSource = undefined,`,
    `  formatHzDisplay = undefined,`,
    `  formatIsoDateTime = undefined,`,
    `  formatPlaybackRateLabel = undefined,`,
    `  formatQualityDisplay = undefined,`,
    `  formatRecorderUptimeHint = undefined,`,
    `  formatRecorderUptimeValue = undefined,`,
    `  formatRecordingStartTime = undefined,`,
    `  formatRatioDisplay = undefined,`,
    `  formatShortDuration = undefined,`,
    `  formatTimeSlug = undefined,`,
    `  formatTimecode = undefined,`,
    `  formatTransportClock = undefined,`,
    `  formatUnitless = undefined,`,
    `  formatWaveformZoom = undefined,`,
    `  normalizeEncodingSource = undefined,`,
    `  timeFormatter = undefined,`,
    `  userLocales = undefined,`,
    `} = formattersModule || {};`,
    `const stateModule = globalThis.__dashboardModules[${JSON.stringify("state.js")}] || {};`,
    `const stateApi = stateModule;`,
    `const {`,
    `  dashboardState: state = stateModule.dashboardState || {},`,
    `  healthState = stateModule.healthState || {},`,
    `  splitEventState = stateModule.splitEventState || {},`,
    `  updateDashboardState = stateModule.updateDashboardState || ((fn) => { if (typeof fn === "function") { fn(state); } return state; }),`,
    `  updateHealthState = stateModule.updateHealthState || ((fn) => { if (typeof fn === "function") { fn(healthState); } return healthState; }),`,
    `  updateSplitEventState = stateModule.updateSplitEventState || ((fn) => { if (typeof fn === "function") { fn(splitEventState); } return splitEventState; }),`,
    `  getPendingSelectionRange = stateModule.getPendingSelectionRange || (() => null),`,
    `  setPendingSelectionRange = stateModule.setPendingSelectionRange || (() => {}),`,
    `  clearPendingSelectionRange = stateModule.clearPendingSelectionRange || (() => null),`,
    `  getStateEvents = stateModule.getStateEvents || (() => []),`,
    `} = stateModule;`,
    `if (formattersModule) { Object.assign(globalThis, formattersModule); }`,
  ].join("\n");
  const wrapped = `${header}\n${dashboardSource}`;
  vm.runInContext(wrapped, sandbox, { filename: "dashboard.js" });

  const stateExports = sandbox.TRICORDER_STATE || {};
  sandbox.splitEventState = stateExports.splitEventState || { pending: false };
  sandbox.healthState = stateExports.healthState || { sdCard: null, lastUpdated: null, resources: {} };
  const dashboardState = sandbox.window.TRICORDER_DASHBOARD_STATE || stateExports.dashboardState || {};
  sandbox.updateDashboardState = (mutator) => {
    if (typeof mutator === "function") {
      mutator(dashboardState);
    }
    return dashboardState;
  };
  sandbox.updateHealthState = (mutator) => {
    if (typeof mutator === "function") {
      mutator(sandbox.healthState);
    }
    return sandbox.healthState;
  };
  sandbox.updateSplitEventState = (mutator) => {
    if (typeof mutator === "function") {
      mutator(sandbox.splitEventState);
    }
    return sandbox.splitEventState;
  };

  delete sandbox.__dashboardModules;
  if (globalThis.__DASHBOARD_ELEMENT_OVERRIDES) {
    delete globalThis.__DASHBOARD_ELEMENT_OVERRIDES;
  }
  return sandbox;
}

module.exports = { loadDashboard };
