import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const popupWindows: Array<{ options: unknown; loadURL: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> }> = [];
  const defaultSession = {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setSpellCheckerEnabled: vi.fn(),
    on: vi.fn(),
  };
  const partitionSessions = new Map<string, {
    setPermissionRequestHandler: ReturnType<typeof vi.fn>;
    setPermissionCheckHandler: ReturnType<typeof vi.fn>;
    setSpellCheckerEnabled: ReturnType<typeof vi.fn>;
  }>();
  const fromPartition = vi.fn((partition: string) => {
    const ses = {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setSpellCheckerEnabled: vi.fn(),
    };
    partitionSessions.set(partition, ses);
    return ses;
  });
  return { appOn: vi.fn(), defaultSession, partitionSessions, fromPartition, popupWindows };
});
const settings = new Map<string, unknown>();

vi.mock("electron", () => ({
  app: { on: mocks.appOn },
  session: { defaultSession: mocks.defaultSession, fromPartition: mocks.fromPartition },
  BrowserWindow: class {
    loadURL = vi.fn();
    focus = vi.fn();
    constructor(options: unknown) {
      mocks.popupWindows.push({ options, loadURL: this.loadURL, focus: this.focus });
    }
  },
}));
vi.mock("electron-log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../db", () => ({
  readSetting: (key: string) => settings.get(key) ?? null,
}));

const business = "https://business.example";
const external = "https://external.example";
const originalProduct = process.env.NUWAX_APP_IDENTIFIER;

function fakeContents(type: "window" | "webview", url: string, session: unknown = mocks.defaultSession) {
  return {
    getType: () => type,
    getURL: () => url,
    session,
    isDestroyed: () => false,
    on: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    send: vi.fn(),
    openDevTools: vi.fn(),
  };
}

function popup(target: string, referrer: string) {
  return {
    url: target,
    features: "width=500,height=300",
    referrer: { url: referrer, policy: "strict-origin-when-cross-origin" },
  } as never;
}

async function setup(product = "nuwax") {
  process.env.NUWAX_APP_IDENTIFIER = product;
  vi.resetModules();
  const { initWebviewPolicy } = await import("./webviewPolicy");
  initWebviewPolicy(() => null);
  const created = mocks.appOn.mock.calls.find(([name]) => name === "web-contents-created")?.[1];
  expect(created).toBeTypeOf("function");
  return created as (_event: unknown, contents: ReturnType<typeof fakeContents>) => void;
}

function attachedWebview(created: Awaited<ReturnType<typeof setup>>, source: string) {
  const host = fakeContents("window", "file:///app/index.html");
  const guest = fakeContents("webview", source);
  created({}, host);
  const attach = host.on.mock.calls.find(([name]) => name === "did-attach-webview")?.[1];
  expect(attach).toBeTypeOf("function");
  attach({}, guest);
  return guest;
}

function webviewPopupHandler(created: Awaited<ReturnType<typeof setup>>, source: string) {
  const guest = attachedWebview(created, source);
  return guest.setWindowOpenHandler.mock.lastCall?.[0] as (details: unknown) => {
    action: string;
    overrideBrowserWindowOptions?: { webPreferences: Record<string, unknown>; width: number; height: number };
  };
}

beforeEach(() => {
  settings.clear();
  settings.set("step1_config", { serverHost: business });
  mocks.appOn.mockClear();
  mocks.fromPartition.mockClear();
  mocks.partitionSessions.clear();
  mocks.popupWindows.length = 0;
});
afterEach(() => {
  if (originalProduct === undefined) delete process.env.NUWAX_APP_IDENTIFIER;
  else process.env.NUWAX_APP_IDENTIFIER = originalProduct;
});

describe("window.open session boundary", () => {
  it("trusted business webview opens trusted target with business session and bridge", async () => {
    const handler = webviewPopupHandler(await setup(), `${business}/home`);
    const result = handler(popup(`${business}/agent`, `${business}/home`));
    const options = result.overrideBrowserWindowOptions!;
    expect(result.action).toBe("allow");
    expect(options.width).toBe(1000);
    expect(options.height).toBe(600);
    expect(options.webPreferences.session).toBe(mocks.defaultSession);
    expect(options.webPreferences.partition).toBeUndefined();
    expect(options.webPreferences.preload).toMatch(/webviewPerfBridge\.js$/);
    expect(options.webPreferences.additionalArguments).toEqual(expect.arrayContaining([
      "--nuwax-host-product=nuwax",
    ]));
  });

  it("business to external popup has no bridge and a fresh memory session", async () => {
    const handler = webviewPopupHandler(await setup(), `${business}/home`);
    const first = handler(popup(`${external}/docs`, `${business}/home`)).overrideBrowserWindowOptions!;
    const second = handler(popup(`${external}/docs`, `${business}/home`)).overrideBrowserWindowOptions!;
    expect(first.webPreferences.preload).toBeUndefined();
    expect(first.webPreferences.session).toBeUndefined();
    expect(first.webPreferences.partition).toMatch(/^temp:nuwax-popup-/);
    expect(second.webPreferences.partition).not.toBe(first.webPreferences.partition);
    const isolated = mocks.partitionSessions.get(first.webPreferences.partition as string);
    expect(isolated).toBeDefined();
    expect(isolated?.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(isolated?.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
    expect(isolated?.setSpellCheckerEnabled).toHaveBeenCalledWith(false);
    const request = isolated?.setPermissionRequestHandler.mock.lastCall?.[0] as (
      contents: unknown, permission: string, callback: (allowed: boolean) => void,
    ) => void;
    const check = isolated?.setPermissionCheckHandler.mock.lastCall?.[0] as (
      contents: unknown, permission: string,
    ) => boolean;
    const answer = vi.fn();
    request(null, "media", answer);
    expect(answer).toHaveBeenCalledWith(false);
    expect(check(null, "notifications")).toBe(false);
    expect(check(null, "fullscreen")).toBe(true);
  });

  it("external webview, external iframe and credentialed URL cannot inherit business session", async () => {
    const created = await setup();
    const externalHandler = webviewPopupHandler(created, `${external}/docs`);
    const businessHandler = webviewPopupHandler(created, `${business}/home`);
    for (const result of [
      externalHandler(popup(`${business}/agent`, `${external}/docs`)),
      businessHandler(popup(`${business}/agent`, `${external}/iframe`)),
      businessHandler(popup(`https://user:pass@business.example/agent`, `${business}/home`)),
      businessHandler(popup(`${business}/agent`, `https://user:pass@business.example/home`)),
      businessHandler(popup(`${business}/agent`, "")),
    ]) {
      expect(result.overrideBrowserWindowOptions?.webPreferences.partition)
        .toMatch(/^temp:nuwax-popup-/);
      expect(result.overrideBrowserWindowOptions?.webPreferences.preload).toBeUndefined();
    }
  });

  it("popup from isolated BrowserWindow remains isolated, including second level popup", async () => {
    const created = await setup();
    const isolated = fakeContents("window", `${business}/home`, { isolated: true });
    created({}, isolated);
    const handler = isolated.setWindowOpenHandler.mock.lastCall?.[0] as (details: unknown) => {
      overrideBrowserWindowOptions: { webPreferences: Record<string, unknown> };
    };
    const child = handler(popup(`${business}/agent`, `${business}/home`));
    expect(child.overrideBrowserWindowOptions.webPreferences.partition).toMatch(/^temp:nuwax-popup-/);
    expect(child.overrideBrowserWindowOptions.webPreferences.preload).toBeUndefined();
    const grandchild = handler(popup(`${external}/docs`, `${business}/home`));
    expect(grandchild.overrideBrowserWindowOptions.webPreferences.partition)
      .not.toBe(child.overrideBrowserWindowOptions.webPreferences.partition);
  });

  it("trusted standalone business window keeps bridge for trusted child", async () => {
    const created = await setup();
    const businessWindow = fakeContents("window", `${business}/home`);
    created({}, businessWindow);
    const handler = businessWindow.setWindowOpenHandler.mock.lastCall?.[0] as (details: unknown) => {
      overrideBrowserWindowOptions: { webPreferences: Record<string, unknown> };
    };
    const child = handler(popup(`${business}/agent`, `${business}/home`));
    expect(child.overrideBrowserWindowOptions.webPreferences.session).toBe(mocks.defaultSession);
    expect(child.overrideBrowserWindowOptions.webPreferences.preload).toMatch(/webviewPerfBridge\.js$/);
  });

  it("denies about:blank and preserves the community popup defaults", async () => {
    const handler = webviewPopupHandler(await setup("nuwaclaw"), `${external}/home`);
    expect(handler(popup("about:blank", `${external}/home`))).toEqual({ action: "deny" });
    const result = handler(popup(`${business}/agent`, `${external}/home`));
    expect(result.overrideBrowserWindowOptions?.webPreferences.partition).toBeUndefined();
    expect(result.overrideBrowserWindowOptions?.webPreferences.preload).toBeUndefined();
  });
});

describe("business top-level navigation boundary", () => {
  it("moves _self cross-origin navigation into an isolated window", async () => {
    const guest = attachedWebview(await setup(), `${business}/home`);
    const onNavigate = guest.on.mock.calls.find(([name]) => name === "will-frame-navigate")?.[1];
    const event = { url: `${external}/docs`, isMainFrame: true, preventDefault: vi.fn() };
    onNavigate(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(mocks.popupWindows).toHaveLength(1);
    expect(mocks.popupWindows[0].loadURL).toHaveBeenCalledWith(`${external}/docs`);
    expect((mocks.popupWindows[0].options as any).webPreferences.partition)
      .toMatch(/^temp:nuwax-popup-/);
    expect((mocks.popupWindows[0].options as any).webPreferences.preload).toBeUndefined();
    const sameOrigin = { url: `${business}/agent`, isMainFrame: true, preventDefault: vi.fn() };
    onNavigate(sameOrigin);
    expect(sameOrigin.preventDefault).not.toHaveBeenCalled();
    const iframe = { url: `${external}/embed`, isMainFrame: false, preventDefault: vi.fn() };
    onNavigate(iframe);
    expect(iframe.preventDefault).not.toHaveBeenCalled();
  });

  it("blocks an initial trusted page's 302 to an external origin before commit", async () => {
    const guest = attachedWebview(await setup(), "");
    const onRedirect = guest.on.mock.calls.find(([name]) => name === "will-redirect")?.[1];
    const event = { url: `${external}/checkout`, isMainFrame: true, preventDefault: vi.fn() };
    onRedirect(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect((mocks.popupWindows[0].options as any).webPreferences.partition)
      .toMatch(/^temp:nuwax-popup-/);
    expect(mocks.popupWindows[0].loadURL).toHaveBeenCalledWith(`${external}/checkout`);
  });

  it("places an external initial webview src in a fresh memory session", async () => {
    process.env.NUWAX_APP_IDENTIFIER = "nuwax";
    vi.resetModules();
    const { isolateUntrustedInitialWebview } = await import("./webviewPolicy");
    const preferences = { preload: "/sensitive/preload.js", session: mocks.defaultSession } as any;
    const params = { src: `${external}/docs` };
    expect(isolateUntrustedInitialWebview(preferences, params)).toBe(true);
    expect(preferences.partition).toMatch(/^temp:nuwax-webview-/);
    expect(preferences.session).toBeUndefined();
    expect(preferences.preload).toBeUndefined();
    expect((params as any).partition).toBe(preferences.partition);
    expect(mocks.partitionSessions.get(preferences.partition)?.setPermissionRequestHandler)
      .toHaveBeenCalledOnce();
    expect(isolateUntrustedInitialWebview({}, { src: `${business}/home` })).toBe(false);
  });
});

describe("defaultSession permission origin boundary", () => {
  it("requires the top document and actual requesting frame to be current business origins", async () => {
    await setup();
    const request = mocks.defaultSession.setPermissionRequestHandler.mock.lastCall?.[0] as (
      contents: unknown, permission: string, callback: (allowed: boolean) => void,
      details: { requestingUrl: string },
    ) => void;
    const check = mocks.defaultSession.setPermissionCheckHandler.mock.lastCall?.[0] as (
      contents: unknown, permission: string, requestingOrigin: string,
      details: { isMainFrame: boolean; requestingUrl?: string; embeddingOrigin?: string },
    ) => boolean;
    const top = fakeContents("webview", `${business}/home`);
    const answer = vi.fn();
    request(top, "media", answer, { requestingUrl: `${business}/camera` });
    expect(answer).toHaveBeenLastCalledWith(true);
    request(top, "media", answer, { requestingUrl: `${external}/iframe` });
    expect(answer).toHaveBeenLastCalledWith(false);
    expect(check(top, "clipboard-read", business,
      { isMainFrame: true, requestingUrl: `${business}/home` })).toBe(true);
    expect(check(top, "clipboard-read", external,
      { isMainFrame: false, embeddingOrigin: business })).toBe(false);
    expect(check(top, "notifications", business,
      { isMainFrame: false, embeddingOrigin: external })).toBe(false);
    expect(check(fakeContents("webview", `${external}/docs`), "media", business,
      { isMainFrame: true })).toBe(false);
    expect(check(null, "media", business, { isMainFrame: true })).toBe(false);
    settings.set("step1_config", { serverHost: "https://new-business.example" });
    expect(check(top, "media", business, { isMainFrame: true })).toBe(false);
  });
});
