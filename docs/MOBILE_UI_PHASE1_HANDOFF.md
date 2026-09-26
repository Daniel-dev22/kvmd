# Mobile-first web UI — Phase 1 handoff

**Branch:** `feat/mobile-first-ui` on `origin` (`Daniel-dev22/kvmd`, a fork of `pikvm/kvmd`).
**Status:** built, tested, deployed to the kd appliance. Not merged, not upstream.
**Base:** v4.215.

## Why

The UI was a desktop application served to phones unchanged. The cause was structural:

- **No `<meta name="viewport">` existed anywhere in `web/`.** Phones laid the page out at their
  ~980px fallback viewport and scaled it down by ~0.4.
- **The layout was chosen once at load from a user-agent sniff**, which then injected
  `x-mobile.css` or `x-desktop.css` as a `<link>`. A 1280px tablet got the phone layout; a 390px
  desktop window got the desktop one; rotating re-resolved nothing.
- **Changing the interface style reloaded the page** (`window.location.href = window.location.href`),
  dropping the stream, the HID socket and any open form, to swap a stylesheet.
- **`is_mobile` conflated three questions:** what platform this is, how wide the viewport is, and
  whether a pointer can hover.

## What shipped

One attribute on `<html>`: `data-ui="desktop"|"mobile"`, resolved in `web/share/js/ui.js` from the
stored preference and a single media query. `base.pug` stamps it before the first paint;
`kvm/main.js` takes over the same switch, so the preference now applies live with the session
intact. The three questions are asked separately — `[data-ui]` for layout, `(pointer: coarse)` for
touch sizing, `(hover: hover)` for hover affordances. The four overlay stylesheets are folded into
the components they modify and deleted.

Also fixed: fixed widths wider than a phone are `min()`-clamped (these were not merely awkward —
`div.window` is `overflow: hidden`, so the excess was clipped and the controls inside unreachable);
`wm.js` measures `visualViewport` instead of `window.innerHeight`; press/release binding is hoisted
into `web/share/js/events.js` and **releases on `touchcancel`** (a cancelled touch previously left a
key held down *on the target host*); `--border-navbar-menu-top-thin` is now declared.

## Measured, 390px device, headless Chromium

| | before | after |
|---|---|---|
| every page | 980px of content on a 390px screen | 390px — fits |
| viewport meta | absent | present on all 5 pages |
| interface style switch | full page reload | live, session kept |
| on-screen key | — | 51.2 × 51.2px (clears the 44px minimum) |
| **widest keyboard row** | — | **741px in a 390px viewport — still clipped** |

## Tests

`testenv/jstests/`, run by `node --test`, wired in as a `jstest` tox env. **79 tests, 78 passing,
1 skipped.** No new npm dependencies; the only addition to the test image is `chromium`.

Two tiers: static assertions against the *shipped artifacts* (so editing a `.pug` and forgetting
`make pug` fails), and layout measured in headless Chromium over CDP (`browser.mjs`, driven with
node's built-in `fetch`/`WebSocket`).

Three things worth knowing, because they will bite again:

1. **`scrollWidth <= window.innerWidth` is worthless as an overflow test.** With no viewport meta the
   browser sets the layout viewport to ~980px and `innerWidth` *reports* 980 on a 390px phone, so the
   assertion passes on the broken code. Always compare against the emulated device width.
2. **The suite shares one browser.** A test that writes `page.ui.type` to localStorage changed the
   layout every later test measured. Storage is cleared per page, and tests that depend on a layout
   assert it as an explicit precondition.
3. **A missing browser used to skip the whole layout suite silently**, which reads like passing. Its
   absence now fails as a test of its own.

## Deployed to kd

`ansible-playbook pikvm/deploy_web_ui.yaml -e 'server_home=kdhome'` (branch
`feat/pikvm-web-deploy` in the ansible repo). Revert:
`… -e 'server_home=kdhome' -e 'pikvm_web_revert=true'` — **tested end to end, not assumed.**

Device: kvmd **4.213**, our tree is v4.215. Checked before deploying: the `web/` diff between them is
7 lines across 3 files with no new API calls, so the newer UI has nothing to reach for that the
older daemon lacks. Deployed files verified by sha256 against the branch.

⚠ **`pacman -Syu` on the appliance reverts `/usr/share/kvmd/web`.** Re-run the play after any
upgrade, until this is upstream.

## What is NOT done

- **The keyboard is untouched.** Still two hand-written boards (111 codes + 87 duplicated), sized in
  fixed pixels. Keys now clear 44px, but the widest row needs 741px in a 390px viewport and
  `div.window` is `overflow: hidden` — so the right-hand half is *absent*, not scrollable. This is
  Phase 2 and is asserted by a test skipped with that reason, so it stays visible.
- **Native typing (Phase 3)** — chosen input model is Option A: the phone's own IME streams through
  the existing `POST api/hid/print`, with a rail for keys an IME cannot produce.
- **Phase 4** — sticky modifiers reachable by touch, tap-to-click on the stream, OCR touch binding.
- **No on-device human check yet.** Everything above is measured in headless Chromium; nobody has
  held a phone.
- **Not upstream.** `origin` is the fork; `upstream` (pikvm/kvmd) has its push URL disabled
  deliberately.
