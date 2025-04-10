import express from 'express';
import http from 'http';
import { JanusWhipServer } from '../../../src/whip.js';

(async function main() {
	console.log('Example: WHIP server creating a new REST backend');
	let server = null;

	// Create an HTTP server and bind to port 7180 just to list endpoints
	let myApp = express();
	myApp.get('/endpoints', async (_req, res) => {
		res.setHeader('content-type', 'application/json');
		res.status(200);
		res.send(JSON.stringify(server.listEndpoints()));
	});
	http.createServer({}, myApp).listen(7180);

	// Create a WHIP server, binding to port 7080 and using base path /whip
	server = new JanusWhipServer({
		janus: {
			address: 'ws://localhost:8188'
		},
		rest: {
			port: 7080,
			basePath: '/whip'
		}
	});
	// Add a couple of global event handlers
	server.on('janus-disconnected', () => {
		console.log('WHIP server lost connection to Janus');
	});
	server.on('janus-reconnected', () => {
		console.log('WHIP server reconnected to Janus');
	});
	// Start the server
	await server.start();

	// Create a test endpoint using a static token
	let endpoint = server.createEndpoint({ id: 'abc123', room: 1234, token: 'verysecret' });
	endpoint.on('endpoint-active', function() {
		console.log(this.id + ': Endpoint is active');
	});
	endpoint.on('endpoint-inactive', function() {
		console.log(this.id + ': Endpoint is inactive');
	});
}());
