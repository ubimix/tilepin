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
var Zlib = require('zlib');

var Tilepin = require('./lib/');
require('./lib/Tilepin.Events');

var Carto = require('carto');
var AdmZip = require('adm-zip');
var LRU = require('lru-cache');

var Tilelive = require('tilelive');
var extensions = [ 'tilelive-mapnik', 'tilelive-vector', 'tilelive-bridge',
        'tilejson' ];
_.each(extensions, function(extension) {
    try {
        (require(extension)).registerProtocols(Tilelive);
    } catch (e) {
        console.log(e);
    }
});

function CompositeTileSource(tileSources, interactiveLayer) {
    this.tileSources = _.filter(tileSources, function(source) {
        var result = source != null;
        return result;
    });
    this.interactiveLayer = interactiveLayer;
}
_.extend(CompositeTileSource.prototype, {
    getTile : function(z, x, y, callback) {
        var that = this;
        Tilepin.P.all(_.map(that.tileSources, function(tileSource) {
            var deferred = Tilepin.P.defer();
            // console.log(' * BGN [' + z + ',' + x + ',' + y + ']',
            // tileSource.sourceKey);
            tileSource.getTile(z, x, y, function(err, tile, meta) {
                if (err == 'Error: Tile does not exist') {
                    tile = new Buffer([]);
                    meta = {
                        'Content-Type' : 'application/x-protobuf'
                    };
                    err = undefined;
                }
                if (err) {
                    // console.log(' * ERR [' + z + ',' + x + ',' + y
                    // + ']', tileSource.sourceKey, err);
                    deferred.reject(err);
                } else {
                    // console.log(' * END [' + z + ',' + x + ',' + y
                    // + ']', tileSource.sourceKey, 'LEN: ['
                    // + tile.length + ']', meta);
                    deferred.resolve({
                        tile : tile,
                        meta : meta
                    })
                }
            });
            return deferred.promise;
        }))
        //
        .then(function(tiles) {
            // Unzip all tiles
            return Tilepin.P.all(_.map(tiles, function(tile) {
                var meta = tile.meta;
                if (meta['Content-Encoding'] == 'deflate') {
                    return Tilepin.P.ninvoke(Zlib, 'inflate', tile.tile);
                }
                return tile.tile;
            }))
            // Concat and re-zip all tiles
            .then(function(tiles) {
                var buf = Buffer.concat(tiles);
                return Tilepin.P.ninvoke(Zlib, 'deflate', buf);
            });
        })
        // Return the final tile
        .then(function(tile) {
            callback(null, tile, {
                'Content-Type' : 'application/x-protobuf',
                'Content-Encoding' : 'deflate'
            });
        }, function(err) {
            callback(err);
        });
    },
    getGrid : function(z, x, y, callback) {
        var that = this;
        var tileSource = _.find(that.tileSources, function(tileSource) {
            return that.interactiveLayer == tileSource.name;
        });
        if (!tileSource) {
            callback(new Error('No interactive layer'));
        } else {
            tileSource.getGrid(z, x, y, callback);
        }
    },
    getInfo : function(callback) {
        var that = this;
        Tilepin.P.all(_.map(that.tileSources, function(tileSource) {
            return Tilepin.P.ninvoke(tileSource, 'getInfo');
        })).then(function(list) {
            var result = {};
            _.each(list, function(info) {
                _.extend(result, info);
            })
            callback(null, result);
        }, function(err) {
            callback(err);
        })
    }
});

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
        var id = that._getCacheId(params);
        // FIXME: add expiration of individual requests
        var promise = that._promises.get(id);
        if (!promise) {
            promise = Tilepin.P().then(function() {
                return that._loadMapnikConfig(params, id).then(function(uri) {
                    return that._loadTileliveSourceUri(uri, params);
                }).then(function(uri) {
                    return Tilepin.P.ninvoke(Tilelive, 'load', uri);
                }).then(function(tileSource) {
                    return that._wrapTileSource(tileSource, params);
                });
            }).then(null, function(err) {
                that._promises.del(id);
                throw err;
            });
            that._promises.set(id, promise);
        }
        return promise;
    },

    isDynamicSource : function(params) {
        var result = false;
        var config = this._getConfig();
        if (!!config.dynamic) {
            result = true;
        }
        return result;
    },

    getCacheKey : function(params, suffix) {
        var that = this;
        var x = +params.x;
        var y = +params.y;
        var zoom = +params.z;
        var array = [];
        _.each([ zoom, x, y ], function(n) {
            if (!_.isNaN(n)) {
                array.push(n);
            }
        })
        var key = undefined;
        if (array.length == 3 /* zoom, x, y */) {
            key = that._getCacheId(params) + array.join('-');
            if (suffix && suffix != '')
                key += '-' + suffix;
        }
        return key;
    },

    _getCacheId : function(params) {
        var that = this;
        var mapnikAdapter = that._project
                .getAdapter(Tilepin.ConfigAdapter.MapnikAdapter);
        var suffix = mapnikAdapter.getMapnikCacheKey(params);
        if (suffix != '') {
            suffix = '-' + suffix;
        } else {
            suffix = '';
        }
        var type = that._isVectorTileRequested(params) ? '-a' : '-b';
        var sourceKey = that._getSourceKey();
        var id = sourceKey + type + suffix;
        id = require('crypto').createHash('sha1').update(id).digest('hex')
        return id;
    },

    clear : function(params) {
        var that = this;
        var dir = that._getMapnikConfigDir();
        return Tilepin.P().then(function() {
            return Tilepin.P.ninvoke(FS, 'readdir', dir);
        }).then(function(array) {
            var promises = _.map(array, function(name) {
                if (!name.indexOf('project.tilepin.') == 0)
                    return;
                var ext = Path.extname(name);
                if (ext == '.xml' || ext == '.json') {
                    var file = Path.join(dir, name);
                    return Tilepin.IO.deleteFile(file);
                }
            });
            promises.push(that._unloadProject().then(function() {
                // Re-open the project
                return that._loadProject().then(function(project) {
                    return project.open();
                });
            }));
            return Tilepin.P.all(promises);
        })
    },

    open : function() {
        var that = this;
        return that._openProjectPromise = that._openProjectPromise
                || Tilepin.P().then(function() {
                    return that._loadProject();
                }).then(function(project) {
                    return project.open();
                }).then(function() {
                    return that;
                });
    },

    close : function(params) {
        var that = this;
        return Tilepin.P().then(function() {
            delete that._handlers;
        }).then(function() {
            return that._unloadProject();
        }).then(function() {
            return that._promises.reset();
        });
    },

    /** Returns an already opened project */
    _getProject : function() {
        return this._project;
    },

    /** Removes an already loaded project */
    _unloadProject : function() {
        var that = this;
        return Tilepin.P().then(function() {
            var project = that._project;
            delete that._project;
            delete that._loadProjectPromise;
            delete that._openProjectPromise;
            if (project) {
                return project.close();
            }
        })
    },

    /** Loads the project. */
    _loadProject : function() {
        var that = this;
        return that._loadProjectPromise = that._loadProjectPromise || // 
        Tilepin.P().then(function() {
            if (!that._project) {
                var projectDir = that._getProjectDir();
                var options = _.extend({}, that.options, {
                    projectDir : projectDir
                });
                that._project = new Tilepin.ProjectConfig(options);
            }
            return that._project;
        });
    },

    _getConfig : function(deepCopy) {
        var config = this._project.getConfigObject(deepCopy);
        return config;
    },

    _isRemoteSource : function() {
        var source = this._getSourceKey();
        return source.indexOf(':') > 0;
    },

    _isVectorTileRequested : function(params) {
        var format = params.format || 'png';
        return format == 'vtile' || format == 'pbf'
    },

    _getMapnikConfigDir : function() {
        var dir = this._getProjectDir();
        return dir;
    },
    _getMapnikConfigFileBase : function(id) {
        var dir = this._getMapnikConfigDir();
        var name = 'project.tilepin.' + id.substring(0, 12);
        return Path.join(dir, name);
    },

    _loadMapnikConfig : function(params, id) {
        var that = this;
        return Tilepin.P().then(function() {
            return that._loadProject();
        }).then(function(project) {
            var configFileBase = that._getMapnikConfigFileBase(id);
            var configFileDir = that._getMapnikConfigDir();
            var configFile = configFileBase + '.xml';
            var mapnikAdapter = that._project//
            .getAdapter(Tilepin.ConfigAdapter.MapnikAdapter);
            return mapnikAdapter.prepareMapnikConfig(params)//
            .then(function(config) {
                return _.extend({}, config, {
                    base : configFileDir,
                    pathname : configFile,
                    path : configFile,
                    protocol : 'mapnik:',
                });
            })
        });
    },

    _loadTileliveSourceUri : function(uri, params) {
        var that = this;
        return Tilepin.P().then(
                function() {
                    if (that._isVectorTileRequested(params)
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
                        if (!vectorTilesParams || !vectorTilesParams.length)
                            return uri;

                        var manager = that.options.sourceManager;
                        function loadTileSource(prm) {
                            return Tilepin.P().then(function() {
                                return manager.loadTileSourceProvider(prm) //
                                .then(function(provider) {
                                    return provider.prepareTileSource(prm) //
                                    .then(function(tileSource) {
                                        tileSource.sourceKey = prm.source;
                                        return tileSource;
                                    });
                                });
                            });
                        }
                        return Tilepin.P.all(
                                _.map(vectorTilesParams, loadTileSource))//
                        .then(
                                function(tileSources) {
                                    var tileSource = new CompositeTileSource(
                                            tileSources);
                                    uri = _.extend({}, uri, {
                                        protocol : 'vector:',
                                        source : {
                                            protocol : 'tilepin:',
                                            source : tileSource
                                        }
                                    });
                                    return uri;
                                });
                    }
                });
    },

    _getVectorTilesParams : function(params, uri) {
        var result = [];
        var that = this;
        var config = that._getConfig();
        if (config.useVectorTiles) {
            var prefix = config.dataSourcePrefix || that._getSourceKey();
            _.each(config.Layer, function(layer) {
                var source = Path.join(prefix, layer.name);
                if (source && source != '') {
                    var vectorSourceParams = _.extend({}, params, {
                        source : source,
                        format : 'vtile'
                    });
                    result.push(vectorSourceParams);
                }
            })
        }
        return result;
    },

    _getProjectDir : function() {
        var projectDir = this.options.projectDir;
        return projectDir;
    },

    _getSourceKey : function() {
        return this.options.sourceKey || '';
    },

    _closeTileSource : function(promise) {
        var that = this;
        return promise.then(function(tileSource) {
            if (!tileSource)
                return;
            var eventEmitter = that._getEventEmitter();
            if (eventEmitter) {
                eventEmitter.emit('TileSourceProvider:clearTileSource', {
                    eventName : 'TileSourceProvider:clearTileSource',
                    tileSource : tileSource,
                    provider : that
                });
            }
            if (_.isFunction(tileSource.close)) {
                return Tilepin.P.ninvoke(tileSource, 'close');
            }
        })
    },

    _prepareUri : function(params) {
        var that = this;
        return Tilepin.P().then(function() {
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

    _wrapTileSource : function(tileSource, params) {
        if (!tileSource)
            return null;
        var that = this;
        var eventEmitter = that._getEventEmitter();
        if (eventEmitter) {
            var methods = _.map([ 'getTile', 'getGrid', 'getInfo' ], function(
                name) {
                return {
                    eventName : name,
                    methodName : name,
                    params : params
                }
            });
            return Tilepin.Events.Mixin.addEventTracingWithCallbacks(
                    tileSource, methods, eventEmitter);
        } else {
            return tileSource;
        }
    },

    _getEventEmitter : function() {
        return this.options.eventEmitter;
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
_.extend(TileSourceManager.prototype, {

    type : 'TileSourceManager',

    initialize : function(options) {
        var that = this;
        that.options = options || {};
        that._providerPromises = {};
        that._providerCache = new LRU({
            maxAge : that._getTileSourceCacheTTL(),
            dispose : function(key, n) {
                that._deleteTileSourceProvider(n);
            },
        });
        var eventEmitter = that._getEventEmitter();
        Tilepin.Events.Mixin.addEventTracing(that, [ 'loadTileSourceProvider',
                'clearTileSourceProvider' ], eventEmitter);
    },

    /* ------------------------------ */
    // Methods to re-define in sub-classes.
    /** Loads and returns a promise for a tile source */
    loadTileSourceProvider : function(params) {
        var that = this;
        return Tilepin.P().then(function() {
            var cacheKey = that._getCacheKey(params);
            var eventEmitter = that._getEventEmitter();
            var provider = that._providerCache.get(cacheKey);
            if (provider) {
                eventEmitter.emit('loadTileSourceProvider:loadFromCache', {
                    eventName : 'loadTileSourceProvider:loadFromCache',
                    arguments : [ params ],
                    provider : provider
                });
                return provider;
            }
            return that._providerPromises[cacheKey] = //
            that._providerPromises[cacheKey] || //
            Tilepin.P.fin(Tilepin.P.then(function() {
                var provider = that._newTileSourceProvider(params);
                eventEmitter.emit('loadTileSourceProvider:setInCache', {
                    eventName : 'loadTileSourceProvider:setInCache',
                    arguments : [ params ],
                    provider : provider
                });
                that._providerCache.set(cacheKey, provider);
                return provider.open();
            }), function() {
                delete that._providerPromises[cacheKey];
            });
        });
    },

    /** Cleans up a tile source corresponding to the specified parameters */
    clearTileSourceProvider : function(params) {
        var that = this;
        return Tilepin.P().then(function() {
            var cacheKey = that._getCacheKey(params);
            var provider = null;
            return Tilepin.P.fin(that.loadTileSourceProvider(params)//
            .then(function(p) {
                provider = p;
            }, function(err) {
                provider = that._providerCache.get(cacheKey);
                // We ignore errors rised while openining the provider.
                if (!provider) {
                    throw err;
                }
            }).then(function() {
                var eventEmitter = that._getEventEmitter();
                var eventName = 'clearTileSourceProvider:clearCache';
                eventEmitter.emit(eventName, {
                    eventName : eventName,
                    arguments : [ params ],
                    provider : provider
                });
                return provider.clear(params).then(function() {
                    return provider.close(params);
                });
            }), function() {
                that._providerCache.del(cacheKey);
            });
        });
    },

    /* ---------------------------------------------------------------------- */

    _getSourceKey : function(params) {
        return params.source || '';
    },

    /**
     * An internal method returning a cache key for the source defined in the
     * parameters.
     */
    _getCacheKey : function(params) {
        var key = this._getSourceKey(params);
        return key;
    },

    _getEventEmitter : function() {
        var eventEmitter = this.options.eventEmitter || this;
        return eventEmitter;
    },

    _getTileSourceCacheTTL : function() {
        return this.options.tileSourceCacheTTL || 60 * 60 * 1000;
    },

    _getProjectDir : function(sourceKey) {
        var dir = this.options.dir || this.options.styleDir || __dirname;
        dir = Path.join(dir, sourceKey);
        dir = Path.resolve(dir);
        return dir;
    },

    _newTileSourceProvider : function(params) {
        var that = this;
        var sourceKey = that._getSourceKey(params);
        var projectDir = that._getProjectDir(sourceKey);
        var provider = new TileSourceProvider(_.extend({}, that.options, {
            sourceKey : sourceKey,
            projectDir : projectDir,
            eventEmitter : that._getEventEmitter(),
            sourceManager : that
        }));
        return provider;
    },

    _deleteTileSourceProvider : function(provider) {
        provider.close().done();
    },

});

module.exports = TileSourceManager;
