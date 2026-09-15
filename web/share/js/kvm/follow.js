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
//   output scrolling  the bottom of the text
//   a BIOS/TUI menu   the highlighted row
//
// One mechanism, four cases, and no rule anywhere about where prompts live.
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
export function shouldFollow(region, scale) {
	return (
		region !== null
		// At 1x the whole picture is already on screen; there is nowhere to pan
		// TO, and moving would only fight the clamp.
		&& scale > ZOOM_MIN
		&& region.fraction <= FOLLOW_MAX_FRACTION
	);
}


// The pan that brings `region` back inside the comfort band -- {dx, dy} in box
// pixels, and {0, 0} when it is already comfortable, which is most of the time.
//
// `view` is the zoom's own {scale, x, y}; `viewport` the box {width, height};
// `region` is normalised to the frame, as changedRegion returns it.
export function followPan({view, viewport, region, margin=FOLLOW_MARGIN}) {
	// The picture is `scale` boxes wide, and view.x is where its left edge sits.
	let span_x = viewport.width * view.scale;
	let span_y = viewport.height * view.scale;
	return {
		"dx": __axis(
			view.x + region.x * span_x,
			view.x + (region.x + region.w) * span_x,
			viewport.width, margin),
		"dy": __axis(
			view.y + region.y * span_y,
			view.y + (region.y + region.h) * span_y,
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
