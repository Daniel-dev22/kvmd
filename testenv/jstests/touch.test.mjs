// Input from a finger, measured in a real engine with a real touchscreen.
//
// Everything here is a capability the UI HAD for a mouse and did not have for a
// finger: locking a modifier, seeing that a key is about to latch, clicking the
// host's screen at all, and selecting text to recognise. The touches are
// dispatched through the browser's own input pipeline -- hit-tested, with real
// TouchEvents -- because a synthetic event handed straight to a listener proves
// only that the listener exists.

import test, {before, after, describe} from "node:test";
import assert from "node:assert/strict";
import {serveWeb, launchBrowser, chromiumPath} from "./browser.mjs";
import {read} from "./helpers.mjs";

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

// Two claims cannot be measured in the page: the OCR gate lives in setState,
// which only a live kvmd session calls, and a CSS rule that matches nothing is
// invisible to a test that never looks for it. Both are asserted at the source.
describe("what the page cannot be asked", () => {
	test("text recognition is not gated on the pointer being able to hover", () => {
		// __enabled = (state.enabled && matchMedia("(hover: hover)").matches)
		// turned the whole feature off on every phone. setState is reached only
		// from a session update, so nothing below can exercise it.
		// matchMedia is the only way a module can ask; the prose about why the
		// gate went is allowed to mention it.
		assert.doesNotMatch(read("web/share/js/kvm/ocr.js"), /HOVER_QUERY|matchMedia/,
			"kvm/ocr.js must not decide anything from whether the device can hover");
	});

	test("the latch warning is not gated on hover either", () => {
		const css = read("web/share/css/keypad.css");
		const rule = css.split("\n").find((line) => line.includes("keypad-animate-holding")
			|| (line.includes("div.pressed") && line.includes("allow-autohold")));
		assert.ok(rule, "the about-to-latch rule has gone missing");
		assert.doesNotMatch(rule, /:hover/,
			"a finger can never satisfy :hover, and the latch it warns about happens anyway");
	});

	test("the class that rule keys on is one the code actually sets", () => {
		// A rule matching nothing looks exactly like a rule that works.
		assert.match(read("web/share/css/keypad.css"), /div\.pressed\.holding/);
		assert.match(read("web/share/js/keypad.js"), /classList\.toggle\("holding"/);
	});
});

// touch=true gives the page an actual touchscreen: without it the engine
// answers `pointer: coarse` and `hover: none` the way a desktop does, and every
// assertion below would be measuring a mouse.
async function open(width = 390, {touch = true, height = 844} = {}) {
	const pg = await browser.newPage();
	await pg.setViewport(width, height, touch);
	await pg.setTouch(touch, 5);
	await pg.clearStorage(server.origin);
	await pg.goto(`${server.origin}/${KVM}`);
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

// The keyboard window is opened the way a user opens it, so the layout under
// test is the one the window manager actually produces. It opens in typing
// mode, where the scancode layers are put away and the phone's own keyboard
// does the letters -- so a test that wants a scancode key has to ask for its
// layer, exactly as a user would.
const SHOW_KEYBOARD = `document.querySelector('[data-wm-window-show="keyboard-window"]').click()`;
const LAYERS = ["abc", "sym", "fn", "num", "intl"];
const showLayer = (layer) => `document.querySelector('[data-keypad-layer-button="${layer}"]').click()`;

describe("a finger reaches every modifier state", {"skip": chromiumPath() ? false : "no chromium available"}, () => {
	test("tapping a modifier latches it, again locks it, again releases it", async () => {
		const pg = await open();
		await pg.eval(SHOW_KEYBOARD);
		const sel = `#keyboard-compact [data-keypad-code="ControlLeft"]`;
		const at = await pg.eval(centre(sel));
		const seen = [];
		for (let i = 0; i < 3; i++) {
			await tap(pg, at);
			seen.push(await pg.eval(classOf(sel)));
		}
		await pg.close();
		assert.deepEqual(seen, ["key holded", "key locked", "key"],
			"a finger has no middle or right button: the states have to be reachable by tapping");
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

		await tap(pg, at_ctrl); // held
		await tap(pg, at_ctrl); // locked
		await tap(pg, at_letter);
		const after_locked = await pg.eval(classOf(ctrl));
		await pg.close();

		assert.equal(after_held, "key", "a held modifier is released by the next key");
		assert.equal(after_locked, "key locked", "a locked modifier is not");
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
		await pg.eval(SHOW_KEYBOARD);
		await pg.eval(showLayer("fn"));
		const sel = `#keyboard-compact [data-keypad-code="PrintScreen"]`;
		const at = await pg.eval(centre(sel));
		await pg.touch("touchStart", [at]);
		const down = await pg.eval(classOf(sel));
		await pg.touch("touchEnd", []);
		const up = await pg.eval(classOf(sel));
		await pg.close();
		assert.match(down, /\bpressed\b/, "the key goes down under the finger");
		assert.equal(up, "key", "and comes back up when it lifts -- it must not latch");
	});

	test("a long press latches a key that allows it, and a tap then locks it", async () => {
		const pg = await open();
		await pg.eval(SHOW_KEYBOARD);
		await pg.eval(showLayer("fn"));
		const sel = `#keyboard-compact [data-keypad-code="PrintScreen"]`;
		const at = await pg.eval(centre(sel));
		await tap(pg, at, 650);
		const held = await pg.eval(classOf(sel));
		await tap(pg, at);
		const locked = await pg.eval(classOf(sel));
		await tap(pg, at);
		const off = await pg.eval(classOf(sel));
		await pg.close();
		assert.equal(held, "key holded");
		assert.equal(locked, "key locked", "lock was unreachable without a middle mouse button");
		assert.equal(off, "key");
	});

	test("the about-to-latch warning is drawn to a finger", async () => {
		// It used to be gated on :hover, which a finger can never satisfy: the
		// key latched after 500ms with nothing on screen to say it was coming.
		const pg = await open();
		await pg.eval(SHOW_KEYBOARD);
		await pg.eval(showLayer("fn"));
		const sel = `#keyboard-compact [data-keypad-code="PrintScreen"]`;
		await pg.touch("touchStart", [await pg.eval(centre(sel))]);
		const m = await pg.eval(`(() => {
			const el = document.querySelector(${JSON.stringify(sel)});
			const cs = getComputedStyle(el);
			return {
				"cls": el.className,
				"animation": cs.animationName,
				"gradient": cs.backgroundImage.startsWith("linear-gradient"),
				"hover": matchMedia("(hover: hover)").matches,
			};
		})()`);
		await pg.touch("touchEnd", []);
		await pg.close();
		assert.equal(m.hover, false, "this device cannot hover -- which is the point of the test");
		assert.match(m.cls, /\bholding\b/, "keypad.js has to mark the key while the latch is armed");
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
			el.dispatchEvent(new KeyboardEvent("keydown", {"code": "ControlLeft", "bubbles": true}));
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

describe("the host's screen takes a click from a finger", {"skip": chromiumPath() ? false : "no chromium available"}, () => {
	// The on-screen mouse buttons are where a click becomes visible: emit()
	// drives the same keypad the Mouse window shows, so watching its classes
	// watches what was actually sent.
	const WATCH = `(() => {
		window.__seen = [];
		for (const code of ["left", "right", "middle"]) {
			const el = document.querySelector('#mouse-buttons [data-keypad-code="' + code + '"]');
			new MutationObserver(function() {
				if (el.classList.contains("pressed")) { window.__seen.push(code); }
			}).observe(el, {"attributes": true, "attributeFilter": ["class"]});
		}
		return true;
	})()`;

	async function gesture(run) {
		const pg = await open();
		await pg.eval(WATCH);
		const box = await pg.eval(centre("#stream-box"));
		await run(pg, box);
		await new Promise((done) => setTimeout(done, 150));
		const seen = await pg.eval(`window.__seen`);
		await pg.close();
		return seen;
	}

	test("a tap is a left click", async () => {
		assert.deepEqual(await gesture((pg, box) => tap(pg, box)), ["left"]);
	});

	test("a long press is a right click", async () => {
		assert.deepEqual(await gesture((pg, box) => tap(pg, box, 650)), ["right"]);
	});

	test("two fingers are a middle click", async () => {
		assert.deepEqual(await gesture(async (pg, box) => {
			await pg.touch("touchStart", [{"x": box.x - 30, "y": box.y, "id": 1}, {"x": box.x + 30, "y": box.y, "id": 2}]);
			await pg.touch("touchEnd", []);
		}), ["middle"]);
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

	test("the button is held long enough to be a click", async () => {
		// Press and release in the same millisecond is a valid HID sequence
		// that a polling BIOS can sit straight through.
		const pg = await open();
		await pg.eval(`(() => {
			window.__at = [];
			const el = document.querySelector('#mouse-buttons [data-keypad-code="left"]');
			new MutationObserver(() => window.__at.push([performance.now(), el.className])).observe(
				el, {"attributes": true, "attributeFilter": ["class"]});
			return true;
		})()`);
		await tap(pg, await pg.eval(centre("#stream-box")));
		await new Promise((done) => setTimeout(done, 200));
		const at = await pg.eval(`window.__at`);
		await pg.close();
		assert.equal(at.length, 2, "one press and one release");
		assert.ok(at[1][0] - at[0][0] >= 40, `the button was held ${Math.round(at[1][0] - at[0][0])}ms`);
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

	test("a finger draws the same box a mouse does", async () => {
		const from = {"x": 120, "y": 300};
		const to = {"x": 280, "y": 430};
		const pg = await open();
		assert.equal(await pg.eval(OPEN), true, "the overlay has to open");

		await pg.touch("touchStart", [from]);
		await pg.touch("touchMove", [to]);
		await pg.touch("touchEnd", []);
		const by_touch = await pg.eval(BOX);

		await pg.eval(`(() => {
			const el = document.getElementById("stream-ocr-window");
			for (const [type, p] of [["mousedown", ${JSON.stringify(from)}], ["mousemove", ${JSON.stringify(to)}], ["mouseup", ${JSON.stringify(to)}]]) {
				el.dispatchEvent(new MouseEvent(type, {"clientX": p.x, "clientY": p.y, "bubbles": true}));
			}
			return true;
		})()`);
		const by_mouse = await pg.eval(BOX);
		await pg.close();

		assert.ok(by_touch.w > 1 && by_touch.h > 1,
			`the finger drew nothing: ${JSON.stringify(by_touch)}`);
		assert.equal(by_touch.hidden, false);
		assert.equal(by_touch.confirm, true, "and the box can then be recognised");
		assert.deepEqual(by_touch, by_mouse, "a finger and a mouse must select the same pixels");
	});

	test("the buttons are reachable, on screen, and do not draw a box behind them", async () => {
		for (const width of [320, 390]) {
			const pg = await open(width);
			await pg.eval(OPEN);
			await pg.touch("touchStart", [{"x": 100, "y": 300}]);
			await pg.touch("touchMove", [{"x": 240, "y": 420}]);
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

	test("the overlay opens and is usable on a device that cannot hover", async () => {
		const pg = await open();
		const m = await pg.eval(`(() => {
			document.getElementById("stream-ocr").classList.remove("feature-disabled");
			document.getElementById("stream-ocr-button").click();
			return {
				"hover": matchMedia("(hover: hover)").matches,
				"open": !document.getElementById("stream-ocr-window").classList.contains("hidden"),
			};
		})()`);
		await pg.close();
		assert.equal(m.hover, false, "a device that cannot hover -- which used to disable OCR outright");
		assert.equal(m.open, true);
		// What this does NOT prove is that the gate is gone from setState; see
		// "what the page cannot be asked" above for that one.
	});
});
