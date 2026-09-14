// Press/release binding. The release path must also fire when a touch is
// CANCELLED -- a system gesture, an incoming call or the browser taking over
// the gesture. Without it the key stays down on the target machine, which is a
// fault on the host we are administering, not a cosmetic bug in the page.

import test from "node:test";
import assert from "node:assert/strict";
import {read, jsFiles} from "./helpers.mjs";
import {setOnClick, setOnDown, setOnDrag, setOnUp, dragPoint} from "../../web/share/js/events.js";

const fakeEvent = () => {
	let prevented = false;
	return {"preventDefault": () => (prevented = true), "wasPrevented": () => prevented};
};

test("a press binds both mouse and touch", () => {
	const el = {};
	let calls = 0;
	setOnDown(el, () => calls++);
	assert.equal(typeof el.onmousedown, "function");
	assert.equal(typeof el.ontouchstart, "function");
	el.onmousedown(fakeEvent());
	el.ontouchstart(fakeEvent());
	assert.equal(calls, 2);
});

test("a release binds mouse up, touch end AND touch cancel", () => {
	const el = {};
	let calls = 0;
	setOnUp(el, () => calls++);
	for (const handler of ["onmouseup", "ontouchend", "ontouchcancel"]) {
		assert.equal(typeof el[handler], "function", `setOnUp must bind ${handler}`);
		el[handler](fakeEvent());
	}
	assert.equal(calls, 3, "every release path must reach the callback");
});

test("a cancelled touch releases exactly like a finished one", () => {
	const ended = {};
	const cancelled = {};
	const seen = [];
	setOnUp(ended, () => seen.push("end"));
	setOnUp(cancelled, () => seen.push("cancel"));
	ended.ontouchend(fakeEvent());
	cancelled.ontouchcancel(fakeEvent());
	assert.deepEqual(seen, ["end", "cancel"]);
});

test("prevent_default is honoured and can be opted out of", () => {
	const on = {};
	const off = {};
	setOnClick(on, () => {});
	setOnClick(off, () => {}, false);
	const a = fakeEvent();
	const b = fakeEvent();
	on.onclick(a);
	off.onclick(b);
	assert.equal(a.wasPrevented(), true);
	assert.equal(b.wasPrevented(), false);
});

test("the stream surface also releases a cancelled touch", () => {
	// mouse.js binds the stream with addEventListener rather than the helpers
	// above, so it needs its own cancel path.
	const mouse = read("web/share/js/kvm/mouse.js");
	assert.match(mouse, /addEventListener\("touchcancel"/,
		"kvm/mouse.js must release mouse buttons when a touch is cancelled");
});

test("no module hand-rolls its own press/release binding", () => {
	// One binding point, so a fix like touchcancel lands everywhere at once.
	for (const f of jsFiles()) {
		if (f.endsWith("events.js") || f.endsWith("tools.js") || f.endsWith("kvm/mouse.js")) {
			continue;
		}
		assert.doesNotMatch(read(f), /\.ontouchstart\s*=/,
			`${f}: bind presses through tools.el.setOnDown, not ontouchstart directly`);
	}
});

const fakeTouch = (type, touches, changed = []) => ({
	type,
	touches,
	"changedTouches": changed,
	"preventDefault": () => {},
});

test("a drag surface binds a mouse, a finger, and the cancel a finger has", () => {
	const el = {};
	const seen = [];
	setOnDrag(el, {
		"onStart": (p) => seen.push(["start", p.x]),
		"onMove": (p) => seen.push(["move", p.x]),
		"onEnd": (p) => seen.push(["end", p.x]),
		"onCancel": () => seen.push(["cancel"]),
	});
	for (const handler of ["onmousedown", "onmousemove", "onmouseup", "ontouchstart", "ontouchmove", "ontouchend", "ontouchcancel"]) {
		assert.equal(typeof el[handler], "function", `setOnDrag must bind ${handler}`);
	}
	el.onmousedown({"clientX": 5, "clientY": 6, "preventDefault": () => {}});
	el.ontouchcancel({"preventDefault": () => {}});
	assert.deepEqual(seen, [["start", 5], ["cancel"]]);
});

test("the last point of a drag comes from changedTouches", () => {
	// On a touchend the finger is gone from `touches`. Reading it from there
	// loses the end of every gesture -- the selection would always stop where
	// the last touchmove happened to land.
	const moving = fakeTouch("touchmove", [{"clientX": 10, "clientY": 20}]);
	const ending = fakeTouch("touchend", [], [{"clientX": 30, "clientY": 40}]);
	assert.deepEqual(dragPoint(moving), {"x": 10, "y": 20});
	assert.deepEqual(dragPoint(ending), {"x": 30, "y": 40});
	assert.deepEqual(dragPoint({"clientX": 1, "clientY": 2}), {"x": 1, "y": 2}, "a mouse event still works");
});

test("a drag prevents the touch defaults and leaves the mouse alone", () => {
	// The touch defaults replay the whole gesture as synthetic mouse events a
	// moment later, which starts a second drag over the one just drawn. The
	// mouse defaults include taking focus, which the surface still needs.
	const el = {};
	setOnDrag(el, {"onStart": () => {}, "onMove": () => {}, "onEnd": () => {}, "onCancel": () => {}});
	let touch_prevented = false;
	let mouse_prevented = false;
	el.ontouchstart({
		"touches": [{"clientX": 1, "clientY": 1}],
		"changedTouches": [],
		"preventDefault": () => (touch_prevented = true),
	});
	el.onmousedown({"clientX": 1, "clientY": 1, "preventDefault": () => (mouse_prevented = true)});
	assert.equal(touch_prevented, true);
	assert.equal(mouse_prevented, false);
});

test("a drag with no point at all reaches nothing", () => {
	const el = {};
	let calls = 0;
	setOnDrag(el, {
		"onStart": () => calls++,
		"onMove": () => calls++,
		"onEnd": () => calls++,
		"onCancel": () => calls++,
	});
	el.ontouchend(fakeTouch("touchend", [], []));
	assert.equal(calls, 0, "a callback must never be handed an undefined position");
});

test("the stream binds the gesture recogniser instead of guessing", () => {
	const mouse = read("web/share/js/kvm/mouse.js");
	assert.match(mouse, /TouchGestures/, "kvm/mouse.js must use the shared recogniser");
	for (const method of ["start", "move", "end", "cancel"]) {
		assert.match(mouse, new RegExp(`__gestures\\.${method}\\(`),
			`kvm/mouse.js never calls gestures.${method}()`);
	}
});
