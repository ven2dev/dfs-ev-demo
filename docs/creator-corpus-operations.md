# Creator corpus tools (owner-run)

These commands build the expected-video manifest for the creator corpus (#40,
#88), let the owner review it (#92), and give the owner a queue for capturing
transcripts by hand (#89). They are **local, owner-run tools**.
They are not part of the deployed app, a build, CI or any scheduled job, and
nothing here is imported by the application.

They operate under the #40 internal-POC exception and its guardrails. Read the
[amendment on #40](https://github.com/ven2dev/dfs-ev-demo/issues/40) before
use. The tools fetch **metadata only** (video IDs, titles, descriptions,
publish times, lengths) through the official YouTube Data API. They never fetch
captions, transcripts or audio. Transcripts enter only when **you** copy one from
YouTube's own transcript panel and paste it into the Capture page (step 10). The
exception ends before any public use (#91).

## Ground rules

- **Run these in your own terminal**, not one attached to an agent session. The
  commands print creator names and titles, and your API key is in that
  terminal's environment.
- **Everything the tools read or write must be a `.json` file (or, for the
  capture log, a `.jsonl` file) outside this repository.** They refuse any path inside the repository (after resolving
  symlinks), so creator names, API data and your decisions cannot be committed
  by accident. A file that is itself a symbolic link, or has a second hard
  link, is refused too, since it could point back into the repository. Output
  files are created with owner-only permissions and are never overwritten. An
  existing capture log that others can read is refused, not changed.
- **Never put the API key in a file, an argument, an issue or a chat.** It is
  read only from the `YOUTUBE_API_KEY` environment variable and is sent in a
  request header, never in a URL. Error output contains one fixed code and
  never the key, a URL or a raw response.
- **Keep creator names out of the repository and GitHub.** Use the opaque `key`
  (for example `creator-a`) everywhere that is shared. Names live only in your
  private creators file.
- **Real transcripts never go into an agent session**, whether a relay or a
  local one, and never into an issue, a pull request or a commit. Do the
  capture work in your own browser and terminal, and do not ask an agent to
  open, print or summarize the capture log.
- Use Node 24 (`nvm use` in the repository).

A suggested private folder: `~/.config/dfs-ev-demo/creators/`.

## What is fixed in advance

`scripts/creator-corpus/registration.json` records the window and rule that were
registered before any data was pulled (see the registration comments on #88):

- **Window:** 2024 Week 1 through 2026 Week 4, regular-season weeks 1–18 only.
  Playoffs and the preseason are excluded. Extending the window, adding a
  creator or changing the rule is a new, separately recorded registration. It is
  not an edit made after looking at results.
- **Inclusion rule v1** (`src/lib/creatorVideoRule.ts`): a video is a *candidate*
  when its title has a clear prop signal (props, DFS, player TDs) and a football
  signal (NFL, TNF/SNF/MNF, or "Week N"), and it was published inside a
  registered week. Fantasy-football titles, other leagues, videos under two
  minutes, and live or upcoming broadcasts are excluded. Anything ambiguous
  (picks without "props", a team name alone, a signal only in the description, a
  title week that disagrees with the publish week, an unknown length) is
  **flagged for your review** and never decided automatically. Week and season
  always come from the publish date, using the nflverse-derived calendar in
  `src/lib/nflSeasonCalendar.ts`.

Each registered week for each creator becomes one **slot**: *included* (at least
one video counts), *needs review* (only flagged videos), or *missing* (nothing
qualifying). A missing week is reported as missing. It is never filled from
another week or another video.

## Walkthrough

### 1. Describe the creators

Create a creators file (names stay in this file only):

```json
[
  { "key": "creator-a", "name": "Channel Name As Shown", "seedVideoId": "https://www.youtube.com/watch?v=VIDEO_ID_1" },
  { "key": "creator-b", "name": "Another Channel", "seedVideoId": "VIDEO_ID_2" }
]
```

`key` is lowercase letters, digits and hyphens (up to 32 characters, unique).
`seedVideoId` is any one video from that channel, as a watch URL or the
11-character ID. Up to 20 creators.

### 2. Set the API key (this terminal only)

```bash
read -rs "YOUTUBE_API_KEY?YouTube API key: "
```

Run that line by itself, then:

```bash
export YOUTUBE_API_KEY
```

### 3. Resolve the channels

```bash
npm run creators -- resolve --creators ~/.config/dfs-ev-demo/creators/creators.json --output ~/.config/dfs-ev-demo/creators/registry.json
```

One API call per creator (1 quota unit each). It prints, for each creator, how
well your stored name matches the channel the seed video belongs to
(`exact`, `normalized`, `partial` or `mismatch`) next to both names. A creator
that fails (for example a deleted seed video) is listed with its code and the
rest still resolve. Nothing is confirmed yet.

### 4. Confirm creators one by one

```bash
npm run creators -- confirm --registry ~/.config/dfs-ev-demo/creators/registry.json --keys creator-a,creator-b --output ~/.config/dfs-ev-demo/creators/registry.confirmed.json
```

Confirm only creators whose names you checked. A `mismatch` cannot be confirmed:
fix the seed video or name in the creators file and resolve again.

### 5. Discover videos

```bash
npm run creators -- discover --registry ~/.config/dfs-ev-demo/creators/registry.confirmed.json --output ~/.config/dfs-ev-demo/creators/discovery.json
```

For each confirmed creator it pages the channel's uploads (newest first, 50 per
request), stops once uploads are older than the window, fetches details only
for videos inside the window, and builds the manifest. It prints a coverage
table and the quota used. A run for four creators used about 150 units against
a daily default of 10,000. Options:

- `--max-units N` — hard cap for the run (default 1000); the run stops before
  it would be exceeded and writes nothing.
- `--decisions <file>` — apply your review decisions (see step 7). A creator key
  in the file that is not in the registry stops the run before any API call.
  Decisions that cannot be applied are listed (see *Decisions that cannot be
  applied* below).
- `--allow-incomplete-end-week` — only for testing. Without it the command
  refuses to run until the registered end week has closed.

Videos the API no longer returns (removed or made private) are counted as
unavailable and never replaced.

### 6. Review in the browser

```bash
npm run creators -- review --input ~/.config/dfs-ev-demo/creators/discovery.json --decisions ~/.config/dfs-ev-demo/creators/decisions.json
```

To also use the Capture page (step 10), add `--captures <file>.jsonl`, a new
file or your existing capture log.

It prints an address that works only on this computer (add `--port N`, 1024–65535,
to choose the port) and keeps running until you press Ctrl+C. Open the address
in your browser, **including the part after `#`**. That part is a random token;
the page removes it from the address bar once it has read it. If you lose the
token, stop the command and start it again.

In the page:

- Pick a creator. The summary shows weeks included, needing review and missing,
  and your decisions so far.
- The **week grid** shows every registered week. Select a week to see **every**
  video published in it, including excluded ones, then select it again to go
  back. This is how you inspect a missing week.
- Filter by status (default: needs review), by reason, or by text, and order by
  date.
- Each card shows the week, the time in Eastern, the length, what the rule said
  and why in plain words, a description snippet, and a link that opens the video
  on YouTube so you can judge it yourself.
- **Include**, **Exclude** or **Clear decision**, each with a required reason
  (up to 500 characters). Keyboard: `j`/`k` move between videos; `i` or `e`
  focus the reason field, then Enter saves.
- Every decision is saved immediately to the decisions file. Closing the tab
  loses nothing. Saves take a short lock (a hidden `.decisions.json.lock` file
  beside the log), so two review windows or two commands on the same log cannot
  overwrite each other's decisions. A lock left by a crashed run is cleared
  automatically once its owner is gone or after 30 seconds.

If the saved YouTube data is older than 30 days the page shows a red banner and
disables all decisions (see *Data age* below).

### 7. Decisions file

The decisions file is an **append-only log**. Nothing in it is ever edited or
deleted:

```json
{
  "creator-a": [
    {
      "videoId": "VIDEO_ID_1",
      "decision": "include",
      "reason": "Props throughout the video",
      "ruleVersion": "v1",
      "decidedAt": "2026-10-07T16:00:56.019Z"
    }
  ]
}
```

The latest event for a video is its active decision. `clear` withdraws an
earlier include or exclude while keeping why and when it was withdrawn. The rule
version and the time are written by the tool, not typed by you. Only videos
inside the registered window can be decided. You do not normally edit this
file by hand; if you do, every field is required and the tool refuses a file it
cannot read rather than guessing.

### 8. Produce the manifest with your decisions

```bash
npm run creators -- rebuild --input ~/.config/dfs-ev-demo/creators/discovery.json --decisions ~/.config/dfs-ev-demo/creators/decisions.json --output ~/.config/dfs-ev-demo/creators/manifest.json
```

This applies the active decisions to the saved videos with **no API call** and
writes a new file (it never overwrites). It refuses stale data, decisions for
unknown creators. A decision that cannot be applied is skipped and reported
(next section). To see coverage again at any time:

```bash
npm run creators -- screen --input ~/.config/dfs-ev-demo/creators/manifest.json
```

### Decisions that cannot be applied

Your log is permanent, but a decision can only count while its video is in the
saved data. `discover` and `rebuild` never fail on such a decision and never
skip it silently: the command prints how many were skipped, and the output file
lists each one under `decisionsNotApplied` with the reason:

- `video-unavailable` — YouTube listed the video but no longer returns it
  (removed or made private).
- `video-not-in-discovery` — the video is not in the saved data at all. It may
  have been deleted, or the ID in a hand-edited log may be wrong.
- `video-outside-window` — the video is outside the registered weeks.
- `creator-not-discovered` — the creator is in the registry but was not
  discovered in this run.

The skipped decision stays in the log. If the video returns, the next run
applies it again.

### 9. Refresh and delete when the data ages

Saved API data may be kept for at most 30 calendar days (see below). To
continue after that, run `resolve` and `confirm` again if your registry is also
older than 30 days (`discover` refuses a stale registry), then `discover` with a
**new output filename**, then `review` and `rebuild` against the new file,
reusing the same decisions file. Decisions carry over because they are keyed by
video ID.

Then **delete the old files**. The 30-day limit is on keeping the data, not only
on using it:

```bash
npm run creators -- purge --input ~/.config/dfs-ev-demo/creators/discovery.json --dry-run
```

shows the file's kind, how many records it holds, its oldest fetch time and its
delete-by date, and whether it is stale, without printing any titles. Without
`--dry-run`, `purge` deletes the file once any record in it is past the limit.
It refuses to delete a file that is still inside its period unless you add
`--force`. It only accepts discovery, rebuilt-manifest and registry files, so
it can never delete your decisions log or any other file.

### 10. Capture transcripts by hand

Start the review tool with a capture log:

```bash
npm run creators -- review --input ~/.config/dfs-ev-demo/creators/discovery.json --decisions ~/.config/dfs-ev-demo/creators/decisions.json --captures ~/.config/dfs-ev-demo/creators/captures.jsonl
```

A **Capture** tab appears beside **Review**. Without `--captures` the tab does
not exist and the capture routes answer not-found. The tool checks the whole log
before it starts and refuses a damaged one (`invalid-captures-file`).

The queue holds the videos you have included (tick *Include videos still flagged
for review* to add flagged ones). For each video:

1. Select **Open on YouTube**, open the video's transcript panel, and copy the
   whole transcript.
2. Paste it into the Transcript box. The counter shows characters, size and
   lines.
3. Check the **Published date** against the video page. It starts as the day the
   API reports, in Pacific time, but what you save is the date **you** confirm.
   Pick the **Caption type** if you can tell (auto-generated or uploaded by the
   creator), and add a note if useful.
4. **Save transcript** (or Ctrl/Cmd+Enter). The page moves to the next video.
   If a video has no transcript, use **No transcript available**. **Skip**
   changes nothing. Pressing `n` outside a field also skips.

Things worth knowing:

- Text is stored exactly as pasted, except that line endings become `\n`, so
  every character, timestamp and word survives for later extraction and the
  stored hash describes exactly what you pasted. Limit 500 KB. Control
  characters are refused.
- The queue decides what can be saved, not the page. A video you excluded, or
  one still flagged while the box above is unticked, is refused with
  `video-not-in-queue` even from an old tab. If you exclude a video after
  capturing it, the capture stays in the log but the queue stops listing it.
- **No transcript available** also records the **Published date** you confirmed,
  like a saved transcript.
- Under 200 characters the page asks first (*Save anyway*), because that is
  usually a partial copy.
- A saved transcript is never edited. **Replace transcript** adds a new version
  and requires a reason; the older version stays in the log. A video marked
  unavailable can be captured later. Counts and the week grid update after every
  save, and the list's **Show** filter switches between needing a transcript,
  captured, unavailable, or everything.
- What you have typed but not saved is kept in memory while you look at another
  video, and is lost if you close the tab. After a failed save the text stays in
  the box.
- The page never shows a saved transcript back. It shows the length, a short
  fingerprint and a preview of the first 160 characters.
- **Backlog plan.** Work one creator at a time, oldest week first (the page
  opens on the oldest video that still needs one). Roughly 300–450 transcripts
  take a few focused sessions. Every save is written to the log immediately, so
  closing the tool and reopening it loses nothing and needs no clean-up.

The capture log is an **append-only** file with one JSON event per line
(`captured`, `replaced` or `unavailable`), each carrying the source
(`manual-owner-paste`), the usage status (`internal-research-only`), a SHA-256 of
the text and its length. The tool re-verifies every line when it reads the file
and refuses the whole file if any line was edited or damaged. Saves take the same
kind of short lock as decisions (a hidden `.captures.jsonl.lock` file), so two
windows or two commands cannot interleave writes. A lock is taken over only when
the process that held it no longer exists, never merely because it is old; a
lock held for over 5 seconds by a live process gives `file-busy`. Removing a
dead process's lock needs a short-lived claim of its own with the same
guarantees, so a paused process can never be displaced. If a process dies
mid-takeover it can leave a tiny hidden `.…lock.reap-…` file beside the log;
the next run clears it, and it is safe to delete by hand when no tool is
running. The log must
be a single-link regular file readable only by you, or it is refused.

The log holds transcript text, so treat it as the most sensitive file here: keep
it outside the repository (enforced), do not share it, and do not open it in an
agent session. It contains no API data, so the 30-day limit does not apply to
it, and `purge` will never delete it.

## Data age

The tools treat API-derived fields (titles, descriptions, publish times,
lengths, channel titles) as data to be refreshed, not kept. Every record carries
the time it was fetched. Data older than **30 days** is refused: `rebuild` fails
with `stale-discovery-data`, `discover` fails with `stale-registry-data`, and the
review page blocks decisions.

The 30-day figure is the policy's own: the YouTube API Services Developer
Policies (III.E.4.d) allow non-authorized data to be stored temporarily, "not
longer than 30 calendar days". That limit applies to keeping the data, so stale
files must be deleted, not only left unused. Use `purge` (step 9). Your
decisions (video IDs, your choice and reason) are your own records and are not
subject to the limit; titles, descriptions and channel titles are.

## Troubleshooting

Every failure prints one line, `creator-corpus: <code>`.

| Code | Meaning and fix |
| --- | --- |
| `api-key-missing` | `YOUTUBE_API_KEY` is not set in this terminal. Repeat step 2. |
| `forbidden` | Google refused the key: the API is not enabled for the project, or the key's restriction does not include YouTube Data API v3. |
| `quota-exceeded` | The project's daily quota is used up. Try again after midnight Pacific, or check the quota page. |
| `quota-limit-reached` | The run hit its own `--max-units` cap. Nothing was written. Raise the cap if the estimate allows it. |
| `end-week-not-closed` | The registered end week has not finished yet. Wait, or use the testing flag. |
| `must-be-outside-repository` | A file path is inside the repository. Use a folder outside it. |
| `directory-missing` | The folder for a file does not exist. Create it first. |
| `output-exists` | The output file already exists. Choose a new name; files are never overwritten. |
| `input-unreadable` | An input file is missing or is not valid JSON. |
| `invalid-creators-file`, `invalid-creator-key`, `invalid-creator-name`, `invalid-seed-video`, `duplicate-creator-key` | The creators file is malformed; see step 1. |
| `title-mismatch-cannot-confirm` | The stored name does not match the resolved channel. Fix the creators file and resolve again. |
| `creator-not-confirmed`, `no-confirmed-creators` | Run `confirm` first and pass the confirmed registry to `discover`. |
| `symlink-not-allowed`, `hard-link-not-allowed` | A file is a symbolic link or has a second hard link. Use a plain file in a folder outside the repository. |
| `file-busy` | Another process held the decisions-file or captures-file lock for over 5 seconds. Wait and try the save again. |
| `jsonl-file-required` | The capture log must be a `.jsonl` file (and the other files `.json`). Rename it or choose another path. |
| `invalid-captures-file` | The capture log is damaged or was edited by hand. The tool will not read, repair or overwrite it. Restore it from a copy. |
| `transcript-empty`, `transcript-too-large`, `transcript-invalid-characters`, `transcript-too-short` | The Capture page refused the text: nothing pasted, over 500 KB, control characters, or under 200 characters (confirm with *Save anyway* if it is really that short). |
| `invalid-published-date`, `invalid-caption-kind`, `note-too-long`, `reason-too-long` | A field on the Capture form is not acceptable. The page shows what to change; nothing was saved. |
| `reason-required` | Replacing a transcript needs a reason. |
| `already-captured`, `already-unavailable`, `nothing-to-replace` | The video's state does not allow that action (for example a second capture instead of a replace). |
| `video-not-in-queue` | The video is excluded, or flagged while the flagged box is unticked. Reload the page; change the decision or tick the box if you want it in the queue. |
| `insecure-file-permissions` | The capture log can be read by other users. Nothing was read or written. Run `chmod 600` on it (the tool never loosens or silently changes it). |
| `payload-too-large` | A request body was over the limit. A transcript above 500 KB is refused for this reason or `transcript-too-large`. |
| `invalid-decisions-file` | The decisions file is not in the current log format. The tool will not overwrite it. |
| `unknown-creator-in-decisions` | A creator key in the decisions file is not in the registry (usually a typo). Nothing was fetched. Fix the key. |
| `invalid-decisions-present` | The decision log itself is damaged (a duplicate or reason-less decision). Restore it from a copy. |
| `stale-discovery-data` | The saved data is over 30 days old. Run `discover` again, then `purge` the old file. |
| `stale-registry-data` | The saved channel details are over 30 days old. Run `resolve` and `confirm` again. |
| `not-stale-yet` | `purge` kept a file that is still inside its 30 days. Use `--force` to delete it anyway. |
| `unrecognized-data-file` | `purge` was given something that is not a discovery, manifest or registry file. Nothing was deleted. |
| `nothing-to-clear`, `video-outside-window`, `unknown-video` | The review page refused a decision for that video (shown in plain words on the card). |
| `invalid-port` | `--port` must be 0 or between 1024 and 65535. |
| `network-error`, `timeout`, `server-error` | The request to Google failed. Check the connection and try again; a run that fails writes nothing. |
| `page-limit-reached` | A channel has an unexpectedly long upload list. Contact the maintainer before raising limits. |

Any other code: send the exact line (it contains no secrets).

## What is not covered here

- **Automatic caption or transcript fetching.** None exists and none is planned
  for the API-key path: the YouTube API policies bar scraping or non-API access
  by an API client. Transcripts come only from your own manual capture
  (step 10) or, later, creator-authorized sources (#91). This is a summary of the
  policy as read for this project, not legal advice.
- **Database persistence** (#90) is not built. Your decisions, captures and
  manifests live only in the private files above until the planned import.
- **Public or product use** of any of this is blocked by #91.
