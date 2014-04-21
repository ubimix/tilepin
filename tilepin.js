var _ = require('underscore');
var Path = require('path')
var Url = require('url');
var FS = require('fs');
var Crypto = require('crypto');

var Commons = require('./tilepin-commons');
var P = Commons.P;

var LRU = require('lru-cache');
var TileSourceProvider = require('./tilepin-provider');

function TilesProvider(options) {
    this.options = options || {};
}
_.extend(TilesProvider.prototype, Commons.Events, {
    invalidate : function(params) {
        return P();
    },
    loadTile : function(params) {
        return P(null);
    },
    loadInfo : function(params) {
        return P(null);
    },
    getFormats : function(params) {
        return P(this.options.formats || this.formats || []);
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
    }
})

/**
 * 
 * @param options.provider
 *            source of tiles
 * @param options.cache
 *            an implementation of a cache used to store cached objects
 * 
 */
function CachingTilesProvider(options) {
    this.options = options;
    this.cache = options.cache || new MemCache();
    this.provider = options.provider;
    Commons.addEventTracing(this, [ 'invalidate', 'loadTile', 'loadInfo' ]);
}
_.extend(CachingTilesProvider.prototype, TilesProvider.prototype, {

    invalidate : function(params) {
        var that = this;
        return that._getTilesProvider(params, false) //
        .then(function(provider) {
            return provider.invalidate(params).then(function() {
                return provider.getFormats(params);
            });
        })// 
        .then(function(formats) {
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
        });
    },
    loadTile : function(params) {
        var that = this;
        var sourceKey = that._getSourceKey(params);
        var format = params.format;
        var cacheKey = that._getCacheKey(params, format);
        return that.cache.get(sourceKey, cacheKey).then(function(result) {
            if (result)
                return result;
            return that._getTilesProvider(params, true) //
            .then(function(provider) {
                return provider.loadTile(params).then(function(result) {
                    return that.cache.set(sourceKey, cacheKey, result) // 
                    .then(function() {
                        return result;
                    });
                });
            });
        });
    },
    loadInfo : function(params) {
        return this._getTilesProvider(params, true).then(function(provider) {
            return provider.loadInfo(params);
        });
    },
    getFormats : function() {
        return this._getTilesProvider(params, true).then(function(provider) {
            return provider.getFormats();
        });
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
        if (key != '') {
            if (prefix && prefix != '')
                key = prefix + '-' + key;
        } else {
            key = undefined;
        }
        return key;
    }
})

function ProjectBasedTilesProvider(options) {
    this.options = options || {};
    var provider = new TileSourceProvider.TileMillSourceProvider(this.options);
    this.tileSourceProvider = TileSourceProvider.CachingTileSourceProvider
            .wrap(provider);
    Commons.addEventTracing(this, [ 'invalidate', 'loadTile', 'loadInfo' ]);
}
_.extend(ProjectBasedTilesProvider.prototype, TilesProvider.prototype, {

    invalidate : function(params) {
        return this.tileSourceProvider.clearTileSource(params);
    },

    loadTile : function(params) {
        var that = this;
        return that.tileSourceProvider.loadTileSource(params)
                .then(
                        function(tileSource) {
                            var deferred = P.defer();
                            try {
                                var format = params.format;
                                var z = params.z;
                                var x = +params.x;
                                var y = +params.y;
                                var fn = format === 'grid.json' ? 'getGrid'
                                        : 'getTile';
                                tileSource[fn](z, x, y, function(err, tile,
                                        headers) {
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
                        });
    },
    loadInfo : function(params) {
        var that = this;
        return that.tileSourceProvider.loadTileSource(params).then(
                function(tileSource) {
                    return P.ninvoke(tileSource, 'getInfo');
                });
    },
    getFormats : function(params) {
        var result = [ 'grid.json', 'png', 'vtile' ];
        if (params && _.isArray(params.formats)) {
            result = _.filter(result, function(format) {
                return _.contains(params.formats, format);
            })
        }
        return P(result);
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
    CachingTilesProvider : CachingTilesProvider,
    ProjectBasedTilesProvider : ProjectBasedTilesProvider,
    MemCache : MemCache
}
