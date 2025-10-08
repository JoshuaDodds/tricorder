const fs = require("fs");
const path = require("path");
const vm = require("vm");

function createMockElement() {
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
    children: [],
    append(...nodes) {
      for (const node of nodes) {
        if (node !== undefined && node !== null) {
          element.children.push(node);
        }
      }
    },
    appendChild(node) {
      if (node !== undefined && node !== null) {
        element.children.push(node);
      }
      return node;
    },
    removeChild(node) {
      const index = element.children.indexOf(node);
      if (index !== -1) {
        element.children.splice(index, 1);
      }
      return node;
    },
    get childElementCount() {
      return element.children.length;
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
    getElementById: (id) => (elementStore.has(id) ? elementStore.get(id) : null),
    querySelector: () => null,
    querySelectorAll: () => [],
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

  vm.createContext(sandbox);
  return { sandbox, windowStub };
}

function loadDashboard() {
  const { sandbox } = createSandbox();
  const dashboardPath = path.join(__dirname, "..", "..", "lib", "webui", "static", "js", "dashboard.js");
  const code = fs.readFileSync(dashboardPath, "utf8");
  vm.runInContext(code, sandbox, { filename: "dashboard.js" });
  if (globalThis.__DASHBOARD_ELEMENT_OVERRIDES) {
    delete globalThis.__DASHBOARD_ELEMENT_OVERRIDES;
  }
  return sandbox;
}

module.exports = { loadDashboard };
