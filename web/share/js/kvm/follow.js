/*****************************************************************************
#                                                                            #
#    KVMD - The main PiKVM daemon.                                           #
#                                                                            #
#    Copyright (C) 2018-2024  Maxim Devaev <mdevaev@gmail.com>               #
#                                                                            #
#    This program is free software: you can redistribute it and/or modify    #
#    it under the terms of the GNU General Public License as published by    #
#    the Free Software Foundation, either version 3 of the License, or       #
#    (at your option) any later version.                                     #
#                                                                            #
#    This program is distributed in the hope that it will be useful,         #
#    but WITHOUT ANY WARRANTY; without even the implied warranty of          #
#    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the           #
#    GNU General Public License for more details.                            #
#                                                                            #
#    You should have received a copy of the GNU General Public License       #
#    along with this program.  If not, see <https://www.gnu.org/licenses/>.  #
#                                                                            #
*****************************************************************************/

// Keeping the part of the host's screen that MATTERS inside a zoomed view.
//
// Zoomed to 250% on a phone you see a quarter of the console, anchored where
// the prompt was when the page loaded. Type a dozen lines and the prompt has
// walked out of the bottom of the box: you are typing blind, and panning back
// by hand after every few lines is the whole of the problem.
//
// There is no feedback channel -- kvmd has only video -- so nothing can be
// asked where the cursor is. But it does not have to be: the part that matters
// is the part that CHANGES, and that is visible in the pixels.
//
//   idle at a shell   the only thing changing is the blinking cursor
//   typing            the line being typed
//   a BIOS/TUI menu   the highlighted row
//
// One mechanism, three cases, and no rule anywhere about where prompts live.
//
// ⚠ NOT output scrolling, which an earlier version of this comment claimed.
// At 80x45 over a 1920x1080 console one sample cell is about one character
// cell, so scrolling a half-full screen changes ~50% of them -- past the
// repaint cap below, and deliberately so, because a cap that admits a scroll
// admits a window opening too. The view stops following while output flows and
// picks the cursor up again the moment it stops.
//
// State and arithmetic only. Sampling the video and applying the pan belong to
// the caller, so every rule here is testable without a browser -- and these are
// exactly the rules that go wrong in a way you only notice as a view that
// jitters, or that flings itself across the screen when a window opens.

"use strict";


import {ZOOM_MIN} from "./zoom.js";


// The grid the picture is sampled onto. Small on purpose: this is looking for
// WHERE something changed, not what, and a 1920x1080 frame downscaled to 80x45
// keeps a text cursor as roughly one cell.
export const FOLLOW_COLS = 80;
export const FOLLOW_ROWS = 45;

// How often to look. A cursor blinks at about 1Hz, so this only has to be fast
// enough not to miss it, and slow enough not to cost battery on a phone.
//
// 📏 What a sample costs (draw + read back + diff), desktop Chromium, with the
// source MUTATED every iteration so nothing upstream can be reused:
//
//     320x240   0.068 ms     1280x720   0.19 ms
//     640x480   0.173 ms     1920x1080  0.424 ms
//
// ⚠ An earlier note here claimed 0.05 ms. That was measured against a small
// STATIC source, so it timed the readback and the 3600-cell loop and never the
// downscale -- which is the part that scales with source area, and the real
// case is 1080p. The true figure is ~8x larger, and a phone is several times
// slower again: budget a few percent of a core while zoomed. That is why every
// "not now" test in the tick happens BEFORE the sample.
//
// The lever, if it ever matters: sample when a new frame actually arrived
// (requestVideoFrameCallback for janus, load ticks for mjpeg) instead of on a
// wall clock, which at 5Hz over a 30fps stream re-measures unchanged frames.
export const FOLLOW_HZ = 5;

// Per-cell change threshold, summed over R+G+B. Below this is JPEG noise: an
// MJPEG stream re-encodes every frame, so NOTHING is ever pixel-identical and a
// threshold of zero would report the whole screen as changing forever.
export const FOLLOW_CELL_DELTA = 24;

// A change covering more of the frame than this is a repaint, a scroll of the
// whole screen, or a video playing -- not a cursor. Following it would fling
// the view across the picture for something that is not where the user is
// working, so it is ignored and the view stays where they left it.
export const FOLLOW_MAX_FRACTION = 0.2;

// How long a manual pan or an explicit zoom keeps the follower's hands off.
// The user has just said where they want to look; overriding that half a second
// later is worse than not following at all.
export const FOLLOW_MANUAL_HOLD_MS = 4000;

// How much of a region's own bounding box has to have changed for it to be ONE
// thing. A caret fills its box; a caret plus a clock in the far corner spans
// most of the screen while changing a handful of cells, and the trailing-edge
// rule below would then chase the CLOCK and drag the caret off the top. When
// two things change at once there is no way to tell which one the user is
// looking at, so the honest answer is to stay put until only one of them does.
export const FOLLOW_MIN_DENSITY = 0.25;

// The band the region is kept inside, as a fraction of the box on each edge.
// Without it the view re-pans on every cursor blink, which reads as a jitter
// rather than as help.
export const FOLLOW_MARGIN = 0.2;


// Where the picture changed between two samples, in fractions of the frame.
//
// `prev` and `now` are RGBA sample buffers of cols*rows*4. Returns null when
// nothing moved, which is the common case and must stay cheap.
export function changedRegion(prev, now, cols, rows, delta=FOLLOW_CELL_DELTA) {
	let min_x = cols;
	let max_x = -1;
	let min_y = rows;
	let max_y = -1;
	let changed = 0;

	for (let cell = 0, p = 0; cell < cols * rows; cell += 1, p += 4) {
		let diff = (
			Math.abs(now[p] - prev[p])
			+ Math.abs(now[p + 1] - prev[p + 1])
			+ Math.abs(now[p + 2] - prev[p + 2])
		);
		if (diff > delta) {
			changed += 1;
			let x = cell % cols;
			let y = (cell - x) / cols;
			if (x < min_x) { min_x = x; }
			if (x > max_x) { max_x = x; }
			if (y < min_y) { min_y = y; }
			if (y > max_y) { max_y = y; }
		}
	}

	if (changed === 0) {
		return null;
	}
	return {
		"x": (min_x / cols),
		"y": (min_y / rows),
		"w": ((max_x + 1 - min_x) / cols),
		"h": ((max_y + 1 - min_y) / rows),
		"fraction": (changed / (cols * rows)),
	};
}


// Whether a change is worth moving the view for.
export function shouldFollow(region, scale, cols=FOLLOW_COLS, rows=FOLLOW_ROWS) {
	if (region === null) {
		return false;
	}
	// The share of the region's OWN box that actually changed. fraction is a
	// share of the whole frame, so it cannot see a sparse box.
	let box = (region.w * cols) * (region.h * rows);
	let density = (box > 0 ? (region.fraction * cols * rows) / box : 0);
	return (
		// At 1x the whole picture is already on screen; there is nowhere to pan
		// TO, and moving would only fight the clamp.
		scale > ZOOM_MIN
		&& region.fraction <= FOLLOW_MAX_FRACTION
		&& density >= FOLLOW_MIN_DENSITY
	);
}


// The pan that brings `region` back inside the comfort band -- {dx, dy} in box
// pixels, and {0, 0} when it is already comfortable, which is most of the time.
//
// `view` is the zoom's own {scale, x, y}; `viewport` the visible box
// {width, height}; `picture` is where the picture actually SITS in that box
// unzoomed, as stream.getGeometry() reports it; `region` is normalised to the
// picture, as changedRegion returns it.
//
// 🔴 The region is a fraction of the PICTURE, not of the box, and the two are
// not the same: drawImage samples the source bitmap, which `object-fit:
// contain` letterboxes inside the element. Measuring from the box instead put
// the cursor up to 780px from where it really was in a full-tab window on a
// phone -- most of the screen -- and panned the view into the black bars. Every
// other box-to-picture mapping in this tree already goes through getGeometry();
// this was the only one that did not.
export function followPan({view, viewport, picture, region, margin=FOLLOW_MARGIN}) {
	// An unzoomed box coordinate `b` is drawn at `view.x + b * scale`.
	let left = picture.x + region.x * picture.width;
	let top = picture.y + region.y * picture.height;
	return {
		"dx": __axis(
			view.x + left * view.scale,
			view.x + (left + region.w * picture.width) * view.scale,
			viewport.width, margin),
		"dy": __axis(
			view.y + top * view.scale,
			view.y + (top + region.h * picture.height) * view.scale,
			viewport.height, margin),
	};
}


// How far to move one axis so [lo, hi] sits inside the band.
//
// The TRAILING edge wins when the region is too big to fit: that is where a
// text cursor sits on the line it is on, and where new output appears at the
// bottom of a console. Preferring the leading edge instead keeps the start of
// a long line in view and leaves the cursor off the screen, which is the thing
// this whole module exists to stop.
var __axis = function(lo, hi, size, margin) {
	let band_lo = size * margin;
	let band_hi = size * (1 - margin);
	if (hi > band_hi) {
		return (band_hi - hi);
	}
	if (lo < band_lo) {
		return Math.min(band_lo - lo, band_hi - hi);
	}
	return 0;
};
