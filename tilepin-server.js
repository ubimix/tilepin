var express = require('express');
var Tilepin = require('./lib/');
var _ = require('underscore');
var app = express();
var Url = require('url');
var FS = require('fs');
var Path = require('path');
var tp = require('./tilepin');
var tpCache = require('./tilepin-cache-redis');
var MapExport = require('./tilepin-export');
var events = require('events');

var workDir = process.cwd();
var config = loadConfig(workDir, [ 'tilepin.config.js', 'tilepin.config.json',
        'config.js', 'config.json' ]);

var port = config.port || 8888;

var redisOptions = config.redisOptions || {};
var tileCache = new tpCache(redisOptions);

var tmpFileDir = Path.join(workDir, 'tmp');
var eventEmitter = new events.EventEmitter();
var options = {
    eventEmitter : eventEmitter, // Centralized event manager
    cache : tileCache, // Redis cache
    dir : workDir, // Working directory containing map layers
    tmpDir : tmpFileDir, // Used to generate PDF/SVG maps
    handleDatalayer : function(options) {
        var dataLayer = options.dataLayer;
        if (dataLayer.Datasource && dataLayer.Datasource.type == 'postgis') {
            var db = config.db || {};
            if (_.isFunction(db)) {
                db.call(config, options);
            } else {
                var projectConf = options.config;
                var sourceKey = options.params.source;
                var dbParams = db[sourceKey];
                _.extend(dataLayer.Datasource, dbParams);
            }
        }
    }
};
var mapExport = new MapExport(options);
var dir = __dirname;

function trace(options) {
    console.log(options.eventName, options.arguments);
}
eventEmitter.on('getTile:begin', trace);
eventEmitter.on('getTile:end', trace);
// eventEmitter.on('loadTileSource:begin', trace);
// eventEmitter.on('loadTileSource:end', trace);
// eventEmitter.on('loadTileSource:loadFromCache', trace);
// eventEmitter.on('loadTileSource:missedInCache', trace);
// eventEmitter.on('loadTileSource:setInCache', trace);
// eventEmitter.on('clearTileSource:clearCache', trace);

var tileProvider = new tp.TilesProvider(options);

var promise = Tilepin.P();
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
    app.get(mask, handleRequest(function(req, res) {
        var formats = req.query['formats'];
        if (formats) {
            formats = formats.split(/[,;]/gim)
        } else {
            formats = undefined;
        }
        return tileProvider.invalidate({
            formats : formats,
            source : req.param('source')
        }).then(function(result) {
            sendReply(req, res, 200, 'OK');
        });
    }));

    mask = '/tiles/:source([^]+)/:z/:x/:y.:format(png|grid.json|vtile)';
    app.get(mask, handleRequest(function(req, res) {
        var format = req.params.format;
        var conf = _.extend({}, req.query, {
            source : req.params.source,
            format : format,
            z : req.params.z,
            x : +req.params.x,
            y : +req.params.y,
        });
        return tileProvider.loadTile(conf).then(function(result) {
            sendReply(req, res, 200, result.tile, result.headers);
        });
    }));

    mask = '/tiles/:source([^]+)';
    app.get(mask, handleRequest(function(req, res) {
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
        return tileProvider.loadInfo(options).then(function(result) {
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
        });
    }));

    mask = '/export/:source([^]+)/:zoom/' //
            + ':west,:south,:east,:north' //
            + '/:file.:format(svg|pdf|png)';
    app.get(mask, handleRequest(function(req, res) {
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
            return sendReply(req, res, 200, result.file, result.headers);
        });
    }));

    mask = '/service/:source([^]+)/.:service([^]+)';
    app.get(mask, handleRequest(function(req, res) {
        var source = req.params.source;
        var service = req.params.service;
        var params = {
            source : source,
            service : service
        };
        // * Load config corresponding to the specified source
        // * Load an endpoint description for the specified service
        // * Pre-process query for specified parameters
        // * Launch the query and return results
        return mapExport.generateMap(params).then(function(result) {
            return sendReply(req, res, 200, result.file, result.headers);
        });
    }));

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
    Tilepin.P().then(function() {
        app.close();
    }).then(function() {
        return tileProvider.close();
    }).then(function() {
        console.log("Server is down.");
    }).done();
});

function handleRequest(action) {
    return function(req, res) {
        return Tilepin.P().then(function() {
            return action(req, res);
        }).then(null, function(err) {
            sendError(req, res, err);
        }).done();
    }
}

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
            headers['Content-Type'] = 'application/javascript; charset=utf-8';
        }
        var str;
        if (Buffer.isBuffer(content)) {
            str = content.toString();
        } else {
            str = JSON.stringify(content, null, 2);
        }
        content = callback + '(' + str + ');'
    }
    _.each(headers, function(value, key) {
        res.setHeader(key, value);
    })
    res.send(content);
}

function loadConfig(workDir, configFiles) {
    var file = Tilepin.IO.findExistingFile(_.map(configFiles, function(file) {
        return Path.join(workDir, file);
    }));
    if (!file)
        return {};
    return Tilepin.IO.loadObject(file);
}
