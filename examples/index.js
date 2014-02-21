(function(context) {
    $(function() {
        var projectIdField = $('#projectId');
        var btn = $('#projectIdSubmit');

        var center = [ 48.857487002645485, 2.3455810546875 ];
        var zoom = 12;

        var attribution = 'Map data &copy; '
                + '<a href="http://openstreetmap.org">OpenStreetMap</a> contributors';
        var map;
        btn.on('click', function() {
            var path = projectIdField.val();
            if (map) {
                map.remove();
                map = null;
            }
            map = L.map('map').setView(center, zoom);
            var tilesUrl = '/tiles/' + path + '/{z}/{x}/{y}.png';
            L.tileLayer(tilesUrl, {
                attribution : attribution,
                maxZoom : 18
            }).addTo(map);
        })
    });

})(this);