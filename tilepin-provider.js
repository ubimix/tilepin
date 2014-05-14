/**
 * This module contains utility methods used to load and prepare TileMill
 * projects as a source of tiles
 */
var _ = require('underscore');
var Path = require('path');
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
var extensions = [ 'tilelive-mapnik', 'tilelive-vector', 'tilelive-bridge',
        'tilejson' ];
_.each(extensions, function(extension) {
    (require(extension)).registerProtocols(Tilelive);
});

var TileMillProjectLoader = require('./tilepin-loader');

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

    type : 'TileSourceProvider',

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

    _getSourceKey : function(params) {
        return params.source || '';
    },

    _setSourceKey : function(params, source) {
        return _.extend({}, params, {
            source : source
        })
    },

    _getEventManager : function() {
        var eventManager = this.options.eventManager || this;
        return eventManager;
    }
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

    type : 'CachingTileSourceProvider',

    initialize : function(options) {
        this.options = options || {};
        this.sourceCache = new LRU({
            maxAge : this._getTileSourceCacheTTL()
        });
        var eventManager = this._getEventManager();
        Commons.addEventTracing(this, [ 'loadTileSource', 'clearTileSource' ],
                eventManager);
    },

    loadTileSource : function(params) {
        var that = this;
        var eventManager = that._getEventManager();
        return P().then(function() {
            var sourceType = that.getTileSourceType(params);
            var sourceKey = that._getSourceCacheKey(params, sourceType);
            var tileSource = that.sourceCache.get(sourceKey);
            if (tileSource) {
                eventManager.fire('loadTileSource:loadFromCache', {
                    eventName : 'loadTileSource:loadFromCache',
                    arguments : [ params ],
                    tileSource : tileSource
                });
                return tileSource;
            }
            eventManager.fire('loadTileSource:missedInCache', {
                eventName : 'loadTileSource:missedInCache',
                arguments : [ params ]
            });
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
                eventManager.fire('loadTileSource:setInCache', {
                    eventName : 'loadTileSource:setInCache',
                    arguments : [ params ],
                    tileSource : tileSource
                });
                that.sourceCache.set(sourceKey, tileSource);
                return tileSource;
            });
        });
    },
    clearTileSource : function(params) {
        var that = this;
        return P().then(function() {
            var promises = [];
            var types = that.getAllTileSourceTypes();
            _.each(types, function(type) {
                var p = P().then(function() {
                    var sourceKey = that._getSourceCacheKey(params, type);
                    var source = that.sourceCache.get(sourceKey);
                    var eventManager = that._getEventManager();
                    var eventName = 'clearTileSource:clearCache';
                    eventManager.fire(eventName, {
                        eventName : eventName,
                        arguments : [ params ],
                        type : type,
                        result : source
                    });
                    that.sourceCache.del(sourceKey);
                }).then(function() {
                    var provider = that.getTileSourceProvider();
                    return provider.clearTileSource(params);
                });
                promises.push(p);
            })
            return P.all(promises);
        });
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
        var key = this._getSourceKey(params);
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

    type : 'TileMillSourceProvider',

    initialize : function(options) {
        this.options = options || {};
        this.projectLoader = this.options.projectLoader
                || new TileMillProjectLoader(this.options);
        var eventManager = this._getEventManager();
        Commons.addEventTracing(this, [ 'loadTileSource', 'clearTileSource' ],
                eventManager);
    },
    loadTileSource : function(params) {
        var that = this;
        return P().then(function() {
            var sourceKey = that._getSourceKey(params);
            return P().then(function() {
                var promiseKey = sourceKey + '-' + params.format;
                var index = that._sourceLoadingIndex || {};
                that._sourceLoadingIndex = index;
                var promise = index[promiseKey];
                if (!promise) {
                    promise = index[promiseKey] = P().then(function() {
                        return that._newTileliveSource(params);
                    }).then(function(tileSource) {
                        return that._wrapTileSource(tileSource, params);
                    }).fin(function() {
                        delete index[promiseKey];
                    });
                }
                return promise;
            });
        });
    },
    clearTileSource : function(params) {
        var that = this;
        return P().then(function() {
            return that.projectLoader.clearProject(params);
        });
    },
    getTileSourceProvider : function() {
        return this.options.tileSourceProvider;
    },
    setTileSourceProvider : function(provider) {
        this.options.tileSourceProvider = provider;
    },

    _isRemoteSource : function(params) {
        var source = this._getSourceKey(params);
        return source.indexOf(':') > 0;
    },
    _getVectorTilesParams : function(params, uri) {
        var properties = uri.properties || {};
        var result = null;
        var source = this._getSourceKey(properties);
        if (source == '') {
            source = (properties.useVectorTiles ? this._getSourceKey(params)
                    : null);
        }
        if (source && source != '') {
            result = this._setSourceKey(params, source)
            result.format = 'vtile';
        }
        return result;
    },
    _getTileSourceConfig : function(params) {
        return this.projectLoader.loadProject(params);
    },
    _wrapTileSource : function(tileSource, params) {
        if (tileSource.__wrapped)
            return tileSource;
        tileSource.__wrapped = true;
        var source = this._getSourceKey(params);
        var eventManager = this._getEventManager();
        var methods = _.map([ 'getTile', 'getGrid', 'getInfo' ],
                function(name) {
                    return {
                        eventName : name,
                        methodName : name,
                        params : {
                            source : source
                        }
                    }
                });
        return Commons.addEventTracingWithCallbacks(tileSource, methods,
                eventManager);
    },
    _newTileliveSource : function(params) {
        var that = this;
        return that._getTileSourceConfig(params).then(
                function(uri) {
                    var loadVector = that.isVectorSourceType(params)
                            && !that._isRemoteSource(params);
                    if (loadVector) {
                        // Generate vector tiles using existing tilemill
                        // projects
                        uri = _.extend({}, uri, {
                            protocol : 'bridge:'
                        });
                        return uri;
                    } else {
                        // Generate image from vector tile sources
                        var vectorTilesParams = that._getVectorTilesParams(
                                params, uri);
                        if (!vectorTilesParams)
                            return uri;
                        var provider = that.getTileSourceProvider(params);
                        return provider.loadTileSource(vectorTilesParams).then(
                                function(vtileSource) {
                                    uri = _.extend({}, uri, {
                                        protocol : 'vector:',
                                        source : {
                                            protocol : 'tilepin:',
                                            source : vtileSource
                                        }
                                    });
                                    // uri.xml = that
                                    // ._replaceVtilesProjection(uri.xml);
                                    return uri;
                                });
                    }
                }).then(function(uri) {
            return P.ninvoke(Tilelive, 'load', uri);
        });

        // _replaceVtilesProjection : function(str) {
        // if (!str)
        // return str;
        // // Replace all SRS references by the Google SRS (900913)
        // return str.replace(/srs=".*?"/gim, function(match) {
        // return 'srs="+proj=merc ' + '+a=6378137 +b=6378137 '
        // + '+lat_ts=0.0 +lon_0=0.0 ' + '+x_0=0.0 +y_0=0.0 +k=1.0 '
        // + '+units=m +nadgrids=@null ' + '+wktext +no_defs +over"';
        // });
        // },

    },

})

module.exports = TileSourceProvider;
