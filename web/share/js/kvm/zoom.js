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


// Zooming into the host's screen, for the one case where nothing else can help:
// a 1920x1080 console on a 390px phone is 4.8px per character, and the picture
// is PIXELS -- there is no font to make bigger. The browser's own pinch is not
// available over the video (the stream has to preventDefault single-finger
// touches, and allowing the two-finger case did not bring it back), so the
// gesture is recognised here and the view is transformed by us.
//
// State only: how far in, and where. Applying it to an element and reading
// touches belong to the caller. That keeps every rule below testable without a
// browser -- and these rules are exactly the ones that go wrong in a way you
// only notice by clicking 40px from where you meant to.

"use strict";


export const ZOOM_MIN = 1;
export const ZOOM_MAX = 4;


// Where a picture of `nw`x`nh` sits inside a `bw`x`bh` box under `object-fit:
// contain` -- scaled to fit and centred, with a letterbox on whichever axis has
// room left over.
//
// Every box-to-picture mapping needs this and none of them may disagree: a tap
// is sent to the host in picture coordinates, the OCR selection is read in
// them, and the follower pans by them. The letterbox is the whole difference
// between the two spaces and it is not small -- 1920x1080 contained in a
// 390x844 full-tab window leaves 312px of black above and below.
export function containFit(nw, nh, bw, bh) {
	let ratio = Math.min(bw / nw, bh / nh);
	return {
		"x": Math.round((bw - ratio * nw) / 2),
		"y": Math.round((bh - ratio * nh) / 2),
		"width": Math.round(ratio * nw),
		"height": Math.round(ratio * nh),
	};
}


export function makeZoom() {
	var self = this;

	/************************************************************************/

	var __scale = 1;
	var __x = 0; // Where the picture's top-left sits inside the box, in box px
	var __y = 0;
	var __width = 0;
	var __height = 0;

	/************************************************************************/

	// The box the picture is shown in. Panning is clamped to it, so the picture
	// can never be dragged off the screen and leave a blank strip.
	self.setViewport = function(width, height) {
		__width = width;
		__height = height;
		__clamp();
	};

	self.get = function() {
		return {"scale": __scale, "x": __x, "y": __y};
	};

	self.isZoomed = function() {
		return (__scale > ZOOM_MIN);
	};

	// factor: how much closer this gesture just got. anchor: the point on the
	// BOX the fingers are pinching around, which has to stay under them --
	// zooming about the centre instead sends whatever you were looking at off
	// the edge.
	self.pinch = function(factor, anchor) {
		let want = Math.min(Math.max(__scale * factor, ZOOM_MIN), ZOOM_MAX);
		let real = want / __scale; // What the clamp actually allowed
		__x = anchor.x - (anchor.x - __x) * real;
		__y = anchor.y - (anchor.y - __y) * real;
		__scale = want;
		__clamp();
	};

	self.pan = function(dx, dy) {
		__x += dx;
		__y += dy;
		__clamp();
	};

	self.reset = function() {
		__scale = 1;
		__x = 0;
		__y = 0;
	};

	// A point on the box, in the picture's own coordinates -- which is what the
	// host is told about. Without this a click at 1x lands where you tapped and
	// a click at 3x lands a third of the way there.
	self.toPicture = function(point) {
		return {
			"x": Math.round((point.x - __x) / __scale),
			"y": Math.round((point.y - __y) / __scale),
		};
	};

	/************************************************************************/

	var __clamp = function() {
		if (__scale <= ZOOM_MIN) {
			__scale = ZOOM_MIN;
			__x = 0;
			__y = 0;
			return;
		}
		// The picture is `scale` times the box, so its top-left may sit between
		// "box fully covered from the right" and zero.
		__x = Math.min(0, Math.max(__x, __width - __width * __scale));
		__y = Math.min(0, Math.max(__y, __height - __height * __scale));
	};
}
