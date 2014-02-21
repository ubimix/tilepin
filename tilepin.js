var _ = require('underscore');
var Path = require('path')
var FS = require('fs');

var Q = require('q');
var Tilelive = require('tilelive');
require('tilelive-mapnik').registerProtocols(Tilelive);
var LRU = require('lru-cache');

var CartoJsonCss = require('./carto-json-css');
var Carto = require('carto')

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
    this.sourceCache = new CachingTiles.MemCache({
        maxAge : this._getTileSourceCacheTTL()
    });
    this.tileCache = options.tileCache || new CachingTiles.MemCache();
    this.headersCache = options.headersCache || new CachingTiles.MemCache();
}
_.extend(CachingTiles.prototype, {

    invalidateStyle : function(params) {
        var that = this;
        return Q().then(
                function() {
                    var cacheKey = that._getTileCacheKey(params);
                    return Q.all([ that.tileCache.reset(cacheKey),
                            that.headersCache.reset(cacheKey) ])
                }).then(function() {
            var cacheKey = that._getTileSourceCacheKey(params);
            return that.sourceCache.reset(cacheKey);
        })
    },

    getTile : function(params) {
        var that = this;
        var cacheKey = that._getTileCacheKey(params);
        function loadFromCache() {
            return Q.all(
                    [ that.tileCache.get(cacheKey),
                            that.headersCache.get(cacheKey) ]).then(
                    function(arr) {
                        if (arr[0] && arr[1]) {
                            return {
                                tile : arr[0],
                                headers : arr[1]
                            }
                        }
                        return null;
                    });
        }
        function storeToCache(result) {
            return Q.all(
                    [ that.tileCache.set(cacheKey, result.tile),
                            that.headersCache.set(cacheKey, result.headers) ])
                    .then(function() {
                        return result;
                    });
        }
        return loadFromCache().then(function(result) {
            if (result)
                return result;
            return that.loadTile(params).then(storeToCache);
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
        var array = [];
        if (this.sourceCache.close)
            array.push(this.sourceCache.close());
        if (this.tileCache.close)
            array.push(this.tileCache.close());
        if (this.headersCache.close)
            array.push(this.headersCache.close());
        return Q(array);
    },

    _getTileCacheKey : function(params) {
        var source = params.source;
        var x = +params.x;
        var y = +params.y;
        var zoom = params.z;
        var format;
        if (params.format && params.format != '') {
            format = params.format === 'grid.json' ? 'grid' : 'tile';
        }
        var array = [];
        _.each([ format, zoom, x, y ], function(n) {
            if (n) {
                array.push(n);
            }
        })
        var cacheKey = [ source ];
        if (array.length) {
            cacheKey.push(array.join('-'));
        }
        return cacheKey;
    },

    _getTileSourceFile : function(sourceKey, fileName) {
        var dir = this.options.styleDir || __dirname;
        dir = Path.join(dir, sourceKey);
        dir = Path.resolve(dir);
        var fullPath = Path.join(dir, fileName);
        return fullPath;
    },

    /**
     * @param mmlFile
     * @param xmlFile
     * @param params
     * @returns a promise//
     */
    _buildXmlStyleFile : function(mmlFile, xmlFile, params) {
        var that = this;
        return Q().then(function() {
            return Q.nfcall(FS.readFile, mmlFile, 'utf8');
        }).then(function(str) {
            // var options = this.options || {};
            // str = _.template(str, options)
            return JSON.parse(str);
        }).then(function(styleJSON) {
            var dir = Path.dirname(mmlFile);
            return Q.all(_.map(styleJSON.Stylesheet, function(stylesheet) {
                return that._loadMmlStyle(dir, stylesheet);
            })).then(function(styles) {
                styleJSON.Stylesheet = styles;
                return styleJSON;
            });
        }).then(function(styleJSON) {
            var renderer = new Carto.Renderer({
                filename : xmlFile,
                local_data_dir : Path.dirname(xmlFile),
            });
            var deferred = Q.defer();
            renderer.render(styleJSON, deferred.makeNodeResolver());
            return deferred.promise;
        }).then(function(xml) {
            return Q.nfcall(FS.writeFile, xmlFile, xml);
        });
    },

    _loadMmlStyle : function(dir, stylesheet) {
        if (_.isString(stylesheet)) {
            var fullPath = Path.join(dir, stylesheet);
            return Q.nfcall(FS.readFile, fullPath, 'utf8').then(function(css) {
                return {
                    id : stylesheet,
                    data : css
                }
            });
        } else if (stylesheet.cartocss) {
            var css = stylesheet.cartocss;
            if (_.isObject(stylesheet.cartocss)) {
                var converter = new CartoJsonCss.CartoCssSerializer();
                var css = converter.serialize(stylesheet.cartocss);
            }
            stylesheet.data = css;
            delete stylesheet.cartocss;
            return Q(stylesheet);
        }
    },

    _prepareTileSourceFile : function(params) {
        var that = this;
        var sourceKey = params.source;
        var mmlFile = that._getTileSourceFile(sourceKey, 'project.mml');
        var xmlFile = that._getTileSourceFile(sourceKey, 'project.xml');
        var promise;
        if (FS.existsSync(xmlFile)) {
            return Q(xmlFile);
        } else {
            return that._buildXmlStyleFile(mmlFile, xmlFile, params).then(
                    function() {
                        return xmlFile;
                    });
        }
    },

    _loadTileSource : function(params) {
        return this._prepareTileSourceFile(params).then(function(sourceFile) {
            // See:
            // *
            // https://github.com/mapbox/tilemill/issues/971
            // *
            // https://github.com/mapbox/tilelive-mapnik/commit/c741c3ffa1afe7acfa71f89c591b835e0e70ed44
            // *
            // https://github.com/mapbox/tilelive-mapnik/blob/4e9cbf8347eba7c3c2b7e8fd4270ea39f9cc7af5/test/data/test.xml#L6-L7
            var uri = 'mapnik://' + sourceFile;
            return Q.ninvoke(Tilelive, 'load', uri);
        })
    },

    _getTileSourceCacheTTL : function() {
        return this.options.tileSourceCacheTTL || 60 * 60 * 1000;
    },
    _getTileSourceCacheKey : function(params) {
        return [ params.source ];
    },
    _getTileSource : function(params) {
        var that = this;
        var cacheKey = this._getTileSourceCacheKey(params);
        return that.sourceCache.get(cacheKey).then(
                function(tileSource) {
                    if (tileSource) {
                        return tileSource;
                    }
                    // Load tileSource and set it in thecache
                    return that._loadTileSource(params).then(
                            function(tileSource) {
                                return that.sourceCache.set(cacheKey,
                                        tileSource).then(function() {
                                    return tileSource;
                                });
                            });
                })
    },

})
CachingTiles.MemCache = function(options) {
    this.options = options || {};
    this.cache = new LRU(this.options);
}
_.extend(CachingTiles.MemCache.prototype, {
    _getCache : function(key) {
        var name = key[0];
        var result = this.cache.get(name);
        if (!result) {
            result = new LRU(this.options);
            this.cache.set(name, result);
        }
        return result;
    },
    _getKeyId : function(key) {
        key = _.toArray(key).join('/');
        return key;
    },
    reset : function(key) {
        key = _.toArray(key);
        var name = key[0];
        this.cache.del(name);
        return Q();
    },
    get : function(key) {
        key = _.toArray(key);
        var cache = this._getCache(key);
        var id = this._getKeyId(key);
        return Q(cache.get(id));
    },
    set : function(key, value) {
        key = _.toArray(key);
        var cache = this._getCache(key);
        var id = this._getKeyId(key);
        return Q(cache.set(id, value));
    },
})

module.exports = CachingTiles;
