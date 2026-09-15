// Input from a finger, measured in a real engine with a real touchscreen.
//
// Everything here is a capability the UI HAD for a mouse and did not have for a
// finger: locking a modifier, seeing that a key is about to latch, clicking the
// host's screen at all, and selecting text to recognise. Touches and clicks are
// dispatched through the browser's own input pipeline -- hit-tested, with real
// events and real default actions -- because a synthetic event handed straight
// to a listener proves only that the listener exists, and it was exactly that
// shortcut which hid two defects in the first cut of this phase.
//
// Where it matters, the assertion is on the HID EVENTS THE PAGE SENDS, read out
// of the app's own recorder, not on the CSS class the key happens to wear. A
// build where the latch is purely cosmetic passed an entire suite of class
// assertions.

import test, {before, after, describe} from "node:test";
import assert from "node:assert/strict";
import {serveWeb, launchBrowser, chromiumPath} from "./browser.mjs";

const MIN_TARGET = 44;
const KVM = "kvm/index.html";

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

test("a browser is available to dispatch touches", () => {
	assert.ok(chromiumPath(),
		"no chromium binary found -- the touch suite cannot run and every assertion below is skipped");
});

// touch=true gives the page an actual touchscreen: without it the engine
// answers `pointer: coarse` and `hover: none` the way a desktop does, and every
// assertion below would be measuring a mouse.
async function open(width = 390, {touch = true, height = 844} = {}) {
	const pg = await browser.newPage();
	await pg.setViewport(width, height, touch);
	await pg.setTouch(touch, 5);
	await pg.clearStorage(server.origin);
	// ?debug=1 turns on tools.debug, which is the HID instrument below. It
	// changes nothing else about the page.
	await pg.goto(`${server.origin}/${KVM}?debug=1`);
	return pg;
}

// A touch is dispatched at coordinates, so a target that is not on screen does
// not fail -- it silently aims at 0,0, which is the back link in the navbar, and
// the page navigates away mid-test. The instrument refuses instead.
const centre = (selector) => `(() => {
	const el = document.querySelector(${JSON.stringify(selector)});
	if (el === null) { throw new Error("no element for " + ${JSON.stringify(selector)}); }
	const r = el.getBoundingClientRect();
	if (r.width === 0 || r.height === 0) {
		throw new Error(${JSON.stringify(selector)} + " is not on screen: nothing to touch");
	}
	return {"x": r.left + r.width / 2, "y": r.top + r.height / 2, "w": r.width, "h": r.height};
})()`;

const classOf = (selector) => `document.querySelector(${JSON.stringify(selector)}).className`;

async function tap(pg, point, hold = 0) {
	await pg.touch("touchStart", [point]);
	if (hold > 0) {
		await new Promise((done) => setTimeout(done, hold));
	}
	await pg.touch("touchEnd", []);
}

// ===========================================================================
// What the host receives. tools.debug logs every HID event on the line that
// sits immediately beside the websocket write, in __innerSendKey and
// __sendButton, so this is the page's own account of what it sent -- not the
// CSS class the key happens to be wearing. A build where the latch is purely
// cosmetic passed an entire suite of class assertions.
//
// 📏 The recorder's own script is one step closer to the wire and was tried
// first: kvm/recorder.js stops recording on setSocket(null), which a page with
// no kvmd behind it reaches 700-1200ms after load. Every gesture longer than
// that read back as "sent nothing", which is the answer half of these tests are
// looking for -- silently, and for free.
// ===========================================================================

const HID_START = `(() => {
	window.__hid = [];
	const real = console.log;
	console.log = function(...args) {
		const m = args.join(" ").match(/(Keyboard: key|Mouse: button) (pressed|released): (\\S+)/);
		if (m !== null) {
			window.__hid.push(
				(m[1].startsWith("Keyboard") ? "key " : "mouse ")
				+ m[3] + (m[2] === "pressed" ? " down" : " up"));
		}
		return real.apply(console, args);
	};
	if (!window.location.search.includes("debug=1")) {
		throw new Error("the page was not opened with ?debug=1: nothing is logged and every assertion below is free");
	}
	return true;
})()`;

const HID_READ = `window.__hid`;

// Waits for the events rather than sleeping a guessed number of milliseconds --
// which is long enough on an idle machine and not on one running four browsers
// at once. An expectation of NOTHING has to wait out the whole window, since
// there is no event to wait for.
async function hidSettled(pg, pg_want, ms = 2000) {
	const until = Date.now() + ms;
	do {
		const seen = await pg.eval(HID_READ);
		if (pg_want > 0 && seen.length >= pg_want) {
			break;
		}
		await new Promise((done) => setTimeout(done, 50));
	} while (Date.now() < until);
	// A grace period, so an event that should NOT have followed still shows up
	// in the assertion instead of being missed by a race.
	await new Promise((done) => setTimeout(done, 150));
	return pg.eval(HID_READ);
}

// The keyboard window is opened the way a user opens it, so the layout under
// test is the one the window manager actually produces. It opens in typing
// mode, where the scancode layers are put away and the phone's own keyboard
// does the letters -- so a test that wants a scancode key has to ask for its
// layer, exactly as a user would.
const SHOW_KEYBOARD = `document.querySelector('[data-wm-window-show="keyboard-window"]').click()`;
const LAYERS = ["abc", "sym", "fn", "num", "intl"];
const showLayer = (layer) => `document.querySelector('[data-keypad-layer-button="${layer}"]').click()`;

describe("a finger reaches every modifier state", {"skip": chromiumPath() ? false : "no chromium available"}, () => {
	test("tapping a modifier holds it DOWN ON THE HOST, again locks it, again releases it", async () => {
		const pg = await open();
		await pg.eval(HID_START);
		await pg.eval(SHOW_KEYBOARD);
		const sel = `#keyboard-compact [data-keypad-code="ControlLeft"]`;
		const at = await pg.eval(centre(sel));
		const seen = [];
		for (let i = 0; i < 3; i++) {
			await tap(pg, at);
			seen.push(await pg.eval(classOf(sel)));
		}
		const sent = await pg.eval(HID_READ);
		await pg.close();
		assert.deepEqual(seen, ["key holded", "key locked", "key"],
			"a finger has no middle or right button: the states have to be reachable by tapping");
		assert.deepEqual(sent, ["key ControlLeft down", "key ControlLeft up"],
			"the latch has to be a key held on the HOST, not a colour on a key");
	});

	test("a locked modifier survives another key, a held one does not", async () => {
		// That difference IS the difference between hold and lock, and it is
		// the whole reason lock had to become reachable.
		const pg = await open();
		await pg.eval(SHOW_KEYBOARD);
		await pg.eval(showLayer("abc"));
		const ctrl = `#keyboard-compact [data-keypad-code="ControlLeft"]`;
		const letter = `#keyboard-compact [data-keypad-code="KeyA"]`;
		const at_ctrl = await pg.eval(centre(ctrl));
		const at_letter = await pg.eval(centre(letter));

		await tap(pg, at_ctrl); // held
		await tap(pg, at_letter);
		const after_held = await pg.eval(classOf(ctrl));

		await pg.eval(HID_START);
		await tap(pg, at_ctrl); // held
		await tap(pg, at_ctrl); // locked
		await tap(pg, at_letter);
		const after_locked = await pg.eval(classOf(ctrl));
		const sent = await pg.eval(HID_READ);
		await pg.close();

		assert.equal(after_held, "key", "a held modifier is released by the next key");
		assert.equal(after_locked, "key locked", "a locked modifier is not");
		assert.deepEqual(sent, ["key ControlLeft down", "key KeyA down", "key KeyA up"],
			"Ctrl+A on a phone: Ctrl goes down once and stays down across the letter");
	});

	test("the modifier state is mirrored onto the desktop board", async () => {
		// Both boards are in the DOM at once; a key showing the wrong state on
		// one of them is how the two hand-written boards used to drift.
		const pg = await open();
		await pg.eval(SHOW_KEYBOARD);
		await tap(pg, await pg.eval(centre(`#keyboard-compact [data-keypad-code="ShiftLeft"]`)));
		const desktop = await pg.eval(classOf(`#keyboard-desktop [data-keypad-code="ShiftLeft"]`));
		await pg.close();
		assert.match(desktop, /\bholded\b/);
	});

	test("tapping a key that is NOT a modifier still sends it", async () => {
		// PrintScreen and the Japanese mode keys can be held -- they carry the
		// latch bullet -- but they are keys, not modifiers: a tap has to send
		// one. Latching every bulleted key would have taken that away.
		const pg = await open();
		await pg.eval(HID_START);
		await pg.eval(SHOW_KEYBOARD);
		await pg.eval(showLayer("fn"));
		const sel = `#keyboard-compact [data-keypad-code="PrintScreen"]`;
		const at = await pg.eval(centre(sel));
		await pg.touch("touchStart", [at]);
		const down = await pg.eval(classOf(sel));
		await pg.touch("touchEnd", []);
		const up = await pg.eval(classOf(sel));
		const sent = await pg.eval(HID_READ);
		await pg.close();
		assert.match(down, /\bpressed\b/, "the key goes down under the finger");
		assert.equal(up, "key", "and comes back up when it lifts -- it must not latch");
		assert.deepEqual(sent, ["key PrintScreen down", "key PrintScreen up"]);
	});

	test("a long press latches a key that allows it, and a tap then RELEASES it", async () => {
		// Not locks it. The advance-on-tap belongs to modifiers alone: on the
		// on-screen mouse pad a latched Left is how a finger drags on the host,
		// and a tap has to drop it rather than lock it down harder.
		const pg = await open();
		await pg.eval(SHOW_KEYBOARD);
		await pg.eval(showLayer("fn"));
		const sel = `#keyboard-compact [data-keypad-code="PrintScreen"]`;
		const at = await pg.eval(centre(sel));
		await tap(pg, at, 650);
		const held = await pg.eval(classOf(sel));
		await tap(pg, at);
		const off = await pg.eval(classOf(sel));
		await pg.close();
		assert.equal(held, "key holded");
		assert.equal(off, "key");
	});

	test("the about-to-latch warning is drawn to a finger, on both boards", async () => {
		// It used to be gated on :hover, which a finger can never satisfy: the
		// key latched after 500ms with nothing on screen to say it was coming.
		const pg = await open();
		await pg.eval(SHOW_KEYBOARD);
		await pg.eval(showLayer("fn"));
		const sel = `#keyboard-compact [data-keypad-code="PrintScreen"]`;
		await pg.touch("touchStart", [await pg.eval(centre(sel))]);
		const m = await pg.eval(`(() => {
			const el = document.querySelector(${JSON.stringify(sel)});
			const twin = document.querySelector('#keyboard-desktop [data-keypad-code="PrintScreen"]');
			const cs = getComputedStyle(el);
			return {
				"cls": el.className,
				"twin": twin.className,
				"animation": cs.animationName,
				"gradient": cs.backgroundImage.startsWith("linear-gradient"),
				"hover": matchMedia("(hover: hover)").matches,
			};
		})()`);
		await pg.touch("touchEnd", []);
		await pg.close();
		assert.equal(m.hover, false, "this device cannot hover -- which is the point of the test");
		assert.match(m.cls, /\bholding\b/, "keypad.js has to mark the key while the latch is armed");
		assert.match(m.twin, /\bholding\b/, "and mirror it, like every other state class");
		assert.equal(m.animation, "keypad-animate-holding");
		assert.equal(m.gradient, true, "the fill that shows the latch coming");
	});

	test("a key held on a physical keyboard is not announced as latching", async () => {
		// The state is marked where it is known -- when the timer is armed --
		// rather than inferred from "pressed", which emit() also sets.
		const pg = await open();
		await pg.eval(SHOW_KEYBOARD);
		const m = await pg.eval(`(() => {
			const el = document.querySelector('#keyboard-desktop [data-keypad-code="ControlLeft"]');
			document.getElementById("keyboard-window").dispatchEvent(
				new KeyboardEvent("keydown", {"code": "ControlLeft", "bubbles": true}));
			return {"cls": el.className, "animation": getComputedStyle(el).animationName};
		})()`);
		await pg.close();
		assert.doesNotMatch(m.cls, /\bholding\b/);
		assert.equal(m.animation, "none");
	});

	test("every key of every layer can be tapped where it is", async () => {
		// Presence is not touchability: a key that measures 46px and is covered
		// by something else is not a key. The hit test asks the engine, layer
		// by layer -- sweeping the board as it opens would sweep the four keys
		// of the strip and report a clean board.
		for (const width of [320, 390]) {
			const pg = await open(width);
			await pg.eval(SHOW_KEYBOARD);
			for (const layer of LAYERS) {
				await pg.eval(showLayer(layer));
				const m = await pg.eval(`(() => {
					const code = (el) => el.getAttribute("data-keypad-code");
					const box = (el) => el.getBoundingClientRect();
					const gone = [];
					const covered = [];
					// Every key this layer DEFINES has to be on screen once the
					// layer is chosen -- counting only what is already visible
					// would let a missing key pass as a smaller board.
					const mine = [...document.querySelectorAll('#keyboard-compact [data-keypad-layer="${layer}"] .key')];
					for (const el of mine) {
						const r = box(el);
						if (r.width === 0 || r.height === 0) { gone.push(code(el)); }
					}
					for (const el of document.querySelectorAll("#keyboard-compact div.key")) {
						const r = box(el);
						if (r.width === 0 || r.height === 0) { continue; } // a layer put away
						const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
						if (el !== top && !el.contains(top)) { covered.push(code(el)); }
					}
					return {"defined": mine.length, gone, covered};
				})()`);
				assert.ok(m.defined > 0, `${width}px, ${layer}: the layer defines no keys at all`);
				assert.deepEqual(m.gone, [], `${width}px, ${layer}: keys that never appeared`);
				assert.deepEqual(m.covered, [],
					`${width}px, ${layer}: keys covered by something else`);
			}
			await pg.close();
		}
	});
});

describe("a mouse keeps every button it had", {"skip": chromiumPath() ? false : "no chromium available"}, () => {
	// The tap cycle must not reach the mouse: a left click is a momentary press
	// and always was, and it is what desktop users press keys with.
	const press = (sel, button) => `(() => {
		const el = document.querySelector(${JSON.stringify(sel)});
		el.dispatchEvent(new MouseEvent("mousedown", {"button": ${button}, "bubbles": true}));
		const down = el.className;
		el.dispatchEvent(new MouseEvent("mouseup", {"button": ${button}, "bubbles": true}));
		return {down, "up": el.className};
	})()`;

	for (const [button, name, expected] of [
		// Only the left click is on its way to a latch, so only it is marked.
		[0, "left", {"down": "key wide-1 left small pressed holding", "up": "key wide-1 left small"}],
		[2, "right", {"down": "key wide-1 left small holded", "up": "key wide-1 left small holded"}],
		[1, "middle", {"down": "key wide-1 left small locked", "up": "key wide-1 left small locked"}],
	]) {
		test(`a ${name} click on a modifier still means what it meant`, async () => {
			const pg = await open(1280, {"touch": false, "height": 900});
			await pg.eval(SHOW_KEYBOARD);
			const m = await pg.eval(press(`#keyboard-desktop [data-keypad-code="ControlLeft"]`, button));
			await pg.close();
			assert.deepEqual(m, expected);
		});
	}

	test("a lock held down for half a second is still a lock", async () => {
		// The autohold timer fired over the state the click had already chosen
		// and demoted it. Nothing cancelled it except the button coming back up
		// within 500ms, which is the only reason this was ever hard to see.
		const pg = await open(1280, {"touch": false, "height": 900});
		await pg.eval(SHOW_KEYBOARD);
		const sel = `#keyboard-desktop [data-keypad-code="ControlLeft"]`;
		await pg.eval(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(
			new MouseEvent("mousedown", {"button": 1, "bubbles": true}))`);
		await new Promise((done) => setTimeout(done, 700));
		const cls = await pg.eval(classOf(sel));
		await pg.close();
		assert.equal(cls, "key wide-1 left small locked");
	});
});

describe("a phone can reach the keyboard and the mouse", {"skip": chromiumPath() ? false : "no chromium available"}, () => {
	// Reported from a real phone, against the deployed build: "there is no
	// button now to pop up android keyboard or open mouse in mobile view".
	// Both buttons existed -- in the LAST row of the System sheet, under a
	// screenful of settings and three spoilers, at or below the fold on a
	// viewport shortened by the browser's own chrome. They were reachable only
	// by scrolling a sheet nobody had a reason to scroll.
	//
	// This walks the whole path with a finger rather than measuring geometry,
	// because the complaint was not that a rectangle was the wrong size.
	for (const [width, height] of [[390, 640], [320, 568]]) {
		test(`from the video to the typing bar and the pad, at ${width}x${height}`, async () => {
			const pg = await open(width, {height});
			const shut = await pg.eval(`({
				"keyboard": document.getElementById("keyboard-window").classList.contains("hidden"),
				"mouse": document.getElementById("mouse-window").classList.contains("hidden"),
			})`);
			assert.deepEqual(shut, {"keyboard": true, "mouse": true},
				"neither window should be open before it is asked for");

			await tap(pg, await pg.eval(centre("#navbar-menu-button")));
			await tap(pg, await pg.eval(centre("#system-dropdown .menu-button")));
			const reach = await pg.eval(`(() => {
				const menu = document.getElementById("system-menu");
				const out = {"scrolled": menu.scrollTop, "open": !menu.classList.contains("hidden")};
				for (const what of ["keyboard-window", "mouse-window"]) {
					const el = menu.querySelector('[data-wm-window-show="' + what + '"]');
					const r = el.getBoundingClientRect();
					const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
					out[what] = {
						"firstScreenful": (r.top >= 0 && r.bottom <= window.innerHeight),
						"topmost": (el === top || el.contains(top)),
						"tall": Math.round(r.height),
					};
				}
				// This page has no hardware behind it, so its System sheet is
				// SHORTER than a real device's -- "it happens to fit" is not
				// the property. The property is that the actions come before
				// the settings, whatever is in them.
				out.beforeSettings = (
					document.querySelector('[data-wm-window-show="keyboard-window"]').getBoundingClientRect().top
					< menu.querySelector("details").getBoundingClientRect().top
				);
				return out;
			})()`);
			assert.equal(reach.open, true, "the System sheet did not open");
			assert.equal(reach.scrolled, 0, "the sheet had to be scrolled before this was measured");
			assert.equal(reach.beforeSettings, true,
				"the keyboard and the mouse are below the settings again: on a real device that is under the fold");
			for (const what of ["keyboard-window", "mouse-window"]) {
				assert.equal(reach[what].firstScreenful, true,
					`${what} is not in the first screenful of the sheet: it has to be found by scrolling`);
				assert.equal(reach[what].topmost, true, `${what} is covered by something else`);
				assert.ok(reach[what].tall >= MIN_TARGET, `${what} is ${reach[what].tall}px tall`);
			}

			await tap(pg, await pg.eval(centre(`#system-menu [data-wm-window-show="keyboard-window"]`)));
			const typing = await pg.eval(`(() => {
				const bar = document.getElementById("hid-type-input");
				const r = bar.getBoundingClientRect();
				const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
				return {
					"open": !document.getElementById("keyboard-window").classList.contains("hidden"),
					"barOnScreen": (r.height > 0 && r.bottom <= window.innerHeight),
					"barTappable": (bar === top || bar.contains(top)),
				};
			})()`);
			assert.equal(typing.open, true, "the Keyboard button did not open the keyboard");
			assert.equal(typing.barOnScreen, true,
				"the typing bar -- the only thing that raises the phone's own keyboard -- is not on screen");
			assert.equal(typing.barTappable, true, "the typing bar is covered");

			const collapsed = await pg.eval(
				`Math.round(document.getElementById("keyboard-window").getBoundingClientRect().height)`);
			await tap(pg, await pg.eval(centre("#keyboard-window-mouse-button")));
			// Past the 200ms blur debounce: the board used to unfold here.
			await new Promise((done) => setTimeout(done, 400));
			const pad = await pg.eval(`(() => {
				const el = document.getElementById("mouse-window");
				const kbd = document.getElementById("keyboard-window");
				const layers = [...document.querySelectorAll("#keyboard-compact [data-keypad-layer]")]
					.filter((row) => row.getBoundingClientRect().height > 0);
				return {
					"open": !el.classList.contains("hidden"),
					"onScreen": el.getBoundingClientRect().bottom <= window.innerHeight + 1,
					"typing": (document.documentElement.dataset.typing || ""),
					"layers": layers.length,
					"keyboard": Math.round(kbd.getBoundingClientRect().height),
				};
			})()`);
			await pg.close();
			assert.equal(pad.open, true, "the keyboard header did not open the mouse pad");
			assert.equal(pad.onScreen, true, "the mouse pad opened off the bottom of the screen");
			// Asking for the mouse is not asking to stop typing. Focus moving to
			// the button blurred the typing bar, and 200ms later the full
			// scancode board unfolded over the pad that had just been asked for.
			assert.equal(pad.typing, "1", "opening the pad dropped out of typing mode");
			assert.equal(pad.layers, 0,
				`the scancode board unfolded over the mouse pad: ${pad.layers} rows visible`);
			// Not exact: docking the pad above it re-runs the sheet geometry and
			// moves it by a pixel or two. An unfolded board is +200px.
			assert.ok(pad.keyboard <= collapsed + 10,
				`the keyboard sheet grew from ${collapsed}px to ${pad.keyboard}px when the pad opened`);
		});
	}
});

describe("nothing is painted underneath a window's own header", {"skip": chromiumPath() ? false : "no chromium available"}, () => {
	// A window header is position: absolute, so the window has to RESERVE its
	// height in padding. Those were two separate numbers, and a compact rule
	// grew the header for a finger without growing the padding -- so 13-14px of
	// the video, of the mouse buttons and of the keyboard's layer picker were
	// painted underneath it. Reported from a phone as "some keys are cut off at
	// the top" and "the stream toolbar is covering a portion of the screen".
	//
	// Content BELOW the fold of a scrolling sheet is reachable; content behind
	// the header never is, at any scroll position.
	const BEHIND = `(() => {
		const out = [];
		for (const win of document.querySelectorAll("div.window")) {
			const wr = win.getBoundingClientRect();
			if (wr.height === 0) { continue; }
			const header = win.querySelector(".window-header");
			if (header === null) { continue; }
			const hr = header.getBoundingClientRect();
			if (hr.height === 0) { continue; }
			for (const el of win.querySelectorAll("div.key, div.keypad-row, div.keypad-layers, input, div#stream-box, div.buttons-row")) {
				if (header.contains(el)) { continue; } // the header's own controls
				const r = el.getBoundingClientRect();
				if (r.height === 0 || r.width === 0) { continue; }
				// Only the part that scrolling can never reveal.
				const hidden = Math.round(Math.min(hr.bottom, r.bottom) - Math.max(hr.top, r.top));
				if (hidden > 0 && win.scrollTop === 0) {
					out.push({
						"win": win.id,
						"el": (el.id || el.className).slice(0, 30),
						"code": (el.dataset.keypadCode || ""),
						"hidden": hidden,
					});
				}
			}
		}
		return out;
	})()`;

	for (const [width, height] of [[390, 844], [390, 640], [320, 568]]) {
		test(`every open window at ${width}x${height}`, async () => {
			const pg = await open(width, {height});
			await pg.eval(SHOW_KEYBOARD);
			const seen = [];
			// Typing mode, the full board, and the pad on top of both: three
			// different sheet heights, which is what moves the content under
			// the header.
			seen.push(["typing", await pg.eval(BEHIND)]);
			await pg.eval(showLayer("abc"));
			seen.push(["board", await pg.eval(BEHIND)]);
			await tap(pg, await pg.eval(centre("#keyboard-window-mouse-button")));
			await new Promise((done) => setTimeout(done, 400));
			seen.push(["pad", await pg.eval(BEHIND)]);
			await pg.close();
			for (const [what, behind] of seen) {
				assert.deepEqual(behind, [],
					`${width}x${height}, ${what}: painted under a window header, where no scroll can reach it`);
			}
		});
	}
});

describe("the host's screen takes a click from a finger", {"skip": chromiumPath() ? false : "no chromium available"}, () => {
	// want: how many HID events this gesture should produce. 0 means "nothing",
	// and that case waits out the window rather than racing it.
	async function gesture(run, {width = 390, before = null, want = 0} = {}) {
		const pg = await open(width);
		if (before !== null) {
			await pg.eval(before);
		}
		await pg.eval(HID_START);
		const box = await pg.eval(centre("#stream-box"));
		await run(pg, box);
		const sent = await hidSettled(pg, want, (want > 0 ? 2000 : 1200));
		await pg.close();
		return sent.filter((what) => what.startsWith("mouse "));
	}

	test("a tap is a left click on the host", async () => {
		assert.deepEqual(await gesture((pg, box) => tap(pg, box), {"want": 2}),
			["mouse left down", "mouse left up"]);
	});

	test("a long press is a right click, sent when the finger lifts", async () => {
		assert.deepEqual(await gesture((pg, box) => tap(pg, box, 650), {"want": 2}),
			["mouse right down", "mouse right up"]);
	});

	test("an armed right click is shown, and can still be abandoned", async () => {
		const pg = await open();
		const box = await pg.eval(centre("#stream-box"));
		await pg.eval(HID_START);
		await pg.touch("touchStart", [box]);
		const before_arm = await pg.eval(classOf("#stream-box"));
		await new Promise((done) => setTimeout(done, 650));
		const armed = await pg.eval(`(() => {
			const el = document.getElementById("stream-box");
			return {"cls": el.className, "outline": getComputedStyle(el, "::before").outlineStyle};
		})()`);
		await pg.touch("touchMove", [{"x": box.x + 60, "y": box.y + 60}]);
		const after_move = await pg.eval(classOf("#stream-box"));
		await pg.touch("touchEnd", []);
		const sent = (await hidSettled(pg, 0, 1200)).filter((what) => what.startsWith("mouse "));
		await pg.close();
		assert.doesNotMatch(before_arm, /click-armed/, "nothing is promised before the threshold");
		assert.match(armed.cls, /\bstream-box-click-armed\b/,
			"a 500ms promotion with no warning is the defect this phase fixed for the keypad");
		assert.equal(armed.outline, "solid", "and the warning has to be something you can see");
		assert.doesNotMatch(after_move, /click-armed/, "moving away takes the offer back");
		assert.deepEqual(sent, [], "so lifting sends nothing");
	});

	test("a finger left resting on the video sends nothing at all", async () => {
		assert.deepEqual(await gesture((pg, box) => tap(pg, box, 2300)), []);
	});

	test("two fingers never click, however still they are", async () => {
		// An under-travelled two-finger scroll is the gesture an operator makes
		// by reflex on a video pane. A middle click pastes the X11 PRIMARY
		// selection, which at a root shell executes whatever it holds.
		for (const travel of [0, 8]) {
			const sent = await gesture(async (pg, box) => {
				const a = {"x": box.x - 30, "y": box.y, "id": 1};
				const b = {"x": box.x + 30, "y": box.y, "id": 2};
				await pg.touch("touchStart", [a, b]);
				if (travel > 0) {
					await pg.touch("touchMove", [
						{...a, "y": a.y + travel}, {...b, "y": b.y + travel},
					]);
				}
				await pg.touch("touchEnd", []);
			});
			assert.deepEqual(sent, [], `two fingers travelling ${travel}px`);
		}
	});

	test("a finger resting elsewhere on the page does not change what a tap means", async () => {
		// `ev.touches` is every contact on the SCREEN, and a touch dispatches
		// only to the element it started on -- so the video is told about a
		// thumb parked below it and never told when it lifts.
		const sent = await gesture(async (pg, box) => {
			const thumb = {"x": 20, "y": 820, "id": 9};
			await pg.touch("touchStart", [thumb]);
			await pg.touch("touchStart", [thumb, {"x": box.x, "y": box.y, "id": 1}]);
			await pg.touch("touchEnd", [{"x": box.x, "y": box.y, "id": 1}]);
			await pg.touch("touchEnd", [thumb]);
		}, {"want": 2});
		assert.deepEqual(sent, ["mouse left down", "mouse left up"],
			"the tap on the video is a plain left click, whatever else is on the glass");
	});

	test("a drag moves the cursor and clicks nothing", async () => {
		assert.deepEqual(await gesture(async (pg, box) => {
			await pg.touch("touchStart", [box]);
			await pg.touch("touchMove", [{"x": box.x + 70, "y": box.y + 50}]);
			await pg.touch("touchEnd", []);
		}), []);
	});

	test("a cancelled touch clicks nothing", async () => {
		// A system gesture or an incoming call, mid-tap. Clicking the host
		// because the browser took the gesture away is not acceptable.
		assert.deepEqual(await gesture(async (pg, box) => {
			await pg.touch("touchStart", [box]);
			await pg.touch("touchCancel", []);
		}), []);
	});

	test("the tap that dismisses a menu does not also click the host", async () => {
		// It lands on the video, because that is what is under the sheet.
		const pg = await open();
		await pg.eval(HID_START);
		await tap(pg, await pg.eval(centre("#navbar-menu-button")));
		await tap(pg, await pg.eval(centre("#system-dropdown .menu-button")));
		const open_menu = await pg.eval(`(() => {
			const m = document.getElementById("system-menu");
			return {"open": !m.classList.contains("hidden"),
				"under": document.elementFromPoint(20, 100).id};
		})()`);
		await tap(pg, {"x": 20, "y": 100});
		const sent = (await hidSettled(pg, 0, 1200)).filter((what) => what.startsWith("mouse "));
		const closed = await pg.eval(`document.getElementById("system-menu").classList.contains("hidden")`);
		await pg.close();
		assert.equal(open_menu.open, true, "the sheet has to be open for this to mean anything");
		assert.equal(open_menu.under, "stream-box", "and the video has to be what the tap lands on");
		assert.equal(closed, true, "the tap dismisses the sheet");
		assert.deepEqual(sent, [], "and dismissing is not clicking");
	});

	test("a latched mouse button is left alone: the video stops clicking mid-drag", async () => {
		// A long press on the pad's Left latches it -- the only way to drag on
		// the host from a phone. emit() on an already-down button RELEASES it,
		// so a tap used to end the drag and send nothing.
		const pg = await open();
		await pg.eval(`document.querySelector('[data-wm-window-show="keyboard-window"]').click();
			document.querySelector('#keyboard-window-header [data-wm-window-show="mouse-window"]').click(); true`);
		const pad = await pg.eval(centre(`#mouse-buttons [data-keypad-code="left"]`));
		await tap(pg, pad, 650);
		const latched = await pg.eval(classOf(`#mouse-buttons [data-keypad-code="left"]`));
		await pg.eval(HID_START);
		const box = await pg.eval(centre("#stream-box"));
		await tap(pg, box);
		await tap(pg, box, 650);
		const sent = (await hidSettled(pg, 0, 1200)).filter((what) => what.startsWith("mouse "));
		const still = await pg.eval(classOf(`#mouse-buttons [data-keypad-code="left"]`));
		await pg.close();
		assert.match(latched, /\bholded\b/, "the long press has to latch the pad button");
		assert.deepEqual(sent, [], "no click while a button is held down on the host");
		assert.match(still, /\bholded\b/, "and the drag survives being tapped at");
	});

	test("turning tap-to-click off turns it off", async () => {
		const sent = await gesture((pg, box) => tap(pg, box), {
			"before": `(() => {
				const el = document.getElementById("hid-mouse-tap-click-switch");
				el.checked = false;
				el.dispatchEvent(new Event("change", {"bubbles": true}));
				return true;
			})()`,
		});
		assert.deepEqual(sent, []);
	});

	test("the button is held long enough to be a click, whichever it is", async () => {
		// Press and release in the same millisecond is a valid HID sequence,
		// and a real click has a duration -- it is also the only acknowledgement
		// a phone user gets, since there is no cursor under their finger.
		for (const [button, hold] of [["left", 0], ["right", 650]]) {
			const pg = await open();
			await pg.eval(`(() => {
				window.__at = [];
				const el = document.querySelector('#mouse-buttons [data-keypad-code="${button}"]');
				new MutationObserver(() => window.__at.push(performance.now())).observe(
					el, {"attributes": true, "attributeFilter": ["class"]});
				return true;
			})()`);
			await tap(pg, await pg.eval(centre("#stream-box")), hold);
			await new Promise((done) => setTimeout(done, 200));
			const at = await pg.eval(`window.__at`);
			await pg.close();
			assert.equal(at.length, 2, `${button}: one press and one release`);
			const held = at[1] - at[0];
			assert.ok(held >= 45 && held < 200,
				`${button} was held ${Math.round(held)}ms, which is not a 50ms click`);
		}
	});
});

describe("the console is already zoomed when a phone opens it", {"skip": chromiumPath() ? false : "no chromium available"}, () => {
	// The picture is pixels: a 1920x1080 console on a 390px phone is 4.8px per
	// character and there is no font to change. Zooming in by hand after every
	// page load is not a thing anyone should have to do, so the view starts
	// where the user left the setting.
	const PICTURE = `(() => {
		const img = document.getElementById("stream-image");
		return {
			"transform": getComputedStyle(img).transform,
			"slider": document.getElementById("stream-zoom-slider").value,
			"label": document.getElementById("stream-zoom-value").innerText,
		};
	})()`;

	test("a phone starts zoomed in, a desktop does not", async () => {
		const phone = await open(390);
		const on_phone = await phone.eval(PICTURE);
		await phone.close();
		const desk = await open(1280, {"touch": false, "height": 900});
		const on_desk = await desk.eval(PICTURE);
		await desk.close();

		assert.match(on_phone.transform, /^matrix\(2\.5,/,
			`the console opened at ${on_phone.transform} on a phone`);
		assert.equal(on_phone.label, "250%", "the setting has to say what it did");
		assert.equal(on_desk.transform, "none", "the desktop console must not be zoomed");
	});

	test("a phone that has already chosen a zoom keeps it", async () => {
		// The slider writes its default to storage on the first load, so the
		// stored value -- not the constant -- is what a returning phone gets.
		const pg = await browser.newPage();
		await pg.setViewport(390, 844, true);
		await pg.setTouch(true, 5);
		await pg.clearStorage(server.origin);
		await pg.goto(`${server.origin}/${KVM}`);
		await pg.eval(`(() => {
			localStorage.setItem("stream.zoom", "1.25");
			localStorage.setItem("stream.zoom.bumped", "1");
			return true;
		})()`);
		await pg.goto(`${server.origin}/${KVM}`);
		const m = await pg.eval(PICTURE);
		await pg.close();
		assert.match(m.transform, /^matrix\(1\.25,/,
			`a stored 125% opened at ${m.transform} -- the setting is not being read`);
		assert.equal(m.label, "125%");
	});

	test("two fingers zoom further and pan, and neither reaches the host", async () => {
		const pg = await open(390);
		await pg.eval(HID_START);
		const box = await pg.eval(centre("#stream-box"));
		const spread = async (from, to) => {
			await pg.touch("touchStart", [{"x": box.x - from, "y": box.y, "id": 1}, {"x": box.x + from, "y": box.y, "id": 2}]);
			// Two frames: the first has no previous frame to measure against.
			await pg.touch("touchMove", [{"x": box.x - (from + to) / 2, "y": box.y, "id": 1}, {"x": box.x + (from + to) / 2, "y": box.y, "id": 2}]);
			await pg.touch("touchMove", [{"x": box.x - to, "y": box.y, "id": 1}, {"x": box.x + to, "y": box.y, "id": 2}]);
			await pg.touch("touchEnd", []);
		};
		await spread(40, 110);
		const zoomed = await pg.eval(PICTURE);
		await pg.touch("touchStart", [{"x": box.x - 40, "y": box.y, "id": 1}, {"x": box.x + 40, "y": box.y, "id": 2}]);
		await pg.touch("touchMove", [{"x": box.x - 40, "y": box.y - 30, "id": 1}, {"x": box.x + 40, "y": box.y - 30, "id": 2}]);
		await pg.touch("touchMove", [{"x": box.x - 40, "y": box.y - 70, "id": 1}, {"x": box.x + 40, "y": box.y - 70, "id": 2}]);
		await pg.touch("touchEnd", []);
		const panned = await pg.eval(PICTURE);
		const sent = (await hidSettled(pg, 0, 1000)).filter((what) => what.startsWith("mouse "));
		await pg.close();

		const scaleOf = (t) => Number(t.slice(t.indexOf("(") + 1).split(",")[0]);
		assert.ok(scaleOf(zoomed.transform) > 2.2,
			`a spread took the console to ${zoomed.transform}`);
		assert.notEqual(panned.transform, zoomed.transform, "a two-finger drag did not pan the view");
		assert.deepEqual(sent, [], "two fingers moved the view -- they must send nothing to the host");
	});

	test("a tap lands where the finger is, not where it would be at 1x", async () => {
		// The one that matters: zoomed 2x from the top-left, 100px along the
		// glass is 50px into the host's screen. A click that skips that lands a
		// long way from where it was meant.
		const at = async function(zoom) {
			const pg = await open(390);
			await pg.eval(`(() => {
				const el = document.getElementById("stream-zoom-slider");
				el.value = "${zoom}";
				el.dispatchEvent(new Event("input", {"bubbles": true}));
				el.dispatchEvent(new Event("change", {"bubbles": true}));
				window.__abs = [];
				const real = console.log;
				console.log = function(...args) {
					if (String(args[1]) === "Mouse: abs:") {
						window.__abs.push(args[2]);
					}
					return real.apply(console, args);
				};
				return true;
			})()`);
			const box = await pg.eval(`(() => {
				const r = document.getElementById("stream-box").getBoundingClientRect();
				return {"left": Math.round(r.left), "top": Math.round(r.top)};
			})()`);
			await pg.touch("touchStart", [{"x": box.left + 100, "y": box.top + 50}]);
			await pg.touch("touchEnd", []);
			await new Promise((done) => setTimeout(done, 250));
			const abs = await pg.eval(`window.__abs`);
			await pg.close();
			assert.equal(abs.length >= 1, true, `no absolute move was sent at ${zoom}x`);
			return abs[0];
		};
		const plain = await at(1);
		const zoomed = await at(2);
		// Both are remapped into the HID range, so compare their positions
		// within it rather than raw pixels: half the distance from the left
		// edge is a smaller number, always.
		assert.ok(zoomed.x < plain.x && zoomed.y < plain.y,
			`the same tap reported ${JSON.stringify(zoomed)} zoomed and ${JSON.stringify(plain)} at 1x -- the zoom is not in the mapping`);
	});
});

describe("text recognition works without a pointer", {"skip": chromiumPath() ? false : "no chromium available"}, () => {
	// Opening it the way the Text menu does. The feature is hardware-gated and
	// the app re-applies that gate about a second after load, so the reveal and
	// the open happen in the same evaluate.
	const OPEN = `(() => {
		document.getElementById("stream-ocr").classList.remove("feature-disabled");
		document.getElementById("stream-ocr-button").click();
		return !document.getElementById("stream-ocr-window").classList.contains("hidden");
	})()`;

	// Every request the page makes, so "Recognize recognised something" is an
	// observation rather than an inference.
	const SPY = `(() => {
		window.__urls = [];
		const Real = window.XMLHttpRequest;
		window.XMLHttpRequest = function() {
			const xhr = new Real();
			const open = xhr.open.bind(xhr);
			xhr.open = function(method, url, ...rest) {
				window.__urls.push(url);
				return open(method, url, ...rest);
			};
			return xhr;
		};
		return true;
	})()`;

	// A fixed sleep is long enough on an idle machine and not on one running
	// four browsers at once: this waits for the thing itself.
	async function ocrRequests(pg, want, ms = 4000) {
		const until = Date.now() + ms;
		let urls = [];
		do {
			urls = await pg.eval(`window.__urls`);
			if (ocrParams(urls).length >= want) {
				break;
			}
			await new Promise((done) => setTimeout(done, 50));
		} while (Date.now() < until);
		return ocrParams(urls);
	}

	const ocrParams = (urls) => urls.filter((url) => url.includes("ocr=1")).map(function(url) {
		const q = new URLSearchParams(url.split("?")[1]);
		return ["left", "top", "right", "bottom"].reduce(function(out, side) {
			out[side] = Math.round(Number(q.get(`ocr_${side}`)));
			return out;
		}, {});
	});

	const BOX = `(() => {
		const el = document.getElementById("stream-ocr-selection");
		const r = el.getBoundingClientRect();
		return {
			"hidden": el.classList.contains("hidden"),
			"w": Math.round(r.width), "h": Math.round(r.height),
			"x": Math.round(r.left), "y": Math.round(r.top),
			"confirm": !document.getElementById("stream-ocr-confirm-button").disabled,
		};
	})()`;

	// Small and central, so the selection is nowhere near the clamp to the
	// video's own edges -- a box that is silently clipped would agree with
	// itself across devices and tell us nothing.
	async function boxAround(pg, dx = 40, dy = 30) {
		const at = await pg.eval(centre("#stream-box"));
		return {
			"from": {"x": Math.round(at.x - dx), "y": Math.round(at.y - dy)},
			"to": {"x": Math.round(at.x + dx), "y": Math.round(at.y + dy)},
			"w": dx * 2, "h": dy * 2,
		};
	}

	async function mouseDrag(pg, from, to) {
		await pg.mouse("mousePressed", from.x, from.y);
		await pg.mouse("mouseMoved", to.x, to.y);
		await pg.mouse("mouseReleased", to.x, to.y);
	}

	test("a finger draws exactly the box it was dragged, and so does a mouse", async () => {
		const pg = await open();
		assert.equal(await pg.eval(OPEN), true, "the overlay has to open");
		const want = await boxAround(pg);

		await pg.touch("touchStart", [want.from]);
		await pg.touch("touchMove", [want.to]);
		await pg.touch("touchEnd", []);
		const by_touch = await pg.eval(BOX);

		await mouseDrag(pg, want.from, want.to);
		const by_mouse = await pg.eval(BOX);
		await pg.close();

		assert.deepEqual(
			{"w": by_touch.w, "h": by_touch.h, "x": by_touch.x, "y": by_touch.y},
			{"w": want.w, "h": want.h, "x": want.from.x, "y": want.from.y},
			"the finger drew a different rectangle from the one it dragged");
		assert.equal(by_touch.hidden, false);
		assert.equal(by_touch.confirm, true, "and the box can then be recognised");
		assert.deepEqual(by_touch, by_mouse, "a finger and a mouse must select the same pixels");
	});

	test("Recognize recognises the selected region -- with a real mouse", async () => {
		// Dispatching a MouseEvent from inside the page runs no default action.
		// With a real one, pressing the button moved focus off the overlay, the
		// blur handler wiped the selection, and the click that followed found
		// nothing to recognise: the button was inert on the only device that
		// previously had a working path.
		const pg = await open(1280, {"touch": false, "height": 900});
		await pg.eval(SPY);
		await pg.eval(OPEN);
		const want = await boxAround(pg, 120, 80);
		await mouseDrag(pg, want.from, want.to);
		const drawn = await pg.eval(BOX);
		const at = await pg.eval(centre("#stream-ocr-confirm-button"));
		await pg.mouse("mousePressed", at.x, at.y);
		await pg.mouse("mouseReleased", at.x, at.y);
		const asked = await ocrRequests(pg, 1);
		const m = await pg.eval(`({
			"closed": document.getElementById("stream-ocr-window").classList.contains("hidden"),
		})`);
		await pg.close();
		assert.equal(drawn.w, want.w, "the box has to exist before the button can act on it");
		assert.equal(asked.length, 1, `Recognize issued ${asked.length} OCR requests, not one`);
		assert.ok(asked[0].left < asked[0].right && asked[0].top < asked[0].bottom,
			`the region is inside out: ${JSON.stringify(asked[0])}`);
		assert.equal(m.closed, true, "and the overlay gets out of the way afterwards");
	});

	test("the region follows the box that was drawn", async () => {
		// Two boxes, one further right and lower than the other. Nothing else
		// about the page changes, so the numbers have to move with it.
		const pg = await open(1280, {"touch": false, "height": 900});
		await pg.eval(SPY);
		for (const shift of [-50, 50]) {
			await pg.eval(OPEN);
			// Measured after the overlay is up: opening it also raises the
			// stream window, which moves the video under it.
			const at = await pg.eval(centre("#stream-box"));
			await mouseDrag(pg,
				{"x": Math.round(at.x + shift - 40), "y": Math.round(at.y + shift - 30)},
				{"x": Math.round(at.x + shift + 40), "y": Math.round(at.y + shift + 30)});
			const drawn = await pg.eval(BOX);
			assert.equal(drawn.w, 80, `the ${shift > 0 ? "second" : "first"} drag drew ${drawn.w}x${drawn.h}, so it was clamped`);
			const button = await pg.eval(centre("#stream-ocr-confirm-button"));
			await pg.mouse("mousePressed", button.x, button.y);
			await pg.mouse("mouseReleased", button.x, button.y);
			await ocrRequests(pg, (shift > 0 ? 2 : 1));
			// There is no kvmd behind this page, so the recognition fails and
			// wm.error puts a modal over everything -- including the overlay
			// the next drag needs. Dismissing it is part of the real flow, and
			// it has to be waited for: the modal appears when the request
			// FAILS, which is after the request was made.
			await pg.eval(`(async () => {
				for (let i = 0; i < 60; i++) {
					const ok = document.querySelector(".modal-window button");
					if (ok !== null) {
						ok.click();
						return true;
					}
					await new Promise((done) => setTimeout(done, 50));
				}
				throw new Error("the error modal never appeared, so the next drag would land on it");
			})()`);
		}
		const asked = await ocrRequests(pg, 2);
		await pg.close();
		assert.equal(asked.length, 2, "both selections had to be recognised");
		assert.ok(asked[1].left > asked[0].left && asked[1].right > asked[0].right,
			`the region did not move right with the box: ${JSON.stringify(asked)}`);
		assert.ok(asked[1].top > asked[0].top && asked[1].bottom > asked[0].bottom,
			`the region did not move down with the box: ${JSON.stringify(asked)}`);
	});

	test("Recognize works for a finger too, and Cancel recognises nothing", async () => {
		for (const [button, want_urls, name] of [
			["stream-ocr-confirm-button", 1, "Recognize"],
			["stream-ocr-cancel-button", 0, "Cancel"],
		]) {
			const pg = await open();
			await pg.eval(SPY);
			await pg.eval(OPEN);
			const want = await boxAround(pg);
			await pg.touch("touchStart", [want.from]);
			await pg.touch("touchMove", [want.to]);
			await pg.touch("touchEnd", []);
			const at = await pg.eval(centre(`#${button}`));
			await tap(pg, at);
			const asked = await ocrRequests(pg, Math.max(want_urls, 1), (want_urls === 0 ? 1000 : 4000));
			const m = await pg.eval(`({
				"closed": document.getElementById("stream-ocr-window").classList.contains("hidden"),
			})`);
			await pg.close();
			assert.equal(asked.length, want_urls, `${name} asked for the wrong thing`);
			assert.equal(m.closed, true, `${name} left the overlay open`);
		}
	});

	test("a drag released over the buttons still finishes, and does not poison the next one", async () => {
		// The release used to be dropped -- either by a guard, or by the engine
		// suppressing events on the disabled button -- leaving the anchor set.
		// Every later selection was then drawn from a corner the user chose
		// once, silently, and THAT is the rectangle that got recognised.
		const pg = await open(1280, {"touch": false, "height": 900});
		await pg.eval(OPEN);
		const at = await pg.eval(centre("#stream-box"));
		const controls = await pg.eval(centre("#stream-ocr-confirm-button"));
		await mouseDrag(pg, {"x": Math.round(at.x), "y": Math.round(at.y)}, controls);
		const first = await pg.eval(BOX);
		const want = await boxAround(pg);
		await mouseDrag(pg, want.from, want.to);
		const second = await pg.eval(BOX);
		await pg.close();
		assert.ok(first.w > 1 && first.h > 1, "the first drag has to have drawn something");
		assert.deepEqual(
			{"w": second.w, "h": second.h, "x": second.x, "y": second.y},
			{"w": want.w, "h": want.h, "x": want.from.x, "y": want.from.y},
			"the second box was anchored to the first drag's corner");
	});

	test("a drag that ENDS on the buttons is the box that gets recognised", async () => {
		// The release over a control used to be dropped, so the box on screen
		// and the region in __sel disagreed: the user drew a new rectangle,
		// pressed Recognize, and got the text from the PREVIOUS one.
		const region = async function(redraw) {
			const pg = await open(1280, {"touch": false, "height": 900});
			await pg.eval(SPY);
			await pg.eval(OPEN);
			const at = await pg.eval(centre("#stream-box"));
			const button = await pg.eval(centre("#stream-ocr-confirm-button"));
			await mouseDrag(pg,
				{"x": Math.round(at.x - 200), "y": Math.round(at.y - 100)},
				{"x": Math.round(at.x - 120), "y": Math.round(at.y - 40)});
			if (redraw) {
				// The second box ends ON the button, which is where a downward
				// drag towards it naturally finishes.
				await mouseDrag(pg, {"x": Math.round(at.x + 40), "y": Math.round(at.y)}, button);
			}
			await pg.mouse("mousePressed", button.x, button.y);
			await pg.mouse("mouseReleased", button.x, button.y);
			const asked = await ocrRequests(pg, 1);
			await pg.close();
			assert.equal(asked.length, 1, `${redraw ? "two boxes" : "one box"}: expected exactly one request`);
			return asked[0];
		};
		const first_only = await region(false);
		const redrawn = await region(true);
		assert.ok(redrawn.left > first_only.left && redrawn.top > first_only.top,
			`Recognize used a box the user had replaced: ${JSON.stringify({first_only, redrawn})}`);
	});

	test("a cancelled drag leaves no selection behind", async () => {
		const pg = await open();
		await pg.eval(OPEN);
		const want = await boxAround(pg);
		await pg.touch("touchStart", [want.from]);
		await pg.touch("touchMove", [want.to]);
		await pg.touch("touchCancel", []);
		const after = await pg.eval(BOX);
		await pg.close();
		assert.equal(after.hidden, true, "a gesture the system took away did not select anything");
		assert.equal(after.confirm, false, "and there is nothing to recognise");
	});

	test("the buttons are reachable, on screen, and do not draw a box behind them", async () => {
		for (const width of [320, 390]) {
			const pg = await open(width);
			await pg.eval(OPEN);
			const want = await boxAround(pg);
			await pg.touch("touchStart", [want.from]);
			await pg.touch("touchMove", [want.to]);
			await pg.touch("touchEnd", []);
			const drawn = await pg.eval(BOX);

			const m = await pg.eval(`(() => {
				const out = {};
				for (const id of ["stream-ocr-confirm-button", "stream-ocr-cancel-button"]) {
					const el = document.getElementById(id);
					const r = el.getBoundingClientRect();
					const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
					out[id] = {
						"w": r.width, "h": r.height,
						"onscreen": (r.left >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight),
						"topmost": (el === top || el.contains(top)),
					};
				}
				return out;
			})()`);

			const at = await pg.eval(centre("#stream-ocr-confirm-button"));
			await pg.touch("touchStart", [at]);
			const after = await pg.eval(BOX);
			await pg.touch("touchEnd", []);
			await pg.close();

			for (const [id, got] of Object.entries(m)) {
				assert.ok(got.w >= MIN_TARGET && got.h >= MIN_TARGET,
					`${width}px: ${id} is ${got.w}x${got.h}`);
				assert.equal(got.onscreen, true, `${width}px: ${id} is off the screen`);
				assert.equal(got.topmost, true, `${width}px: ${id} is covered`);
			}
			assert.ok(drawn.w > 1 && drawn.h > 1, `${width}px: nothing was drawn to protect`);
			assert.deepEqual(after, drawn, `${width}px: touching the button wiped the selection behind it`);
		}
	});

	test("the feature is no longer switched off where the pointer cannot hover", async () => {
		// The gate lived in setState, which only a live session calls -- so it
		// was guarded by a grep for two literal strings, which any other
		// spelling walks straight past. The module takes a geometry callback
		// and nothing else, so the real thing is three lines away.
		const pg = await open();
		const m = await pg.eval(`(async () => {
			const mod = await import("/share/js/kvm/ocr.js");
			const geo = () => ({"x": 0, "y": 0, "width": 100, "height": 100, "real_width": 100, "real_height": 100});
			new mod.Ocr(geo).setState({"enabled": true, "langs": {"available": ["eng"], "default": "eng"}});
			return {
				"hover": matchMedia("(hover: hover)").matches,
				"enabled": !document.getElementById("stream-ocr").classList.contains("feature-disabled"),
				"led": document.getElementById("stream-ocr-led").className,
			};
		})()`);
		await pg.close();
		assert.equal(m.hover, false, "a device that cannot hover -- which used to disable OCR outright");
		assert.equal(m.enabled, true, "the Text menu has to offer OCR on a phone");
		assert.equal(m.led, "led-gray", "and its LED has to say the feature is there");
	});
});
