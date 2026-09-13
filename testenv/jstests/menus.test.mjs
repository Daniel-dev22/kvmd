// The navbar strip and the dropdown sheets, measured in a real engine.
//
// Two separate claims are under test here, and they fail in different ways:
//
//   1. Nothing in a menu is CLIPPED. The compact sheet is `overflow-x: hidden`,
//      so anything wider than it is not merely awkward -- it is invisible and
//      unreachable, with no scrollbar to say so.
//   2. The strip ADVERTISES that it scrolls. It is 621px wide at 390px on a
//      bare device and 1287px with a PiKVM Switch attached; every item is
//      reachable by swiping, which is worth nothing if nothing says to swipe.
//
// The modal a menu opens is measured here too -- it is a separate surface with
// its own sizing, and it fails the same way: shrink-to-fit content deciding a
// width the screen does not have.
//
// Menus are addressed as `ul#navbar li div.menu`, never by id: the ATX and
// Macro menus are bare `.hidden.menu` elements with no id at all, so an
// id-based sweep silently skips two of the ten and reports the other eight
// green.

import test, {before, after, describe} from "node:test";
import assert from "node:assert/strict";
import {serveWeb, launchBrowser, chromiumPath} from "./browser.mjs";
import {read} from "./helpers.mjs";

const WIDTHS = [320, 390];
const MIN_TARGET = 44;

// The dropdowns in the order the compact strip must show them. System first --
// it carries the link/video/keyboard/mouse LEDs, so it is the session's status
// line. Then the three a user operates mid-session, then the occasional ones.
const COMPACT_ORDER = [
	"system-dropdown",
	"switch-dropdown",
	"atx-dropdown",
	"msd-dropdown",
	"macro-dropdown",
	"text-dropdown",
	"shortcuts-dropdown",
	"gpio-dropdown",
];

let server = null;
let browser = null;

before(async () => {
	server = await serveWeb();
	browser = await launchBrowser();
});
after(async () => {
	await browser?.close();
	await server?.close();
});

// Switch and GPIO are hardware-gated, and a dev machine has neither. Revealing
// them is not enough on its own: about a second after load the app's own state
// update puts `feature-disabled` back, so anything measured after a sleep is
// measuring a strip with no Switch in it -- and passes for the wrong reason.
// Every measurement below reveals in the SAME evaluate that measures.
const REVEAL = `[...document.querySelectorAll("#navbar li")].forEach((el) => {
	el.classList.remove("feature-disabled");
});`;

async function open(width, height = 844, mobile = true) {
	const pg = await browser.newPage();
	await pg.setViewport(width, height, mobile);
	await pg.clearStorage(server.origin);
	await pg.goto(`${server.origin}/kvm/index.html`);
	return pg;
}

// An element contained by a clipping ancestor is contained ON PURPOSE -- the
// toggle switch is a 200%-wide span sliding inside an `overflow: hidden` label.
// Only boxes that escape into the sheet itself are defects.
const ESCAPES = `(menu) => {
	const clipped = (el) => {
		for (let p = el.parentElement; p && p !== menu; p = p.parentElement) {
			const s = getComputedStyle(p);
			if (/hidden|clip|auto|scroll/.test(s.overflowX + s.overflowY)) { return true; }
		}
		return false;
	};
	const cs = getComputedStyle(menu);
	const box = menu.getBoundingClientRect();
	const right = box.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
	const left = box.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
	const out = [];
	for (const el of menu.querySelectorAll("*")) {
		const b = el.getBoundingClientRect();
		if ((b.width === 0 && b.height === 0) || clipped(el)) { continue; }
		const over = Math.max(b.right - right, left - b.left);
		if (over > 0.5) {
			out.push(el.tagName.toLowerCase()
				+ (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/)[0] : "")
				+ (el.id ? "#" + el.id : "") + " +" + Math.round(over) + "px");
		}
	}
	return out;
}`;

// Words split down the middle. Counting the client rects of a RANGE OVER AN
// ELEMENT does not work: nested inline boxes (`<sup><i>long</i></sup>`) each
// contribute their own rect on one visual line, so a perfectly fine button
// reads as broken. A rect count over a single TEXT NODE containing no
// whitespace is unambiguous -- more than one line box means the WORD was split.
const BROKEN_WORDS = `(root) => {
	const out = [];
	const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let n = walk.nextNode(); n; n = walk.nextNode()) {
		const txt = n.nodeValue.trim();
		// One word, short enough that no phone should ever need to split it.
		if (!txt || /\\s/.test(txt) || txt.length > 14) { continue; }
		if (!n.parentElement || !n.parentElement.offsetParent) { continue; }
		const r = document.createRange();
		r.selectNode(n);
		const lines = r.getClientRects().length;
		if (lines > 1) { out.push(txt + " (" + lines + " lines)"); }
	}
	return out;
}`;

describe("a dropdown sheet fits the phone it is on", {"skip": chromiumPath() ? false : "no chromium available"}, () => {
	for (const width of WIDTHS) {
		test(`no sheet is wider than its own box at ${width}px`, async () => {
			const pg = await open(width);
			const bad = await pg.eval(`(() => {
				${REVEAL}
				const escapes = ${ESCAPES};
				const out = [];
				for (const menu of document.querySelectorAll("ul#navbar li div.menu")) {
					const was = menu.classList.contains("hidden");
					menu.classList.remove("hidden");
					const b = menu.getBoundingClientRect();
					const name = menu.id || ("(no id) under " + (menu.parentElement.id || menu.parentElement.className));
					if (menu.scrollWidth > Math.ceil(b.width) + 1) {
						out.push(name + ": content " + menu.scrollWidth + "px in a " + Math.round(b.width) + "px sheet");
					}
					for (const esc of escapes(menu)) {
						out.push(name + ": " + esc + " escapes the sheet");
					}
					if (was) { menu.classList.add("hidden"); }
				}
				return out;
			})()`);
			await pg.close();
			assert.deepEqual(bad, [], `clipped menu content at ${width}px:\n  ${bad.join("\n  ")}`);
		});

		test(`no control's label is painted outside it at ${width}px`, async () => {
			// A fixed 30px control height assumes the label fits on one line.
			// At phone width it does not, and the overflow is painted over the
			// button's own background rather than growing the button.
			const pg = await open(width);
			const bad = await pg.eval(`(() => {
				${REVEAL}
				const out = [];
				for (const menu of document.querySelectorAll("ul#navbar li div.menu")) {
					const was = menu.classList.contains("hidden");
					menu.classList.remove("hidden");
					for (const el of menu.querySelectorAll("button, select")) {
						const b = el.getBoundingClientRect();
						if (b.width < 1 || b.height < 1) { continue; }
						const over = el.scrollHeight - el.clientHeight;
						if (over > 1) {
							out.push((menu.id || "(no id)") + " " + el.tagName.toLowerCase()
								+ ' "' + el.textContent.trim().slice(0, 20) + '" spills ' + over + "px");
						}
					}
					if (was) { menu.classList.add("hidden"); }
				}
				return out;
			})()`);
			await pg.close();
			assert.deepEqual(bad, [], `labels painted outside their control at ${width}px:\n  ${bad.join("\n  ")}`);
		});
	}

	test("a menu table stretches to the sheet minus its own margins", async () => {
		// `width: 100%` resolves against the containing block and then adds the
		// margins outside it, which is what made every populated sheet 20px too
		// wide. The distinction only shows up on an element that HAS margins.
		const pg = await open(390);
		const m = await pg.eval(`(() => {
			${REVEAL}
			const menu = document.getElementById("system-menu");
			menu.classList.remove("hidden");
			const t = menu.querySelector("table.kv");
			const cs = getComputedStyle(t);
			return {
				sheet: Math.round(menu.getBoundingClientRect().width),
				table: Math.round(t.getBoundingClientRect().width),
				margin: Math.round(parseFloat(cs.marginLeft) + parseFloat(cs.marginRight)),
			};
		})()`);
		await pg.close();
		assert.ok(m.margin > 0, "precondition: table.kv must have horizontal margins for this to mean anything");
		assert.equal(m.table, m.sheet - m.margin,
			`a ${m.sheet}px sheet with ${m.margin}px of table margin must hold a ${m.sheet - m.margin}px table, not ${m.table}px`);
	});

	test("the paste sheet spans the viewport in compact and is capped on the desktop", async () => {
		// It used to carry `style="width: min(360px, 100vw)"`, and an inline
		// width outranks any stylesheet rule at any specificity.
		const compact = await open(390);
		const narrow = await compact.eval(`(() => {
			const m = document.getElementById("text-menu");
			m.classList.remove("hidden");
			return Math.round(m.getBoundingClientRect().width);
		})()`);
		await compact.close();
		assert.equal(narrow, 390, "the compact paste sheet must span the viewport");

		const wide = await open(1440, 900, false);
		const capped = await wide.eval(`(() => {
			const m = document.getElementById("text-menu");
			m.classList.remove("hidden");
			return Math.round(m.getBoundingClientRect().width);
		})()`);
		await wide.close();
		// 360px of sheet plus the 2px border either side. Without the cap it is
		// 376px, so a loose "under 400" bound would pass on the missing rule.
		assert.equal(capped, 364, `the desktop paste sheet must stay capped at 360px, got ${capped}px`);
	});

	for (const width of WIDTHS) {
		test(`no label is broken mid-word at ${width}px`, async () => {
			// `word-break: break-word` keeps a long value from widening the
			// sheet, and will just as happily split a short one down the middle
			// when the box it is in is too narrow: the FPS readout is pinned to
			// 40px and rendered "Unlimited" as "Unlimi/ted".
			const pg = await open(width);
			const broken = await pg.eval(`(() => {
				${REVEAL}
				const broken = ${BROKEN_WORDS};
				const out = [];
				for (const menu of document.querySelectorAll("ul#navbar li div.menu")) {
					const was = menu.classList.contains("hidden");
					menu.classList.remove("hidden");
					for (const word of broken(menu)) {
						out.push((menu.id || "(no id)") + ": " + word);
					}
					if (was) { menu.classList.add("hidden"); }
				}
				return out;
			})()`);
			await pg.close();
			assert.deepEqual(broken, [], `words broken mid-word at ${width}px:\n  ${broken.join("\n  ")}`);
		});

		test(`a full-width control fits the box it is in at ${width}px`, async () => {
			// `width: 100%` on a content-box control adds its own border on top,
			// which is how the paste textarea sat 6px outside its container.
			const pg = await open(width);
			const spilling = await pg.eval(`(() => {
				${REVEAL}
				const out = [];
				for (const menu of document.querySelectorAll("ul#navbar li div.menu")) {
					const was = menu.classList.contains("hidden");
					menu.classList.remove("hidden");
					for (const el of menu.querySelectorAll("textarea, input[type=text], select, div.radio-box")) {
						const b = el.getBoundingClientRect();
						if (b.width < 1) { continue; }
						const p = el.parentElement;
						const pb = p.getBoundingClientRect();
						const ps = getComputedStyle(p);
						const inner = pb.width
							- parseFloat(ps.paddingLeft) - parseFloat(ps.paddingRight)
							- parseFloat(ps.borderLeftWidth) - parseFloat(ps.borderRightWidth);
						if (b.width > inner + 0.5) {
							out.push((menu.id || "(no id)") + " " + el.tagName.toLowerCase() + "#" + (el.id || "?")
								+ ": " + Math.round(b.width) + "px inside " + Math.round(inner) + "px");
						}
					}
					if (was) { menu.classList.add("hidden"); }
				}
				return out;
			})()`);
			await pg.close();
			assert.deepEqual(spilling, [], `controls wider than their own container at ${width}px:\n  ${spilling.join("\n  ")}`);
		});
	}
});

// One port row as kvm/switch.js builds it: eight cells, ending in a three-button
// ATX group. The chain is rendered from the switch's own state, so there is
// nothing to measure on a machine with no switch attached -- and this is the
// surface the whole phase came from. PORT_ROW_MARKERS keeps this fixture honest:
// if switch.js stops emitting the shape below, the test says so instead of
// quietly measuring a layout the app no longer produces.
const PORT_ROW_MARKERS = ["<td>Port:</td>", "__switch-port-button-p", "__switch-atx-reset-button-p"];
const PORT_ROW = `
	<tr>
		<td>Port:</td>
		<td class="value">1</td>
		<td>&nbsp;&nbsp;</td>
		<td>
			<div class="buttons-row">
				<button><img class="inline-lamp led-gray" src="../share/svg/led-circle.svg"/></button>
				<button><img class="inline-lamp led-gray" src="../share/svg/led-gear.svg"/></button>
			</div>
		</td>
		<td>
			<span style="visibility:hidden">&#9913;</span>
			&nbsp;&nbsp;&nbsp;&nbsp;
			Host 1
			&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
		</td>
		<td style="font-size:1em">
			<button class="small"><img class="inline-lamp led-gray" src="../share/svg/led-beacon.svg"/></button>
		</td>
		<td>
			<img class="inline-lamp led-gray" src="../share/svg/led-video.svg"/>
			<img class="inline-lamp led-gray" src="../share/svg/led-usb.svg"/>
			<img class="inline-lamp led-gray" src="../share/svg/led-atx-power.svg"/>
			<img class="inline-lamp led-gray" src="../share/svg/led-atx-hdd.svg"/>
		</td>
		<td>
			<div class="buttons-row">
				<button class="small">Power <sup><i>short</i></sup></button>
				<button class="small"><sup><i>long</i></sup></button>
				<button class="small">Reset</button>
			</div>
		</td>
	</tr>`;

describe("the switch port list is readable on a phone", {"skip": chromiumPath() ? false : "no chromium available"}, () => {
	test("the fixture still matches what switch.js builds", () => {
		const src = read("web/share/js/kvm/switch.js");
		for (const marker of PORT_ROW_MARKERS) {
			assert.ok(src.includes(marker),
				`switch.js no longer contains ${marker} -- the PORT_ROW fixture below is stale and the layout it measures is not the one shipped`);
		}
	});

	for (const width of WIDTHS) {
		test(`a port row wraps rather than being squeezed at ${width}px`, async () => {
			// A table column can never be narrower than its widest unbreakable
			// word, so eight columns on a 390px phone were compressed instead:
			// "Port:" rendered as "Po rt:" and "Reset" as "Re set". Every cell
			// measured as fitting; none of it could be read.
			const pg = await open(width);
			const out = await pg.eval(`(() => {
				${REVEAL}
				const menu = document.getElementById("switch-menu");
				menu.classList.remove("hidden");
				document.getElementById("switch-chain").innerHTML = ${JSON.stringify(PORT_ROW)};
				const broken = (${BROKEN_WORDS})(document.getElementById("switch-chain"));
				const chain = document.getElementById("switch-chain");
				return {broken, escapes: (${ESCAPES})(menu).length, chainWidth: Math.round(chain.getBoundingClientRect().width)};
			})()`);
			await pg.close();
			assert.deepEqual(out.broken, [],
				`these labels were split mid-word at ${width}px: ${out.broken.join(", ")}`);
			assert.equal(out.escapes, 0, "the port row must stay inside the sheet");
		});
	}
});

describe("the compact strip says that it scrolls", {"skip": chromiumPath() ? false : "no chromium available"}, () => {
	test("every dropdown has an explicit compact order", async () => {
		// A dropdown added without one gets the initial `order: 0` and lands in
		// front of System. That is loud on screen and this names it.
		const pg = await open(390);
		const missing = await pg.eval(`(() => {
			${REVEAL}
			return [...document.querySelectorAll("ul#navbar > li[id$='-dropdown']")]
				.filter((li) => getComputedStyle(li).order === "0")
				.map((li) => li.id);
		})()`);
		await pg.close();
		assert.deepEqual(missing, [],
			`these dropdowns have no compact order and will render before System: ${missing.join(", ")}`);
	});

	test("the operational dropdowns come first", async () => {
		const pg = await open(390);
		const order = await pg.eval(`(() => {
			${REVEAL}
			return [...document.querySelectorAll("ul#navbar > li[id$='-dropdown']")]
				.sort((a, b) => Number(getComputedStyle(a).order) - Number(getComputedStyle(b).order))
				.map((li) => li.id);
		})()`);
		await pg.close();
		assert.deepEqual(order, COMPACT_ORDER,
			"the Switch is the item users reach for and DOM order puts it last; see navbar.css");
	});

	test("the Switch is on screen or peeking, never a whole screen away", async () => {
		// The report this phase came from: with a Switch attached it sat 726px
		// past the right edge of a 390px screen, behind two full swipes.
		const pg = await open(390);
		const m = await pg.eval(`(() => {
			${REVEAL}
			const li = document.getElementById("switch-dropdown");
			const b = li.getBoundingClientRect();
			return {left: Math.round(b.left), width: Math.round(b.width), inner: 390};
		})()`);
		await pg.close();
		assert.ok(m.width > 0, "precondition: the Switch item must be revealed for this to measure anything");
		assert.ok(m.left < m.inner,
			`the Switch starts at ${m.left}px on a ${m.inner}px screen -- it must at least peek past the edge`);
	});

	test("an edge cue is painted over the content the strip is hiding", async () => {
		const pg = await open(390);
		const m = await pg.eval(`(() => {
			${REVEAL}
			const nav = document.getElementById("navbar");
			const after = getComputedStyle(nav, "::after");
			const before = getComputedStyle(nav, "::before");
			return {
				scrolls: nav.scrollWidth > nav.clientWidth,
				afterImage: after.backgroundImage, afterPos: after.position, afterOpacity: after.opacity,
				beforeImage: before.backgroundImage, beforeOpacity: before.opacity,
				// A pseudo-element that ADDS width would make the strip wider
				// than its content and put a gap past the last item.
				contentWidth: nav.scrollWidth,
			};
		})()`);
		await pg.close();
		assert.ok(m.scrolls, "precondition: the strip must actually overflow for a cue to be meaningful");
		assert.match(m.afterImage, /gradient/, "the right edge has no fade over the content past it");
		assert.equal(m.afterPos, "sticky", "the cue must stay pinned to the edge while the strip scrolls");
		assert.equal(m.afterOpacity, "1", "at rest there IS content past the right edge, so the cue must be on");
		assert.match(m.beforeImage, /gradient/, "the left edge has no fade");
		assert.equal(m.beforeOpacity, "0", "at rest nothing is hidden to the left, so that cue must be off");
	});

	test("the cue tracks the scroll position where the engine can do that", async () => {
		// `scroll(self inline)` looks right and is inert here: applied to a
		// pseudo-element `self` resolves to the PSEUDO, which is not a scroll
		// container, so the timeline attaches, reports playState "running", and
		// holds currentTime null forever. Only the timeline's own activity
		// distinguishes that from a working cue.
		const pg = await open(390);
		const m = await pg.eval(`(() => {
			${REVEAL}
			const nav = document.getElementById("navbar");
			const anims = nav.getAnimations({subtree: true})
				.filter((a) => a.timeline && a.timeline.constructor.name === "ScrollTimeline");
			return {
				supported: CSS.supports("animation-timeline: scroll()"),
				count: anims.length,
				active: anims.filter((a) => a.currentTime !== null).length,
				names: anims.map((a) => a.animationName),
			};
		})()`);
		await pg.close();
		if (!m.supported) {
			// The static rules stand on their own: right cue on, left cue off,
			// which is correct at the position the strip starts in.
			assert.equal(m.count, 0, "no scroll timelines should be attached where they are unsupported");
			return;
		}
		assert.equal(m.count, 2, `both edge cues must be driven by the strip's scroll, got ${m.names.join(", ")}`);
		assert.equal(m.active, 2,
			"the scroll timeline is attached but INACTIVE -- currentTime is null, so the cue never moves");
	});
});

describe("a dialog fits the screen it opens on", {"skip": chromiumPath() ? false : "no chromium available"}, () => {
	// div.modal-window is `display: table` with `overflow: hidden`, so its
	// content sets its width and anything past the viewport is CLIPPED, not
	// scrolled. The Add-EDID dialog asked for a 350px hex box and came out
	// 382px wide, losing 62px of itself off the right of a 320px phone --
	// including part of the OK button.
	const OPEN_EDID_DIALOG = `(() => {
		[...document.querySelectorAll("#navbar li")].forEach((el) => el.classList.remove("feature-disabled"));
		document.getElementById("switch-menu").classList.remove("hidden");
		document.getElementById("switch-edid-add-button").click();
	})()`;

	for (const width of WIDTHS) {
		test(`the Add-EDID dialog stays on screen at ${width}px`, async () => {
			const pg = await open(width);
			await pg.eval(OPEN_EDID_DIALOG);
			const m = await pg.eval(`(() => {
				const win = [...document.querySelectorAll("div.modal-window")]
					.filter((el) => el.getBoundingClientRect().width > 0)[0];
				if (!win) { return null; }
				const b = win.getBoundingClientRect();
				return {left: Math.round(b.left), right: Math.round(b.right),
					width: Math.round(b.width), clipped: win.scrollWidth - win.clientWidth};
			})()`);
			await pg.close();
			assert.ok(m, "the Add-EDID dialog did not open, so nothing was measured");
			assert.ok(m.left >= 0 && m.right <= width,
				`the dialog spans ${m.left}..${m.right} on a ${width}px screen`);
			assert.ok(m.clipped <= 1, `the dialog clips ${m.clipped}px of its own content`);
		});
	}

	test("a dialog whose content is too wide is still held to the screen", async () => {
		// A NEGATIVE CONTROL. With the hex box made responsive, nothing the app
		// actually builds is over-wide any more -- so the width cap on the
		// window cannot be falsified by any real dialog, and a test over real
		// dialogs would pass just as happily with the cap deleted. This forces
		// the case the cap exists for.
		const pg = await open(320);
		await pg.eval(OPEN_EDID_DIALOG);
		const m = await pg.eval(`(() => {
			const win = [...document.querySelectorAll("div.modal-window")]
				.filter((el) => el.getBoundingClientRect().width > 0)[0];
			const wide = document.createElement("div");
			wide.style.width = "900px";
			wide.textContent = "x";
			win.querySelector("div.modal-content").appendChild(wide);
			const b = win.getBoundingClientRect();
			return {left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width)};
		})()`);
		await pg.close();
		assert.ok(m.right <= 320 && m.left >= 0,
			`a 900px child pushed the dialog to ${m.left}..${m.right} on a 320px screen -- the width cap is gone`);
	});

	test("the desktop dialog keeps its full-size hex box", async () => {
		// The phone fix must not shrink the box someone pastes 512 hex digits into.
		const pg = await open(1440, 900, false);
		await pg.eval(OPEN_EDID_DIALOG);
		const w = await pg.eval(`(() => {
			const ta = document.getElementById("__switch-edid-new-data-text");
			return ta ? Math.round(ta.getBoundingClientRect().width) : null;
		})()`);
		await pg.close();
		assert.equal(w, 350, `the desktop hex box must stay 350px, got ${w}`);
	});
});

describe("a finger can work the menus", {"skip": chromiumPath() ? false : "no chromium available"}, () => {
	test("the mouse pad buttons are not cut off", async () => {
		// The pad reuses the .keypad classes, so it was inheriting the compact
		// KEYBOARD's 20-column grid and a default `span 2`: three keys at 36px
		// with "Right" cut off by the board's `overflow: hidden`.
		const pg = await open(390);
		const keys = await pg.eval(`(() => {
			document.querySelector('[data-wm-window-show="mouse-window"]')?.click();
			return [...document.querySelectorAll("#mouse-buttons div.key")].map((el) => ({
				label: el.textContent.trim().replace(/\\s+/g, ""),
				w: Math.round(el.getBoundingClientRect().width),
				h: Math.round(el.getBoundingClientRect().height),
				cut: el.scrollWidth - el.clientWidth,
			})).filter((k) => k.w > 0);
		})()`);
		await pg.close();
		assert.ok(keys.length >= 3, `expected the three mouse buttons, got ${JSON.stringify(keys)}`);
		assert.deepEqual(keys.filter((k) => k.cut > 1), [],
			`mouse buttons with clipped labels: ${JSON.stringify(keys.filter((k) => k.cut > 1))}`);
		assert.deepEqual(keys.filter((k) => k.h < MIN_TARGET), [],
			`mouse buttons under ${MIN_TARGET}px tall: ${JSON.stringify(keys)}`);
	});

	test("a menu button is tall enough to hit", async () => {
		const pg = await open(390);
		const small = await pg.eval(`(() => {
			${REVEAL}
			const out = [];
			for (const menu of document.querySelectorAll("ul#navbar li div.menu")) {
				const was = menu.classList.contains("hidden");
				menu.classList.remove("hidden");
				for (const bt of menu.querySelectorAll("button")) {
					const b = bt.getBoundingClientRect();
					if (b.width > 0 && b.height > 0 && b.height < ${MIN_TARGET}) {
						out.push((menu.id || "(no id)") + ' "' + bt.textContent.trim().slice(0, 16) + '" ' + Math.round(b.height) + "px");
					}
				}
				if (was) { menu.classList.add("hidden"); }
			}
			return out;
		})()`);
		await pg.close();
		assert.deepEqual(small, [], `menu buttons under ${MIN_TARGET}px tall:\n  ${small.join("\n  ")}`);
	});
});
