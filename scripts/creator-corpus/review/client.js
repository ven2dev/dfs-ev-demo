// Review page for the owner-run creator corpus tool. Everything shown comes
// from the local server over a token-protected API. Titles, descriptions and
// reasons are untrusted text: they are only ever set with textContent, never
// parsed as markup, and links are built from validated video IDs alone.
(() => {
  "use strict";

  const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
  const PAGE_SIZE = 100;
  const STATUS_LABEL = { present: "Included", "needs-review": "Needs review", excluded: "Excluded" };
  const SLOT_CLASS = { present: "slot-present", "needs-review": "slot-review", missing: "slot-missing" };
  const SLOT_LABEL = { present: "included", "needs-review": "needs review", missing: "missing" };
  const QUICK_REASONS = [
    "Props throughout the video",
    "Picks and recap, no props",
    "Not NFL content",
    "Fantasy lineup content, not props",
    "Wrong week for this slot",
    "Duplicate of another video",
  ];
  const ERROR_TEXT = {
    unauthorized: "This page's session token was not accepted. Reopen the address printed by the command.",
    forbidden: "The server refused the request.",
    "stale-discovery-data": "The saved YouTube data is too old to decide on. Refresh it with the discover command.",
    "nothing-to-clear": "There is no active decision to clear.",
    "reason-required": "Enter a reason first.",
    "reason-too-long": "The reason is too long (500 characters at most).",
    "unknown-video": "That video is not in the discovery file.",
    "video-outside-window": "That video is outside the registered window, so it cannot be decided.",
    "payload-too-large": "That request was too large.",
    "server-error": "The server could not save that. Check its terminal.",
  };

  const state = {
    data: null,
    creator: null,
    status: "needs-review",
    reason: "all",
    query: "",
    sort: "newest",
    week: null,
    limit: PAGE_SIZE,
    busy: false,
  };

  const byId = (id) => document.getElementById(id);

  // Element builder. Text goes in as textContent; attributes that could run
  // code or inject styling are refused outright.
  const el = (tag, options = {}, children = []) => {
    const node = document.createElement(tag);
    if (options.class) node.className = options.class;
    if (options.text !== undefined) node.textContent = options.text;
    for (const [name, value] of Object.entries(options.attrs || {})) {
      const lower = name.toLowerCase();
      if (lower.startsWith("on") || lower === "style" || lower === "srcdoc") throw new Error("attribute not allowed");
      node.setAttribute(name, String(value));
    }
    for (const child of children) node.append(child);
    return node;
  };

  const token = new URLSearchParams(location.hash.slice(1)).get("token");
  // The token never stays in the address bar, history or a referrer.
  history.replaceState(null, "", location.pathname + location.search);

  const say = (text) => {
    byId("status").textContent = text;
  };

  const showBanner = (text) => {
    const banner = byId("banner");
    banner.textContent = text || "";
    banner.hidden = !text;
  };

  const api = async (path, init = {}) => {
    const response = await fetch(path, {
      cache: "no-store",
      ...init,
      headers: { ...(init.headers || {}), Authorization: "Bearer " + token },
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const code = body && typeof body.error === "string" ? body.error : "server-error";
      const error = new Error(code);
      error.code = code;
      throw error;
    }
    return body;
  };

  const creator = () => state.data.creators.find((entry) => entry.key === state.creator);
  const blocked = () => Boolean(state.data && state.data.stale.blocked);

  const formatDate = (iso) => {
    const time = new Date(iso);
    if (Number.isNaN(time.getTime())) return "unknown date";
    return (
      time.toLocaleString("en-US", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }) + " ET"
    );
  };

  const formatDuration = (seconds) => {
    if (typeof seconds !== "number") return "length unknown";
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = String(seconds % 60).padStart(2, "0");
    return hours > 0 ? hours + ":" + String(minutes).padStart(2, "0") + ":" + rest : minutes + ":" + rest;
  };

  const visibleVideos = () => {
    const query = state.query.trim().toLowerCase();
    const list = creator().videos.filter((video) => {
      if (state.week) {
        if (video.season !== state.week.season || video.week !== state.week.week) return false;
      } else if (state.status === "decided") {
        if (!video.decision) return false;
      } else if (state.status !== "all" && video.status !== state.status) {
        return false;
      }
      if (state.reason !== "all" && !video.reasons.some((reason) => reason.code === state.reason)) return false;
      if (query && !(video.title + " " + video.description).toLowerCase().includes(query)) return false;
      return true;
    });
    list.sort((a, b) => (state.sort === "newest" ? -1 : 1) * a.publishedAt.localeCompare(b.publishedAt));
    return list;
  };

  const renderCreators = () => {
    const nav = byId("creators");
    nav.replaceChildren();
    for (const entry of state.data.creators) {
      const waiting = entry.summary.videos["needs-review"];
      const button = el("button", {
        class: "tab" + (entry.key === state.creator ? " selected" : ""),
        text: entry.key + " (" + waiting + " to review)",
        attrs: { type: "button", "aria-pressed": entry.key === state.creator ? "true" : "false" },
      });
      button.addEventListener("click", () => {
        state.creator = entry.key;
        state.week = null;
        state.limit = PAGE_SIZE;
        renderAll();
      });
      nav.append(button);
    }
  };

  const renderSummary = () => {
    const entry = creator();
    const summary = byId("summary");
    summary.replaceChildren();
    const decided = entry.videos.filter((video) => video.decision).length;
    const part = (label, value) => el("div", { class: "stat" }, [el("strong", { text: String(value) }), el("span", { text: label })]);
    summary.append(
      part("weeks included", entry.summary.slots.present),
      part("weeks needing review", entry.summary.slots["needs-review"]),
      part("weeks missing", entry.summary.slots.missing),
      part("videos included", entry.summary.videos.present),
      part("videos to review", entry.summary.videos["needs-review"]),
      part("videos excluded", entry.summary.videos.excluded),
      part("decisions made", decided)
    );
    if (entry.unavailableVideoIds.length > 0) {
      summary.append(el("p", { class: "note", text: entry.unavailableVideoIds.length + " listed video(s) are no longer available from YouTube." }));
    }
    summary.hidden = false;
  };

  const renderGrid = () => {
    const entry = creator();
    const grid = byId("grid");
    grid.replaceChildren();
    const seasons = [...new Set(entry.slots.map((slot) => slot.season))];
    const table = el("table", { class: "weeks" });
    const head = el("tr", {}, [el("th", { text: "Season", attrs: { scope: "col" } })]);
    for (let week = 1; week <= 18; week++) head.append(el("th", { text: String(week), attrs: { scope: "col" } }));
    table.append(el("thead", {}, [head]));
    const body = el("tbody");
    for (const season of seasons) {
      const row = el("tr", {}, [el("th", { text: String(season), attrs: { scope: "row" } })]);
      for (let week = 1; week <= 18; week++) {
        const slot = entry.slots.find((candidate) => candidate.season === season && candidate.week === week);
        const cell = el("td");
        if (slot) {
          const chosen = state.week && state.week.season === season && state.week.week === week;
          const included = slot.videoIds.length;
          const waiting = slot.reviewVideoIds.length;
          const button = el("button", {
            class: "slot " + SLOT_CLASS[slot.status] + (chosen ? " chosen" : ""),
            text: String(week),
            attrs: {
              type: "button",
              "aria-pressed": chosen ? "true" : "false",
              "aria-label": season + " week " + week + ": " + SLOT_LABEL[slot.status] + ", " + included + " included, " + waiting + " to review",
              title: SLOT_LABEL[slot.status] + " (" + included + " included, " + waiting + " to review)",
            },
          });
          button.addEventListener("click", () => {
            state.week = chosen ? null : { season, week };
            state.limit = PAGE_SIZE;
            renderList();
            renderGrid();
          });
          cell.append(button);
        }
        row.append(cell);
      }
      body.append(row);
    }
    table.append(body);
    grid.append(table);
    byId("grid-section").hidden = false;
  };

  const populateFilters = () => {
    const select = byId("filter-reason");
    const codes = new Map();
    for (const video of creator().videos) for (const reason of video.reasons) codes.set(reason.code, reason.label);
    select.replaceChildren(el("option", { text: "Any reason", attrs: { value: "all" } }));
    for (const [code, label] of [...codes.entries()].sort((a, b) => a[1].localeCompare(b[1]))) {
      select.append(el("option", { text: label, attrs: { value: code } }));
    }
    select.value = codes.has(state.reason) ? state.reason : "all";
    state.reason = select.value;
    byId("filter-status").value = state.status;
    byId("filter-sort").value = state.sort;
  };

  const youtubeLink = (video) =>
    YOUTUBE_ID.test(video.videoId)
      ? el("a", {
          class: "open",
          text: "Open on YouTube ↗",
          attrs: { href: "https://www.youtube.com/watch?v=" + video.videoId, target: "_blank", rel: "noopener noreferrer" },
        })
      : el("span", { class: "note", text: "No valid video link" });

  const describeEvent = (event) =>
    formatDate(event.decidedAt) + " · " + event.decision + " · " + event.reason + " (rule " + event.ruleVersion + ")";

  const decide = async (video, decision, reasonInput, message) => {
    if (state.busy || blocked()) return;
    const reason = reasonInput.value.trim();
    message.textContent = "";
    if (!reason) {
      message.textContent = ERROR_TEXT["reason-required"];
      reasonInput.focus();
      return;
    }
    state.busy = true;
    renderBusy();
    try {
      const result = await api("/api/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creatorKey: state.creator, videoId: video.videoId, decision, reason }),
      });
      state.data = result.state;
      say("Saved: " + decision + " — " + reason);
      state.busy = false;
      renderAll(video.videoId);
    } catch (error) {
      state.busy = false;
      renderBusy();
      message.textContent = ERROR_TEXT[error.code] || ERROR_TEXT["server-error"];
    }
  };

  const renderVideo = (video) => {
    const item = el("li", { class: "video status-" + video.status, attrs: { tabindex: "-1" } });
    item.dataset.videoId = video.videoId;
    const badges = el("p", { class: "badges" }, [
      el("span", { class: "badge badge-" + video.status, text: STATUS_LABEL[video.status] }),
      el("span", { class: "badge", text: "Rule said: " + STATUS_LABEL[video.classification === "candidate" ? "present" : video.classification] }),
    ]);
    const meta =
      video.season === null
        ? "Outside the registered weeks"
        : video.season + " week " + video.week;
    item.append(
      el("h3", { text: video.title || "(no title)" }),
      el("p", { class: "meta", text: meta + " · " + formatDate(video.publishedAt) + " · " + formatDuration(video.durationSeconds) }),
      badges
    );
    if (video.reasons.length > 0) {
      item.append(el("ul", { class: "reasons" }, video.reasons.map((reason) => el("li", { text: reason.label }))));
    }
    if (video.description) {
      item.append(el("details", {}, [el("summary", { text: "Description" }), el("p", { class: "description", text: video.description })]));
    }
    item.append(youtubeLink(video));

    if (video.decision) {
      item.append(
        el("p", { class: "decision", text: "Your decision: " + video.decision.decision + " — " + video.decision.reason })
      );
    }

    const reasonInput = el("input", {
      class: "reason",
      attrs: { type: "text", maxlength: "500", list: "reason-presets", placeholder: "Reason (required)", "aria-label": "Reason for " + (video.title || video.videoId) },
    });
    const message = el("p", { class: "error", attrs: { role: "alert" } });
    let pending = null;
    // Whether each button is enabled is decided in one place, renderBusy.
    const mk = (label, decision) => {
      const button = el("button", { class: "act act-" + decision, text: label, attrs: { type: "button" } });
      button.addEventListener("click", () => decide(video, decision, reasonInput, message));
      return button;
    };
    const form = el("div", { class: "decide" }, [
      reasonInput,
      mk("Include", "include"),
      mk("Exclude", "exclude"),
      mk("Clear decision", "clear"),
    ]);
    reasonInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && pending) {
        event.preventDefault();
        decide(video, pending, reasonInput, message);
      }
    });
    item.addEventListener("keydown", (event) => {
      if (event.target !== item || blocked()) return;
      if (event.key === "i" || event.key === "e") {
        pending = event.key === "i" ? "include" : "exclude";
        message.textContent = "Type a reason and press Enter to " + pending + ".";
        reasonInput.focus();
        event.preventDefault();
      }
    });
    item.append(form, message);

    if (video.events.length > 0) {
      item.append(
        el("details", { class: "history" }, [
          el("summary", { text: "History (" + video.events.length + ")" }),
          el("ol", {}, video.events.map((event) => el("li", { text: describeEvent(event) }))),
        ])
      );
    }
    return item;
  };

  const renderList = () => {
    const matches = visibleVideos();
    const list = byId("videos");
    list.replaceChildren(...matches.slice(0, state.limit).map(renderVideo));
    byId("count").textContent = "Showing " + Math.min(state.limit, matches.length) + " of " + matches.length + " videos.";
    byId("more").hidden = matches.length <= state.limit;
    const note = byId("week-note");
    note.hidden = !state.week;
    note.textContent = state.week ? "Every video published in " + state.week.season + " week " + state.week.week + ", whatever its status. Select the week again to go back." : "";
    byId("list-section").hidden = false;
    byId("keys").hidden = false;
    renderBusy();
  };

  const renderBusy = () => {
    for (const button of document.querySelectorAll(".act")) {
      const isClear = button.classList.contains("act-clear");
      const item = button.closest(".video");
      const video = item && creator().videos.find((entry) => entry.videoId === item.dataset.videoId);
      button.disabled = state.busy || blocked() || (isClear && !(video && video.decision));
    }
  };

  const renderStale = () => {
    const stale = state.data.stale;
    if (!stale.blocked) return showBanner("");
    const since = stale.oldestFetchedAt ? formatDate(stale.oldestFetchedAt) : "an unknown time";
    showBanner(
      "The saved YouTube data was fetched " + since + " and is over " + stale.maxAgeDays + " days old. Decisions are disabled. " +
        "Refresh it with the discover command, then reopen this page."
    );
  };

  const renderAll = (focusVideoId) => {
    if (!creator()) state.creator = state.data.creators[0] ? state.data.creators[0].key : null;
    renderStale();
    renderCreators();
    renderSummary();
    renderGrid();
    populateFilters();
    renderList();
    if (focusVideoId) {
      const item = [...document.querySelectorAll(".video")].find((node) => node.dataset.videoId === focusVideoId);
      if (item) item.focus();
    }
  };

  const wireFilters = () => {
    byId("filters").addEventListener("submit", (event) => event.preventDefault());
    const on = (id, name, parse) =>
      byId(id).addEventListener("input", (event) => {
        state[name] = parse(event.target.value);
        if (name === "status") state.week = null;
        state.limit = PAGE_SIZE;
        renderList();
        renderGrid();
      });
    on("filter-status", "status", (value) => value);
    on("filter-reason", "reason", (value) => value);
    on("filter-query", "query", (value) => value);
    on("filter-sort", "sort", (value) => value);
    byId("more").addEventListener("click", () => {
      state.limit += PAGE_SIZE;
      renderList();
    });
    document.addEventListener("keydown", (event) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      if (event.key !== "j" && event.key !== "k") return;
      const items = [...document.querySelectorAll(".video")];
      const index = items.indexOf(document.activeElement);
      const next = items[event.key === "j" ? Math.min(items.length - 1, index + 1) : Math.max(0, index - 1)];
      if (next) next.focus();
    });
    const presets = byId("reason-presets");
    for (const reason of QUICK_REASONS) presets.append(el("option", { attrs: { value: reason } }));
  };

  const start = async () => {
    wireFilters();
    if (!token) {
      say("Missing token. Open the address printed by the command, including the part after #.");
      return;
    }
    try {
      state.data = await api("/api/data");
    } catch (error) {
      say(ERROR_TEXT[error.code] || "Could not load the review data.");
      return;
    }
    if (state.data.creators.length === 0) {
      say("The discovery file has no creators.");
      return;
    }
    say("Loaded " + state.data.creators.length + " creator(s).");
    renderAll();
  };

  start();
})();
