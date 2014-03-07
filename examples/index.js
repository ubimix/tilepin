(function(context) {
    $(function() {
        var tilesUrl = '/tiles/project/{z}/{x}/{y}.png';
        var center = [ 48.857487002645485, 2.3455810546875 ];
        var zoom = 2;
        var attribution = 'Map data &copy; '
                + '<a href="http://openstreetmap.org">OpenStreetMap</a> contributors';

        var map = L.map('map').setView(center, zoom);
        L.tileLayer(tilesUrl, {
            attribution : attribution,
            maxZoom : 6
        }).addTo(map);
    });

})(this);