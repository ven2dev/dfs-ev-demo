// Capture view for the owner-run creator corpus tool. The owner copies a
// transcript from YouTube's own transcript panel and pastes it here; the local
// server saves it to a private log. Titles, notes and previews come from the
// local server and are untrusted: they are only ever set as text. Transcripts
// are never rendered back, kept in a URL, or written to any browser storage;
// an unsaved transcript lives only in the text box (and in memory while the
// owner moves to another video).
(() => {
  "use strict";

  const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
  const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
  const MAX_TRANSCRIPT_BYTES = 512000;
  const SHORT_TRANSCRIPT_CHARACTERS = 200;
  const PAGE_SIZE = 50;
  const CAPTION_KINDS = [
    ["unknown", "Not sure"],
    ["auto-generated", "Auto-generated"],
    ["uploaded", "Uploaded by the creator"],
  ];
  const STATE_LABEL = { "needs-capture": "Needs a transcript", captured: "Captured", unavailable: "Marked unavailable" };
  const ERROR_TEXT = {
    unauthorized: "This page's session token was not accepted. Reopen the address printed by the command.",
    "transcript-empty": "Paste the transcript first.",
    "transcript-too-large": "That transcript is over 500 KB, which is more than can be saved.",
    "transcript-invalid-characters": "The text contains control characters that cannot be saved.",
    "invalid-published-date": "Enter the publish date as shown on the video page, as year-month-day.",
    "invalid-caption-kind": "Choose one of the caption types.",
    "note-too-long": "The note is too long (500 characters at most).",
    "reason-too-long": "The reason is too long (500 characters at most).",
    "reason-required": "Enter a reason for replacing the transcript.",
    "already-captured": "This video already has a transcript. Use Replace and give a reason.",
    "already-unavailable": "This video is already marked unavailable.",
    "nothing-to-replace": "There is no saved transcript to replace.",
    "unknown-video": "That video is not in the discovery file.",
    "unknown-creator-key": "That creator is not in the discovery file.",
    "video-outside-window": "That video is outside the registered window.",
    "stale-discovery-data": "The saved YouTube data is too old to use. Refresh it with the discover command.",
    "invalid-captures-file": "The captures file is damaged, so nothing was saved. It has not been changed.",
    "insecure-file-permissions": "The captures file can be read by other users, so nothing was saved. Run chmod 600 on it and try again.",
    "video-not-in-queue": "That video is not in the queue, perhaps because it was excluded or is flagged. Reload the page.",
    "takeover-claim-abandoned": "A previous save was interrupted mid-takeover and left a hidden .reap file beside the captures file. Nothing was saved. Close the tool, delete that file (see the runbook), and start again.",
    "file-busy": "Another process is saving to the captures file. Try again in a moment.",
    "payload-too-large": "That request was too large to send.",
    "server-error": "The server could not save that. Your transcript is still in the box.",
  };

  const start = (context) => {
    const { api, el, byId, formatDate, formatDuration } = context;
    const cap = {
      queue: null,
      creator: null,
      scope: "included",
      filter: "needs-capture",
      query: "",
      week: null,
      selected: null,
      limit: PAGE_SIZE,
      busy: false,
      drafts: new Map(),
      captionKind: "unknown",
    };

    const say = (text) => {
      byId("capture-status").textContent = text;
    };
    const banner = (text) => {
      const node = byId("capture-banner");
      node.textContent = text || "";
      node.hidden = !text;
    };
    const blocked = () => Boolean(cap.queue && cap.queue.stale.blocked);
    const creator = () => cap.queue.creators.find((entry) => entry.key === cap.creator);
    const selectedItem = () => (creator().items.find((item) => item.videoId === cap.selected) || null);

    const visibleItems = () => {
      const query = cap.query.trim().toLowerCase();
      return creator().items.filter((item) => {
        if (cap.week) {
          if (item.season !== cap.week.season || item.week !== cap.week.week) return false;
        } else if (cap.filter !== "all" && item.state !== cap.filter) {
          return false;
        }
        return !query || item.title.toLowerCase().includes(query);
      });
    };

    const youtubeLink = (item) =>
      YOUTUBE_ID.test(item.videoId)
        ? el("a", {
            class: "open",
            text: "Open on YouTube ↗",
            attrs: { href: "https://www.youtube.com/watch?v=" + item.videoId, target: "_blank", rel: "noopener noreferrer" },
          })
        : el("span", { class: "note", text: "No valid video link" });

    // ---- progress
    const renderCreators = () => {
      const nav = byId("capture-creators");
      nav.replaceChildren();
      for (const entry of cap.queue.creators) {
        const left = entry.counts.needsCapture;
        const button = el("button", {
          class: "tab" + (entry.key === cap.creator ? " selected" : ""),
          text: entry.key + " (" + (left === null ? "—" : left) + " to capture)",
          attrs: { type: "button", "aria-pressed": entry.key === cap.creator ? "true" : "false" },
        });
        button.addEventListener("click", () => {
          stashDraft();
          cap.creator = entry.key;
          cap.week = null;
          cap.limit = PAGE_SIZE;
          cap.selected = entry.nextVideoId;
          render();
        });
        nav.append(button);
      }
    };

    const renderSummary = () => {
      const entry = creator();
      const box = byId("capture-summary");
      box.replaceChildren();
      const part = (label, value) => el("div", { class: "stat" }, [el("strong", { text: String(value) }), el("span", { text: label })]);
      const { needsCapture, captured, unavailable, total } = entry.counts;
      box.append(
        part("still need a transcript", needsCapture === null ? "—" : needsCapture),
        part("captured", captured),
        part("marked unavailable", unavailable),
        part("in the queue", total === null ? "—" : total)
      );
      if (total) {
        const done = Math.round(((captured + unavailable) / total) * 100);
        box.append(el("progress", { class: "progress", attrs: { max: "100", value: String(done), "aria-label": "Share finished" } }));
      }
      if (cap.queue.capturesNotListed > 0) {
        box.append(el("p", { class: "note", text: cap.queue.capturesNotListed + " saved capture(s) are for videos no longer in this queue. They stay in the log." }));
      }
    };

    const renderGrid = () => {
      const entry = creator();
      const grid = byId("capture-grid");
      grid.replaceChildren();
      if (entry.weeks.length === 0) return;
      const seasons = [...new Set(entry.weeks.map((week) => week.season))];
      const table = el("table", { class: "weeks" });
      const head = el("tr", {}, [el("th", { text: "Season", attrs: { scope: "col" } })]);
      for (let number = 1; number <= 18; number++) head.append(el("th", { text: String(number), attrs: { scope: "col" } }));
      table.append(el("thead", {}, [head]));
      const body = el("tbody");
      for (const season of seasons) {
        const row = el("tr", {}, [el("th", { text: String(season), attrs: { scope: "row" } })]);
        for (let number = 1; number <= 18; number++) {
          const cell = el("td");
          const week = entry.weeks.find((candidate) => candidate.season === season && candidate.week === number);
          if (week) {
            const queued = week.needsCapture + week.captured + week.unavailable;
            const kind = queued === 0 ? "slot-empty" : week.needsCapture === 0 ? "slot-present" : "slot-review";
            const chosen = cap.week && cap.week.season === season && cap.week.week === number;
            const button = el("button", {
              class: "slot " + kind + (chosen ? " chosen" : ""),
              text: String(number),
              attrs: {
                type: "button",
                "aria-pressed": chosen ? "true" : "false",
                "aria-label": season + " week " + number + ": " + week.captured + " captured, " + week.unavailable + " unavailable, " + week.needsCapture + " left",
              },
            });
            button.addEventListener("click", () => {
              cap.week = chosen ? null : { season, week: number };
              cap.limit = PAGE_SIZE;
              renderGrid();
              renderList();
            });
            cell.append(button);
          }
          row.append(cell);
        }
        body.append(row);
      }
      table.append(body);
      grid.append(table);
    };

    // ---- the current video and its form
    const meter = (text) => {
      const characters = text.length;
      const bytes = new TextEncoder().encode(text).length;
      const lines = text === "" ? 0 : text.split("\n").length;
      const sizeText = bytes < 1024 ? bytes + " bytes" : (bytes / 1024).toFixed(1) + " KB";
      let warning = "";
      if (bytes > MAX_TRANSCRIPT_BYTES) warning = " — over the 500 KB limit";
      else if (text.trim() !== "" && characters < SHORT_TRANSCRIPT_CHARACTERS) warning = " — looks short, saving will ask you to confirm";
      return characters.toLocaleString("en-US") + " characters · " + sizeText + " · " + lines + " lines" + warning;
    };

    const stashDraft = () => {
      const form = byId("capture-current").querySelector(".capture-form");
      if (!form || !cap.selected) return;
      const text = form.querySelector(".cap-text").value;
      const draft = {
        text,
        date: form.querySelector(".cap-date").value,
        kind: form.querySelector(".cap-kind").value,
        note: form.querySelector(".cap-note").value,
        reason: form.querySelector(".cap-reason") ? form.querySelector(".cap-reason").value : "",
      };
      if (text || draft.note || draft.reason) cap.drafts.set(cap.selected, draft);
      else cap.drafts.delete(cap.selected);
      cap.captionKind = draft.kind;
    };

    const setBusy = (busy) => {
      cap.busy = busy;
      for (const node of document.querySelectorAll("#capture-view .cap-act")) {
        node.disabled = busy || blocked();
      }
    };

    const errorText = (error) => ERROR_TEXT[error && error.code] || ERROR_TEXT["server-error"];

    const submit = async (item, action, form, confirmShort) => {
      if (cap.busy || blocked()) return;
      const message = form.querySelector(".error");
      message.textContent = "";
      for (const node of form.querySelectorAll(".cap-confirm")) node.remove();
      const body = { creatorKey: cap.creator, videoId: item.videoId, action, scope: cap.scope };
      const note = form.querySelector(".cap-note").value.trim();
      if (note) body.note = note;
      const date = form.querySelector(".cap-date").value;
      const dateProblem = () => !DATE_ONLY.test(date);
      if (action === "capture" || action === "replace") {
        const text = form.querySelector(".cap-text").value;
        if (text.trim() === "") return fail(message, form, ".cap-text", "transcript-empty");
        if (new TextEncoder().encode(text).length > MAX_TRANSCRIPT_BYTES) return fail(message, form, ".cap-text", "transcript-too-large");
        if (dateProblem()) return fail(message, form, ".cap-date", "invalid-published-date");
        body.text = text;
        body.captionKind = form.querySelector(".cap-kind").value;
        if (action === "replace") {
          const reason = form.querySelector(".cap-reason").value.trim();
          if (!reason) return fail(message, form, ".cap-reason", "reason-required");
          body.reason = reason;
        }
        if (confirmShort) body.confirmShort = true;
      } else if (dateProblem()) {
        return fail(message, form, ".cap-date", "invalid-published-date");
      }
      body.publishedDate = date;
      setBusy(true);
      try {
        const result = await api("/api/capture", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        // The owner may have moved to another video while this was saving. Keep
        // whatever is typed there, and only advance if they are still here.
        const stillHere = cap.selected === item.videoId;
        if (!stillHere) stashDraft();
        cap.drafts.delete(item.videoId);
        if (body.captionKind) cap.captionKind = body.captionKind;
        cap.queue = result.queue;
        const label = action === "unavailable" ? "Marked unavailable" : action === "replace" ? "Replaced" : "Saved";
        say(label + ": " + item.title + (result.receipt.characters ? " (" + result.receipt.characters.toLocaleString("en-US") + " characters)" : ""));
        if (stillHere) cap.selected = creator() ? creator().nextVideoId : null;
        cap.busy = false;
        render(stillHere);
      } catch (error) {
        setBusy(false);
        // Nothing is re-rendered, so the transcript is still in the box.
        if (error.code === "transcript-too-short") return offerShortConfirm(item, action, form, message);
        message.textContent = errorText(error);
      }
    };

    const fail = (message, form, selector, code) => {
      message.textContent = ERROR_TEXT[code];
      form.querySelector(selector).focus();
    };

    const offerShortConfirm = (item, action, form, message) => {
      message.textContent = "This looks short, which can mean a partial copy. Save it anyway?";
      const confirm = el("button", { class: "cap-act cap-confirm", text: "Save anyway", attrs: { type: "button" } });
      confirm.addEventListener("click", () => submit(item, action, form, true));
      message.after(confirm);
      confirm.focus();
    };

    const field = (labelText, control, hint) =>
      el("label", { class: "cap-field" }, [el("span", { text: labelText }), control, ...(hint ? [el("small", { text: hint })] : [])]);

    const renderCurrent = () => {
      const box = byId("capture-current");
      box.replaceChildren();
      const item = selectedItem();
      if (blocked()) {
        box.append(el("p", { class: "note", text: "The video list is withheld until the YouTube data is refreshed." }));
        return;
      }
      if (!item) {
        const entry = creator();
        box.append(
          el("p", {
            class: "note",
            text: entry.counts.total === 0
              ? "No videos are queued for this creator."
              : entry.counts.needsCapture === 0
                ? "Everything queued for this creator has a transcript or is marked unavailable."
                : "Select a video from the queue.",
          })
        );
        return;
      }

      const draft = cap.drafts.get(item.videoId) || {};
      box.append(
        el("h2", { text: "Current video" }),
        el("h3", { text: item.title || "(no title)" }),
        el("p", {
          class: "meta",
          text:
            item.season + " week " + item.week + " · " + formatDuration(item.durationSeconds) +
            " · YouTube lists " + formatDate(item.publishedAt) + " (a hint, check it on the video page)",
        }),
        el("p", { class: "badges" }, [
          el("span", { class: "badge badge-" + (item.state === "captured" ? "present" : item.state === "unavailable" ? "needs-review" : ""), text: STATE_LABEL[item.state] }),
          ...(item.reviewStatus === "needs-review" ? [el("span", { class: "badge", text: "Still flagged for review" })] : []),
        ]),
        youtubeLink(item)
      );

      if (item.capture && item.capture.event !== "unavailable") {
        box.append(
          el("p", {
            class: "decision",
            text:
              "Saved " + (item.capture.characters || 0).toLocaleString("en-US") + " characters, fingerprint " + item.capture.hash +
              ", date " + item.capture.publishedDate + (item.capture.events > 1 ? ", " + item.capture.events + " versions" : ""),
          }),
          el("p", { class: "description", text: item.capture.preview || "" })
        );
      } else if (item.capture) {
        box.append(el("p", { class: "decision", text: "Marked unavailable" + (item.capture.reason ? ": " + item.capture.reason : "") + (item.capture.note ? " — " + item.capture.note : "") }));
      }

      const replacing = item.state === "captured";
      const text = el("textarea", {
        class: "cap-text",
        attrs: { rows: "14", placeholder: "Paste the transcript from YouTube's “Show transcript” panel", "aria-label": "Transcript", spellcheck: "false", autocomplete: "off" },
      });
      text.value = draft.text || "";
      const date = el("input", { class: "cap-date", attrs: { type: "date", "aria-label": "Publish date" } });
      date.value = draft.date || item.publishedDateHint;
      const kind = el("select", { class: "cap-kind", attrs: { "aria-label": "Caption type" } });
      for (const [value, label] of CAPTION_KINDS) kind.append(el("option", { text: label, attrs: { value } }));
      kind.value = draft.kind || cap.captionKind;
      const note = el("input", { class: "cap-note", attrs: { type: "text", maxlength: "500", "aria-label": "Note (optional)" } });
      note.value = draft.note || "";
      const reason = replacing ? el("input", { class: "cap-reason", attrs: { type: "text", maxlength: "500", "aria-label": "Reason for replacing" } }) : null;
      if (reason) reason.value = draft.reason || "";
      const counter = el("p", { class: "meter", text: meter(text.value) });
      text.addEventListener("input", () => {
        counter.textContent = meter(text.value);
      });
      const message = el("p", { class: "error", attrs: { role: "alert" } });

      const details = el("div", { class: "cap-row" }, [
        field("Published date", date, "Check it against the video page. What you save is your confirmed date."),
        field("Caption type", kind),
        field("Note (optional)", note),
      ]);
      const form = el("div", { class: "capture-form" }, [
        ...(reason ? [field("Reason for replacing (required)", reason)] : []),
        field(replacing ? "New transcript" : "Transcript", text),
        counter,
        details,
        message,
      ]);
      const save = el("button", { class: "cap-act cap-save", text: replacing ? "Replace transcript" : "Save transcript", attrs: { type: "button" } });
      save.addEventListener("click", () => submit(item, replacing ? "replace" : "capture", form, false));
      const actions = el("div", { class: "decide" }, [save]);
      if (!replacing) {
        const none = el("button", { class: "cap-act cap-none", text: "No transcript available", attrs: { type: "button" } });
        none.addEventListener("click", () => submit(item, "unavailable", form, false));
        actions.append(none);
      }
      const skip = el("button", { class: "cap-skip", text: "Skip", attrs: { type: "button" } });
      skip.addEventListener("click", () => skipToNext());
      actions.append(skip);
      form.append(actions);
      text.addEventListener("keydown", (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
          event.preventDefault();
          save.click();
        }
      });
      box.append(form);
      for (const node of form.querySelectorAll(".cap-act")) node.disabled = cap.busy || blocked();
    };

    // ---- the queue list
    const select = (videoId) => {
      stashDraft();
      cap.selected = videoId;
      renderCurrent();
      renderList();
    };

    const skipToNext = () => {
      const items = visibleItems();
      if (items.length === 0) return;
      const index = items.findIndex((item) => item.videoId === cap.selected);
      const after = items.slice(index + 1).find((item) => item.state === "needs-capture") || items[(index + 1) % items.length];
      select(after.videoId);
    };

    const renderList = () => {
      const items = visibleItems();
      const list = byId("capture-list");
      list.replaceChildren(
        ...items.slice(0, cap.limit).map((item) => {
          const choose = el("button", {
            class: "row-select" + (item.videoId === cap.selected ? " chosen" : ""),
            text: item.title || "(no title)",
            attrs: { type: "button", "aria-pressed": item.videoId === cap.selected ? "true" : "false" },
          });
          choose.addEventListener("click", () => select(item.videoId));
          const row = el("li", { class: "video status-" + (item.state === "captured" ? "present" : item.state === "unavailable" ? "excluded" : "needs-review") }, [
            choose,
            el("p", { class: "meta", text: item.season + " week " + item.week + " · " + STATE_LABEL[item.state] + " · " + item.publishedDateHint }),
          ]);
          row.dataset.videoId = item.videoId;
          return row;
        })
      );
      byId("capture-count").textContent = "Showing " + Math.min(cap.limit, items.length) + " of " + items.length + " videos.";
      byId("capture-more").hidden = items.length <= cap.limit;
      const note = byId("capture-week-note");
      note.hidden = !cap.week;
      note.textContent = cap.week ? "Only " + cap.week.season + " week " + cap.week.week + ", whatever its state. Select the week again to go back." : "";
    };

    const render = (focusText) => {
      if (!creator()) cap.creator = cap.queue.creators[0] ? cap.queue.creators[0].key : null;
      if (!cap.creator) {
        say("The discovery file has no creators.");
        return;
      }
      const stale = cap.queue.stale;
      banner(
        stale.blocked
          ? "The saved YouTube data is over " + stale.maxAgeDays + " days old, so the video list is withheld. Your saved captures are unaffected. " +
              "Refresh with the discover command, delete the old file with the purge command, then reopen this page."
          : ""
      );
      if (!selectedItem() && !blocked()) {
        const entry = creator();
        cap.selected = entry.nextVideoId || (entry.items[0] ? entry.items[0].videoId : null);
      }
      renderCreators();
      renderSummary();
      renderGrid();
      renderCurrent();
      renderList();
      if (focusText) {
        const box = byId("capture-current").querySelector(".cap-text");
        if (box) box.focus();
      }
    };

    // ---- wiring
    const load = async () => {
      try {
        cap.queue = await api("/api/captures?scope=" + cap.scope);
      } catch (error) {
        say(errorText(error));
        return;
      }
      say("Loaded the capture queue.");
      render();
    };

    byId("capture-scope").addEventListener("change", (event) => {
      stashDraft();
      cap.scope = event.target.checked ? "included-and-flagged" : "included";
      cap.limit = PAGE_SIZE;
      load();
    });
    byId("capture-filters").addEventListener("submit", (event) => event.preventDefault());
    byId("capture-filter").addEventListener("input", (event) => {
      cap.filter = event.target.value;
      cap.week = null;
      cap.limit = PAGE_SIZE;
      renderGrid();
      renderList();
    });
    byId("capture-query").addEventListener("input", (event) => {
      cap.query = event.target.value;
      cap.limit = PAGE_SIZE;
      renderList();
    });
    byId("capture-more").addEventListener("click", () => {
      cap.limit += PAGE_SIZE;
      renderList();
    });
    document.addEventListener("keydown", (event) => {
      const view = byId("capture-view");
      if (!view || view.hidden || !cap.queue) return;
      const target = event.target;
      const tag = target && target.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (event.key === "n") skipToNext();
    });

    say("Loading the capture queue…");
    load();
  };

  globalThis.creatorCapture = { start };
})();
