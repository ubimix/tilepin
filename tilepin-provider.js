/**
 * This module contains utility methods used to load and prepare TileMill
 * projects as a source of tiles
 */
var _ = require('underscore');
var Path = require('path')
var Url = require('url');
var FS = require('fs');
var Crypto = require('crypto');
var Http = require('http');

var Commons = require('./tilepin-commons');
var P = Commons.P;

var CartoJsonCss = require('./carto-json-css');
var Carto = require('carto');
var AdmZip = require('adm-zip');
var LRU = require('lru-cache');

var Tilelive = require('tilelive');
var TileliveMapnik = require('tilelive-mapnik');
var VectorTile = require('tilelive-vector');
var TileBridge = require('tilelive-bridge');
var TileMillProjectLoader = require('./tilepin-loader');

// Protocols registration
TileliveMapnik.registerProtocols(Tilelive);
VectorTile.registerProtocols(Tilelive);
// Register a fake protocol allowing to return the control to the renderer
Tilelive.protocols['tilepin:'] = function(options, callback) {
    callback(null, options.source);
};

function TileSourceProvider() {
    if (_.isFunction(this.initialize)) {
        this.initialize.apply(this, arguments);
    }
}
TileSourceProvider.TILE_TYPES = [ 'vtiles', 'rendered' ];
_.extend(TileSourceProvider.prototype, Commons.Events, {

    traceWrap : Commons.traceWrap,

    initialize : function(options) {
        this.options = options;
    },

    /* ------------------------------ */
    // Methods to re-define in sub-classes.
    /** Loads and returns a promise for a tile source */
    loadTileSource : function(params) {
        return P();
    },
    /** Cleans up a tile source corresponding to the specified parameters */
    clearTileSource : function(params) {
        return P();
    },

    /* ------------------------------ */
    /** Returns all possible types of tile sources supported by this provider */
    getAllTileSourceTypes : function(params) {
        return TileSourceProvider.TILE_TYPES;
    },
    isVectorSourceType : function(params) {
        var format = params.format;
        return format == 'vtile' || format == 'pbf'
    },
    /**
     * Returns a type of sources corresponding to the format parameter in the
     * given arguments.
     */
    getTileSourceType : function(params) {
        if (this.isVectorSourceType(params)) {
            return TileSourceProvider.TILE_TYPES[0];
        } else {
            return TileSourceProvider.TILE_TYPES[1];
        }
    },
});

TileSourceProvider.CachingTileSourceProvider = CachingTileSourceProvider;
TileSourceProvider.TileMillSourceProvider = TileMillSourceProvider;

/* -------------------------------------------------------------------------- */
/**
 * 
 */
function CachingTileSourceProvider() {
    TileSourceProvider.apply(this, arguments);
}
_.extend(CachingTileSourceProvider.prototype, TileSourceProvider.prototype);
_.extend(CachingTileSourceProvider.prototype, {

    initialize : function(options) {
        this.options = options || {};
        this.sourceCache = new LRU({
            maxAge : this._getTileSourceCacheTTL()
        });
    },
    loadTileSource : function(params) {
        var that = this;
        return that.traceWrap('loadTileSource', params, P().then(function() {
            var sourceType = that.getTileSourceType(params);
            var sourceKey = that._getSourceCacheKey(params, sourceType);
            var tileSource = that.sourceCache.get(sourceKey);
            if (tileSource) {
                return tileSource;
            }
            var index = that._sourceLoadingIndex || {};
            that._sourceLoadingIndex = index;
            var promise = index[sourceKey];
            if (!promise) {
                promise = index[sourceKey] = P().then(function() {
                    return that.getTileSourceProvider().loadTileSource(params);
                }).fin(function() {
                    delete index[sourceKey];
                });
            }
            return promise.then(function(tileSource) {
                that.sourceCache.set(sourceKey, tileSource);
                return tileSource;
            });
        }));
    },
    clearTileSource : function(params) {
        var that = this;
        return that.traceWrap('clearTileSource', params, P().then(
                function() {
                    var promises = [];
                    _.each(this.getAllTileSourceTypes(), function(type) {
                        promises.push(P().then(
                                function() {
                                    var sourceKey = that._getSourceCacheKey(
                                            params, type);
                                    var source = that.sourceCache
                                            .get(sourceKey);
                                    that.sourceCache.del(sourceKey);
                                    if (source && _.isFunction(source.close)) {
                                        return P.ninvoke(source, 'close');
                                    }
                                }).then(
                                function() {
                                    return that.getTileSourceProvider()
                                            .clearTileSource(params);
                                }));
                    })
                    return P.all(promises);
                }));
    },
    /** Returns the underlying tilesource provider */
    getTileSourceProvider : function() {
        return this.options.tileSourceProvider;
    },
    /** Sets a new underlying tilesource provider returning tilesources to cache. */
    setTileSourceProvider : function(provider) {
        this.options.tileSourceProvider = provider;
    },
    _getTileSourceCacheTTL : function() {
        return this.options.tileSourceCacheTTL || 60 * 60 * 1000;
    },
    /**
     * An internal method returning a cache key for the source defined in the
     * parameters.
     */
    _getSourceCacheKey : function(params, sourceType) {
        var key = params.source || '';
        key += '-' + sourceType;
        return key;
    },
})

/* -------------------------------------------------------------------------- */
/**
 * This provider uses TileMill projects to create tile sources.
 */
function TileMillSourceProvider() {
    TileSourceProvider.apply(this, arguments);
}
_.extend(TileMillSourceProvider.prototype, TileSourceProvider.prototype);
_.extend(TileMillSourceProvider.prototype, {
    initialize : function(options) {
        this.options = options || {};
        this.projectLoader = new TileMillProjectLoader(options);
    },
    loadTileSource : function(params) {
        var that = this;
        return that.traceWrap('loadTileSource', params, P().then(function() {
            var sourceKey = params.source;
            var sourceType = that.getTileSourceType(params);
            return P().then(function() {
                var index = that._sourceLoadingIndex || {};
                that._sourceLoadingIndex = index;
                var promise = index[sourceKey];
                if (!promise) {
                    promise = index[sourceKey] = P().then(function() {
                        if (that.isVectorSourceType(params)) {
                            return that._newTileBridgeSource(params);
                        } else {
                            return that._newTileliveSource(params);
                        }
                    }).fin(function() {
                        delete index[sourceKey];
                    });
                }
                return promise
            });
        }));
    },
    clearTileSource : function(params) {
        return that.traceWrap('clearTileSource', params, P().then(function() {
            return this.projectLoader.clearProject(params);
        }));
    },
    _getTopTileSourceProvider : function(params) {
        return this.options.provider || this;
    },
    _setTopTileSourceProvider : function(provider) {
        this.options.provider = provider;
    },
    _getVectorTilesUri : function(params, uri) {
        if (uri.vectorTilesUrl)
            return uri.vectorTilesUrl;
        if (params.vectorTilesUrl)
            return params.vectorTilesUrl;
        return undefined;
    },
    _replaceVtilesProjection : function(str) {
        if (!str)
            return str;
        return str.replace(/srs=".*?"/gim, function(match) {
            return 'srs="+proj=merc ' + '+a=6378137 +b=6378137 '
                    + '+lat_ts=0.0 +lon_0=0.0 ' + '+x_0=0.0 +y_0=0.0 +k=1.0 '
                    + '+units=m +nadgrids=@null ' + '+wktext +no_defs +over"';
        });
    },
    _getTileSourceConfig : function(params) {
        return this.projectLoader.loadProject(params);
    },
    _newTileliveSource : function(params) {
        var that = this;
        return that._getTileSourceConfig(params).then(function(uri) {
            var vectorTilesUrl = that._getVectorTilesUri(params, uri);
            if (vectorTilesUrl) {
                var provider = that._getTopTileSourceProvider(params);
                return provider.loadTileSource(_.extend({}, params, {
                    format : 'vtile'
                })).then(function(vtileSource) {
                    var tilesUri = _.extend({}, uri, {
                        protocol : 'vector:',
                        source : {
                            protocol : 'tilepin:',
                            source : vtileSource
                        }
                    });
                    tilesUri.xml = that._replaceVtilesProjection(tilesUri.xml);
                    return P.ninvoke(Tilelive, 'load', tilesUri);
                });
            } else {
                var url = _.extend({}, uri, {
                    protocol : 'mapnik:'
                });
                return P.ninvoke(Tilelive, 'load', url);
                // var url = 'mapnik://' + uri.path;
                // return P.ninvoke(Tilelive, 'load', url);
            }
        });
    },

    _newTileBridgeSource : function(params, uri) {
        var that = this;
        return that._getTileSourceConfig(params).then(function(uri) {
            var deferred = P.defer();
            try {
                new TileBridge(uri.path, function(err, bridge) {
                    if (err) {
                        deferred.reject(err);
                    } else {
                        deferred.resolve(bridge);
                    }
                });
            } catch (e) {
                deferred.reject(e);
            }
            return deferred.promise;
        });
    }
// var sourceType = this.getTileSourceType(params);
})

module.exports = TileSourceProvider;
