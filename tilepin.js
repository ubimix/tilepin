var _ = require('underscore');
var Path = require('path')
var Url = require('url');
var FS = require('fs');
var Crypto = require('crypto');

var Q = require('q');
var Tilelive = require('tilelive');
var TileliveMapnik = require('tilelive-mapnik');
var VectorTile = require('tilelive-vector');
var TileBridge = require('tilelive-bridge');

var LRU = require('lru-cache');
var mercator = new (require('sphericalmercator'));
var CartoJsonCss = require('./carto-json-css');
var Carto = require('carto');
var AdmZip = require('adm-zip');
var TileSourceProvider = require('./tilepin-provider');

// Protocols registration
TileliveMapnik.registerProtocols(Tilelive);
VectorTile.registerProtocols(Tilelive);
// Register a fake protocol allowing to return the control to the renderer
Tilelive.protocols['tilepin:'] = function(options, callback) {
    callback(null, options.source);
};

function getTileCacheKey(params, prefix) {
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

/**
 * @param options.xml
 *            xml source of the project
 * @param options.base
 *            the project base directory
 * @param options.source
 *            the unique key of this tile source
 */
function VectorTileSource(options) {
    this.initialize(options);
}
_.extend(VectorTileSource.prototype, {
    initialize : function(options) {
        this.options = options || {};
        this.tileCache = options.tileCache || new MemCache();
    },
    clearTiles : function(params) {
        var that = this;
        var sourceKey = that._getKey();
        var key = getTileCacheKey(params, 'vtiles');
        if (!key) {
            return that.tileCache.reset(sourceKey);
        } else {
            return that.tileCache.reset(sourceKey, key);
        }
    },
    getTile : function(z, x, y, callback) {
        var that = this;
        var params = {
            x : x,
            y : y,
            z : z
        };
        var sourceKey = that._getKey();
        var cacheKey = getTileCacheKey(params, 'vtiles');
        return that.tileCache.get(sourceKey, cacheKey).then(
                function(buf) {
                    if (buf) {
                        return [ buf, JSON.stringify({
                            'Content-Type' : 'application/x-protobuf',
                            'Content-Encoding' : 'deflate'
                        }) ];
                    }
                    return that._loadTile(params).then(
                            function(result) {
                                var buf = result[0];
                                return that.tileCache.set(sourceKey, cacheKey,
                                        buf).then(function() {
                                    return result;
                                }) //
                            });
                }) //
        .then(function(result) {
            console.log(result);
            callback(null, result[0], result[1]);
        }, function(err) {
            console.log(err);
            callback(err);
        });
    },
    _getBridge : function() {
        var that = this;
        return Q().then(function() {
            if (that._bridge)
                return that._bridge;
            var deferred = Q.defer();
            try {
                new TileBridge(that.options, function(err, bridge) {
                    if (err) {
                        deferred.reject(err);
                    } else {
                        that._bridge = bridge;
                        deferred.resolve(that._bridge);
                    }
                });
            } catch (e) {
                deferred.reject(e);
            }
            return deferred.promise;
        });
    },
    _getKey : function() {
        if (!this._key) {
            this._key = this.options.source;
            if (!this._key) {
                var shasum = Crypto.createHash('sha1');
                console.log(this.options);
                shasum.update(this.options.xml);
                this._key = shasum.digest('hex');
            }
        }
        return this._key;
    },
    _loadTile : function(params) {
        var that = this;
        return that._getBridge().then(
                function(bridge) {
                    var deferred = Q.defer();
                    try {
                        bridge.getTile(params.z, params.x, params.y, function(
                                err, buf, meta) {
                            if (err) {
                                deferred.reject(err);
                            } else {
                                deferred.resolve([ buf, meta ]);
                            }
                        });
                    } catch (err) {
                        deferred.reject(err);
                    }
                    return deferred.promise;
                });
    },
    getInfo : function(callback) {
        return this._getBridge().then(function(bridge) {
            bridge.getInfo(callback);
        }).done();
    }
})

var TilesProvider = {
    invalidate : function(params) {
        return Q();
    },
    loadTile : function(params) {
        return Q(null);
    },
    loadInfo : function(params) {
        return Q(null);
    },
    getFormats : function(params) {
        return this.options.formats || this.formats || [];
    },
    _getSourceKey : function(params) {
        return params.source;
    },
}

function DispatchingTilesProvider(options) {
    this.options = options || {};
}
_.extend(DispatchingTilesProvider.prototype, TilesProvider, {
    invalidate : function(params) {
        return this._getTilesProvider(params, false).then(function(provider) {
            if (!provider)
                return false;
            return provider.invalidate();
        })
    },
    loadTile : function(params) {
        return this._getTilesProvider(params, true).then(function(provider) {
            if (!provider)
                return null;
            return provider.loadTile(params);
        })
    },
    loadInfo : function(params) {
        return this._getTilesProvider(params, true).then(function(provider) {
            if (!provider)
                return null;
            return provider.loadInfo(params);
        })
    },
    getFormats : function(params) {
        return this._getTilesProvider(params, true).then(function(provider) {
            if (!provider)
                return null;
            return provider.getFormats(params);
        })
    },
    _getTilesProvider : function(params, force) {
        return this.options.getProvider.call(this, params, force);
    }
});

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
}
_.extend(CachingTilesProvider.prototype, TilesProvider, {

    invalidate : function(params) {
        var that = this;
        return this.provider.getFormats(params).then(function(formats) {
            var sourceKey = that._getSourceKey(params);
            var resetAll = true;
            return Q.all(_.map(formats, function(format) {
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
            return that.provider.loadTile(params).then(function(result) {
                return that.cache.set(sourceKey, cacheKey, result) // 
                .then(function() {
                    return result;
                });
            });
        });
    },
    loadInfo : function(params) {
        return this.provider.loadInfo(params);
    },
    getFormats : function() {
        return this.provider.getFormats();
    },
    _getCacheKey : function(params, format) {
        return getTileCacheKey(params, format);
    }

})

function ProjectBasedTilesProvider(options) {
    this.options = options || {};
    this.tileSourceProvider = new TileSourceProvider.TileMillProvider(
            this.options);
    this.sourceCache = new LRU({
        maxAge : this._getTileSourceCacheTTL()
    });
}
_.extend(ProjectBasedTilesProvider.prototype, TilesProvider, {

    invalidate : function(params) {
        var promises = [];
        promises.push(this.tileSourceProvider.clearTileSource(params));
        var sourceKey = this._getSourceKey(params);
        if (sourceKey) {
            this.sourceCache.del(sourceKey);
        }
        return Q.all(promises);
    },
    loadTile : function(params) {
        return this._getTileSource(params).then(function(tileSource) {
            var deferred = Q.defer();
            try {
                var format = params.format;
                var z = params.z;
                var x = +params.x;
                var y = +params.y;
                var fn = format === 'grid' ? 'getGrid' : 'getTile';
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
        });
    },
    loadInfo : function(params) {
        return this.provider.loadInfo(params);
    },
    getFormats : function() {
        return [ 'grid', 'tile', 'vtile' ];
    },
    _getTileSourceCacheTTL : function() {
        return this.options.tileSourceCacheTTL || 60 * 60 * 1000;
    },
    _loadTileSource : function(params) {
        var that = this;
        return that.tileSourceProvider.loadTileSource(params).then(
                function(uri) {
                    uri.protocol = 'mapnik:';
                    return Q.ninvoke(Tilelive, 'load', uri);
                });
    },
    _getTileSource : function(params) {
        var that = this;
        var sourceKey = that._getSourceKey(params);
        return Q().then(function() {
            var tileSource = that.sourceCache.get(sourceKey);
            if (tileSource) {
                return tileSource;
            }
            // Load tileSource and set it in the cache
            return that._loadTileSource(params).then(function(tileSource) {
                that.sourceCache.set(sourceKey, tileSource);
                return tileSource;
            });
        })
    }
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
        return Q();
    },
    get : function(sourceKey, tileKey) {
        var cache = this.cache.get(sourceKey);
        var result = cache ? cache.get(tileKey) : undefined;
        return Q(result);
    },
    set : function(sourceKey, tileKey, tile) {
        var cache = this.cache.get(sourceKey);
        if (!cache) {
            cache = new LRU(this.options);
            this.cache.set(sourceKey, cache);
        }
        return Q(cache.set(tileKey, tile));
    },
})

module.exports = {
    TilesProvider : TilesProvider,
    DispatchingTilesProvider : DispatchingTilesProvider,
    CachingTilesProvider : CachingTilesProvider,
    ProjectBasedTilesProvider : ProjectBasedTilesProvider,
    MemCache : MemCache
}
