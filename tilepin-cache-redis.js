var Path = require('path')
var FS = require('fs');
var P = require('./tilepin-commons').P;
var _ = require('underscore');
var LRU = require('lru-cache');
var Redis = require('redis');
var Zlib = require('zlib');

/**
 * 
 * @param options.keyPrefix
 *            prefix for all keys
 * @param options.redisClient -
 *            a Redis client to use
 * @param options.redis.port
 *            a Redis port (6379 by default); this parameter is used only if the
 *            options.redisClient is not defined
 * @param options.redis.host
 *            a Redis host ('127.0.0.1' by default); this parameter is used only
 *            if the options.redisClient is not defined
 */
function RedisCache(options) {
    this.options = options || {};
    var redisOptions = this.options.redis || {};
    if (this.options.redisClient) {
        this.client = this.options.redisClient;
    } else {
        this.client = RedisCache.newRedisClient(options)
    }
    this._valueToBuf = this.options.valueToBuf || this._valueToBuf;
    this._bufToValue = this.options.bufToValue || this._bufToValue;
}
_.extend(RedisCache.prototype, {
    open : function() {
        return P();
    },
    close : function() {
        client.quit();
        return P();
    },
    _invokeClient : function(method, args) {
        var deferred = P.defer();
        try {
            args.push(deferred.makeNodeResolver());
            method = this.client[method];
            method.apply(this.client, args);
        } catch (e) {
            deferred.reject(e);
        }
        return deferred.promise;
    },
    _invoke : function(method, sourceKey, tileArgs, headersArgs) {
        tileArgs = [ sourceKey ].concat(tileArgs);
        headersArgs = [ 'h:' + sourceKey ].concat(headersArgs);
        return P.all([ this._invokeClient(method, tileArgs),
                this._invokeClient(method, headersArgs) ]);
    },
    _convertJsonToBuffer : function(obj) {
        if (!obj)
            return P();
        return P.nfcall(Zlib.gzip, JSON.stringify(obj)).then(function(result) {
            return result;
        })
    },
    _convertBufferToJson : function(buf) {
        if (!buf)
            return P();
        return P.nfcall(Zlib.gunzip, buf).then(function(buf) {
            var str = buf.toString('utf8');
            var result = JSON.parse(str);
            return result;
        })
    },
    _isJson : function(headers) {
        if (!headers)
            return false;
        var str = headers['Content-Type'];
        var result = str.indexOf('text/javascript') >= 0
                || str.indexOf('application/json') >= 0;
        return result;
    },
    _toTile : function(tile, headers) {
        return {
            tile : tile,
            headers : headers
        }
    },
    reset : function(sourceKey, tileKey) {
        if (!tileKey || tileKey == '') {
            return this._invoke('del', sourceKey, [], []);
        } else {
            return this._invoke('hdel', sourceKey, [ tileKey ], [ tileKey ]);
        }
    },
    get : function(sourceKey, tileKey) {
        var that = this;
        return that._invoke('hget', sourceKey, [ tileKey ], [ tileKey ]).then(
                function(arr) {
                    var tileBlob = arr[0];
                    var headersBlob = arr[1];
                    if (!tileBlob || !headersBlob)
                        return null;
                    return that._convertBufferToJson(headersBlob).then(
                            function(headers) {
                                if (!that._isJson(headers)) {
                                    return that._toTile(tileBlob, headers);
                                }
                                return that._convertBufferToJson(tileBlob)
                                        .then(function(tile) {
                                            return that._toTile(tile, headers);
                                        });
                            })
                })
    },
    set : function(sourceKey, tileKey, tile) {
        var that = this;
        return that._convertJsonToBuffer(tile.headers).then(
                function(headersBlob) {
                    var promise;
                    if (!that._isJson(tile.headers)) {
                        promise = P(tile.tile);
                    } else {
                        promise = that._convertJsonToBuffer(tile.tile);
                    }
                    return promise.then(function(tileBlob) {
                        return that
                                ._invoke('hset', sourceKey,
                                        [ tileKey, tileBlob ],
                                        [ tileKey, headersBlob ]).then(
                                        function(arr) {
                                            var tilesOk = arr[0];
                                            var headersOk = arr[1];
                                            return tilesOk && headersOk;
                                        });
                    })
                })
    },
})

RedisCache.newRedisClient = function(options) {
    if (options.redisClient) {
        return options.redisClient;
    } else {
        var port = options.redisPort || 6379;
        var host = options.redisHost || '127.0.0.1';
        var redisOptions = _.extend({}, options, {
            return_buffers : true
        });
        return Redis.createClient(port, host, redisOptions);
    }
}

module.exports = RedisCache;
