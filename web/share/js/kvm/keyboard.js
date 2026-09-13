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


import {tools, $, $$$} from "../tools.js";
import {Keypad} from "../keypad.js";
import {printText} from "./print.js";
import {diffTyped, makePrintQueue} from "./typing.js";


export function Keyboard(__recordWsEvent) {
	var self = this;

	/************************************************************************/

	var __ws = null;
	var __online = true;

	var __caps_led = false;

	var __keypad = null;
	var __el_magic = null;

	var __init__ = function() {
		// Built on the whole window, so it binds BOTH arrangements. Keypad
		// resolves a code to every element carrying it, which is what keeps
		// modifier state in step between the desktop and compact boards.
		__keypad = new Keypad($("keyboard-window"), __sendKey);

		__initLayers();
		__initTyping();

		$("hid-keyboard-led").title = "Keyboard free";

		for (let el of [$("keyboard-window"), $("mouse-window"), $("stream-window")]) {
			el.onkeydown = (ev) => __keyboardHandler(ev, true);
			el.onkeyup = (ev) => __keyboardHandler(ev, false);
			el.addEventListener("focus", __updateOnlineLeds);
			el.addEventListener("blur", __updateOnlineLeds);
		}

		window.addEventListener("focusin", __updateOnlineLeds);
		window.addEventListener("focusout", __updateOnlineLeds);

		for (let what of ["mouseenter", "mouseleave", "mousemove"]) {
			window.addEventListener(what, __syncCapsOnMouse);
		}

		tools.storage.bindSimpleSwitch($("hid-keyboard-bad-link-switch"), "hid.keyboard.bad_link", false);
		tools.storage.bindSimpleSwitch($("hid-keyboard-swap-cc-switch"), "hid.keyboard.swap_cc", false);
		tools.storage.bindSimpleSwitch($("hid-keyboard-sync-caps-switch"), "hid.keyboard.sync_caps", false);

		__el_magic = $("hid-keyboard-magic-selector");
		let alt = (tools.browser.is_apple ? "Option" : "Alt");
		let meta = (tools.browser.is_win ? "Win" : "Meta");
		let sel = tools.storage.get("hid.keyboard.magic", (tools.browser.is_apple ? "AltRight" : "ControlRight"));
		for (let kv of [
			["Ctrl Left", "ControlLeft"],
			[`${alt} Left`, "AltLeft"],
			["Shift Left", "ShiftLeft"],
			[`${meta} Left`, "MetaLeft"],
			null,
			["Ctrl Right", "ControlRight"],
			[`${alt} Right`, "AltRight"],
			["Shift Right", "ShiftRight"],
			[`${meta} Right`, "MetaRight"],
			null,
			["Menu Key", "ContextMenu"],
			null,
			["\u2500 None \u2500", ""],
		]) {
			if (kv === null) {
				tools.selector.addSeparator(__el_magic, 8);
			} else {
				if ((tools.browser.is_apple || tools.browser.is_win) && kv[1].startsWith("Meta")) {
					continue;
				}
				tools.selector.addOption(__el_magic, kv[0], kv[1], (kv[1] === sel));
			}
		}
		__el_magic.addEventListener("change", function() {
			tools.storage.set("hid.keyboard.magic", __el_magic.value);
		});
	};

	/************************************************************************/

	self.setSocket = function(ws) {
		if (ws !== __ws) {
			self.releaseAll();
			__ws = ws;
		}
		__updateOnlineLeds();
	};

	self.setState = function(online, leds, hid_online, hid_busy) {
		if (!hid_online) {
			__online = null;
		} else {
			__online = (online && !hid_busy);
		}
		__updateOnlineLeds();

		__caps_led = leds["caps"];
		for (let led of ["caps", "scroll", "num"]) {
			for (let el of $$$(`.hid-keyboard-${led}-led`)) {
				if (leds[led]) {
					el.classList.add("led-green");
					el.classList.remove("led-gray");
				} else {
					el.classList.add("led-gray");
					el.classList.remove("led-green");
				}
			}
		}
	};

	self.releaseAll = function() {
		__keypad.releaseAll();
	};

	self.emit = function(code, state) {
		__keypad.emit(code, state);
	};

	var __updateOnlineLeds = function() {
		let is_captured = (
			$("stream-window").classList.contains("window-active")
			|| $("keyboard-window").classList.contains("window-active")
			|| $("mouse-window").classList.contains("window-active")
		);
		let led = "led-gray";
		let title = "Keyboard free";

		if (__ws) {
			if (__online === null) {
				led = "led-red";
				title = (is_captured ? "Keyboard captured, emulator offline" : "Keyboard free, emulator offline");
			} else if (__online) {
				if (is_captured) {
					led = "led-green";
					title = "Keyboard captured";
				}
			} else {
				led = "led-yellow";
				title = (is_captured ? "Keyboard captured, inactive/busy" : "Keyboard free, inactive/busy");
			}
		} else {
			if (is_captured) {
				title = "Keyboard captured, PiKVM offline";
			}
		}
		$("hid-keyboard-led").className = led;
		$("hid-keyboard-led").title = title;
	};

	/************************************************************************/

	var __sync_caps_armed = true;

	var __syncCapsReload = function() {
		__sync_caps_armed = false;
		setTimeout(function() { __sync_caps_armed = true; }, 1500);
	};

	var __isSyncCapsActivated = function(ev) {
		if (__online && __sync_caps_armed) {
			let caps = ev.getModifierState("CapsLock");
			if (caps !== __caps_led && $("hid-keyboard-sync-caps-switch").checked) {
				tools.info("Synchronizing CapsLock:", __caps_led, "->", caps);
				__syncCapsReload();
				return true;
			}
		}
		return false;
	};

	var __syncCapsOnMouse = function(ev) {
		if (__isSyncCapsActivated(ev)) {
			__innerSendKey("CapsLock", true);
			setTimeout(function() {
				__innerSendKey("CapsLock", false);
			}, 100);
		}
	};

	var __keyboardHandler = function(ev, state) {
		if (ev.code === "CapsLock") {
			__syncCapsReload();
		}
		if (__isSyncCapsActivated(ev)) {
			__innerSendKey("CapsLock", true);
			setTimeout(function() {
				__innerSendKey("CapsLock", false);
				setTimeout(() => __innerKeyboardHandler(ev, state), 100);
			}, 100);
		} else {
			__innerKeyboardHandler(ev, state);
		}
	};

	var __altgr_ctrl_timer = null;

	var __innerKeyboardHandler = function(ev, state) {
		ev.preventDefault();
		if (ev.repeat) {
			return;
		}
		let code = ev.code;

		// https://github.com/pikvm/pikvm/issues/819
		if (code === "IntlBackslash" && ["`", "~"].includes(ev.key)) {
			code = "Backquote";
		} else if (code === "Backquote" && ["§", "±"].includes(ev.key)) {
			code = "IntlBackslash";
		}

		// Mac CMD key fix
		if (tools.browser.is_mac) {
			if (!__magic_pressed && !state && ["MetaLeft", "MetaRight"].includes(code)) {
				self.releaseAll();
			}
		}

		// https://github.com/pikvm/pikvm/issues/375
		// https://github.com/novnc/noVNC/blob/84f102d6/core/input/keyboard.js
		if (tools.browser.is_win) {
			if (state) {
				if (__altgr_ctrl_timer) {
					// Если у нас было отложенное нажатие Ctrl, и новая клавиша не Alt,
					// то выстреливаем Ctrl немедленно.
					clearTimeout(__altgr_ctrl_timer);
					__altgr_ctrl_timer = null;
					if (code !== "AltRight") {
						__keypad.emit("ControlLeft", true);
					}
				}
				if (code === "ControlLeft" && !__keypad.isCodeActive("ControlLeft")) {
					// Если пришел новый Ctrl, откладываем его нажатие на 50ms...
					__altgr_ctrl_timer = setTimeout(function() {
						__altgr_ctrl_timer = null;
						__keypad.emit("ControlLeft", true);
					}, 50);
					return; // ... и больше не делаем вообще ничего
				}
			} else {
				if (__altgr_ctrl_timer) {
					// Если Ctrl был отложен, но что-то отпустили,
					// то выстреливаем Ctrl немедленно.
					clearTimeout(__altgr_ctrl_timer);
					__altgr_ctrl_timer = null;
					__keypad.emit("ControlLeft", true);
				}
			}
		}

		__keypad.emit(code, state);
	};

	var __magic_pressed = false;
	var __magic_pressed_ts = 0;
	var __magic_started = false;
	var __magic_fired_once = false;
	var __magic_mods = [];
	var __all_mods = {
		"ControlLeft": "Ctrl L",
		"ControlRight": "Ctrl R",
		"AltLeft": (tools.browser.is_apple ? "Option L" : "Alt L"),
		"AltRight": (tools.browser.is_apple ? "Option R" : "Alt R"),
		"ShiftLeft": "Shift L",
		"ShiftRight": "Shift R",
		"MetaLeft": (tools.browser.is_apple ? "Cmd L" : "Meta L"),
		"MetaRight": (tools.browser.is_apple ? "Cmd R" : "Meta R"),
	};

	var __isModifier = function(code) {
		return (code in __all_mods);
	};

	var __startMagic = function() {
		__magic_started = true;
		__drawMagicOverStream();
	};

	var __addNewMagicModifier = function(code) {
		if (!__magic_mods.includes(code)) {
			__magic_mods.push(code);
			__drawMagicOverStream();
			return true;
		}
		return false;
	};

	var __drawMagicOverStream = function(code=null) {
		let html = "";
		if (__magic_started) {
			html += "<span>Shortcut &rarr;</span>";
		}
		for (let mod of __magic_mods) {
			html += `<span>${__all_mods[mod]}</span>`;
		}
		if (code) {
			html += `<span>${code}</span>`;
		}
		$("stream-keyboard-magic").innerHTML = html;
	};

	var __releaseMagicModifiers = function() {
		while (__magic_mods.length > 0) {
			__innerSendKey(__magic_mods.pop(), false, false);
		}
		__magic_started = false;
		__magic_fired_once = false;
		__magic_mods = [];
		setTimeout(function() {
			if (!__magic_started) {
				__drawMagicOverStream();
			}
		}, 100);
	};

	var __sendKey = function(code, state) {
		if ($("hid-keyboard-swap-cc-switch").checked) {
			if (code === "ControlLeft") {
				code = "CapsLock";
			} else if (code === "CapsLock") {
				code = "ControlLeft";
			}
		}
		if (code === __el_magic.value) {
			let now_ts = new Date().getTime();
			__magic_pressed = state;
			if (state) {
				if (__magic_started) {
					if (now_ts - __magic_pressed_ts < 250) {
						__releaseMagicModifiers();
					}
				} else {
					__startMagic();
				}
			} else if (__magic_fired_once) {
				__releaseMagicModifiers();
			}
			__magic_pressed_ts = now_ts;
		} else {
			if (__magic_started) {
				if (__isModifier(code)) {
					if (state && __addNewMagicModifier(code)) {
						__innerSendKey(code, state, false);
					}
				} else {
					__drawMagicOverStream(state ? code : null);
					__innerSendKey(code, state, false);
					__magic_fired_once = true;
					if (!__magic_pressed) {
						__releaseMagicModifiers();
					}
				}
			} else {
				__innerSendKey(code, state, true);
			}
		}
	};

	// ======================= native typing =======================
	//
	// The phone's own keyboard drives the host. Characters go through the
	// server's keymap (api/hid/print) rather than being mapped to scancodes
	// here, so swipe, dictation, long-press accents and autocorrect all work,
	// and there is no second copy of every keymap in the browser.
	//
	// Editing intents that are not characters -- Backspace, Enter -- are sent
	// as ordinary key events on the existing socket.

	var __typed = "";
	var __composing = false;
	var __printer = null;

	var __initTyping = function() {
		let el = $("hid-type-input");
		if (el === null) {
			return; // Desktop pages do not render the typing bar
		}

		__printer = makePrintQueue({
			"post": (text, keymap, done) => printText(text, keymap, 0, (http) => done(http.status === 200, http)),
			"getKeymap": function() {
				// The Text menu already owns the keymap chooser; reuse it
				// rather than offering a second one that could disagree.
				let el_km = $("hid-pak-keymap-selector");
				return ((el_km !== null && el_km.value) ? el_km.value : "en-us");
			},
			"onError": (http) => tools.error("Keyboard: typing failed:", http.status, http.responseText),
		});

		// An IME composes in place and fires input events for partial text.
		// Sending those would type every intermediate guess to the host.
		el.addEventListener("compositionstart", function() {
			__composing = true;
		});
		el.addEventListener("compositionend", function() {
			__composing = false;
			__syncTyped(el);
		});
		el.addEventListener("input", function() {
			if (!__composing) {
				__syncTyped(el);
			}
		});
		el.addEventListener("keydown", function(ev) {
			if (ev.key === "Enter") {
				ev.preventDefault();
				__sendKey("Enter", true);
				__sendKey("Enter", false);
				el.value = "";
				__typed = "";
			}
		});

		tools.el.setOnClick($("hid-type-clear"), function() {
			// Local only -- clears the field, never touches the host.
			el.value = "";
			__typed = "";
			el.focus();
		});
	};

	var __syncTyped = function(el) {
		let now = el.value;
		let was = __typed;
		__typed = now;

		if ($("hid-mute-switch").checked) {
			return;
		}

		let change = diffTyped(was, now);
		for (let left = change.backspaces; left > 0; left -= 1) {
			__sendKey("Backspace", true);
			__sendKey("Backspace", false);
		}
		__printer.push(change.added);
	};

	// The compact board shows one layer at a time. Desktop ignores this
	// entirely -- it shows every key at once and the picker is not rendered.
	var __setLayer = function(layer) {
		let el_keypad = $("keyboard-compact");
		if (el_keypad === null) {
			return;
		}
		el_keypad.setAttribute("data-layer", layer);
		tools.storage.set("hid.keyboard.layer", layer);
		for (let el_bt of $$$("[data-keypad-layer-button]")) {
			let on = (el_bt.getAttribute("data-keypad-layer-button") === layer);
			el_bt.setAttribute("aria-pressed", String(on));
		}
	};

	var __initLayers = function() {
		for (let el_bt of $$$("[data-keypad-layer-button]")) {
			tools.el.setOnClick(el_bt, () => __setLayer(el_bt.getAttribute("data-keypad-layer-button")));
		}
		__setLayer(tools.storage.get("hid.keyboard.layer", "abc"));
	};

	var __innerSendKey = function(code, state, allow_finish) {
		tools.debug("Keyboard: key", (state ? "pressed:" : "released:"), code);
		let ev = {
			"event_type": "key",
			"event": {
				"key": code,
				"state": state,
				"finish": (allow_finish && $("hid-keyboard-bad-link-switch").checked),
			},
		};
		if (__ws && !$("hid-mute-switch").checked) {
			__ws.sendHidEvent(ev);
		}
		delete ev.event.finish;
		__recordWsEvent(ev);
	};

	__init__();
}
