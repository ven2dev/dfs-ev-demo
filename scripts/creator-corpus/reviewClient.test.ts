// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionEvent } from "../../src/lib/creatorDecisions.ts";
import { buildReviewState, type ReviewState } from "./reviewState.ts";
import { NOW, discoveryFor, record, vid } from "./testSupport.ts";

// jsdom gives test files an http import.meta.url, so read from the repository root.
const REVIEW_DIRECTORY = resolve(process.cwd(), "scripts/creator-corpus/review");
const CLIENT = readFileSync(resolve(REVIEW_DIRECTORY, "client.js"), "utf8");
const PAGE = readFileSync(resolve(REVIEW_DIRECTORY, "index.html"), "utf8");
const TOKEN = "TEST_TOKEN_VALUE";

type Json = Record<string, unknown>;
type Call = { path: string; method: string; headers: Record<string, string>; body: Json | null };

// A tiny in-memory stand-in for the local server, built on the real state
// builder so the page is exercised against authentic data shapes.
const makeServer = (initial: { discovery: ReturnType<typeof discoveryFor>; events?: Record<string, DecisionEvent[]> }) => {
  const events: Record<string, DecisionEvent[]> = initial.events ?? {};
  const calls: Call[] = [];
  let postStatus: number | "network" | null = null;
  let hold: Promise<void> | null = null;
  const state = (): ReviewState => buildReviewState({ discovery: initial.discovery, decisions: events, now: NOW });
  const fetchImpl = async (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const call: Call = {
      path,
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      body: init.body ? (JSON.parse(init.body) as Json) : null,
    };
    calls.push(call);
    if (call.method === "POST") {
      if (hold) await hold;
      if (postStatus === "network") throw new TypeError("network down");
      if (postStatus !== null) {
        const error = postStatus === 409 ? "stale-discovery-data" : "server-error";
        return { ok: false, status: postStatus, json: async () => ({ error }) };
      }
      const body = call.body as { creatorKey: string; videoId: string; decision: DecisionEvent["decision"]; reason: string };
      const event: DecisionEvent = {
        videoId: body.videoId,
        decision: body.decision,
        reason: body.reason,
        ruleVersion: "v1",
        decidedAt: `2026-10-07T12:${String(calls.length).padStart(2, "0")}:00.000Z`,
      };
      (events[body.creatorKey] ??= []).push(event);
      return { ok: true, status: 200, json: async () => ({ event, state: state() }) };
    }
    return { ok: true, status: 200, json: async () => state() };
  };
  return {
    calls,
    fetchImpl,
    failPostsWith: (status: number | "network" | null) => (postStatus = status),
    holdPosts: (promise: Promise<void> | null) => (hold = promise),
    state,
  };
};

let listeners: [string, EventListenerOrEventListenerObject][] = [];
let replaceState: ReturnType<typeof vi.fn>;

// Runs the real client script against the page skeleton. `document` is a thin
// proxy so each test's keyboard listeners can be removed afterwards.
const mount = async (server: ReturnType<typeof makeServer>, hash = `#token=${TOKEN}`) => {
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
  replaceState = vi.fn();
  const location = { hash, pathname: "/", search: "" };
  new Function("document", "location", "history", "fetch", "HTMLInputElement", "HTMLSelectElement", CLIENT)(
    proxy,
    location,
    { replaceState },
    server.fetchImpl,
    HTMLInputElement,
    HTMLSelectElement
  );
  await vi.waitFor(() => expect(document.getElementById("status")!.textContent).not.toBe("Loading…"));
};

afterEach(() => {
  for (const [type, listener] of listeners) document.removeEventListener(type, listener);
  listeners = [];
  document.body.replaceChildren();
  document.title = "";
});
beforeEach(() => {
  document.title = "";
});

const text = (selector: string) => document.querySelector(selector)?.textContent ?? "";
const cards = () => [...document.querySelectorAll<HTMLElement>("#videos > li")];
const titles = () => cards().map((card) => card.querySelector("h3")!.textContent);
const cardFor = (title: string) => cards().find((card) => card.querySelector("h3")!.textContent === title)!;
const click = (element: Element | null) => (element as HTMLElement).click();
const choose = (id: string, value: string) => {
  const select = document.getElementById(id) as HTMLSelectElement | HTMLInputElement;
  select.value = value;
  select.dispatchEvent(new Event("input", { bubbles: true }));
};
const reasonField = (card: HTMLElement) => card.querySelector<HTMLInputElement>(".reason")!;
const button = (card: HTMLElement, name: string) =>
  [...card.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === name)!;
const decideOn = async (card: HTMLElement, name: string, reason: string) => {
  reasonField(card).value = reason;
  click(button(card, name));
};

const basic = () =>
  makeServer({
    discovery: discoveryFor([
      record(1, { title: "Week 6 NFL best bets and picks", publishedAt: "2025-10-09T15:00:00Z" }),
      record(2, { title: "NFL Week 6 Player Props", publishedAt: "2025-10-08T15:00:00Z" }),
      record(3, { title: "NFL Week 6 reaction and recap", publishedAt: "2025-10-10T15:00:00Z" }),
      record(4, { title: "NFL Week 7 picks tonight", publishedAt: "2025-10-16T15:00:00Z" }),
    ]),
  });

describe("loading", () => {
  it("shows a clear message and makes no request when the token is missing", async () => {
    const server = basic();
    await mount(server, "");
    expect(text("#status")).toContain("Missing token");
    expect(server.calls).toHaveLength(0);
  });

  it("sends the token on every request and removes it from the address bar", async () => {
    const server = basic();
    await mount(server);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
    expect(server.calls[0]).toMatchObject({ path: "/api/data", method: "GET" });
    expect(server.calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(replaceState.mock.calls)).not.toContain(TOKEN);
  });

  it("reports an unusable session instead of an empty page", async () => {
    const server = basic();
    const failing = { ...server, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: "unauthorized" }) }) };
    await mount(failing as unknown as ReturnType<typeof makeServer>);
    expect(text("#status")).toContain("token was not accepted");
    expect(document.getElementById("list-section")!.hidden).toBe(true);
  });
});

describe("rendering", () => {
  it("lists creators, a week grid for every season, and only videos needing review by default", async () => {
    await mount(basic());
    expect([...document.querySelectorAll("#creators button")].map((node) => node.textContent)).toEqual([
      "creator-a (2 to review)",
      "creator-b (1 to review)",
    ]);
    expect(document.querySelectorAll("#grid tbody tr")).toHaveLength(3);
    expect(document.querySelectorAll("#grid thead th")).toHaveLength(19);
    expect(titles()).toEqual(["NFL Week 7 picks tonight", "Week 6 NFL best bets and picks"]);
    expect(text("#count")).toBe("Showing 2 of 2 videos.");
    expect(text("#summary")).toContain("videos to review");
  });

  it("describes each video with its week, time in Eastern, length, rule status and plain reasons", async () => {
    await mount(basic());
    const card = cardFor("Week 6 NFL best bets and picks");
    expect(card.querySelector(".meta")!.textContent).toBe("2025 week 6 · Oct 9, 2025, 11:00 AM ET · 30:00");
    expect(card.textContent).toContain("Needs review");
    expect(card.textContent).toContain("Rule said: Needs review");
    expect(card.querySelector(".reasons li")!.textContent).toBe("Title says picks or best bets but never props.");
  });

  it("links to YouTube only from a valid video id and never lets the page open another site", async () => {
    await mount(basic());
    const link = cardFor("Week 6 NFL best bets and picks").querySelector("a")!;
    expect(link.getAttribute("href")).toBe(`https://www.youtube.com/watch?v=${vid(1)}`);
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("target")).toBe("_blank");
    expect([...document.querySelectorAll("a")].every((anchor) => anchor.getAttribute("href")!.startsWith("https://www.youtube.com/watch?v="))).toBe(true);
  });

  it("renders no link at all when a video id is not a valid id", async () => {
    const server = basic();
    const data = server.state();
    data.creators[0].videos[0] = { ...data.creators[0].videos[0], videoId: "javascript:alert(1)", status: "needs-review", title: "Odd id" };
    await mount({ ...server, fetchImpl: async () => ({ ok: true, status: 200, json: async () => data }) } as unknown as ReturnType<typeof makeServer>);
    choose("filter-status", "all");
    expect(cardFor("Odd id").querySelector("a")).toBeNull();
    expect(cardFor("Odd id").textContent).toContain("No valid video link");
  });
});

describe("untrusted text", () => {
  const hostile = [
    '<img src=x onerror="document.title=\'XSS\'">',
    '"><svg onload=document.title="XSS">',
    "<script>document.title='XSS'</script>",
    "<iframe src=//evil.example></iframe>",
    "<a href=\"javascript:document.title='XSS'\">x</a>",
    "<style>body{display:none}</style>",
  ];

  it("shows hostile titles, descriptions, reasons and decisions as plain text only", async () => {
    const events: Record<string, DecisionEvent[]> = {};
    const server = makeServer({
      discovery: discoveryFor(
        hostile.map((markup, index) => record(index + 1, { title: `${markup} NFL props`, description: `${markup} description` })),
        [record(900)]
      ),
      events,
    });
    // Every record is hostile, including the owner's own reasons from the log.
    events["creator-a"] = hostile.map((markup, index) => ({
      videoId: vid(index + 1),
      decision: "exclude" as const,
      reason: markup,
      ruleVersion: "v1",
      decidedAt: `2026-10-07T10:0${index}:00.000Z`,
    }));
    await mount(server);
    choose("filter-status", "all");
    for (const markup of hostile) {
      expect(titles().some((title) => title === `${markup} NFL props`)).toBe(true);
    }
    const injected = document.querySelectorAll("#videos img, #videos svg, #videos script, #videos iframe, #videos style, #summary *:not(div):not(strong):not(span):not(p)");
    expect(injected).toHaveLength(0);
    expect(document.querySelectorAll("#videos a:not(.open)")).toHaveLength(0);
    const handlers = [...document.querySelectorAll("*")].filter((node) => [...node.attributes].some((attribute) => attribute.name.startsWith("on")));
    expect(handlers).toHaveLength(0);
    expect(document.title).toBe("");
    // The owner's stored reasons are shown as the text they typed.
    expect(cards().some((card) => card.querySelector(".decision")!.textContent === `Your decision: exclude — ${hostile[0]}`)).toBe(true);
  });

  it("never writes markup through any API in the client source", () => {
    for (const forbidden of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "setAttribute(\"on"]) {
      expect(CLIENT, forbidden).not.toContain(forbidden);
    }
    // The element builder itself refuses code-bearing attributes.
    expect(CLIENT).toContain('lower.startsWith("on") || lower === "style" || lower === "srcdoc"');
  });
});

describe("filters", () => {
  it("filters by status, reason and search text, and orders by date", async () => {
    await mount(basic());
    choose("filter-status", "all");
    expect(titles()).toEqual(["NFL Week 7 picks tonight", "NFL Week 6 reaction and recap", "Week 6 NFL best bets and picks", "NFL Week 6 Player Props"]);
    choose("filter-sort", "oldest");
    expect(titles()[0]).toBe("NFL Week 6 Player Props");
    choose("filter-status", "present");
    expect(titles()).toEqual(["NFL Week 6 Player Props"]);
    choose("filter-status", "excluded");
    expect(titles()).toEqual(["NFL Week 6 reaction and recap"]);
    choose("filter-status", "all");
    choose("filter-reason", "no-prop-signal");
    expect(titles()).toEqual(["NFL Week 6 reaction and recap"]);
    choose("filter-reason", "all");
    choose("filter-query", "TONIGHT");
    expect(titles()).toEqual(["NFL Week 7 picks tonight"]);
    choose("filter-query", "no such words");
    expect(titles()).toEqual([]);
    expect(text("#count")).toBe("Showing 0 of 0 videos.");
  });

  it("offers only the reasons that appear for the chosen creator, with their plain labels", async () => {
    await mount(basic());
    const options = [...document.querySelectorAll("#filter-reason option")].map((option) => [option.getAttribute("value"), option.textContent]);
    expect(options).toContainEqual(["all", "Any reason"]);
    expect(options).toContainEqual(["picks-without-prop-signal", "Title says picks or best bets but never props."]);
    expect(options.map(([value]) => value)).not.toContain("short-form");
  });

  it("switches creators and resets the week selection", async () => {
    await mount(basic());
    click(document.querySelector('button[aria-label^="2025 week 6"]'));
    expect(text("#week-note")).toContain("2025 week 6");
    click([...document.querySelectorAll("#creators button")][1]);
    expect(document.querySelector("#creators .selected")!.textContent).toContain("creator-b");
    expect(document.getElementById("week-note")!.hidden).toBe(true);
    expect(titles()).toEqual(["NFL Week 6 best bets"]);
  });
});

describe("week grid", () => {
  it("labels each week with its status and counts and shows every video of a selected week", async () => {
    await mount(basic());
    const week6 = document.querySelector('button[aria-label^="2025 week 6"]')!;
    expect(week6.getAttribute("aria-label")).toBe("2025 week 6: included, 1 included, 1 to review");
    expect(document.querySelector('button[aria-label^="2025 week 5"]')!.getAttribute("aria-label")).toContain("missing");
    click(week6);
    expect(week6.getAttribute("aria-pressed")).toBe("false");
    const chosen = document.querySelector('button[aria-label^="2025 week 6"]')!;
    expect(chosen.getAttribute("aria-pressed")).toBe("true");
    expect(titles().sort()).toEqual(["NFL Week 6 Player Props", "NFL Week 6 reaction and recap", "Week 6 NFL best bets and picks"].sort());
    expect(document.getElementById("week-note")!.hidden).toBe(false);
    click(chosen);
    expect(document.getElementById("week-note")!.hidden).toBe(true);
    expect(titles()).toEqual(["NFL Week 7 picks tonight", "Week 6 NFL best bets and picks"]);
  });
});

describe("recording decisions", () => {
  it("refuses an empty reason without sending anything and returns focus to the field", async () => {
    const server = basic();
    await mount(server);
    const card = cardFor("Week 6 NFL best bets and picks");
    click(button(card, "Include"));
    expect(card.querySelector(".error")!.textContent).toBe("Enter a reason first.");
    expect(document.activeElement).toBe(reasonField(card));
    reasonField(card).value = "   ";
    click(button(card, "Exclude"));
    expect(server.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("sends exactly the creator, video, decision and reason and updates the card, summary and week grid", async () => {
    const server = basic();
    await mount(server);
    await decideOn(cardFor("Week 6 NFL best bets and picks"), "Include", "  Props throughout the video  ");
    await vi.waitFor(() => expect(text("#status")).toContain("Saved: include"));
    const post = server.calls.find((call) => call.method === "POST")!;
    expect(post.path).toBe("/api/decision");
    expect(post.body).toEqual({ creatorKey: "creator-a", videoId: vid(1), decision: "include", reason: "Props throughout the video" });
    expect(post.headers["Content-Type"]).toBe("application/json");
    expect(post.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(titles()).toEqual(["NFL Week 7 picks tonight"]);
    choose("filter-status", "decided");
    const card = cardFor("Week 6 NFL best bets and picks");
    expect(card.className).toContain("status-present");
    expect(card.querySelector(".decision")!.textContent).toBe("Your decision: include — Props throughout the video");
    expect(card.querySelector(".history summary")!.textContent).toBe("History (1)");
    expect(text("#summary")).toContain("1decisions made");
    expect(document.querySelector('button[aria-label^="2025 week 6"]')!.getAttribute("aria-label")).toContain("2 included, 0 to review");
  });

  it("enables Clear only when a decision is active, and clearing keeps the history", async () => {
    const server = basic();
    await mount(server);
    let card = cardFor("Week 6 NFL best bets and picks");
    expect(button(card, "Clear decision").disabled).toBe(true);
    await decideOn(card, "Exclude", "recap only");
    await vi.waitFor(() => expect(text("#status")).toContain("Saved: exclude"));
    choose("filter-status", "decided");
    card = cardFor("Week 6 NFL best bets and picks");
    expect(button(card, "Clear decision").disabled).toBe(false);
    await decideOn(card, "Clear decision", "reconsidering after the full video");
    await vi.waitFor(() => expect(text("#status")).toContain("Saved: clear"));
    expect(titles()).toEqual([]);
    choose("filter-status", "all");
    card = cardFor("Week 6 NFL best bets and picks");
    expect(card.querySelector(".decision")).toBeNull();
    expect(card.querySelector(".history summary")!.textContent).toBe("History (2)");
    expect([...card.querySelectorAll(".history li")].map((item) => item.textContent)).toEqual([
      expect.stringContaining("exclude · recap only (rule v1)"),
      expect.stringContaining("clear · reconsidering after the full video (rule v1)"),
    ]);
  });

  it("blocks a second submission while one is in flight", async () => {
    const server = basic();
    let release!: () => void;
    server.holdPosts(new Promise<void>((resolve) => (release = resolve)));
    await mount(server);
    const card = cardFor("Week 6 NFL best bets and picks");
    await decideOn(card, "Include", "first");
    await vi.waitFor(() => expect(server.calls.some((call) => call.method === "POST")).toBe(true));
    expect([...document.querySelectorAll<HTMLButtonElement>(".act")].every((entry) => entry.disabled)).toBe(true);
    click(button(card, "Exclude"));
    expect(server.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(text("#status")).toContain("Saved: include"));
  });

  it("records a decision for the creator being viewed, not the first one", async () => {
    const server = basic();
    await mount(server);
    click([...document.querySelectorAll("#creators button")][1]);
    await decideOn(cardFor("NFL Week 6 best bets"), "Exclude", "recap only");
    await vi.waitFor(() => expect(text("#status")).toContain("Saved: exclude"));
    expect(server.calls.find((call) => call.method === "POST")!.body).toEqual({
      creatorKey: "creator-b",
      videoId: vid(900),
      decision: "exclude",
      reason: "recap only",
    });
  });

  it("sends only one request when Enter is pressed again while a save is in flight", async () => {
    const server = basic();
    let release!: () => void;
    server.holdPosts(new Promise<void>((resolve) => (release = resolve)));
    await mount(server);
    const card = cardFor("Week 6 NFL best bets and picks");
    card.focus();
    card.dispatchEvent(new KeyboardEvent("keydown", { key: "i", bubbles: true }));
    reasonField(card).value = "props throughout";
    const enter = () => reasonField(card).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    enter();
    await vi.waitFor(() => expect(server.calls.some((call) => call.method === "POST")).toBe(true));
    enter();
    enter();
    expect(server.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(text("#status")).toContain("Saved: include"));
  });

  it.each([
    [409, "The saved YouTube data is too old to decide on."],
    [500, "The server could not save that."],
    ["network", "The server could not save that."],
  ] as const)("explains a failed save (%s) in plain words and lets the owner try again", async (status, message) => {
    const server = basic();
    await mount(server);
    server.failPostsWith(status);
    const card = cardFor("Week 6 NFL best bets and picks");
    await decideOn(card, "Include", "reason");
    await vi.waitFor(() => expect(card.querySelector(".error")!.textContent).toContain(message));
    expect(button(card, "Include").disabled).toBe(false);
    expect(card.querySelector(".decision")).toBeNull();
    server.failPostsWith(null);
    click(button(card, "Include"));
    await vi.waitFor(() => expect(text("#status")).toContain("Saved: include"));
  });
});

describe("stale data", () => {
  const stale = () =>
    makeServer({ discovery: discoveryFor([record(1, { title: "Week 6 NFL best bets", apiFetchedAt: "2026-08-01T00:00:00.000Z" })]) });

  it("shows a blocking banner with the data age and disables every decision control", async () => {
    const server = stale();
    await mount(server);
    const banner = document.getElementById("banner")!;
    expect(banner.hidden).toBe(false);
    // Shown in Eastern time: midnight UTC on Aug 1 is still Jul 31 there.
    expect(banner.textContent).toContain("Jul 31, 2026");
    expect(banner.textContent).toContain("Decisions are disabled");
    expect(banner.textContent).toContain("discover");
    expect([...document.querySelectorAll<HTMLButtonElement>(".act")].every((entry) => entry.disabled)).toBe(true);
    const card = cards()[0];
    reasonField(card).value = "reason";
    click(button(card, "Include"));
    expect(server.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("shows no banner for fresh data", async () => {
    await mount(basic());
    expect(document.getElementById("banner")!.hidden).toBe(true);
  });
});

describe("long lists and the keyboard", () => {
  it("shows a hundred videos at a time and reveals more on request", async () => {
    const many = Array.from({ length: 230 }, (_, index) => record(index + 1, { title: `Week 6 NFL picks ${index}`, publishedAt: new Date(Date.UTC(2025, 9, 8, 12, index)).toISOString() }));
    await mount(makeServer({ discovery: discoveryFor(many) }));
    expect(cards()).toHaveLength(100);
    expect(text("#count")).toBe("Showing 100 of 230 videos.");
    const more = document.getElementById("more") as HTMLButtonElement;
    expect(more.hidden).toBe(false);
    click(more);
    expect(cards()).toHaveLength(200);
    click(more);
    expect(cards()).toHaveLength(230);
    expect(more.hidden).toBe(true);
  });

  it("moves between videos with j and k, but never while typing in a field", async () => {
    await mount(basic());
    const press = (key: string) =>
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    cards()[0].focus();
    press("j");
    expect(document.activeElement).toBe(cards()[1]);
    press("k");
    expect(document.activeElement).toBe(cards()[0]);
    press("k");
    expect(document.activeElement).toBe(cards()[0]);
    reasonField(cards()[0]).focus();
    press("j");
    expect(document.activeElement).toBe(reasonField(cards()[0]));
  });

  it("includes with i, a typed reason and Enter", async () => {
    const server = basic();
    await mount(server);
    const card = cardFor("Week 6 NFL best bets and picks");
    card.focus();
    card.dispatchEvent(new KeyboardEvent("keydown", { key: "i", bubbles: true }));
    expect(document.activeElement).toBe(reasonField(card));
    expect(card.querySelector(".error")!.textContent).toContain("Enter");
    reasonField(card).value = "props throughout";
    reasonField(card).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(text("#status")).toContain("Saved: include"));
    expect(server.calls.find((call) => call.method === "POST")!.body).toMatchObject({ decision: "include", videoId: vid(1) });
  });
});
