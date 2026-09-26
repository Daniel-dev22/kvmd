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

// The terminal is somebody else's application in an iframe, and the size of its
// type is NOT set from here.
//
// ttyd does read options off its URL -- `fontSize` included; the parser is in
// the build running on the appliance -- and that was tried first, at 18px and
// then at 30px. Both were reported from the phone as having no effect, and
// nothing this side of the iframe can prove otherwise: the query has to survive
// kvmd's proxying, the redirect to login, and ttyd's own websocket handshake
// before it means anything. A knob that cannot be verified is not a knob.
//
// What replaced it is `zoom` on the iframe, in kvm/stream.css, which needs
// nothing from ttyd: the terminal is handed half the viewport, lays itself out
// for that, and every pixel it draws comes out twice the size. See the comment
// there for the measurement.

"use strict";


export function webtermUrl(base, path) {
	// The trailing slash avoids an Nginx 301 when the location has none, which
	// a reverse proxy in front of PiKVM can be misconfigured to mishandle.
	// disableLeaveAlert stops ttyd asking "are you sure?" on every navigation.
	return base + path + "/?disableLeaveAlert=true";
}
