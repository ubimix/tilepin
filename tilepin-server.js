var express = require('express');
var P = require('./tilepin-commons').P;
var EventManager = require('./tilepin-commons').EventManager;
var _ = require('underscore');
var app = express();
var Url = require('url');
var Path = require('path');
var Tilepin = require('./tilepin');
var TilepinCache = require('./tilepin-cache-redis');
var TileMillProjectLoader = require('./tilepin-loader');
var MapExport = require('./tilepin-export');

var port = 8888;
var redisOptions = {};
var tileCache = new TilepinCache(redisOptions);
var workDir = process.cwd();
var tmpFileDir = Path.join(workDir, 'tmp');

var projectLoader = new TileMillProjectLoader({
    dir : workDir
});
var eventManager = new EventManager();
var options = {
    useVectorTiles : false,
    eventManager : eventManager,
    cache : tileCache,
    styleDir : workDir,
    projectLoader : projectLoader,
    tmpDir : tmpFileDir
};
var mapExport = new MapExport(options);
var dir = __dirname;
var baseProvider = new Tilepin.ProjectBasedTilesProvider(options);
options.provider = function(params, force) {
    return baseProvider;
};
function trace(options) {
    console.log(options.eventName, options.arguments);
}
eventManager.on('getTile:begin', trace);
eventManager.on('getTile:end', trace);
// eventManager.on('loadTileSource:begin', trace);
// eventManager.on('loadTileSource:end', trace);
// eventManager.on('loadTileSource:loadFromCache', trace);
// eventManager.on('loadTileSource:missedInCache', trace);
// eventManager.on('loadTileSource:setInCache', trace);
// eventManager.on('clearTileSource:clearCache', trace);

var tileProvider = new Tilepin.CachingTilesProvider(options);
baseProvider.setTopTilesProvider(tileProvider);

var promise = P();
promise = promise
//
.then(function initApplication(tileSource) {
    app.use(function(req, res, next) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        return next();
    });
    app.use(express.static(workDir + '/'));

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
        var conf = _.extend({}, req.query, {
            source : req.params.source,
            format : format,
            z : req.params.z,
            x : +req.params.x,
            y : +req.params.y,
        });
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

    mask = '/export/:source([^]+)/:zoom/' //
            + ':west,:south,:east,:north' //
            + '/:file.:format(svg|pdf|png)';
    app.get(mask, function(req, res) {
        var source = req.params.source;
        var format = req.params.format;
        var zoom = req.params.zoom;
        var file = req.params.file + '.' + format;
        var params = {
            source : source,
            format : format,
            zoom : zoom,
            west : req.params.west,
            south : req.params.south,
            east : req.params.east,
            north : req.params.north,
            file : file
        };
        return mapExport.generateMap(params).then(function(result) {
            sendReply(req, res, 200, result.file, result.headers);
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
