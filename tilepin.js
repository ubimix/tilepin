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

function TilesProvider(options) {
    this.options = options || {};
}
_.extend(TilesProvider.prototype, {
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
        return Q(this.options.formats || this.formats || []);
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
        return Q(provider);
    }
})

function DispatchingTilesProvider(options) {
    this.options = options || {};
}
_.extend(DispatchingTilesProvider.prototype, TilesProvider.prototype, {
    invalidate : function(params) {
        return this._getTilesProvider(params, false).then(function(provider) {
            if (!provider)
                return;
            return provider.invalidate(params);
        });
    },
    loadTile : function(params) {
        return this._getTilesProvider(params, true).then(function(provider) {
            if (!provider)
                return;
            return provider.loadTile(params);
        });
    },
    loadInfo : function(params) {
        return this._getTilesProvider(params, true).then(function(provider) {
            if (!provider)
                return;
            return provider.loadInfo(params);
        });
    },
    getFormats : function(params) {
        return this._getTilesProvider(params, true).then(function(provider) {
            if (!provider)
                return;
            return provider.getFormats(params);
        });
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
_.extend(CachingTilesProvider.prototype, TilesProvider.prototype, {

    invalidate : function(params) {
        var that = this;
        return that._getTilesProvider(params, false).then(function(provider) {
            return provider.invalidate(params).then(function() {
                return provider.getFormats(params);
            }).then(function(formats) {
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
        })
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
    this.tileSourceProvider = new TileSourceProvider.TileMillProvider(
            this.options);
    this.sourceCache = new LRU({
        maxAge : this._getTileSourceCacheTTL()
    });
}
_.extend(ProjectBasedTilesProvider.prototype, TilesProvider.prototype, {

    invalidate : function(params) {
        var promises = [];
        promises.push(this.tileSourceProvider.clearTileSource(params));
        _.each([ '', '-tile', '-vector' ], function(prefix) {
            var sourceKey = this._getSourceKey(params, prefix);
            var source = this.sourceCache.get(sourceKey);
            this.sourceCache.del(sourceKey);
            if (source && _.isFunction(source.close)) {
                promises.push(Q.ninvoke(source, 'close'));
            }
        }, this);
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
        return this._getTileSource(params).then(function(tileSource) {
            return Q.ninvoke(tileSource, 'getInfo');
        });
    },
    getFormats : function(params) {
        var result = [ 'grid', 'tile', 'vtile' ];
        if (params && _.isArray(params.formats)) {
            result = _.filter(result, function(format) {
                return _.contains(params.formats, format);
            })
        }
        return Q(result);
    },
    _getTileSourceCacheTTL : function() {
        return this.options.tileSourceCacheTTL || 60 * 60 * 1000;
    },
    _isVectorTiles : function(params) {
        return params.format == 'vtile';
    },
    _getSourceCacheKey : function(params) {
        var suffix = this._isVectorTiles(params) ? '-vector' : '-tile';
        return this._getSourceKey(params, suffix);
    },
    // Load a tileSource and set it in the cache
    _getTileSource : function(params) {
        var that = this;
        var suffix = undefined;
        var loadSourcePromise;
        var sourceKey = that._getSourceCacheKey(params);
        return Q().then(function() {
            var tileSource = that.sourceCache.get(sourceKey);
            if (tileSource) {
                return tileSource;
            }
            var index = that._sourceLoadingIndex || {};
            that._sourceLoadingIndex = index;
            var promise = index[sourceKey];
            if (!promise) {
                promise = index[sourceKey] = Q().then(function() {
                    return that.tileSourceProvider.loadTileSource(params);
                }).then(function(uri) {
                    if (that._isVectorTiles(params)) {
                        return that._newTileBridge(params, uri);
                    } else {
                        return that._newTileliveSource(params, uri);
                    }
                }).fin(function() {
                    delete index[sourceKey];
                });
            }
            return promise
        }).then(function(tileSource) {
            that.sourceCache.set(sourceKey, tileSource);
            return tileSource;
        });
    },
    _newTileliveSource : function(params, uri) {
        var that = this;
        return Q.ninvoke(FS, 'readFile', uri.path, 'UTF-8').then(function(xml) {
            var url = {
                pathname : uri.path,
                base : uri.base,
                xml : xml
            }
            if (that.options.useVectorTiles) {
                return that._newTileliveSource1(params, url);
            } else {
                return that._newTileliveSource0(params, url);
            }
        });
    },

    _newTileliveSource0 : function(params, uri) {
        var url = _.extend({}, uri, {
            protocol : 'mapnik:'
        });
        return Q.ninvoke(Tilelive, 'load', url);
        // var url = 'mapnik://' + uri.path;
        // return Q.ninvoke(Tilelive, 'load', url);
    },

    _newTileliveSource1 : function(params, uri) {
        var that = this;
        function replaceProjection(str) {
            if (!str)
                return str;
            return str.replace(/srs=".*?"/gim, function(match) {
                return 'srs="+proj=merc ' + '+a=6378137 +b=6378137 '
                        + '+lat_ts=0.0 +lon_0=0.0 '
                        + '+x_0=0.0 +y_0=0.0 +k=1.0 '
                        + '+units=m +nadgrids=@null '
                        + '+wktext +no_defs +over"';
            });
        }
        return that._getTileSource(_.extend({}, params, {
            format : 'vtile'
        })).then(function(vtileSource) {
            var tilesUri = _.extend({}, uri, {
                protocol : 'vector:',
                source : {
                    protocol : 'tilepin:',
                    source : vtileSource
                }
            });
            tilesUri.xml = replaceProjection(tilesUri.xml);
            return Q.ninvoke(Tilelive, 'load', tilesUri);
        });
    },
    _newTileBridge : function(params, uri) {
        var that = this;
        return Q().then(function() {
            var deferred = Q.defer();
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
})

function VectorTilesProvider(options) {
    this.options = options || {};
}
_.extend(VectorTilesProvider.prototype, TilesProvider.prototype, {
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
    }
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
