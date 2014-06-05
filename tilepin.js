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
    this.tileSourceManager = new TileSourceManager(this.options);
    var eventManager = this._getEventManager();
    Commons.addEventTracing(this, [ 'invalidate', 'loadTile', 'loadInfo' ],
            eventManager);
}
_.extend(TilesProvider.prototype, Commons.Events, {

    invalidate : function(params) {
        var that = this;
        var sourceKey = that._getSourceKey(params);
        var resetAll = true;
        var cacheKeys = [];
        return P().then(function() {
            return that.tileSourceManager //
            .loadTileSourceProvider(params) //
            .then(function(provider) {
                return that._getFormats(params).then(function(formats) {
                    return P.all(_.map(formats, function(format) {
                        var cacheKey = provider.getCacheKey(params, format);
                        cacheKeys.push(cacheKey);
                    }));
                });
            });
        }).then(function() {
            return P.all([ invalidateCache(), clearTileSourceProvider() ]);
        }, function(err) {
            return P.all([ invalidateCache(), clearTileSourceProvider() ]);
            throw err;
        });
        function invalidateCache() {
            if (cacheKeys.length) {
                return P.all(_.map(cacheKeys, function(cacheKey) {
                    return that.cache.reset(sourceKey, cacheKey);
                }));
            } else {
                return that.cache.reset(sourceKey);
            }
        }
        function clearTileSourceProvider() {
            return that.tileSourceManager.clearTileSourceProvider(params);
        }
    },

    loadTile : function(params) {
        var that = this;
        function loadNonCached(provider, params) {
            return provider.prepareTileSource(params) // 
            .then(function(tileSource) {
                return that._readTile(tileSource, params);
            })
        }
        function loadCached(provider, params) {
            var sourceKey = that._getSourceKey(params);
            var format = params.format;
            var cacheKey = provider.getCacheKey(params, format);
            return that.cache.get(sourceKey, cacheKey).then(function(result) {
                if (result && !that._forceTileInvalidation(params))
                    return result;
                return loadNonCached(provider, params).then(function(result) {
                    return that.cache.set(sourceKey, cacheKey, result) // 
                    .then(function() {
                        return result;
                    });
                });
            })
        }
        return that.tileSourceManager.loadTileSourceProvider(params).then(
                function(provider) {
                    // TODO: replace it by caching timeout
                    if (!provider.isDynamicSource()) {
                        return loadCached(provider, params);
                    } else {
                        return loadNonCached(provider, params);
                    }
                });
    },

    loadInfo : function(params) {
        var that = this;
        return that.tileSourceManager.loadTileSourceProvider(params) //
        .then(function(provider) {
            return provider.prepareTileSource(params);
        }).then(function(tileSource) {
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
    _getEventManager : function() {
        var eventManager = this.options.eventManager || this;
        return eventManager;
    },
    _forceTileInvalidation : function(params) {
        return !!params.reload;
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
});

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
