'use strict';

/*
 * Simple WHIP server
 *
 * Author:  Lorenzo Miniero <lorenzo@meetecho.com>
 * License: GPLv3
 *
 * WHIP API and endpoint management
 *
 */

// Dependencies
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import http from 'http';
import https from 'https';
import Janode from 'janode';
import VideoRoomPlugin from 'janode/plugins/videoroom';
import { EventEmitter } from 'events';

// WHIP server class
class JanusWhipServer extends EventEmitter {

	// Constructor
	constructor({ janus, rest, allowTrickle = true, strictETags = false, iceServers = [], debug }) {
		super();
		// Parse configuration
		if(!janus || typeof janus !== 'object')
			throw new Error('Invalid configuration, missing parameter "janus" or not an object');
		if(!janus.address)
			throw new Error('Invalid configuration, missing parameter "address" in "janus"');
		if(!rest || typeof rest !== 'object')
			throw new Error('Invalid configuration, missing parameter "rest" or not an object');
		if(!rest.basePath)
			throw new Error('Invalid configuration, missing parameter "basePath" in "rest"');
		if(!rest.port && !rest.app)
			throw new Error('Invalid configuration, at least one of "port" and "app" should be set in "rest"');
		const debugLevels = [ 'err', 'warn', 'info', 'verb', 'debug' ];
		if(debug && debugLevels.indexOf(debug) === -1)
			throw new Error('Invalid configuration, unsupported "debug" level');
		this.config = {
			janus: {
				address: janus.address
			},
			rest: {
				port: rest.port,
				basePath: rest.basePath,
				app: rest.app
			},
			allowTrickle: (allowTrickle === true),
			strictETags: (strictETags === true),
			iceServers: Array.isArray(iceServers) ? iceServers : [iceServers]
		};

		// Resources
		this.janus = null;
		this.endpoints = new Map();
		this.resources = new Map();
		this.logger = new JanusWhipLogger({ prefix: '[WHIP] ', level: debug ? debugLevels.indexOf(debug) : 2 });
	}

	async start() {
		if(this.started)
			throw new Error('WHIP server already started');
		// Connect to Janus
		await this._connectToJanus();
		// WHIP REST API
		if(!this.config.rest.app) {
			// Spawn a new app and server
			this.logger.verb('Spawning new Express app');
			let app = express();
			this._setupRest(app);
			let options = null;
			let useHttps = (this.config.rest.https && this.config.rest.https.cert && this.config.rest.https.key);
			if(useHttps) {
				options = {
					cert: fs.readFileSync(this.config.rest.https.cert, 'utf8'),
					key: fs.readFileSync(this.config.rest.https.key, 'utf8'),
					passphrase: this.config.rest.https.passphrase
				};
			}
			this.server = await (useHttps ? https : http).createServer(options, app);
			await this.server.listen(this.config.rest.port);
		} else {
			// A server already exists, only add our endpoints to its router
			this.logger.verb('Reusing existing Express app');
			this._setupRest(this.config.rest.app);
		}
		// We're up and running
		this.logger.info('WHIP server started');
		this.started = true;
		return this;
	}

	async destroy() {
		if(!this.started)
			throw new Error('WHIP server not started');
		if(this.janus)
			await this.janus.close();
		if(this.server)
			this.server.close();
	}

	generateRandomString(len) {
		const charSet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		let randomString = '';
		for(let i=0; i<len; i++) {
			let randomPoz = Math.floor(Math.random() * charSet.length);
			randomString += charSet.substring(randomPoz,randomPoz+1);
		}
		return randomString;
	}

	createEndpoint({ id, room, secret, adminKey, pin, label, token, iceServers, recipient }) {
		this.logger.debug('createEndpoint was called for id', id);
		if(!id || !room)
			throw new Error('Invalid arguments');
		if(this.endpoints.has(id))
			throw new Error('Endpoint already exists');
		let endpoint = new JanusWhipEndpoint({
			id: id,
			room: room,
			secret: secret,
			adminKey: adminKey,
			pin: pin,
			label: label ? label : 'WHIP Publisher ' + room,
			token: token,
			iceServers: iceServers,
			recipient: recipient
		});
		this.logger.info('[' + id + '] Created new WHIP endpoint');
		this.endpoints.set(id, endpoint);
		return endpoint;
	}

	listEndpoints() {
		this.logger.debug('listEndpoints was called');
		let list = [];
		this.endpoints.forEach(function(endpoint, id) {
			list.push({ id: id, enabled: endpoint.enabled });
		});
		return list;
	}

	getEndpoint({ id }) {
		this.logger.debug('getEndpoint was called for id', id);
		return this.endpoints.get(id);
	}

	async destroyEndpoint({ id }) {
		this.logger.debug('destroyEndpoint was called for id', id);
		let endpoint = this.endpoints.get(id);
		if(!id || !endpoint)
			throw new Error('Invalid endpoint ID');
		// Get rid of the Janus publisher, if there's one active
		if(this.janus && endpoint.handle)
			await endpoint.handle.detach().catch(_err => {});
		if(endpoint.resourceId)
			delete this.resources[endpoint.resourceId];
		delete endpoint.resourceId;
		this.endpoints.delete(id);
		this.logger.info('[' + id + '] Destroyed WHIP endpoint');
	}

	// Janus setup
	async _connectToJanus() {
		const connection = await Janode.connect({
			is_admin: false,
			address: {
				url: this.config.janus.address,
			},
			retry_time_secs: 3,
			max_retries: Number.MAX_VALUE
		});
		connection.once(Janode.EVENT.CONNECTION_ERROR, () => {
			this.logger.warn('Lost connectivity to Janus, reset the manager and try reconnecting');
			// Teardown existing endpoints
			this.endpoints.forEach(function(endpoint, id) {
				endpoint.enabling = false;
				endpoint.enabled = false;
				delete endpoint.handle;
				delete endpoint.publisher;
				delete endpoint.sdpOffer;
				delete endpoint.ice;
				if(endpoint.resourceId)
					this.resources.delete(endpoint.resourceId);
				delete endpoint.resourceId;
				delete endpoint.resource;
				delete endpoint.latestEtag;
				this.logger.info('[' + id + '] Terminating WHIP session');
				endpoint.emit('endpoint-inactive');
				endpoint.emit('janus-disconnected');
				this.emit('endpoint-inactive', id);
			}, this);
			this.emit('janus-disconnected');
			// Reconnect
			this.janus = null;
			setTimeout(this._connectToJanus.bind(this), 1);
		});
		this.janus = await connection.create();
		this.logger.info('Connected to Janus:', this.config.janus.address);
		if(this.started)
			this.emit('janus-reconnected');
	}

	// REST server setup
	_setupRest(app) {
		const router = express.Router();

		// Just a helper to make sure this API is up and running
		router.get('/healthcheck', (_req, res) => {
			this.logger.debug('GET /healthcheck', _req.ip);
			res.sendStatus(200);
		});

		// OPTIONS associated with publishing to a WHIP endpoint
		router.options('/endpoint/:id', (req, res) => {
			// Prepare CORS headers for preflight
			res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE');
			res.setHeader('Vary', 'Access-Control-Request-Headers');
			// Authenticate the request, and only return Link headers if valid
			let id = req.params.id;
			this.logger.debug('OPTIONS /endpoint/', id, req.ip);
			let endpoint = this.endpoints.get(id);
			if(!id || !endpoint) {
				res.sendStatus(204);
				return;
			}
			if(endpoint.enabled) {
				res.sendStatus(204);
				return;
			}
			// Check the Bearer token
			let auth = req.headers['authorization'];
			if(endpoint.token) {
				if(!auth || auth.indexOf('Bearer ') < 0) {
					res.sendStatus(204);
					return;
				}
				let authtoken = auth.split('Bearer ')[1];
				if(typeof endpoint.token === 'function') {
					if(!endpoint.token(authtoken)) {
						res.sendStatus(204);
						return;
					}
				} else if(!authtoken || authtoken.length === 0 || authtoken !== endpoint.token) {
					res.sendStatus(204);
					return;
				}
			}
			// Done
			let iceServers = endpoint.iceServers ? endpoint.iceServers : this.config.iceServers;
			if(iceServers && iceServers.length > 0) {
				// Add a Link header for each static ICE server
				res.setHeader('Access-Control-Expose-Headers', 'Link');
				res.setHeader('Access-Post', 'application/sdp');
				let links = [];
				for(let server of iceServers) {
					if(!server.uri || (server.uri.indexOf('stun:') !== 0 &&
							server.uri.indexOf('turn:') !== 0 &&
							server.uri.indexOf('turns:') !== 0))
						continue;
					let link = '<' + server.uri + '>; rel="ice-server"';
					if(server.username && server.credential) {
						link += ';';
						link += ' username="' + server.username + '";' +
							' credential="' + server.credential + '";' +
							' credential-type="password"';
					}
					links.push(link);
				}
				res.setHeader('Link', links);
			}
			res.sendStatus(204);
		});
		// Publish to a WHIP endpoint
		router.post('/endpoint/:id', async (req, res) => {
			let id = req.params.id;
			this.logger.debug('POST /endpoint/' + id, req.ip);
			let endpoint = this.endpoints.get(id);
			if(!id || !endpoint) {
				this.logger.debug('[' + id + '] 404 Invalid endpoint ID');
				res.status(404);
				res.send('Invalid endpoint ID');
				return;
			}
			if(endpoint.enabling || endpoint.enabled) {
				this.logger.debug('[' + id + '] 403 Endpoint ID already in use');
				res.status(403);
				res.send('Endpoint ID already in use');
				return;
			}
			this.logger.verb('/endpoint/:', id);
			this.logger.debug(req.body);
			// Make sure we received an SDP
			if(req.headers['content-type'] !== 'application/sdp' || req.body.indexOf('v=0') < 0) {
				this.logger.debug('[' + id + '] 406 Unsupported content type');
				res.status(406);
				res.send('Unsupported content type');
				return;
			}
			// Check the Bearer token
			let auth = req.headers['authorization'];
			if(endpoint.token) {
				if(!auth || auth.indexOf('Bearer ') < 0) {
					this.logger.debug('[' + id + '] 403 Unauthorized');
					res.status(403);
					res.send('Unauthorized');
					return;
				}
				let authtoken = auth.split('Bearer ')[1];
				if(typeof endpoint.token === 'function') {
					if(!endpoint.token(authtoken)) {
						this.logger.debug('[' + id + '] 403 Unauthorized');
						res.status(403);
						res.send('Unauthorized');
						return;
					}
				} else if(!authtoken || authtoken.length === 0 || authtoken !== endpoint.token) {
					this.logger.debug('[' + id + '] 403 Unauthorized');
					res.status(403);
					res.send('Unauthorized');
					return;
				}
			}
			// Make sure Janus is up and running
			if(!this.janus) {
				this.logger.debug('[' + id + '] 503 Janus unavailable');
				res.status(503);
				res.send('Janus unavailable');
				return;
			}
			// Create a new session
			this.logger.info('[' + id + '] Publishing to WHIP endpoint');
			endpoint.enabling = true;
			try {
				// Create a random ID for the resource path
				let rid = this.generateRandomString(16);
				while(this.resources.has(rid))
					rid = this.generateRandomString(16);
				this.resources.set(rid, id);
				endpoint.resourceId = rid;
				endpoint.resource = this.config.rest.basePath + '/resource/' + rid;
				endpoint.latestEtag = this.generateRandomString(16);
				// Take note of SDP and ICE credentials
				endpoint.sdpOffer = req.body;
				endpoint.ice = {
					ufrag: endpoint.sdpOffer.match(/a=ice-ufrag:(.*)\r\n/)[1],
					pwd: endpoint.sdpOffer.match(/a=ice-pwd:(.*)\r\n/)[1]
				};
				// Connect to the VideoRoom plugin
				endpoint.handle = await this.janus.attach(VideoRoomPlugin);
				endpoint.handle.on(Janode.EVENT.HANDLE_DETACHED, () => {
					// Janus notified us the session is gone, tear it down
					let endpoint = this.endpoints.get(id);
					if(endpoint) {
						this.logger.info('[' + id + '] PeerConnection detected as closed');
						endpoint.enabling = false;
						endpoint.enabled = false;
						delete endpoint.handle;
						delete endpoint.publisher;
						delete endpoint.sdpOffer;
						delete endpoint.ice;
						if(endpoint.resourceId)
							this.resources.delete(endpoint.resourceId);
						delete endpoint.resourceId;
						delete endpoint.resource;
						delete endpoint.latestEtag;
					}
				});
				endpoint.publisher = await endpoint.handle.joinConfigurePublisher({
					room: endpoint.room,
					pin: endpoint.pin,
					display: endpoint.label,
					audio: true,
					video: true,
					jsep: {
						type: 'offer',
						sdp: req.body
					}
				});
				if(endpoint.recipient && endpoint.recipient.host && (endpoint.recipient.audioPort > 0 || endpoint.recipient.videoPort > 0)) {
					// Configure an RTP forwarder too
					const max32 = Math.pow(2, 32) - 1;
					let details = {
						room: endpoint.room,
						feed: endpoint.publisher.feed,
						secret: endpoint.secret,
						admin_key: endpoint.adminKey,
						host: endpoint.recipient.host,
						audio_port: endpoint.recipient.audioPort,
						audio_ssrc: Math.floor(Math.random() * max32),
						video_port: endpoint.recipient.videoPort,
						video_ssrc: Math.floor(Math.random() * max32),
						video_rtcp_port: endpoint.recipient.videoRtcpPort
					};
					await endpoint.handle.startForward(details);
				}
				endpoint.enabling = false;
				endpoint.enabled = true;
				// Done
				res.setHeader('Access-Control-Expose-Headers', 'Location, Link');
				res.setHeader('Accept-Patch', 'application/trickle-ice-sdpfrag');
				res.setHeader('Location', endpoint.resource);
				res.set('ETag', '"' + endpoint.latestEtag + '"');
				let iceServers = endpoint.iceServers ? endpoint.iceServers : this.config.iceServers;
				if(iceServers && iceServers.length > 0) {
					// Add a Link header for each static ICE server
					let links = [];
					for(let server of iceServers) {
						if(!server.uri || (server.uri.indexOf('stun:') !== 0 &&
								server.uri.indexOf('turn:') !== 0 &&
								server.uri.indexOf('turns:') !== 0))
							continue;
						let link = '<' + server.uri + '>; rel="ice-server"';
						if(server.username && server.credential) {
							link += ';';
							link += ' username="' + server.username + '";' +
								' credential="' + server.credential + '";' +
								' credential-type="password"';
						}
						links.push(link);
					}
					res.setHeader('Link', links);
				}
				res.writeHeader(201, { 'Content-Type': 'application/sdp' });
				res.write(endpoint.publisher.jsep.sdp);
				res.end();
				endpoint.emit('endpoint-active');
				this.emit('endpoint-active', id);
			} catch(err) {
				this.logger.err('Error publishing:', err);
				endpoint.enabling = false;
				endpoint.enabled = false;
				if(endpoint.handle)
					await endpoint.handle.detach();
				delete endpoint.handle;
				delete endpoint.publisher;
				delete endpoint.sdpOffer;
				delete endpoint.ice;
				res.status(500);
				res.send(err.error);
			}
		});

		// GET, HEAD and PUT on the endpoint must return a 405
		router.get('/endpoint/:id', (_req, res) => {
			res.sendStatus(405);
		});
		router.head('/endpoint/:id', (_req, res) => {
			res.sendStatus(405);
		});
		router.put('/endpoint/:id', (_req, res) => {
			res.sendStatus(405);
		});

		// Trickle a WHIP resource
		router.patch('/resource/:rid', async (req, res) => {
			if(!this.config.allowTrickle) {
				res.sendStatus(405);
				return;
			}
			let rid = req.params.rid;
			let id = this.resources.get(rid);
			this.logger.debug('PATCH /resource/' + rid, req.ip);
			if(!rid || !id) {
				this.logger.debug('[' + rid + '] 404 Invalid resource ID');
				res.status(404);
				res.send('Invalid resource ID');
				return;
			}
			let endpoint = this.endpoints.get(id);
			if(!endpoint) {
				this.logger.debug('[' + id + '] 404 Invalid endpoint ID');
				res.status(404);
				res.send('Invalid endpoint ID');
				return;
			}
			if(endpoint.latestEtag)
				res.set('ETag', '"' + endpoint.latestEtag + '"');
			this.logger.debug('PATCH /resource[trickle]/' + id, req.ip);
			this.logger.verb('/resource[trickle]/:', id);
			this.logger.debug(req.body);
			// Check the Bearer token
			let auth = req.headers['authorization'];
			if(endpoint.token) {
				if(!auth || auth.indexOf('Bearer ') < 0) {
					this.logger.debug('[' + id + '] 403 Unauthorized');
					res.status(403);
					res.send('Unauthorized');
					return;
				}
				let authtoken = auth.split('Bearer ')[1];
				if(typeof endpoint.token === 'function') {
					if(!endpoint.token(authtoken)) {
						this.logger.debug('[' + id + '] 403 Unauthorized');
						res.status(403);
						res.send('Unauthorized');
						return;
					}
				} else if(!authtoken || authtoken.length === 0 || authtoken !== endpoint.token) {
					this.logger.debug('[' + id + '] 403 Unauthorized');
					res.status(403);
					res.send('Unauthorized');
					return;
				}
			}
			if(!endpoint.handle) {
				this.logger.debug('[' + id + '] 403 Endpoint ID not published');
				res.status(403);
				res.send('Endpoint ID not published');
				return;
			}
			// Check the latest ETag
			if(req.headers['if-match'] !== '"*"' && req.headers['if-match'] !== ('"' + endpoint.latestEtag + '"')) {
				if(this.config.strictETags) {
					// Only return a failure if we're configured with strict ETag checking, ignore it otherwise
					this.logger.debug('[' + id + '] 412 Precondition Failed');
					res.status(412);
					res.send('Precondition Failed');
					return;
				}
			}
			// Make sure Janus is up and running
			if(!this.janus) {
				res.status(503);
				this.logger.debug('[' + id + '] 503 Janus unavailable');
				res.send('Janus unavailable');
				return;
			}
			// Make sure we received a trickle candidate
			if(req.headers['content-type'] !== 'application/trickle-ice-sdpfrag') {
				this.logger.debug('[' + id + '] 406 Unsupported content type');
				res.status(406);
				res.send('Unsupported content type');
				return;
			}
			// Parse the RFC 8840 payload
			let fragment = req.body;
			let lines = fragment.split(/\r?\n/);
			let iceUfrag = null, icePwd = null, restart = false;
			let candidates = [];
			for(let line of lines) {
				if(line.indexOf('a=ice-ufrag:') === 0) {
					iceUfrag = line.split('a=ice-ufrag:')[1];
				} else if(line.indexOf('a=ice-pwd:') === 0) {
					icePwd = line.split('a=ice-pwd:')[1];
				} else if(line.indexOf('a=candidate:') === 0) {
					let candidate = {
						sdpMLineIndex: 0,
						candidate: line.split('a=')[1]
					};
					candidates.push(candidate);
				} else if(line.indexOf('a=end-of-candidates') === 0) {
					// Signal there won't be any more candidates
					candidates.push({ completed: true });
				}
			}
			// Check if there's a restart involved
			if(iceUfrag && icePwd && (iceUfrag !== endpoint.ice.ufrag || icePwd !== endpoint.ice.pwd)) {
				// We need to restart
				restart = true;
			}
			// Do one more ETag check (make sure restarts have '*' as ETag, and only them)
			if((req.headers['if-match'] === '*' && !restart) || (req.headers['if-match'] !== '"*"' && restart)) {
				if(this.config.strictETags) {
					// Only return a failure if we're configured with strict ETag checking, ignore it otherwise
					this.logger.debug('[' + id + '] 412 Precondition Failed');
					res.status(412);
					res.send('Precondition Failed');
					return;
				}
			}
			try {
				if(!restart) {
					// Trickle the candidate(s)
					if(candidates.length > 0)
						await endpoint.handle.trickle(candidates);
					// We're done
					this.logger.debug('[' + id + '] 204 no ICE restart');
					res.sendStatus(204);
					return;
				}
				// If we got here, we need to do an ICE restart, which we do
				// by generating a new fake offer and send it to Janus
				this.logger.info('[' + id + '] Performing ICE restart');
				let oldUfrag = 'a=ice-ufrag:' + endpoint.ice.ufrag;
				let oldPwd = 'a=ice-pwd:' + endpoint.ice.pwd;
				let newUfrag = 'a=ice-ufrag:' + iceUfrag;
				let newPwd = 'a=ice-pwd:' + icePwd;
				endpoint.sdpOffer = endpoint.sdpOffer
					.replace(new RegExp(oldUfrag, 'g'), newUfrag)
					.replace(new RegExp(oldPwd, 'g'), newPwd);
				endpoint.ice.ufrag = iceUfrag;
				endpoint.ice.pwd = icePwd;
				// Generate a new ETag too
				endpoint.latestEtag = this.generateRandomString(16);
				this.logger.verb('New ETag: ' + endpoint.latestEtag);
				// Send the new offer
				const result = await endpoint.handle.configure({
					jsep: {
						type: 'offer',
						sdp: endpoint.sdpOffer
					}
				});
				// Now that we have a response, trickle the candidates we received
				if(candidates.length > 0 && this.janus)
					await endpoint.handle.trickle(candidates);
				// Read the ICE credentials/candidates and send them back
				let serverUfrag, serverPwd, serverCandidates = [];

				let sdp = result.jsep.sdp
				const sections = sdp.split(/\r?\nm=/);
				if(sections.length > 2)
					sdp = sections.slice(0, 2).join('\r\nm=');
				const sdpLines = sdp.split(/\r?\n/);
				const payloadLines = sdpLines.filter(line => {
					return line.startsWith('a=ice-')
						|| line.startsWith('a=group:BUNDLE')
						|| line.startsWith('m=')
						|| line.startsWith('a=mid:')
						|| line.startsWith('a=candidate:')
						|| line.startsWith('a=end-of-candidates')
				});
				const payload = payloadLines.join('\r\n') + '\r\n';

				res.set('ETag', '"' + endpoint.latestEtag + '"');
				res.writeHeader(200, { 'Content-Type': 'application/trickle-ice-sdpfrag' });
				res.write(payload);
				res.end();
			} catch(err) {
				this.logger.err('Error patching:', err);
				res.status(500);
				res.send(err.error);
			}
		});

		// Stop publishing to a WHIP endpoint
		router.delete('/resource/:rid', async (req, res) => {
			let rid = req.params.rid;
			let id = this.resources.get(rid);
			this.logger.debug('DELETE /resource/' + rid, req.ip);
			if(!rid || !id) {
				this.logger.debug('[' + rid + '] 404 Invalid resource ID');
				res.status(404);
				res.send('Invalid resource ID');
				return;
			}
			let endpoint = this.endpoints.get(id);
			if(!endpoint) {
				this.logger.debug('[' + id + '] 404 Invalid endpoint ID');
				res.status(404);
				res.send('Invalid endpoint ID');
				return;
			}
			// Check the Bearer token
			let auth = req.headers['authorization'];
			if(endpoint.token) {
				if(!auth || auth.indexOf('Bearer ') < 0) {
					this.logger.debug('[' + id + '] 403 Unauthorized');
					res.status(403);
					res.send('Unauthorized');
					return;
				}
				let authtoken = auth.split('Bearer ')[1];
				if(typeof endpoint.token === 'function') {
					if(!endpoint.token(authtoken)) {
						this.logger.debug('[' + id + '] 403 Unauthorized');
						res.status(403);
						res.send('Unauthorized');
						return;
					}
				} else if(!authtoken || authtoken.length === 0 || authtoken !== endpoint.token) {
					this.logger.debug('[' + id + '] 403 Unauthorized');
					res.status(403);
					res.send('Unauthorized');
					return;
				}
			}
			this.logger.verb('/resource/:', id);
			// Get rid of the Janus publisher
			if(this.janus && endpoint.handle)
				await endpoint.handle.detach().catch(_err => {});
			endpoint.enabled = false;
			endpoint.enabling = false;
			delete endpoint.handle;
			delete endpoint.publisher;
			delete endpoint.sdpOffer;
			delete endpoint.ice;
			if(endpoint.resourceId)
				this.resources.delete(endpoint.resourceId);
			delete endpoint.resourceId;
			delete endpoint.resource;
			delete endpoint.latestEtag;
			this.logger.info('[' + id + '] Terminating WHIP session');
			endpoint.emit('endpoint-inactive');
			this.emit('endpoint-inactive', id);
			// Done
			res.sendStatus(200);
		});

		// GET, HEAD, POST and PUT on the resource must return a 405
		router.get('/resource/:rid', (_req, res) => {
			res.sendStatus(405);
		});
		router.head('/resource/:rid', (_req, res) => {
			res.sendStatus(405);
		});
		router.post('/resource/:rid', (_req, res) => {
			res.sendStatus(405);
		});
		router.put('/resource/:rid', (_req, res) => {
			res.sendStatus(405);
		});

		// Setup CORS
		app.use(cors({ preflightContinue: true }));

		// Initialize the REST API
		app.use(express.json());
		app.use(express.text({ type: 'application/sdp' }));
		app.use(express.text({ type: 'application/trickle-ice-sdpfrag' }));
		app.use(this.config.rest.basePath, router);
	}
}

// WHIP endpoint class
class JanusWhipEndpoint extends EventEmitter {
	constructor({ id, room, secret, adminKey, pin, label, token, iceServers, recipient }) {
		super();
		this.id = id;
		this.room = room;
		this.secret = secret;
		this.adminKey = adminKey;
		this.pin = pin;
		this.label = label;
		this.token = token;
		this.iceServers = iceServers;
		this.recipient = recipient;
		this.enabled = false;
	}
}

// Logger class
const debugLevels = [ 'err', 'warn', 'info', 'verb', 'debug' ];
class JanusWhipLogger {
	constructor({ prefix, level }) {
		this.prefix = prefix;
		this.debugLevel = level;
	}

	err() {
		if(this.debugLevel < 0)
			return;
		let args = Array.prototype.slice.call(arguments);
		args.unshift(this.prefix + '[err]');
		console.log.apply(console, args);
	}

	warn() {
		if(this.debugLevel < 1)
			return;
		let args = Array.prototype.slice.call(arguments);
		args.unshift(this.prefix + '[warn]');
		console.log.apply(console, args);
	}

	info() {
		if(this.debugLevel < 2)
			return;
		let args = Array.prototype.slice.call(arguments);
		args.unshift(this.prefix + '[info]');
		console.log.apply(console, args);
	}

	verb() {
		if(this.debugLevel < 3)
			return;
		let args = Array.prototype.slice.call(arguments);
		args.unshift(this.prefix + '[verb]');
		console.log.apply(console, args);
	}

	debug() {
		if(this.debugLevel < 4)
			return;
		let args = Array.prototype.slice.call(arguments);
		args.unshift(this.prefix + '[debug]');
		console.log.apply(console, args);
	}
}

// Exports
export {
	JanusWhipServer,
	JanusWhipEndpoint
};
