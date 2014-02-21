var express = require('express');
var Q = require('q');
var _ = require('underscore');
var app = express();
var Tilepin = require('../');
var TilepinRedisCache = require('../tilepin-cache-redis');

var port = 8888;
var projectsDir = './project';
var options = TilepinRedisCache.initTileServerCacheOptions({
    styleDir : projectsDir
});
var tileProvider = new Tilepin(options);

var promise = Q();
promise = promise
//
.then(function initApplication(tileSource) {
    app.configure(function() {
        app.use(function(req, res, next) {
            res.setHeader("Access-Control-Allow-Origin", "*");
            return next();
        });
        app.use(express.static(__dirname + '/'));
    });

    app.get('/tiles/invalidate/:source', function(req, res) {
        tileProvider.invalidateStyle({
            source : req.param('source')
        }).then(function(result) {
            sendReply(res, 200, 'OK');
        }).fail(function(err) {
            sendError(res, err);
        }).done();
    });

    app.get('/tiles/:source/:z/:x/:y.:format(png|grid.json)', function(req, res) {
        tileProvider.getTile({
            source : req.param('source'),
            format : req.param.format,
            z : req.params.z,
            x : +req.params.x,
            y : +req.params.y,
        }).then(function(result) {
            sendReply(res, 200, result.tile, result.headers);
        }).fail(function(err) {
            sendError(res, err);
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

function sendError(res, err) {
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
    sendReply(res, statusCode, errMsg, {});
}

function sendReply(res, statusCode, content, headers) {
    res.status(statusCode);
    _.each(headers, function(value, key) {
        res.setHeader(key, value);
    })
    res.send(content);
}
