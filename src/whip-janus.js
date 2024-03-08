'use strict';

/*
 * Simple WHIP server
 *
 * Author:  Lorenzo Miniero <lorenzo@meetecho.com>
 * License: GPLv3
 *
 * Janus API stack (WebSocket)
 *
 */

/*
 * Usage:
 *
 * var WhipJanus = require("./whip-janus.js");
 * var wj = new WhipJanus(config);
 *
 */

var noop = function(){};

// Connectivity
var WebSocketClient = require('websocket').client;

// Debugging
var debug = require('debug');
var whip = {
	vdebug: debug('janus:vdebug'),
	debug: debug('janus:debug'),
	err: debug('janus:error'),
	warn: debug('janus:warn'),
	info: debug('janus:info')
};

var whipJanus = function(janusConfig) {

	let that = this;

	// We use this method to register callbacks
	this.callbacks = {};
	this.on = function(event, callback) {
		that.callbacks[event] = callback;
	}

	// Configuration is static for now: we'll make this dynamic
	this.config = {
		janus: {
			ws: janusConfig.address,
			apiSecret: janusConfig.apiSecret
		}
	};
	whip.debug("Janus:", that.config);
	// Enrich the configuration with the additional info we need
	that.config.janus.session = { id: 0 };
	that.config.janus.state = "disconnected";
	that.config.janus.transactions = {};
	// Tables
	let sessions = {};		// Not to be confused with Janus sessions
	let handles = {};		// All Janus handles (map to local sessions here)

	// Public method to check when the class object is ready
	this.isReady = function() { return that.config.janus.session && that.config.janus.session.id !== 0; };
	this.getState = function() { return that.config.janus.state; };

	// Connect to Janus via WebSockets
	this.connect = function(callback) {
		whip.info("Connecting to " + that.config.janus.ws);
		// Callbacks
		callback = (typeof callback == "function") ? callback : noop;
		let disconnectedCB = (typeof that.callbacks["disconnected"] == "function") ? that.callbacks["disconnected"] : noop;
		// Connect to Janus via WebSockets
		if(that.config.janus.state !== "disconnected" || that.config.ws) {
			whip.warn("Already connected/connecting");
			callback({ error: "Already connected/connecting" });
			return;
		}
		that.config.ws = new WebSocketClient();
		that.config.ws.on('connectFailed', function(error) {
			whip.err('Janus WebSocket Connect Error: ' + error.toString());
			cleanup();
			callback({ error: error.toString() });
			disconnectedCB();
		});
		that.config.ws.on('connect', function(connection) {
			whip.info('Janus WebSocket Client Connected');
			that.config.ws.connection = connection;
			// Register events
			connection.on('error', function(error) {
				whip.err("Janus WebSocket Connection Error: " + error.toString());
				cleanup();
				callback({ error: error.toString() });
				disconnectedCB();
			});
			connection.on('close', function() {
				whip.info('Janus WebSocket Connection Closed');
				cleanup();
				disconnectedCB();
			});
			connection.on('message', function(message) {
				if(message.type === 'utf8') {
					let json = JSON.parse(message.utf8Data);
					whip.vdebug("Received message:", json);
					let event = json["janus"];
					let transaction = json["transaction"];
					if(transaction) {
						let reportResult = that.config.janus.transactions[transaction];
						if(reportResult) {
							reportResult(json);
						}
						return;
					}
					if(event === 'hangup') {
						// Janus told us this PeerConnection is gone
						let sender = json["sender"];
						let handle = handles[sender];
						if(handle) {
							let session = sessions[handle.uuid];
							if(session && session.uuid && session.teardown && (typeof session.teardown === "function")) {
								// Notify the application layer
								session.teardown(session.uuid);
							}
						}
					}
				}
			});
			// Create the session now
			janusSend({ janus: "create" }, function(response) {
				whip.debug("Session created:", response);
				if(response["janus"] === "error") {
					whip.err("Error creating session:", response["error"]["reason"]);
					disconnect();
					return;
				}
				// Unsubscribe from this transaction as well
				delete that.config.janus.transactions[response["transaction"]];
				that.config.janus.session.id = response["data"]["id"];
				whip.info("Janus session ID is " + that.config.janus.session.id);
				// We need to send keep-alives on a regular basis
				that.config.janus.session.timer = setInterval(function() {
					// Send keep-alive
					janusSend({ janus: "keepalive", session_id: that.config.janus.session.id }, function(response) {
						// Unsubscribe from this keep-alive transaction
						delete that.config.janus.transactions[response["transaction"]];
					});
					// FIXME We should monitor it getting back or not
				}, 15000);
				// Send an "info" request to check what version of Janus we're talking
				// to, and also to make sure the VideoRoom plugin is available
				janusSend({ janus: "info" }, function(response) {
					if(response["janus"] === "error") {
						whip.err("Error retrieving server info:", response["error"]["reason"]);
						disconnect();
						return;
					}
					let found = false;
					if(response.plugins) {
						for(let plugin in response.plugins) {
							if(plugin === "janus.plugin.videoroom") {
								found = true;
								break;
							}
						}
					}
					if(!found) {
						whip.err("VideoRoom plugin not available in configured Janus instance");
						disconnect();
						return;
					}
					that.config.janus.multistream = (response.version >= 1000);
					whip.info("Janus instance version: " + response.version_string + " (" +
						(that.config.janus.multistream ? "multistream" : "legacy") + ")");
					// We're done
					that.config.janus.state = "connected";
					callback();
				});
			});
		});
		that.config.ws.connect(that.config.janus.ws, 'janus-protocol');
	};

	// Public methods for managing sessions
	this.addSession = function(details) {
		whip.debug("Adding session:", details);
		sessions[details.uuid] = {
			uuid: details.uuid,
			teardown: details.teardown
		};
	};
	this.removeSession = function(details) {
		whip.debug("Removing user:", details);
		let uuid = details.uuid;
		this.hangup({ uuid: uuid });
		delete sessions[uuid];
	};

	// Public method for publishing in the VideoRoom
	this.publish = function(details, callback) {
		callback = (typeof callback === "function") ? callback : noop;
		whip.debug("Publishing:", details);
		if(!details.jsep || !details.room || !details.uuid) {
			callback({ error: "Missing mandatory attribute(s)" });
			return;
		}
		let jsep = details.jsep;
		let room = details.room;
		let pin = details.pin;
		let secret = details.secret;
		let adminKey = details.adminKey;
		let recipient = details.recipient;
		let uuid = details.uuid;
		let label = details.label;
		let session = sessions[uuid];
		if(!session) {
			callback({ error: "No such session" });
			return;
		}
		if(session.handle) {
			callback({ error: "WebRTC " + uuid + " already published" });
			return;
		}
		// If we're talking to multistream Janus and forwarding, extract the mids
		if(recipient && that.config.janus.multistream && jsep.sdp) {
			let lines = jsep.sdp.split("\r\n");
			let type = null;
			for(let i=0; i<lines.length; i++) {
				const mline = lines[i].match(/m=(\w+) */);
				if(mline) {
					type = mline[1];
					continue;
				}
				if(type !== "audio" && type !== "video")
					continue;
				let mid = lines[i].match('a=mid:(.+)');
				if(mid) {
					if(type === "audio" && !session.audioMid)
						session.audioMid = mid[1];
					else if(type === "video" && !session.videoMid)
						session.videoMid = mid[1];
					if(session.audioMid && session.videoMid)
						break;
				}
			}
		}
		// Create a handle to attach to specified plugin
		whip.debug("Creating handle for session " + uuid);
		let attach = {
			janus: "attach",
			session_id: that.config.janus.session.id,
			plugin: "janus.plugin.videoroom"
		};
		janusSend(attach, function(response) {
			whip.debug("Attach response:", response);
			// Unsubscribe from the transaction
			delete that.config.janus.transactions[response["transaction"]];
			let event = response["janus"];
			if(event === "error") {
				whip.err("Got an error attaching to the plugin:", response["error"].reason);
				callback({ error: response["error"].reason });
				return;
			}
			// Take note of the handle ID
			let handle = response["data"]["id"];
			whip.debug("Plugin handle for session " + session + " is " + handle);
			session.handle = handle;
			handles[handle] = { uuid: uuid, room: room };
			// Do we have pending trickles?
			if(session.candidates && session.candidates.length > 0) {
				// Send a trickle candidates bunch request
				let candidates = {
					janus: "trickle",
					session_id: that.config.janus.session.id,
					handle_id: handle,
					candidates: session.candidates
				}
				janusSend(candidates, function(response) {
					// Unsubscribe from the transaction right away
					delete that.config.janus.transactions[response["transaction"]];
				});
				session.candidates = [];
			}
			// Send a request to the plugin to publish
			let publish = {
				janus: "message",
				session_id: that.config.janus.session.id,
				handle_id: handle,
				body: {
					request: "joinandconfigure",
					room: room,
					pin: pin,
					ptype: "publisher",
					display: label,
					audio: true,
					video: true
				},
				jsep: jsep
			};
			janusSend(publish, function(response) {
				let event = response["janus"];
				if(event === "error") {
					delete that.config.janus.transactions[response["transaction"]];
					whip.err("Got an error publishing:", response["error"].reason);
					callback({ error: response["error"].reason });
					return;
				}
				if(event === "ack") {
					whip.debug("Got an ack to the setup for session " + uuid + ", waiting for result...");
					return;
				}
				// Get the plugin data: is this a success or an error?
				let data = response.plugindata.data;
				if(data.error) {
					// Unsubscribe from the transaction
					delete that.config.janus.transactions[response["transaction"]];
					whip.err("Got an error publishing:", data.error);
					callback({ error: data.error });
					return;
				}
				whip.debug("Got an answer to the setup for session " + uuid + ":", data);
				if(data["reason"]) {
					// Unsubscribe from the transaction
					delete that.config.janus.transactions[response["transaction"]];
					// Notify the error
					callback({ error: data["reason"] });
				} else {
					// Unsubscribe from the transaction
					delete that.config.janus.transactions[response["transaction"]];
					handles[handle].publisher = data["id"];
					// Should we RTP forward too?
					if(recipient && recipient.host && (recipient.audioPort > 0 || recipient.videoPort > 0)) {
						// RTP forward the publisher to the specified address
						let forwardDetails = {
							uuid: uuid,
							secret: secret,			// RTP forwarding may need the room secret
							adminKey: adminKey,		// RTP forwarding may need the plugin Admin Key
							recipient: recipient
						};
						that.forward(forwardDetails, function(err) {
							if(err) {
								// Something went wrong
								that.hangup({ uuid: uuid });
								callback(err);
								return;
							}
							// Notify the response
							let jsep = response["jsep"];
							callback(null, { jsep: jsep });
						});
						return;
					}
					// Notify the response
					let jsep = response["jsep"];
					callback(null, { jsep: jsep });
				}
			});
		});
	};
	this.forward = function(details, callback) {
		callback = (typeof callback === "function") ? callback : noop;
		whip.debug("Forwarding publisher:", details);
		if(!details.uuid || !details.recipient) {
			callback({ error: "Missing mandatory attribute(s)" });
			return;
		}
		let secret = details.secret;
		let adminKey = details.adminKey;
		let recipient = details.recipient;
		let uuid = details.uuid;
		let session = sessions[uuid];
		if(!session) {
			callback({ error: "No such session" });
			return;
		}
		if(!session.handle) {
			callback({ error: "WebRTC session not established for " + uuid });
			return;
		}
		let handleInfo = handles[session.handle];
		// Now send the RTP forward request
		let max32 = Math.pow(2, 32) - 1;
		let forward = {
			janus: "message",
			session_id: that.config.janus.session.id,
			handle_id: session.handle,
		};
		if(!that.config.janus.multistream) {
			// Use legacy syntax of rtp_forward
			forward.body = {
				request: "rtp_forward",
				room: handleInfo.room,
				publisher_id: handleInfo.publisher,
				secret: secret,
				admin_key: adminKey,
				host: recipient.host,
				host_family: "ipv4",
				audio_port: recipient.audioPort,
				audio_ssrc: Math.floor(Math.random() * max32),
				video_port: recipient.videoPort,
				video_ssrc: Math.floor(Math.random() * max32),
				video_rtcp_port: recipient.videoRtcpPort
			}
		} else {
			// Use multistream syntax of rtp_forward
			forward.body = {
				request: "rtp_forward",
				room: handleInfo.room,
				publisher_id: handleInfo.publisher,
				secret: secret,
				admin_key: adminKey,
				host: recipient.host,
				host_family: "ipv4",
				streams: []
			}
			if(!isNaN(recipient.audioPort) && recipient.audioPort > 0 && session.audioMid) {
				forward.body.streams.push({
					mid: session.audioMid,
					port: recipient.audioPort,
					ssrc: Math.floor(Math.random() * max32)
				});
			}
			if(!isNaN(recipient.videoPort) && recipient.videoPort > 0 && session.videoMid) {
				forward.body.streams.push({
					mid: session.videoMid,
					port: recipient.videoPort,
					ssrc: Math.floor(Math.random() * max32),
					rtcp_port: recipient.videoRtcpPort
				});
			}
		}
		whip.debug("Sending forward request:", forward);
		janusSend(forward, function(response) {
			delete that.config.janus.transactions[response["transaction"]];
			let event = response["janus"];
			if(event === "error") {
				whip.err("Got an error forwarding:", response["error"].reason);
				callback({ error: response["error"].reason });
				return;
			}
			// Get the plugin data: is this a success or an error?
			let data = response.plugindata.data;
			if(data.error) {
				whip.err("Got an error forwarding:", data.error);
				callback({ error: data.error });
				return;
			}
			// Done
			callback();
		});
	}
	this.trickle = function(details, callback) {
		callback = (typeof callback === "function") ? callback : noop;
		whip.debug("Trickling:", details);
		if(!details.candidate || !details.uuid) {
			callback({ error: "Missing mandatory attribute(s)" });
			return;
		}
		let candidate = details.candidate;
		let uuid = details.uuid;
		let session = sessions[uuid];
		if(!session) {
			callback({ error: "No such session" });
			return;
		}
		if(!session.handle) {
			// We don't have a handle yet, enqueue the trickle
			if(!session.candidates)
				session.candidates = [];
			session.candidates.push(candidate);
			return;
		}
		// Send a trickle request
		let trickle = {
			janus: "trickle",
			session_id: that.config.janus.session.id,
			handle_id: session.handle,
			candidate: candidate
		}
		janusSend(trickle, function(response) {
			// Unsubscribe from the transaction right away
			delete that.config.janus.transactions[response["transaction"]];
		});
	};
	this.restart = function(details, callback) {
		callback = (typeof callback === "function") ? callback : noop;
		whip.debug("Restarting:", details);
		if(!details.jsep || !details.uuid) {
			callback({ error: "Missing mandatory attribute(s)" });
			return;
		}
		let jsep = details.jsep;
		let uuid = details.uuid;
		let session = sessions[uuid];
		if(!session || !session.handle) {
			callback({ error: "No such session" });
			return;
		}
		// Send a request to the plugin with the new SDP to restart
		let restart = {
			janus: "message",
			session_id: that.config.janus.session.id,
			handle_id: session.handle,
			body: {
				request: "configure",
			},
			jsep: jsep
		};
		janusSend(restart, function(response) {
			let event = response["janus"];
			if(event === "error") {
				delete that.config.janus.transactions[response["transaction"]];
				whip.err("Got an error restarting:", response["error"].reason);
				callback({ error: response["error"].reason });
				return;
			}
			if(event === "ack") {
				whip.debug("Got an ack to the restart for session " + uuid + ", waiting for result...");
				return;
			}
			// Get the plugin data: is this a success or an error?
			let data = response.plugindata.data;
			if(data.error) {
				// Unsubscribe from the transaction
				delete that.config.janus.transactions[response["transaction"]];
				whip.err("Got an error restarting:", data.error);
				callback({ error: data.error });
				return;
			}
			whip.debug("Got an answer to the restart for session " + uuid + ":", data);
			if(data["reason"]) {
				// Unsubscribe from the transaction
				delete that.config.janus.transactions[response["transaction"]];
				// Notify the error
				callback({ error: data["reason"] });
			} else {
				// Unsubscribe from the transaction
				delete that.config.janus.transactions[response["transaction"]];
				// Notify the response
				let jsep = response["jsep"];
				callback(null, { jsep: jsep });
			}
		});
	};
	this.hangup = function(details, callback) {
		callback = (typeof callback === "function") ? callback : noop;
		whip.debug("Stopping WebRTC session:", details);
		if(!details.uuid) {
			callback({ error: "Missing mandatory attribute(s)" });
			return;
		}
		let uuid = details.uuid;
		let session = sessions[uuid];
		if(!session) {
			callback({ error: "No such session" });
			return;
		}
		if(!session.handle) {
			callback({ error: "WebRTC session not established for " + uuid });
			return;
		}
		// Get rid of the handle now
		let handle = session.handle;
		delete handles[handle];
		session.handle = 0;
		// We hangup sending a detach request
		let hangup = {
			janus: "detach",
			session_id: that.config.janus.session.id,
			handle_id: handle
		}
		janusSend(hangup, function(response) {
			// Unsubscribe from the transaction
			delete that.config.janus.transactions[response["transaction"]];
			whip.debug("Handle detached for session " + uuid);
			callback();
		});
	};
	this.destroy = function() {
		disconnect();
	};

	// Private method to disconnect from Janus and cleanup resources
	function disconnect() {
		if(that.config.ws && that.config.ws.connection) {
			try {
				that.config.ws.connection.close();
				that.config.ws.connection = null;
			} catch(e) {
				// Don't care
			}
		}
		that.config.ws = null;
	}
	function cleanup() {
		if(that.config.janus.session && that.config.janus.session.timer)
			clearInterval(that.config.janus.session.timer);
		that.config.janus.session = { id: 0 };
		that.config.janus.transactions = {};
		sessions = {};
		disconnect();
		that.config.janus.state = "disconnected";
	}

	// Private method to send requests to Janus
	function janusSend(message, responseCallback) {
		if(that.config.ws && that.config.ws.connection) {
			let transaction = that.generateRandomString(16);
			if(responseCallback)
				that.config.janus.transactions[transaction] = responseCallback;
			message["transaction"] = transaction;
			if(that.config.janus.apiSecret !== null && that.config.janus.apiSecret !== null)
				message["apisecret"] = that.config.janus.apiSecret;
			whip.vdebug("Sending message:", message);
			that.config.ws.connection.sendUTF(JSON.stringify(message));
		}
	}

	// Helper method to create random identifiers (e.g., transaction)
	this.generateRandomString = function(len) {
		let charSet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		let randomString = '';
		for(let i=0; i<len; i++) {
			let randomPoz = Math.floor(Math.random() * charSet.length);
			randomString += charSet.substring(randomPoz,randomPoz+1);
		}
		return randomString;
	}

};

module.exports = whipJanus;
