// Press/release binding. The release path must also fire when a touch is
// CANCELLED -- a system gesture, an incoming call or the browser taking over
// the gesture. Without it the key stays down on the target machine, which is a
// fault on the host we are administering, not a cosmetic bug in the page.

import test from "node:test";
import assert from "node:assert/strict";
import {read, jsFiles} from "./helpers.mjs";
import {setOnClick, setOnDown, setOnDrag, setOnUp} from "../../web/share/js/events.js";

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

const touchEvent = (touches, changed = []) => ({
	"touches": touches,
	"targetTouches": touches,
	"changedTouches": changed,
	"preventDefault": () => {},
});
const finger = (id, x, y) => ({"identifier": id, "clientX": x, "clientY": y});

function dragHarness() {
	const el = {};
	const seen = [];
	setOnDrag(el, {
		"onStart": (p) => seen.push(["start", p.x, p.y]),
		"onMove": (p) => seen.push(["move", p.x, p.y]),
		"onEnd": (p) => seen.push(["end", p.x, p.y]),
		"onCancel": () => seen.push(["cancel"]),
	});
	return {el, seen};
}

test("a drag surface binds a mouse, a finger, and the cancel a finger has", () => {
	const {el, seen} = dragHarness();
	for (const handler of ["onmousedown", "onmousemove", "onmouseup", "ontouchstart", "ontouchmove", "ontouchend", "ontouchcancel"]) {
		assert.equal(typeof el[handler], "function", `setOnDrag must bind ${handler}`);
	}
	el.onmousedown({"clientX": 5, "clientY": 6, "preventDefault": () => {}});
	el.ontouchcancel({"preventDefault": () => {}});
	assert.deepEqual(seen, [["start", 5, 6], ["cancel"]]);
});

test("the last point of a drag comes from changedTouches", () => {
	// On a touchend the finger is gone from `touches`. Reading it from there
	// loses the end of every gesture -- the selection would always stop where
	// the last touchmove happened to land.
	const {el, seen} = dragHarness();
	el.ontouchstart(touchEvent([finger(7, 10, 20)], [finger(7, 10, 20)]));
	el.ontouchmove(touchEvent([finger(7, 30, 40)]));
	el.ontouchend(touchEvent([], [finger(7, 55, 66)]));
	assert.deepEqual(seen, [["start", 10, 20], ["move", 30, 40], ["end", 55, 66]]);
});

test("the drag follows the finger that started it, not whichever is first", () => {
	// `touches[0]` is not "the finger drawing": a second contact anywhere can
	// take index 0, and the box then jumps to it and ends where IT is.
	const {el, seen} = dragHarness();
	el.ontouchstart(touchEvent([finger(1, 10, 10)], [finger(1, 10, 10)]));
	// A second finger lands: the drag is abandoned rather than handed over.
	el.ontouchstart(touchEvent([finger(1, 10, 10), finger(2, 900, 900)], [finger(2, 900, 900)]));
	el.ontouchmove(touchEvent([finger(1, 12, 12), finger(2, 800, 800)]));
	el.ontouchend(touchEvent([finger(1, 12, 12)], [finger(2, 800, 800)]));
	el.ontouchend(touchEvent([], [finger(1, 12, 12)]));
	assert.deepEqual(seen, [["start", 10, 10], ["cancel"]],
		"a pinch is not a selection, and no point of the second finger may reach the callbacks");
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
		"touches": [finger(1, 1, 1)],
		"targetTouches": [finger(1, 1, 1)],
		"changedTouches": [finger(1, 1, 1)],
		"preventDefault": () => (touch_prevented = true),
	});
	el.onmousedown({"clientX": 1, "clientY": 1, "preventDefault": () => (mouse_prevented = true)});
	assert.equal(touch_prevented, true);
	assert.equal(mouse_prevented, false);
});

test("a stray release reaches nothing", () => {
	const {el, seen} = dragHarness();
	el.ontouchend(touchEvent([], [finger(3, 1, 1)]));
	el.ontouchmove(touchEvent([finger(3, 2, 2)]));
	assert.deepEqual(seen, [], "no drag is in progress, so there is nothing to report");
});

test("the stream binds the gesture recogniser instead of guessing", () => {
	const mouse = read("web/share/js/kvm/mouse.js");
	assert.match(mouse, /TouchGestures/, "kvm/mouse.js must use the shared recogniser");
	for (const method of ["start", "move", "end", "cancel"]) {
		assert.match(mouse, new RegExp(`__gestures\\.${method}\\(`),
			`kvm/mouse.js never calls gestures.${method}()`);
	}
	// targetTouches, not touches: the difference is a thumb resting anywhere
	// else on the screen turning the next tap into a two-finger gesture.
	assert.match(mouse, /for \(let touch of ev\.targetTouches\)/,
		"kvm/mouse.js must feed the recogniser the fingers that started on the video");
});
