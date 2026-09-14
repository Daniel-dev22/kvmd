// What a finger MEANT on the video of the host. Every case here is a decision
// the recogniser has to make with no element to help it -- only distance and
// time -- and getting one wrong is a click nobody asked for on somebody's
// server, or a click that never arrives.
//
// No browser: gestures.js has no DOM in it, and the clock and the timer are
// injected, so a 500ms long press is tested in no time at all and cannot go
// flaky on a loaded machine.

import test from "node:test";
import assert from "node:assert/strict";
import {TouchGestures, TAP_SLOP_PX, LONG_PRESS_MS} from "../../web/share/js/gestures.js";

function harness() {
	const clicks = [];
	const timers = new Map();
	let now = 0;
	let seq = 0;
	const gestures = new TouchGestures((button) => clicks.push(button), {
		"setTimer": (cb, ms) => {
			timers.set(++seq, {cb, "at": now + ms});
			return seq;
		},
		"clearTimer": (id) => timers.delete(id),
		"now": () => now,
	});
	return {
		gestures, clicks,
		"armed": () => timers.size,
		"tick": function(ms) {
			now += ms;
			for (const [id, timer] of [...timers]) {
				if (timer.at <= now) {
					timers.delete(id);
					timer.cb();
				}
			}
		},
	};
}

const at = (x, y, id = 0) => ({id, x, y});

test("a tap is a left click", () => {
	const h = harness();
	h.gestures.start([at(100, 100)]);
	h.tick(80);
	h.gestures.end([]);
	assert.deepEqual(h.clicks, ["left"]);
});

test("a tap may wobble, but a drag is not a click", () => {
	// The boundary itself, in both directions: a finger never lands still, and
	// a drag has to stay a cursor move.
	for (const [dx, expected] of [[TAP_SLOP_PX, ["left"]], [TAP_SLOP_PX + 1, []]]) {
		const h = harness();
		h.gestures.start([at(100, 100)]);
		h.gestures.move([at(100 + dx, 100)]);
		h.tick(80);
		h.gestures.end([]);
		assert.deepEqual(h.clicks, expected, `moved ${dx}px`);
	}
});

test("a long press is a right click, and lifting afterwards is not a second one", () => {
	const h = harness();
	h.gestures.start([at(100, 100)]);
	h.tick(LONG_PRESS_MS);
	assert.deepEqual(h.clicks, ["right"], "the click has to arrive under the finger, not on release");
	h.tick(2000);
	h.gestures.end([]);
	assert.deepEqual(h.clicks, ["right"]);
});

test("a press that moves never becomes a right click", () => {
	const h = harness();
	h.gestures.start([at(100, 100)]);
	h.gestures.move([at(140, 100)]);
	h.tick(LONG_PRESS_MS * 4);
	h.gestures.end([]);
	assert.deepEqual(h.clicks, []);
});

test("two fingers tapped are a middle click", () => {
	const h = harness();
	h.gestures.start([at(100, 100, 1)]);
	h.gestures.start([at(100, 100, 1), at(160, 100, 2)]);
	h.tick(80);
	h.gestures.end([at(160, 100, 2)]); // one lifts first: the gesture is not over
	assert.deepEqual(h.clicks, [], "the gesture ends when the LAST finger lifts");
	h.gestures.end([]);
	assert.deepEqual(h.clicks, ["middle"]);
});

test("a second finger cancels the pending right click", () => {
	const h = harness();
	h.gestures.start([at(100, 100, 1)]);
	assert.equal(h.armed(), 1);
	h.gestures.start([at(100, 100, 1), at(160, 100, 2)]);
	assert.equal(h.armed(), 0, "two fingers are a scroll or a middle click, never a right click");
	h.tick(LONG_PRESS_MS * 2);
	h.gestures.end([]);
	assert.deepEqual(h.clicks, [], "and holding two fingers is not a tap either");
});

test("two fingers that move are a scroll, not a click", () => {
	const h = harness();
	h.gestures.start([at(100, 100, 1), at(160, 100, 2)]);
	h.gestures.move([at(100, 160, 1), at(160, 160, 2)]);
	h.tick(80);
	h.gestures.end([]);
	assert.deepEqual(h.clicks, []);
});

test("three fingers mean nothing at all", () => {
	const h = harness();
	h.gestures.start([at(100, 100, 1), at(160, 100, 2), at(220, 100, 3)]);
	h.tick(80);
	h.gestures.end([]);
	assert.deepEqual(h.clicks, []);
});

test("a touch the system took away is not a tap", () => {
	// An incoming call or a system gesture. The user never finished the
	// gesture, and the host must not be clicked because of it.
	const h = harness();
	h.gestures.start([at(100, 100)]);
	h.tick(80);
	h.gestures.cancel();
	h.gestures.end([]);
	assert.deepEqual(h.clicks, []);
	assert.equal(h.armed(), 0, "the pending right click has to go with it");
});

test("a finger resting on the video is not a click when it finally lifts", () => {
	const h = harness();
	h.gestures.start([at(100, 100, 1), at(160, 100, 2)]);
	h.tick(LONG_PRESS_MS + 1);
	h.gestures.end([]);
	assert.deepEqual(h.clicks, [], "a tap is short, whatever the finger count");
});

test("one gesture cannot poison the next", () => {
	const h = harness();
	h.gestures.start([at(100, 100)]);
	h.gestures.move([at(300, 300)]);
	h.gestures.end([]);
	assert.deepEqual(h.clicks, []);
	h.gestures.start([at(100, 100)]);
	h.tick(50);
	h.gestures.end([]);
	assert.deepEqual(h.clicks, ["left"], "the drag's 'moved' flag must not survive into the next tap");
});

test("a right click is not followed by a left one on the same press", () => {
	const h = harness();
	h.gestures.start([at(100, 100)]);
	h.tick(LONG_PRESS_MS);
	h.gestures.move([at(101, 101)]); // a finger shifts while resting
	h.gestures.end([]);
	assert.deepEqual(h.clicks, ["right"]);
});

test("the timer is disarmed once the gesture is over", () => {
	const h = harness();
	h.gestures.start([at(100, 100)]);
	h.gestures.end([]);
	assert.equal(h.armed(), 0);
	h.tick(LONG_PRESS_MS * 2);
	assert.deepEqual(h.clicks, ["left"], "and no right click arrives afterwards");
});
