// Zooming into the host's screen. The picture is PIXELS -- a 1920x1080 console
// on a 390px phone is 4.8px per character and there is no font to make bigger
// -- so the only answer is to magnify, and the only thing that must not break
// is where a click lands. Every rule here is one that goes wrong in a way you
// notice by clicking 40px from where you meant to.

import test from "node:test";
import assert from "node:assert/strict";
import {makeZoom, ZOOM_MIN, ZOOM_MAX} from "../../web/share/js/kvm/zoom.js";

const box = (w = 390, h = 220) => {
	const zoom = new makeZoom();
	zoom.setViewport(w, h);
	return zoom;
};

test("at rest it changes nothing", () => {
	const zoom = box();
	assert.deepEqual(zoom.get(), {"scale": 1, "x": 0, "y": 0});
	assert.equal(zoom.isZoomed(), false);
	assert.deepEqual(zoom.toPicture({"x": 137, "y": 42}), {"x": 137, "y": 42});
});

test("the point under the fingers stays under the fingers", () => {
	// The whole of "it zoomed where I was looking". Anchoring on the centre of
	// the box instead sends whatever you were reading off the edge.
	for (const anchor of [{"x": 0, "y": 0}, {"x": 195, "y": 110}, {"x": 380, "y": 210}]) {
		const zoom = box();
		zoom.pinch(2.5, anchor);
		const after = zoom.toPicture(anchor);
		assert.ok(Math.abs(after.x - anchor.x) <= 1 && Math.abs(after.y - anchor.y) <= 1,
			`anchor ${JSON.stringify(anchor)} moved to ${JSON.stringify(after)}`);
	}
});

test("a click is reported in the picture's coordinates, not the glass's", () => {
	const zoom = box();
	zoom.pinch(2, {"x": 0, "y": 0});
	// Zoomed 2x from the top-left: 100px along the glass is 50px into the host.
	assert.deepEqual(zoom.toPicture({"x": 100, "y": 50}), {"x": 50, "y": 25});
});

test("the picture can never be panned off its own box", () => {
	const zoom = box();
	zoom.pinch(2, {"x": 0, "y": 0});
	zoom.pan(9999, 9999);
	assert.deepEqual(zoom.get(), {"scale": 2, "x": 0, "y": 0}, "panned past the top-left");
	zoom.pan(-9999, -9999);
	assert.deepEqual(zoom.get(), {"scale": 2, "x": -390, "y": -220},
		"panned past the bottom-right: at 2x the picture is twice the box, so -390 is its far edge");
});

test("the zoom is bounded at both ends", () => {
	const zoom = box();
	zoom.pinch(100, {"x": 195, "y": 110});
	assert.equal(zoom.get().scale, ZOOM_MAX);
	zoom.pinch(0.001, {"x": 195, "y": 110});
	assert.equal(zoom.get().scale, ZOOM_MIN);
});

test("zooming back out recentres, so there is never a blank strip", () => {
	const zoom = box();
	zoom.pinch(3, {"x": 380, "y": 200});
	zoom.pan(-200, -200);
	zoom.pinch(1 / 3, {"x": 0, "y": 0});
	assert.deepEqual(zoom.get(), {"scale": 1, "x": 0, "y": 0});
});

test("a smaller box re-clamps what was already panned", () => {
	// Rotating the phone, or a sheet opening under the video.
	const zoom = box(390, 220);
	zoom.pinch(2, {"x": 0, "y": 0});
	zoom.pan(-390, -220);
	zoom.setViewport(320, 180);
	const at = zoom.get();
	assert.ok(at.x >= -320 && at.y >= -180,
		`the picture is still panned for the old box: ${JSON.stringify(at)}`);
});

test("reset is a return to exactly the resting state", () => {
	const zoom = box();
	zoom.pinch(2.75, {"x": 100, "y": 100});
	zoom.pan(-50, -50);
	zoom.reset();
	assert.deepEqual(zoom.get(), {"scale": 1, "x": 0, "y": 0});
});
