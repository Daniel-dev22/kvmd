# Mobile-first web UI — state, and what Phase 4 must do

**Branch:** `feat/mobile-first-ui` (fork `Daniel-dev22/kvmd`, `origin`). **Deployed to kd. Not merged.**
**Read first:** `MOBILE_UI_PHASE1/2/3_HANDOFF.md`. This one supersedes their "what's next".

**127 tests, 127 passing, 0 skipped** — `node --test "testenv/jstests/*.test.mjs"`, also a `jstest` tox env.

---

## Where it stands

Shipped and verified on the device: the viewport foundation and one live layout switch (Phase 1); one
key definition with a 5-layer compact board reaching all 111 codes (Phase 2); native typing through
`api/hid/print` with the scancode board collapsing while the system keyboard is up (Phase 3).

Deploy: `ansible-playbook pikvm/deploy_web_ui.yaml -e 'server_home=kdhome'` (ansible branch
`feat/pikvm-web-deploy`). Revert with `-e 'pikvm_web_revert=true'` — tested end to end.
⚠ `pacman -Syu` on the appliance reverts `/usr/share/kvmd/web`.

---

## Phase 4 scope, in priority order

### 1. The navbar strip hides items with no cue — THE "HDMI SWITCHER VANISHES" REPORT

Measured at 390px (`node testenv/jstests/audit-menus.mjs`):

```
navbar: scrollWidth 1081 / client 390   -> 691px of items are off-screen
order:  (logo) System ATX Drive Macro Text Shortcuts GPIO Switch
```

**Nothing is missing — everything is reachable by swiping the strip.** But *Switch is last*, so it is
the furthest off-screen item, and there is **no visible affordance that the strip scrolls at all**.
That is the whole bug: discoverability, not absence.

Worth fixing together:
- A persistent overflow cue (an edge fade, or partial-item peeking) so the strip reads as scrollable.
- **Reconsider the order.** In compact, DOM order wins because `li.right`'s float is disabled.
  The desktop order puts the rarely-used items first. Switch/ATX/Drive are the operational ones.
- The four hidden left-hand items (health LEDs, stream-info) still occupy DOM positions before
  System; confirm they contribute no width when hidden.

### 2. Menu sheets overflow their own width by ~20px

At 390px, every populated menu reports `content 410 / width 390`: `system`, `msd`, `text`,
`shortcuts`, `switch`. On desktop all of them fit. `gpio` fits only because it is empty without
hardware.

**Not yet root-caused.** Every *direct* child of `#system-menu` measures exactly 390 and does not
overflow, so a nested descendant is responsible — the audit points at a `label` element +50px. Start
there; do not assume it is padding, because the menu's computed padding is `0px/0px` and
`box-sizing` is already `border-box`.

⚠ **Address menus as `ul#navbar li div.menu`, never by id.** The ATX and Macro menus have **no id**
— they are bare `.hidden.menu` elements. An id-based fix silently skips two of the ten menus, and an
id-based *test* silently reports them "missing", which is exactly what my first audit did.

### 3. Menu content is desktop-shaped

`table.kv` label/control rows, `white-space: nowrap` inherited from the desktop rule, `.tip` columns
and fixed-width `.buttons-row` classes (`row16/row25/row33/row50`). Phase 1 set `white-space: normal`
and `width: 100%` on menu tables as a holding measure; the rows still need to stack properly at phone
width rather than being squeezed into two columns.

### 4. Touch input correctness (carried from the original plan, still true)

- `locked` modifier state is unreachable by touch: `keypad.js` only upgrades to `holded`/`locked` for
  `ev.button === 1|2`, i.e. a middle or right mouse button.
- The "about to latch" animation is `:hover`-gated (`keypad.css`), so on a phone the 500 ms latch
  happens with **no visual warning at all**.
- The stream has no tap-to-click: a tap only moves the cursor. Long-press → right click, two-finger
  tap → middle click.
- `ocr.js` disables OCR whenever there is no hover; bind touch and remove the guard.

---

## Things that cost me time — do not re-derive them

**A headless page is never "focused".** `.focus()` moves `document.activeElement` but fires **no focus
event**, so every focus-driven behaviour silently does nothing under test while working in a real
browser. `browser.mjs` now enables CDP focus emulation, and `layout.test.mjs` asserts that `focus()`
actually fires — so the typing-mode tests cannot go vacuous if that ever regresses.

**`scrollWidth <= window.innerWidth` is worthless as an overflow check.** With no viewport meta the
browser sets the layout viewport to ~980px and `innerWidth` *reports* 980 on a 390px phone, so the
assertion passes on the broken code. Always compare against the emulated device width.

**Opening a window by stripping `.hidden` bypasses the window manager**, so the layout under test is
not the layout the app produces — and the dock offset is never computed. Tests click the same control
a user clicks.

**Presence is not touchability.** Two separate bugs put something *on top of* a control that measured
perfectly. There is now a hit test (a control must be the topmost element at its own centre) over the
typing bar, mouse buttons, every visible key and every layer button.

**CSS specificity beat me once:** `div.window:not(...):not(#stream-window)` outranks
`div#mouse-window:not(...)` — the first carries one more class-level selector. Matching them exactly
lets source order decide.

**Grid gaps are expensive at phone width.** A 20-column row has 19 gaps; at 4px that was 24% of a
320px screen. 3px gives letter keys 28px at 320px and 35px at 390px.

---

## Still not done

**Nobody has held a phone for most of this.** Every real-device report so far (the mouse pad covering
the typing bar; the board not making way for the system keyboard) was something headless measurement
could not have told me. Keep testing on the actual phone — that has been the highest-yield channel by
a wide margin.

Not merged to `master`; `upstream` (pikvm/kvmd) push URL is disabled deliberately. Upstream PR is a
separate, later decision.
