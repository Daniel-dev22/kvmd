# Mobile-first web UI — Phase 6 handoff (touch input correctness)

**Branch:** `feat/mobile-first-ui` (fork `Daniel-dev22/kvmd`, `origin`), worktree
`/docker_container_volumes/kvmd-mobile-first`.
**Commits:** `2148b643` (the phase), `2d533147` (review fixes), `5f769faf` (a fix found by
canarying them), then everything a real phone asked for: `33cdb1a7`, `af301512`, `9fad1246`,
`18776fad`, `fbbeac72`, `a1b62b0e`, `a44ccb83`, `f3bf169b`, `0a2facaf`, `58f66198`.
**Status:** committed and pushed. **NOT merged to `master`. Deployed to the kd appliance**, last at
`58f66198` on 2026-09-15, verified each time by sha256 against the branch.
**Read first:** `MOBILE_UI_PHASE1/2/3/5_HANDOFF.md`. (Phase 4's document describes what Phase 5
built; its title is misleading.)

**242 tests, 242 passing, 0 skipped** — `node --test testenv/jstests/*.test.mjs`, also the `jstest`
tox env, two consecutive clean runs. New files: `gestures.test.mjs` (no browser), `zoom.test.mjs`
(no browser), `webterm.test.mjs`, `touch.test.mjs` (real touchscreen, real mouse, real pinch).

This closes the plan's Phase 4 **except the entry pages** — and the phone took the phase well past
its original scope; see *What the phone changed* below, which is most of the work in these commits.

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

Tap → left. Press ≥500 ms → right. A drag still moves the cursor. (Two fingers scrolled the host
when this shipped; they zoom and pan the VIEW now — see *The console opens already zoomed*, and the
wheel buttons that took the scroll over.)

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

**Then it said three more things, all of them right** (`af301512`):

- *"I click mouse and it opens full on screen pikvm keyboard."* Typing mode was a **shadow of where
  focus happened to be** — set on the typing bar's `focus`, cleared 200 ms after its `blur`. Tapping
  the mouse button in the keyboard's OWN header moves focus, so the full scancode board unfolded
  over the pad that had just been asked for: 📏 the sheet went **254px → 456px** and the pad was
  left an 82px strip. Focus moving to another CONTROL is not a decision to stop typing.
  `relatedTarget` is null only when focus went *nowhere*, which is what dismissing the system
  keyboard does — and the board is welcome back then. (The same distinction as the OCR overlay's
  reset, two sections up. Twice in one phase.)
- *"Some keys are cut off at the top"*, for the keyboard, the pad and the video. A window header is
  `position: absolute`, so the window reserves its height in padding — and those were **two separate
  numbers**. The `@media (pointer: coarse)` rule grew the header from 21px to 36px for a finger and
  the padding stayed where it was. 📏 At 390×640: **14px of the video, 13px of Left/Mid/Right and
  6px of the layer picker** were painted underneath the header, where no scrolling can reach them.
  One number now — `--wm-header-h` — and the reservation is derived from it.
- *"Do we even need those positional buttons on the toolbar?"* Not all of them: a sheet docked by
  CSS cannot be restored to "original" or "maximized", so those two are hidden in compact. Full
  screen and full tab both still do something.

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
canarying, or revert from a copy. 📏 Twice more, the same family: a canary whose suite run **timed
out** never reached its restore, and one **killed from outside** stopped between mutate and restore —
both left the mutation in the working tree, where the next run reads as a regression. Put the restore
in a `finally`, and expect a loaded machine: this one was at **load 10.5 on 8 cores** with three
large processes that were not mine, and a 60-second suite took longer than a 900-second timeout.

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

## Deferred — from the phase and its review

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

The device added four more of these; they are in *Deferred — from the device*, below.

---

## What the phone changed

Everything below came from using the build on a real device, after four review lenses had finished.
None of it was found by a lens or by any headless measurement.

### The navbar is one button and a grid

Option C+D of a measured options page, chosen by the owner. 📏 The strip was **815px on a 390px
screen** with a Switch attached — 425px (52%) past the right edge, 495px (61%) at 320px, ATX (the
fourth item) starting at x=376. Seven of nine items were never seen. The bar is now identity, status
and one button; the sections are tiles in a grid, **with Keyboard and Mouse among them**. The four
global LEDs (link, video, keyboard, mouse) moved out of the System button into `#navbar-status`:
they are status, not a section, and inside it they made it the widest thing on the bar and scrolled
off with it.

152 lines of strip machinery went with it — the scroll container, the named scroll timeline, both
edge-fade pseudo-elements and the eight `order` values. Desktop is untouched, by measurement:
`#navbar-sections` is `display: contents` there, one row, no overflow, no Menu button.

Three defects found while building it, all invisible to a class-based check, all now tested:

- Every section's sheet is a **descendant of the grid container**, so hiding that container hid the
  sheets with it — choosing System opened a sheet nobody could see.
- With the tiles merely hidden, the container still stood **152px tall over the video**, invisible
  and eating every tap on it. Closed, each section is `display: contents`: no box at all.
- A tile's box was **50px** (a navbar item is one row of a desktop bar) while its content was
  **76px**, so the label painted 26px past its own border onto the tile below — reported from the
  phone as *"the text overflows the box borders at the bottom"*.

### The console opens already zoomed

This was the original request, and it took three wrong targets to hear it: *"zoom in the terminal
screen so it's readable in the box it's in"* means **the host's screen in the video on `/kvm`**, not
the web terminal. The picture is PIXELS — 1920×1080 on a 390px phone is **4.8px per character** —
so there is no font to change and no way to read it at 1×.

- **`System → Video quality settings → "Zoom the console by"`**, 100–400% in 25% steps, persisted,
  compact only. 📏 **250%**, chosen on the phone: the one number in this phase that cannot be derived
  from anything.
- The view **starts there on every load**, anchored top-left, where a console's prompt is.
- **Two fingers move the view and send nothing to the host**: pinch to zoom about the point between
  them, drag to pan. That is what the pad's Up/Down wheel buttons were restored to pay for.
- One finger is unchanged: cursor, tap-to-click, long press for right click.

The part that had to be exactly right is **where a click lands**. A tap is reported in the PICTURE's
coordinates, not the glass's: zoomed 2× from the top-left, 100px along the glass is 50px into the
host's screen. Relative drags are divided by the scale for the same reason. `kvm/zoom.js` is DOM-free
so every rule is tested without a browser — the anchor stays under the fingers, the picture can never
be panned off its own box, the scale is bounded both ways, zooming out recentres, and a smaller
viewport re-clamps a view that was already panned.

### The web terminal is scaled, not asked

`/extras/webterm/ttyd/` is a different thing from the console, and it needed a different fix. ttyd
**does** read `fontSize` off its URL — the parser is in the build on the appliance, which I checked
by pulling its page off its UNIX socket — and `18px` and then `30px` were both reported from the
phone as having no effect. A knob that cannot be verified from here is not a knob.

`transform: scale(2.25)` on the iframe needs nothing from ttyd: the terminal is laid out at half
size and drawn at twice it, so it is handed ~193px on a 390px phone, lays itself out for that, and
every pixel it draws lands twice the size. 📏 Measured: the iframe paints 386px wide inside a 390px
window with an inner viewport of 193px; ten characters measure 90px inside and 181px on screen.
The `fontSize` parameter was **removed** rather than left as a belt — if ttyd does honour it, the two
multiply.

### The launcher, and the pad's wheel

- The launcher put KVM and Terminal on one row and wrapped **Logout** onto a second, at 390 *and*
  320px. The three share a row now, down to the narrowest phone.
- Upstream ships **Up/Down wheel buttons** on the mouse pad behind an inline `display: none` — a
  desktop judgement, since a mouse has a wheel. A phone does not, and now that two fingers move the
  view, they are the host's scroll. 190×46 each in compact, still hidden on the desktop.

---

## Traps — from this session, do not re-derive these

**`zoom` does not cross into a subframe in every engine.** Both `zoom` and `transform` scale an
iframe in Blink, and `zoom` also halves the child's layout viewport there (measured: 193px inside a
386px box). But a subframe is its own rendering context and WebKit does not propagate `zoom` into
one — which is the exact shape of *"it didn't zoom"* from a phone. Use `transform` for a subframe.

**A top-level page without a viewport meta is laid out at ~980px and scaled to fit; an iframe is
not.** 📏 A ttyd-shaped page (no viewport meta) opened top-level on a 390px phone lays out at 980px
and is scaled to **0.4×** — a 15px font *looks like 6px*. The same document inside an iframe gets the
iframe's own box. That difference decides which fixes can work at all, and it is invisible unless you
measure both.

**`bindSimpleSlider` writes its default to localStorage on the FIRST load.** So raising a default in
the code reaches nobody who has already opened the page — their browser is holding the old one and
the code and the device disagree silently. A one-time migration behind a marker is what moves them;
`stream.zoom` has one, and the marker is what lets a *deliberate* choice of the old value stick.

**A canary that does not restore leaves its mutation in the working tree**, and the next run reads as
a real regression. Three ways it happened here: `git checkout --` discarding an uncommitted fix, a
suite run that **timed out** before the restore, and a run **killed from outside** between mutate and
restore. Put the restore in a `finally`, commit before canarying, and expect a loaded machine — this
one was at **load 10.5 on 8 cores** with three large processes that were not mine.

**A test that passes alone and fails in a full run is a race, not a defect.** One read the System
sheet in the frame the tap landed in; under load the layout had not settled, and *a sheet measured
mid-open is indistinguishable from one that opened where nobody can see it* — which is the defect
that test exists to catch. Wait for the thing, never for a guessed number of milliseconds.

**`Input.synthesizePinchGesture` is not evidence on every page.** It takes the launcher from scale 1
to 2.5 and does nothing at all on `/kvm` — no touch events, no scale change — even with every
handler permissive. Its silence there is an instrument limit, not a finding. The launcher control is
what proves the instrument works.

---

## Deferred — from the device

| Item | Why |
|---|---|
| The browser's own pinch still does nothing on `/kvm` | `preventDefault` is now limited to single-finger touches and `touch-action: pinch-zoom` is on the stream, and it made no difference on the device. Unexplained. It no longer matters — the console has its own zoom, which is better anyway because it survives a reload and does not zoom the chrome with it. |
| Whether ttyd honours `fontSize` from the URL on this appliance | The parser is in the shipped bundle; two attempts had no visible effect; the query has to survive kvmd's proxying, the login redirect and ttyd's websocket handshake, and none of that is observable from here. Moot now the iframe is scaled. |
| The console zoom has no reset control | Pinching back out reaches 100% and the slider sets any value, so nothing is unreachable. A "fit" button is product surface nobody has asked for. |
| Two-finger *scroll of the host* is gone from the video | Replaced by the pad's Up/Down buttons, which is what paid for pinch-to-zoom on the view. If the buttons turn out to be worse in practice, the gesture is 20 lines to restore — but then the view zoom needs another home. |

---

## Next phase — first concrete step

**The entry pages: `web/login/index.pug` and `web/index.pug`.** The launcher's app row is fixed, but
neither page has had a real mobile pass — the launcher is still a `<table>` layout and the login page
has never been measured at 320px.

Start by measuring what they do now: `layout.test.mjs` already opens every page in `PAGES` at
320/360/390/768 and asserts no horizontal overflow, so the foundation is there; what is missing is
touch-target and reading-order coverage for those two pages.

⚠ **Before starting, re-read the plan's deferred register** (`~/.claude/plans/can-you-look-at-stateful-neumann.md`)
and re-run the measurement each row carries. A note is a measurement of the system when it was
written, and this phase moved several of them.

---

## Deploying

```
ansible-playbook pikvm/deploy_web_ui.yaml -e 'server_home=kdhome'
ansible-playbook pikvm/deploy_web_ui.yaml -e 'server_home=kdhome' -e 'pikvm_web_revert=true'
```
(ansible branch `feat/pikvm-web-deploy`, worktree `/docker_container_volumes/ansible-pikvm-web-deploy`.)

The play deploys a **git export of `pikvm_web_ref`** (default `HEAD`) rather than the working tree,
so nothing untracked can ride along. Run eleven times this session; every run verified afterwards by
comparing sha256 of every `.js`/`.css`/`.html` on the appliance against the branch, and that the
rootfs went back to `ro`.

⚠ `pacman -Syu` on the appliance reverts `/usr/share/kvmd/web`. The appliance runs **kvmd 4.213**
while this branch is based on **v4.215**; the web UI is static and served straight off disk, so
nothing is restarted and no session is interrupted, but that version gap has not been audited for
API drift.

---

## The one lesson this phase is actually about

📏 **The phone found nine defects that four independent review lenses and every headless measurement
missed** — and three of them were Phase 5's, shipped and unnoticed. Two were structurally invisible
to this suite: the test page has no hardware behind it and no browser chrome, so its sheets are
shorter than a real device's and content that is buried on a phone still fits on the emulator.

Three separate times this session I fixed the wrong thing with confidence — the ttyd font when the
ask was the console, `zoom` when the engine needed `transform`, a default constant when the device
was holding a stored value. Each was a reasonable inference from evidence I had, and each was wrong
in a way only the device could show.

**Deploy early, and ask the device.** Every measurement in this document is worth less than one
person looking at a phone.
