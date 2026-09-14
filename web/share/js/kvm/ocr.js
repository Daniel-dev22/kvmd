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


"use strict";


import {tools, $} from "../tools.js";
import {wm} from "../wm.js";
import {clipboard} from "./clipboard.js";


export function Ocr(__getGeometry) {
	var self = this;

	/************************************************************************/

	var __enabled = null;

	var __start_pos = null;
	var __end_pos = null;
	var __sel = null;

	var __init__ = function() {
		tools.el.setOnClick($("stream-ocr-button"), function() {
			__resetSelection();
			wm.showWindow($("stream-window"));
			wm.showWindow($("stream-ocr-window"));
		});

		$("stream-ocr-lang-selector").addEventListener("change", function() {
			tools.storage.set("stream.ocr.lang", $("stream-ocr-lang-selector").value);
		});

		$("stream-ocr-window").addEventListener("blur", __resetSelection);
		$("stream-ocr-window").addEventListener("resize", __resetSelection);
		$("stream-ocr-window").close_hook = __resetSelection;

		$("stream-ocr-window").onkeyup = function(ev) {
			ev.preventDefault();
			if (ev.code === "Enter") {
				__confirmSelection();
			} else if (ev.code === "Escape") {
				wm.closeWindow($("stream-ocr-window"));
			}
		};

		// Enter and Escape are the whole interface to this overlay, and a phone
		// has neither. The two buttons are the same two actions, reachable --
		// and they are shown to everybody rather than gated on a media query,
		// because "has a keyboard" is not something the page can ask.
		tools.el.setOnClick($("stream-ocr-confirm-button"), __confirmSelection);
		tools.el.setOnClick($("stream-ocr-cancel-button"), () => wm.closeWindow($("stream-ocr-window")));

		// A box drawn by a finger is the same box drawn by a mouse.
		tools.el.setOnDrag($("stream-ocr-window"), {
			"onStart": __startSelection,
			"onMove": __changeSelection,
			"onEnd": __endSelection,
			"onCancel": __resetSelection,
		});
	};

	/************************************************************************/

	self.setState = function(state) {
		if (state) {
			if (state.enabled !== undefined) {
				// Not gated on (hover: hover) any more. Selection was bound to
				// the mouse only, so the whole feature used to be switched off
				// wherever there was no pointer -- a capability silently absent
				// on a phone rather than adapted to it.
				__enabled = state.enabled;
				tools.feature.setEnabled($("stream-ocr"), __enabled);
				$("stream-ocr-led").className = (__enabled ? "led-gray" : "hidden");
			}
			if (__enabled && state.langs !== undefined) {
				__updateLangs(state.langs);
			}
		} else {
			__enabled = false;
			tools.feature.setEnabled($("stream-ocr"), false);
			$("stream-ocr-led").className = "hidden";
		}
	};

	var __updateLangs = function(langs) {
		let el = $("stream-ocr-lang-selector");
		el.options.length = 0;
		for (let lang of langs.available) {
			tools.selector.addOption(el, lang, lang);
		}
		el.value = tools.storage.get("stream.ocr.lang", langs["default"]);
	};

	// The buttons sit on top of the drawing surface, so a tap on one must not
	// also start a box behind it.
	var __isControl = function(target) {
		return $("stream-ocr-controls").contains(target);
	};

	var __startSelection = function(point, ev) {
		if (__isControl(ev.target)) {
			return;
		}
		if (__start_pos === null) {
			tools.hidden.setVisible($("stream-ocr-selection"), false);
			__setSelection(null);
			__start_pos = __getGlobalPosition(point);
			__end_pos = null;
		}
	};

	var __changeSelection = function(point) {
		if (__start_pos !== null) {
			__end_pos = __getGlobalPosition(point);
			let width = Math.abs(__start_pos.x - __end_pos.x);
			let height = Math.abs(__start_pos.y - __end_pos.y);
			let el = $("stream-ocr-selection");
			el.style.left = Math.min(__start_pos.x, __end_pos.x) + "px";
			el.style.top = Math.min(__start_pos.y, __end_pos.y) + "px";
			el.style.width = width + "px";
			el.style.height = height + "px";
			tools.hidden.setVisible(el, (width > 1 || height > 1));
		}
	};

	var __endSelection = function(point, ev) {
		if (__start_pos === null || __isControl(ev.target)) {
			return;
		}
		__changeSelection(point);
		let el = $("stream-ocr-selection");
		let ok = (
			el.offsetWidth > 1 && el.offsetHeight > 1
			&& __start_pos !== null && __end_pos !== null
		);
		tools.hidden.setVisible(el, ok);
		if (ok) {
			let rect = $("stream-box").getBoundingClientRect();
			let rel_left = Math.min(__start_pos.x, __end_pos.x) - rect.left;
			let rel_right = Math.max(__start_pos.x, __end_pos.x) - rect.left;
			let offset = __getNavbarOffset();
			let rel_top = Math.min(__start_pos.y, __end_pos.y) - rect.top + offset;
			let rel_bottom = Math.max(__start_pos.y, __end_pos.y) - rect.top + offset;
			let geo = __getGeometry();
			__setSelection({
				"left": tools.remap(rel_left - geo.x, 0, geo.width, 0, geo.real_width),
				"right": tools.remap(rel_right - geo.x, 0, geo.width, 0, geo.real_width),
				"top": tools.remap(rel_top - geo.y, 0, geo.height, 0, geo.real_height),
				"bottom": tools.remap(rel_bottom - geo.y, 0, geo.height, 0, geo.real_height),
			});
		} else {
			__setSelection(null);
		}
		__start_pos = null;
		__end_pos = null;
	};

	// One place decides both what will be recognized and whether the button
	// that recognizes it can be pressed, so the two cannot disagree.
	var __setSelection = function(sel) {
		__sel = sel;
		tools.el.setEnabled($("stream-ocr-confirm-button"), (sel !== null));
	};

	var __confirmSelection = function() {
		if (__sel) {
			__recognizeSelection();
			wm.closeWindow($("stream-ocr-window"));
		}
	};

	var __getGlobalPosition = function(point) {
		let rect = $("stream-box").getBoundingClientRect();
		let geo = __getGeometry();
		let offset = __getNavbarOffset();
		return {
			"x": Math.min(Math.max(point.x, rect.left + geo.x), rect.right - geo.x),
			"y": Math.min(Math.max(point.y - offset, rect.top + geo.y - offset), rect.bottom - geo.y - offset),
		};
	};

	var __getNavbarOffset = function() {
		if (tools.browser.is_firefox) {
			// На лисе наблюдается оффсет из-за навбара, хз почему
			return wm.getViewGeometry().top;
		}
		return 0;
	};

	var __resetSelection = function() {
		tools.hidden.setVisible($("stream-ocr-selection"), false);
		__start_pos = null;
		__end_pos = null;
		__setSelection(null);
	};

	var __recognizeSelection = function() {
		tools.el.setEnabled($("stream-ocr-button"), false);
		tools.el.setEnabled($("stream-ocr-lang-selector"), false);
		$("stream-ocr-led").className = "led-yellow-rotating-fast";
		let params = {
			"allow_offline": 1,
			"ocr": 1,
			"ocr_langs": $("stream-ocr-lang-selector").value,
			"ocr_left": __sel.left,
			"ocr_top": __sel.top,
			"ocr_right": __sel.right,
			"ocr_bottom": __sel.bottom,
		};
		tools.httpGet("api/streamer/snapshot", params, function(http) {
			if (http.status === 200) {
				clipboard.setText(http.responseText);
			} else {
				wm.error("OCR error:<br>", http.responseText);
			}
			tools.el.setEnabled($("stream-ocr-button"), true);
			tools.el.setEnabled($("stream-ocr-lang-selector"), true);
			$("stream-ocr-led").className = "led-gray";
		}, null, null, 30000);
	};

	__init__();
}
