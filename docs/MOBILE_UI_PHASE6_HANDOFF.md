# Mobile-first web UI — Phase 6 handoff (touch input correctness)

**Branch:** `feat/mobile-first-ui` (fork `Daniel-dev22/kvmd`, `origin`), worktree
`/docker_container_volumes/kvmd-mobile-first`.
**Commits:** `2148b643` (the phase), `2d533147` (review fixes), `5f769faf` (a fix found by
canarying the review fixes), `33cdb1a7` (the phone could not find the keyboard — see below).
**Status:** committed and pushed. **NOT merged to `master`. Deployed to the kd appliance on
2026-09-14** and used on a real phone, which produced the finding in §*Surprises* below.
**Read first:** `MOBILE_UI_PHASE1/2/3/5_HANDOFF.md`. (Phase 4's document describes what Phase 5
built; its title is misleading.)

**216 tests, 216 passing, 0 skipped** — `node --test testenv/jstests/*.test.mjs`, also the `jstest`
tox env, three consecutive clean runs. 16 in the new `gestures.test.mjs` (no browser), 34 in the new
`touch.test.mjs` (real touchscreen, real mouse), 12 in `events.test.mjs`.

This closes the plan's Phase 4 **except the entry pages**, which are the next phase.

---

## What shipped

### 1. A tap latches a modifier; a second tap locks it; a third releases it

`locked` was reachable only with a **middle mouse button** (`keypad.js` tested `ev.button === 1|2`)
and `holded` only by holding a finger still for 500 ms. Ctrl+Alt+Del from a phone was two blind
half-second presses.

**The cycle is for modifiers only** — `data-keypad-modifier`, a new attribute on the eight true
modifiers. Everything else keeps its momentary tap, and clearing a latch still happens in the
pre-existing release path, so "a tap turns it off" is written once and works for both devices.

📏 Verified at the wire, not as a colour: a tap on Ctrl emits `key ControlLeft down`, and Ctrl+A
emits `ControlLeft down, KeyA down, KeyA up` with no Ctrl release in between.

### 2. Four of the twelve latching keys are not modifiers

`KB_KEYS`'s `"mod": true` meant two things at once — *render the latch bullet* and *allow the 500 ms
autohold* — and it was on `PrintScreen`, `KanaMode`, `NonConvert` and `Convert`, which are keys.
Latching every bulleted key on tap would have taken the momentary tap away from all four. The
definition now says which it is: **`mod`** latches on a tap; **`hold`** can still be held by a long
press. Both render the bullet, both take `data-keypad-allow-autohold`, only `mod` takes
`data-keypad-modifier`.

📏 Attribute parity is exact: 17 codes carried `data-keypad-allow-autohold` before the split and 17
after, per-code element counts unchanged; stripping the new attribute makes the generated HTML
byte-identical to the parent apart from the OCR controls.

### 3. The latch warning is drawn to a finger — and stopped lying to a mouse

The "about to latch" animation was `:hover`-gated, so on a phone the latch arrived with nothing on
screen. **Deleting `:hover` would have been wrong**: a modifier held on a PHYSICAL keyboard reaches
`emit()`, which sets `pressed` but arms no timer, so the animation would have promised a latch that
never comes. `keypad.js` now marks the key with `holding` exactly while the promotion is armed, and
the CSS keys off that. It costs **0.025 ms per keystroke** out of 0.44 ms (222-key board, measured).

### 4. The video takes a click — and refuses when it is not sure

Tap → left. Press ≥500 ms → right. A drag still moves the cursor, two fingers still scroll.

The first cut also had a two-finger middle click and fired the right click at the 500 ms threshold.
**Both were wrong, and the review is what said so** (see *The review*). As shipped:

- **There is no two-finger middle click.** It cannot be told apart from a two-finger scroll that did
  not travel the 15 px needed to scroll — the gesture an operator makes by reflex on a video pane —
  and a middle click pastes the X11 PRIMARY selection, which at a root shell executes what it holds.
  Middle click is on the Mouse pad, where it is asked for. 📏 An 8 px two-finger tap produced
  `mouse middle down/up` on the host before this.
- **The right click is armed at 500 ms, shown on the video, and committed when the finger LIFTS**,
  inside a window that expires at 2 s. A finger resting on the screen sends nothing; moving away
  takes the offer back. The phase's own thesis, applied to the phase.
- **`ev.targetTouches`, never `ev.touches`.** `touches` is every contact on the SCREEN and a touch
  dispatches only to the element it started on, so the video was told about a thumb parked below it
  and never told when it lifted. 📏 The next ordinary tap then read as two fingers and middle-clicked.
- **No click while a menu is open** — the tap that dismisses a sheet lands on the video underneath
  it, and dismissing is not clicking. `wm.isMenuOpen()` is the one owner of that question.
- **No click while a mouse button is latched** — that is a drag in progress on the host, and
  `emit()` on an already-down button sends a RELEASE.
- **A switch**: System → Keyboard & mouse settings → *Tap the screen to click*, persisted, default
  on. The only thing that previously stopped a tap reaching the host was the HID mute, which
  disables the keyboard too.
- The button is held **50 ms**, for both buttons, because a real click has a duration and the flash
  on the on-screen button is the only acknowledgement a phone user gets.

### 5. Text recognition works without a pointer

OCR was switched off wherever `(hover: hover)` was false — a capability silently absent on every
phone rather than adapted. Selection is now bound through one drag binding that reads both devices
(`tools.el.setOnDrag`), latched to the identifier of the finger that started it, and the overlay has
**Recognize / Cancel** buttons because Enter and Escape were the only way to confirm and a phone has
neither.

Three defects the review and its canaries found in that, all of them on the DESKTOP:

- **Recognize was inert with a real mouse.** Pressing it moved focus off the overlay, whose `blur`
  handler wiped the selection and disabled the button before its own click could fire. The reset now
  asks where focus WENT (`focusout` + `relatedTarget`).
- **A release over the buttons left the drag anchored**, so every later selection was drawn from a
  corner the user chose once — silently — and that rectangle is what got recognised. A fresh press
  now always re-anchors.
- **A `disabled` control swallows the events over it** instead of passing them down, so a drag that
  ended on the greyed-out Recognize button lost its release and its whole selection.
  `pointer-events: none` on the disabled button hit-tests straight through.

And one on the phone: **the selection box was drawn 55 px below the finger**, because the
coordinates are client-space and the box is positioned inside the overlay. The Firefox-only navbar
fudge that hid this on one browser is gone, replaced by the overlay's measured origin.

---

## What was verified, and how

**Measured in a real engine** — headless Chromium over CDP, with a real touchscreen
(`Emulation.setTouchEmulationEnabled`, which also makes the page answer `pointer: coarse` and
`hover: none` like a phone), real touches (`Input.dispatchTouchEvent`) and real mouse input
(`Input.dispatchMouseEvent`). **Looked at** — screenshots of a latched Ctrl and a locked Shift, the
armed right-click cue, and the OCR overlay mid-selection.

**The assertions are about what the host receives**, read out of the page's own debug log on the
line beside the websocket write, not about the colour of a key. That change alone killed a mutation
where a tap on Ctrl sends key-**up** and 201 tests stayed green.

**Desktop is unchanged, by measurement**: menu sheet widths system 424, text 364, shortcuts 291,
macro 439 — the numbers Phase 5 recorded; the desktop keyboard renders identically under a real
mouse press, hold and release; left/right/middle clicks on a modifier still mean press/hold/lock.

### The review, and the numbers that matter

Four independent lenses against the frozen `2148b643`, then fixes, then canaries.

- 📏 **The verification lens applied 16 mutations and 11 SURVIVED** the 201-test suite — including a
  build where a phone cannot send Ctrl, OCR recognises the wrong rectangle, and OCR is switched back
  off on every phone. All ten headline survivors applied at once: **201 of 201 still green.**
- **Two lenses independently found that Recognize was dead with a real mouse**, and a third found
  the same class of defect from the other end. Multi-lens agreement again beat everything else.
- 📏 **Canarying my own review fixes: 17 mutations, 17 killed** — but only after correcting two
  *inert* mutations of my own (a middle click inserted behind a gate that already required exactly
  one finger; an event renamed where the defect had been a missing guard) and writing one test that
  did not exist. That new test then found the `disabled`-control defect, which no lens had raised.
- Nothing was dropped: every finding is fixed above, or in *Deferred* below with its reason.

---

## Surprises — the expensive ones

**The first thing a phone said about this build was that it could not find the keyboard.** Not a
gesture, not a latch: *"there is no button now to pop up android keyboard or open mouse in mobile
view"*. Both buttons were there — `• Keyboard` and `• Mouse` are the LAST row of the System sheet,
under a screenful of settings and three spoilers. 📏 On a 390×844 emulator that row lands at
**y=795**; on a real phone, whose viewport is shorter by the browser's own chrome, it is at or below
the fold, and the only way to it is scrolling a sheet nobody has a reason to scroll. In compact the
sheet now puts its actions FIRST (`order: -1`, same DOM, desktop untouched).

**This is Phase 5's change, surfaced by Phase 6's deploy**: before Phase 5 the mouse pad was forced
open on every compact load and its header carried a keyboard button, so a phone always had one of
the two on screen. Making the pad open on demand — which was right, it was eating the whole screen —
left the System sheet as the only door, and nobody checked whether that door was visible.

📏 **The test that now pins it went green against the broken layout at 390×640 on the first
attempt.** This page has no hardware behind it, so its System sheet is SHORTER than a real device's
and the buried row still fitted on screen. "It happens to fit" was the wrong property; the test
asserts the actions come BEFORE the settings, which is true at any size and with any amount of
hardware. Canaried at both sizes afterwards.

**`mod` meant two different things, and four of the keys wearing it are not modifiers.** Found by
asking what a tap on PrintScreen should do. If the tap cycle had shipped for every bulleted key, the
phone would have lost the ability to send PrintScreen, Kana, NonConvert and Convert at all.

**Simply deleting `:hover` would have made the animation lie.** The naive fix looked identical to
the correct one and was wrong in a direction nobody would have noticed for months.

**A middle click was one reflex away.** The recogniser's own comment claimed the 10 px tap slop and
the 15 px scroll step meant "a wobble too small to scroll is too big to click". They do not: they
leave 0–10 px clicking and 10–15 px dead. The comment was reasoning I had written down and not
checked, which is exactly how a rule with no measurement behind it survives.

**`ev.touches` is not "the fingers on this element".** Three lenses arrived at this from three
directions — a stray middle click, an OCR box that ends at the wrong finger, a pinch that draws a
selection. One wrong noun, three defects.

**The instrument I reached for first was silently broken.** `kvm/recorder.js` stops recording on
`setSocket(null)`, which a page with no kvmd behind it reaches **700–1200 ms after load**. Every
gesture longer than that read back as "sent nothing" — which is the answer half of these tests are
looking for. A 2.3-second test passed for free before I caught it.

**A `git checkout --` revert inside the canary loop discarded an uncommitted fix**, and the next full
run failed in a way that looked exactly like the defect the test existed to catch. Commit before
canarying, or revert from a copy.

---

## Traps — do not re-derive these

**`Input.dispatchTouchEvent` with `type: "touchEnd"` takes the points being RELEASED**, not the ones
still down; an empty list means all of them. The harness comment said the opposite.

**Touch emulation has to be enabled BEFORE navigating**, and it changes what the layout resolves to.
Any test that wants a mouse must not enable it.

**Dispatching a `MouseEvent` from inside the page runs no default action** — no focus change, no
suppression on a disabled control. Two of this phase's defects were invisible to tests written that
way, and both are on the desktop. Use `pg.mouse(...)`.

**A disabled `<button>` swallows pointer events rather than passing them down.** Anywhere a control
sits on top of a surface the user drags on, that is a hole in the surface.

**The keypad's hold timer is two mechanisms in one**: the 500 ms autohold promotion, AND the marker
that says "a press happened in this session" so the release of that same press can be ignored. The
tap-latch works because of the second one. `__startHoldTimer(el, autohold=false)` takes the marker
without the promotion.

**`tools.debug` only logs with `?debug=1`**, read once at module load, so the URL must carry it.

**The compact keyboard opens in typing mode**, with the scancode layers put away: a test that reaches
for a letter key without choosing a layer measures a 0×0 element — and a touch dispatched at a 0×0
element's "centre" lands on 0,0, which is the navbar back-link, and navigates the page away
mid-test. `centre()` refuses a zero-size target for that reason.

**`make pug` needs Docker, but `npx --yes pug-cli@1.0.0-alpha6 --pretty web/kvm/index.pug -o web/kvm`
reproduces the committed HTML byte-for-byte.** Nothing in the suite checks the HTML still matches the
`.pug`, so a `.pug`-only edit is caught by nothing — regenerate and commit both.

**`eslint` cannot run from this repo's config as written**: `testenv/linters/eslintrc.js` requires
`globals` at `/usr/lib/node_modules/globals/index.js`, a path that exists only inside the testenv
Docker image. Copy the config, patch that one path, and run eslint 9 against it.

---

## Deferred, with reasons

| Item | Why it is deferred |
|---|---|
| Dragging on the host by touch (press, move, release) is not possible | A long press is the right click, so there is no press-and-move gesture left. The pad's Left can still be latched by a long press and the stream dragged, which is the same route a mouse user has. A dedicated drag mode is product surface nobody asked for. |
| A locked modifier is invisible once the layer changes or the sheet closes | Only the four LEFT modifiers are on the persistent strip; `ShiftRight`/`MetaRight`/`AltRight` live on `sym` and `ControlRight` on `intl`. The right fix is a held-modifier indicator in the navbar, which is design work. `blur`/`visibilitychange` still clears everything. |
| The OCR controls block a 239×44 strip of the drawing surface at the bottom centre | Only the START corner is blocked — a drag can end there, and the opposite corner always works. Any overlay control has this property; hiding them on desktop would mean gating an affordance on a media query that cannot ask "does this user have a keyboard". |
| Clicks are sent while the HID emulator is offline or busy, and while the stream is offline | `__sendEvent` gates on the socket and the mute switch only; `__online` paints the LED and nothing else. Pre-existing for a mouse — this phase changes only how easily a finger reaches it. Fixing it means deciding what the LED's yellow state should forbid, which is a behaviour change for desktop too. |
| `wm.js` still drags and resizes windows with mouse-only handlers | In the compact layout windows are docked sheets that are neither dragged nor resized. It would matter for a tablet in the desktop layout. |
| `-webkit-touch-callout: none` on `#stream-box` is reasoned, not measured | It stops iOS Safari answering a long press with its own "Save Image" callout. Nothing in this suite is an iPhone. |
| Modals still have no `max-height` | Carried from Phase 5, and this phase makes it newly reachable: OCR now exists on phones, and a long `wm.error` (which passes `cancel=false`, so Escape does not dismiss it) can push OK below the fold on a 390×844 screen. |
| The handoffs name `kdhome`, `kdhomeapps.com` and local paths, on a branch pushed to a public fork | Pre-existing across Phases 1–5. Rewriting five documents and the history that carries them is a decision for the repo's owner, not a side effect of this phase. |

---

## Next phase — first concrete step

**The entry pages: `web/login/index.pug` and `web/index.pug`.** They are the last of the plan's
Phase 4 and have had no mobile work at all — the launcher is still a `<table>` layout
(`web/index.pug:12-31`), and the login page has never been measured at 320 px.

Start by measuring what they do now: `testenv/jstests/layout.test.mjs` already opens every page in
`PAGES` at 320/360/390/768 and asserts no horizontal overflow, so the foundation is there; what is
missing is touch-target and reading-order coverage for those two pages. Then decide whether the
launcher's table becomes a flex list or a grid.

⚠ **Before starting, re-read the plan's deferred register** (`~/.claude/plans/can-you-look-at-stateful-neumann.md`)
and re-run the measurement each row carries. A note is a measurement of the system when it was
written, and this phase already moved three of them.

---

## Deploying

```
ansible-playbook pikvm/deploy_web_ui.yaml -e 'server_home=kdhome'
ansible-playbook pikvm/deploy_web_ui.yaml -e 'server_home=kdhome' -e 'pikvm_web_revert=true'
```
(ansible branch `feat/pikvm-web-deploy`, worktree `/docker_container_volumes/ansible-pikvm-web-deploy`.)

The play now deploys a **git export of `pikvm_web_ref`** (default `HEAD`) rather than the working
tree, so nothing untracked can ride along — during this phase's review that checkout had four agents
reading it and one mutating files. Run end to end on 2026-09-14 (`ok=19 changed=7 failed=0`,
rootfs back to `ro`), and verified against the device rather than the exit code: **all 58 js/css/html
files on the appliance match the branch by sha256**, and nginx serves the new `gestures.js` with the
same hash.

⚠ `pacman -Syu` on the appliance reverts `/usr/share/kvmd/web`. The appliance runs **kvmd 4.213**
while this branch is based on **v4.215**; the web UI is static and served straight off disk, so
nothing is restarted and no session is interrupted, but that version gap has not been audited for
API drift.

**Real-device testing remains the highest-yield channel by a wide margin**, and this phase is the one
that most needs it: every gesture here is a judgement about what a finger MEANT, and four of the six
gestures were re-decided during review on reasoning alone. The first things to try on the phone are
the ones no measurement can settle — whether the 500 ms arm feels long or short, whether the armed
outline reads as "lift to right click", and whether tapping to click is a relief or a hazard.
