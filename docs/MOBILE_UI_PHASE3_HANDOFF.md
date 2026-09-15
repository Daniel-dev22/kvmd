# Mobile-first web UI — Phase 3 handoff (native typing)

**Branch:** `feat/mobile-first-ui` (fork `Daniel-dev22/kvmd`). Deployed to the kd appliance.
**Follows:** Phase 1 (foundation) and Phase 2 (one keyboard). **Not merged, not upstream.**

This is the chosen input model — **Option A, native first**.

## What it does

Tapping the typing bar raises the **phone's own keyboard**. Swipe, dictation, long-press accents and
autocorrect all work, at real typing speed, instead of hunting scancode keys.

- **Characters** go through the existing `POST api/hid/print` with the **server's** keymap — the same
  call the Text menu has always used.
- **Backspace and Enter** go out as ordinary key events on the existing socket.
- **Esc, Ctrl, Alt, Win, Shift, Tab and the four arrows** sit in a strip that stays on screen across
  every layer. A phone IME cannot produce any of them, and `Ctrl+C` in a console is not optional.
- **The full scancode board is one tap away** for a BIOS or boot menu, where no IME exists.

Those ten strip codes were **moved** out of the layers, not copied, so the compact board still carries
each of the 111 codes exactly once.

## Decisions worth not re-litigating

**The browser does not map characters to scancodes.** That would be a second copy of every keymap,
and the server already owns them. A test fails the build if a mapping table appears in `web/share/js`.

**Exactly one print request is ever in flight.** Keystrokes arrive one at a time; two overlapping
POSTs can reach the host out of order and scramble the text. Anything typed during a request is
coalesced into the next one.

**IME composition is suppressed until it ends.** ⚠ **SUPERSEDED BY PHASE 7** — this is
exactly what made the console lag a whole word behind the box, and a delete inside a composing word
reach the host as nothing. See `MOBILE_UI_PHASE7_HANDOFF.md`. Original text: An IME composes in place and fires an `input` event
for each partial guess; sending those types every intermediate guess to the host.

**The typing field is 16px.** Anything smaller makes iOS zoom the whole page the moment it is focused.

**A mid-string edit is reported as an edit at the end.** `diffTyped` compares common prefixes. That is
exact for appending and for erasing at the end. There is no correct answer for a caret edit in the
middle — the host gives us no cursor to reconcile against — so the behaviour is predictable rather
than pretending.

## Structure

- `web/share/js/kvm/typing.js` — `diffTyped()` and `makePrintQueue()`. ⚠ `makePrintQueue` no longer
  exists; Phase 7 replaced it with `makeTypingQueue()`, which carries keys as well as text. No DOM, no transport, so both
  are unit-tested directly.
- `web/share/js/kvm/print.js` — `printText()`, the `api/hid/print` call, **hoisted out of `paste.js`**.
  `paste.js` now goes through it, so a fix to one caller cannot miss the other.
- `web/share/js/kvm/keyboard.js` — wiring only.

## Tests — 119 total, 119 passing, 0 skipped

The headline is end-to-end in a real engine rather than an assertion about the source: standing in for
XHR, typing `hello` produces **exactly one** POST to `api/hid/print`, body `"hello"`, with a keymap
parameter — and **erasing a character sends no print request at all**, rather than retyping the line.

Unit coverage of the queue includes ordering across randomised bursts, coalescing, an empty push, and
a failed request not wedging the queue. `diffTyped` is covered for append, swipe/dictation (whole word
at once), erase-to-empty, an autocorrect-style correction, no-op, and non-ASCII including Japanese.

## Deployed

`ansible-playbook pikvm/deploy_web_ui.yaml -e 'server_home=kdhome'` → `ok=17, failed=0`, rootfs back
to `ro`. On-device: typing bar present, both strip rows present, `typing.js` and `print.js` served 200.

⚠ `pacman -Syu` still reverts `/usr/share/kvmd/web`.

## What is left

- **Phase 4** — sticky modifiers reachable by touch (`locked` still needs a middle mouse button, and
  the "about to latch" animation is `:hover`-gated so it never renders on a phone), tap-to-click on
  the stream, OCR touch binding.
- **Nobody has held a phone yet.** Everything is headless-Chromium measurement. The typing bar is
  exactly the thing that cannot be fully judged that way: IME behaviour, autocorrect and dictation are
  real-device concerns.
- Not merged; `upstream` push remains disabled deliberately.
