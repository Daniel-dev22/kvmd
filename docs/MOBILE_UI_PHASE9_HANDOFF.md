# Mobile-first web UI — Phase 9 handoff (the typing path tells the truth)

**Branch:** `feat/typing-truth` off `master` (fork `Daniel-dev22/kvmd`, `origin`), worktree
`/docker_container_volumes/kvmd-phase9`.
**Range:** `0eb2c307` (the Phase 1–8 merge) … `PLACEHOLDER_HEAD`.
**Status:** PLACEHOLDER_STATUS
**Read first:** `MOBILE_UI_PHASE7_HANDOFF.md` and `MOBILE_UI_PHASE8_HANDOFF.md`, then this.

**PLACEHOLDER_TESTS tests, all passing** — `CHROMIUM=/snap/bin/chromium node --test
--test-timeout=120000 testenv/jstests/*.test.mjs`, ~70 s on a quiet machine (309 tests / ~64 s at
the start of the phase). **Check `uptime` first** (see Traps).

---

## What shipped

### 1. Typing types what you typed, and not a chord you did not ask for

🔴 The defect, reported from a phone and open since Phase 7: tap `Ctrl` on the compact strip — a tap
LATCHES since Phase 6 — then type `ls`. The host receives **Ctrl+L** (clears the screen) and
**Ctrl+S** (XOFF: the terminal freezes until Ctrl+Q). Nothing on screen explains it, because the bar
shows what was TYPED and the video shows what a chord did.

A latched modifier is not a colour on a key: it is a key genuinely **held down on the host**, and
`api/hid/print` makes the SERVER type the characters into whatever modifier state the HID is already
in.

**It was never a chord the user could have meant.** `kvmd/keyboard/printer.py:94-113` presses Shift
and AltGr itself for any character that needs them, so a latched Ctrl over a capital `C` is
**Ctrl+Shift+C** — copy, not interrupt — and over `@` on a German keymap it is **Ctrl+AltGr+Q**. A
chord is built from key CODES; a character plus a held modifier is a chord only by accident, and
only for unshifted ASCII on a keymap that happens to match.

So the board is let go first, every time. The key visibly un-latching is the feedback, and the
chords that ARE well formed — `Ctrl` with the strip's own arrows, `Esc`, `Tab` — go through the
keypad, where the code is known, and are untouched.

It lives in `print.js` because every caller of `api/hid/print` goes through it — and the third one
did not until now (below). The bar's own keys (Backspace, Enter) leave over the **websocket** and
never touch `print.js`, so they drop the board too: under a latched Ctrl, a Backspace is delete-word
in a shell and Enter is not Enter.

### 2. The bar stops claiming a keystroke it could not deliver

`api/hid/print` answers **200** whether or not kvmd could deliver a single scancode: with the OTG
gadget unenumerated the report is accepted and discarded (`otg/device.py:100-101` clears `online`
when the UDC is not configured). A null websocket was worse — keys were dropped while the text
around them still went out over HTTP, so `helo` plus a correction reached the host as `helolo`.

Two questions, answered **differently on purpose**:

| | what it is | what happens |
|---|---|---|
| `__linkUp()` — is there a socket? | a **fact**: `__innerSendKey` sends nothing without one | typing **refuses** and says so; the session's own reconnect loop clears it |
| `__hidReady()` — will the HID take it? | an **inference** from kvmd's state stream | the text **still goes**, and the page says it may not have arrived |

🔴 The second must not refuse. If the inference is ever wrong — a plugin whose `online` means
something else, a state stream that has not caught up — refusing would leave someone unable to type
at all, to prevent a message being optimistic; while sending under a wrong inference costs nothing,
because kvmd discards it exactly as it would have. **That ranking is pinned by a test**, not by this
paragraph: reintroducing the refusal turns `with the gadget unenumerated it says so -- and still
types` red.

### 3. …and says which, in words

The whole failure signal used to be a 2 s red border: colour only, nothing for a screen reader
(WCAG 1.4.1), and silent about which of three things went wrong. `div#hid-type-status`
(`role="status"`, `aria-live="polite"`) sits **above** the bar, over the bottom of the video, so it
covers no control and moves nothing; it is empty except when something is wrong, and it names the
cause — the link, the emulator, or the status kvmd answered. Closes register row 25.

The Text panel's paste has the same blind spot, so its **confirmation** — already the moment the
user is deciding — says it too. ⚠ With *Ask paste confirmation* turned off there is nothing to say
it in; recorded in the register rather than answered with a second surface.

### 4. A reconnect no longer inherits the last session's answer

`__online` is remembered per **keyboard**, not per socket, and `Hid.setState(null)` never tells the
keyboard anything — so after a disconnect the last session's answer stood, and a gadget that went
offline while the page was away read as **ready** for the round trip between the socket opening and
the first state event. On a flapping link that window is exactly where the typing happens.

### 5. The harness grew the websocket half of a fake appliance

`testenv/jstests/browser.mjs` now answers `api/auth/check`, accepts the `api/ws` upgrade (RFC 6455
by hand — a sha1 and a two-byte header; the suite stays dependency-free), streams the `hid` and
`hid_keymaps` state, replies to the session's heartbeat, and **decodes the HID binary frames the
page sends**. Keys and text therefore land in ONE ordered record (`server.host`), which is the only
place an ordering claim between the two transports can be read.

**Opt-in per test** (`server.control.session`, default off): with no kvmd the pages must still lay
out, which is what nearly every other suite measures.

📏 **It immediately paid for itself.** Shipping the refusal turned **13 existing tests red** — every
test that typed through the bar. They had been measuring a page with no kvmd behind it at all, i.e.
a bar that claimed success for keystrokes the socket could never have carried. `ime.test.mjs` and
the two typing tests in `layout.test.mjs` now run against the stub.

---

## What was verified, and HOW

**Measured, from the host's side of the wire.** The appliance stub decodes what the page actually
sent, so `the board is put down before the bar types under it` asserts on a single ordered record —
`["key ControlLeft down", "key ControlLeft up", "print \"ls\""]` — rather than on the page's
intentions. The Ctrl+Left regression test asserts the *whole* sequence, so a fix that dropped the
board for the keypad too would fail it.

**Every new behavioural test was canaried** — the defect was reintroduced by line number and the
suite re-run. All of these went red, and nothing else did:

| mutation | tests that failed |
|---|---|
| delete the release in `printText()` | 4 |
| delete `self.releaseAll()` in the queue's `sendKey` | 1 (the bar's own keys) |
| delete `__unholdAll()` in `keypad.js`'s tap-release path | 1 (Ctrl+Left) |
| `__linkUp = () => true` | 1 |
| `__hidReady = () => true` | 2 |
| delete `__online = null` in `setSocket` | 1 (the reconnect) |
| **make the print path REFUSE when the HID is unready** (the rejected remedy) | 2 |
| `$("hid-type-status")` resolves to null | 4 |
| `printText()` returns instead of throwing with no keyboard registered | 1 |
| a second `api/hid/print` caller added to `recorder.js` | 1 (the guard) |

**Assumed, NOT measured.**
- **The stub is not kvmd.** It answers the same shapes (`poll_state` sends the whole state, so it
  does too) but nothing here has talked to a real appliance since Phase 8's deploy.
- **Nothing here has run on a phone or on WebKit.** iOS is unexercised, as in every phase.
- **The ordering claim is the stub's ARRIVAL order** across two sockets on loopback. It has never
  been observed to invert (the release is written synchronously from JS before the XHR is
  constructed), but two TCP connections are not ordered by anything stronger than that.
- **The 4 s message has not been read by anyone on a device.** It is long enough to read on a
  desktop; a phone is a different reading distance.

---

## Decisions, and the alternatives rejected

**Release the board before typing; do NOT refuse while something is latched.** The register offered
both as "the owner's decision". It is not one: a printed character under a held modifier is not the
chord the user would be protected for (see `printer.py`, above), so refusing would drop what they
typed to preserve an accident — and it needs a second explanation on screen for a state the strip is
already showing. Releasing costs the chord-by-accident and nothing else.

**Where the rule lives: `print.js`, not the three call sites.** A fourth caller would forget, and the
third one had already diverged — `recorder.js` had its own copy of the request. A test now fails if
any module but `print.js` posts to `api/hid/print`.

**The recorder was migrated onto `printText()` rather than exempted.** Its own copy also meant a
replayed paste got `tools.httpPost`'s bare 15 s timeout instead of the long one every other print
gets, so a long replay was cut off and reported as an error. A replay's own scripted modifiers are
safe: `recorder.js` sends its key events straight to the websocket, bypassing the keypad, so
`releaseAll()` can only let go of what the USER latched on screen.

**Report, don't refuse, when kvmd says the HID is not ready.** See the table above. The harm a
refusal prevents (an optimistic message) is smaller and shorter than the harm it causes (no typing at
all, with no override) — and one is recoverable by looking at the video, the other is not recoverable
at all.

**The status line sits ABOVE the bar.** In the row there is nothing to spare at 390px — an input and
two 46px buttons — and a line that pushed them down would move the console every time something
failed. Over the video it covers no control, costs no layout, and is where the user is already
looking. `:not(:empty)` drives it rather than a second attribute: the text IS the state.

**The Text panel says it in the confirmation it already shows**, rather than in a surface invented
for it. The gap (confirmation switched off ⇒ nothing said) is a register row, not a reason to build
one.

**The mute switch was NOT moved into `printText()`.** "Mute KB/M — don't send keyboard & mouse
events" does not stop the Text panel or a replay from typing, which is a lie of the same family — but
it is a different mechanism, on a different surface, and fixing it means deciding what the Text panel
should SAY when muted. Register row, not a side effect of this phase.

---

## Surprises — the expensive ones

🔴 **The canary harness reverted the work under test. Again.** Phase 8's handoff says, in bold, to
commit before canarying because `git checkout -- <file>` restores HEAD. This session wrote a canary
script that did exactly that over an **uncommitted** `keyboard.js` and lost the whole of item 2's
implementation; it had to be re-applied from the patch script. The trap is now closed in the harness
rather than in a document: the script **refuses to mutate a file with uncommitted changes**, and
refuses to start at all unless the baseline suite is green. If you write another one, copy those two
checks first.

📏 **13 tests were measuring the failure they were written to rule out.** Every browser test of the
typing bar ran against a page with no kvmd, so the bar was reporting success for keystrokes that
could not leave — which is the exact defect this phase fixes. A green suite said nothing about it.
This is the same shape as Phase 8's "the suite was measuring the failure path": the harness's
*default* state was the broken state.

**`Hid.setState(null)` tells the keyboard nothing.** The null path resets the LEDs and the radios and
never calls `__keyboard.setState()`, so `__online` survived a disconnect. Nothing in the UI noticed,
because `__updateOnlineLeds` checks `__ws` first — the stale value was masked everywhere except in a
decision nobody was making yet.

**`node --check` accepts an ES module with `export`** in a `.js` file, so it is a real syntax gate
for this tree — worth knowing, because it is the fastest check available and there is no linter in
the loop for `web/`.

---

## The review, and what it found

Four independent lenses against the frozen SHA `d902450e` (domain correctness, security/release
surface, regression, verification quality), each with the same context block and its own brief, plus
a fifth that is not a lens: **looking at a screenshot**.

**23 findings. 18 fixed, 2 deferred with reasons, 3 were "checked and clean".** The three that
mattered most:

1. 🔴 **A muted release leaves a key held on the host and clear on screen** — found independently by
   TWO lenses, which is the strongest signal a review produces. The board clears a latch whether or
   not the key-up went anywhere, and `Mute KB/M` silences the socket: mute, then let go of anything,
   and the strip shows nothing held while the host still holds Ctrl — permanently, because
   `dropHeldKeys()` cannot let go of a key it can no longer see. **A release is now delivered
   whatever the mute switch says** (`mute.js`, read by both transports): it cannot type, click or
   move anything, and a mute that can leave a key down on someone's server is not a mute.
2. 🔴 **The magic-shortcut composer swallows modifier releases on purpose**, so `releaseAll()`
   un-latched the key on screen and left it down on the host — and, with `isCodeActive` now false,
   nothing could ever release it again. Also found by two lenses. `releaseAll()` now drops what the
   composer is holding first, by its own path.
3. 📏 **The status line covered three keys of the strip and ate their taps.** The comment said "over
   the bottom of the video, so it covers no control"; above that row there is no video, there is
   `Ctrl`, `Esc` and `Tab`. Found by looking at a PNG — no assertion in the suite could have said
   it, so one exists now, and it taps the key nearest the message to prove the message takes no tap.

The two deferrals and every other finding are in the register below.

---

## Deferred — with why

| # | Item | Why / what it needs |
|---|---|---|
| **1** | **A bar key flushing mid-chord can break a Shortcuts-menu chord.** `__emitShortcut` presses codes 100 ms apart through the keypad, so for a few hundred ms they are active on it; a queued Enter released by a completing print calls `releaseAll()` and drops `Ctrl`+`Alt` before `Del`. | Fixing it means releasing only LATCHED keys, which narrows the phase's own safety property (a momentary press during a print would then chord the text) to fix a collision that is not destructive and is visible when it happens. Two things want to type at once; the real fix is one queue for both, which is a phase of its own. |
| **2** | **A half-open websocket answers "up" for up to 15 s.** `__linkUp()` can only ask the engine, and a socket whose far side is gone with no FIN — a phone changing network — still reads `OPEN` and still accepts `send()`. Inside that window keys go nowhere while HTTP text still lands: `helo` + a correction as `helolo`, the exact corruption this phase closes elsewhere. | Bounded by `session.js`'s heartbeat at 15 missed pings. Closing it needs an ack per event, which the protocol does not have; shortening the heartbeat trades it for reconnect churn on a flaky link. |
| 3 | **"Mute KB/M" does not stop the Text panel or a replay from typing.** The switch says "don't send keyboard & mouse events"; `printText` has no mute gate, so a paste or a replayed macro types while muted. | Pre-existing, and a different mechanism from this phase's. Fixing it means deciding what the Text panel should SAY when it refuses — the same product question as the secure-mode row. |
| 4 | **With *Ask paste confirmation* off, the Text panel says nothing** when the HID is not ready: its only channel is the confirmation. | A second surface in that sheet, for a state the keyboard LED beside it already shows. |
| 5 | **A replayed print now waits ~10 min instead of erroring at 15 s** when kvmd is wedged. | Deliberate: the 15 s was `httpPost`'s bare default and cut off any long replay. It now matches the Text panel's own timeout, so both are wrong in the same direction, and Stop still works. |
| 6 | `ime.test.mjs`'s keymap test now depends on the stub's `hid_keymaps` landing before it overwrites the selector. | True today because `waitOnline` gates on it; a reconnect inside the test window would repopulate the selector and reset it to `en-us`. |

Carried from earlier phases: the plan's register, and Phase 8's items 3 and 4 — **the next phase**
(see below).


---

## The next phase, and its first step

**Phase 8's items 3 and 4, which this phase deliberately did not take** — it was re-cut to one
concern ("the typing path tells the truth") because the instrument had to be built first and a
review reads better over one concern than four.

1. **No secure mode for passwords in the bar.** The Text panel has `-webkit-text-security` and a
   confirmation; the bar has neither, the composing word stays visible until it commits, and a
   password-manager tap sends a credential with no confirmation. Nothing is persisted — no
   localStorage, no form history, the field is emptied on blur — so the exposure is live-screen and
   IME-side. **First step:** decide whether the bar's secure mode is the Text panel's existing
   `hid.pak.secure` preference applied to both fields, or its own control in the bar row; the row
   has no room at 390px, and the answer decides the markup.
2. **Window-header buttons are 40px**, under both 44pt and 48dp — Close included. Raising it grows
   every window header, which is what put keys underneath the header in Phase 6, so it is a
   deliberate change with a layout re-measurement, not a side effect.

Then the register rows above, of which #3 (Mute KB/M does not mute the Text panel) is the one that
is a lie rather than a gap.

---

## Traps — do not re-derive these

🔴 **Commit before canarying.** Phase 8's handoff says this in bold; this session broke it anyway
and lost a whole feature's implementation to `git checkout -- <file>` in its own canary script. The
script now **refuses to touch a file with uncommitted changes** and refuses to start unless the
baseline is green — copy those two checks into the next one.
📏 It is the second session in a row to lose work this way, and the first one lost it three times.

🔴 **Check `uptime` before you believe a test run.** 📏 This session's full suite was run at load
average **226** on 8 cores (another session's emulator and Gradle builds) and reported **14
failures, every one of them a 120 s timeout**, plus two fast failures that passed on their own a
minute later. `node --test` runs one process per FILE, so the suite is ~19 chromium instances at
once. On a busy machine pass `--test-concurrency=2`. A red suite on a loaded machine is not
evidence of anything.

**The typing suites need an appliance now.** `ime.test.mjs` and two tests in `layout.test.mjs` set
`server.control.session = true` and wait for `waitOnline(pg)`. Without it the bar REFUSES to type —
correctly — and every assertion about what the host received reads as "nothing arrived".

**`server.host` is the host's side of both transports, in arrival order**; `server.printed` is still
the HTTP record. Use `server.waitHost(n)` rather than a sleep — and `waitHost(0, ms)` to assert that
nothing arrived, which has to wait out the whole window.

**A live region that is `display: none` when its text is set is the pattern screen readers announce
least reliably.** `#hid-type-status` is therefore always rendered in the compact layout; only its
colours are conditional, and `:not(:empty)` is what switches them.

**`div.window` sets `white-space: nowrap` for its chrome, and a sentence inside it inherits it.**
The status line ran off both ends of the field until it was told to wrap. Nothing in the suite could
see that; a screenshot could.

**Three answers, three words.** kvmd distinguishes the whole emulator being absent (red LED,
"emulator offline") from a keyboard that is merely not accepting input (yellow, "inactive/busy"),
and the page now has a fourth state of its own: *not told yet*, which is `undefined` and says
"connecting". Anything that phrases one of these must use `__whyNotReady()`, or the bar and the LED
will disagree in front of the user.

**`make pug` needs Docker**, but `npx --yes pug-cli@1.0.0-alpha6 --pretty web/kvm/index.pug -o web/kvm`
reproduces the committed HTML byte-for-byte. Nothing in the suite checks the HTML matches the `.pug`.

---

## Deploying

Unchanged from Phase 8 — the command, the sha256 verification and the `ro` re-check are in
`MOBILE_UI_PHASE8_HANDOFF.md`. It ships a git export of `HEAD`, so uncommitted work does not deploy.
⚠ Gate it on the suite, and on `uptime` before you believe the suite.
