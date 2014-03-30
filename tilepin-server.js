var express = require('express');
var Q = require('q');
var _ = require('underscore');
var app = express();
var Tilepin = require('./tilepin');
var TilepinCache = require('./tilepin-cache-redis');
// var TilepinCache = require('./tilepin-cache-mbtiles');

var port = 8888;
var redisOptions = {};
var tileCache = new TilepinCache(redisOptions);
var workdir = process.cwd();
var options = {
    tileCache : tileCache,
    styleDir : workdir
};
// options = {};

var dir = __dirname;
var baseProvider = new Tilepin.ProjectBasedTilesProvider(options);
var tileProvider = new Tilepin.CachingTilesProvider({
    provider : baseProvider
});

var promise = Q();
promise = promise
//
.then(function initApplication(tileSource) {
    app.configure(function() {
        app.use(function(req, res, next) {
            res.setHeader("Access-Control-Allow-Origin", "*");
            return next();
        });
        app.use(express.static(workdir + '/'));
    });

    var mask = '/tiles/invalidate/:source([^]+)'
    app.get(mask, function(req, res) {
        tileProvider.invalidate({
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
        if (format == 'grid.json') {
            format = 'grid';
        }
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
    Q().then(function() {
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
    res.status(statusCode);
    _.each(headers, function(value, key) {
        res.setHeader(key, value);
    })
    var callback = req.query.callback;
    if (callback == '')
        callback = null;
    if (callback && !Buffer.isBuffer(content)) {
        res.send(callback + '(' + JSON.stringify(content) + ');');
    } else {
        res.send(content);
    }
}
