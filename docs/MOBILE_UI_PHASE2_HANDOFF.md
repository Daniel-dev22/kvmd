# Mobile-first web UI — Phase 2 handoff (the keyboard)

**Branch:** `feat/mobile-first-ui` (fork `Daniel-dev22/kvmd`). Deployed to the kd appliance.
**Follows:** `MOBILE_UI_PHASE1_HANDOFF.md`. **Not merged, not upstream.**

## The problem, restated precisely

`web/kvm/window-keyboard.pug` held **two hand-written boards**, and they had drifted in both ways a
duplicate can:

- **Wrong:** the mobile copy labelled `Quote` as a backtick (`` ` / ' ``); desktop had the correct `" / '`.
- **Missing:** the mobile copy was a strict subset — **24 codes** (the whole numpad, `Power`, and the
  entire Japanese block) existed only on desktop. Not awkward to reach on a phone; *unreachable*.

And the compact board's widest row needed **741px on a 390px screen**. `div.window` is
`overflow: hidden`, so that half wasn't clipped-but-scrollable — it was gone.

## What shipped

Every key is defined **once**, in `KB_KEYS`. The two arrangements reference codes only; neither
restates a label. The compact board is a **20-column grid per row**, so a row is a fraction of the
viewport by construction.

111 keys reached through five layers — **ABC / ?123 / Fn / Num / Intl** (34 / 24 / 29 / 17 / 7).

| viewport | widest row | smallest key |
|---|---|---|
| 320px | 302px | 27 × 46 |
| 390px | 372px | 34 × 46 |
| 768px | 750px | 71 × 46 |

**Desktop is byte-identical.** Verified against the pre-change compiled HTML: 111 codes, none lost,
none added, not one label changed.

`Keypad` is constructed on the whole window, so it binds both arrangements, and `__resolveKeys`
already mirrors a code to every element carrying it — modifier latch state stays in step with **no
change to `keypad.js`**. The keyboard is dismissible again: its window header is no longer hidden.

## Why two arrangements rather than one DOM tree

The original plan said "one DOM tree whose groups rearrange responsively". That is not achievable
without either per-key CSS reordering or accepting rows a phone cannot fit: a desktop number row is
14 keys, and a phone keyboard shows 10. **The defect was never DOM duplication — it was SOURCE
duplication**, which is what let the two copies disagree. One table rendered into two arrangements
removes that entirely, and a test asserts the arrangements can never disagree about a label.

Cost: the page carries 227 keypad elements instead of 208.

## Tests — 98 total, 98 passing, 0 skipped

`testenv/jstests/keyboard.test.mjs` (8 static) plus browser coverage of all five layers at **320px and
390px**. The Phase 1 skip is gone.

**Every assertion was run against master as a negative control**, and the two that matter fail there:
24 unreachable codes, and the `Quote` divergence. They are not vacuous.

Two corrections to my own tests, worth remembering:

1. **A flat pixel floor is the wrong shape** for a grid that is inherently a fraction of the screen.
   The key-width floor passed at 390px and would have failed at 320px. It is now `viewport/12` — at
   least ten keys across, which is what native keyboards give — and 320px is actually tested.
2. **`var(--x, fallback)` can never fail to resolve**, so flagging it is a false positive. The CSS
   custom-property test now checks only fallback-less references — and still catches the original
   `--border-navbar-menu-top-thin` on master.

## Deployed

`ansible-playbook pikvm/deploy_web_ui.yaml -e 'server_home=kdhome'` → `ok=17, failed=0`, rootfs back
to `ro`. On-device: `keyboard-compact` present, `keyboard-mobile` gone, the Num layer's rows present.

⚠ `pacman -Syu` still reverts `/usr/share/kvmd/web`. Re-run the play after any upgrade.

## What is next

- **Phase 3 — native typing (the chosen model, Option A).** The phone's own IME streams through the
  existing `POST api/hid/print` with the server keymap; `beforeinput` intents map to Backspace/Enter
  as normal key events; a slim rail carries what an IME cannot produce. The layered board stays one
  tap away for BIOS and boot menus. No backend change.
- **Phase 4** — sticky modifiers reachable by touch (today `locked` still needs a middle mouse
  button, and the "about to latch" animation is `:hover`-gated so it never renders on a phone),
  tap-to-click on the stream, OCR touch binding.
- **Still nobody has held a phone.** Everything above is measured in headless Chromium.
