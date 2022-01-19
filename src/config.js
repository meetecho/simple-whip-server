export default {

	// Janus info
	janus: {
		// WebSocket address
		address: 'ws://127.0.0.1:8188',
		// Janus API secret, if required
		//~ apiSecret: 'janusrocks'
	},

	// Port to bind the WHIP API to
	port: 7080,
	// By default we create a plain HTTP backend, but you can turn that
	// into an HTTPS one instead if you configure the certificate to use
	// https: {
	// 	cert: '/path/to/certificate',
	// 	key: '/path/to/privatekey',
	// 	passphrase: 'key passphrase, if required'
	// },

	// Base path for the REST WHIP API
	rest: '/whip',

	// Whether we should allow trickle candidates via API: if disabled,
	// we'll send back an HTTP 405 error as per the specification
	allowTrickle: true,

	// In case we need to always return a set of STUN/TURN servers to
	// WHIP clients via a Link header (unless some servers have been provided
	// as part of the endpoint creation request), we can put them here
	iceServers: [
		//~ { uri: 'stun:stun.example.net' },
		//~ { uri: 'turn:turn.example.net?transport=udp', username: 'user', credential: 'password' },
		//~ { uri: 'turn:turn.example.net?transport=tcp', username: 'user', credential: 'password' },
		//~ { uri: 'turns:turn.example.net?transport=tcp', username: 'user', credential: 'password' },
	]
};
