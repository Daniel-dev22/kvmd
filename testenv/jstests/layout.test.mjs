// What a real layout engine actually renders. The static suites can assert that
// a rule exists; only this can assert what it produces -- and the two headline
// claims of the mobile work (nothing overflows, everything is reachable by a
// finger) are measurements, not rules.

import test, {before, after, describe} from "node:test";
import assert from "node:assert/strict";
import {serveWeb, launchBrowser, chromiumPath} from "./browser.mjs";
import {PAGES} from "./helpers.mjs";

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
	const SHOW = `document.getElementById("keyboard-window").classList.remove("hidden");`;

	async function openKeyboard(width = 390) {
		const pg = await open("web/kvm/index.html", width);
		assert.equal(await pg.eval("document.documentElement.dataset.ui"), "mobile",
			"precondition: the compact board only exists in the compact layout");
		await pg.eval(SHOW);
		return pg;
	}

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
