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
        this.tileCache = options.tileCache || new CachingTiles.MemCache();
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

/**
 * 
 * @param options.styleDir -
 *            root directory with styles; each style folder has to contain a
 *            'project.mml' file.t
 * @param options.tileSourceCacheTTL -
 *            cache time to live (in milliseconds) for each instantiated
 *            tilesource
 * @param options.tileCache
 *            an implementation of a cache used to store cached objects
 * 
 */
function CachingTiles(options) {
    this.options = options;
    this.sourceCache = new LRU({
        maxAge : this._getTileSourceCacheTTL()
    });
    this.tileCache = options.tileCache || new CachingTiles.MemCache();
    this.vectorTileCache = options.vectorTileCache
            || new CachingTiles.MemCache();
    this._tileSourceProvider = new TileSourceProvider.TileMillProvider(
            this.options);
}
_.extend(CachingTiles.prototype, {

    invalidateStyle : function(params) {
        var that = this;
        var sourceKey = params.source;
        function clearTileCache() {
            var cacheKey = that._getTileCacheKey(params, 'tile');
            if (!cacheKey) {
                return that.tileCache.reset(sourceKey);
            } else {
                return that.tileCache.reset(sourceKey, cacheKey).then(
                        function() {
                            var cacheKey = that
                                    ._getTileCacheKey(params, 'grid');
                            return that.tileCache.reset(sourceKey, cacheKey);
                        });
            }
        }
        function clearSourceCache() {
            var tileSource = that.sourceCache.get(sourceKey);
            that.sourceCache.del(sourceKey)
            if (tileSource) {
                return Q.ninvoke(tileSource, 'close');
            }
            return Q();
        }
        function clearTileSource() {
            return that._tileSourceProvider.clearTileSource(params);
        }
        function clearVectorTileSource() {
            return that._getVectorTileSource(params).then(function(tileSource) {
                if (tileSource) {
                    return tileSource.clearTiles(params);
                }
            });
        }
        return Q
                .all(
                        [ clearTileCache(), clearSourceCache(),
                                clearVectorTileSource() ]).then(function() {
                    return clearTileSource();
                });
    },

    getTile : function(params) {
        var that = this;
        var sourceKey = params.source;
        var format;
        if (params.format && params.format != '') {
            format = params.format === 'grid.json' ? 'grid' : 'tile';
        }
        var cacheKey = that._getTileCacheKey(params, format);
        return that.tileCache.get(sourceKey, cacheKey).then(function(result) {
            console.log('WTF?', sourceKey, cacheKey, result)
            if (result)
                return result;
            return that.loadTile(params).then(function(result) {
                return that.tileCache.set(sourceKey, cacheKey, result) //
                .then(function() {
                    return result;
                });
            });
        });
    },

    loadTile : function(params) {
        return this._getTileSource(params).then(function(tileSource) {
            var deferred = Q.defer();
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
        });
    },

    close : function() {
        this.sourceCache.reset();
        var array = [];
        if (this.tileCache.close)
            array.push(this.tileCache.close());
        return Q(array);
    },

    _getTileCacheKey : getTileCacheKey,

    _getVectorTileSource : function(params) {
        var that = this;
        return Q().then(
                function() {
                    var sourceKey = params.source;
                    if (!that._vectorTileSources) {
                        that._vectorTileSources = {};
                    }
                    var result = that._vectorTileSources[sourceKey];
                    if (result) {
                        return result;
                    }
                    return that._tileSourceProvider.loadTileSource(params)
                            .then(function(options) {
                                options.source = sourceKey;
                                result = new VectorTileSource(options);
                                that._vectorTileSources[sourceKey] = result;
                                return result;
                            });
                })
    },

    _getTileSourceCacheTTL : function() {
        return this.options.tileSourceCacheTTL || 60 * 60 * 1000;
    },

    _loadTileSource : function(params) {
        var that = this;
        return that._getVectorTileSource(params).then(
                function(vectorTileSource) {
                    return that._tileSourceProvider.loadTileSource(params)
                            .then(function(options) {
                                var uri = _.extend(options, {
                                    protocol : 'vector:',
                                    source : {
                                        protocol : 'tilepin:',
                                        source : vectorTileSource
                                    }
                                });
                                return Q.ninvoke(Tilelive, 'load', uri);
                            });
                });
    },
    _getTileSource : function(params) {
        var that = this;
        var sourceKey = params.source;
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
    },
})
CachingTiles.MemCache = function(options) {
    this.options = options || {};
    this.cache = new LRU(this.options);
}
_.extend(CachingTiles.MemCache.prototype, {
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

module.exports = CachingTiles;
