Simple WHIP Server
==================

This is prototype implementation of a [WHIP server](https://www.rfc-editor.org/rfc/rfc9725.html), developed by [Meetecho](https://www.meetecho.com), using the [Janus WebRTC Server](https://github.com/meetecho/janus-gateway/) as a WebRTC server backend. While it was initially conceived to be used mostly for testing with [Simple WHIP Client](https://github.com/meetecho/simple-whip-client) (based on [GStreamer's webrtcbin](https://gstreamer.freedesktop.org/documentation/webrtc/index.html)), as a standard WHIP implementation it's supposed to interoperate just as well with other WHIP implementations (check [this presentation](https://github.com/IETF-Hackathon/ietf112-project-presentations/blob/main/ietf112-hackathon-whip.pdf) for some interoperability considerations).

# Installation

The server requires [Node.js](https://nodejs.org/) to run. In theory any version should work, even though I've used v12.x locally.

To install the dependencies, run:

	npm run build

# Configuration

The configuration file for the server can be found under `src/config.js`. The defaults should work fine, but in case you want to tweak anything, each property is commented so it should be easy to figure out how to modify it.

# Starting

You can start the server using the following command:

	npm start

which will use a limited amount of debugging. In case you're interested in a more verbose instance, you can use this command instead:

	npm run start-debug

# Testing

When started, the server will expose a REST interface implementing the WHIP API. Assuming the default values are used, a local instance of the server would be reachable at this base address:

	http://localhost:7080/whip

Considering Janus is used as a backend, before a WHIP endpoint can be negotiated, it needs to be created and mapped to a Janus resource. This can be done sending an HTTP POST to the `/create` endpoint of the REST API, with a JSON payload formatted like this:

```
{
	"id": "<unique ID of the endpoint to create>",
	"room": <VideoRoom room ID to publish media to>,
	"pin": <VideoRoom room pin, if required to join (optional)>,
	"label": <Display name to use in the VideoRoom room (optional)>,
	"token": "<token to require via Bearer authorization when using WHIP (optional)>,
	"iceServers": [ array of STUN/TURN servers to return via Link headers (optional) ],
	"recipient": { ... plain RTP recipient (optional) ... },
	"secret": <VideoRoom secret, if required for external RTP forwarding (optional)>,
	"adminKey": <VideoRoom plugin Admin Key, if required for external RTP forwarding (optional)>
}
```

If successful, a 200 OK will be returned, and the `/endpoint/<id>` endpoint will become available in the REST API: pushing an SDP to that resource using the WHIP API would lead the server to automatically create a VideoRoom publisher in the specified room. A simple example to create an endpoint using curl is the following:

	curl -H 'Content-Type: application/json' -d '{"id": "abc123", "room": 1234}' http://localhost:7080/whip/create

Notice that the server will not create the VideoRoom for you. In the example above, the specified room `1234` must exist already, or any attempt to publish there will fail.

Publishing to the WHIP endpoint via WebRTC can be done by sending an SDP offer to the created `/endpoint/<id>` endpoint via HTTP POST, which will interact with Janus on your behalf and, if successful, return an SDP answer back in the 200 OK. If you're using [Simple WHIP Client](https://github.com/meetecho/simple-whip-client) to test, the full HTTP path to the endpoint is all you need to provide as the WHIP url.

As per the specification, the response to the publish request will contain a `Location` header which points to the resource to use to refer to the stream. In this prototype implementation, the resource is handled by the same server instance, and is currently hardcoded, for the sake of simplicity, to the `/resource/<id>` endpoint (returned as a relative path in the header). That's the address used for interacting with the session, i.e., for tricking candidates, restarting ICE, and tearing down the session. The server is configured to automatically allow trickle candidates to be sent via HTTP PATCH to the `/resource/<id>` endpoint: if you'd like the server to not allow trickle candidates instead (e.g., to test if your client handles a failure gracefully), you can disable them in the configuration file. ICE restarts are supported too. Finally, that's also the address you'll need to send the HTTP DELETE request to, in case you want to signal the intention to tear down the WebRTC PeerConnection.

Notice that a DELETE to the resource endpoint will only tear down the PeerConnection, but will preserve the endpoint, meaning a new WHIP session towards the same Janus room can be created again: to permanently destroy an existing endpoint, you can issue a DELETE to the `/endpoint/<id>` endpoint instead. For testing purposes, you can retrieve a list of the created endpoints by sending a GET to the `/endpoints` resource: notice that, since this is a testbed implementation, this request is not authenticated.

# Web demo

To make the management of endpoints easier, the server comes with an intergrated web demo, available at the base address of the web server, e.g.:

	http://localhost:7080

The demo allows you to visually create, list, teardown and destroy endpoints, using the same REST APIs introduced previously. Notice that there's no way to publish or consume via WebRTC in that demo page, as the main purpose of this prototype is testing the interoperability with non-browser implementations. To watch the ingested stream, you should refer to the resources made available by the WebRTC server itself (e.g., the Janus VideoRoom demo page).
