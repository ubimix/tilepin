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

function TileSourceWrapper(options) {
    var that = this;
    that.options = options;
    that._tileSource = null;
    that._uri = that.options.uri;
    that._promises = that._newCache(that._getMaxTimeout());
}
_.extend(TileSourceWrapper.prototype, {

    prepareTileSource : function(params) {
        var that = this;
        var id = that._getId(params);
        var promise = that._promises.get(id);
        if (!promise) {
            promise = that._doLoadTileSource(params).fail(function(err) {
                that._promises.del(id);
                throw err;
            });
            that._promises.set(id, promise);
        }
        return promise;
    },

    close : function() {
        this._reset();
    },

    _closeTileSource : function(promise) {
        return promise.then(function(tileSource) {
            console.log('Destroying the tileSource: ', tileSource);
        })
    },

    _getId : function(params) {
        var uri = this._uri
        var id = '';
        if (uri.handler && _.isFunction(uri.handler.getId)) {
            id = uri.handler.getId(params, uri);
        }
        return id;
    },

    _prepareUri : function(params) {
        var that = this;
        return P().then(function() {
            var uri = that._uri
            if (uri.handler && _.isFunction(uri.handler.prepareUri)) {
                return uri.handler.prepareUri(params, uri);
            }
            return uri;
        });
    },

    _newCache : function(timeout) {
        var that = this;
        return new LRU({
            dispose : function(key, n) {
                that._closeTileSource(n);
            },
            maxAge : timeout
        });
    },

    _getMaxTimeout : function() {
        return 1000 * 60 * 60;
    },

    _reset : function() {
        var that = this;
        that._promises.reset();
        that._tileSource = null;
    },

    _doLoadTileSource : function(params) {
        var that = this;
        return that._prepareUri(params).then(function(uri) {
            return P.ninvoke(Tilelive, 'load', uri);
        }).then(
                function(tileSource) {
                    var eventManager = that._getEventManager();
                    if (eventManager) {
                        var methods = _.map(
                                [ 'getTile', 'getGrid', 'getInfo' ], function(
                                        name) {
                                    return {
                                        eventName : name,
                                        methodName : name,
                                        params : params
                                    }
                                });
                        return Commons.addEventTracingWithCallbacks(tileSource,
                                methods, eventManager);
                    } else {
                        return tileSource;
                    }
                })
        return promise;
    },

    _getEventManager : function() {
        return this.options.tilesProvider ? this.options.tilesProvider
                ._getEventManager() : null;
    }

})

// Register a fake protocol allowing to return the control to the renderer
Tilelive.protocols['tilepin:'] = function(options, callback) {
    callback(null, options.source);
};

function TileSourceProvider() {
    if (_.isFunction(this.initialize)) {
        this.initialize.apply(this, arguments);
    }
}
_.extend(TileSourceProvider.prototype, Commons.Events, {

    type : 'TileSourceProvider',

    initialize : function(options) {
        this.options = options || {};
        this.sourceCache = new LRU({
            maxAge : this._getTileSourceCacheTTL()
        });
        this.projectLoader = this.options.projectLoader
                || new TileMillProjectLoader(this.options);
        var eventManager = this._getEventManager();
        Commons.addEventTracing(this, [ 'loadTileSource', 'clearTileSource' ],
                eventManager);
    },

    /* ------------------------------ */
    // Methods to re-define in sub-classes.
    /** Loads and returns a promise for a tile source */
    loadTileSource : function(params) {
        var that = this;
        var eventManager = that._getEventManager();
        return P().then(function() {
            var format = that._getTileFormat(params);
            var cacheKey = that._getCacheKey(params, format);
            var wrapper = that.sourceCache.get(cacheKey);
            if (wrapper) {
                eventManager.fire('loadTileSource:loadFromCache', {
                    eventName : 'loadTileSource:loadFromCache',
                    arguments : [ params ],
                    format : format,
                    wrapper : wrapper
                });
                return wrapper;
            }

            eventManager.fire('loadTileSource:missedInCache', {
                eventName : 'loadTileSource:missedInCache',
                format : format,
                arguments : [ params ]
            });
            var promiseKey = cacheKey;
            var index = that._sourceLoadingIndex || {};
            that._sourceLoadingIndex = index;
            var promise = index[promiseKey];
            if (!promise) {
                promise = index[promiseKey] = P().then(function() {
                    return that._loadTileliveSourceUri(params);
                }).then(function(uri) {
                    return that._wrapTileSource(uri, params);
                }).fin(function() {
                    delete index[promiseKey];
                });
            }
            return promise.then(function(wrapper) {
                eventManager.fire('loadTileSource:setInCache', {
                    eventName : 'loadTileSource:setInCache',
                    arguments : [ params ],
                    format : format,
                    wrapper : wrapper
                });
                that.sourceCache.set(cacheKey, wrapper);
                return wrapper;
            });
        }).then(function(wrapper) {
            return wrapper.prepareTileSource(params);
        });
    },

    /** Cleans up a tile source corresponding to the specified parameters */
    clearTileSource : function(params) {
        var that = this;
        return P().then(function() {
            var formats = that._getTileFormats(params);
            var promises = _.map(formats, function(format) {
                return P().then(function() {
                    var cacheKey = that._getCacheKey(params, format);
                    var wrapper = that.sourceCache.get(cacheKey);
                    if (!wrapper) {
                        return;
                    }
                    var eventManager = that._getEventManager();
                    var eventName = 'clearTileSource:clearCache';
                    eventManager.fire(eventName, {
                        eventName : eventName,
                        arguments : [ params ],
                        format : format,
                        wrapper : wrapper
                    });
                    that.sourceCache.del(cacheKey);
                    return wrapper.close();
                })
            })
            return P.all(promises).then(function() {
                return that.projectLoader.clearProject(params);
            });
        });
    },

    /* ------------------------------ */

    isVectorSourceType : function(params) {
        var format = this._getTileFormat(params);
        return format == 'vtile' || format == 'pbf'
    },

    _getTileFormat : function(params) {
        return params.format || 'png';
    },

    _getTileFormats : function() {
        // TODO: check that it is all possible formats
        var formats = [ 'png', 'pbf', 'vtile', 'grid.json' ];
        return formats;
    },

    _getSourceKey : function(params) {
        return params.source || '';
    },

    /**
     * An internal method returning a cache key for the source defined in the
     * parameters.
     */
    _getCacheKey : function(params, format) {
        var key = this._getSourceKey(params);
        key += '-' + format;
        return key;
    },

    _getEventManager : function() {
        var eventManager = this.options.eventManager || this;
        return eventManager;
    },

    _getTileSourceCacheTTL : function() {
        return this.options.tileSourceCacheTTL || 60 * 60 * 1000;
    },

    /**
     * Returns the toplevel tilesource provider. By default this method returns
     * this object.
     */
    getTileSourceProvider : function() {
        return this.options.tileSourceProvider || this;
    },

    /**
     * Sets a new underlying tilesource provider returning tilesources to cache.
     */
    setTileSourceProvider : function(provider) {
        this.options.tileSourceProvider = provider;
    },

    _newTileliveSource : function(params) {
        var that = this;
        return that._loadTileliveSourceUri(params).then(function(uri) {
            return P.ninvoke(Tilelive, 'load', uri);
        });
    },

    _loadTileliveSourceUri : function(params) {
        var that = this;
        return that.projectLoader.loadProject(params) // 
        .then(
                function(uri) {
                    if (that.isVectorSourceType(params)
                            && !that._isRemoteSource(params)) {
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
                        return provider.loadTileSource(vectorTilesParams) // 
                        .then(function(vtileSource) {
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
                });
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
            result = _.extend({}, params, {
                source : source,
                format : 'vtile'
            });
        }
        return result;
    },

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

    /* ---------------------------------------------------------------------- */
    // Handling tile source wrappers (creating / initialisation / destruction)
    _wrapTileSource : function(uri, params) {
        return new TileSourceWrapper({
            uri : uri,
            params : params,
            tilesProvider : this,
        });
    },

});

module.exports = TileSourceProvider;
