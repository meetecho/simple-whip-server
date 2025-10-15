Simple WHIP Server
==================

This is a Node.js library implementation of a [WHIP server](https://www.rfc-editor.org/rfc/rfc9725.html), developed by [Meetecho](https://www.meetecho.com), using the [Janus WebRTC Server](https://github.com/meetecho/janus-gateway/) as a WebRTC server backend and [Janode](https://github.com/meetecho/janode/) as its Janus stack. While it was initially conceived to be used mostly for testing with [Simple WHIP Client](https://github.com/meetecho/simple-whip-client) (based on [GStreamer's webrtcbin](https://gstreamer.freedesktop.org/documentation/webrtc/index.html)), as a standard WHIP implementation it's supposed to interoperate just as well with other WHIP implementations (check [this presentation](https://github.com/IETF-Hackathon/ietf112-project-presentations/blob/main/ietf112-hackathon-whip.pdf) for some interoperability considerations).

The library is available on [npm](https://www.npmjs.com/package/janus-whip-server) and the source code is on [Github](https://github.com/meetecho/simple-whip-server/).

> Note: this is an implementation of WHIP (WebRTC-HTTP ingestion protocol), **NOT** WHEP (WebRTC-HTTP egress protocol). If you're looking for a WHEP server to handle media ingestion, check the [Simple WHEP Server](https://github.com/meetecho/simple-whep-server) library instead. The two libraries can be used together in the same application, if you want to serve both protocols at the same time.

# Example of usage

The repo comes with a [few examples](https://github.com/meetecho/simple-whip-server/tree/master/examples) that show how you can create a new WHIP server.

You create a new server this way:

```js
const server = new JanusWhipServer(config);
await server.start();
```

where `config` is an object that may contain the following properties:

```
{
	janus: {
		address: '<Janus backend (Janode supported transports)>'
	},
	rest: {
		app: <existing Express application to add the WHIP server to, if reusing an existing REST server>
		port: <port to bind the WHIP server to, in case a new REST server is to be created>,
		basePath: '<base path to use for all WHIP endpoints, e.g., /whip>',
		https: {
			// cert, key, passphrase; in case an HTTPS server is to be created
		}
	},
	allowTrickle: <whether trickle should be allowed; true by default>,
	strictETags: <whether to be strict when checking ETags in HTTP PATCH; false by default>,
	iceServers: [
		// list of ICE servers to send back in Link headers by default, e.g.
		//	{ uri: 'stun:stun.example.net' },
		//	{ uri: 'turn:turn.example.net?transport=udp', username: 'user', credential: 'password' },
	]
}
```

The following snippet creates a WHIP server that will spawn its own REST backend on port `7080`:

```js
const server = new JanusWhipServer({
	janus: {
		address: 'ws://localhost:8188'
	},
	rest: {
		port: 7080,
		basePath: '/whip'
	}
});
```

The following snippet reuses an existing Express app contest for the WHIP server:

```js
const server = new JanusWhipServer({
	janus: {
		address: 'ws://localhost:8188'
	},
	rest: {
		app: myApp,
		basePath: '/whip'
	}
});
```

The `JanusWhipServer` exposes a few methods to manage endpoints that should be served by the WHIP server. This creates a new endpoint:

```js
const endpoint = server.createEndpoint({ id: 'test', room: 1234, token: 'verysecret' });
```

which returns a `JanusWhipEndpoint` instance. You can also retrieve the same instance later on with a call to `getEndpoint(id)`, should you need it.

The object to pass when creating a new endpoint must refer to the following structure:

```
{
	id: "<unique ID of the endpoint to create>",
	plugin: "<ID of the Janus plugin to publish to (optional, default=videoroom; supported=videoroom,audiobridge,recordplay,ndi)>",
	room: <VideoRoom|AudioBridge room ID to publish media to (mandatory when using VideoRoom or AudioBridge)>,
	pin: <VideoRoom|AudioBridge room pin, if required to join (optional)>,
	label: "<Display name to use in the VideoRoom|AudioBridge room, Record&Play recording or as an NDI sender (optional)">,
	token: "<token to require via Bearer authorization when using WHIP: can be either a string, or a callback function to validate the provided token (optional)>",
	iceServers: [ array of STUN/TURN servers to return via Link headers (optional, overrides global ones) ],
	recipients: [ { ... plain RTP recipient (optional, only supported for VideoRoom) ... } ],
	secret: "<VideoRoom secret, if required for external RTP forwarding (optional)>",
	adminKey: "<VideoRoom plugin Admin Key, if required for external RTP forwarding (optional)>",
	customize: <callback function to provide most of the above properties dynamically, for each publisher>
}
```

See the [examples](https://github.com/meetecho/simple-whip-server/tree/master/examples) for more info.

Publishing to a WHIP endpoint via WebRTC can be done by sending an SDP offer to the created `<basePath>/endpoint/<id>` endpoint via HTTP POST, which will interact with Janus on your behalf and, if successful, return an SDP answer back in the 200 OK. If you're using [Simple WHIP Client](https://github.com/meetecho/simple-whip-client) to test, the full HTTP path to the endpoint is all you need to provide as the WHIP url.

As per the specification, the response to the publish request will contain a `Location` header which points to the resource to use to refer to the stream. In this implementation, the resource is handled by the same server instance, and is randomized to a `<basePath>/resource/<rid>` endpoint (returned as a relative path in the header). That's the address used for interacting with the session, i.e., for tricking candidates, restarting ICE, and tearing down the session. The server is configured to automatically allow trickle candidates to be sent via HTTP PATCH to the `<basePath>/resource/<rid>` endpoint: if you'd like the server to not allow trickle candidates instead (e.g., to test if your client handles a failure gracefully), you can disable them when creating the server via `allowTrickle`. ICE restarts are supported too. Finally, that's also the address you'll need to send the HTTP DELETE request to, in case you want to signal the intention to tear down the WebRTC PeerConnection.

Notice that a DELETE to the resource endpoint will only tear down the PeerConnection, but will preserve the endpoint, meaning a new WHIP session towards the same Janus room can be created again: to permanently destroy an existing endpoint, you need to destroy it via `destroyEndpoint`:

```js
server.destroyEndpoint({ id: 'test' });
```

This returns a list of existing endpoints the WHIP server is aware of:

```js
const list = server.listEndpoints();
```

Notice that the array will contain a list of objects only including the `id` and `enabled` properties. An endpoint that currently has an active publisher will have the `enabled` property set to `true`. If you want more details on a specific endpoint (e.g., to access the endpoint instance and update the event emitter configuration), use `getEndpoint(id)` instead.

Both `JanusWhipServer` and `JanusWhipEndpoint` are event emitters. At the time of writing, the supported events are:

* `janus-disconnected`
* `janus-reconnected`
* `endpoint-active`
* `endpoint-inactive`

Check the demos for an example.
