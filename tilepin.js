var _ = require('underscore');
var Path = require('path')
var Url = require('url');
var FS = require('fs');
var Crypto = require('crypto');

var Commons = require('./tilepin-commons');
var P = Commons.P;

var LRU = require('lru-cache');
var TileSourceManager = require('./tilepin-provider');

function TilesProvider(options) {
    this.options = options || {};
    this.cache = options.cache || new MemCache();
    this.provider = options.provider;
    this.tileSourceManager = new TileSourceManager(this.options);
    var eventManager = this._getEventManager();
    Commons.addEventTracing(this, [ 'invalidate', 'loadTile', 'loadInfo' ],
            eventManager);
}
_.extend(TilesProvider.prototype, Commons.Events, {

    invalidate : function(params) {
        var that = this;
        return that._getFormats(params).then(function(formats) {
            var sourceKey = that._getSourceKey(params);
            var resetAll = true;
            return P.all(_.map(formats, function(format) {
                var cacheKey = that._getCacheKey(params, format);
                if (cacheKey) {
                    resetAll = false;
                    return that.cache.reset(sourceKey, cacheKey);
                }
            })).then(function(result) {
                if (resetAll) {
                    return that.cache.reset(sourceKey);
                }
                return result;
            })
        }).then(function() {
            return that.tileSourceManager.clearTileSourceProvider(params);
        });
    },

    loadTile : function(params) {
        var that = this;
        var sourceKey = that._getSourceKey(params);
        var format = params.format;
        var cacheKey = that._getCacheKey(params, format);
        return that.cache.get(sourceKey, cacheKey).then(function(result) {
            if (result && !that._forceTileInvalidation(params))
                return result;
            return that._loadTileSource(params).then(function(tileSource) {
                return that._readTile(tileSource, params);
            }).then(function(result) {
                if (result.cache === false)
                    return result;
                return that.cache.set(sourceKey, cacheKey, result) // 
                .then(function() {
                    return result;
                });
            });
        });
    },

    loadInfo : function(params) {
        var that = this;
        return that._loadTileSource(params).then(function(tileSource) {
            return P.ninvoke(tileSource, 'getInfo');
        });
    },

    _getFormats : function(params) {
        var result = [ 'grid.json', 'png', 'vtile' ];
        if (params && _.isArray(params.formats)) {
            result = _.filter(result, function(format) {
                return _.contains(params.formats, format);
            })
        }
        return P(result);
    },

    _getSourceKey : function(params, suffix) {
        var key = params.source || '';
        if (suffix) {
            key += suffix;
        }
        return key;
    },
    _getTilesProvider : function(params, force) {
        var provider = this.options.provider || this.options.getProvider;
        if (_.isFunction(provider)) {
            provider = provider.call(this, params, force);
        }
        return P(provider);
    },
    _getEventManager : function() {
        var eventManager = this.options.eventManager || this;
        return eventManager;
    },
    _loadTileSource : function(params) {
        var that = this;
        return that.tileSourceManager.loadTileSourceProvider(params).then(
                function(provider) {
                    return provider.prepareTileSource(params);
                });
    },
    _forceTileInvalidation : function(params) {
        return !!params.reload;
    },
    _getCacheKey : function(params, prefix) {
        var x = +params.x;
        var y = +params.y;
        var zoom = +params.z;
        var array = [];
        _.each([ zoom, x, y ], function(n) {
            if (!_.isNaN(n)) {
                array.push(n);
            }
        })
        var key = array.join('-');
        if (array.length == 3 /* zoom, x, y */) {
            if (prefix && prefix != '')
                key = prefix + '-' + key;
        } else {
            key = undefined;
        }
        return key;
    },

    _readTile : function(tileSource, params) {
        var deferred = P.defer();
        try {
            var format = params.format;
            var z = params.z;
            var x = +params.x;
            var y = +params.y;
            var fn = format === 'grid.json' ? 'getGrid' : 'getTile';
            tileSource[fn](z, x, y, function(err, tile, headers) {
                if (err) {
                    deferred.reject(err);
                } else {
                    deferred.resolve({
                        tile : tile,
                        headers : headers
                    })
                }
            })
        } catch (e) {
            deferred.reject(e);
        }
        return deferred.promise;
    },

})

function MemCache(options) {
    this.options = options || {};
    this.cache = new LRU(this.options);
}
_.extend(MemCache.prototype, {
    reset : function(sourceKey, tileKey) {
        if (tileKey && tileKey != '') {
            var cache = this.cache.get(sourceKey);
            if (cache) {
                cache.del(tileKey);
            }
        } else {
            this.cache.del(sourceKey);
        }
        return P();
    },
    get : function(sourceKey, tileKey) {
        var cache = this.cache.get(sourceKey);
        var result = cache ? cache.get(tileKey) : undefined;
        return P(result);
    },
    set : function(sourceKey, tileKey, tile) {
        var cache = this.cache.get(sourceKey);
        if (!cache) {
            cache = new LRU(this.options);
            this.cache.set(sourceKey, cache);
        }
        return P(cache.set(tileKey, tile));
    },
})

module.exports = {
    TilesProvider : TilesProvider,
    MemCache : MemCache
}
