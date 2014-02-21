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
 * @param options.redis.client -
 *            a Redis client to use OR
 * @param options.redis.port
 *            a Redis port (6379 by default)
 * @param options.redis.host
 *            a Redis host ('127.0.0.1' by default)
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
    _invokeClient : function(method, id) {
        var deferred = Q.defer();
        try {
            var args = _.toArray(arguments);
            args.splice(0, 2);
            args = _.toArray(id).concat(args);
            args.push(deferred.makeNodeResolver());
            if (_.isString(method)) {
                method = this.client[method];
            }
            method.apply(this.client, args);
        } catch (e) {
            deferred.reject(e);
        }
        return deferred.promise;
    },
    _getKey : function(key) {
        var prefix = this.options.keyPrefix || '';
        key = _.toArray(key);
        var id = prefix + key[0];
        key.splice(0, 1);
        var result = [id];
        if (key.length){
            result.push(key.join('/'));
        }
        return result;
    },
    _valueToBuf : function(value) {
        if (!value)
            return null;
        return new Buffer(JSON.stringify(value), 'utf8');
    },
    _bufToValue : function(buf) {
        if (!buf)
            return null;
        var str = buf.toString();
        return JSON.parse(str);
    },
    reset : function(key) {
        var id = this._getKey(key);
        if (id.length == 1) {
            return this._invokeClient('del', id);
        } else {
            return this._invokeClient('hdel', id);
        }
    },
    get : function(key) {
        var that = this;
        var id = that._getKey(key);
        return that._invokeClient('hget', id).then(function(buf) {
            return that._bufToValue(buf);
        });
    },
    set : function(key, value) {
        var that = this;
        var id = that._getKey(key);
        var buf = that._valueToBuf(value);
        return that._invokeClient('hset', id, buf);
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

RedisCache.initTileServerCacheOptions = function(options) {
    var redisClient = RedisCache.newRedisClient(options)
    return _.extend({}, options, {
        tileCache : new RedisCache({
            redisClient : redisClient,
            keyPrefix : 'tiles:',
            valueToBuf : function(value) {
                if (value && !Buffer.isBuffer(value)) {
                    value = new Buffer(value);
                }
                return value;
            },
            bufToValue : function(buf) {
                if (buf && !Buffer.isBuffer(buf)) {
                    buf = new Buffer(buf);
                }
                return buf;
            }
        }),
        headersCache : new RedisCache({
            redisClient : redisClient,
            keyPrefix : 'headers:'
        })
    })
}

module.exports = RedisCache;
