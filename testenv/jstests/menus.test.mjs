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

// The hw-health and fan-health sheets are not inside an <li> that REVEAL
// reaches -- they sit in a `div.hidden` WRAPPER (index.html: #hw-health-dropdown,
// #fan-health-dropdown), so stripping .hidden from the menu alone left them
// display:none and every sweep measured them as an empty set. They are also the
// only two menus built from menu_message's rowspan icon table, which is exactly
// the construct the compact rules claim to leave alone. Sweeps use this; the
// navbar geometry tests must NOT, because revealing the full-tab window buttons
// would move every item and stop describing the strip a real device shows.
const REVEAL_ALL = REVEAL + `[...document.querySelectorAll("#navbar > div.hidden")].forEach((el) => {
	el.classList.remove("hidden");
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
				${REVEAL_ALL}
				const escapes = ${ESCAPES};
				const out = [];
				let measured = 0;
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
					if (b.width > 0 && menu.querySelectorAll("*").length > 0) { measured += 1; }
					if (was) { menu.classList.add("hidden"); }
				}
				return {out, measured};
			})()`);
			await pg.close();
			// A sweep over sheets that never became visible reports nothing wrong
			// and proves nothing. Two of the ten used to do exactly that.
			assert.ok(bad.measured >= 8,
				`only ${bad.measured} menus were actually measured -- the rest were invisible, so this assertion is vacuous`);
			assert.deepEqual(bad.out, [], `clipped menu content at ${width}px:\n  ${bad.out.join("\n  ")}`);
		});

		test(`no control's label is painted outside it at ${width}px`, async () => {
			// A fixed 30px control height assumes the label fits on one line.
			// At phone width it does not, and the overflow is painted over the
			// button's own background rather than growing the button.
			const pg = await open(width);
			const bad = await pg.eval(`(() => {
				${REVEAL_ALL}
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

	for (const width of WIDTHS) {
		test(`no text is clipped inside its own box at ${width}px`, async () => {
			// A cell with `overflow: hidden` and a width too small for its text
			// silently truncates it. That is not a broken word (one line box)
			// and not an escape (the box fits the sheet) -- it needs its own
			// check: the FPS readout was pinned to 40px and rendered "Unlimi".
			const pg = await open(width);
			const clipped = await pg.eval(`(() => {
				${REVEAL_ALL}
				const out = [];
				for (const menu of document.querySelectorAll("ul#navbar li div.menu")) {
					const was = menu.classList.contains("hidden");
					menu.classList.remove("hidden");
					for (const el of menu.querySelectorAll("td, span, div")) {
						const cs = getComputedStyle(el);
						if (!/hidden|clip/.test(cs.overflowX)) { continue; }
						const b = el.getBoundingClientRect();
						if (b.width < 1 || el.children.length > 0) { continue; }
						if (el.scrollWidth > el.clientWidth + 1) {
							out.push((menu.id || "(no id)") + ' "' + el.textContent.trim().slice(0, 18)
								+ '" needs ' + el.scrollWidth + "px in " + el.clientWidth + "px");
						}
					}
					if (was) { menu.classList.add("hidden"); }
				}
				return out;
			})()`);
			await pg.close();
			assert.deepEqual(clipped, [], `text truncated inside its own box at ${width}px:\n  ${clipped.join("\n  ")}`);
		});
	}

	test("a spacer cell that holds a desktop column open is not rendered", async () => {
		// Those cells carry `width: 100%`, so on a wrapped line one would take a
		// whole row to show nothing.
		const pg = await open(390);
		const m = await pg.eval(`(() => {
			${REVEAL_ALL}
			let total = 0;
			let rendered = 0;
			for (const menu of document.querySelectorAll("ul#navbar li div.menu")) {
				const was = menu.classList.contains("hidden");
				menu.classList.remove("hidden");
				for (const td of menu.querySelectorAll("table.kv > tbody > tr > td")) {
					if (td.childNodes.length > 0) { continue; }
					total += 1;
					if (td.getBoundingClientRect().width > 0) { rendered += 1; }
				}
				if (was) { menu.classList.add("hidden"); }
			}
			return {total, rendered};
		})()`);
		await pg.close();
		assert.ok(m.total > 0, "precondition: there must be empty spacer cells for this to mean anything");
		assert.equal(m.rendered, 0, `${m.rendered} of ${m.total} empty spacer cells still take space on a wrapped line`);
	});

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
				${REVEAL_ALL}
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
				${REVEAL_ALL}
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
				const row = chain.querySelector("tr");
				const lines = new Set([...row.children]
					.filter((td) => td.getBoundingClientRect().width > 0)
					.map((td) => Math.round(td.getBoundingClientRect().top))).size;
				return {broken, lines, escapes: (${ESCAPES})(menu).length};
			})()`);
			await pg.close();
			assert.deepEqual(out.broken, [],
				`these labels were split mid-word at ${width}px: ${out.broken.join(", ")}`);
			assert.equal(out.escapes, 0, "the port row must stay inside the sheet");
			// Wrapping is the point: stacking every cell on its own line makes a
			// port EIGHT lines tall, which passes every other assertion here.
			// Two lines at 390px, up to four at 320px. Stacking every cell on its
			// own line is eight, which is what this rules out.
			assert.ok(out.lines >= 2 && out.lines <= 5,
				`a port row occupies ${out.lines} lines -- it should wrap, not stack every cell on its own line`);
		});
	}
});

describe("the sections are a grid behind one button", {"skip": chromiumPath() ? false : "no chromium available"}, () => {
	// 📏 What this replaces: the same items as one horizontally scrollable
	// strip. With a Switch attached it measured 815px on a 390px screen --
	// 425px (52%) past the right edge, 495px (61%) at 320px -- and ATX, the
	// fourth item, started at x=376. Seven of nine were never seen.
	//
	// Every hardware-gated item is revealed in the SAME evaluate that measures,
	// because the app puts the gate back about a second after load and a strip
	// with no Switch in it passes for the wrong reason.
	// A statement, so it can be pasted into a larger evaluate as well as run on
	// its own -- slicing an IIFE apart to reuse its body produces a syntax error
	// that CDP reports only as "Invalid parameters".
	const REVEAL_JS = `for (const id of ["switch-dropdown", "gpio-dropdown", "msd-dropdown", "atx-dropdown"]) {
		const el = document.getElementById(id);
		if (el !== null) { el.classList.remove("feature-disabled"); }
	}`;
	const REVEAL = `(() => { ${REVEAL_JS} return true; })()`;

	const openGrid = async (pg) => {
		const at = await pg.eval(`(() => {
			const r = document.getElementById("navbar-menu-button").getBoundingClientRect();
			if (r.width === 0) { throw new Error("the Menu button is not on screen"); }
			return {"x": r.left + r.width / 2, "y": r.top + r.height / 2};
		})()`);
		await pg.touch("touchStart", [at]);
		await pg.touch("touchEnd", []);
	};

	for (const width of [320, 360, 390]) {
		test(`the bar itself fits at ${width}px, with everything attached`, async () => {
			const pg = await open(width);
			const m = await pg.eval(`(() => {
				${REVEAL_JS}
				const nav = document.getElementById("navbar");
				return {
					"strip": nav.scrollWidth,
					"client": nav.clientWidth,
					"doc": document.documentElement.scrollWidth,
					"menuButton": !!document.getElementById("navbar-menu-button"),
				};
			})()`);
			await pg.close();
			assert.equal(m.menuButton, true, "the compact layout has no Menu button");
			assert.ok(m.strip <= m.client,
				`the bar needs ${m.strip}px of a ${m.client}px screen -- it is a strip again`);
			assert.ok(m.doc <= width, `the page is ${m.doc}px wide on a ${width}px device`);
		});
	}

	test("the grid holds every section, plus the keyboard and the mouse", async () => {
		const pg = await open(390);
		await pg.eval(REVEAL);
		await openGrid(pg);
		const m = await pg.eval(`(() => {
			${REVEAL_JS}
			const tiles = [...document.querySelectorAll("#navbar-sections > li")]
				.filter((li) => li.getBoundingClientRect().height > 0)
				.map(function(li) {
					const r = li.getBoundingClientRect();
					const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
					return {
						"id": li.id || li.className,
						"w": Math.round(r.width), "h": Math.round(r.height),
						"onscreen": (r.bottom <= window.innerHeight && r.top >= 0),
						"tappable": li.contains(top),
					};
				});
			return tiles;
		})()`);
		await pg.close();
		const want = ["keyboard-section", "mouse-section", "system-dropdown", "atx-dropdown",
			"msd-dropdown", "macro-dropdown", "text-dropdown", "shortcuts-dropdown",
			"gpio-dropdown", "switch-dropdown"];
		assert.deepEqual(m.map((t) => t.id).sort(), [...want].sort(),
			"the grid does not offer exactly the sections this UI has");
		for (const tile of m) {
			assert.ok(tile.w >= MIN_TARGET && tile.h >= MIN_TARGET,
				`${tile.id} is ${tile.w}x${tile.h}`);
			assert.equal(tile.onscreen, true, `${tile.id} is off the screen`);
			assert.equal(tile.tappable, true, `${tile.id} is covered by something else`);
		}
	});

	for (const width of [320, 390]) {
		test(`no tile paints outside its own box at ${width}px`, async () => {
			// A navbar item is 50px tall because a desktop navbar is one row of
			// them. A tile is a column -- icon over label, and the label wraps
			// -- which needs 76px, and the 50px box did not clip it: it painted
			// past its own border, over the tile below. Reported from a phone
			// as "the text overflows the box borders at the bottom".
			const pg = await open(width);
			await pg.eval(REVEAL);
			await openGrid(pg);
			const over = await pg.eval(`(() => {
				const out = [];
				for (const li of document.querySelectorAll("#navbar-sections > li")) {
					const item = li.querySelector(".menu-item");
					if (item === null || item.getBoundingClientRect().height === 0) { continue; }
					const box = li.getBoundingClientRect();
					const content = item.getBoundingClientRect();
					const spill = Math.round(Math.max(
						content.bottom - box.bottom,
						box.top - content.top,
						item.scrollHeight - Math.round(content.height)));
					if (spill > 0) {
						out.push({"id": li.id, spill, "box": Math.round(box.height),
							"content": item.scrollHeight});
					}
				}
				return out;
			})()`);
			await pg.close();
			assert.deepEqual(over, [],
				`${width}px: tiles whose content is taller than the tile it is in`);
		});
	}

	test("choosing a section shows its sheet and puts the grid away", async () => {
		const pg = await open(390);
		await openGrid(pg);
		const at = await pg.eval(`(() => {
			const r = document.querySelector("#system-dropdown .menu-button").getBoundingClientRect();
			return {"x": r.left + r.width / 2, "y": r.top + r.height / 2};
		})()`);
		await pg.touch("touchStart", [at]);
		await pg.touch("touchEnd", []);
		const m = await pg.eval(`(() => {
			const sheet = document.getElementById("system-menu").getBoundingClientRect();
			return {
				"gridOpen": document.getElementById("navbar").classList.contains("navbar-sections-open"),
				"sheetW": Math.round(sheet.width), "sheetH": Math.round(sheet.height),
			};
		})()`);
		await pg.close();
		assert.equal(m.gridOpen, false, "the grid stayed open behind the sheet it opened");
		// Not the class: every section's sheet is a DESCENDANT of the grid
		// container, and hiding that container hid the sheets with it.
		assert.ok(m.sheetW > 100 && m.sheetH > 100,
			`the System sheet measured ${m.sheetW}x${m.sheetH}: it opened where nobody can see it`);
	});

	test("with the grid shut, nothing of it is left over the video", async () => {
		// It is absolutely positioned over the stream: a container with height
		// but no paint eats every tap that lands on it.
		const pg = await open(390);
		const m = await pg.eval(`(() => {
			const r = document.getElementById("navbar-sections").getBoundingClientRect();
			const nav = document.getElementById("navbar").getBoundingClientRect();
			return {"h": Math.round(r.height),
				"under": (document.elementFromPoint(195, Math.round(nav.bottom) + 10) || {}).id};
		})()`);
		await pg.close();
		assert.equal(m.h, 0, `the closed grid is ${m.h}px tall over the video`);
		assert.notEqual(m.under, "navbar-sections", "the closed grid is still catching taps");
	});

	test("the desktop navbar is not touched by any of this", async () => {
		const pg = await open(1280, 900, false);
		const m = await pg.eval(`(() => {
			${REVEAL_JS}
			const nav = document.getElementById("navbar");
			const items = [...nav.querySelectorAll("li")].filter((li) => li.getBoundingClientRect().height > 0);
			return {
				"sections": getComputedStyle(document.getElementById("navbar-sections")).display,
				"menuButton": document.getElementById("navbar-menu-button").getBoundingClientRect().height,
				"rows": [...new Set(items.map((li) => Math.round(li.getBoundingClientRect().top)))].length,
				"strip": nav.scrollWidth <= nav.clientWidth,
			};
		})()`);
		await pg.close();
		assert.equal(m.sections, "contents",
			"the sections container must not exist as a box on the desktop");
		assert.equal(m.menuButton, 0, "the Menu button is showing on the desktop");
		assert.equal(m.rows, 1, "the desktop navbar is no longer one row");
		assert.equal(m.strip, true, "the desktop navbar overflows");
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
			assert.ok(m.left >= 6 && m.right <= width - 6,
				`the dialog spans ${m.left}..${m.right} on a ${width}px screen -- it must keep a gutter, not sit flush to both edges`);
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
		// The gutter is asserted HERE rather than on a real dialog: no dialog the
		// app builds is wide enough to reach the cap, so on those the assertion
		// would pass with the cap set to a flush `100%`. Only a forced-wide one
		// can tell the two apart.
		assert.ok(m.right <= 320 && m.left >= 0,
			`a 900px child pushed the dialog to ${m.left}..${m.right} on a 320px screen -- the width cap is gone`);
		assert.ok(m.left >= 6 && m.right <= 314,
			`at the cap the dialog spans ${m.left}..${m.right} -- it must keep a gutter, not go flush to both screen edges`);
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
		// They share the row: shrink-to-fit would leave three small buttons
		// huddled at the left of a 390px pad.
		const widest = Math.max(...keys.map((k) => k.w));
		const narrowest = Math.min(...keys.map((k) => k.w));
		// They carry a right margin except the last, so they are not pixel-equal.
		assert.ok(widest - narrowest <= 10,
			`the mouse buttons are not equal width (${keys.map((k) => k.w).join("/")}) -- they should share the row`);
		assert.ok(keys.reduce((a, k) => a + k.w, 0) > 300,
			`the mouse buttons total ${keys.reduce((a, k) => a + k.w, 0)}px on a 390px pad -- they are not filling it`);
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
