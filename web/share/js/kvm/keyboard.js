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
import {wm} from "../wm.js";
import {UI_MOBILE} from "../ui.js";
import {printText} from "./print.js";
import {PAD, decodeEdit, makeTypingQueue} from "./typing.js";


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

	// The typing bar owns the line being typed, so the scancode path must keep
	// its hands off the keys that edit it.
	//
	// This handler is bound on the whole keyboard WINDOW, and the bar lives
	// inside it -- so every key pressed in the bar was also going out as a
	// scancode the instant it was pressed. Enter reached the host TWICE, and the
	// immediate one arrived ahead of the characters it was meant to run; every
	// other key was preventDefault()ed before it could enter the field at all,
	// which is why a hardware keyboard could not type into the bar.
	//
	// A character, Backspace, Delete and Enter are part of the line and go
	// through the bar's queue. Everything else -- Esc, Tab, the arrows, anything
	// held with Ctrl/Alt/Meta -- is not, and still goes straight out, because
	// Ctrl+C in a console is not optional.
	var __isTypingBarKey = function(ev) {
		if (ev.target !== $("hid-type-input") || typeof ev.key !== "string") {
			return false;
		}
		if (ev.ctrlKey || ev.altKey || ev.metaKey) {
			return false;
		}
		// "Process" and "Unidentified" are a soft keyboard mid-composition: the
		// field is the only thing that can say what the user meant.
		return (ev.key.length === 1
			|| ["Enter", "Backspace", "Delete", "Process", "Unidentified"].includes(ev.key));
	};

	var __keyboardHandler = function(ev, state) {
		if (__isTypingBarKey(ev)) {
			return;
		}
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
	// and there is no second copy of every keymap in the browser. Editing
	// intents that are not characters -- Backspace, Enter -- go out as ordinary
	// key events, through the SAME queue, so they cannot overtake the text they
	// follow.
	//
	// The field is a pipe, never a transcript: see typing.js. It holds the word
	// an IME is still composing and nothing else, because everything before that
	// has already reached the host.

	var __typed = "";
	var __composing = false;
	var __queue = null;
	var __reset_timer = null;
	var __exitTyping = null;
	var __blur_timer = null;

	var __initTyping = function() {
		let el = $("hid-type-input");
		if (el === null) {
			return; // Desktop pages do not render the typing bar
		}

		__queue = makeTypingQueue({
			"print": (text, keymap, done) => printText(text, keymap, 0, (http) => done(http.status === 200, http)),
			"sendKey": __sendKey,
			"getKeymap": function() {
				// The Text menu already owns the keymap chooser; reuse it
				// rather than offering a second one that could disagree.
				let el_km = $("hid-pak-keymap-selector");
				return ((el_km !== null && el_km.value) ? el_km.value : "en-us");
			},
			"onError": (http) => tools.error("Keyboard: typing failed:", http.status, http.responseText),
		});

		// While the system keyboard is up, the scancode layers are redundant --
		// Android already has the letters -- and they are eating the screen. Only
		// what a phone keyboard CANNOT send stays: Esc, the modifiers, Tab and
		// the arrows. The layer picker stays too, so the full board is one tap
		// away; tapping it dismisses the system keyboard.
		// On a phone this window is opened to TYPE far more often than to send a
		// scancode, and the bar that starts that sits BELOW the whole board --
		// which is exactly why it gets missed. Opening straight into typing mode
		// puts the phone's own keyboard up with only the keys it cannot send
		// above it. The layer picker still expands the full board in one tap.
		let el_win = $("keyboard-window");
		if (el_win !== null) {
			el_win.show_hook = function() {
				if (document.documentElement.getAttribute("data-ui") === UI_MOBILE) {
					el.focus();
				}
			};
		}

		el.addEventListener("focus", function() {
			if (__blur_timer !== null) {
				clearTimeout(__blur_timer);
				__blur_timer = null;
			}
			// The padding only has to exist while a soft keyboard is looking at
			// the field. Installing it on focus keeps the field genuinely empty
			// the rest of the time, which is what lets the placeholder render.
			__resetField(el);
			document.documentElement.setAttribute("data-typing", "1");
			wm.organizeAllWindows();
		});
		__exitTyping = function() {
			// An explicit layer choice is not the momentary blur the debounce
			// below exists to absorb, so it leaves typing mode at once. Waiting
			// out the 200ms meant the board did not come back on the tap that
			// asked for it, which is the whole of "one tap away".
			if (__blur_timer !== null) {
				clearTimeout(__blur_timer);
				__blur_timer = null;
			}
			el.blur();
			document.documentElement.removeAttribute("data-typing");
			wm.organizeAllWindows();
		};

		el.addEventListener("blur", function(ev) {
			__clearField(el);
			// Typing mode is a MODE, not a shadow of where focus happens to be.
			// Focus moving to another CONTROL is not a decision to leave it:
			// tapping the mouse button in this window's own header blurred the
			// bar, so 200ms later the full scancode board unfolded over the
			// pad the user had just asked for -- reported from a phone as
			// "i click mouse and it opens full on screen pikvm keyboard".
			// relatedTarget is null only when focus went NOWHERE, which is what
			// dismissing the system keyboard does; then the board is welcome
			// back, because the space it was making way for has gone.
			if (ev.relatedTarget !== null) {
				return;
			}
			// Pressing a key in the strip must not collapse and re-expand the
			// sheet under the user's finger, so a momentary blur is ignored.
			__blur_timer = setTimeout(function() {
				__blur_timer = null;
				document.documentElement.removeAttribute("data-typing");
				wm.organizeAllWindows();
			}, 200);
		});

		// An IME composes a word in place, firing an input event per character.
		// Those are forwarded like any other edit: the host has to track the
		// finger, not lag a word behind it. Suppressing them until the word
		// committed is what made the field disagree with the console -- the
		// letters sat in the box, the console stayed blank, and a delete inside
		// the word reached the host as nothing at all.
		//
		// What composition DOES gate is the reset: the field is the IME's own
		// workspace until it commits, so it is left alone until then.
		el.addEventListener("compositionstart", function() {
			__composing = true;
		});
		el.addEventListener("compositionend", function() {
			__composing = false;
			// Engines disagree about whether the final input event comes before
			// or after this one, so both paths decode. Whichever runs second
			// sees no change and emits nothing.
			__onEdit(el, null);
		});
		el.addEventListener("input", function(ev) {
			__onEdit(el, ev.inputType);
		});
		el.addEventListener("keydown", function(ev) {
			if (ev.key === "Enter") {
				// preventDefault stops the single-line field submitting, and is
				// why no input event follows this to double the Enter.
				ev.preventDefault();
				if (!$("hid-mute-switch").checked) {
					// Queued, not sent: Enter runs the command, so it must not
					// reach the host before the characters of that command do.
					__queue.push([{"key": "Enter", "n": 1}]);
				}
				__resetField(el);
			}
		});

		tools.el.setOnClick($("hid-type-clear"), function() {
			// Local only -- clears the field, never touches the host.
			__resetField(el);
			el.focus();
		});
	};

	// The field is put back to its padding after every edit, so nothing
	// accumulates in it. It happens on the next task rather than inside the
	// handler: mutating the value a soft keyboard is mid-way through reading is
	// how an IME ends up duplicating what it just inserted.
	var __scheduleReset = function(el) {
		if (__reset_timer !== null) {
			return;
		}
		__reset_timer = setTimeout(function() {
			__reset_timer = null;
			if (__composing) {
				return; // The IME still owns the field; compositionend reschedules
			}
			__resetField(el);
		}, 0);
	};

	var __resetField = function(el) {
		el.value = PAD;
		__typed = PAD;
		// Programmatic assignment fires no input event, so this cannot loop.
		el.setSelectionRange(PAD.length, PAD.length);
	};

	var __clearField = function(el) {
		// A reset still pending from the last edit would put the padding back
		// after this, and a field that is not empty renders no placeholder -- so
		// leaving typing mode would leave an empty-looking box with no hint in it.
		if (__reset_timer !== null) {
			clearTimeout(__reset_timer);
			__reset_timer = null;
		}
		el.value = "";
		__typed = "";
	};

	var __onEdit = function(el, input_type) {
		let was = __typed;
		let now = el.value;
		__typed = now;
		__scheduleReset(el);
		if ($("hid-mute-switch").checked) {
			return;
		}
		__queue.push(decodeEdit({"was": was, "now": now, "input_type": input_type}));
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
			tools.el.setOnClick(el_bt, function() {
				// Choosing a layer means you want the scancode board, so let go
				// of the typing field and put the system keyboard away.
				if (__exitTyping !== null) {
					__exitTyping();
				}
				__setLayer(el_bt.getAttribute("data-keypad-layer-button"));
			});
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
