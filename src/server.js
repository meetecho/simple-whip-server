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
var async = require('async');
var express = require('express');
var cors = require('cors');
var colors = require('colors/safe');
var debug = require('debug');
var WhipJanus = require("./whip-janus.js");

// Debugging
var whip = {
	debug: debug('whip:debug'),
	err: debug('whip:error'),
	warn: debug('whip:warn'),
	timer: debug('whip:timer'),
	info: debug('whip:info')
};

// Configuration file
const config = require('./config.js');

// Static properties
var janus = null;
var endpoints = {}, resources = {};

// Startup
async.series([
	// 1. Connect to Janus
	function(callback) {
		console.log(colors.yellow("[1. Janus]"));
		console.log("Connecting to Janus:", config.janus);
		setupJanus(callback);
	},
	// 2. WHIP REST API
	function(callback) {
		console.log(colors.yellow("[2. WHIP REST API]"));
		// Create REST backend via express
		let app = express();
		app.use(express.static('web'));
		setupRest(app);
		// Are we using plain HTTP or HTTPS?
		let options = null;
		let https = (config.https && config.https.cert && config.https.key);
		if(https) {
			let fs = require('fs');
			options = {
				cert: fs.readFileSync(config.https.cert, 'utf8'),
				key: fs.readFileSync(config.https.key, 'utf8'),
				passphrase: config.https.passphrase
			};
		}
		let http = require(https ? 'https' : 'http').createServer(options, app);
		http.on('error', function(err) {
			console.log('Web server error:', err)
			if(err.code == 'EADDRINUSE') {
				callback('Port ' + config.port + ' for WHIP REST API already in use');
			} else {
				callback('Error creating WHIP REST API:', err);
			}
		});
		http.listen(config.port, function() {
			console.log('WHIP REST API listening on *:' + config.port);
			callback(null, "WHIP REST API OK");
		});
	}
],
function(err, results) {
	if(err) {
		console.log(colors.red("WHIP server prototype failed to start :-("));
		console.log(err);
		process.exit(1);
	} else {
		// We're up and running
		console.log(colors.cyan("WHIP server prototype started!"));
		console.log(results);
	}
});

// Janus setup
var firstTime = true;
var reconnectingTimer = null;
var noop = function() {};
function setupJanus(callback) {
	callback = (typeof callback == "function") ? callback : noop;
	reconnectingTimer = null;
	if(!janus) {
		janus = new WhipJanus(config.janus);
		janus.on("disconnected", function() {
			// Event to detect when we loose Janus, try reconnecting
			if(reconnectingTimer) {
				whip.warn("A reconnection timer has already been set up");
				return;
			}
			janus = null;
			// Teardown existing endpoints
			for(let id in endpoints) {
				let endpoint = endpoints[id];
				if(!endpoint)
					continue;
				endpoint.enabled = false;
				delete endpoint.publisher;
				delete endpoint.sdpOffer;
				delete endpoint.ice;
				if(endpoint.resourceId)
					delete resources[endpoint.resourceId];
				delete endpoint.resourceId;
				delete endpoint.resource;
				delete endpoint.latestEtag;
				whip.info('[' + id + '] Terminating WHIP session');
			}
			whip.warn("Lost connectivity to Janus, reset the manager and try reconnecting");
			reconnectingTimer = setTimeout(function() { setupJanus(firstTime ? callback : undefined); }, 2000);
		});
	}
	janus.connect(function(err) {
		if(err) {
			whip.warn("Error connecting, will retry later:", err.error);
			return;
		}
		// Connected
		whip.info("Connected to Janus:", config.janus.address);
		firstTime = false;
		callback(null, "Janus OK");
	});
}

// REST server setup
function setupRest(app) {
	let router = express.Router();

	// Just a helper to make sure this API is up and running
	router.get('/healthcheck', function(req, res) {
		whip.debug("/healthcheck:", req.params);
		res.sendStatus(200);
	});

	// Return a list of the configured endpoints
	router.get('/endpoints', function(req, res) {
		whip.debug("/endpoints:", req.params);
		res.setHeader('content-type', 'application/json');
		res.status(200);
		let list = [];
		for(let id in endpoints) {
			let endpoint = endpoints[id];
			let le = {
				id: endpoint.id,
				room: endpoint.room,
				label: endpoint.label
			};
			if(endpoint.enabled)
				le.enabled = true;
			if(endpoint.iceServers)
				le.iceServers = true;
			if(endpoint.token)
				le.token = true;
			if(endpoint.pin)
				le.pin = true;
			if(endpoint.secret)
				le.secret = true;
			if(endpoint.adminKey)
				le.adminKey = true;
			if(endpoint.recipient)
				le.recipient = true;
			list.push(le);
		}
		res.send(JSON.stringify(list));
	});

	// Simple, non-standard, interface to create endpoints and map them to Janus rooms
	router.post('/create', function(req, res) {
		whip.debug("/create:", req.body);
		let id = req.body.id;
		let room = req.body.room;
		let secret = req.body.secret;
		let adminKey = req.body.adminKey;
		let pin = req.body.pin;
		let label = req.body.label;
		let token = req.body.token;
		let iceServers = req.body.iceServers;
		let recipient = req.body.recipient;
		if(!id || !room) {
			res.status(400);
			res.send('Invalid arguments');
			return;
		}
		if(endpoints[id]) {
			res.status(400);
			res.send('Endpoint already exists');
			return;
		}
		endpoints[id] = {
			id: id,
			room: room,
			secret: secret,
			adminKey: adminKey,
			pin: pin,
			label: label ? label : "WHIP Publisher " + room,
			token: token,
			iceServers: iceServers,
			recipient: recipient,
			enabled: false
		};
		whip.info('[' + id + '] Created new WHIP endpoint');
		// Done
		res.sendStatus(200);
	});

	// OPTIONS associated with publishing to a WHIP endpoint
	router.options('/endpoint/:id', function(req, res) {
		// Prepare CORS headers for preflight
		res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE');
		res.setHeader('Vary', 'Access-Control-Request-Headers');
		// Authenticate the request, and only return Link headers if valid
		let id = req.params.id;
		let endpoint = endpoints[id];
		if(!id || !endpoint) {
			res.sendStatus(204);
			return;
		}
		if(endpoint.enabled) {
			res.sendStatus(204);
			return;
		}
		// Check the Bearer token
		let auth = req.headers["authorization"];
		if(endpoint.token) {
			if(!auth || auth.indexOf('Bearer ') < 0) {
				res.sendStatus(204);
				return;
			}
			let authtoken = auth.split('Bearer ')[1];
			if(!authtoken || authtoken.length === 0 || authtoken !== endpoint.token) {
				res.sendStatus(204);
				return;
			}
		}
		// Done
		let iceServers = endpoint.iceServers ? endpoint.iceServers : config.iceServers;
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
					link += ';'
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
	router.post('/endpoint/:id', function(req, res) {
		let id = req.params.id;
		let endpoint = endpoints[id];
		if(!id || !endpoint) {
			res.status(404);
			res.send('Invalid endpoint ID');
			return;
		}
		if(endpoint.enabled) {
			res.status(403);
			res.send('Endpoint ID already in use');
			return;
		}
		whip.debug("/endpoint/:", id);
		whip.debug(req.body);
		// Make sure we received an SDP
		if(req.headers["content-type"] !== "application/sdp" || req.body.indexOf('v=0') < 0) {
			res.status(406);
			res.send('Unsupported content type');
			return;
		}
		// Check the Bearer token
		let auth = req.headers["authorization"];
		if(endpoint.token) {
			if(!auth || auth.indexOf('Bearer ') < 0) {
				res.status(403);
				res.send('Unauthorized');
				return;
			}
			let authtoken = auth.split('Bearer ')[1];
			if(!authtoken || authtoken.length === 0 || authtoken !== endpoint.token) {
				res.status(403);
				res.send('Unauthorized');
				return;
			}
		}
		// Make sure Janus is up and running
		if(!janus || !janus.isReady() || janus.getState() !== "connected") {
			res.status(503);
			res.send('Janus unavailable');
			return;
		}
		let uuid = id;
		// Create a new session
		janus.removeSession({ uuid: uuid });
		janus.addSession({
			uuid: uuid,
			teardown: function(whipId) {
				// Janus notified us the session is gone, tear it down
				let endpoint = endpoints[whipId];
				if(endpoint) {
					whip.info('[' + whipId + '] PeerConnection detected as closed');
					if(endpoint.publisher)
						janus.removeSession({ uuid: endpoint.publisher });
					endpoint.enabled = false;
					delete endpoint.publisher;
					delete endpoint.sdpOffer;
					delete endpoint.ice;
					if(endpoint.resourceId)
						delete resources[endpoint.resourceId];
					delete endpoint.resourceId;
					delete endpoint.resource;
					delete endpoint.latestEtag;
				}
			}
		});
		// Prepare the JSEP object
		let details = {
			uuid: uuid,
			room: endpoint.room,
			label: endpoint.label,
			pin: endpoint.pin,
			jsep: {
				type: 'offer',
				sdp: req.body
			}
		};
		if(endpoint.recipient) {
			details.secret = endpoint.secret;
			details.adminKey = endpoint.adminKey;
			details.recipient = endpoint.recipient;
		}
		endpoint.enabled = true;
		endpoint.publisher = uuid;
		// Take note of SDP and ICE credentials
		endpoint.sdpOffer = req.body;
		endpoint.ice = {
			ufrag: endpoint.sdpOffer.match(/a=ice-ufrag:(.*)\r\n/)[1],
			pwd: endpoint.sdpOffer.match(/a=ice-pwd:(.*)\r\n/)[1]
		};
		// Publish
		janus.publish(details, function(err, result) {
			// Make sure we got an ANSWER back
			if(err) {
				endpoint.enabled = false;
				delete endpoint.publisher;
				delete endpoint.sdpOffer;
				delete endpoint.ice;
				res.status(500);
				res.send(err.error);
			} else {
				whip.info('[' + id + '] Publishing to WHIP endpoint');
				// Create a random ID for the resource path
				let rid = janus.generateRandomString(16);
				while(resources[rid])
					rid = janus.generateRandomString(16);
				resources[rid] = id;
				endpoint.resourceId = rid;
				endpoint.resource = config.rest + '/resource/' + rid;
				endpoint.latestEtag = janus.generateRandomString(16);
				// Done
				res.setHeader('Access-Control-Expose-Headers', 'Location, Link');
				res.setHeader('Accept-Patch', 'application/trickle-ice-sdpfrag');
				res.setHeader('Location', endpoint.resource);
				res.set('ETag', '"' + endpoint.latestEtag + '"');
				let iceServers = endpoint.iceServers ? endpoint.iceServers : config.iceServers;
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
							link += ';'
							link += ' username="' + server.username + '";' +
								' credential="' + server.credential + '";' +
								' credential-type="password"';
						}
						links.push(link);
					}
					res.setHeader('Link', links);
				}
				res.writeHeader(201, { 'Content-Type': 'application/sdp' });
				res.write(result.jsep.sdp);
				res.end();
			}
		});
	});

	// GET, HEAD and PUT on the endpoint must return a 405
	router.get('/endpoint/:id', function(req, res) {
		res.sendStatus(405);
	});
	router.head('/endpoint/:id', function(req, res) {
		res.sendStatus(405);
	});
	router.put('/endpoint/:id', function(req, res) {
		res.sendStatus(405);
	});

	// Trickle a WHIP resource
	router.patch('/resource/:rid', function(req, res) {
		let rid = req.params.rid;
		let id = resources[rid];
		if(!rid || !id) {
			res.status(404);
			res.send('Invalid resource ID');
			return;
		}
		let endpoint = endpoints[id];
		if(!endpoint) {
			res.status(404);
			res.send('Invalid endpoint ID');
			return;
		}
		if(endpoint.latestEtag)
			res.set('ETag', '"' + endpoint.latestEtag + '"');
		whip.debug("/resource[trickle]/:", id);
		whip.debug(req.body);
		// Check the Bearer token
		let auth = req.headers["authorization"];
		if(endpoint.token) {
			if(!auth || auth.indexOf('Bearer ') < 0) {
				res.status(403);
				res.send('Unauthorized');
				return;
			}
			let authtoken = auth.split('Bearer ')[1];
			if(!authtoken || authtoken.length === 0 || authtoken !== endpoint.token) {
				res.status(403);
				res.send('Unauthorized');
				return;
			}
		}
		if(!endpoint.enabled) {
			res.status(403);
			res.send('Endpoint ID not published');
			return;
		}
		// Check the latest ETag
		if(req.headers['if-match'] !== '"*"' && req.headers['if-match'] !== ('"' + endpoint.latestEtag + '"')) {
			if(config.strictETags) {
				// Only return a failure if we're configured with strict ETag checking, ignore it otherwise
				res.status(412);
				res.send('Precondition Failed');
				return;
			}
		}
		// Make sure Janus is up and running
		if(!janus || !janus.isReady() || janus.getState() !== "connected") {
			res.status(503);
			res.send('Janus unavailable');
			return;
		}
		// Make sure we received a trickle candidate
		if(req.headers["content-type"] !== "application/trickle-ice-sdpfrag") {
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
			} else if(line.indexOf("a=candidate:") === 0) {
				let candidate = {
					sdpMLineIndex: 0,
					candidate: line.split('a=')[1]
				};
				candidates.push(candidate);
			} else if(line.indexOf("a=end-of-candidates") === 0) {
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
			if(config.strictETags) {
				// Only return a failure if we're configured with strict ETag checking, ignore it otherwise
				res.status(412);
				res.send('Precondition Failed');
				return;
			}
		}
		if(!restart) {
			// Trickle the candidate(s)
			if(candidates.length > 0)
				janus.trickle({ uuid: endpoint.publisher, candidates: candidates });
			// We're Done
			res.sendStatus(204);
			return;
		}
		// If we got here, we need to do an ICE restart, which we do
		// by generating a new fake offer and send it to Janus
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
		endpoint.latestEtag = janus.generateRandomString(16);
		whip.warn('New ETag: ' + endpoint.latestEtag);
		// Send the new offer
		let details = {
			uuid: endpoint.publisher,
			jsep: {
				type: 'offer',
				sdp: endpoint.sdpOffer
			}
		};
		whip.info('[' + id + '] Performing ICE restart');
		janus.restart(details, function(err, result) {
			if(err) {
				whip.err('Error restarting:', err.error);
				res.status(400);
				res.send('Restart error');
			} else {
				// Now that we have a response, trickle the candidates we received
				if(candidates.length > 0 && janus)
					janus.trickle({ uuid: endpoint.publisher, candidates: candidates });
				// Read the ICE credentials and send them back
				let sdpAnswer = result.jsep.sdp;
				let serverUfrag = sdpAnswer.match(/a=ice-ufrag:(.*)\r\n/)[1];
				let serverPwd = sdpAnswer.match(/a=ice-pwd:(.*)\r\n/)[1];
				let payload =
					'a=ice-ufrag:' + serverUfrag + '\r\n' +
					'a=ice-pwd:' + serverPwd + '\r\n';
				res.set('ETag', '"' + endpoint.latestEtag + '"');
				res.writeHeader(200, { 'Content-Type': 'application/trickle-ice-sdpfrag' });
				res.write(payload);
				res.end();
			}
		});
	});

	// Stop publishing to a WHIP endpoint
	router.delete('/resource/:rid', function(req, res) {
		let rid = req.params.rid;
		let id = resources[rid];
		if(!rid || !id) {
			res.status(404);
			res.send('Invalid resource ID');
			return;
		}
		let endpoint = endpoints[id];
		if(!endpoint || !endpoint.enabled || !endpoint.publisher) {
			res.status(404);
			res.send('Invalid endpoint ID');
			return;
		}
		// Check the Bearer token
		let auth = req.headers["authorization"];
		if(endpoint.token) {
			if(!auth || auth.indexOf('Bearer ') < 0) {
				res.status(403);
				res.send('Unauthorized');
				return;
			}
			let authtoken = auth.split('Bearer ')[1];
			if(!authtoken || authtoken.length === 0 || authtoken !== endpoint.token) {
				res.status(403);
				res.send('Unauthorized');
				return;
			}
		}
		whip.debug("/resource/:", id);
		// Get rid of the Janus publisher
		if(janus)
			janus.removeSession({ uuid: endpoint.publisher });
		endpoint.enabled = false;
		delete endpoint.publisher;
		delete endpoint.sdpOffer;
		delete endpoint.ice;
		if(endpoint.resourceId)
			delete resources[endpoint.resourceId];
		delete endpoint.resourceId;
		delete endpoint.resource;
		delete endpoint.latestEtag;
		whip.info('[' + id + '] Terminating WHIP session');
		// Done
		res.sendStatus(200);
	});

	// GET, HEAD, POST and PUT on the resource must return a 405
	router.get('/resource/:rid', function(req, res) {
		res.sendStatus(405);
	});
	router.head('/resource/:rid', function(req, res) {
		res.sendStatus(405);
	});
	router.post('/resource/:rid', function(req, res) {
		res.sendStatus(405);
	});
	router.put('/resource/:rid', function(req, res) {
		res.sendStatus(405);
	});

	// Simple, non-standard, interface to destroy existing endpoints
	router.delete('/endpoint/:id', function(req, res) {
		let id = req.params.id;
		let endpoint = endpoints[id];
		if(!id || !endpoint) {
			res.status(404);
			res.send('Invalid endpoint ID');
			return;
		}
		// Check the Bearer token
		let auth = req.headers["authorization"];
		if(endpoint.token) {
			if(!auth || auth.indexOf('Bearer ') < 0) {
				res.status(403);
				res.send('Unauthorized');
				return;
			}
			let authtoken = auth.split('Bearer ')[1];
			if(!authtoken || authtoken.length === 0 || authtoken !== endpoint.token) {
				res.status(403);
				res.send('Unauthorized');
				return;
			}
		}
		whip.debug("/endpoint[destroy]/:", id);
		// Get rid of the Janus publisher, if there's one active
		if(endpoint.publisher && janus)
			janus.removeSession({ uuid: endpoint.publisher });
		if(endpoint.resourceId)
			delete resources[endpoint.resourceId];
		delete endpoint.resourceId;
		delete endpoints[id];
		whip.info('[' + id + '] Destroyed WHIP endpoint');
		// Done
		res.sendStatus(200);
	});

	// Setup CORS
	app.use(cors({ preflightContinue: true }));

	// Initialize the REST API
	let bodyParser = require('body-parser');
	app.use(bodyParser.json());
	app.use(bodyParser.text({ type: 'application/sdp' }));
	app.use(bodyParser.text({ type: 'application/trickle-ice-sdpfrag' }));
	app.use(config.rest, router);
}
