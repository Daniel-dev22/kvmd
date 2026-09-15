// Keeping the part of the host's screen that matters inside a zoomed view.
//
// The arithmetic is pure and tested directly. The SAMPLER is not: it is the
// step between the decoder and the view, and the last phase's mutation sweep
// found six of its twelve survivors in exactly that kind of layer -- an
// assembler that the unit tests replace with a fake and the browser tests run
// through without observing. So the browser half below drives a real changing
// picture and asserts the view actually moved.

import test, {before, after, describe} from "node:test";
import assert from "node:assert/strict";
import {serveWeb, launchBrowser, chromiumPath} from "./browser.mjs";
import {
	changedRegion, shouldFollow, followPan,
	FOLLOW_CELL_DELTA, FOLLOW_MAX_FRACTION, FOLLOW_MARGIN, FOLLOW_MIN_DENSITY,
} from "../../web/share/js/kvm/follow.js";

// A sample buffer with the listed cells set to white.
function frame(cols, rows, cells = []) {
	const buf = new Uint8ClampedArray(cols * rows * 4);
	for (const [x, y] of cells) {
		const p = (y * cols + x) * 4;
		buf[p] = buf[p + 1] = buf[p + 2] = 255;
		buf[p + 3] = 255;
	}
	return buf;
}

// ---- finding the change ----

test("an unchanged picture reports nothing", () => {
	const a = frame(8, 4, [[1, 1]]);
	assert.equal(changedRegion(a, a, 8, 4), null);
});

test("a single changed cell is located, not just detected", () => {
	const a = frame(8, 4);
	const b = frame(8, 4, [[6, 1]]);
	assert.deepEqual(changedRegion(a, b, 8, 4), {
		"x": 0.75, "y": 0.25, "w": 0.125, "h": 0.25, "fraction": 1 / 32,
	});
});

test("the region spans every cell that changed", () => {
	const a = frame(8, 4);
	const b = frame(8, 4, [[1, 1], [5, 2]]);
	const r = changedRegion(a, b, 8, 4);
	assert.deepEqual(
		{"x": r.x, "y": r.y, "w": r.w, "h": r.h},
		{"x": 1 / 8, "y": 1 / 4, "w": 5 / 8, "h": 2 / 4});
});

test("JPEG noise is not a change", () => {
	// An MJPEG stream re-encodes every frame, so nothing is ever pixel
	// identical. A threshold of zero would report the whole screen as changing
	// forever, and the view would chase noise.
	const a = frame(8, 4);
	const b = frame(8, 4);
	for (let p = 0; p < b.length; p += 4) {
		b[p] = 5; b[p + 1] = 5; b[p + 2] = 5;   // 15 summed, under the threshold
	}
	assert.equal(changedRegion(a, b, 8, 4), null);
	// Both sides, or a build with the threshold raised 8x passes: a cell just
	// over it must register.
	const over = Math.ceil((FOLLOW_CELL_DELTA + 3) / 3);
	const loud = frame(8, 4);
	loud[0] = loud[1] = loud[2] = over;
	assert.notEqual(changedRegion(a, loud, 8, 4), null,
		`${over * 3} over black must register against a threshold of ${FOLLOW_CELL_DELTA}`);
});

// ---- deciding whether to move ----

test("nothing to follow when nothing changed", () => {
	assert.equal(shouldFollow(null, 2.5, 8, 4), false);
});

test("nothing to follow at 1x, where the whole picture is already on screen", () => {
	const r = changedRegion(frame(8, 4), frame(8, 4, [[6, 1]]), 8, 4);
	assert.equal(shouldFollow(r, 1, 8, 4), false);
	assert.equal(shouldFollow(r, 2.5, 8, 4), true);
});

test("a repaint is not a cursor", () => {
	// A window opening, a screen scrolling, a video playing. Following it would
	// fling the view somewhere the user is not working.
	const cells = [];
	for (let y = 0; y < 4; y += 1) {
		for (let x = 0; x < 8; x += 1) {
			cells.push([x, y]);
		}
	}
	const r = changedRegion(frame(8, 4), frame(8, 4, cells), 8, 4);
	assert.equal(r.fraction, 1);
	assert.equal(shouldFollow(r, 2.5, 8, 4), false);

	// A REALISTIC repaint, not a whole-screen one: half the rows changing is a
	// scroll or a window opening and must still be refused. `fraction < 1` as
	// the only assertion let the cap move from 0.2 to 0.9 unnoticed.
	const half = [];
	for (let y = 0; y < 2; y += 1) {
		for (let x = 0; x < 8; x += 1) {
			half.push([x, y]);
		}
	}
	const wide = changedRegion(frame(8, 4), frame(8, 4, half), 8, 4);
	assert.equal(wide.fraction, 0.5);
	assert.equal(shouldFollow(wide, 2.5, 8, 4), false, "half the screen changing is not a cursor");
});

// ---- where to move to ----

const VIEW = {"scale": 2, "x": 0, "y": 0};
const BOX = {"width": 400, "height": 300};
// A picture with no letterbox: it fills the element box exactly.
const FULL = {"x": 0, "y": 0, "width": 400, "height": 300};

test("a region already inside the band is left alone", () => {
	// Otherwise the view re-pans on every cursor blink, which reads as a
	// jitter rather than as help.
	const region = {"x": 0.2, "y": 0.2, "w": 0.05, "h": 0.05};
	assert.deepEqual(followPan({"view": VIEW, "viewport": BOX, "picture": FULL, "region": region}), {"dx": 0, "dy": 0});
});

test("a region inside the box but inside the MARGIN is still pulled in", () => {
	// 📏 The test above passes whether or not the band exists: its region is
	// comfortable either way. This is what the margin is actually for -- the
	// cursor is technically on screen, but pressed against the edge, and
	// waiting until it leaves the box entirely is waiting too long.
	// Box 400 wide at 2x: the band ends at 320, the picture at 400.
	const region = {"x": 0.4, "y": 0.2, "w": 0.05, "h": 0.05};
	const move = followPan({"view": VIEW, "viewport": BOX, "picture": FULL, "region": region});
	assert.equal(move.dy, 0, "it must not drift vertically for a horizontal problem");
	assert.equal(move.dx, BOX.width * (1 - FOLLOW_MARGIN) - 0.45 * BOX.width * VIEW.scale);
	assert.ok(move.dx < 0, `expected a pull towards the centre, got ${move.dx}`);
});

test("a region past the bottom of the box pans the picture up", () => {
	const region = {"x": 0.2, "y": 0.9, "w": 0.05, "h": 0.05};
	const move = followPan({"view": VIEW, "viewport": BOX, "picture": FULL, "region": region});
	assert.equal(move.dx, 0, "it must not drift sideways for a vertical problem");
	// bottom of the region is 0.95 * 600 = 570; the band ends at 240.
	assert.equal(move.dy, 240 - 570);
});

test("a region above the box pans the picture down", () => {
	const region = {"x": 0.2, "y": 0.0, "w": 0.05, "h": 0.02};
	const move = followPan({"view": {"scale": 2, "x": 0, "y": -400}, "viewport": BOX, "picture": FULL, "region": region});
	assert.ok(move.dy > 0, `expected a downward pan, got ${move.dy}`);
});

test("the trailing edge wins when the region is too big to fit", () => {
	// A whole line of text is wider than the band. The cursor is at its END,
	// and new output appears at the BOTTOM -- keeping the leading edge in view
	// instead leaves both off the screen, which is the entire problem.
	const region = {"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0};
	const move = followPan({"view": VIEW, "viewport": BOX, "picture": FULL, "region": region});
	assert.equal(move.dx, BOX.width * (1 - FOLLOW_MARGIN) - BOX.width * 2);
	assert.equal(move.dy, BOX.height * (1 - FOLLOW_MARGIN) - BOX.height * 2);
});

test("bringing the leading edge in never pushes the trailing edge out", () => {
	// 📏 The earlier version of this test never executed the cap it was named
	// after: its region's trailing edge was already past the band, so __axis
	// returned from the FIRST branch and both assertions were tautologies of
	// that branch. Replacing the cap with a bare leading-edge correction
	// survived it. This region takes the LEADING branch and is taller than the
	// band, so an uncapped correction would shove the bottom back out.
	const view = {"scale": 2, "x": 0, "y": -100};
	const region = {"x": 0.2, "y": 0.0, "w": 0.05, "h": 0.5};
	const top = -100;
	const bottom = -100 + 0.5 * FULL.height * view.scale;
	const band_lo = BOX.height * FOLLOW_MARGIN;
	const band_hi = BOX.height * (1 - FOLLOW_MARGIN);
	assert.ok(top < band_lo, "precondition: the leading edge is above the band");
	assert.ok(bottom <= band_hi, "precondition: the trailing edge is already inside it");
	assert.ok(band_lo - top > band_hi - bottom, "precondition: an uncapped correction would overshoot");

	const move = followPan({view, "viewport": BOX, "picture": FULL, "region": region});
	assert.equal(move.dy, band_hi - bottom, "the correction must stop at the trailing edge");
});

test("a letterboxed picture is measured from the picture, not the box", () => {
	// 🔴 The region is a fraction of the PICTURE: drawImage samples the source
	// bitmap, and `object-fit: contain` letterboxes that inside the element.
	// Measuring from the box put the cursor up to 780px from where it really
	// was in a full-tab window on a phone, and panned into the black bars --
	// at the top of the picture it panned the WRONG WAY entirely.
	const box = {"width": 390, "height": 844};
	// 1920x1080 contained in 390x844 renders 390x219, centred: 312px of bar.
	const picture = {"x": 0, "y": 312, "width": 390, "height": 219};
	const view = {"scale": 2.5, "x": 0, "y": 0};
	const at_top = {"x": 0.2, "y": 0.0, "w": 0.02, "h": 0.05};

	const right = followPan({view, "viewport": box, picture, "region": at_top});
	const wrong = followPan({view, "viewport": box, "picture": {"x": 0, "y": 0, ...box}, "region": at_top});
	assert.ok(right.dy < 0, `the top of a letterboxed picture is BELOW the band, so it must pan up; got ${right.dy}`);
	assert.ok(wrong.dy > 0, "precondition: measuring from the box pans the other way");
});

test("two things changing at once are not one thing to chase", () => {
	// A caret top-left and a clock repainting bottom-right share a bounding box
	// that spans the screen while changing a handful of cells. The trailing
	// edge rule would chase the CLOCK and drag the caret off the top.
	const a = frame(8, 4);
	const caret = changedRegion(a, frame(8, 4, [[1, 1]]), 8, 4);
	const both = changedRegion(a, frame(8, 4, [[1, 1], [7, 3]]), 8, 4);
	assert.ok(both.fraction < FOLLOW_MAX_FRACTION, "precondition: too few cells for the repaint guard to catch");
	assert.equal(shouldFollow(caret, 2.5, 8, 4), true);
	assert.equal(shouldFollow(both, 2.5, 8, 4), false, "a sparse bounding box is two things, not one");
	assert.ok(FOLLOW_MIN_DENSITY > 0);
});

// ---- the sampler, in a real engine ----

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

describe("the view follows the action", {"skip": chromiumPath() ? false : "no chromium available"}, () => {

	// The y translate the picture is currently drawn at.
	const TRANSLATE_Y = `(() => {
		const m = /translate\\([-0-9.]+px,\\s*([-0-9.]+)px\\)/.exec(
			document.getElementById("stream-canvas").style.transform || "");
		return (m === null ? null : parseFloat(m[1]));
	})()`;

	test("a change at the bottom of the picture pulls the view down to it", async () => {
		const pg = await browser.newPage();
		await pg.setViewport(390, 844, true);
		await pg.setTouch(true, 5);
		await pg.clearStorage(server.origin);
		await pg.goto(`${server.origin}/kvm/index.html`);
		await pg.eval("new Promise((r) => setTimeout(r, 400))");

		// Stand in for the host's screen with a canvas we can actually change.
		// stream-canvas is one of the three elements the follower samples.
		await pg.eval(`(() => {
			const c = document.getElementById("stream-canvas");
			// Wide enough that the vertical letterbox is LARGE. 1920x1080 in
			// this box leaves only ~30px a side, inside the sample grid's own
			// quantisation, so a mapping that ignores the letterbox still lands
			// close enough to pass. At 2560x1080 it is ~58px a side.
			c.width = 2560; c.height = 1080;
			c.classList.remove("hidden");
			document.getElementById("stream-image").classList.add("hidden");
			window.__paint = function(n) {
				const x = c.getContext("2d");
				x.fillStyle = "#000"; x.fillRect(0, 0, 2560, 1080);
				// 📏 10x20 is a real box cursor, and it is SMALLER THAN A SAMPLE
				// CELL (2560x1080 over 80x45 makes a cell 32x24 source px). A
				// 24x40 block fills a whole cell, which is the one size that
				// survives a point-sampled downscale -- so this test passed on
				// a build that could not see any real cursor: at 1920x1080 a
				// 10x20 block was detected 24 times in 60, median delta ZERO.
				//
				// It sits clear of the picture's bottom, because down there
				// zoom.js's clamp decides the final position and the mapping
				// stops showing through -- and clear of the LEFT edge, so it is
				// already comfortable horizontally and only the VERTICAL pan is
				// needed. A caret off-band on both axes cannot tell "pan if
				// either axis needs it" from "pan only if both do", and the
				// second never follows a scrolling prompt at all.
				if (n % 2 === 0) {
					x.fillStyle = "#fff"; x.fillRect(512, 745, 10, 20);
				}
			};
			window.__paint(1);
			return true;
		})()`);

		await pg.eval(`(() => {
			const el = document.getElementById("stream-zoom-slider");
			el.value = "2.5";
			el.dispatchEvent(new Event("change", {bubbles: true}));
			return el.value;
		})()`);
		const at_rest = await pg.eval(TRANSLATE_Y);
		assert.equal(at_rest, 0, "the view starts anchored at the top, where the prompt is on load");

		// The follower deliberately keeps its hands off for a few seconds after
		// a deliberate change of view, so this has to wait that out -- it is
		// the behaviour, not a sleep standing in for one.
		await pg.eval("new Promise((r) => setTimeout(r, 4200))");

		// Blink the cursor until the view moves, or give up.
		const until = Date.now() + 6000;
		let moved = at_rest;
		for (let n = 0; Date.now() < until; n += 1) {
			await pg.eval(`window.__paint(${n})`);
			await pg.eval("new Promise((r) => setTimeout(r, 220))");
			moved = await pg.eval(TRANSLATE_Y);
			if (moved !== null && moved < -1) {
				break;
			}
		}
		const scale = await pg.eval(`document.getElementById("stream-canvas").style.transform`);
		// WHERE it ended up, not merely that it moved. "It moved at all" passes
		// straight through a mapping that measures the region against the box
		// instead of the letterboxed picture -- which is the defect this test
		// exists to catch, and which it did not catch until this assertion.
		const caret = await pg.eval(`(() => {
			const box = document.getElementById("stream-box").getBoundingClientRect();
			const c = document.getElementById("stream-canvas");
			// Doubled: this lives inside a template literal, which eats one
			// level of escaping before the page ever sees the regex.
			const m = /translate\\(([-0-9.]+)px,\\s*([-0-9.]+)px\\)\\s*scale\\(([0-9.]+)\\)/.exec(c.style.transform || "");
			if (m === null) { return null; }
			const tx = parseFloat(m[1]), ty = parseFloat(m[2]), sc = parseFloat(m[3]);
			const ratio = Math.min(box.width / 2560, box.height / 1080);
			const pw = ratio * 2560, ph = ratio * 1080;
			const px = (box.width - pw) / 2, py = (box.height - ph) / 2;
			// The painted caret's centre, in source pixels.
			const fx = (512 + 5) / 2560, fy = (745 + 10) / 1080;
			return {
				"x": tx + (px + fx * pw) * sc,
				"y": ty + (py + fy * ph) * sc,
				"w": box.width, "h": box.height,
			};
		})()`);
		await pg.close();
		assert.ok(moved < -1,
			`the view never followed the cursor down: translateY ${moved}, transform ${scale}`);
		assert.ok(caret !== null, "no transform to measure");
		assert.ok(caret.y >= 0 && caret.y <= caret.h,
			`the caret is not on screen: y ${caret.y.toFixed(1)} of ${caret.h}`);
		// WHERE it came to rest, not merely that it is on screen. 📏 The single
		// assertion "translateY got more negative" was satisfied by zoom.js's
		// CLAMP -- measured at exactly -416 against a requested -443.8 -- so
		// the magnitude the follower computed was erased before anything
		// observed it, and almost every mutation of the arithmetic survived.
		// This caret sits clear of the clamp, so the arithmetic alone decides.
		// The tolerance is the sample grid's quantisation (~12 box px here);
		// ignoring the ~58px letterbox misses by far more.
		const want = caret.h * (1 - FOLLOW_MARGIN);
		assert.ok(Math.abs(caret.y - want) <= 25,
			`the caret came to rest ${(caret.y - want).toFixed(1)}px off the comfort band `
			+ `(y ${caret.y.toFixed(1)}, band ${want.toFixed(1)}, box ${caret.h})`);
	});

	// This is also the negative control for the test above: if the view moved
	// for some reason other than the follower, it would move here too.
	test("the switch turns it off", async () => {
		const pg = await browser.newPage();
		await pg.setViewport(390, 844, true);
		await pg.setTouch(true, 5);
		await pg.clearStorage(server.origin);
		await pg.goto(`${server.origin}/kvm/index.html`);
		await pg.eval("new Promise((r) => setTimeout(r, 400))");
		await pg.eval(`(() => {
			const c = document.getElementById("stream-canvas");
			c.width = 2560; c.height = 1080;
			c.classList.remove("hidden");
			document.getElementById("stream-image").classList.add("hidden");
			window.__paint = function(n) {
				const x = c.getContext("2d");
				x.fillStyle = "#000"; x.fillRect(0, 0, 2560, 1080);
				if (n % 2 === 0) { x.fillStyle = "#fff"; x.fillRect(512, 745, 10, 20); }
			};
			window.__paint(1);
			// bindSimpleSwitch binds on CLICK, so assigning .checked and
			// firing a change event turns nothing off -- it just made this
			// test measure the follower running normally.
			const sw = document.getElementById("stream-follow-switch");
			sw.click();
			if (sw.checked) { throw new Error("the switch did not turn off"); }
			const el = document.getElementById("stream-zoom-slider");
			el.value = "2.5";
			el.dispatchEvent(new Event("change", {bubbles: true}));
			return true;
		})()`);
		await pg.eval("new Promise((r) => setTimeout(r, 4200))");
		for (let n = 0; n < 8; n += 1) {
			await pg.eval(`window.__paint(${n})`);
			await pg.eval("new Promise((r) => setTimeout(r, 180))");
		}
		const y = await pg.eval(TRANSLATE_Y);
		await pg.close();
		assert.equal(y, 0, `the view moved with following switched off: translateY ${y}`);
	});
});
