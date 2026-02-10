Simple WHIP Server examples
===========================

This folder contains a few example applications using the Janus WHIP library.

* The `server-owned` folder contains an example where the application asks the library to create a new REST server to host the WHIP functionality, binding to the provided port. A separate REST server is then spawned by the application for its own purposes (e.g., listing the available endpoints). A sample endpoint is created, with a static token.

* The `server-shared` folder, instead, contains an example where the application pre-creates a REST server for its own needs, and then tells the library to re-use that server for the WHIP functionality too. A sample endpoint is created, with a callback function used to validate the token any time one is presented.

* The `server-dynamic` folder shows how you can use dynamic features for a new endpoint, e.g., by choosing different rooms or RTP forwarding recipients for different WHIP publishers contacting the same endpoint.

* The `audiobridge` folder shows how you can configure a WHIP endpoint to publish to the AudioBridge plugin, instead of the VideoRoom (which is the default).

* The `recordplay` folder shows how you can configure a WHIP endpoint to publish to the RecordPlay plugin, instead of the VideoRoom (which is the default), thus simply recording the published media to a Janus recording.

* The `ndi` folder shows how you can configure a WHIP endpoint to publish to the [NDI plugin](https://github.com/meetecho/janus-ndi), instead of the VideoRoom (which is the default), in order to have the WebRTC stream turned into an NDI sender. Notice that this will fail if the NDI plugin is not available in the Janus instance.

All demos subscribe to a few of the events the library can emit for debugging purposes.
