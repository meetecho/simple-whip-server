Simple WHIP Server examples
===========================

This folder contains a few example applications using the Janus WHIP library.

* The `server-owned` folder contains an example where the application asks the library to create a new REST server to host the WHIP functionality, binding to the provided port. A separate REST server is then spawned by the application for its own purposes (e.g., listing the available endpoints). A sample endpoint is created, with a static token.

* The `server-shared` folder, instead, contains an example where the application pre-creates a REST server for its own needs, and then tells the library to re-use that server for the WHIP functionality too. A sample endpoint is created, with a callback function used to validate the token any time one is presented.

Both demos subscribe to a few of the events the library can emit for debugging purposes.
