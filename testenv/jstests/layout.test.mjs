// What a real layout engine actually renders. The static suites can assert that
// a rule exists; only this can assert what it produces -- and the two headline
// claims of the mobile work (nothing overflows, everything is reachable by a
// finger) are measurements, not rules.

import test, {before, after, describe} from "node:test";
import assert from "node:assert/strict";
import {serveWeb, launchBrowser, chromiumPath} from "./browser.mjs";
import {PAGES, read} from "./helpers.mjs";

// Narrowest supported phone, a common Android, a common iPhone, and a tablet
// that must still get touch sizing without the phone layout.
const WIDTHS = [320, 360, 390, 768];
const MIN_TARGET = 44; // Apple HIG and Material both land here

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

// A skipped suite is indistinguishable from a passing one at a glance, so the
// absence of a browser has to fail out loud rather than quietly halve the
// coverage. Set CHROMIUM=/path/to/chromium if it lives somewhere unusual.
test("a browser is available to measure layout", () => {
	assert.ok(chromiumPath(),
		"no chromium binary found -- the layout suite cannot run and every assertion below is skipped");
});

const urlFor = (page) => `${server.origin}/${page.replace(/^web\//, "")}`;

async function open(page, width, height = 844, mobile = true) {
	const pg = await browser.newPage();
	await pg.setViewport(width, height, mobile);
	await pg.clearStorage(server.origin);
	await pg.goto(urlFor(page));
	return pg;
}

describe("nothing overflows sideways", {"skip": chromiumPath() ? false : "no chromium available"}, () => {
	for (const page of PAGES) {
		for (const width of WIDTHS) {
			test(`${page} at ${width}px`, async () => {
				const pg = await open(page, width);
				const m = await pg.eval(`({
					doc: document.documentElement.scrollWidth,
					body: document.body.scrollWidth,
					inner: window.innerWidth,
					ui: document.documentElement.dataset.ui,
				})`);
				await pg.close();
				// Compare against the DEVICE width we emulated, never against
				// window.innerWidth. With no viewport meta the browser sets the
				// layout viewport to its ~980px fallback, so innerWidth reports
				// 980 on a 390px phone and `scrollWidth <= innerWidth` is
				// satisfied by the exact bug this test exists to catch.
				assert.ok(m.inner <= width,
					`${page} at ${width}px: layout viewport is ${m.inner}px -- the page is being scaled down`);
				assert.ok(m.doc <= width,
					`${page} at ${width}px: document is ${m.doc}px wide on a ${width}px device (data-ui=${m.ui})`);
				assert.ok(m.body <= width,
					`${page} at ${width}px: body is ${m.body}px wide on a ${width}px device`);
			});
		}
	}
});

describe("the layout switch resolves in a real engine", {"skip": chromiumPath() ? false : "no chromium available"}, () => {
	test("a phone viewport gets the compact layout", async () => {
		const pg = await open("web/kvm/index.html", 390);
		assert.equal(await pg.eval("document.documentElement.dataset.ui"), "mobile");
		await pg.close();
	});

	test("a wide viewport with a fine pointer gets the desktop layout", async () => {
		const pg = await open("web/kvm/index.html", 1440, 900, false);
		assert.equal(await pg.eval("document.documentElement.dataset.ui"), "desktop");
		await pg.close();
	});

	test("changing the interface style does not reload the page", async () => {
		const pg = await open("web/kvm/index.html", 390);
		await pg.eval("window.__probe = 'alive';");
		const out = await pg.eval(`(() => {
			let el = document.querySelector('input[name="page-ui-type-radio"][value="desktop"]');
			el.click();
			return {probe: window.__probe, ui: document.documentElement.dataset.ui, checked: el.checked};
		})()`);
		await pg.close();
		assert.equal(out.checked, true, "the Desktop option did not take");
		assert.equal(out.ui, "desktop", "the layout did not change");
		// It used to do window.location.href = window.location.href here, which
		// dropped the stream, the HID socket and any half-filled form.
		assert.equal(out.probe, "alive", "the page reloaded -- the session would have been dropped");
	});
});

describe("a finger can hit the controls", {"skip": chromiumPath() ? false : "no chromium available"}, () => {
	test("every navbar item meets the minimum touch target", async () => {
		const pg = await open("web/kvm/index.html", 390);
		const small = await pg.eval(`
			[...document.querySelectorAll("#navbar li:not(.hidden):not(.feature-disabled) .menu-item")]
				.map((el) => { let r = el.getBoundingClientRect(); return {t: el.innerText.trim().slice(0, 16), w: Math.round(r.width), h: Math.round(r.height)}; })
				.filter((m) => m.w > 0 && (m.w < ${MIN_TARGET} || m.h < ${MIN_TARGET}))
		`);
		await pg.close();
		assert.deepEqual(small, [], `navbar items under ${MIN_TARGET}px: ${JSON.stringify(small)}`);
	});

	test("an opened menu stays inside the viewport", async () => {
		const pg = await open("web/kvm/index.html", 390);
		// Measuring the compact menu is only meaningful in the compact layout.
		assert.equal(await pg.eval("document.documentElement.dataset.ui"), "mobile",
			"precondition: this test must run in the compact layout");
		const box = await pg.eval(`(() => {
			let bt = document.querySelector("#system-dropdown .menu-button");
			bt.dispatchEvent(new MouseEvent("mousedown", {bubbles: true}));
			let menu = document.getElementById("system-menu");
			let r = menu.getBoundingClientRect();
			return {left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width),
				inner: window.innerWidth, visible: !menu.classList.contains("hidden")};
		})()`);
		await pg.close();
		assert.equal(box.visible, true, "the System menu did not open");
		assert.ok(box.left >= 0, `menu starts off-screen at ${box.left}px`);
		assert.ok(box.right <= box.inner + 1, `menu runs to ${box.right}px in a ${box.inner}px viewport`);
	});
});

// The compact board is a 20-column grid per row, so a row is a fraction of the
// viewport by construction. Before Phase 2 the widest row needed 741px on a
// 390px screen and div.window is overflow:hidden -- the right-hand half of the
// keyboard was not clipped-but-scrollable, it was absent.
//
// Height is the touch-target dimension that matters for a keyboard: every
// native on-screen keyboard has keys narrower than they are tall. Width is
// therefore checked RELATIVE to the screen -- the board is a 20-column grid, so
// an absolute pixel floor would be a different requirement on every device.
// viewport/12 means at least ten keys sit comfortably across, which is what a
// native keyboard gives you (iOS letter keys are ~1/11th of the screen).
const minKeyWidth = (viewport) => viewport / 12;

describe("the on-screen keyboard", {"skip": chromiumPath() ? false : "no chromium available"}, () => {
	const LAYERS = ["abc", "sym", "fn", "num", "intl"];
	// Open it the way a user does. Stripping the "hidden" class directly skips
	// the window manager, so the layout the test measures is not the layout the
	// app produces -- which is exactly how a mouse pad covering the typing bar
	// got past a green suite.
	const SHOW = `document.getElementById("mouse-window-keyboard-button").click();`;

	async function openKeyboard(width = 390) {
		const pg = await open("web/kvm/index.html", width);
		assert.equal(await pg.eval("document.documentElement.dataset.ui"), "mobile",
			"precondition: the compact board only exists in the compact layout");
		await pg.eval(SHOW);
		await pg.eval("new Promise((r) => setTimeout(r, 200))");
		assert.equal(await pg.eval(`document.getElementById("keyboard-window").classList.contains("hidden")`), false,
			"the keyboard button did not open the keyboard");
		return pg;
	}

	// Being present and correctly sized is not the same as being touchable.
	// Anything a finger is meant to hit must be the topmost element at its own
	// centre -- nothing may be sitting on top of it.
	const hitTest = (selector) => `(() => {
		return [...document.querySelectorAll(${JSON.stringify(selector)})]
			.filter((el) => el.getBoundingClientRect().height > 0)
			.map((el) => {
				// Reachable, not merely on screen right now: the strip scrolls
				// horizontally while typing, and a key past its right edge is
				// reached by scrolling to it, which is what a finger does.
				el.scrollIntoView({"block": "nearest", "inline": "nearest"});
				const b = el.getBoundingClientRect();
				const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
				return {
					what: el.id || el.dataset.keypadCode || el.textContent.trim().slice(0, 10),
					ok: !!hit && (hit === el || el.contains(hit)),
					covered: (hit && hit !== el && !el.contains(hit)) ? (hit.id || hit.className) : null,
				};
			})
			.filter((r) => !r.ok);
	})()`;

	test("the typing bar is actually touchable, not covered", async () => {
		const pg = await openKeyboard();
		const blocked = await pg.eval(hitTest("#hid-type-input"));
		await pg.close();
		assert.deepEqual(blocked, [],
			`the typing bar is covered: ${JSON.stringify(blocked)}`);
	});

	test("the mouse buttons are touchable while the keyboard is open", async () => {
		const pg = await openKeyboard();
		const blocked = await pg.eval(hitTest("#mouse-buttons .key"));
		await pg.close();
		assert.deepEqual(blocked, [], `mouse buttons covered: ${JSON.stringify(blocked)}`);
	});

	test("while typing, the strip is ONE scrollable row and the console gets the height", async () => {
		// 📏 Measured at 390x420 -- a phone with the system keyboard up, which
		// is the only time this matters. Three rows of keys (layer picker,
		// modifiers, arrows) made the sheet 269px, 64% of the screen, and left
		// 62px of the console visible. One row leaves ~162px.
		const pg = await open("web/kvm/index.html", 390, 420);
		await pg.eval(SHOW);
		await pg.eval("new Promise((r) => setTimeout(r, 250))");
		const m = await pg.eval(`(() => {
			const strips = document.querySelector(".keypad-strips");
			const keys = [...strips.querySelectorAll(".key")];
			const r = strips.getBoundingClientRect();
			const win = document.getElementById("keyboard-window").getBoundingClientRect();
			const box = document.getElementById("stream-box").getBoundingClientRect();
			return {
				"typing": document.documentElement.dataset.typing,
				"tops": [...new Set(keys.map((k) => Math.round(k.getBoundingClientRect().top)))],
				"scrollW": Math.round(strips.scrollWidth),
				"clientW": Math.round(strips.clientWidth),
				"minKeyH": Math.min(...keys.map((k) => Math.round(k.getBoundingClientRect().height))),
				"minKeyW": Math.min(...keys.map((k) => Math.round(k.getBoundingClientRect().width))),
				"reachableWithoutScrolling": keys
					.filter((k) => { const b = k.getBoundingClientRect();
						return b.left >= r.left - 1 && b.right <= r.right + 1; })
					.map((k) => k.dataset.keypadCode),
				"all": keys.map((k) => k.dataset.keypadCode),
				"sheet": Math.round(win.height),
				"console": Math.round(win.top - box.top),
			};
		})()`);
		await pg.close();

		assert.equal(m.typing, "1", "precondition: the compact keyboard opens in typing mode");
		assert.equal(m.tops.length, 1, `the strip must be ONE row, found tops ${JSON.stringify(m.tops)}`);
		assert.ok(m.scrollW > m.clientW,
			`the strip must scroll, not be cut off: ${m.scrollW} content in ${m.clientW}`);
		// Every key still a finger-sized target -- the height came from losing
		// two ROWS, never from shrinking the keys.
		assert.ok(m.minKeyH >= 44, `keys shrank to ${m.minKeyH}px tall`);
		assert.ok(m.minKeyW >= 44, `keys shrank to ${m.minKeyW}px wide`);
		// What fits without scrolling is the console's own set. Alt, Shift and
		// Win scroll: a shell needs the arrows and Ctrl far more often.
		for (const code of ["ArrowLeft", "ArrowDown", "ArrowUp", "ArrowRight", "ControlLeft", "Escape"]) {
			assert.ok(m.reachableWithoutScrolling.includes(code),
				`${code} needs scrolling to reach; visible: ${JSON.stringify(m.reachableWithoutScrolling)}`);
		}
		assert.equal(m.all.length, 10, "all ten strip keys must still be there, just scrolled");
		assert.ok(m.sheet <= 200, `the sheet is ${m.sheet}px; three rows of keys was 269px`);
		assert.ok(m.console >= 140, `only ${m.console}px of console visible; three rows left 62px`);
	});

	test("every visible key and layer button is touchable", async () => {
		const pg = await openKeyboard();
		const blocked = await pg.eval(hitTest("#keyboard-compact .key, #keyboard-layers button, #hid-type-clear"));
		await pg.close();
		assert.deepEqual(blocked, [], `covered controls: ${JSON.stringify(blocked)}`);
	});

	test("no two docked windows sit on top of each other", async () => {
		const pg = await openKeyboard();
		const overlaps = await pg.eval(`(() => {
			const wins = [...document.getElementsByClassName("window")]
				.filter((el) => !el.classList.contains("hidden") && el.id !== "stream-window")
				.map((el) => { const b = el.getBoundingClientRect(); return {id: el.id, top: b.top, bottom: b.bottom}; })
				.filter((w) => w.bottom > w.top);
			const bad = [];
			for (let i = 0; i < wins.length; i++) {
				for (let j = i + 1; j < wins.length; j++) {
					const a = wins[i], b = wins[j];
					if (a.top < b.bottom - 1 && b.top < a.bottom - 1) bad.push(a.id + " over " + b.id);
				}
			}
			return bad;
		})()`);
		await pg.close();
		assert.deepEqual(overlaps, [],
			`docked windows overlap: ${overlaps.join(", ")} -- the one on top hides the other's controls`);
	});

	for (const width of [320, 390]) {
		for (const layer of LAYERS) {
			test(`the ${layer} layer fits a ${width}px screen`, async () => {
			const pg = await openKeyboard(width);
			const m = await pg.eval(`(() => {
				document.querySelector('[data-keypad-layer-button="${layer}"]').click();
				const rows = [...document.querySelectorAll('#keyboard-compact [data-keypad-layer="${layer}"]')];
				const keys = rows.flatMap((r) => [...r.querySelectorAll(".key")]);
				return {
					shown: rows.filter((r) => r.getBoundingClientRect().height > 0).length,
					rows: rows.length,
					widest: Math.max(...rows.map((r) => Math.round(r.scrollWidth))),
					keys: keys.length,
					small: keys.map((el) => {
						const r = el.getBoundingClientRect();
						return {k: el.dataset.keypadCode, w: Math.round(r.width), h: Math.round(r.height)};
					}).filter((k) => k.h < ${MIN_TARGET} || k.w < ${minKeyWidth(width)}),
				};
			})()`);
			await pg.close();
			assert.equal(m.shown, m.rows, `the ${layer} layer did not become visible when its button was clicked`);
			assert.ok(m.keys > 0, `the ${layer} layer rendered no keys`);
			assert.ok(m.widest <= width,
				`the ${layer} layer needs ${m.widest}px on a ${width}px screen`);
			assert.deepEqual(m.small, [],
				`keys under ${Math.round(minKeyWidth(width))}x${MIN_TARGET}px on the ${layer} layer at ${width}px: ${JSON.stringify(m.small)}`);
			});
		}
	}

	test("only the chosen layer is on screen", async () => {
		const pg = await openKeyboard();
		const visible = await pg.eval(`(() => {
			document.querySelector('[data-keypad-layer-button="num"]').click();
			const rows = [...document.querySelectorAll("#keyboard-compact [data-keypad-layer]")];
			return rows.filter((r) => r.getBoundingClientRect().height > 0)
				.map((r) => r.dataset.keypadLayer);
		})()`);
		await pg.close();
		assert.deepEqual([...new Set(visible)], ["num"],
			`layers on screen at once: ${[...new Set(visible)].join(", ")}`);
	});

	test("the mouse pad is not on screen until it is asked for", async () => {
		// It used to be opened on every phone load. With the keyboard sheet and
		// the system keyboard up as well there was no video left at all.
		const pg = await open("web/kvm/index.html", 390);
		const m = await pg.eval(`(() => {
			const pad = document.getElementById("mouse-window");
			return {visible: pad.getBoundingClientRect().height > 0,
				reachable: !!document.querySelector('#keyboard-window-header [data-wm-window-show="mouse-window"]')};
		})()`);
		await pg.close();
		assert.equal(m.visible, false, "the mouse pad is open before anyone asked for it");
		assert.equal(m.reachable, true,
			"nothing opens the mouse pad from the keyboard header -- hiding it by default would strand it");
	});

	test("the keyboard header opens the mouse pad", async () => {
		const pg = await open("web/kvm/index.html", 390);
		const shown = await pg.eval(`(() => {
			document.querySelector('[data-wm-window-show="keyboard-window"]').click();
			document.querySelector('#keyboard-window-header [data-wm-window-show="mouse-window"]').click();
			return document.getElementById("mouse-window").getBoundingClientRect().height > 0;
		})()`);
		await pg.close();
		assert.equal(shown, true, "the mouse toggle in the keyboard header did not open the pad");
	});

	test("a sheet taller than the screen scrolls instead of running off the top", async () => {
		// A docked sheet grows UPWARDS from the bottom edge, so on a short phone
		// the full board ran past the navbar with div.window's `overflow: hidden`
		// swallowing it -- the top rows could not be reached at all.
		// 360px tall: short enough that the board genuinely cannot fit, which is
		// what makes the height cap bind. At 480 the sheet fits either way and
		// removing the cap changes nothing observable.
		const pg = await open("web/kvm/index.html", 320, 360);
		const m = await pg.eval(`(() => {
			document.querySelector('[data-wm-window-show="keyboard-window"]').click();
			document.querySelector('[data-keypad-layer-button="abc"]').click();
			const win = document.getElementById("keyboard-window");
			const b = win.getBoundingClientRect();
			return {top: Math.round(b.top), overflowY: getComputedStyle(win).overflowY,
				scrollable: win.scrollHeight > win.clientHeight + 1,
				reachable: win.scrollHeight - win.clientHeight};
		})()`);
		await pg.close();
		assert.equal(m.overflowY, "auto", "the compact sheet cannot scroll, so anything past the screen is lost");
		assert.ok(m.scrollable,
			"precondition: the board must not fit this viewport, or the height cap is not under test");
		assert.ok(m.top >= 50,
			`the sheet starts at y=${m.top} -- it has run up past the navbar, where those rows cannot be reached`);
		assert.ok(m.reachable > 0, "the sheet reports overflow but nothing can be scrolled to");
	});

	test("the desktop board is not rendered in the compact layout", async () => {
		const pg = await openKeyboard();
		const h = await pg.eval(`(() => {
			const el = document.getElementById("keyboard-desktop");
			return Math.round(el.getBoundingClientRect().height);
		})()`);
		await pg.close();
		assert.equal(h, 0, "the desktop board is still taking space on a phone");
	});

	test("the native typing bar is present, and is the last thing above the keyboard", async () => {
		const pg = await openKeyboard();
		const m = await pg.eval(`(() => {
			const el = document.getElementById("hid-type-input");
			if (!el) return null;
			const r = el.getBoundingClientRect();
			const cs = getComputedStyle(el);
			const rows = [...document.querySelectorAll("#keyboard-compact .keypad-row")]
				.filter((x) => x.getBoundingClientRect().height > 0);
			const lowest = Math.max(...rows.map((x) => x.getBoundingClientRect().bottom));
			return {h: Math.round(r.height), font: parseFloat(cs.fontSize), top: r.top, lowestRow: lowest};
		})()`);
		await pg.close();
		assert.ok(m, "the typing bar is missing from the compact layout");
		assert.ok(m.h >= MIN_TARGET, `the typing bar is only ${m.h}px tall`);
		// Under 16px, iOS zooms the whole page when the field is focused.
		assert.ok(m.font >= 16, `the typing field renders at ${m.font}px`);
		assert.ok(m.top >= m.lowestRow - 1,
			"the typing bar must sit below the keys, where the system keyboard opens");
	});

	test("the typing bar is not rendered on desktop", async () => {
		const pg = await open("web/kvm/index.html", 1440, 900, false);
		await pg.eval(SHOW);
		const h = await pg.eval(`Math.round(document.getElementById("hid-type-input").getBoundingClientRect().height)`);
		await pg.close();
		assert.equal(h, 0, "desktop already has the Text menu; it must not grow a second typing field");
	});

	test("the persistent strip stays on screen whichever layer is showing", async () => {
		const pg = await openKeyboard();
		const seen = await pg.eval(`(() => {
			const out = {};
			for (const L of ["abc", "sym", "fn", "num", "intl"]) {
				document.querySelector('[data-keypad-layer-button="' + L + '"]').click();
				out[L] = [...document.querySelectorAll("#keyboard-compact [data-keypad-persistent] .key")]
					.filter((el) => el.getBoundingClientRect().height > 0).length;
			}
			return out;
		})()`);
		await pg.close();
		for (const [layer, count] of Object.entries(seen)) {
			assert.ok(count >= 10, `only ${count} strip keys visible on the ${layer} layer`);
		}
	});

	test("typing in the bar reaches api/hid/print, once per burst", async () => {
		// The whole chain, in a real engine: input event -> diff -> queue ->
		// printText -> tools.httpPost -> XHR. Recorded by standing in for XHR,
		// because there is no kvmd behind this page.
		const pg = await openKeyboard();
		const sent = await pg.eval(`(() => {
			window.__sent = [];
			const Real = window.XMLHttpRequest;
			window.XMLHttpRequest = function() {
				const x = new Real();
				const open = x.open.bind(x);
				const send = x.send.bind(x);
				let url = null;
				x.open = (m, u, a) => { url = u; return open(m, u, a); };
				x.send = (body) => { window.__sent.push({url: url, body: body}); return send(body); };
				return x;
			};
			const el = document.getElementById("hid-type-input");
			el.focus();
            // How a soft keyboard, a swipe, or dictation delivers text.
			el.value = "hello";
			el.dispatchEvent(new Event("input", {bubbles: true}));
			return window.__sent;
		})()`);
		await pg.close();
		assert.equal(sent.length, 1, `expected one request, got ${sent.length}`);
		assert.match(sent[0].url, /api\/hid\/print/, `posted to ${sent[0].url}`);
		assert.match(sent[0].url, /keymap=/, "the request must name the server-side keymap");
		assert.equal(sent[0].body, "hello", `body was ${JSON.stringify(sent[0].body)}`);
	});

	test("erasing does not retype the line", async () => {
		const pg = await openKeyboard();
		const sent = await pg.eval(`(() => {
			window.__sent = [];
			const Real = window.XMLHttpRequest;
			window.XMLHttpRequest = function() {
				const x = new Real();
				const send = x.send.bind(x);
				x.send = (body) => { window.__sent.push(body); return send(body); };
				return x;
			};
			const el = document.getElementById("hid-type-input");
			el.value = "hello";
			el.dispatchEvent(new Event("input", {bubbles: true}));
			el.value = "hell";
			el.dispatchEvent(new Event("input", {bubbles: true}));
			return window.__sent;
		})()`);
		await pg.close();
		// A deletion is a Backspace key event, never a re-print of the text.
		assert.deepEqual(sent, ["hello"], `erasing sent: ${JSON.stringify(sent)}`);
	});

	// Focus events are the whole mechanism here, and a headless page that is not
	// "focused" moves activeElement without firing them -- so this would pass
	// vacuously if the harness ever stopped emulating focus.
	test("the harness fires real focus events", async () => {
		const pg = await openKeyboard();
		const fired = await pg.eval(`(() => {
			let n = 0;
			const el = document.getElementById("hid-type-clear");
			el.addEventListener("focus", () => n++);
			el.focus();
			return n;
		})()`);
		await pg.close();
		assert.equal(fired, 1, "focus() did not fire a focus event -- focus-driven behaviour is untested");
	});

	test("the compact keyboard opens ready to type, and the board is one tap back", async () => {
		// On a phone this window is opened to type far more often than to send a
		// scancode, and the bar that starts that sat BELOW the whole board --
		// so it was never found and the redundant letter keys ate the screen.
		// It now opens in typing mode. The round trip is asserted in both
		// directions: a layer tap must bring the board straight back, which is
		// what "one tap away" means and what the 200ms blur debounce used to eat.
		const pg = await openKeyboard();
		const vis = `(s) => [...document.querySelectorAll(s)].filter((e) => e.getBoundingClientRect().height > 0).length`;
		const snap = `(() => {
			const vis = ${vis};
			return {
				typing: document.documentElement.getAttribute("data-typing"),
				rows: vis("#keyboard-compact [data-keypad-layer]"),
				strip: vis("#keyboard-compact [data-keypad-persistent] .key"),
				bar: vis("#hid-type-input"),
				picker: vis("#keyboard-layers button"),
				h: Math.round(document.getElementById("keyboard-window").getBoundingClientRect().height),
			};
		})()`;

		const opened = await pg.eval(snap);
		assert.equal(opened.typing, "1", "the compact keyboard must open in typing mode");
		assert.equal(opened.rows, 0, "the redundant scancode layers must not be on screen while the phone's own keyboard is");
		assert.ok(opened.strip >= 10, `only ${opened.strip} strip keys -- the arrows and modifiers a phone cannot send must stay`);
		assert.equal(opened.bar, 1, "the typing bar must be on screen");
		// The picker is a whole row whose only job here is "give me the board
		// back", and that is one button -- which sits in the typing bar, where
		// it costs no height at all. 📏 Three rows of keys above the system
		// keyboard left 62px of the console visible at 390x420; one scrollable
		// row leaves ~162px.
		assert.equal(opened.picker, 0, "the layer picker is a row of its own and must not cost one while typing");
		assert.ok(await pg.eval(`document.getElementById("hid-type-board").getBoundingClientRect().height > 0`),
			"the way back to the board must be on screen");

		// One tap on that button, and the full board is back immediately.
		await pg.eval(`document.getElementById("hid-type-board").click()`);
		const tapped = await pg.eval(snap);
		assert.equal(tapped.typing, null, "a layer tap must leave typing mode at once, not after the blur debounce");
		assert.ok(tapped.rows > 0, "the scancode board did not come back on the tap that asked for it");
		assert.ok(tapped.h > opened.h, `the sheet did not grow for the board (${opened.h}px -> ${tapped.h}px)`);

		// And back into typing mode, which is what gives the space to the video.
		await pg.eval(`document.getElementById("hid-type-input").focus()`);
		await pg.eval("new Promise((r) => setTimeout(r, 150))");
		const typing = await pg.eval(snap);
		await pg.close();
		assert.equal(typing.typing, "1", "typing mode never re-engaged");
		assert.equal(typing.rows, 0, "the scancode layers are still on screen while the system keyboard is up");
		assert.ok(typing.h < tapped.h,
			`the sheet did not shrink again (${tapped.h}px -> ${typing.h}px); the space should go back to the video`);
	});

	test("choosing a layer leaves typing mode and shows that layer", async () => {
		const pg = await openKeyboard();
		await pg.eval(`document.getElementById("hid-type-input").focus()`);
		await pg.eval("new Promise((r) => setTimeout(r, 150))");
		await pg.eval(`document.querySelector('[data-keypad-layer-button="fn"]').click()`);
		await pg.eval("new Promise((r) => setTimeout(r, 400))");
		const after = await pg.eval(`(() => {
			const vis = (s) => [...document.querySelectorAll(s)].filter((e) => e.getBoundingClientRect().height > 0).length;
			return {typing: document.documentElement.getAttribute("data-typing"),
				fnRows: vis('#keyboard-compact [data-keypad-layer="fn"]')};
		})()`);
		await pg.close();
		assert.equal(after.typing, null, "tapping a layer must release the typing field");
		assert.ok(after.fnRows > 0, "the chosen layer did not appear");
	});

	test("docked sheets are positioned clear of the system keyboard", async () => {
		// On iOS the layout viewport does not shrink when the keyboard opens --
		// only the visual viewport does -- so bottom:0 puts a sheet behind it.
		const pg = await openKeyboard();
		const m = await pg.eval(`(() => {
			const root = getComputedStyle(document.documentElement);
			const kw = getComputedStyle(document.getElementById("keyboard-window"));
			return {inset: root.getPropertyValue("--wm-kb-inset").trim(), bottom: kw.bottom};
		})()`);
		await pg.close();
		assert.notEqual(m.inset, "", "wm.js must publish the system keyboard inset");
		assert.equal(m.inset, "0px", "no system keyboard is open in the harness, so the inset is zero");
		assert.equal(m.bottom, "0px", "with no keyboard open the sheet sits on the bottom edge");
	});

	test("the keyboard can be dismissed on a phone", async () => {
		// kvm/x-mobile.css used to hide the window header outright, so the
		// keyboard could be neither moved nor closed once it was up.
		const pg = await openKeyboard();
		const box = await pg.eval(`(() => {
			const bt = document.querySelector("#keyboard-window [data-wm-window-close]");
			if (!bt) return null;
			const r = bt.getBoundingClientRect();
			return {w: Math.round(r.width), h: Math.round(r.height)};
		})()`);
		await pg.close();
		assert.ok(box, "the keyboard window has no close button");
		assert.ok(box.w > 0 && box.h > 0, `the close button is not visible: ${JSON.stringify(box)}`);
	});
});

describe("the launcher offers everything it has on one row", {"skip": chromiumPath() ? false : "no chromium available"}, () => {
	// The tiles are 100px wide with 5px margins and float: left, so three of
	// them need 330px: on a phone KVM and Terminal took the first row and
	// Logout wrapped onto a second. The apps come from the API, which is not
	// behind this page, so the list is stood in -- in the shape index/main.js
	// actually builds, which is asserted against the source below.
	const APPS = `(() => {
		const tile = (id, path, icon, name) => \`<li>
			<div \${id ? 'id="' + id + '"' : ""} class="app">
				<a href="\${path}/">
					<div><img class="svg-gray" src="\${icon}">\${name}</div>
				</a>
			</div>
		</li>\`;
		document.getElementById("apps-box").innerHTML = "<ul id=\\"apps\\">"
			+ tile(null, "kvm", "share/svg/kvm.svg", "KVM")
			+ tile(null, "webterm", "share/svg/webterm.svg", "Terminal")
			+ tile("logout-button", "#", "share/svg/logout.svg", "Logout")
			+ "</ul>";
		return true;
	})()`;

	test("index/main.js still builds the tiles this test stands in for", () => {
		const src = read("web/share/js/index/main.js");
		for (const marker of ["<ul id=\"apps\">", "<li>", "class=\"app\"", "<img class=\"svg-gray\""]) {
			assert.ok(src.includes(marker),
				`index/main.js no longer builds ${marker}: this suite is measuring a shape the app stopped producing`);
		}
	});

	for (const width of [320, 390]) {
		test(`three apps share one row at ${width}px`, async () => {
			const pg = await open("web/index.html", width);
			await pg.eval(APPS);
			const m = await pg.eval(`(() => {
				const tiles = [...document.querySelectorAll("#apps li")].map(function(li) {
					const r = li.getBoundingClientRect();
					const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
					return {
						"name": li.textContent.trim(),
						"y": Math.round(r.top), "w": Math.round(r.width),
						"tappable": (li.contains(top)),
					};
				});
				return {tiles, "rows": [...new Set(tiles.map((t) => t.y))].length};
			})()`);
			await pg.close();
			assert.equal(m.tiles.length, 3, "the stand-in list did not render");
			assert.equal(m.rows, 1,
				`the launcher split its apps over ${m.rows} rows at ${width}px: ${JSON.stringify(m.tiles)}`);
			for (const tile of m.tiles) {
				assert.ok(tile.w >= MIN_TARGET, `${tile.name} is ${tile.w}px wide at ${width}px`);
				assert.equal(tile.tappable, true, `${tile.name} is covered by something else`);
			}
		});
	}
});

describe("the terminal is zoomed for a phone, and only for a phone", {"skip": chromiumPath() ? false : "no chromium available"}, () => {
	// The source test in webterm.test.mjs says the rule exists. This says what
	// it DOES: the terminal is handed half the viewport, lays itself out for
	// that, and every pixel it draws comes out twice the size -- the terminal's
	// own font, its cursor, its scrollbar. Asking ttyd for a font size was
	// tried instead and reported twice from the phone as having no effect.
	const OPEN = `(async () => {
		const win = document.getElementById("webterm-window");
		win.classList.remove("hidden");
		const frame = document.getElementById("webterm-iframe");
		// Same origin, so the viewport the terminal would get is readable.
		frame.src = "/share/svg/logo.svg";
		await new Promise((done) => {
			frame.onload = done;
			setTimeout(done, 2000);
		});
		const box = frame.getBoundingClientRect();
		const outer = win.getBoundingClientRect();
		return {
			"rendered": Math.round(box.width),
			"tall": Math.round(box.height),
			"window": Math.round(outer.width),
			"inner": (frame.contentWindow === null ? null : frame.contentWindow.innerWidth),
			"transform": getComputedStyle(frame).transform,
		};
	})()`;

	test("a phone gets half the viewport at twice the size", async () => {
		const pg = await open("web/kvm/index.html", 390, 700);
		const m = await pg.eval(OPEN);
		await pg.close();
		assert.notEqual(m.transform, "none", "the iframe is not scaled");
		assert.ok(m.rendered >= m.window - 10,
			`the terminal fills ${m.rendered}px of a ${m.window}px window -- the zoom shrank its box`);
		assert.ok(m.tall > 100, `the terminal is ${m.tall}px tall`);
		assert.ok(m.inner < m.rendered * 0.6,
			`the terminal sees ${m.inner}px inside a ${m.rendered}px box: it is not being scaled up`);
	});

	test("the desktop terminal is left alone", async () => {
		const pg = await open("web/kvm/index.html", 1280, 900, false);
		const m = await pg.eval(OPEN);
		await pg.close();
		assert.equal(m.transform, "none", "the desktop terminal must not be scaled");
		assert.equal(m.inner, m.rendered,
			`the desktop terminal sees ${m.inner}px inside a ${m.rendered}px box`);
	});
});

