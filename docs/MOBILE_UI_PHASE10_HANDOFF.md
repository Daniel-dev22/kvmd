# Mobile-first web UI — Phase 10 handoff (the switches reach every writer)

**Branch:** `feat/switches-reach-every-writer` off `master` (fork `Daniel-dev22/kvmd`, `origin`),
worktree `/docker_container_volumes/kvmd-phase10`.
**Range:** `39027ec2` (the Phase 9 merge) … this document's own commit.
**Status:** committed and pushed. **NOT deployed** — the kd appliance is still running Phase 8
(`31511d9d`); Phase 9 was merged and never deployed either, so a deploy now ships **two** phases.
Read the release-scope note under *Traps*.
**Read first:** `MOBILE_UI_PHASE9_HANDOFF.md`, then this.

**362 tests, all passing** — `CHROMIUM=/snap/bin/chromium node --test --test-concurrency=3
--test-timeout=120000 testenv/jstests/*.test.mjs`, ~122 s on a quiet machine (339 at the start of
the phase). **Check `uptime` first** — see Traps. `eslint` is clean and now actually runnable
locally; see Traps for the one-line reason it was not.

---

## What shipped

One concern, in two halves: **a control that makes a promise about what leaves the page must be
enforced where the page leaves, not at the call sites that happened to remember.**

### 1. "Mute KB/M" reaches every writer

The switch says *don't send keyboard & mouse events*. It was applied by whichever module had
thought to ask, and the set that had not asked is the interesting one:

| route out | writers | gated before this phase |
|---|---|---|
| websocket `sendHidEvent` | `keyboard.js`, `mouse.js`, **`recorder.js`** | 2 of 3 |
| HTTP `api/hid/print` | `keyboard.js` (the bar), **`paste.js`**, **`recorder.js`** | 1 of 3 |

So a **replayed macro typed, clicked and moved the mouse on the host with the switch on**, and the
Text panel's Paste typed. The rule was correct, was tested, and reached about a third of the
traffic.

It now lives at the two waists — `hidSilences()` inside `session.js`'s `__sendHidEvent`, and
`hidMuted()` at the top of `print.js`'s `printText`. `mute.js` is the only module that reads the
switch, and a test fails if anything else looks it up. The three copies of that lookup in
`keyboard.js` are gone: the bar decodes and queues exactly as before and the transports refuse,
**deliberately**, so that no guard here can mask the guard there.

Each surface says its own refusal in the channel it already had: the bar's status line
(*"Muted — nothing was sent"*), one dialog from the Text panel which **keeps your text** because it
was never typed, a replay that refuses to start and stops if the switch is thrown mid-script, and
the Shortcuts menu, which used to flash its keys and do nothing.

🔴 **A release is delivered whatever the switch says** (`RELEASABLE` in `mute.js`) — unchanged, and
now true for the recorder too. The page cannot know whether the host is holding a key, and a mute
that can leave Ctrl down on someone's server is not a mute. **Do not "fix" this by releasing only
keys the page remembers pressing:** such a set is empty after a reconnect, which is exactly when the
host IS still holding something.

### 2. "Hide input text" reaches the field a phone actually types into

The switch masked the Text panel's textarea and nothing else. The compact typing bar — the field a
phone types into, and the one a password manager fills — showed the password at 16px with the
switch on. Both are doors into the same `api/hid/print`.

One preference (`hid.pak.secure`, still the Text menu's) now sets one attribute on `<html>`, and one
block in `main.css` names the fields, so a third field is a selector rather than a second binding.

**Two masking mechanisms, because the two fields hold different things. Do not unify them:**

- The textarea holds exactly what was typed ⇒ a disc per character is honest.
- 📏 The bar's field always holds **eight zero-width padding characters** while focused (`typing.js`,
  `PAD` — the padding is what makes Android report a Backspace at all). Measured: `-webkit-text-
  security` renders a disc for U+200B like any other character, so the same rule there draws a
  permanent `••••••••` standing for nothing — in a field where pressing Backspace does not remove
  them but sends a Backspace **to the host**, deleting real content.
- 📏 So the bar's content leaves the box instead. `color: transparent` alone was not enough and
  **only a screenshot said so**: the engine draws its own IME composition marker — a filled block in
  chromium, an underline on Android — to the WIDTH of the composing word, so the password's length
  was on screen in a field that looked broken. `text-indent: -9999px` takes the marker and the caret
  with it.

Nothing is echoed at all. That is the point: the contents have already reached the host, so an echo
is a transcript the bar does not keep, and the console's video is where the host says what it got.

---

## What was verified, and HOW

**Measured, from the host's side of the wire.** `testenv/jstests/browser.mjs` decodes the binary HID
frames the page sends, so `server.host` is one ordered record across both transports. Every mute
assertion reads that, not the page's own intentions.

**Every negative assertion is bracketed**, which is the discipline this phase needed most: a test
that asserts *nothing arrived within 400 ms* gets **easier** under load, so a green run proves
nothing on a busy box. Five of the seven have a **positive twin** in the same test (the same action
unmuted, arriving); the other two have a **non-vacuity guard** (the replay is asserted to have
STARTED before asserting the second key never came; the dialog is asserted to exist and to name the
switch before asserting it is not a confirmation). Without one or the other, a green negative
assertion is only evidence that you did not wait long enough.

**Every behavioural claim was canaried** — the defect reintroduced by patch, the suite re-run. Two
canaries of the first sweep **survived**, and both were missing tests rather than wrong code:
a replayed print that refuses mid-script, and a lone muted Enter (a burst of text is also announced
by the queue's error path, so every test that typed masked it). Both now have tests.

**The review's fixes were canaried too**, because most review fixes are inert.

**Assumed, NOT measured.**
- **Nothing here has run on a phone, on WebKit, or against a real appliance.** iOS is unexercised,
  as in every phase. The appliance stub answers the same shapes; it is not kvmd.
- **The Android composition marker is an underline rather than a filled block** — that is a claim
  about Android Chrome, not a measurement. What was measured is that `text-indent` removes the
  marker in this chromium.
- **Nothing has spoken to a screen reader.**
- The `atx`-while-muted test uses a **synthesised** upload (a `DataTransfer` with a JSON file), not a
  file the user picked.

---

## Decisions, and the alternatives rejected

**The rule goes at the waist, not in the callers.** A fourth writer cannot forget a rule it never
has to remember. The corollary is that `keyboard.js` still asks `hidMuted()` in two places — but
only to choose WORDS, never to gate: delete both and the switch is still obeyed, because the
transports refuse. A transport cannot word a refusal; it has no idea which surface it is carrying
for.

**Report the refusal with the reason that CAUSED it, not by re-reading the switch.** The first
version asked `hidMuted()` when the sentence was written. Two lenses found the hole: `status === 0`
is a request that **died**, and kvmd may have typed all of it — so muting after a print is in flight
made the bar claim *"Muted — nothing was sent"* about a burst the host had. The reason now travels
with the failure.

**A recording keeps what you meant, not what left.** A muted bar used to record its Enter (the
socket path always records, muted or not) and lose its text (recorded only on a 200). Replayed
later that is a **bare Enter into whatever is on the host's command line** — verbatim the hazard the
print-recording exists to prevent. Rejected alternative: stop recording the keys instead. That would
have needed the transport to report what it wrote, and would have changed what a muted board records
— a rule that predates this phase.

**The replay refuses to start only when the script contains something the switch silences.** A
recording also replays ATX and GPIO. Muting the keyboard before power-cycling a host is exactly the
thing someone would do, and the first version refused it with a message about keyboard events.

**A muted bar key does not put the board down.** `print.js` already refused without touching it, on
the grounds that dropping the modifiers the user latched, for something that never left, is a side
effect they did not ask for. The key path did it unconditionally; the two ways out now agree.

**The Text panel is refused before the confirmation, not after.** Asking *"are you sure you want to
paste 7 characters?"* about a paste that cannot happen, and only then refusing, is two dialogs and
the first one is a lie. The check there decides only whether to ASK.

**Masking the bar with discs was measured and rejected** (the eight phantom dots, above). Do not
re-propose it.

**`text-indent` and `color: transparent` are both kept.** They hide different things and neither is
the other's fallback. Two independent reasons beyond the composition marker, both from the review:
Chrome's autofill UA stylesheet sets `-webkit-text-fill-color !important`, which **overrides**
`color` — on an autofilled field the indent is the only thing still hiding the value; and an engine
that forces a selection foreground colour repaints selected text opaque.

---

## Surprises — the expensive ones

📏 **The suite's own record of keys is not the wire, and never was.** `ime.test.mjs` builds its
`host` list from `tools.debug("Keyboard: key pressed:")`, a line written with no socket at all — so
it reports what the keyboard EMITTED. This phase put the gate below that line, and the muted test
went red *correctly*. The first fix was to make the log truthful; that broke three `touch.test.mjs`
tests, because most of the suite runs with no appliance and relies on the log meaning "the page
decided to". So the log kept its meaning and the **test** moved to `server.host`. The general shape:
*an instrument that reads a log line beside a write measures the write only while nothing between
them can drop it.*

🔴 **The test harness had been leaking 5.4 GB of RAM for three days, and its cleanup looked
correct.** `browser.mjs` created each chromium profile in `/tmp` — which on this machine is
**tmpfs** — and removed it on close. But snap confinement **redirects `/tmp`** for snap-packaged
apps, so the browser's real profile went to `/tmp/snap-private-tmp/snap.chromium/tmp/` while the
harness deleted an empty stub in the real `/tmp`. That directory is root-owned and `drwx------`, so
it could not have cleaned it even if it had tried. **It leaked on the happy path**, not only when a
run threw: 285 profiles, 5.4 GB, which filled swap on a 30 GB box and produced a suite run with 14
failures that were entirely the machine. Fixing it produced two more measurements worth keeping:
snap's `home` interface does **not** grant hidden directories (chromium dies at `SingletonLock` in
`~/.cache`), and `close()`'s `rm` started **racing chromium's own writes** — it never could before,
because it had been deleting an empty stub.

📏 **`node --test` loads each file once, at start.** Editing a test file while the suite is running
gives results from a mixture of versions. One "failure" cost twenty minutes before the cause was
the edit, not the code.

**The canary harness ran in the same worktree the review lenses were reading.** One lens noticed —
it saw `if (false) {` in `paste.js` and then the real line seconds later — and correctly built its
analysis from `git show` copies instead. It was right to; the next review must give the lenses a
worktree of their own, or run the canaries after they finish.

---

## Deferred — with why

| # | Item | Why / what it needs |
|---|---|---|
| **1** | **Window-header buttons are 40px**, under both 44pt and 48dp, Close included. | Phase 8's item 4, deferred again on purpose: raising it grows every window header, which is what put keys underneath the header in Phase 6. A layout change with its own re-measurement — **this is the next phase.** |
| **2** | **The mute switch is the only preference on the page that is not persisted**, so it fails OPEN on a reload or a discarded mobile tab. Every other switch (`hid.pak.secure`, `hid.pak.ask`, `hid.keyboard.*`, `msd.*`, `stream.*`) is stored. | Genuinely a product call, and the asymmetry is the thing to decide rather than ignore: a persisted mute is one you can forget you left on; an unpersisted one comes back live after the tab the phone discarded. One line (`bindSimpleSwitch($("hid-mute-switch"), "hid.mute", false)`) either way, and testable exactly as `hid.pak.secure` is. **Ask the owner.** |
| **3** | **The recorder writes the credential to disk in plaintext**: with "Hide input text" ON, typing into either field while recording stores the literal text in `__events`, and **Download script** serialises it to `script.json`. | Pre-existing for the Text panel and unchanged by this phase — but this phase promotes the switch to a document-wide promise, which makes the recorder's copy its loudest contradiction. `paste.js` is careful to log only `${text.length}` for exactly this reason. Needs a decision: a timing placeholder instead of the body while secure is on, and say so on the Record tip. Two deliberate user actions are required to reach it. |
| 4 | **A bulk insert into the bar reaches the host unannounced** — paste, drag-drop, a password manager's autofill, a multi-line snippet flattened into one line by a single-line `<input>`. | The other half of the old register row 23, and unchanged: the phase closed the *live-screen* half. A pipe cannot confirm every keystroke, so this needs a rule that distinguishes typing from inserting — product surface, and a phase of its own. |
| 5 | **Muting cannot retract a print already in flight.** A 5,000-character paste keeps typing on the host for minutes. | Inherent, not a defect: the switch's promise is about what the page SENDS. Only `api/hid/reset` could stop it. Recorded so it is not re-raised. |
| 6 | **While muted the strip can show a latch the host never received** (the press was silenced, the class was not). | The inverse of the defect `mute.js` exists for, and self-healing: the next unmuted print releases it, and the release is delivered either way. Refusing to latch while muted would make the board inert and hide the user's own state. |
| 7 | **A full suite still leaves ~4 partial profile directories**, ~700 KB each. | 📏 Down from 285 directories and 5.4 GB, and now on **ext4 rather than RAM**: chromium's children outlive the parent by a few milliseconds and recreate a file or two after the `rm`. Bounded by the six-hour sweep at the next launch. |
| 8 | **`ime.test.mjs`'s key record is the page's intent, not the wire.** | Fine for the ordering claims it exists to make; it cannot see anything the transports drop. The muted test there now reads `server.host`. Worth knowing before writing a new assertion against `window.__host`. |
| 9 | **Login and launcher are still not mobile-first** — `web/login/index.pug` and `web/index.pug`, the latter still a `<table>`. | Carried from Phase 6. |

---

## The next phase, and its first step

**Phase 8's item 4 — 44px window-header buttons** — deferred twice now, and the reason it keeps
being deferred is the reason it needs its own phase: every window header grows, and Phase 6 has
already shown that growing the header puts keys underneath it.

**First step:** measure, before changing anything. In the compact layout at 390×844, record the
rendered height of `div.window-header` and the top of the first row of `#keyboard-compact` for the
keyboard, mouse and stream windows, with touch emulation ON (`pointer: coarse` grows the header from
21px to 36px — `layout.test.mjs`'s `open(..., touch)` argument exists for this). Those three numbers
decide whether the 4px can come out of the header's padding or has to come out of the sheet.

Then register rows 2 and 3 above, which are the two that need the owner's answer rather than a
repair.

---

## Traps — do not re-derive these

🔴 **Check `uptime` before you believe a test run.** 📏 This session ran the suite at load average
**335** (peer sessions' emulator and JVM builds) and got 14 failures, every one a timeout, plus one
that passed alone a minute later. The same tree at load 6 was green, unchanged. `node --test` runs
one process per FILE. A red suite on a loaded machine is not evidence of anything — **but a GREEN
one under load still is**, because load manufactures timeouts, not passes. The exception is the
negative assertion bounded by a timer; see *What was verified*.

🔴 **Commit before canarying.** The harness refuses to touch a file with uncommitted changes and
refuses to start unless the baseline is green — copy both checks into any new one. This is the third
session in a row to be told; the first two lost work.

🔴 **Do not edit a test file while the suite is running.** `node --test` loads each file once.

🔴 **`/tmp` on this machine is tmpfs — every byte written there is RAM** — and a snap-packaged
browser's `/tmp` is redirected somewhere your cleanup cannot reach. Browser profiles now live under
`$HOME/kvmd-jstest-profiles` (visible, not `~/.cache`: snap's `home` interface does not grant hidden
directories). A `finally { close() }` is the right fast path and cannot be the only one — SIGKILL,
which is what a test timeout sends, defeats every handler, so the six-hour sweep at the next launch
is what actually holds.

**eslint runs locally now.** `testenv/linters/eslintrc.js` hard-codes
`require("/usr/lib/node_modules/globals/index.js")`, which did not exist; symlinking it to
`/usr/share/nodejs/globals` makes `npx --yes eslint@9 --config=testenv/linters/eslintrc.js
web/share/js` work. It found three real errors in this phase's first draft. The distro's eslint is
v6 and cannot read the flat config, which is why "no linter in the loop" was true for three phases.

**`make pug` needs Docker**, but `npx --yes pug-cli@1.0.0-alpha6 --pretty web/kvm/index.pug -o
web/kvm` reproduces the committed HTML byte-for-byte. This phase changed two `.pug` files, so
`web/kvm/index.html` is regenerated in the same commit; nothing in the suite checks that they match.

**`printText`'s `on_done(null)` means the page refused locally** — today, that it is muted. Every
caller must answer it: an unanswered refusal leaves the Text panel's controls disabled for ever and
a replay wedged mid-script with its LED spinning.

**A `status === 0` XHR is a request that DIED, not one that never left.** kvmd may have typed all of
it. Nothing may tell the user it did not arrive.

**Three structural gates, and they are the point.** `nothing posts to api/hid/(print|events) except
print.js`, `nothing writes the socket except session.js`, and `nothing reads the mute switch except
mute.js`. They are what make "exactly two routes out" a property rather than an observation.
