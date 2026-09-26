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
import {TouchGestures, TAP_SLOP_PX, LONG_PRESS_MS, LONG_PRESS_MAX_MS} from "../../web/share/js/gestures.js";

function harness() {
	const clicks = [];
	const armed = [];
	const timers = new Map();
	let now = 0;
	let seq = 0;
	const gestures = new TouchGestures({
		"onClick": (button) => clicks.push(button),
		"onArm": (on) => armed.push(on),
	}, {
		"setTimer": (cb, ms) => {
			timers.set(++seq, {cb, "at": now + ms});
			return seq;
		},
		"clearTimer": (id) => timers.delete(id),
		"now": () => now,
	});
	return {
		gestures, clicks, armed,
		"pending": () => timers.size,
		"tick": function(ms) {
			// One millisecond at a time, so a timer that should fire midway
			// through a long wait fires with the clock it would really see.
			for (let i = 0; i < ms; i++) {
				now += 1;
				for (const [id, timer] of [...timers]) {
					if (timer.at <= now) {
						timers.delete(id);
						timer.cb();
					}
				}
			}
		},
	};
}

const at = (x, y, id = 0) => ({id, x, y});

// The tests below build their inputs from these constants, so they are blind to
// the constants themselves: a build where a 120ms tap is a right click passes
// every one of them. The numbers are the module's whole purpose, so they are
// pinned literally, once.
test("the thresholds are what the module says they are", () => {
	assert.equal(TAP_SLOP_PX, 10);
	assert.equal(LONG_PRESS_MS, 500);
	assert.equal(LONG_PRESS_MAX_MS, 2000);
});

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

test("the tap/long-press boundary is where it claims to be", () => {
	for (const [held, expected] of [
		[LONG_PRESS_MS - 1, ["left"]],
		[LONG_PRESS_MS, ["right"]],
	]) {
		const h = harness();
		h.gestures.start([at(100, 100)]);
		h.tick(held);
		h.gestures.end([]);
		assert.deepEqual(h.clicks, expected, `held ${held}ms`);
	}
});

test("a long press is armed, shown, and committed when the finger LIFTS", () => {
	// Not at the threshold: a click the user cannot abort is a click they did
	// not consent to. Moving away still cancels it right up to the release.
	const h = harness();
	h.gestures.start([at(100, 100)]);
	h.tick(LONG_PRESS_MS - 1);
	assert.deepEqual(h.armed, [], "nothing is promised before the threshold");
	assert.deepEqual(h.clicks, []);
	h.tick(1);
	assert.deepEqual(h.armed, [true], "and the surface is told, so it can show it");
	assert.deepEqual(h.clicks, [], "but nothing is sent while the finger is down");
	h.gestures.end([]);
	assert.deepEqual(h.clicks, ["right"]);
	assert.deepEqual(h.armed, [true, false]);
});

test("an armed long press can still be abandoned by moving", () => {
	const h = harness();
	h.gestures.start([at(100, 100)]);
	h.tick(LONG_PRESS_MS + 100);
	assert.deepEqual(h.armed, [true]);
	h.gestures.move([at(160, 100)]);
	assert.deepEqual(h.armed, [true, false], "the warning has to go away with it");
	h.gestures.end([]);
	assert.deepEqual(h.clicks, []);
});

test("a finger resting on the screen runs out of the window and sends nothing", () => {
	const h = harness();
	h.gestures.start([at(100, 100)]);
	h.tick(LONG_PRESS_MAX_MS);
	assert.deepEqual(h.armed, [true, false], "the offer expires visibly");
	h.tick(5000);
	h.gestures.end([]);
	assert.deepEqual(h.clicks, [], "a forgotten finger is not a right click");
});

test("two fingers never click, however still they are", () => {
	// A two-finger tap cannot be told from a two-finger scroll that did not
	// travel far enough -- and that under-travelled scroll is the gesture an
	// operator makes by reflex on a video pane. Middle click lives on the
	// on-screen Mouse pad, where it is asked for.
	for (const travel of [0, 1, TAP_SLOP_PX - 1, TAP_SLOP_PX + 1, 40]) {
		const h = harness();
		h.gestures.start([at(100, 100, 1), at(160, 100, 2)]);
		h.gestures.move([at(100 + travel, 100, 1), at(160 + travel, 100, 2)]);
		h.tick(80);
		h.gestures.end([at(160 + travel, 100, 2)]);
		h.gestures.end([]);
		assert.deepEqual(h.clicks, [], `two fingers travelling ${travel}px`);
	}
});

test("a second finger cancels the pending right click", () => {
	const h = harness();
	h.gestures.start([at(100, 100, 1)]);
	assert.equal(h.pending(), 1);
	h.gestures.start([at(100, 100, 1), at(160, 100, 2)]);
	assert.equal(h.pending(), 0, "two fingers are a scroll, never a right click");
	h.tick(LONG_PRESS_MS * 2);
	h.gestures.end([]);
	assert.deepEqual(h.clicks, []);
});

test("moving the cursor and THEN adding a second finger clicks nothing", () => {
	// The most ordinary two-handed sequence there is: drag to place the cursor,
	// then put a thumb down to scroll. Neither half is a click.
	const h = harness();
	h.gestures.start([at(100, 100, 1)]);
	h.gestures.move([at(300, 100, 1)]);
	h.gestures.start([at(300, 100, 1), at(360, 100, 2)]);
	h.tick(50);
	h.gestures.end([at(360, 100, 2)]);
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
	h.gestures.cancel([]);
	h.gestures.end([]);
	assert.deepEqual(h.clicks, []);
	assert.equal(h.pending(), 0, "the pending right click has to go with it");
});

test("what is left on the screen after a cancel is not a new gesture", () => {
	// Only one of two fingers is cancelled. The survivor is the tail of a
	// gesture the user has already lost -- its lift must not be read as a tap,
	// and it must not re-seed the clock either.
	const h = harness();
	h.gestures.start([at(100, 100, 1), at(160, 100, 2)]);
	h.gestures.cancel([at(160, 100, 2)]);
	h.gestures.start([at(160, 100, 2)]);
	h.tick(50);
	h.gestures.end([]);
	assert.deepEqual(h.clicks, [], "a cancelled gesture cannot come back as a click");
	// ...and once the screen is clear, the next gesture is believed again.
	h.gestures.start([at(100, 100, 1)]);
	h.tick(50);
	h.gestures.end([]);
	assert.deepEqual(h.clicks, ["left"]);
});

test("a finger that lifts mid-gesture leaves no origin behind", () => {
	// Touch identifiers are reusable the moment a touch ends, so a stale origin
	// is inherited by the NEXT finger and makes it look like it has travelled.
	const h = harness();
	h.gestures.start([at(100, 100, 1), at(600, 600, 2)]);
	h.gestures.end([at(100, 100, 1)]); // finger 2 lifts; id 2 is now free
	h.gestures.start([at(100, 100, 1), at(105, 105, 2)]); // reused id, new place
	h.gestures.move([at(100, 100, 1), at(106, 106, 2)]);
	h.gestures.end([at(100, 100, 1)]);
	h.gestures.end([]);
	assert.deepEqual(h.clicks, [], "two fingers, so no click either way");
	// The point is the bookkeeping, so check it where it shows: a fresh
	// single-finger tap at the reused id must still be a tap.
	h.gestures.start([at(105, 105, 2)]);
	h.tick(50);
	h.gestures.end([]);
	assert.deepEqual(h.clicks, ["left"]);
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

test("the timers are disarmed once the gesture is over", () => {
	const h = harness();
	h.gestures.start([at(100, 100)]);
	h.gestures.end([]);
	assert.equal(h.pending(), 0);
	h.tick(LONG_PRESS_MAX_MS * 2);
	assert.deepEqual(h.clicks, ["left"], "and no right click arrives afterwards");
	assert.deepEqual(h.armed, []);
});
