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

var ProjectLoader = require('./tilepin-loader');

/* -------------------------------------------------------------------------- */
/**
 * Objects of this type provide access to individual projects and they are used
 * to generate TileSource instances using dynamic parameters.
 */
function TileSourceProvider(options) {
    var that = this;
    that.options = options;
    that._promises = that._newCache(that._getMaxTimeout());
}
_.extend(TileSourceProvider.prototype, {

    prepareTileSource : function(params) {
        var that = this;
        var id = that.getCacheId(params);
        var promise = that._promises.get(id);
        if (!promise) {
            promise = that._generateTileliveUri(params) // 
            .then(function(uri) {
                return that._loadTileliveSourceUri(uri, params);
            }) // 
            .then(function(uri) {
                return P.ninvoke(Tilelive, 'load', uri);
            }) //
            .then(function(tileSource) {
                return that._wrapTileSource(tileSource, params);
            }) // 
            .fail(function(err) {
                that._promises.del(id);
                throw err;
            });
            that._promises.set(id, promise);
        }
        return promise;
    },

    getCacheId : function(params) {
        var id = '';
        // console.log(this.options.config);
        return id;
    },

    close : function(params) {
        this._reset();
    },

    _isRemoteSource : function(params) {
        var source = this._getSourceKey(params);
        return source.indexOf(':') > 0;
    },

    _isVectorSourceType : function(params) {
        var format = params.format || 'png';
        return format == 'vtile' || format == 'pbf'
    },

    _generateTileliveUri : function(params) {
        var that = this;
        var file = that.options.pathname;
        var dir = Path.dirname(file);
        return P().then(function() {
            return that._getProcessedConfig(params);
        }).then(function(config) {
            var renderer = new Carto.Renderer({
                filename : file,
                local_data_dir : dir,
            });
            return P.ninvoke(renderer, 'render', config) // 
            .then(function(xml) {
                return {
                    base : dir,
                    pathname : file,
                    path : file,
                    protocol : 'mapnik:',
                    xml : xml,
                    properties : config.properties || {}
                };
            })
        });
    },

    _getProcessedConfig : function(params) {
        var that = this;
        var options = that.options;
        // Deep copy of the config
        var config = JSON.parse(JSON.stringify(options.config));
        var handler = options['handleDatalayer'];
        if (_.isFunction(handler)) {
            _.map(config.Layer, function(dataLayer) {
                if (!dataLayer.Datasource)
                    return;
                handler.call(options, {
                    config : config,
                    dataLayer : dataLayer,
                    params : params
                });
            })
        }
        return config;
    },

    _loadTileliveSourceUri : function(uri, params) {
        var that = this;
        return P().then(
                function() {
                    if (that._isVectorSourceType(params)
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
                        var manager = that.options.sourceManager;
                        var prm = vectorTilesParams;
                        return manager.loadTileSourceProvider(prm).then(
                                function(provider) {
                                    return provider.prepareTileSource(prm);
                                }).then(function(vtileSource) {
                            uri = _.extend({}, uri, {
                                protocol : 'vector:',
                                source : {
                                    protocol : 'tilepin:',
                                    source : vtileSource
                                }
                            });
                            return uri;
                        });
                    }
                });
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

    _getSourceKey : function(params) {
        return params.source || '';
    },

    _closeTileSource : function(promise) {
        var that = this;
        return promise.then(function(tileSource) {
            var eventManager = that._getEventManager();
            if (eventManager) {
                eventManager.fire('TileSourceProvider:clearTileSource', {
                    eventName : 'TileSourceProvider:clearTileSource',
                    tileSource : tileSource,
                    provider : that
                });
            }
            console.log('Destroying the tileSource: ', tileSource);
        })
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

    _wrapTileSource : function(tileSource, params) {
        var that = this;
        var eventManager = that._getEventManager();
        if (eventManager) {
            var methods = _.map([ 'getTile', 'getGrid', 'getInfo' ], function(
                    name) {
                return {
                    eventName : name,
                    methodName : name,
                    params : params
                }
            });
            return Commons.addEventTracingWithCallbacks(tileSource, methods,
                    eventManager);
        } else {
            return tileSource;
        }
    },

    _getEventManager : function() {
        return this.options.eventManager;
    }

})
/* -------------------------------------------------------------------------- */

// Register a fake protocol allowing to return the control to the renderer
Tilelive.protocols['tilepin:'] = function(options, callback) {
    callback(null, options.source);
};

/* -------------------------------------------------------------------------- */
/**
 * TileSourceManagers are used to manage multiple TileSourceProviders - one
 * provider by project. This object keeps providers in the internal cache.
 */
function TileSourceManager() {
    if (_.isFunction(this.initialize)) {
        this.initialize.apply(this, arguments);
    }
}
_.extend(TileSourceManager.prototype, Commons.Events, {

    type : 'TileSourceManager',

    initialize : function(options) {
        this.options = options || {};
        this.sourceCache = new LRU({
            maxAge : this._getTileSourceCacheTTL()
        });
        this.projectLoader = this.options.projectLoader
                || new ProjectLoader(this.options);
        var eventManager = this._getEventManager();
        Commons.addEventTracing(this, [ 'loadTileSourceProvider',
                'clearTileSourceProvider' ], eventManager);
    },

    /* ------------------------------ */
    // Methods to re-define in sub-classes.
    /** Loads and returns a promise for a tile source */
    loadTileSourceProvider : function(params) {
        var that = this;
        var eventManager = that._getEventManager();
        return P().then(function() {
            var format = that._getTileFormat(params);
            var cacheKey = that._getCacheKey(params, format);
            var provider = that.sourceCache.get(cacheKey);
            if (provider) {
                eventManager.fire('loadTileSourceProvider:loadFromCache', {
                    eventName : 'loadTileSourceProvider:loadFromCache',
                    arguments : [ params ],
                    format : format,
                    provider : provider
                });
                return provider;
            }

            eventManager.fire('loadTileSourceProvider:missedInCache', {
                eventName : 'loadTileSourceProvider:missedInCache',
                format : format,
                arguments : [ params ]
            });
            var promiseKey = cacheKey;
            var index = that._sourceLoadingIndex || {};
            that._sourceLoadingIndex = index;
            var promise = index[promiseKey];
            if (!promise) {
                promise = index[promiseKey] = P().then(function() {
                    return that._loadProjectConfig(params);
                }).then(function(config) {
                    return that._newTileSourceProvider(config, params);
                }).fin(function() {
                    delete index[promiseKey];
                });
            }
            return promise.then(function(provider) {
                eventManager.fire('loadTileSourceProvider:setInCache', {
                    eventName : 'loadTileSourceProvider:setInCache',
                    arguments : [ params ],
                    format : format,
                    provider : provider
                });
                that.sourceCache.set(cacheKey, provider);
                return provider;
            });
        });
    },

    /** Cleans up a tile source corresponding to the specified parameters */
    clearTileSourceProvider : function(params) {
        var that = this;
        return P().then(function() {
            var formats = that._getTileFormats(params);
            var promises = _.map(formats, function(format) {
                return P().then(function() {
                    var cacheKey = that._getCacheKey(params, format);
                    var provider = that.sourceCache.get(cacheKey);
                    if (!provider) {
                        return;
                    }
                    var eventManager = that._getEventManager();
                    var eventName = 'clearTileSourceProvider:clearCache';
                    eventManager.fire(eventName, {
                        eventName : eventName,
                        arguments : [ params ],
                        format : format,
                        provider : provider
                    });
                    that.sourceCache.del(cacheKey);
                    return provider.close(params);
                })
            })
            return P.all(promises).then(function() {
                var sourceKey = that._getSourceKey(params);
                var projectDir = that._getProjectDir(sourceKey);
                return that.projectLoader.clearProjectConfig(projectDir);
            });
        });
    },

    /* ---------------------------------------------------------------------- */

    _getTileFormats : function() {
        // TODO: check that it is all possible formats
        var formats = [ 'png', 'pbf', 'vtile', 'grid.json' ];
        return formats;
    },

    _getTileFormat : function(params) {
        return params.format || 'png';
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

    _loadProjectConfig : function(params) {
        var that = this;
        var sourceKey = that._getSourceKey(params);
        var projectDir = that._getProjectDir(sourceKey);
        return that.projectLoader.loadProjectConfig(projectDir);
    },

    _getProjectDir : function(sourceKey) {
        var dir = this.options.dir || this.options.styleDir || __dirname;
        dir = Path.join(dir, sourceKey);
        dir = Path.resolve(dir);
        return dir;
    },

    _newTileSourceProvider : function(info, params) {
        var that = this;
        var sourceKey = that._getSourceKey(params);
        var projectDir = that._getProjectDir(sourceKey);
        return new TileSourceProvider(_.extend({}, that.options, {
            sourceKey : sourceKey,
            projectDir : projectDir,
            eventManager : that._getEventManager(),
            sourceManager : that
        }, info));
    },

});

module.exports = TileSourceManager;
