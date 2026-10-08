// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaptureError, activeCaptures, buildCaptureEvent, captureKey, transitionProblem, type CaptureEvent, type CaptureRequest } from "../../src/lib/creatorCaptures.ts";
import { buildCaptureQueue, type QueueScope } from "./captureQueue.ts";
import { buildReviewState } from "./reviewState.ts";
import { NOW, discoveryFor, record, vid } from "./testSupport.ts";

// jsdom gives test files an http import.meta.url, so read from the repository root.
const REVIEW_DIRECTORY = resolve(process.cwd(), "scripts/creator-corpus/review");
const CLIENT = readFileSync(resolve(REVIEW_DIRECTORY, "client.js"), "utf8");
const CAPTURE = readFileSync(resolve(REVIEW_DIRECTORY, "capture.js"), "utf8");
const PAGE = readFileSync(resolve(REVIEW_DIRECTORY, "index.html"), "utf8");
const TOKEN = "TEST_TOKEN_VALUE";
const TEXT = "0:00 welcome to the show, today we go through every player prop on the board. ".repeat(5);

type Json = Record<string, unknown>;
type Call = { path: string; method: string; headers: Record<string, string>; body: Json | null };

let listeners: [string, EventListenerOrEventListenerObject][] = [];

// An in-memory stand-in for the local server, built on the real event builder,
// transition rules and queue builder so the page is exercised against authentic
// data and rules. (The real file-backed store is covered by its own tests; it
// reads import.meta.url, which jsdom does not give as a file URL.)
const makeServer = async (discovery = discoveryFor([
  record(1, { title: "NFL Week 6 Player Props", publishedAt: "2025-10-09T15:00:00Z" }),
  record(2, { title: "Week 6 NFL best bets and picks", publishedAt: "2025-10-08T15:00:00Z" }),
  record(4, { title: "NFL Week 7 Player Props", publishedAt: "2025-10-16T15:00:00Z" }),
]), { now = () => NOW }: { now?: () => Date } = {}) => {
  const events: CaptureEvent[] = [];
  const store = {
    read: async () => [...events],
    append: async (request: CaptureRequest) => {
      let event: CaptureEvent;
      try {
        event = buildCaptureEvent(request, now());
      } catch (error) {
        if (error instanceof CaptureError) throw Object.assign(new Error(error.code), { code: error.code });
        throw error;
      }
      const problem = transitionProblem(activeCaptures(events).get(captureKey(event.creatorKey, event.videoId))?.state, event.event);
      if (problem) throw Object.assign(new Error(problem), { code: problem });
      events.push(event);
      return event;
    },
  };
  const calls: Call[] = [];
  let failWith: { status: number; error: string } | null = null;
  let failOnce = false;
  let hold: Promise<void> | null = null;
  const queue = async (scope: QueueScope) =>
    buildCaptureQueue({ discovery, decisions: {}, captures: await store.read(), scope, now: now() });
  const respond = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
  const fetchImpl = async (target: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const url = new URL(target, "http://127.0.0.1");
    const call: Call = { path: target, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ? (JSON.parse(init.body) as Json) : null };
    calls.push(call);
    if (url.pathname === "/api/data") {
      return respond(200, { ...buildReviewState({ discovery, decisions: {}, now: now() }), features: { captures: true } });
    }
    if (url.pathname === "/api/captures") {
      return respond(200, await queue(url.searchParams.get("scope") === "included-and-flagged" ? "included-and-flagged" : "included"));
    }
    if (hold) await hold;
    if (failWith) {
      const failure = failWith;
      if (failOnce) failWith = null;
      return respond(failure.status, { error: failure.error });
    }
    const body = call.body as { scope: QueueScope } & Record<string, unknown>;
    try {
      const { scope, ...request } = body;
      const event = await store.append(request as never);
      return respond(200, {
        receipt: { creatorKey: event.creatorKey, videoId: event.videoId, event: event.event, capturedAt: event.capturedAt, characters: event.characters, hash: event.sha256 === null ? null : event.sha256.slice(0, 12) },
        queue: await queue(scope),
      });
    } catch (error) {
      const code = (error as { code?: string }).code ?? "server-error";
      return respond(code === "already-captured" || code === "stale-discovery-data" ? 409 : 400, { error: code });
    }
  };
  return {
    calls,
    events,
    fetchImpl,
    posts: () => calls.filter((call) => call.method === "POST"),
    failPostsWith: (status: number, error: string, once = false) => {
      failWith = { status, error };
      failOnce = once;
    },
    stopFailing: () => (failWith = null),
    holdPosts: (promise: Promise<void> | null) => (hold = promise),
  };
};

type TestServer = Awaited<ReturnType<typeof makeServer>>;

const mount = async (server: TestServer, { features = true }: { features?: boolean } = {}) => {
  const body = new DOMParser().parseFromString(PAGE, "text/html").body;
  body.querySelectorAll("script").forEach((script) => script.remove());
  document.body.replaceChildren(...Array.from(body.childNodes).map((node) => document.importNode(node, true)));
  const proxy = new Proxy(document, {
    get(target, property) {
      if (property === "addEventListener") {
        return (type: string, listener: EventListenerOrEventListenerObject, options?: boolean) => {
          listeners.push([type, listener]);
          target.addEventListener(type, listener, options);
        };
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  const fetchImpl = features
    ? server.fetchImpl
    : async (target: string, init?: never) => {
        const reply = await server.fetchImpl(target, init);
        if (target !== "/api/data") return reply;
        const data = (await reply.json()) as Json;
        delete data.features;
        return { ok: true, status: 200, json: async () => data };
      };
  if (features) new Function("document", "TextEncoder", CAPTURE)(proxy, TextEncoder);
  new Function("document", "location", "history", "fetch", "HTMLInputElement", "HTMLSelectElement", CLIENT)(
    proxy,
    { hash: `#token=${TOKEN}`, pathname: "/", search: "" },
    { replaceState: vi.fn() },
    fetchImpl,
    HTMLInputElement,
    HTMLSelectElement
  );
  await vi.waitFor(() => expect(document.getElementById("status")!.textContent).not.toBe("Loading…"));
};

const openCapture = async () => {
  click(document.getElementById("tab-capture"));
  await vi.waitFor(() => expect(status()).toBe("Loaded the capture queue."));
};

afterEach(() => {
  for (const [type, listener] of listeners) document.removeEventListener(type, listener);
  listeners = [];
  document.body.replaceChildren();
  delete (globalThis as { creatorCapture?: unknown }).creatorCapture;
});

const click = (element: Element | null) => (element as HTMLElement).click();
const status = () => document.getElementById("capture-status")!.textContent;
const current = () => document.getElementById("capture-current")!;
const heading = () => current().querySelector("h3")?.textContent ?? null;
const textarea = () => current().querySelector<HTMLTextAreaElement>(".cap-text")!;
const field = (selector: string) => current().querySelector<HTMLInputElement>(selector)!;
const buttonNamed = (name: string) =>
  [...current().querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === name);
const type = (box: HTMLTextAreaElement | HTMLInputElement, value: string) => {
  box.value = value;
  box.dispatchEvent(new Event("input", { bubbles: true }));
};
const rows = () => [...document.querySelectorAll<HTMLElement>("#capture-list > li")];
const rowTitles = () => rows().map((row) => row.querySelector("button")!.textContent);
const error = () => current().querySelector(".error")!.textContent;
const save = async (text = TEXT) => {
  type(textarea(), text);
  click(buttonNamed("Save transcript") ?? buttonNamed("Replace transcript") ?? null);
};
const savedLog = async (server: TestServer) => server.events;
const show = (value: string) => {
  const select = document.getElementById("capture-filter") as HTMLSelectElement;
  select.value = value;
  select.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("the capture tab", () => {
  it("is hidden entirely when the server has no captures file", async () => {
    const server = await makeServer();
    await mount(server, { features: false });
    expect(document.getElementById("views")!.hidden).toBe(true);
    expect(document.getElementById("capture-view")!.hidden).toBe(true);
    expect(server.calls.some((call) => call.path.startsWith("/api/captures"))).toBe(false);
  });

  it("appears with captures enabled, switches views, and loads the queue only once", async () => {
    const server = await makeServer();
    await mount(server);
    expect(document.getElementById("views")!.hidden).toBe(false);
    expect(document.getElementById("capture-view")!.hidden).toBe(true);
    expect(server.calls.some((call) => call.path.startsWith("/api/captures"))).toBe(false);

    await openCapture();
    expect(document.getElementById("capture-view")!.hidden).toBe(false);
    expect(document.getElementById("review-view")!.hidden).toBe(true);
    expect(document.getElementById("creators")!.hidden).toBe(true);
    expect(document.getElementById("tab-capture")!.getAttribute("aria-pressed")).toBe("true");
    expect(document.getElementById("tab-review")!.getAttribute("aria-pressed")).toBe("false");

    click(document.getElementById("tab-review"));
    expect(document.getElementById("capture-view")!.hidden).toBe(true);
    expect(document.getElementById("review-view")!.hidden).toBe(false);
    expect(document.getElementById("creators")!.hidden).toBe(false);
    click(document.getElementById("tab-capture"));
    expect(server.calls.filter((call) => call.path.startsWith("/api/captures"))).toHaveLength(1);
  });

  it("sends the session token with every capture request", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    await save();
    await vi.waitFor(() => expect(server.posts()).toHaveLength(1));
    for (const call of server.calls) expect(call.headers.Authorization, call.path).toBe("Bearer " + TOKEN);
  });
});

describe("what it shows", () => {
  it("lists the creators with how many transcripts each still needs", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    const tabs = [...document.querySelectorAll("#capture-creators button")].map((node) => node.textContent);
    expect(tabs).toEqual(["creator-a (2 to capture)", "creator-b (0 to capture)"]);
    expect(document.getElementById("capture-summary")!.textContent).toContain("2still need a transcript");
  });

  it("opens on the oldest video that needs a transcript, with the date hint in Pacific time", async () => {
    const discovery = discoveryFor([
      record(1, { title: "NFL Week 6 Player Props", publishedAt: "2025-10-10T02:00:00Z" }),
      record(2, { title: "NFL Week 6 Player Props early", publishedAt: "2025-10-08T15:00:00Z" }),
    ]);
    const server = await makeServer(discovery);
    await mount(server);
    await openCapture();
    expect(heading()).toBe("NFL Week 6 Player Props early");
    expect(field(".cap-date").value).toBe("2025-10-08");
    click(rows().find((row) => row.textContent!.includes("NFL Week 6 Player Props") && !row.textContent!.includes("early"))!.querySelector("button"));
    expect(heading()).toBe("NFL Week 6 Player Props");
    // 02:00 UTC on the 10th is still the 9th in California.
    expect(field(".cap-date").value).toBe("2025-10-09");
  });

  it("links to YouTube only from a valid video id", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    const link = current().querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://www.youtube.com/watch?v=" + vid(1));
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("lists only what needs a transcript by default, and the other states on request", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    expect(rowTitles()).toEqual(["NFL Week 6 Player Props", "NFL Week 7 Player Props"]);
    show("all");
    expect(rows()).toHaveLength(2);
    show("captured");
    expect(rows()).toHaveLength(0);
    expect(document.getElementById("capture-count")!.textContent).toBe("Showing 0 of 0 videos.");
  });

  it("includes flagged videos only when asked, by asking the server for that scope", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    expect(rowTitles()).not.toContain("Week 6 NFL best bets and picks");
    const box = document.getElementById("capture-scope") as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(rowTitles()).toContain("Week 6 NFL best bets and picks"));
    expect(server.calls.at(-1)!.path).toBe("/api/captures?scope=included-and-flagged");
    box.checked = false;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(rowTitles()).not.toContain("Week 6 NFL best bets and picks"));
    expect(server.calls.at(-1)!.path).toBe("/api/captures?scope=included");
  });

  it("shows the live character, size and line count while typing, and warns when it looks short", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    expect(current().querySelector(".meter")!.textContent).toBe("0 characters · 0 bytes · 0 lines");
    type(textarea(), "a\nb");
    expect(current().querySelector(".meter")!.textContent).toContain("3 characters · 3 bytes · 2 lines");
    expect(current().querySelector(".meter")!.textContent).toContain("looks short");
    type(textarea(), TEXT);
    expect(current().querySelector(".meter")!.textContent).not.toContain("looks short");
    expect(current().querySelector(".meter")!.textContent).toContain("1 lines");
    type(textarea(), "é".repeat(300_000));
    expect(current().querySelector(".meter")!.textContent).toContain("over the 500 KB limit");
  });
});

describe("saving a transcript", () => {
  it("sends exactly the video, text, confirmed date, caption type and scope, then moves to the next video", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    type(field(".cap-date"), "2025-10-09");
    (field(".cap-kind") as unknown as HTMLSelectElement).value = "auto-generated";
    type(field(".cap-note"), "  checked on the page  ");
    await save();
    await vi.waitFor(() => expect(server.posts()).toHaveLength(1));
    expect(server.posts()[0]!.method).toBe("POST");
    expect(server.posts()[0]!.headers["Content-Type"]).toBe("application/json");
    expect(server.posts()[0]!.body).toEqual({
      creatorKey: "creator-a",
      videoId: vid(1),
      action: "capture",
      scope: "included",
      note: "checked on the page",
      text: TEXT,
      publishedDate: "2025-10-09",
      captionKind: "auto-generated",
    });
    await vi.waitFor(() => expect(heading()).toBe("NFL Week 7 Player Props"));
    expect(status()).toBe(`Saved: NFL Week 6 Player Props (${TEXT.length.toLocaleString("en-US")} characters)`);
    expect(textarea().value).toBe("");
    expect(document.activeElement).toBe(textarea());
    expect(rowTitles()).toEqual(["NFL Week 7 Player Props"]);
    expect(document.getElementById("capture-summary")!.textContent).toContain("1captured");
    expect(await savedLog(server)).toHaveLength(1);
  });

  it("remembers the caption type for the next video", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    (field(".cap-kind") as unknown as HTMLSelectElement).value = "uploaded";
    await save();
    await vi.waitFor(() => expect(heading()).toBe("NFL Week 7 Player Props"));
    expect((field(".cap-kind") as unknown as HTMLSelectElement).value).toBe("uploaded");
    expect(server.posts()[0]!.body).not.toHaveProperty("note");
  });

  it("does not offer a stale Save anyway after the text changes and another problem occurs", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    await save("just a few words");
    await vi.waitFor(() => expect(buttonNamed("Save anyway")).toBeTruthy());
    server.failPostsWith(503, "file-busy", true);
    type(textarea(), TEXT);
    click(buttonNamed("Save transcript") ?? null);
    await vi.waitFor(() => expect(error()).toContain("Another process"));
    expect(buttonNamed("Save anyway")).toBeUndefined();
  });

  it("refuses an empty transcript and a bad date without sending anything", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    click(buttonNamed("Save transcript") ?? null);
    expect(error()).toContain("Paste the transcript first");
    expect(document.activeElement).toBe(textarea());
    type(textarea(), TEXT);
    type(field(".cap-date"), "");
    click(buttonNamed("Save transcript") ?? null);
    expect(error()).toContain("publish date");
    expect(document.activeElement).toBe(field(".cap-date"));
    type(textarea(), "é".repeat(300_000));
    type(field(".cap-date"), "2025-10-09");
    click(buttonNamed("Save transcript") ?? null);
    expect(error()).toContain("over 500 KB");
    expect(server.posts()).toHaveLength(0);
  });

  it("asks before saving a short transcript, keeps the text meanwhile, and resends with confirmation", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    await save("just a few words");
    await vi.waitFor(() => expect(buttonNamed("Save anyway")).toBeTruthy());
    expect(error()).toContain("looks short");
    expect(textarea().value).toBe("just a few words");
    expect(server.posts()[0]!.body).not.toHaveProperty("confirmShort");
    click(buttonNamed("Save anyway") ?? null);
    await vi.waitFor(() => expect(heading()).toBe("NFL Week 7 Player Props"));
    expect(server.posts()[1]!.body).toMatchObject({ confirmShort: true, text: "just a few words" });
    expect(await savedLog(server)).toHaveLength(1);
  });

  it("does not keep a stale Save anyway button after the text is saved or the request is retried", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    await save("just a few words");
    await vi.waitFor(() => expect(buttonNamed("Save anyway")).toBeTruthy());
    type(textarea(), TEXT);
    click(buttonNamed("Save transcript") ?? null);
    await vi.waitFor(() => expect(heading()).toBe("NFL Week 7 Player Props"));
    expect(buttonNamed("Save anyway")).toBeUndefined();
  });

  it("keeps everything typed and says why when the server refuses", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    server.failPostsWith(503, "file-busy");
    type(field(".cap-note"), "keep this note");
    await save();
    await vi.waitFor(() => expect(error()).toContain("Another process"));
    expect(textarea().value).toBe(TEXT);
    expect(field(".cap-note").value).toBe("keep this note");
    expect(heading()).toBe("NFL Week 6 Player Props");
    expect(buttonNamed("Save transcript")!.disabled).toBe(false);
    // Retry succeeds once the problem is gone.
    server.stopFailing();
    click(buttonNamed("Save transcript") ?? null);
    await vi.waitFor(() => expect(heading()).toBe("NFL Week 7 Player Props"));
  });

  it("gives a plain message for every fixed server code, and a generic one for anything else", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    const expected: Record<string, string> = {
      "stale-discovery-data": "too old",
      "invalid-captures-file": "damaged",
      "already-captured": "already has a transcript",
      "transcript-invalid-characters": "control characters",
      "unauthorized": "session token",
      "insecure-file-permissions": "chmod 600",
      "video-not-in-queue": "not in the queue",
      "mystery-code": "could not save",
    };
    for (const [code, words] of Object.entries(expected)) {
      server.failPostsWith(code === "unauthorized" ? 401 : 400, code);
      await save();
      await vi.waitFor(() => expect(error(), code).toContain(words));
      expect(error()).not.toContain(code);
      expect(textarea().value).toBe(TEXT);
    }
  });

  it("recovers from an unexpected server failure, keeping the text and allowing a retry", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    server.failPostsWith(500, "server-error", true);
    await save();
    await vi.waitFor(() => expect(error()).toContain("could not save"));
    expect(textarea().value).toBe(TEXT);
    click(buttonNamed("Save transcript") ?? null);
    await vi.waitFor(() => expect(heading()).toBe("NFL Week 7 Player Props"));
    expect(server.events).toHaveLength(1);
  });

  it("sends one request when Save is pressed twice while a save is in flight", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    let release!: () => void;
    server.holdPosts(new Promise<void>((done) => (release = done)));
    type(textarea(), TEXT);
    const saveButton = buttonNamed("Save transcript")!;
    click(saveButton);
    await vi.waitFor(() => expect(saveButton.disabled).toBe(true));
    click(saveButton);
    click(buttonNamed("No transcript available") ?? null);
    textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    release();
    await vi.waitFor(() => expect(heading()).toBe("NFL Week 7 Player Props"));
    expect(server.posts()).toHaveLength(1);
  });

  it("saves with Ctrl+Enter or Cmd+Enter in the transcript box only", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    type(textarea(), TEXT);
    textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(server.posts()).toHaveLength(0);
    textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    await vi.waitFor(() => expect(heading()).toBe("NFL Week 7 Player Props"));
    expect(server.posts()).toHaveLength(1);
    type(textarea(), TEXT);
    textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    await vi.waitFor(() => expect(server.posts()).toHaveLength(2));
  });
});

describe("marking a video unavailable", () => {
  it("sends no transcript, and the note if one was typed", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    type(textarea(), TEXT);
    type(field(".cap-note"), "captions disabled");
    click(buttonNamed("No transcript available") ?? null);
    await vi.waitFor(() => expect(server.posts()).toHaveLength(1));
    expect(server.posts()[0]!.body).toEqual({
      creatorKey: "creator-a",
      videoId: vid(1),
      action: "unavailable",
      scope: "included",
      note: "captions disabled",
      publishedDate: "2025-10-09",
    });
    await vi.waitFor(() => expect(heading()).toBe("NFL Week 7 Player Props"));
    expect(status()).toBe("Marked unavailable: NFL Week 6 Player Props");
    show("unavailable");
    expect(rowTitles()).toEqual(["NFL Week 6 Player Props"]);
  });

  it("sends the date as confirmed on the form, and refuses a missing or invalid one without sending anything", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    type(field(".cap-date"), "");
    click(buttonNamed("No transcript available") ?? null);
    expect(error()).toContain("publish date");
    expect(document.activeElement).toBe(field(".cap-date"));
    expect(server.posts()).toHaveLength(0);
    type(field(".cap-date"), "2025-10-08");
    click(buttonNamed("No transcript available") ?? null);
    await vi.waitFor(() => expect(server.posts()).toHaveLength(1));
    expect(server.posts()[0]!.body).toMatchObject({ action: "unavailable", publishedDate: "2025-10-08" });
    expect(server.events[0]).toMatchObject({ event: "unavailable", publishedDate: "2025-10-08" });
  });

  it("lets a video marked unavailable be captured later", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    click(buttonNamed("No transcript available") ?? null);
    await vi.waitFor(() => expect(heading()).toBe("NFL Week 7 Player Props"));
    show("unavailable");
    click(rows()[0]!.querySelector("button"));
    expect(current().textContent).toContain("Marked unavailable");
    await save();
    await vi.waitFor(() => expect(status()).toContain("Saved: NFL Week 6 Player Props"));
    expect(await savedLog(server)).toHaveLength(2);
  });
});

describe("replacing a transcript", () => {
  const withOneCaptured = async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    await save();
    await vi.waitFor(() => expect(heading()).toBe("NFL Week 7 Player Props"));
    show("captured");
    click(rows()[0]!.querySelector("button"));
    return server;
  };

  it("shows what is saved without showing the transcript, and offers only Replace", async () => {
    await withOneCaptured();
    expect(current().textContent).toContain(`Saved ${TEXT.length.toLocaleString("en-US")} characters`);
    expect(current().querySelector(".description")!.textContent!.length).toBeLessThanOrEqual(161);
    expect(buttonNamed("Replace transcript")).toBeTruthy();
    expect(buttonNamed("Save transcript")).toBeUndefined();
    expect(buttonNamed("No transcript available")).toBeUndefined();
    expect(textarea().value).toBe("");
  });

  it("requires a reason and sends it with the new text", async () => {
    const server = await withOneCaptured();
    type(textarea(), TEXT + " corrected");
    click(buttonNamed("Replace transcript") ?? null);
    expect(error()).toContain("reason for replacing");
    expect(server.posts()).toHaveLength(1);
    type(field(".cap-reason"), "pasted the wrong part");
    click(buttonNamed("Replace transcript") ?? null);
    await vi.waitFor(() => expect(server.posts()).toHaveLength(2));
    expect(server.posts()[1]!.body).toMatchObject({ action: "replace", reason: "pasted the wrong part", videoId: vid(1) });
    await vi.waitFor(() => expect(status()).toContain("Replaced: NFL Week 6 Player Props"));
    expect(await savedLog(server)).toHaveLength(2);
  });
});

describe("moving around", () => {
  it("skips to the next video that needs a transcript without saving, and wraps around", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    click(buttonNamed("Skip") ?? null);
    expect(heading()).toBe("NFL Week 7 Player Props");
    click(buttonNamed("Skip") ?? null);
    expect(heading()).toBe("NFL Week 6 Player Props");
    expect(server.posts()).toHaveLength(0);
  });

  it("skips with n, but never while typing in a field, and ignores other keys", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true }));
    expect(heading()).toBe("NFL Week 6 Player Props");
    field(".cap-note").dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true }));
    expect(heading()).toBe("NFL Week 6 Player Props");
    field(".cap-kind").dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true }));
    expect(heading()).toBe("NFL Week 6 Player Props");
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "m", bubbles: true }));
    expect(heading()).toBe("NFL Week 6 Player Props");
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true }));
    expect(heading()).toBe("NFL Week 7 Player Props");
  });

  it("ignores n while the review view is showing", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    click(document.getElementById("tab-review"));
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true }));
    expect(heading()).toBe("NFL Week 6 Player Props");
  });

  it("does not let the review view's j and k keys steal focus from the transcript box", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    textarea().focus();
    textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true }));
    expect(document.activeElement).toBe(textarea());
  });

  it("keeps an unsaved transcript while looking at another video, and brings it back", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    type(textarea(), "half pasted");
    type(field(".cap-note"), "a note");
    click(rows()[1]!.querySelector("button"));
    expect(heading()).toBe("NFL Week 7 Player Props");
    expect(textarea().value).toBe("");
    click(rows()[0]!.querySelector("button"));
    expect(textarea().value).toBe("half pasted");
    expect(field(".cap-note").value).toBe("a note");
    expect(server.posts()).toHaveLength(0);
  });

  it("switches creators, opening on that creator's next video", async () => {
    const server = await makeServer(
      discoveryFor([record(1, { title: "NFL Week 6 Player Props" })], [record(900, { title: "NFL Week 6 Player Props from b" })])
    );
    await mount(server);
    await openCapture();
    click(document.querySelectorAll("#capture-creators button")[1]!);
    expect(heading()).toBe("NFL Week 6 Player Props from b");
    expect(document.querySelectorAll("#capture-creators button")[1]!.getAttribute("aria-pressed")).toBe("true");
    await save();
    await vi.waitFor(() => expect(server.posts()).toHaveLength(1));
    expect(server.posts()[0]!.body).toMatchObject({ creatorKey: "creator-b", videoId: vid(900) });
  });

  it("searches titles and filters to a chosen week from the grid", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    const query = document.getElementById("capture-query") as HTMLInputElement;
    type(query, "week 7");
    expect(rowTitles()).toEqual(["NFL Week 7 Player Props"]);
    type(query, "");
    const week7 = () => [...document.querySelectorAll<HTMLButtonElement>("#capture-grid button")].find((node) => node.getAttribute("aria-label")!.startsWith("2025 week 7"))!;
    expect(week7().getAttribute("aria-label")).toBe("2025 week 7: 0 captured, 0 unavailable, 1 left");
    click(week7());
    expect(week7().getAttribute("aria-pressed")).toBe("true");
    expect(rowTitles()).toEqual(["NFL Week 7 Player Props"]);
    expect(document.getElementById("capture-week-note")!.hidden).toBe(false);
    expect(document.getElementById("capture-week-note")!.textContent).toContain("2025 week 7");
    click(week7());
    expect(week7().getAttribute("aria-pressed")).toBe("false");
    expect(rowTitles()).toHaveLength(2);
    expect(document.getElementById("capture-week-note")!.hidden).toBe(true);
  });

  it("marks weeks with nothing queued, some left, and done", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    await save();
    await vi.waitFor(() => expect(heading()).toBe("NFL Week 7 Player Props"));
    const label = (week: number) =>
      [...document.querySelectorAll<HTMLButtonElement>("#capture-grid button")].find((node) => node.getAttribute("aria-label")!.startsWith(`2025 week ${week}:`))!;
    expect(label(6).className).toContain("slot-present");
    expect(label(7).className).toContain("slot-review");
    expect(label(5).className).toContain("slot-empty");
  });

  it("shows a hundred and fifty videos fifty at a time", async () => {
    const many = Array.from({ length: 120 }, (_, index) =>
      record(index + 1, { title: `NFL Week 6 Player Props ${index + 1}`, publishedAt: `2025-10-09T${String(Math.floor(index / 60) + 10).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00Z` })
    );
    const server = await makeServer(discoveryFor(many));
    await mount(server);
    await openCapture();
    expect(rows()).toHaveLength(50);
    expect(document.getElementById("capture-count")!.textContent).toBe("Showing 50 of 120 videos.");
    click(document.getElementById("capture-more"));
    expect(rows()).toHaveLength(100);
    click(document.getElementById("capture-more"));
    expect(rows()).toHaveLength(120);
    expect(document.getElementById("capture-more")!.hidden).toBe(true);
    const box = document.getElementById("capture-scope") as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(server.calls.at(-1)!.path).toBe("/api/captures?scope=included-and-flagged"));
    await vi.waitFor(() => expect(document.getElementById("capture-count")!.textContent).toBe("Showing 50 of 120 videos."));
  });
});

describe("drafts and overlapping actions", () => {
  it("forgets a draft once it is saved, so a later replace starts empty", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    type(textarea(), "half pasted");
    click(rows()[1]!.querySelector("button"));
    click(rows()[0]!.querySelector("button"));
    expect(textarea().value).toBe("half pasted");
    await save();
    await vi.waitFor(() => expect(heading()).toBe("NFL Week 7 Player Props"));
    show("captured");
    click(rows()[0]!.querySelector("button"));
    expect(textarea().value).toBe("");
  });

  it("does not freeze a video's caption type just because it was visited", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    click(rows()[1]!.querySelector("button"));
    (field(".cap-kind") as unknown as HTMLSelectElement).value = "uploaded";
    click(rows()[0]!.querySelector("button"));
    expect((field(".cap-kind") as unknown as HTMLSelectElement).value).toBe("uploaded");
  });

  it("keeps a draft per creator when switching creators and back", async () => {
    const server = await makeServer(
      discoveryFor([record(1, { title: "NFL Week 6 Player Props" })], [record(900, { title: "NFL Week 6 Player Props from b" })])
    );
    await mount(server);
    await openCapture();
    type(textarea(), "unsaved words");
    click(document.querySelectorAll("#capture-creators button")[1]!);
    expect(textarea().value).toBe("");
    click(document.querySelectorAll("#capture-creators button")[0]!);
    expect(textarea().value).toBe("unsaved words");
  });

  it("sends one request even if the owner opens another video and presses its Save while one is in flight", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    let release!: () => void;
    server.holdPosts(new Promise<void>((done) => (release = done)));
    await save();
    await vi.waitFor(() => expect(server.posts()).toHaveLength(1));
    click(rows()[1]!.querySelector("button"));
    expect(heading()).toBe("NFL Week 7 Player Props");
    type(textarea(), TEXT + " second");
    click(buttonNamed("Save transcript") ?? null);
    expect(server.posts()).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(status()).toContain("Saved: NFL Week 6 Player Props"));
    expect(server.posts()).toHaveLength(1);
  });

  it("keeps text typed on another video when a save finishes late, and does not jump away or take focus", async () => {
    const server = await makeServer(
      discoveryFor([
        record(1, { title: "NFL Week 6 Player Props", publishedAt: "2025-10-09T15:00:00Z" }),
        record(4, { title: "NFL Week 7 Player Props", publishedAt: "2025-10-16T15:00:00Z" }),
        record(5, { title: "NFL Week 8 Player Props", publishedAt: "2025-10-23T15:00:00Z" }),
      ])
    );
    await mount(server);
    await openCapture();
    let release!: () => void;
    server.holdPosts(new Promise<void>((done) => (release = done)));
    await save();
    await vi.waitFor(() => expect(server.posts()).toHaveLength(1));
    // Move to the third video, not the one the page would advance to.
    click(rows()[2]!.querySelector("button"));
    expect(heading()).toBe("NFL Week 8 Player Props");
    type(textarea(), "typed while waiting");
    release();
    await vi.waitFor(() => expect(status()).toContain("Saved: NFL Week 6 Player Props"));
    expect(heading()).toBe("NFL Week 8 Player Props");
    expect(textarea().value).toBe("typed while waiting");
    expect(document.activeElement).not.toBe(textarea());
  });

  it("sends the chosen scope with a save, so a flagged video stays in the queue afterwards", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    const box = document.getElementById("capture-scope") as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(rowTitles()).toContain("Week 6 NFL best bets and picks"));
    click(rows().find((row) => row.textContent!.includes("best bets"))!.querySelector("button"));
    await save();
    await vi.waitFor(() => expect(server.posts()).toHaveLength(1));
    expect(server.posts()[0]!.body).toMatchObject({ scope: "included-and-flagged", videoId: vid(2) });
    show("all");
    expect(rowTitles()).toContain("Week 6 NFL best bets and picks");
  });

  it("offers no YouTube link when a video id is not a valid id", async () => {
    const server = await makeServer(discoveryFor([record(1, { videoId: "bad id/../x", title: "NFL Week 6 Player Props" })]));
    await mount(server);
    await openCapture();
    expect(current().querySelector("a")).toBeNull();
    expect(current().textContent).toContain("No valid video link");
  });
});

describe("when the saved YouTube data is too old", () => {
  const staleNow = new Date(NOW.getTime() + 40 * 24 * 60 * 60 * 1000);

  it("withholds the list, offers no way to save, says how to refresh, and keeps log-only counts", async () => {
    const server = await makeServer(undefined, { now: () => staleNow });
    server.events.push(
      buildCaptureEvent({ creatorKey: "creator-a", videoId: vid(1), action: "capture", text: TEXT, publishedDate: "2025-10-09" }, NOW)
    );
    await mount(server);
    await openCapture();
    const banner = document.getElementById("capture-banner")!;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain("over 30 days old");
    expect(banner.textContent).toContain("withheld");
    expect(banner.textContent).toContain("purge command");
    expect(rows()).toHaveLength(0);
    expect(current().textContent).toBe("The video list is withheld until the YouTube data is refreshed.");
    expect(buttonNamed("Save transcript")).toBeUndefined();
    expect(textarea()).toBeNull();
    const summary = document.getElementById("capture-summary")!.textContent!;
    expect(summary).toContain("—still need a transcript");
    expect(summary).toContain("1captured");
  });

  it("shows no banner for fresh data", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    expect(document.getElementById("capture-banner")!.hidden).toBe(true);
  });

  it("disables saving if the data goes stale after the page loaded", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    server.failPostsWith(409, "stale-discovery-data");
    await save();
    await vi.waitFor(() => expect(error()).toContain("too old"));
    expect(textarea().value).toBe(TEXT);
  });
});

describe("untrusted text", () => {
  it("shows hostile titles and notes as plain text only", async () => {
    const hostile = '<img src=x onerror="window.pwned=1"> NFL Week 6 Player Props <script>window.pwned=2</script>';
    const server = await makeServer(discoveryFor([record(1, { title: hostile, publishedAt: "2025-10-09T15:00:00Z" })]));
    await mount(server);
    await openCapture();
    expect(heading()).toBe(hostile);
    expect(rowTitles()).toEqual([hostile]);
    type(field(".cap-note"), "<b onclick=alert(1)>note</b>");
    await save();
    await vi.waitFor(() => expect(status()).toContain("Saved: "));
    show("captured");
    click(rows()[0]!.querySelector("button"));
    expect(document.querySelector("#capture-view img, #capture-view script, #capture-view b")).toBeNull();
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  it("never shows the transcript outside the box, even as a preview of what is saved beyond its length", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    const secret = "SENTINEL-WORDS ".repeat(40);
    await save(secret);
    await vi.waitFor(() => expect(heading()).toBe("NFL Week 7 Player Props"));
    show("captured");
    click(rows()[0]!.querySelector("button"));
    const shown = document.getElementById("capture-view")!.textContent!;
    expect(shown.split("SENTINEL-WORDS").length - 1).toBeLessThanOrEqual(12);
  });
});

describe("browser storage and unsafe APIs", () => {
  it("never writes markup, evaluates code, or touches any browser storage", () => {
    for (const pattern of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function/, /localStorage/, /sessionStorage/, /indexedDB/, /document\.cookie/, /\.style\b/, /setAttribute\(\s*["']on/i, /postMessage/, /window\.open/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bEventSource\b/, /navigator\./]) {
      expect(CAPTURE, String(pattern)).not.toMatch(pattern);
    }
  });

  it("makes requests only to its own two capture routes", () => {
    const targets = [...CAPTURE.matchAll(/api\(\s*["']([^"']+)/g)].map((match) => match[1]);
    expect(targets.sort()).toEqual(["/api/capture", "/api/captures?scope="]);
    expect(CAPTURE).not.toMatch(/https?:\/\/(?!www\.youtube\.com\/watch)/);
    expect(CAPTURE).not.toMatch(/\bfetch\(/);
  });

  it("keeps the transcript out of every URL and address-bar update", async () => {
    const server = await makeServer();
    await mount(server);
    await openCapture();
    await save();
    await vi.waitFor(() => expect(server.posts()).toHaveLength(1));
    for (const call of server.calls) expect(call.path).not.toContain("welcome");
  });
});
