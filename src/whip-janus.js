'use strict';

const { EventEmitter } = require('events');

const Janode = require('janode');
const VideoRoomPlugin = require('janode/src/plugins/videoroom-plugin');

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
 * const WhipJanus = require("./whip-janus.js");
 * const wj = new WhipJanus(config);
 * await wj.connect(config);
 *
 */


// Debugging
const debug = require('debug');
const whip = {
	debug: debug('janus:debug'),
	err: debug('janus:error'),
	warn: debug('janus:warn'),
	info: debug('janus:info')
};

const STATE = {
	DISCONNECTING: 1,
	DISCONNECTED: 2,
	CONNECTING: 3,
	CONNECTED: 4,
};

const EVENT = {
	DISCONNECTED: 'disconnected',
};

class whipJanus extends EventEmitter {

	constructor({ address, apiSecret }) {
		super();
		// Configuration is static for now: we'll make this dynamic
		// Enrich the configuration with the additional info we need
		this._config = {
			janus: {
				ws: address,
				apiSecret,
				session: { id: 0 }, 		// janode session
				state: STATE.DISCONNECTED,
			},
			connection: null, 				// janode connection
		};
		whip.debug('Janus:', this._config);

		// Tables
		this._sessions = {};		// Not to be confused with Janus sessions
		this._handles = {};			// All Janus handles (map to local sessions here)

		this.on('error', _ => { });
	}

	// Private method to cleanup resources
	_cleanup() {
		this._config.connection = null;
		this._config.janus.session = { id: 0 };
		this._sessions = {};
		this._setState(STATE.DISCONNECTED);
	}

	// Private method for disconnecting from Janus
	async _disconnect() {
		if (this._getState() === STATE.DISCONNECTING || this._getState() === STATE.DISCONNECTED) return;
		this._setState(STATE.DISCONNECTING);
		try {
			await this._config.connection.close();
		} finally {
			this._cleanup();
		}
	}

	// Private metohd to detach a handle
	async _hangup(details = {}) {
		whip.debug('Stopping WebRTC session:', details);
		const { uuid } = details;
		if (!uuid) {
			throw new Error('Missing mandatory attribute(s)');
		}
		const session = this._sessions[uuid];
		if (!session) {
			throw new Error('No such session');
		}
		if (!session.handle) {
			throw new Error('WebRTC session not established for ' + uuid);
		}

		// Get rid of the handle now
		const handle_id = session.handle;
		session.handle = 0;
		const janodeHandle = this._handles[handle_id] ? this._handles[handle_id].janodeHandle : null;
		delete this._handles[handle_id];
		if (!janodeHandle) return;

		await janodeHandle.detach();
		whip.debug('Handle detached for session ' + uuid);
	}

	// Private metohd for starting a forwarder
	async _forward(details = {}) {
		whip.debug('Forwarding publisher:', details);
		const { secret, adminKey, recipient, uuid } = details;
		if (!uuid || !recipient) {
			throw new Error('Missing mandatory attribute(s)');
		}
		const session = this._sessions[uuid];
		if (!session) {
			throw new Error('No such session');
		}
		if (!session.handle) {
			throw new Error('WebRTC session not established for ' + uuid);
		}

		const { room, publisher, janodeHandle } = this._handles[session.handle];

		// Now send the RTP forward request
		const max32 = Math.pow(2, 32) - 1;
		const forward = {
			room,
			feed: publisher,
			admin_key: adminKey,
			secret,
			host: recipient.host,
			audio_port: recipient.audioPort,
			audio_ssrc: Math.floor(Math.random() * max32),
			video_port: recipient.audioPort,
			video_ssrc: Math.floor(Math.random() * max32),
			video_rtcp_port: recipient.videoRtcpPort,
		};
		whip.debug('Sending forward request:', forward);

		try {
			await janodeHandle.startForward(forward);
		} catch (e) {
			whip.err('Got an error forwarding:', e.message);
			throw new Error('Got an error forwarding: ' + e.message);
		}
	}

	// Public method to check when the class object is ready
	isReady() {
		return this._config.connection && this._config.janus.session.id !== 0 && this.isConnected();
	}

	isConnecting() {
		return this._getState() === STATE.CONNECTING;
	}

	isConnected() {
		return this._getState() === STATE.CONNECTED;
	}

	// Private method to get the state of the object
	_getState() {
		return this._config.janus.state;
	}

	// Private method to set the state of the object
	_setState(state) {
		this._config.janus.state = state;
	}

	// Connect to Janus via WebSockets
	async connect() {
		whip.info('Connecting to ' + this._config.janus.ws);
		// Callbacks

		if (this.isConnecting() || this.isConnected()) {
			whip.err('Already connected/connecting');
			throw new Error('Already connected/connecting');
		}

		this._setState(STATE.CONNECTING);

		try {
			// Connect to Janus via WebSockets
			this._config.connection = await Janode.connect({
				is_admin: false,
				address: { url: this._config.janus.ws },
				max_retries: 1,
			});

			this._config.connection.once(Janode.EVENT.CONNECTION_CLOSED, _ => {
				whip.warn('Janode Connect Closed');
				this._cleanup();
				this.emit(EVENT.DISCONNECTED);
			});

			this._config.connection.once(Janode.EVENT.CONNECTION_ERROR, error => {
				whip.err('Janode Connect Error: ' + error.message);
				this._cleanup();
				this.emit(EVENT.DISCONNECTED);
			});

			whip.info('Janode Connected');

			const janodeSession = await this._config.connection.create();

			janodeSession.on(Janode.EVENT.SESSION_DESTROYED, async _ => {
				whip.err('Janode Session Destroyed');
				await this._disconnect().catch(_ => { });
			});

			this._config.janus.session = janodeSession;
			whip.info('Janode session ID is ' + this._config.janus.session.id);

			this._setState(STATE.CONNECTED);
		} catch (error) {
			whip.err('Janode Connect Error: ' + error.message);
			await this._disconnect().catch(_ => { });
			throw error;
		}
	}

	// Public methods for managing sessions
	addSession(details = {}) {
		whip.debug('Adding session:', details);
		const { uuid, whipId, teardown } = details;
		this._sessions[details.uuid] = {
			uuid,
			whipId,
			teardown
		};
	}

	// Public method to remove a WHIP session
	removeSession(details = {}) {
		whip.debug('Removing user:', details);
		const { uuid } = details;
		this._hangup({ uuid }).catch(_ => { });
		delete this._sessions[uuid];
	}

	// Public method for publishing in the VideoRoom
	async publish(details = {}) {
		whip.debug('Publishing:', details);
		const { jsep, room, pin, secret, adminKey, recipient, uuid } = details;
		if (!jsep || !room || !uuid) {
			throw new Error('Missing mandatory attribute(s)');
		}

		const session = this._sessions[uuid];
		if (!session) {
			throw new Error('No such session');
		}
		if (session.handle) {
			throw new Error('WebRTC ' + uuid + ' already published');
		}
		// Create a handle to attach to specified plugin
		whip.debug('Creating handle for session ' + uuid);

		let janodeHandle;
		try {
			janodeHandle = await this._config.janus.session.attach(VideoRoomPlugin);

			janodeHandle.on(Janode.EVENT.HANDLE_HANGUP, _ => {
				// Janus told us this PeerConnection is gone
				const session = this._sessions[uuid];
				if (session && session.whipId && session.teardown && (typeof session.teardown === 'function')) {
					// Notify the application layer
					session.teardown(session.whipId);
				}
			});

			const handle_id = janodeHandle.id;
			whip.debug('Plugin handle for session ' + session.id + ' is ' + handle_id);
			this._handles[handle_id] = { uuid, room, janodeHandle, publisher: 0 };
			session.handle = handle_id;
		} catch (e) {
			whip.err('Got an error attaching to the plugin:', e.message);
			throw (e);
		}

		// Do we have pending trickles?
		if (session.candidates && session.candidates.length > 0) {
			// Send a trickle candidates bunch request
			janodeHandle.trickle(session.candidates).catch(_ => { });
			session.candidates = [];
		}

		try {
			const response = await janodeHandle.joinConfigurePublisher({ room, pin, display: uuid, audio: true, video: true, jsep });
			whip.debug('Got an answer to the setup for session ' + uuid + ':', response);
			this._handles[janodeHandle.id].publisher = response.feed;
			if (recipient && recipient.host && (recipient.audioPort > 0 || recipient.videoPort > 0)) {
				// RTP forward the publisher to the specified address
				const forwardDetails = {
					uuid,
					secret,			// RTP forwarding may need the room secret
					adminKey,		// RTP forwarding may need the plugin Admin Key
					recipient
				};
				await this.forward(forwardDetails);
			}
			return { jsep: response.jsep };
		} catch (e) {
			whip.err('Got an error publishing:', e.message);
			await this._hangup({ uuid }).catch(_ => { });
			throw new Error('Got an error publishing: ' + e.message);
		}
	}

	// Public method for triggering an ICE restart
	async restart(details = {}) {
		whip.debug('Restarting:', details);
		const { jsep, uuid } = details;
		if (!jsep || !uuid) {
			throw new Error('Missing mandatory attribute(s)');
		}

		const session = this._sessions[uuid];
		if (!session || !session.handle) {
			throw new Error('No such session');
		}

		const { janodeHandle } = this._handles[session.handle];
		try {
			const response = await janodeHandle.configure({ jsep });
			whip.debug('Got an answer to the restart for session ' + uuid + ':', response);
			return { jsep: response.jsep };
		} catch (e) {
			whip.err('Got an error restarting:', e.message);
			throw e;
		}
	}

	// Public method for sending a trickle to Janus
	async trickle(details = {}) {
		whip.debug('Trickling:', details);
		const { uuid, candidate } = details;
		if (!candidate || !uuid) {
			throw new Error('Missing mandatory attribute(s)');
		}
		const session = this._sessions[uuid];
		if (!session) {
			throw new Error('No such session');
		}
		if (!session.handle) {
			// We don't have a handle yet, enqueue the trickle
			session.candidates = session.candidates || [];
			session.candidates.push(candidate);
			return;
		}

		const { janodeHandle } = this._handles[session.handle];
		await janodeHandle.trickle(candidate).catch(_ => { });
	}
}

module.exports = whipJanus;
