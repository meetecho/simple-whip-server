module.exports = {

	// Janus info
	janus: {
		// WebSocket address
		address: 'ws://127.0.0.1:8188',
		// Janus API secret, if required
		//~ apiSecret: 'janusrocks'
	},

	// Port to bind the WHIP API to
	port: 7080,

	// Base path for the REST WHIP API
	rest: '/whip',

	// Whether we should allow trickle candidates via API: if disabled,
	// we'll send back an HTTP 405 error as per the specification
	allowTrickle: true
};
