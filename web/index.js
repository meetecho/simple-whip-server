// Base path for the REST WHIP API
var rest = '/whip';
// Endpoints we're aware of
var endpoints = {};

$(document).ready(function() {
	// Query the list of endpoints
	getEndpoints();
	// Initialize the button to add new endpoints
	$('#create').click(createEndpoint);
});

// Helper method to get the list of endpoints
function getEndpoints() {
	$.ajax({
		url: rest + '/endpoints'
	}).error(function(xhr, textStatus, errorThrown) {
		bootbox.alert('/endpoints/ ' + xhr.status + ': ' + xhr.responseText, function() {
			setTimeout(getEndpoints, 5000);
		});
	}).done(function(response) {
		let ids = {};
		for(let id in endpoints)
			ids[id] = true;
		for(let endpoint of response) {
			delete ids[endpoint.id];
			addOrUpdateEndpoint(endpoint);
		}
		for(let id in ids) {
			toastr.info('Endpoint <' + id + '> destroyed');
			$('#endpoint-' + id).remove();
			delete endpoints[id];
		}
		setTimeout(getEndpoints, 5000);
	});
}

// Helper to add or update info on an endpoint
function addOrUpdateEndpoint(endpoint) {
	if(!endpoint)
		return;
	let newEndpoint = false;
	let prevEndpoint = endpoints[endpoint.id];
	if(!prevEndpoint) {
		// New endpoint, add the details to the UI
		newEndpoint = true;
		endpoints[endpoint.id] = endpoint;
		$('#controls').before(
			'<tr id="endpoint-' + endpoint.id + '">' +
			'	<td><span class="label label-primary">' + endpoint.id + '</span></td>' +
			'	<td><span class="label label-info">' + endpoint.room + '</span></td>' +
			'	<td><span class="label label-info">' + (endpoint.pin ? endpoint.pin : '(none)') + '</span></td>' +
			'	<td><span class="label label-info">' + endpoint.label + '</span></td>' +
			'	<td><span class="label label-info">' + (endpoint.token ? endpoint.token : '(none)') + '</span></td>' +
			'	<td><span class="label label-' + (endpoint.enabled ? 'success' : 'danger') + '" id="state-' + endpoint.id + '">' + (endpoint.enabled ? 'active' : 'idle') + '</span></td>' +
			'	<td><button class="btn btn-warning btn-xs hide" id="teardown-' + endpoint.id + '">Teardown</button></td>' +
			'	<td><button class="btn btn-danger btn-xs" id="destroy-' + endpoint.id + '">Destroy</button></td>' +
			'</tr>'
		);
		$('#destroy-' + endpoint.id).click(function() {
			let id = $(this).attr('id').split('destroy-')[1];
			bootbox.confirm('Permanently destroy endpoint &lt;' + id + '&gt;?', function(result) {
				if(result) {
					// Send the DELETE to the endpoint
					let endpoint = endpoints[id];
					if(!endpoint)
						return;
					$.ajax({
						url: rest + '/endpoint/' + id,
						beforeSend: function(xhr) {
							if(endpoint.token)
								xhr.setRequestHeader('Authorization', 'Bearer ' + endpoint.token);
						},
						type: 'DELETE'
					}).error(function(xhr, textStatus, errorThrown) {
						bootbox.alert('/endpoint/' + id + ' ' + xhr.status + ': ' + xhr.responseText);
					}).done(function(response) {
						toastr.info('Endpoint <' + id + '> destroyed');
						$('#endpoint-' + id).remove();
						delete endpoints[id];
					});
				}
			});
		});
	}
	if(!prevEndpoint || prevEndpoint.enabled !== endpoint.enabled) {
		// State of the endpoint changed
		if(endpoint.enabled) {
			$('#state-' + endpoint.id)
				.removeClass('label-success label-danger')
				.addClass('label-success')
				.html('active');
			$('#teardown-' + endpoint.id)
				.removeClass('hide')
				.unbind('click')
				.click(function() {
					let id = $(this).attr('id').split('teardown-')[1];
					if(!endpoint.resource) {
						toastr.warning('Missing resource url for endpoint &lt;' + id + '&gt;');
						return;
					}
					bootbox.confirm('Teardown PeerConnection on endpoint &lt;' + id + '&gt;?', function(result) {
						if(result) {
							// Send the DELETE to the endpoint
							$.ajax({
								url: rest + '/resource/' + id,,
								beforeSend: function(xhr) {
									if(endpoint.token)
										xhr.setRequestHeader('Authorization', 'Bearer ' + endpoint.token);
								},
								type: 'DELETE'
							}).error(function(xhr, textStatus, errorThrown) {
								bootbox.alert(endpoint.resource + ' ' + xhr.status + ': ' + xhr.responseText);
							}).done(function(response) {
								toastr.info('PeerConnection for endpoint &lt;' + id + '&gt; torn down');
								endpoint.enabled = false;
								if(endpoints[endpoint.id])
									addOrUpdateEndpoint(endpoint);
							});
						}
					});
				});
			if(prevEndpoint)
				toastr.info('Endpoint &lt;' + endpoint.id + '&gt; now active');
		} else {
			$('#state-' + endpoint.id)
				.removeClass('label-success label-danger')
				.addClass('label-danger')
				.html('idle');
			if(!$('#teardown-' + endpoint.id).hasClass('hide'))
				$('#teardown-' + endpoint.id).addClass('hide');
			if(prevEndpoint)
				toastr.info('Endpoint &lt;' + endpoint.id + '&gt; now idle');
		}
		if(prevEndpoint)
			prevEndpoint.enabled = endpoint.enabled;
	}
}

// Helper method to create a new endpoint
function createEndpoint() {
	let content =
		'<form class="form-horizontal">' +
		'	<div class="form-group">' +
		'		<label for="id" class="col-sm-3 control-label">ID</label>' +
		'		<div class="col-sm-9">' +
		'			<input type="text" class="form-control" id="id" placeholder="Insert the Endpoint ID" onkeypress="return checkEnter(this, event);"></input>' +
		'		</div>' +
		'	</div>' +
		'	<div class="form-group">' +
		'		<label for="room" class="col-sm-3 control-label">Room</label>' +
		'		<div class="col-sm-9">' +
		'			<input type="text" class="form-control" id="room" placeholder="Insert the Janus VideoRoom to publish in" onkeypress="return checkEnter(this, event);"></input>' +
		'		</div>' +
		'	</div>' +
		'	<div class="form-group">' +
		'		<label for="pin" class="col-sm-3 control-label">Room PIN</label>' +
		'		<div class="col-sm-9">' +
		'			<input type="text" class="form-control" id="pin" placeholder="Insert the Janus VideoRoom PIN (optional)" onkeypress="return checkEnter(this, event);"></input>' +
		'		</div>' +
		'	</div>' +
		'	<div class="form-group">' +
		'		<label for="display" class="col-sm-3 control-label">Label/Display</label>' +
		'		<div class="col-sm-9">' +
		'			<input type="text" class="form-control" id="display" placeholder="Insert the display name to use in the VideoRoom (optional)" onkeypress="return checkEnter(this, event);"></input>' +
		'		</div>' +
		'	</div>' +
		'	<div class="form-group">' +
		'		<label for="token" class="col-sm-3 control-label">WHIP Token</label>' +
		'		<div class="col-sm-9">' +
		'			<input type="text" class="form-control" id="token" placeholder="Insert the Authorization token to require (optional)" onkeypress="return checkEnter(this, event);"></input>' +
		'		</div>' +
		'	</div>' +
		'</div>';
	bootbox.dialog({
		title: 'Create endpoint',
		message: content,
		buttons: {
			cancel: {
				label: 'Cancel',
				className: 'btn-info',
				callback: function() {
				}
			},
			ok: {
				label: 'OK',
				className: 'btn-primary',
				callback: function() {
					let id = $('#id').val();
					let room = $('#room').val();
					let pin = $('#pin').val();
					let display = $('#display').val();
					let token = $('#token').val();
					if(!id || id === '' || !room || room === '') {
						bootbox.alert('Missing required arguments');
						return;
					}
					if(/[^a-zA-Z0-9-_]/.test(id)) {
						bootbox.alert('Endpoint ID is not alphanumeric');
						return;
					}
					// Note: we're assuming the Janus VideoRoom ID is numeric
					let roomNum = parseInt(room);
					if(isNaN(roomNum)) {
						bootbox.alert('VideoRoom ID is not numeric');
						return;
					}
					// Send the request to create the endpoint
					let create = { id: id, room: roomNum };
					if(pin && pin !== '')
						create.pin = pin;
					if(display && display !== '')
						create.label = display;
					if(token && token !== '')
						create.token = token;
					$.ajax({
						url: rest + '/create',
						type: 'POST',
						contentType: 'application/json; charset=utf-8',
						data: JSON.stringify(create)
					}).error(function(xhr, textStatus, errorThrown) {
						bootbox.alert(rest + '/create/ ' + xhr.status + ': ' + xhr.responseText);
					}).done(function(response) {
						// Done
						toastr.info('Endpoint created, updating list...');
					});
				}
			}
		}
	});
}

// Helper to intercept enter on field
function checkEnter(field, event) {
	let theCode = event.keyCode ? event.keyCode : event.which ? event.which : event.charCode;
	if(theCode == 13) {
		return false;
	} else {
		return true;
	}
}
