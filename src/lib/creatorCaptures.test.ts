import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CAPTION_KINDS,
  MAX_TRANSCRIPT_BYTES,
  NOTE_MAX_LENGTH,
  SHORT_TRANSCRIPT_CHARACTERS,
  activeCaptures,
  buildCaptureEvent,
  captureKey,
  checkCaptureEvent,
  checkPublishedDate,
  checkTranscript,
  hashTranscript,
  normalizeTranscript,
  parseCaptureLog,
  transitionProblem,
  type CaptureEvent,
  type CaptureRequest,
} from "./creatorCaptures.ts";

const NOW = new Date("2026-10-08T19:47:00.000Z");
const A = "aaaaaaaaaaa";
const B = "bbbbbbbbbbb";
const TEXT = "0:00\nWelcome back to the show.\n0:07\n".repeat(10);
const request = (overrides: Partial<CaptureRequest> = {}): CaptureRequest => ({
  creatorKey: "creator-a",
  videoId: A,
  action: "capture",
  text: TEXT,
  publishedDate: "2025-10-09",
  ...overrides,
});
const build = (overrides: Partial<CaptureRequest> = {}) => buildCaptureEvent(request(overrides), NOW);
const codeOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as { code: string }).code;
  }
  return "accepted";
};
const line = (event: CaptureEvent) => JSON.stringify(event);
const log = (...events: CaptureEvent[]) => events.map(line).join("\n") + "\n";

describe("normalizeTranscript", () => {
  it("changes only line endings and keeps everything else, including a leading byte-order mark", () => {
    expect(normalizeTranscript("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
    expect(normalizeTranscript("\uFEFFhello")).toBe("\uFEFFhello");
    const untouched = "  0:07  odd   spacing \t and trailing space \n\n  é ✓ 日本語 \n";
    expect(normalizeTranscript(untouched)).toBe(untouched);
    expect(normalizeTranscript("x\uFEFFy")).toBe("x\uFEFFy");
  });
});

describe("checkTranscript", () => {
  const long = "x".repeat(SHORT_TRANSCRIPT_CHARACTERS);
  it("accepts ordinary text, tabs and newlines", () => {
    expect(checkTranscript(long)).toBeNull();
    expect(checkTranscript(`${long}\n\t0:07 line`)).toBeNull();
  });

  it.each([
    ["empty", "", "transcript-empty"],
    ["only whitespace", " \n\t ", "transcript-empty"],
    ["a NUL byte", `${long}\u0000`, "transcript-invalid-characters"],
    ["an escape character", `${long}\u001B[31m`, "transcript-invalid-characters"],
    ["a delete character", `${long}\u007F`, "transcript-invalid-characters"],
  ])("refuses %s", (_name, text, code) => expect(checkTranscript(text)).toBe(code));

  it("counts size in UTF-8 bytes at the exact limit", () => {
    expect(checkTranscript("a".repeat(MAX_TRANSCRIPT_BYTES))).toBeNull();
    expect(checkTranscript("a".repeat(MAX_TRANSCRIPT_BYTES + 1))).toBe("transcript-too-large");
    const multibyte = "é".repeat(MAX_TRANSCRIPT_BYTES / 2);
    expect(Buffer.byteLength(multibyte)).toBe(MAX_TRANSCRIPT_BYTES);
    expect(checkTranscript(multibyte)).toBeNull();
    expect(checkTranscript(multibyte + "é")).toBe("transcript-too-large");
  });

  it("asks for confirmation below the short threshold only", () => {
    expect(checkTranscript("x".repeat(SHORT_TRANSCRIPT_CHARACTERS - 1))).toBe("transcript-too-short");
    expect(checkTranscript("x".repeat(SHORT_TRANSCRIPT_CHARACTERS - 1), { confirmShort: true })).toBeNull();
    expect(checkTranscript("x".repeat(SHORT_TRANSCRIPT_CHARACTERS))).toBeNull();
    expect(checkTranscript("", { confirmShort: true })).toBe("transcript-empty");
  });
});

describe("checkPublishedDate", () => {
  it.each(["2025-10-09", "2005-04-23", "2026-10-08", "2026-10-09"])("accepts %s", (date) =>
    expect(checkPublishedDate(date, NOW)).toBeNull()
  );
  it.each([
    "2025-02-30",
    "2025-13-01",
    "2025-1-5",
    "10/09/2025",
    "2025-10-09T00:00:00Z",
    "2005-04-22",
    "2026-10-10",
    "",
    "not a date",
  ])("refuses %j", (date) => expect(checkPublishedDate(date, NOW)).toBe("invalid-published-date"));
  it("refuses a non-string", () => {
    for (const value of [undefined, null, 20251009]) expect(checkPublishedDate(value, NOW)).toBe("invalid-published-date");
  });
  it("accepts a leap day only in a leap year", () => {
    expect(checkPublishedDate("2024-02-29", NOW)).toBeNull();
    expect(checkPublishedDate("2025-02-29", NOW)).toBe("invalid-published-date");
  });
});

describe("buildCaptureEvent", () => {
  it("builds a captured event with the server's time, source, usage, hash and length", () => {
    const event = build({ note: "  auto captions garble names  ", captionKind: "auto-generated" });
    expect(event).toEqual({
      formatVersion: 1,
      creatorKey: "creator-a",
      videoId: A,
      event: "captured",
      capturedAt: NOW.toISOString(),
      source: "manual-owner-paste",
      usageStatus: "internal-research-only",
      publishedDate: "2025-10-09",
      captionKind: "auto-generated",
      text: TEXT,
      sha256: createHash("sha256").update(TEXT, "utf8").digest("hex"),
      characters: TEXT.length,
      reason: null,
      note: "auto captions garble names",
    });
    expect(checkCaptureEvent(event)).toBe(true);
  });

  it("normalizes line endings before hashing, so the hash is of what is stored", () => {
    const event = build({ text: TEXT.replace(/\n/g, "\r\n") });
    expect(event.text).toBe(TEXT);
    expect(event.sha256).toBe(hashTranscript(TEXT));
  });

  it("defaults the caption kind to unknown and refuses an unknown one", () => {
    expect(build().captionKind).toBe("unknown");
    for (const kind of CAPTION_KINDS) expect(build({ captionKind: kind }).captionKind).toBe(kind);
    expect(codeOf(() => build({ captionKind: "human" }))).toBe("invalid-caption-kind");
  });

  it("ignores any reason sent with a first capture", () => {
    expect(build({ reason: "irrelevant" }).reason).toBeNull();
  });

  it("requires a reason to replace, and stores it trimmed", () => {
    expect(codeOf(() => build({ action: "replace" }))).toBe("reason-required");
    expect(codeOf(() => build({ action: "replace", reason: "   " }))).toBe("reason-required");
    const event = build({ action: "replace", reason: "  pasted the wrong video  " });
    expect(event).toMatchObject({ event: "replaced", reason: "pasted the wrong video" });
    expect(checkCaptureEvent(event)).toBe(true);
  });

  it("records an unavailable video with no text or hash, but with the confirmed date", () => {
    const event = build({ action: "unavailable", text: undefined, reason: "captions disabled" });
    expect(event).toMatchObject({
      event: "unavailable",
      text: null,
      sha256: null,
      characters: null,
      publishedDate: "2025-10-09",
      captionKind: null,
      reason: "captions disabled",
    });
    expect(checkCaptureEvent(event)).toBe(true);
    expect(checkCaptureEvent(build({ action: "unavailable" }))).toBe(true);
  });

  it("requires a real confirmed date for an unavailable video, and a stored one is checked when read back", () => {
    for (const publishedDate of [undefined, "", "2025-02-30", "2001-01-01", "2026-10-20", "10/09/2025"]) {
      expect(codeOf(() => build({ action: "unavailable", publishedDate: publishedDate as never })), String(publishedDate)).toBe("invalid-published-date");
    }
    const stored = JSON.parse(JSON.stringify(build({ action: "unavailable" }))) as Record<string, unknown>;
    expect(checkCaptureEvent(stored)).toBe(true);
    for (const bad of [null, "2025-02-30", "2026-10-20", "2001-01-01", 20251009]) {
      expect(checkCaptureEvent({ ...stored, publishedDate: bad }), String(bad)).toBe(false);
    }
  });

  it("never echoes the text of a refused transcript in its error", () => {
    try {
      build({ text: "SECRET-TRANSCRIPT\u0000" });
    } catch (error) {
      expect(JSON.stringify(error) + String(error) + (error as Error).message).not.toContain("SECRET-TRANSCRIPT");
    }
  });

  it.each([
    ["a bad creator key", { creatorKey: "Creator A" }, "invalid-creator-key"],
    ["a bad video id", { videoId: "short" }, "invalid-video-id"],
    ["an unknown action", { action: "delete" as never }, "invalid-capture-action"],
    ["no text", { text: undefined }, "transcript-empty"],
    ["non-string text", { text: 5 as never }, "transcript-empty"],
    ["a short text", { text: "too short" }, "transcript-too-short"],
    ["a missing date", { publishedDate: undefined }, "invalid-published-date"],
    ["a bad date", { publishedDate: "2025-02-30" }, "invalid-published-date"],
    ["a long note", { note: "n".repeat(NOTE_MAX_LENGTH + 1) }, "note-too-long"],
    ["a non-string note", { note: 5 as never }, "note-too-long"],
    ["a long reason", { action: "replace", reason: "r".repeat(NOTE_MAX_LENGTH + 1) }, "reason-too-long"],
  ] as const)("refuses %s", (_name, overrides, code) => expect(codeOf(() => build(overrides as Partial<CaptureRequest>))).toBe(code));

  it("accepts a short text only with confirmation", () => {
    expect(build({ text: "too short", confirmShort: true }).characters).toBe(9);
    expect(codeOf(() => build({ text: "too short", confirmShort: "yes" as never }))).toBe("transcript-too-short");
  });
});

describe("transitionProblem", () => {
  it.each([
    [undefined, "captured", null],
    [undefined, "unavailable", null],
    [undefined, "replaced", "nothing-to-replace"],
    ["captured", "replaced", null],
    ["captured", "captured", "already-captured"],
    ["captured", "unavailable", "already-captured"],
    ["unavailable", "captured", null],
    ["unavailable", "unavailable", "already-unavailable"],
    ["unavailable", "replaced", "nothing-to-replace"],
  ] as const)("%s then %s", (state, next, problem) => expect(transitionProblem(state, next)).toBe(problem));
});

describe("checkCaptureEvent", () => {
  const good = () => JSON.parse(JSON.stringify(build())) as Record<string, unknown>;
  it("rejects every kind of damage", () => {
    const damaged: [string, (event: Record<string, unknown>) => void][] = [
      ["extra field", (event) => (event.extra = 1)],
      ["missing field", (event) => delete event.note],
      ["wrong version", (event) => (event.formatVersion = 2)],
      ["bad creator", (event) => (event.creatorKey = "Bad Key")],
      ["bad video", (event) => (event.videoId = "x")],
      ["bad time", (event) => (event.capturedAt = "yesterday")],
      ["wrong source", (event) => (event.source = "scraper")],
      ["wrong usage", (event) => (event.usageStatus = "public")],
      ["edited text", (event) => (event.text = String(event.text) + " edited")],
      ["wrong hash", (event) => (event.sha256 = "0".repeat(64))],
      ["wrong length", (event) => (event.characters = 5)],
      ["unnormalized text", (event) => { event.text = String(event.text).replace(/\n/g, "\r\n"); }],
      ["bad date", (event) => (event.publishedDate = "2025-02-30")],
      ["date after the capture time", (event) => (event.publishedDate = "2026-10-20")],
      ["date before YouTube existed", (event) => (event.publishedDate = "2001-01-01")],
      ["bad caption kind", (event) => (event.captionKind = "human")],
      ["reason on a first capture", (event) => (event.reason = "why")],
      ["untrimmed note", (event) => (event.note = " padded ")],
      ["empty-string note", (event) => (event.note = "")],
      ["unknown event type", (event) => (event.event = "deleted")],
    ];
    for (const [name, damage] of damaged) {
      const event = good();
      damage(event);
      expect(checkCaptureEvent(event), name).toBe(false);
    }
    expect(checkCaptureEvent(null)).toBe(false);
    expect(checkCaptureEvent([])).toBe(false);
    expect(checkCaptureEvent(good())).toBe(true);
  });

  it("requires a replaced event to carry a reason, and an unavailable one to carry no text", () => {
    const replaced = JSON.parse(JSON.stringify(build({ action: "replace", reason: "fix" }))) as Record<string, unknown>;
    expect(checkCaptureEvent(replaced)).toBe(true);
    replaced.reason = null;
    expect(checkCaptureEvent(replaced)).toBe(false);
    const unavailable = JSON.parse(JSON.stringify(build({ action: "unavailable" }))) as Record<string, unknown>;
    unavailable.text = "x";
    expect(checkCaptureEvent(unavailable)).toBe(false);
  });
});

describe("parseCaptureLog", () => {
  const captured = build();
  const replaced = buildCaptureEvent(request({ action: "replace", reason: "wrong video", text: TEXT + "more\n" }), NOW);
  const unavailable = buildCaptureEvent(request({ videoId: B, action: "unavailable" }), NOW);
  const unavailableA = buildCaptureEvent(request({ action: "unavailable" }), NOW);

  it("reads an empty log and a valid sequence, in order", () => {
    expect(parseCaptureLog("")).toEqual([]);
    expect(parseCaptureLog(log(captured, unavailable, replaced))).toEqual([captured, unavailable, replaced]);
  });

  it("refuses a log whose last line was cut short", () => {
    expect(() => parseCaptureLog(log(captured).slice(0, -1))).toThrow(expect.objectContaining({ code: "invalid-captures-file" }));
    expect(() => parseCaptureLog(log(captured) + line(unavailable).slice(0, 40))).toThrow();
  });

  it("refuses blank lines, bad JSON, damaged events and illegal sequences, naming only the line", () => {
    const failure = (content: string) => {
      try {
        parseCaptureLog(content);
      } catch (error) {
        expect(JSON.stringify(error) + String(error)).not.toContain("Welcome back");
        return (error as { line: number }).line;
      }
      return null;
    };
    expect(failure(log(captured) + "\n")).toBe(2);
    expect(failure(log(captured) + "{nope\n")).toBe(2);
    expect(failure(log(captured, captured))).toBe(2);
    expect(failure(log(replaced))).toBe(1);
    expect(failure(log(unavailable, unavailable))).toBe(2);
    expect(failure(log(captured, unavailableA))).toBe(2);
    expect(failure(log(unavailableA, replaced))).toBe(2);
    const edited = { ...captured, text: String(captured.text) + "tampered" };
    expect(failure(log(captured) + line(edited as CaptureEvent) + "\n")).toBe(2);
    expect(failure(log(captured, unavailable, replaced))).toBeNull();
  });

  it("allows capturing a video that was first marked unavailable", () => {
    const later = buildCaptureEvent(request({ videoId: B }), NOW);
    expect(parseCaptureLog(log(unavailable, later))).toHaveLength(2);
  });
});

describe("activeCaptures", () => {
  it("keeps the latest event for each video and tells states apart", () => {
    const captured = build();
    const replaced = buildCaptureEvent(request({ action: "replace", reason: "fix", text: TEXT + "x" }), NOW);
    const unavailable = buildCaptureEvent(request({ videoId: B, action: "unavailable" }), NOW);
    const active = activeCaptures([captured, unavailable, replaced]);
    expect(active.get(captureKey("creator-a", A))).toMatchObject({ state: "captured", event: { event: "replaced" } });
    expect(active.get(captureKey("creator-a", B))).toMatchObject({ state: "unavailable" });
    expect(active.size).toBe(2);
    expect(active.get(captureKey("creator-b", A))).toBeUndefined();
  });
});
