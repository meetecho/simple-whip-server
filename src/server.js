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
var endpoints = {};

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
		var app = express();
		app.use(express.static('web'));
		setupRest(app);
		// Are we using plain HTTP or HTTPS?
		var options = null;
		var https = (config.https && config.https.cert && config.https.key);
		if(https) {
			var fs = require('fs');
			options = {
				cert: fs.readFileSync(config.https.cert, 'utf8'),
				key: fs.readFileSync(config.https.key, 'utf8'),
				passphrase: config.https.passphrase
			};
		}
		var http = require(https ? 'https' : 'http').createServer(options, app);
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
			delete janus;
			janus = null;
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
	var router = express.Router();

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
		var list = [];
		for(var id in endpoints)
			list.push(endpoints[id]);
		res.send(JSON.stringify(list));
	});

	// Simple, non-standard, interface to create endpoints and map them to Janus rooms
	router.post('/create', function(req, res) {
		whip.debug("/create:", req.body);
		var id = req.body.id;
		var room = req.body.room;
		var token = req.body.token;
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
			token: token,
			enabled: false
		};
		whip.info('[' + id + '] Created new WHIP endpoint');
		// Done
		res.sendStatus(200);
	});

	// Publish to a WHIP endpoint
	router.post('/endpoint/:id', function(req, res) {
		var id = req.params.id;
		var endpoint = endpoints[id];
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
		var auth = req.headers["authorization"];
		if(endpoint.token) {
			if(!auth || auth.indexOf('Bearer ') < 0) {
				res.status(403);
				res.send('Unauthorized');
				return;
			}
			var authtoken = auth.split('Bearer ')[1];
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
		var uuid = "WHIP Publisher " + endpoint.room;
		// Create a new session
		janus.removeSession({ uuid: uuid });
		janus.addSession({ uuid: uuid });
		// Prepare the JSEP object
		var details = {
			uuid: uuid,
			room: endpoint.room,
			jsep: {
				type: 'offer',
				sdp: req.body
			}
		};
		endpoint.enabled = true;
		endpoint.publisher = uuid;
		// Publish
		janus.publish(details, function(err, result) {
			// Make sure we got an ANSWER back
			if(err) {
				endpoint.enabled = false;
				delete endpoint.publisher;
				res.status(500);
				res.send(err.error);
			} else {
				whip.info('[' + id + '] Publishing to WHIP endpoint');
				endpoint.resource = '/whip/resource/' + id;
				// Done
				res.setHeader('content-type', 'application/sdp');
				res.setHeader('location', endpoint.resource);
				res.status(201);
				res.send(result.jsep.sdp);
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
	router.patch('/resource/:id', function(req, res) {
		var id = req.params.id;
		var endpoint = endpoints[id];
		if(!id || !endpoint) {
			res.status(404);
			res.send('Invalid endpoint ID');
			return;
		}
		whip.debug("/resource[trickle]/:", id);
		whip.debug(req.body);
		// Check the Bearer token
		var auth = req.headers["authorization"];
		if(endpoint.token) {
			if(!auth || auth.indexOf('Bearer ') < 0) {
				res.status(403);
				res.send('Unauthorized');
				return;
			}
			var authtoken = auth.split('Bearer ')[1];
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
		// Make sure we received a trickle candidate
		if(req.headers["content-type"] !== "application/trickle-ice-sdpfrag") {
			res.status(406);
			res.send('Unsupported content type');
			return;
		}
		var candidate = req.params.candidate;
		janus.trickle({ uuid: endpoint.publisher, candidate: candidate });
		// Done
		res.sendStatus(200);
	});

	// Stop publishing to a WHIP endpoint
	router.delete('/resource/:id', function(req, res) {
		var id = req.params.id;
		var endpoint = endpoints[id];
		if(!id || !endpoint || !endpoint.enabled || !endpoint.publisher) {
			res.status(404);
			res.send('Invalid resource ID');
			return;
		}
		// Check the Bearer token
		var auth = req.headers["authorization"];
		if(endpoint.token) {
			if(!auth || auth.indexOf('Bearer ') < 0) {
				res.status(403);
				res.send('Unauthorized');
				return;
			}
			var authtoken = auth.split('Bearer ')[1];
			if(!authtoken || authtoken.length === 0 || authtoken !== endpoint.token) {
				res.status(403);
				res.send('Unauthorized');
				return;
			}
		}
		whip.debug("/resource/:", id);
		// Get rid of the Janus publisher
		janus.removeSession({ uuid: endpoint.publisher });
		endpoint.enabled = false;
		delete endpoint.publisher;
		delete endpoint.resource;
		whip.info('[' + id + '] Terminating WHIP session');
		// Done
		res.sendStatus(200);
	});

	// GET, HEAD, POST and PUT on the resource must return a 405
	router.get('/resource/:id', function(req, res) {
		res.sendStatus(405);
	});
	router.head('/resource/:id', function(req, res) {
		res.sendStatus(405);
	});
	router.post('/resource/:id', function(req, res) {
		res.sendStatus(405);
	});
	router.put('/resource/:id', function(req, res) {
		res.sendStatus(405);
	});

	// Simple, non-standard, interface to destroy existing endpoints
	router.delete('/endpoint/:id', function(req, res) {
		var id = req.params.id;
		var endpoint = endpoints[id];
		if(!id || !endpoint) {
			res.status(404);
			res.send('Invalid resource ID');
			return;
		}
		// Check the Bearer token
		var auth = req.headers["authorization"];
		if(endpoint.token) {
			if(!auth || auth.indexOf('Bearer ') < 0) {
				res.status(403);
				res.send('Unauthorized');
				return;
			}
			var authtoken = auth.split('Bearer ')[1];
			if(!authtoken || authtoken.length === 0 || authtoken !== endpoint.token) {
				res.status(403);
				res.send('Unauthorized');
				return;
			}
		}
		whip.debug("/endpoint[destroy]/:", id);
		// Get rid of the Janus publisher, if there's one active
		if(endpoint.publisher)
			janus.removeSession({ uuid: endpoint.publisher });
		delete endpoints[id];
		whip.info('[' + id + '] Destroyed WHIP endpoint');
		// Done
		res.sendStatus(200);
	});

	// Initialize the REST API
	var bodyParser = require('body-parser');
	app.use(bodyParser.json());
	app.use(bodyParser.text({ type: 'application/sdp' }));
	app.use(bodyParser.json({ type: 'application/trickle-ice-sdpfrag' }));
	app.use(config.rest, router);
}
