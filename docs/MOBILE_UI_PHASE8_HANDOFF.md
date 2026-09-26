# Mobile-first web UI — Phase 8 handoff (the follower, and the compact dismissal/bounds contract)

**Branch:** `feat/mobile-first-ui` (fork `Daniel-dev22/kvmd`, `origin`), worktree
`/docker_container_volumes/kvmd-mobile-first`.
**Range:** `b45e20ae` … `31511d9d` (everything after the Phase 7 handoff at `619a35b3`).
**Status:** committed and pushed. **NOT merged to `master`. Deployed to kd at `31511d9d`**,
verified by sha256 of all 61 web files, rootfs back to `ro`.
**Read first:** `MOBILE_UI_PHASE7_HANDOFF.md`, then this.

**309 tests, 309 passing** — `CHROMIUM=/snap/bin/chromium node --test --test-timeout=120000
testenv/jstests/*.test.mjs`, ~60 s on a quiet machine. **Check `uptime` first** (see Traps).

---

## What shipped

### 1. The zoomed console follows what changes

At 250% you see a quarter of the console, anchored where the prompt was on load; a dozen lines later
the prompt has walked out of the bottom and you are typing blind. There is no feedback channel —
kvmd has only video — so nothing can be asked where the cursor is. It does not have to be: the part
that matters is the part that **changes**, and at an idle shell the only changing thing IS the
blinking cursor. Cursor-following with no OCR and nothing added to kvmd.

`follow.js` is arithmetic only (like `zoom.js` beside it); the sampler lives in `mouse.js`.
Switch: **System → Video quality settings → Keep the cursor in view**, default on, compact only.

⚠ **NOT output scrolling**, which an earlier version of the comment claimed. At 80×45 over a
1920×1080 console one sample cell ≈ one character cell, so scrolling a half-full screen changes ~50%
of them — past the repaint cap, deliberately, because a cap that admits a scroll admits a window
opening too. The view parks while output flows and picks the cursor up ~1 s after it stops.

### 2. The keyboard strip is one row that FITS

📏 At 390×420 (phone, system keyboard up) three rows of keys made the sheet **269px — 64% of the
screen** and left **62px of console**. One row: sheet **162px**, console **169px**.

The row carries the four arrows, `Ctrl`, `Esc`, `Tab`, sharing the width at ~50px. `Alt`, `Shift`,
`Win` keep their place on the board, one tap away on the button in the typing bar.

🔴 **It must FIT, not scroll.** The first cut made it a scroller and it could not be scrolled by a
finger at all: every key binds touchstart through `setOnDown`, which `preventDefault`s
(`events.js:44`), so the browser's pan never starts. 📏 Measured: a 120px drag moved `scrollLeft` by
**0** and sent **`Escape` to the host**. On a KVM a swipe that types is worse than a row that does
not scroll.

### 3. Every sheet can be dismissed, and its exit survives being scrolled

📏 Surveyed: **zero of ten** navbar sheets had a dismiss control. They closed by tapping the navbar
button again or the video behind them — neither visible.

Injected **once** in `wm.js` rather than written into eight templates across six files (a ninth would
forget), carrying `data-wm-menu-force-hide`, the mechanism that file already uses. **Sticky**, so a
scrolled sheet still shows its exit — `Shortcuts` is 134px taller than its own bound.

### 4. Fit: the whole console, and your place back

One tap shows everything; the next restores the **exact scale and position** it was taken from.
Restoring the position is the point — zooming back in by hand lands somewhere else.

Labelled **"Fit"/"Back"**, not an icon: ⤢ reads as zoom or full screen, which is what the two buttons
beside it already do.

### 5. The mouse window can be closed again

Its close button was `display: none` on a rule reading *"in compact the mouse window is the
persistent control surface: the navbar is reached from it, so it must not be closable."* True when
written; false two phases later (Phase 5 made the pad open on demand, Phase 6 made the navbar a grid).

### 6. A tap on the video costs no hold; only a drag does

The follower stands down for 4 s after a touch, because panning under a **drag** moves what the
finger maps to and the host's pointer jumps mid-drag. A **tap** moves nothing. `__touchClick` lifts
the hold — that is where "it was a tap" is already decided.

---

## What was verified, and HOW

**Measured in a real engine.** Chrome's own IME (`Input.imeSetComposition`), real touches, real key
events, a canvas standing in for the host's screen, and assertions about **what the host received**.

**Assumed, NOT measured.**
- **Nothing here is WebKit.** iOS is unexercised.
- **The emulator has no browser chrome**, so it systematically over-reports what is reachable — see
  the open question about the typing bar below.
- **The cost numbers are desktop.** A phone is several times slower.

### 📏 The mutation sweep: 24 of 27 survived (89%)

Run against `5788c8b9`. The headline was not a mutation but a **measurement**: the comment claimed
"a 1920×1080 frame downscaled to 80×45 keeps a text cursor as roughly one cell". It does not — the
downscale **point-samples**, so a feature smaller than a character cell is *absent*, not dim:

| cursor at 1920×1080 | default | `imageSmoothingQuality = "high"` |
|---|---|---|
| block 24×36 (full cell) | 60/60 | 60/60 |
| block 10×20 (box cursor) | **24/60, median delta 0** | 60/60 |
| underline 24×4 (BIOS) | **13/60, median delta 0** | 60/60 |
| bar 2×36 (GUI caret) | 7/60 | 42/60 |

The feature's central case did not work at the resolution it was built for. One line fixed it, at
0.42 → 1.58 ms per sample at 1080p.

**Why no test saw it:** none ever drew at a real resolution, and the single assertion that observed
the sampler — "translateY got more negative" — was satisfied by `zoom.js`'s **clamp** (measured at
exactly −416 against a requested −443.8). The magnitude was erased before anything observed it,
which is the mechanism behind nearly every survivor. All but one are now killed; the last is
`__recordPrintEvent`, blocked by the recorder stopping ~1 s after load on a page with no kvmd.

---

## Decisions, and the alternatives rejected

**Follow the CHANGING region, not the cursor.** No OCR, no host knowledge, no kvmd change; the idle
case gives cursor-following for free.

**The trailing edge wins** when a region is too big for the band — that is where a cursor sits on its
line and where new output appears.

**Two things changing at once are not followed.** A caret plus a clock share a bounding box spanning
the screen while changing a handful of cells; the trailing-edge rule chased the *clock*. A density
floor says: when you cannot tell which one the user is looking at, stay put.

**No animation on the view.** `__zoom` holds the destination the instant `pan()` returns and every
tap mapping reads it, so animating means a tap during those frames goes where the view is *going* —
48 picture px of error at 2.5×, on the surface that presses buttons on someone else's server.

**The strip FITS rather than scrolls** — see above. Keeping all ten keys would have left three past
an edge that cannot be scrolled to: unreachable, not merely further away.

**`containFit` was hoisted into `zoom.js`** and `stream.js:getGeometry` migrated onto it. The
follower measures the **element it sampled**, not the streamer's reported resolution — the only
source that cannot disagree with the bitmap drawn, and it answers before the streamer reports
anything.

---

## Surprises — the expensive ones

🔴 **The follower could not see a real cursor.** See the sweep table. Shipped and deployed before it
was found.

🔴 **The follower measured the box, and the picture is not the box.** `drawImage` samples the source
bitmap; `object-fit: contain` letterboxes it inside the element. In a full-tab window on a phone,
1920×1080 in 390×844 renders 390×219 with **312px of black** above and below — the error is ±780px
and **at the top of the picture it panned the wrong way**. On iPhone that path is one tap away
(`requestFullscreen` is absent, so the full-screen button *is* full-tab). Every other box↔picture
mapping in the tree already went through the letterbox; this was the only one that did not.

📏 **A published measurement was wrong.** "0.05 ms per sample" was taken against a small **static**
source, so it timed the readback and never the downscale — the part that scales with source area.
Real: **0.424 ms** at 1080p, ~8×.

📏 **Three orphaned `node --test` runs, 19 hours old**, from this suite, holding 111 chromium
processes and 5.5 GB with swap exhausted. That is the true explanation for a "load average 308" run
that took 324 s and failed two tests I had written off as bad luck. `node --test` defaults to **no
timeout**; `tox.ini` now passes `--test-timeout=120000`.

**The suite was measuring the failure path.** The static test server 404s everything, so **every
print in every test was a failure** — invisible while failures were tolerated, and it began eating
characters the moment they stopped being (`hello` arrived as `hlo`).

---

## Deferred — with why. **The next phase is the first four.**

| # | Item | Why / what it needs |
|---|---|---|
| **1** | 🔴 **A latched strip modifier silently corrupts everything you type.** Tap `Ctrl` (a tap LATCHES since Phase 6), type `ls`: the host gets **Ctrl+L** (clear) and **Ctrl+S** (XOFF — the terminal freezes until Ctrl+Q). Phase 8 made this *more* reachable: Ctrl is now one of seven keys beside the bar. | A decision the owner must make: release latched modifiers before a print, or refuse to print while one is held and say so. Both change desktop behaviour. |
| **2** | 🔴 **The bar reports success when the HID cannot deliver.** `__online`/`hid_busy` are never consulted, a null websocket drops keys while HTTP text still lands, and `api/hid/print` returns **200** even when the OTG gadget is unenumerated and kvmd discards the report. | The queue's refusal is implemented and unit-tested; the wiring always claims success. Needs `__online` **and** an instrument that can put a kvmd-less page back "online", or the refusal ships with no test that can make it fire. |
| **3** | **No secure mode for passwords.** The Text panel has `-webkit-text-security` and a confirmation; the bar has neither, the composing word stays visible until commit, and a password-manager tap sends a credential with no confirmation. | Product surface. Nothing is persisted — no localStorage, no form history, field emptied on blur — so the exposure is live-screen and IME-side. |
| **4** | **Window-header buttons are 40px**, under both 44pt and 48dp — Close included. | Raising it grows every window header, which is what put keys underneath the header in Phase 6. Deliberate change, not a side effect. |
| 5 | `api/hid/print` is lossy and returns 200 anyway (`printer.py:86-91`). | Root fix is server-side; the appliance runs **kvmd 4.213** and this deploy ships only static web files. |
| 6 | Conversion IMEs (JA/ZH/KO) type the reading, then erase it. | Consequence of 5. |
| 7 | Follower: **`visibilitychange` and the `<video>`/Janus path have no coverage**; `__follow_broken` latches for the session with no recovery. | Janus needs a real WebRTC element the harness cannot produce. |
| 8 | `__recordPrintEvent` is unobserved — the only sweep survivor left. | `recorder.js` stops recording ~1 s after load on a page with no kvmd. Same instrument gap as 2. |
| 9 | `__bar_keys` is keyed on `ev.code`, which Android reports as `""`. | Round-trips for matched pairs; no harmful sequence constructed. |
| 10 | Undo, drag-drop and multi-line paste reach the host unannounced; a single-line `<input>` flattens newlines. | Same confirmation question as 3. |
| 11 | `audit-menus.mjs:16` hard-codes an absolute path into this private worktree. | Broken in any clone, leaks layout, and invisible because the filename avoids `*.test.mjs`. |

Carried from earlier phases: the plan's register rows 1–18.

### Four questions only the device can answer

1. **Is the typing bar under the browser's toolbar when the full board is up?** It measures
   reachable at **645..691 of 700** — the last 10px — and the emulator has no browser chrome.
2. **Is `Drive` clipped with no scrollbar, or does it ignore a drag?** Different bugs. Drive renders
   at zero height without a backend, so the sheet actually reported is invisible here.
3. **What shifts the console when a menu opens?** Not reproduced: the stream box did not resize and
   the transform did not change.
4. **Does Enter work from the phone's own Enter key?** Some IMEs report `keyCode 229`, which would
   reach the host as nothing.

---

## Traps — do not re-derive these

🔴 **Commit before canarying, and restore from a COPY.** A canary loop whose restore runs
`git checkout -- <dir>` reverts the **uncommitted work it is testing**. This happened **three times**
in one session, once reverting the very fix under test. Mutate by **line number**, assert the line
says what you think, and **check the baseline test count inside the loop** — a harness that silently
fails to mutate still prints a confident `SURVIVED`.

🔴 **`\(` and `\s` inside a JS template literal lose a level of escaping.** Written singly, a regex
becomes a capturing group and a literal `s`, matches nothing, and reads 0 forever. It made a test
fail and its **negative control pass**, both for the same wrong reason. Hit twice. Same trap in CSS:
`content: "\\2922"` shipped and painted the literal text `\2922` on a button.

**`wm.js` dismisses menus from a window-level `mouseup`/`touchend` handler, and DEFERS it** through a
`setTimeout`. A test that dispatches `click`, or that checks synchronously, reads every sheet as
broken.

**Touch emulation must be on BEFORE navigating**, and it changes what the layout resolves to:
`pointer: coarse` grows the window header 21px → 36px. 📏 A sheet measured without it is ~15px
shorter than on a phone — enough that a 42px regression slipped under a height assertion by 4px.

**The test server answers `api/hid/print` and nothing else.** It can be made slow and can be made to
fail (`server.control.printDelayMs`, `server.control.printStatus`) — necessary, because an instant
success makes "in flight" sub-millisecond and every ordering claim unobservable.

**A cursor at the bottom of the picture is decided by `zoom.js`'s clamp**, not by the follower's
arithmetic — a test placed there cannot tell a correct mapping from a broken one.

**`make pug` needs Docker**, but `npx --yes pug-cli@1.0.0-alpha6 --pretty web/kvm/index.pug -o web/kvm`
reproduces the committed HTML byte-for-byte. Nothing in the suite checks the HTML matches the `.pug`.

---

## Deploying

```
ANSIBLE_CONFIG=/docker_container_volumes/ansible-pikvm-web-deploy/ansible_configuration/ansible.cfg \
  ansible-playbook /docker_container_volumes/ansible-pikvm-web-deploy/pikvm/deploy_web_ui.yaml -e 'server_home=kdhome'
```
It ships a **git export of `HEAD`**, so uncommitted work does not deploy. Verify afterwards by
sha256 of every `.js`/`.css`/`.html` against the branch, and that the rootfs went back to `ro`.
⚠ Gate the deploy on the suite — this session shipped once with three tests red by chaining them.
⚠ `pacman -Syu` on the appliance reverts `/usr/share/kvmd/web`.
