var express = require('express');
var P = require('./tilepin-commons').P;
var _ = require('underscore');
var app = express();
var Url = require('url');
var Tilepin = require('./tilepin');
var TilepinCache = require('./tilepin-cache-redis');
var TileMillProjectLoader = require('./tilepin-loader');
// var TilepinCache = require('./tilepin-cache-mbtiles');

var port = 8888;
var redisOptions = {};
var tileCache = new TilepinCache(redisOptions);
var workdir = process.cwd();

var projectLoader = new TileMillProjectLoader({
    dir : workdir
});
var options = {
    useVectorTiles : true,
    cache : tileCache,
    styleDir : workdir,
    projectLoader : projectLoader
};
// options = {};

var dir = __dirname;
var baseProvider = new Tilepin.ProjectBasedTilesProvider(options);
options.provider = function(params, force) {
    return baseProvider;
};
var tileProvider = new Tilepin.CachingTilesProvider(options);

var promise = P();
promise = promise
//
.then(function initApplication(tileSource) {
    app.configure(function() {
        app.use(function(req, res, next) {
            res.setHeader('Access-Control-Allow-Origin', '*');
            return next();
        });
        app.use(express.static(workdir + '/'));
    });

    var mask;

    mask = '/tiles/invalidate/:source([^]+)'
    app.get(mask, function(req, res) {
        var formats = req.query['formats'];
        if (formats) {
            formats = formats.split(/[,;]/gim)
        } else {
            formats = undefined;
        }
        tileProvider.invalidate({
            formats : formats,
            source : req.param('source')
        }).then(function(result) {
            sendReply(req, res, 200, 'OK');
        }).fail(function(err) {
            sendError(req, res, err);
        }).done();
    });

    mask = '/tiles/:source([^]+)/:z/:x/:y.:format(png|grid.json|vtile)';
    app.get(mask, function(req, res) {
        var format = req.params.format;
        var conf = {
            source : req.params.source,
            format : format,
            z : req.params.z,
            x : +req.params.x,
            y : +req.params.y,
        };
        tileProvider.loadTile(conf).then(function(result) {
            sendReply(req, res, 200, result.tile, result.headers);
        }).fail(function(err) {
            sendError(req, res, err);
        }).done();
    });

    mask = '/tiles/:source([^]+)';
    app.get(mask, function(req, res) {
        var format = req.param('format');
        var source = req.param('source');
        var fullUrl = req.protocol + '://' + req.get('host') + req.originalUrl;
        if (fullUrl[fullUrl.length - 1] != '/') {
            fullUrl += '/';
        }
        var tilesMask = Url.resolve(fullUrl, './{z}/{x}/{y}');
        if (source[source.length - 1] == '/') {
            source = source.substring(0, source.length - 1);
        }
        var options = {
            format : format || 'vtile',
            source : source
        };
        tileProvider.loadInfo(options).then(function(result) {
            result.tilejson = "2.0.0";
            result.format = 'pbf';
            result.id = source;
            result.tiles = [ tilesMask + '.vtile' ];
            var fields = {};
            var array = (result.interactivity_fields || '').split(',');
            _.each(array, function(val) {
                fields[val] = val;
            })
            result.vector_layers = [ {
                description : '',
                fields : fields,
                maxzoom : result.maxzoom,
                minzoom : result.minzoom,
                id : result.interactivity_layer
            } ]
            sendReply(req, res, 200, result);
        }).fail(function(err) {
            sendError(req, res, err);
        }).done();

        // sendReply(req, res, 200, {
        // tilejson : "2.0.0",
        // tiles : [ tilesMask + '.png' ],
        // vector_layers : [ tilesMask + '.vtile' ]
        // })
    })

    mask = '/export/:source([^]+)/:file.:format(svg|pdf|png)';
    app.get(mask, function(req, res) {
        var format = req.params.format;
        var conf = {
            source : req.params.source,
            format : format,
            z : req.params.z,
            x : +req.params.x,
            y : +req.params.y,
        };
        var mercator = new (require('sphericalmercator'));

        var zoom = 16;
        var first = [ 2.3445940017700195, 48.85892699104534 ];
        var second = [ 2.364506721496582, 48.853759781483475 ];
        var firstPoint = mercator.px(first, zoom);
        var secondPoint = mercator.px(second, zoom)
        var size = {
            width : Math.abs(firstPoint[0] - secondPoint[0]),
            height : Math.abs(firstPoint[1] - secondPoint[1])
        }
        var w = Math.min(first[0], second[0]);
        var s = Math.min(first[1], second[1]);
        var e = Math.max(first[0], second[0]);
        var n = Math.max(first[1], second[1]);
        var bbox = mercator.convert([ w, s, e, n ], '900913');
        return projectLoader.loadProject(conf).then(function(uri) {
            var mime = 'application/' + format;
            var options = _.extend({}, uri, size);
            var mapnik = require('mapnik');
            var map = new mapnik.Map(options.width, options.height);
            return P.ninvoke(map, 'fromString', options.xml, options)//
            .then(function(map) {
                map.extent = bbox;
                var path = './map[' + bbox.join(',') + '].' + format;
                return P.ninvoke(map, 'renderFile', path, {
                    format : format,
                    scale : 1.0
                }).then(function() {
                    var FS = require('fs');
                    return P.ninvoke(FS, 'readFile', path) //
                    .then(function(buffer) {
                        return {
                            tile : buffer,
                            headers : {
                                'Content-Type' : mime
                            }
                        }
                    })
                });
            })
        }).then(function(result) {
            sendReply(req, res, 200, result.tile, result.headers);
        }).fail(function(err) {
            sendError(req, res, err);
        }).done();
    });

    app.listen(port);
    console.log('Listening on port: ' + port);
    return true;
})
//    
.then(function() {
    console.log('Tilelive is activated...');
}, function reportActivation(err) {
    console.log(err);
})
//
.done();

process.on('SIGTERM', function() {
    console.log("Closing...");
    P().then(function() {
        app.close();
    }).then(function() {
        return tileProvider.close();
    }).then(function() {
        console.log("Server is down.");
    }).done();
});

function sendError(req, res, err) {
    var statusCode = 400;
    var errMsg = err.message ? ('' + err.message) : ('' + err);
    if (-1 != errMsg.indexOf('permission denied')) {
        statusCode = 401;
    } else if (-1 != errMsg.indexOf('does not exist')) {
        statusCode = 404;
    }
    // Rewrite mapnik parsing errors to start with layer number
    var matches; // = errMsg.match("(.*) in style 'layer([0-9]+)'");
    if (matches = errMsg.match("(.*) in style 'layer([0-9]+)'")) {
        errMsg = 'style' + matches[2] + ': ' + matches[1];
    }
    var result = {
        msg : errMsg,
        stack : err.stack
    }
    sendReply(req, res, statusCode, result);
}

function sendReply(req, res, statusCode, content, headers) {
    var callback = req.query.callback;
    res.status(statusCode);
    if (callback == '')
        callback = null;
    if (callback) {
        if (headers) {
            headers['Content-Type'] = 'application/javascript';
        }
        var str;
        if (Buffer.isBuffer(content)) {
            str = content.toString();
        } else {
            str = JSON.stringify(content);
        }
        content = callback + '(' + str + ');'
    }
    _.each(headers, function(value, key) {
        res.setHeader(key, value);
    })
    res.send(content);
}
