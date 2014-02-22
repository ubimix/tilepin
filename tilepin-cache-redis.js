var Path = require('path')
var FS = require('fs');
var Q = require('q');
var _ = require('underscore');
var LRU = require('lru-cache');
var Redis = require('redis');

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
        return Q();
    },
    close : function() {
        client.quit();
        return Q();
    },
    _invokeClient : function(method, args) {
        var deferred = Q.defer();
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
        return Q.all([ this._invokeClient(method, tileArgs),
                this._invokeClient(method, headersArgs) ]);
    },
    _convertJsonToBuffer : function(obj) {
        if (!obj)
            return null;
        var result = new Buffer(JSON.stringify(obj), 'utf8')
        return result;
    },
    _convertBufferToJson : function(buf) {
        if (!buf)
            return null;
        var str = buf.toString('utf8');
        var result = JSON.parse(str);
        return result;
    },
    _isJson : function(headers) {
        return headers
                && headers['Content-Type'] == 'text/javascript; charset=utf-8';
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
        return that._invoke('hget', sourceKey, [ tileKey ], [ tileKey ])
                .spread(function(tileBlob, headersBlob) {
                    if (!tileBlob || !headersBlob)
                        return null;
                    var headers = that._convertBufferToJson(headersBlob);
                    var tile = tileBlob;
                    if (that._isJson(headers)) {
                        tile = that._convertBufferToJson(tileBlob);
                    }
                    return {
                        tile : tile,
                        headers : headers
                    };
                })
    },
    set : function(sourceKey, tileKey, tile) {
        var that = this;
        var headersBlob = that._convertJsonToBuffer(tile.headers);
        var tileBlob = tile.tile;
        if (that._isJson(tile.headers)) {
            tileBlob = that._convertJsonToBuffer(tile.tile);
        }
        return that._invoke('hset', sourceKey, [ tileKey, tileBlob ],
                [ tileKey, headersBlob ]).spread(function(tilesOk, headersOk) {
            return tilesOk && headersOk;
        });
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
