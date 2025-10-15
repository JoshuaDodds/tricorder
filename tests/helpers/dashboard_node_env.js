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
    style: {},
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
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
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
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  sandbox.URLSearchParams = URLSearchParams;

  vm.createContext(sandbox);
  return { sandbox, windowStub };
}

async function loadDashboard() {
  const { sandbox } = createSandbox();
  const statePath = path.join(
    __dirname,
    "..",
    "..",
    "lib",
    "webui",
    "static",
    "js",
    "state.js",
  );
  const stateCode = fs.readFileSync(statePath, "utf8");
  vm.runInContext(stateCode, sandbox, { filename: "state.js" });
  const dashboardPath = path.join(__dirname, "..", "..", "lib", "webui", "static", "js", "dashboard.js");
  const code = fs.readFileSync(dashboardPath, "utf8");
  vm.runInContext(code, sandbox, { filename: "dashboard.js" });
  if (globalThis.__DASHBOARD_ELEMENT_OVERRIDES) {
    delete globalThis.__DASHBOARD_ELEMENT_OVERRIDES;
  }
  return sandbox;
}

module.exports = { loadDashboard };
