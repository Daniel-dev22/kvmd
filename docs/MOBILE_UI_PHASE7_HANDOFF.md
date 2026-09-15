# Mobile-first web UI — Phase 7 handoff (the typing bar is a pipe, not a mirror)

**Branch:** `feat/mobile-first-ui` (fork `Daniel-dev22/kvmd`, `origin`), worktree
`/docker_container_volumes/kvmd-mobile-first`.
**Commits:** `2524a319` (the phase), `19b63f28` (review fixes).
**Status:** committed. **NOT merged to `master`.**
**Deployed to the kd appliance at `2524a319` only** — the review fixes in `19b63f28` are **NOT on
the device**. Verify before assuming: `sha256sum` of `/usr/share/kvmd/web/share/js/kvm/typing.js`
on the appliance against the branch.
**Read first:** `MOBILE_UI_PHASE3_HANDOFF.md` (this phase REVERSES its central decision) and
`MOBILE_UI_PHASE6_HANDOFF.md`.

**278 tests, 276 passing** — `CHROMIUM=/snap/bin/chromium node --test testenv/jstests/*.test.mjs`.
The two failures (`the fn layer fits a 320px screen`, `a phone that has already chosen a zoom keeps
it`) are **load casualties**: both pass in isolation, and the full run was taken at **load average
308 on 8 cores** with a peer session's two JVM build daemons holding 8.8 GB. Neither is in this
phase's area. Re-run on a quiet machine before trusting any number here.

---

## Why this phase happened

Reported from a phone: *"if i click delete etc on android keyboard the letters dont leave that text
box making it out of sync with the console creating weird ux"*.

The bar was a **mirror buffer**: it accumulated what you typed and diffed the field against it. It
cannot be a mirror — kvmd has only video, so there is **no feedback channel** and nothing can ever
correct it. It is now a **pipe**: every edit is decoded to host commands and the field is put back.

## What shipped

### 1. An IME's characters reach the host as they are typed

Phase 3 suppressed `input` events while an IME was composing. Gboard composes **by default**, one
`insertCompositionText` per letter — so the host got **nothing** until a space committed the word,
and a delete inside the word reached it as **nothing at all**. That is the whole reported bug.

📏 Measured through Chrome's real IME path (`Input.imeSetComposition`), before → after:

| | before | after |
|---|---|---|
| composing `hello` | nothing until the word commits | `h`, `el`, `lo` (coalesced) |
| delete inside the composing word | nothing | one Backspace |
| delete on a just-reset field | nothing (Android reports no deletion on an empty field) | one Backspace |

Composition now gates only the field **reset** — never the sending.

### 2. One ordered queue for both transports

Characters go over HTTP (`api/hid/print`), keys over the websocket. A Backspace dispatched when
decoded **overtook the characters it was meant to erase**, and Enter **ran a command before the
command arrived**. Both go through `makeTypingQueue` now: a key is never dispatched while a print it
follows is in flight, consecutive text still coalesces into one request, one request in flight.

### 3. The field never accumulates

Reset after every edit to `PAD` = 8 × U+200B. The padding is not decoration: **with an empty field
Android reports no deletion at all**, so the first Backspace after every reset would vanish. Padded
on `focus`, emptied on `blur` so the placeholder can render.

### 4. The window handler stopped double-sending the bar's keys

`__keyboardHandler` is bound on the whole keyboard **window** and the bar lives inside it, so every
key pressed in the bar **also** went out as a scancode. 📏 Enter reached the host **twice**, the
immediate copy ahead of its own text; everything else was `preventDefault()`ed before it could enter
the field, which is why a hardware keyboard could never type into the bar. A character, Backspace
and Enter are the line being typed and belong to the bar; Esc, Tab, the arrows and any chord are not.

---

## What was verified, and HOW

**Measured, in a real engine.** `ime.test.mjs` (new) drives **Chrome's own IME** via CDP
`Input.imeSetComposition` and real key events through `Input.dispatchKeyEvent`, so
`compositionstart`/`compositionupdate`/`insertCompositionText` are the browser's, and Backspace
performs the editor's real default action. Assertions read **what the host received** — keys from
`tools.debug` beside the websocket write (`?debug=1`), prints from XHR filtered to `api/hid/print`.

**Assumed, NOT measured.**
- **No real phone has touched `19b63f28`.** The device has `2524a319`.
- **Nothing here is WebKit.** iOS Safari is unexercised; a lens checked the APIs and found no
  Blink-only dependency, but iOS "Slide to Type" drives exactly the composition path.
- **`Input.imeSetComposition` bypasses the field's input-method flags.** The shipped markup carries
  `autocomplete/autocorrect=off spellcheck=false`, which Chromium maps toward
  `TYPE_TEXT_FLAG_NO_SUGGESTIONS` — a Gboard that honours it **may never compose for Latin input at
  all**, making the composing path the suite exercises the *CJK* path in practice. Unresolved; the
  device can answer it.
- **The mutation/verification lens never ran** (killed by an auth failure, then the machine became
  unusable). Nobody has measured which of these tests prove nothing. That is the single biggest gap.

---

## Decisions, and the alternatives that were rejected

**A word-delete is never sent as a chord.** Ctrl+Backspace means "delete word" in a GUI field and
one character in a shell, so it is a guess about an application we cannot see — and pressing Ctrl
would release a modifier latched on the strip. It deletes what it can account for, and never
nothing. Under-deleting is undone by deleting again; over-deleting is not.

**Deletions are recognised from three sources**, in order: what the field's text lost, what the
**padding** lost, and what the `InputEvent` said. The padding matters because `inputType` was the
only thing that could answer a delete at the start of a word, so an engine that reports none — or
reports `""` — lost the first Backspace after every reset, silently. The padding is observable
everywhere.

**Padding lost *while text arrived* is a replacement, not a deletion.** This phase's own fix
introduced the opposite, and its own tests caught it: an autofill or a paste that replaces the whole
value eats the padding on the way in, and counting that as a Backspace erases a host character the
user never asked to lose.

**A failure discards what is queued behind it.** Ordering one transport behind the other makes the
queue a single point of stall; releasing a backlog minutes later types it into a screen that has
moved on, and there is no feedback channel to resynchronise against. Rejected: carrying on, which
let an Enter reach a shell holding a line the failed print never wrote.

**`Delete` was given back to the scancode path.** The bar claimed it, but the caret is pinned at the
end of the field so a forward delete changes nothing and fires no `input` event — it reached the host
by **neither** path. `decodeEdit`'s `Forward` branch is therefore unreachable from the field and is
kept only for a paste/selection path that can produce one.

**The timeout is the caller's, not a constant.** 📏 `printText` passed `7 * 24 * 3600` — seconds
written into a **milliseconds** parameter, so "a week" was **ten minutes**. A paste may legitimately
run long; an interactive keystroke that has not landed in seconds is not going to, and holds every
key behind it. Paste keeps the old value; typing gets 15 s.

---

## Surprises

📏 **The suite was measuring the failure path.** The static test server 404s everything, so **every
print in every test was a failure**. Invisible while failures were tolerated — and it started eating
characters the instant they stopped being (`hello` arrived as `hlo`). The harness now answers
`api/hid/print` and records what it received. Any past assertion about printed text was an assertion
about what was *attempted*.

**Chrome eats Ctrl+C before the page sees it.** A chord test written with Ctrl+C measures the
browser's clipboard, not this page — it does not always dispatch a keydown at all. Use Ctrl+Q.

**`api/hid/print` is LOSSY and returns 200 anyway.** `kvmd/keyboard/printer.py:86-91` does
`if not ch.isprintable(): continue` and `except Exception: continue`. Backspace is a scancode and
always lands. **The asymmetry is the most dangerous thing left in this design** — see Deferred #3.

**Three lenses independently found the same defect**: a press and its release classified
differently, leaving a key held down on the host forever. Multi-lens agreement beat everything else
again.

**The appliance runs kvmd 4.213** while this branch is based on 4.215, and the deploy ships only the
static web UI. **No Python change can reach the device this way** — which is what makes Deferred #3
a Phase 8 item rather than a fix here.

---

## Deferred — every finding not fixed, with why

| # | Item | Why |
|---|---|---|
| 1 | **The bar fails open when the HID cannot accept input.** `__online`/`hid_busy` are never consulted, a null websocket silently drops keys while HTTP text still lands (`helo` + `lo` → `helolo`), and `api/hid/print` returns 200 even when the OTG gadget is unenumerated and kvmd discards the report. The queue's refusal is implemented and unit-tested; the wiring that decides deliverability always claims success. | Answering it needs `__online` wired in **and** an instrument that can put a page with no kvmd behind it back "online" — otherwise a strictness fix ships with no test that can ever make it fire. **Phase 8, item 1.** |
| 2 | **A latched strip modifier rewrites everything the bar prints.** Tap Ctrl on the persistent strip, then type `ls` in the bar: the host receives Ctrl+L (clear) and Ctrl+S (XOFF — the terminal freezes and stays frozen). | Needs a decision that is the owner's: release latched modifiers before a print, or refuse to print while one is held and say so. Both change behaviour a desktop user relies on. |
| 3 | **print is lossy, Backspace is not.** An unmappable character is dropped server-side with a 200, then a correction's Backspaces erase real host content the user typed earlier. | The root fix is the server reporting how many characters it typed, and the appliance runs **kvmd 4.213** — a Python change does not ship with this deploy. Browser-side the blast radius is now bounded (code points, no chords, no double-counted padding). |
| 4 | **Conversion IMEs (Japanese/Chinese/Korean).** The intermediate reading is typed, then backspaced at commit, and the converted text cannot be produced by an `en-us` keymap — so nothing correct arrives and real characters are erased. | A consequence of #3, with the same fix. |
| 5 | **No secure mode.** The Text panel has `-webkit-text-security` and a confirmation; the bar has neither, the composing word is visible until commit, and a password-manager tap sends a credential to the host with no confirmation. | Product surface. Nothing is *persisted* — no localStorage, no form history, field emptied on blur — so the exposure is live-screen and IME-side. |
| 6 | **Enter via an IME reporting `keyCode 229` / `key: "Unidentified"`** may reach the host as nothing: the scancode is swallowed, `ev.key === "Enter"` is false, and `insertLineBreak` on a single-line input changes no value. | One `keydown` log line on the device answers it. Ask the phone before designing a fix. |
| 7 | **The failure signal is colour-only for 2 s** — a thin red border on a field the user is not looking at, no text, no `aria-live`, nothing for a screen reader. Fails WCAG 1.4.1. | Needs worded, persistent feedback; that is design work, and the correct wording depends on #1. |
| 8 | **`__bar_keys` is keyed on `ev.code`**, which Android reports as `""` for every soft key. | Round-trips correctly for matched pairs; no harmful sequence was constructed. The identity assumption does not hold on the platform it was written for. |
| 9 | **`__bar_keys.clear()` on blur can release a latched modifier**: an unmatched keyup then reaches `__keypad.emit(code,false)`, whose last act is `__unholdAll()`. | Narrow (a key physically held as focus leaves). Fixing it means the bar reaching into Keypad's latch state. |
| 10 | **Undo, drag-drop and multi-line paste reach the host unannounced.** A single-line `<input>` flattens newlines before the handler sees them, so a three-line snippet becomes one command; the Text panel confirms first, the bar does not. | The confirmation question is the same one as #5. |
| 11 | **The Clear button is a no-op and the placeholder is never seen** in the default flow — the field is reset after every edit, and `show_hook` focuses it (installing padding) the moment the keyboard opens. | Cosmetic, but the "×" occupies a 46px target that does nothing. |
| 12 | **No mutation sweep was run.** | Both attempts died — an auth failure, then load average 308. **Run it first in Phase 8.** |

Carried from Phase 6 and still open: the plan's register rows 1–18.

---

## Next phase — first concrete step

**Run the verification lens that never ran**, against `19b63f28`, in
`/docker_container_volumes/kvmd-review-verify` (already a separate worktree for exactly this), on a
**quiet machine** — check `uptime` first; this session saw load average 308 from a peer's JVM
builds. Weight mutations toward polarity, position, boundary and arguments, and point them at the
*claims*: composition forwarding, queue ordering, the padding, the press/release pairing.

Then Deferred #1, which is the only HIGH left that is fixable without touching kvmd's Python.

---

## Traps — do not re-derive these

**The test server 404s everything except `api/hid/print`.** If you add another API call, it fails —
and now that a failure discards the queue, that is no longer harmless.

**Chrome does not always dispatch a keydown for Ctrl+C.** Use Ctrl+Q for chord tests.

**`Input.dispatchKeyEvent` with `rawKeyDown` inserts no character** — pass `text` or the field stays
empty and every assertion about typed text becomes an assertion about nothing.

**A Backspace `rawKeyDown` does nothing while an IME composition is active** — Chrome routes it to
the IME. To simulate a delete inside a composing word, re-`compose()` the word shorter, which is what
Gboard actually does.

**`compositionend` fires BEFORE `blur` in Blink.** Do not rely on it; the other order empties the
field first.

**The padding is invisible but the field is never empty while focused**, so `placeholder` will not
render and `value.length` is never 0. Compare `value.replace(/​/gu, "")`.

**`make pug` needs Docker**, but `npx --yes pug-cli@1.0.0-alpha6 --pretty web/kvm/index.pug -o web/kvm`
reproduces the committed HTML byte-for-byte. Nothing in the suite checks the HTML still matches the
`.pug`. (This phase touched no markup.)

---

## Deploying

```
ansible-playbook pikvm/deploy_web_ui.yaml -e 'server_home=kdhome'
ansible-playbook pikvm/deploy_web_ui.yaml -e 'server_home=kdhome' -e 'pikvm_web_revert=true'
```
(ansible branch `feat/pikvm-web-deploy`, worktree `/docker_container_volumes/ansible-pikvm-web-deploy`;
`ANSIBLE_CONFIG=.../ansible_configuration/ansible.cfg`.) It ships a **git export of `pikvm_web_ref`**
(default `HEAD`), so nothing untracked rides along — and so **uncommitted fixes do not deploy**.

⚠ `pacman -Syu` on the appliance reverts `/usr/share/kvmd/web`.
