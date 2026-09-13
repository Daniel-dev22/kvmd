# Mobile-first web UI — Phase 5 handoff (nothing clipped; a strip that fits a thumb)

**Branch:** `feat/mobile-first-ui` (fork `Daniel-dev22/kvmd`, `origin`).
**Commits:** `66b9f1e4` (the phase) and `cf715405` (review fixes + device feedback).
**Status:** committed, **deployed to kd and used on a real phone**. NOT merged to `master`.
**Read first:** `MOBILE_UI_PHASE1/2/3/4_HANDOFF.md`. This supersedes Phase 4's "what's next".

**155 tests, 155 passing, 0 skipped** — `node --test testenv/jstests/*.test.mjs`, also the `jstest`
tox env. 28 of them are in the new `testenv/jstests/menus.test.mjs`.

---

## What shipped

### 1. Every populated sheet was 20px too wide — `width: 100%` was the wrong instruction

`table.kv` carries `margin: 0 10px` (main.css). Phase 1 added `width: 100%` to menu tables as a
holding measure. A percentage resolves against the **containing block** and the element's own margins
are then added **outside** it, so a 390px sheet held a 390px table plus 20px of margin and the
sheet's `overflow-x: hidden` clipped the excess. Exactly 20px on every populated menu, which is why
it looked like padding.

`width: stretch` means "the containing block **minus my own margins**" — nests correctly, and cannot
drift if the margin changes. Three spellings, later ones winning where understood: `-moz-available`,
`-webkit-fill-available`, `stretch`. The repo already used this idiom inline on the EDID `select`.

### 2. Menu content was a desktop shape — rows now WRAP instead of being squeezed

The one that mattered. A table column can never be narrower than its widest unbreakable word, so a
row that does not fit is **compressed**, not wrapped. The switch port list is eight columns; at 390px
it "fitted" 370px by rendering `Port:` as `Po rt:`, `Host 1` as `Ho st 1` and `Reset` as `Re set`.
**Every cell measured as fitting and none of it was readable** — which is why no width assertion had
ever caught it. In compact a `table.kv` row is a flex line that wraps; a port is two legible lines.

Scoped through the direct chain `table.kv > tbody > tr > td`: the bare tables nested inside still
need real table layout. **The GPIO view is excluded** — `gpio.js` builds it from the user's own
`override.yaml` grid, where column alignment is the intent rather than a desktop artefact.

### 3. The strip hid the Switch, and then hid everything else

📏 Measured at 390px: 621px on a bare device, **1287px with a Switch attached**, Switch at x=1116 —
**726px past the right edge**, two full swipes, with nothing saying the strip scrolled.

- **Order.** The desktop lays the right-hand group out with `float: right`, which renders it in
  **reverse source order** — Switch, first in the DOM, is the item nearest the logo. Compact turns
  the float off and source order wins, which put Switch dead last. That reversal was the whole bug.
  Eight explicit `order` values pin the compact order; **only Switch moves**.
- **A fade** at whichever edge still has content beyond it, driven by a named scroll timeline.
- **Sized for a thumb.** The back-link was 138px, 35% of a 390px phone. Nothing was removed — the
  arrow and the mark both stay, the mark at 18px instead of 25px, and every item's flanks went
  14px → 8px. **Strip 1081px → 905px, back-link 138px → 98px, Switch visible 44px → 111px**, and no
  navbar item is under 44px in either dimension at 320 or 390.

### 4. The keyboard opens ready to type

The board collapses when the typing bar has focus — and that bar sat **below the whole board**, so on
a phone it was never found and the redundant letter keys ate the screen. The compact keyboard now
opens in typing mode: the phone's own keyboard, with only what it cannot send above it. Choosing a
layer leaves typing mode **at once** rather than after the 200ms blur debounce; without that the
board did not come back on the tap that asked for it, which is the whole of "one tap away".

### 5. Everything else found by measuring

| Defect | Cause |
|---|---|
| Menu buttons painted their label outside their own background | `button { height: 30px }` is a desktop row height; `• Show stream` at 130px wraps to two lines |
| Mouse pad showed `Left / Mid / ight` | the pad reuses `.keypad` classes and inherited the compact KEYBOARD's 20-column grid with a default `span 2` — 36px keys, `overflow: hidden` |
| FPS readout split as `Unlimi/ted` | `td.slider-value` pinned to `max-width: 40px` |
| Paste textarea 6px wider than its container | `width: 100%` on a content-box control adds its own border |
| Paste sheet 360px wide with a strip of stream beside it | inline `style="width: min(360px, 100vw)"` outranks any stylesheet rule |
| Add-EDID dialog lost 62px of itself, OK button included, off a 320px screen | `div.modal-window` was `display: table`, which sizes to content and **ignores `max-width`** |
| Switch separators vanished | a `<td>` holding only an `<hr>` has a max-content width of **zero** on a flex line |
| A port's `Reset` sat 8px above the NEXT port's beacon | a long host name pushed the ATX group 117px sideways |
| `Power short`(78) / `long`(35) / `Reset`(47) butted with **no gap** | a segmented row is fine for a mouse; a 5px thumb error is a hard power-off |

---

## What was verified, and how

**Measured in a real engine** (headless Chromium over CDP, emulated device metrics at 320 and 390px,
always compared against the **emulated device width**, never `window.innerWidth`). **Looked at** —
screenshots of every sheet, the port chain with an injected 4-port fixture, the navbar at three
scroll positions. The harness gained `pg.screenshot(path)` for this; the port list "fitted" by every
measurement and was still unreadable, and only the picture said so.

**Desktop is unchanged**, by measurement: sheet widths system 424, msd 454, text 364, shortcuts 291,
switch 375 — the same numbers Phase 4's audit recorded; the Add-EDID dialog still 382px with a 350px
hex box; the EDID table still fills its spoiler.

### The review, and the number that matters

Four independent lenses against a frozen SHA, then fixes, then a second canary.

- **Three of four lenses independently found the same HIGH defect** — the strongest signal a review
  produces. See *Surprises*.
- 📏 **The verification lens ran 40 mutations against my suite and 20 SURVIVED (50%)** — against my
  own canary of 14 mutations, 14 killed. Exactly the documented pattern: **the author mutates the
  lines he wrote; the lens mutates the properties he claimed.** Report the lens's number, not mine.
- All ten of its highest-value survivors are now killed, verified by re-running them.

---

## Surprises — the expensive ones

**I verified the edge cue by eye and was wrong.** `order: 1..8` on the dropdowns left
`ul#navbar::before/::after` at the initial `order: 0`, so the right-hand cue sorted into the *middle*
of the strip and painted over the PiKVM logo; the real right edge got nothing. `position: sticky;
right: 0` never shifts a box that is already inside the scrollport. A dark band near an edge looked
like a fade in a screenshot. **Painting the pseudo-elements solid red and green settled it in one
image.** When a visual claim matters, make the thing under test unmistakable rather than squinting at
it. They are now `position: fixed`, out of flex flow, where item ordering cannot reach them.

**A canary that SURVIVES may be a broken mutation, not a blind test.** My first "revert the wrapped
rows" mutation left `td { display: block }` in place, so it never restored table layout. A true
revert fails six tests. A canary that does not actually reintroduce the defect is a green light for
nothing — check what the mutated file looks like, not just that the suite stayed green.

**A negative control failed against my own fix.** `max-width` does not constrain a `display: table`
box whose content cannot shrink, so the dialog cap I first wrote did nothing at all. The control —
inject a 900px child and assert the dialog still fits — is what caught it. Every strictness fix needs
one, because the code it guards already satisfies it.

**Two of the ten menus were being swept as an empty set.** The header of `menus.test.mjs` boasts
about not addressing menus by id; it skipped two anyway, because the health sheets sit inside a
hidden **wrapper div** that the reveal never touched — and they are the only menus built from
`menu_message`'s rowspan table, the exact construct the rules claim to leave alone. Sweeps now assert
a non-empty iteration.

**A screenshot can show a transient.** One appeared to show the whole navbar stacked vertically on a
wide screen. Measuring both commits showed `display: flex` / `nowrap`, one row, in each — it was a
~250ms transient while the layout switches (`transition: all 0.25s` with `allow-discrete`). Measure
before believing a picture, and screenshot before believing a measurement; they fail differently.

---

## Traps — do not re-derive these

**`scroll(self inline)` is inert on a pseudo-element.** `self` resolves to the **pseudo**, which is
not a scroll container. The timeline attaches, reports `playState: "running"`, and holds
`currentTime: null` forever. Nothing errors and nothing moves. A NAMED timeline
(`scroll-timeline: --navbar-strip inline` on the ul) resolves by lookup through the parent. The test
asserts `currentTime !== null`, because that is the only thing that distinguishes the two.

**`animation-duration` must stay at its initial `auto` on a progress timeline.** Any finite duration
collapses the animation to a step at the range start.

**Hardware-gated items get re-disabled about a second after load.** Removing `feature-disabled` from
`#switch-dropdown` works, and then the app's own state update puts it back. Anything measured after a
sleep is measuring a strip with **no Switch in it** and passes for the wrong reason. Every test here
reveals and measures in the same `evaluate`.

**Raising a compact rule's specificity with an id can break the keyboard.** The mouse-pad fix
overrides for `#mouse-buttons` rather than re-scoping the 20-column grid rule to `#keyboard-compact`:
an id there would outrank `div#keyboard-compact div[data-keypad-layer] { display: none }` in
kvm/keyboard.css and show every keyboard layer at once.

**Counting `getClientRects()` over an ELEMENT does not detect a broken word.** Nested inline boxes
(`<sup><i>long</i></sup>`) each contribute a rect on one visual line, so a fine button reads as
broken. Count rects over a single **text node** with no whitespace in it. (Consequence: a name cell
like `&nbsp;&nbsp;Host 1&nbsp;` contains whitespace and is structurally uncoverable by that
instrument — see Deferred.)

**An inline style outranks every compact rule at any specificity.** Three defects this phase were
exactly that: the paste sheet's width, the EDID table's width, and the logo's height. When compact
needs to override something, it cannot live in a `style=` attribute.

**`make pug` needs Docker, but `npx --yes pug-cli@1.0.0-alpha6 --pretty web/kvm/index.pug -o web/kvm`
reproduces the committed HTML byte-for-byte.** Verified by regenerating with no source change and
diffing. Nothing in the suite checks the HTML still matches the `.pug`, so a `.pug`-only edit is
caught by nothing — regenerate and commit both.

**Deploy from a pristine export, not the worktree.** `pikvm/deploy_web_ui.yaml` packs
`pikvm_web_src`, which defaults to the live checkout. While review subagents were mutating files to
test them, `-e pikvm_web_src=<git archive of the SHA>/web/` is what guarantees the device gets the
reviewed commit.

---

## Deferred, with reasons

| Item | Why it is deferred |
|---|---|
| Tab/focus order still follows the DOM, so a screen reader announces Switch last while it is shown second | `order` is visual only. The triggers are non-focusable `div.menu-item`, so nothing is reachable by Tab today and there is no live mismatch. Fixing it properly means making the desktop group a flex row instead of relying on `float: right` to reverse it — a desktop change this phase deliberately avoided. |
| `PORT_ROW_MARKERS` checks three substrings, not the cell count or order | Removing `div.buttons-row` from the port ATX group in `switch.js` survives the suite: the fixture keeps measuring a layout the app no longer builds. A real guard parses the row out of the template literal. |
| The port-name cell cannot be covered by the broken-word instrument | It is one text node containing `&nbsp;` padding, and the instrument skips any node with whitespace. `Port:` and `Reset` are covered; the only **user-supplied** string on the row is not. |
| The compact sheet's `position: fixed` and `overflow-y: auto` are unverified | Both have written rationales in navbar.css and both can be reverted with the suite green. A sheet taller than `70dvh` would spill with no scroll. |
| Modals have no `max-height` | A `wm.error` with a long traceback can push OK below the fold, and `wm.error` passes `cancel=false` so Escape does not dismiss it. Pre-existing, and narrowing the dialog for phones makes the same content taller. Needs `max-height` + `overflow-y` on `.modal-content`, and testing against a real long error. |
| `browser.mjs`'s `screenshot()` has no test calling it | It is a diagnostic used from scratch scripts. Untested harness surface. |
| The `long` ATX button is still only a third of a port row | Now 6px from its neighbours and 44px tall, which removes the mis-tap hazard. Making it visually distinct from `Reset` is a design decision, not a repair. |

---

## Next phase — first concrete step

Two live requests from using it on a phone, neither started:

1. **The keyboard window should scroll.** With the board expanded on a short phone the lower rows are
   unreachable. `div.window` is `overflow: hidden`.
2. **The mouse pad should be dismissible from a button**, because with the system keyboard up the pad
   plus the sheet cover the video entirely. `#mouse-window` already has a close control; what is
   missing is a way back that does not cost a navbar slot.

Then Phase 4's item 4, still entirely open and now the largest remaining gap — **touch input
correctness**:

- `locked` modifier state is unreachable by touch — `web/share/js/keypad.js` only upgrades to
  `holded`/`locked` for `ev.button === 1|2`, i.e. a middle or right MOUSE button.
- The "about to latch" animation is `:hover`-gated in `keypad.css`, so on a phone the 500ms latch
  happens with no visual warning at all.
- The stream has no tap-to-click: a tap only moves the cursor. Long-press → right click, two-finger
  tap → middle click.
- `web/share/js/kvm/ocr.js` disables OCR whenever there is no hover; bind touch and remove the guard.

Start at `web/share/js/keypad.js` and find the `ev.button` test.

---

## Deploying

```
ansible-playbook pikvm/deploy_web_ui.yaml -e 'server_home=kdhome'
ansible-playbook pikvm/deploy_web_ui.yaml -e 'server_home=kdhome' -e 'pikvm_web_revert=true'
```
(ansible branch `feat/pikvm-web-deploy`, worktree `/docker_container_volumes/ansible-pikvm-web-deploy`.)
⚠ `pacman -Syu` on the appliance reverts `/usr/share/kvmd/web`. The appliance runs **kvmd 4.213**
while this branch is based on **v4.215**; the web UI is static and served straight off disk, so
nothing is restarted and no session is interrupted, but that version gap has not been audited for API
drift.

**Real-device testing remains the highest-yield channel by a wide margin.** Every report that changed
this phase's direction — the switcher being unreachable, the redundant letter keys eating the screen,
`Drive`/`Text`/`Shortcuts` off the edge — came from a phone, not from a measurement.
