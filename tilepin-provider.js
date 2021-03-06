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

var Commons = require('./tilepin-commons');
var P = Commons.P;

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
        P.all(_.map(that.tileSources, function(tileSource) {
            var deferred = P.defer();
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
            return P.all(_.map(tiles, function(tile) {
                var meta = tile.meta;
                if (meta['Content-Encoding'] == 'deflate') {
                    return P.ninvoke(Zlib, 'inflate', tile.tile);
                }
                return tile.tile;
            }))
            // Concat and re-zip all tiles
            .then(function(tiles) {
                var buf = Buffer.concat(tiles);
                return P.ninvoke(Zlib, 'deflate', buf);
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
        P.all(_.map(that.tileSources, function(tileSource) {
            return P.ninvoke(tileSource, 'getInfo');
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
            promise = that._loadMapnikConfig(params, id) // 
            .then(function(uri) {
                return that._loadTileliveSourceUri(uri, params);
            }) // 
            .then(function(uri) {
                return P.ninvoke(Tilelive, 'load', uri);
            }) //
            .then(function(tileSource) {
                return that._wrapTileSource(tileSource, params);
            }, function(err) {
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

    clear : function(params) {
        var dir = this._getMapnikConfigDir();
        return P.ninvoke(FS, 'readdir', dir).then(function(array) {
            return P.all(_.map(array, function(name) {
                if (!name.indexOf('project.tilepin.') == 0)
                    return;
                var ext = Path.extname(name);
                if (ext == '.xml' || ext == '.json') {
                    var file = Path.join(dir, name);
                    return Commons.IO.deleteFile(file);
                }
            }));
        })
    },

    open : function() {
        var that = this;
        if (this._projectConfigPromise)
            return this._projectConfigPromise;
        return this._projectConfigPromise = P().then(
                function() {
                    var sourceKey = that._getSourceKey();
                    var projectDir = that._getProjectDir();
                    var projectLoader = that.options.projectLoader;
                    return projectLoader.loadProjectConfig(projectDir)//
                    .then(
                            function(configInfo) {
                                that.configInfo = configInfo || {};
                                return projectLoader.processProjectConfig(
                                        projectDir, configInfo);
                            }).then(function() {
                        return that;
                    });
                })
    },

    close : function(params) {
        var that = this;
        return P().then(function() {
            delete that._handlers;
            delete that._projectConfigPromise;
        }).then(function() {
            var projectDir = that._getProjectDir();
            return that.options.projectLoader.clearProjectConfig(projectDir);
        }).then(function() {
            return that._promises.reset();
        }).then(function() {
            return that._unloadQueryScript();
        });
    },

    _getConfig : function(deepCopy) {
        var configInfo = this.configInfo || {};
        var config = configInfo.config || {};
        if (deepCopy === true) {
            config = JSON.parse(JSON.stringify(config));
        }
        return config;
    },

    _getCacheId : function(params) {
        var sourceKey = this._getSourceKey();
        var suffix = this._getCacheParams(params);
        if (suffix != '') {
            suffix = '-' + suffix;
        } else {
            suffix = '';
        }
        var type = this._isVectorTileRequested(params) ? '-a' : '-b';
        var id = sourceKey + type + suffix;
        id = require('crypto').createHash('sha1').update(id).digest('hex')
        return id;
    },

    _getCacheParams : function(params) {
        // if (this.isDynamicSource(params)) {
        var result = '';
        var script = this._getQueryScript();
        if (script && _.isFunction(script.getId)) {
            result = script.getId(params);
        }
        // }
        if (!result) {
            result = '';
        }
        return result;

    },

    _getQueryScriptPath : function() {
        var that = this;
        var config = that._getConfig();
        var scriptName = config.queryBuilder;
        if (!scriptName)
            return undefined;
        var projectDir = that._getProjectDir();
        var path = Path.join(projectDir, scriptName);
        return path;
    },

    _unloadQueryScript : function() {
        var that = this;
        var path = that._getQueryScriptPath();
        if (!path)
            return;
        delete that._queryScript;
        return Commons.IO.clearObject(path);
    },

    _getQueryScript : function() {
        var that = this;
        if (that._queryScript)
            return that._queryScript;
        var path = that._getQueryScriptPath();
        if (!path)
            return;
        that._queryScript = Commons.IO.loadObject(path);
        return that._queryScript;
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
        var configFileBase = that._getMapnikConfigFileBase(id);
        var config;

        var configFileDir = this._getMapnikConfigDir();
        var configFile = configFileBase + '.xml';
        var jsonLoader = {
            field : 'config',
            file : configFileBase + '.json',
            content : null,
            load : function() {
                return Commons.IO.readJson(this.file);
            },
            build : function() {
                return that._getProcessedConfig(params);
            },
            save : function() {
                return Commons.IO.writeJson(this.file, this.content);
            }
        };
        var xmlLoader = {
            field : 'xml',
            file : configFile,
            content : null,
            load : function() {
                return Commons.IO.readString(this.file);
            },
            build : function() {
                var deferred = P.defer();
                try {
                    var renderer = new Carto.Renderer({
                        filename : this.file,
                        local_data_dir : configFileDir,
                    });
                    var result = renderer.render(jsonLoader.content, P
                            .nresolver(deferred));
                    if (result) {
                        // In case of the synchroneous reply (Carto v0.11)
                        deferred.resolve(result);
                    }
                } catch (e) {
                    deferred.reject(e);
                }
                return deferred.promise;
            },
            save : function() {
                return Commons.IO.writeString(this.file, this.content);
            }
        }
        var promise = P();
        _.each([ jsonLoader, xmlLoader ], function(loader) {
            promise = promise.then(function() {
                var file = loader.file;
                if (FS.existsSync(file)) {
                    return loader.load().then(function(content) {
                        loader.content = content;
                    });
                }
                return loader.build().then(function(content) {
                    loader.content = content;
                    return loader.save(loader.content);
                });
            })
        });
        return promise.then(function() {
            return {
                base : configFileDir,
                pathname : configFile,
                path : configFile,
                xml : xmlLoader.content,
                config : jsonLoader.content,
                protocol : 'mapnik:',
            };
        });
    },

    _getProcessingHandlers : function() {
        var that = this;
        return P().then(function() {
            if (that._handlers)
                return that._handlers;
            that._handlers = [];
            var script = that._getQueryScript();
            if (script && _.isFunction(script.prepareDatasource)) {
                that._handlers.push(function(args) {
                    return script.prepareDatasource(args);
                })
            }
            var handler = that.options['handleDatalayer'];
            if (_.isFunction(handler)) {
                that._handlers.push(function(args) {
                    return handler.call(that.options, args);
                });
            }
            return that._handlers;
        });
    },

    _getProcessedConfig : function(params) {
        var that = this;
        // Deep copy of the config
        var config = that._getConfig(true);
        return P().then(function() {
            var script = that._getQueryScript();
            if (script && _.isFunction(script.prepareConfig)) {
                return script.prepareConfig({
                    config : config,
                    params : params
                });
            }
        }).then(function() {
            if (!config.Layer || !config.Layer.length)
                return;
            return that._getProcessingHandlers().then(function(handlers) {
                if (!handlers.length)
                    return;
                return P.all(_.map(config.Layer, function(dataLayer) {
                    if (!dataLayer.Datasource)
                        return;
                    var args = {
                        config : config,
                        dataLayer : dataLayer,
                        params : params
                    };
                    if (handlers.length == 1)
                        return handlers[0](args);
                    return P.all(_.map(handlers, function(handler) {
                        return handler(args);
                    }));
                }));
            });
        }).then(function() {
            return config;
        })
    },

    _loadTileliveSourceUri : function(uri, params) {
        var that = this;
        return P().then(
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
                        return P.all(_.map(vectorTilesParams, function(prm) {
                            return manager.loadTileSourceProvider(prm) //
                            .then(function(provider) {
                                return provider.prepareTileSource(prm) //
                                .then(function(tileSource) {
                                    tileSource.sourceKey = prm.source;
                                    return tileSource;
                                });
                            });
                        })).then(
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
            var eventManager = that._getEventManager();
            if (eventManager) {
                eventManager.fire('TileSourceProvider:clearTileSource', {
                    eventName : 'TileSourceProvider:clearTileSource',
                    tileSource : tileSource,
                    provider : that
                });
            }
            if (_.isFunction(tileSource.close)) {
                return P.ninvoke(tileSource, 'close');
            }
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

    _wrapTileSource : function(tileSource, params) {
        if (!tileSource)
            return null;
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
        var that = this;
        that.options = options || {};
        that.sourceCache = new LRU({
            maxAge : that._getTileSourceCacheTTL(),
            dispose : function(key, n) {
                that._deleteTileSourceProvider(n);
            },
        });
        that.projectLoader = that.options.projectLoader
                || new ProjectLoader(that.options);
        var eventManager = that._getEventManager();
        Commons.addEventTracing(that, [ 'loadTileSourceProvider',
                'clearTileSourceProvider' ], eventManager);
    },

    /* ------------------------------ */
    // Methods to re-define in sub-classes.
    /** Loads and returns a promise for a tile source */
    loadTileSourceProvider : function(params) {
        var that = this;
        var eventManager = that._getEventManager();
        return P().then(function() {
            var cacheKey = that._getCacheKey(params);
            var provider = that.sourceCache.get(cacheKey);
            if (provider) {
                eventManager.fire('loadTileSourceProvider:loadFromCache', {
                    eventName : 'loadTileSourceProvider:loadFromCache',
                    arguments : [ params ],
                    provider : provider
                });
                return provider;
            }
            var provider = that._newTileSourceProvider(params);
            eventManager.fire('loadTileSourceProvider:setInCache', {
                eventName : 'loadTileSourceProvider:setInCache',
                arguments : [ params ],
                provider : provider
            });
            that.sourceCache.set(cacheKey, provider);
            return provider;
        }).then(function(provider) {
            return provider.open();
        });
    },

    /** Cleans up a tile source corresponding to the specified parameters */
    clearTileSourceProvider : function(params) {
        var that = this;
        return P().then(function() {
            var cacheKey = that._getCacheKey(params);
            var provider = that.sourceCache.get(cacheKey);
            if (!provider) {
                provider = that._newTileSourceProvider(params);
            }
            return provider;
        }).then(function(provider) {
            var eventManager = that._getEventManager();
            var eventName = 'clearTileSourceProvider:clearCache';
            eventManager.fire(eventName, {
                eventName : eventName,
                arguments : [ params ],
                provider : provider
            });
            return provider.clear(params).then(function() {
                return provider.close(params);
            });
        }).then(function() {
            var cacheKey = that._getCacheKey(params);
            that.sourceCache.del(cacheKey);
        }, function(err) {
            var cacheKey = that._getCacheKey(params);
            that.sourceCache.del(cacheKey);
            throw err;
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

    _getEventManager : function() {
        var eventManager = this.options.eventManager || this;
        return eventManager;
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
        return new TileSourceProvider(_.extend({}, that.options, {
            sourceKey : sourceKey,
            projectDir : projectDir,
            eventManager : that._getEventManager(),
            sourceManager : that,
            projectLoader : that.projectLoader
        }));
    },

    _deleteTileSourceProvider : function(provider) {
        provider.close().done();
    },

});

module.exports = TileSourceManager;
