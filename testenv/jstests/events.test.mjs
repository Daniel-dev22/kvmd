// Press/release binding. The release path must also fire when a touch is
// CANCELLED -- a system gesture, an incoming call or the browser taking over
// the gesture. Without it the key stays down on the target machine, which is a
// fault on the host we are administering, not a cosmetic bug in the page.

import test from "node:test";
import assert from "node:assert/strict";
import {read, jsFiles} from "./helpers.mjs";
import {setOnClick, setOnDown, setOnUp} from "../../web/share/js/events.js";

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
