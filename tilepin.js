var _ = require('underscore');
var Path = require('path')
var Url = require('url');
var FS = require('fs');
var Crypto = require('crypto');

var Q = require('q');
var Tilelive = require('tilelive');
require('tilelive-mapnik').registerProtocols(Tilelive);
var LRU = require('lru-cache');

var CartoJsonCss = require('./carto-json-css');
var Carto = require('carto');
var AdmZip = require('adm-zip');

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
}
_.extend(CachingTiles.prototype, {

    invalidateStyle : function(params) {
        var that = this;
        var sourceKey = params.source;
        return Q().then(function() {
            var key = that._getTileCacheKey(params, 'tile');
            if (!key) {
                return that.tileCache.reset(sourceKey);
            } else {
                return that.tileCache.reset(sourceKey, key).then(function() {
                    var key = that._getTileCacheKey(params, 'grid');
                    return that.tileCache.reset(sourceKey, key);
                });
            }
        }).then(function() {
            var tileSource = that.sourceCache.get(sourceKey);
            that.sourceCache.del(sourceKey)
            if (tileSource) {
                return Q.ninvoke(tileSource, 'close');
            }
        }).then(function() {
            var xmlTilepinFile = that._getTilepinProjectFile(sourceKey);
            if (!FS.existsSync(xmlTilepinFile))
                return true;
            return Q.nfcall(FS.unlink, xmlTilepinFile).then(function() {
                return true;
            }, function(e) {
                // Just log errors...
                var msg = 'Can not remove ' + 'the "';
                msg += xmlTilepinFile;
                msg += '" project file';
                console.log(msg, e);
                return true;
            });
        })
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

    _getTileCacheKey : function(params, format) {
        var x = +params.x;
        var y = +params.y;
        var zoom = params.z;
        var array = [];
        _.each([ zoom, x, y ], function(n) {
            if (n) {
                array.push(n);
            }
        })
        var key = array.join('-');
        if (key != '') {
            key = format + '-' + key;
        } else {
            key = undefined;
        }
        return key;
    },

    _getTileSourceFile : function(sourceKey, fileName) {
        var dir = this.options.dir || this.options.styleDir || __dirname;
        dir = Path.join(dir, sourceKey);
        dir = Path.resolve(dir);
        var fullPath = Path.join(dir, fileName);
        return fullPath;
    },

    _findDataIndex : function(dir, url) {
        return Q.nfcall(FS.readdir, dir).then(function(list) {
            var result = null;
            _.each(list, function(file) {
                if (file.lastIndexOf('.shp') > 0) {
                    result = Path.join(dir, file);
                }
            })
            return result;
        })
    },

    _getSha1 : function(str) {
        var shasum = Crypto.createHash('sha1');
        shasum.update(str);
        var hash = shasum.digest('hex');
        return hash;
    },
    _downloadAndUnzip : function(url, dir) {
        var that = this;
        var obj = Url.parse(url);
        var ext = Path.extname(obj.pathname);
        var path = Path.basename(obj.pathname, ext) || '.tmp-'
                + that._getSha1(url);
        var dataDir = Path.join(dir, path);
        var dataFileName = Path.join(dataDir, Path.basename(obj.pathname));
        return Q().then(function() {
            var segments = dataDir.split('/');
            var p = '';
            _.each(segments, function(segment) {
                p = (p == '' && segment == '') ? '/' : Path.join(p, segment);
                if (!FS.existsSync(p)) {
                    FS.mkdirSync(p);
                }
            });
        }).then(function() {
            if (!FS.existsSync(dataFileName)) {
                return that._download(dataFileName, url)
            }
        }).then(function() {
            return that._unzip(dataFileName, dataDir);
        }).then(function() {
            return dataDir;
        });
    },

    _download : function(dataFileName, url) {
        var dataDir = Path.dirname(dataFileName);
        function f() {
        }
        return Q.nfcall(FS.mkdir, dataDir).then(f, f).then(function() {
            var diferred = Q.defer();
            var http = require('http');
            var file = FS.createWriteStream(dataFileName);
            try {
                var request = http.get(url, function(response) {
                    try {
                        response.pipe(file);
                        file.on('finish', function() {
                            file.close();
                            diferred.resolve(true);
                        });
                    } catch (e) {
                        diferred.reject(e);
                    }
                });
            } catch (e) {
                diferred.reject(e);
            }
            return diferred.promise;
        });
    },

    _unzip : function(zipFile, dataDir) {
        var zip = new AdmZip(zipFile);
        var zipEntries = zip.getEntries(); // an array of ZipEntry records
        return Q.all(_.map(zipEntries, function(zipEntry) {
            var file = Path.join(dataDir, zipEntry.entryName);
            zip.extractEntryTo(zipEntry.entryName, dataDir, true, true);
        }));
    },

    _getDbCredentials : function(params, datasource) {
        var that = this;
        return Q().then(function() {
            var sourceKey = params.source;
            if (_.isFunction(that.options.db)) {
                return that.options.db(sourceKey, datasource);
            } else {
                var dbOptions = that.options.db || {};
                return dbOptions[sourceKey];
            }
        })
    },

    /**
     * @param mmlFile
     * @param xmlFile
     * @param params
     * @returns a promise//
     */
    _buildXmlStyleFile : function(mmlFile, xmlFile, params) {
        var that = this;
        var dir = Path.dirname(mmlFile);
        var layersDir = Path.join(dir, 'layers');
        function prepareFileSource(dataLayer) {
            var url = dataLayer.Datasource.file;
            if (!url.match(/^https?:\/\/.*$/gim)) {
                return Q();
            }
            return that._downloadAndUnzip(url, layersDir).then(
                    function(dataDir) {
                        return that._findDataIndex(dataDir, url);
                    }).then(function(filePath) {
                dataLayer.Datasource.file = filePath;
                dataLayer.Datasource.type = 'shape';
            })
        }
        function prepareDbSource(dataLayer) {
            return that._getDbCredentials(params, dataLayer.Datasource).then(
                    function(data) {
                        _.extend(dataLayer.Datasource, data);
                    });
        }
        function downloadRemoteFiles(styleJSON) {
            return Q.all(_.map(styleJSON.Layer, function(dataLayer) {
                if (!dataLayer.Datasource)
                    return;
                var url = dataLayer.Datasource.file;
                if (url) {
                    return prepareFileSource(dataLayer);
                } else if (dataLayer.Datasource.type == 'postgis') {
                    return prepareDbSource(dataLayer);
                }
            }))
        }
        function loadMmlStyles(styleJSON) {
            return Q.all(_.map(styleJSON.Stylesheet, function(stylesheet) {
                return that._loadMmlStyle(dir, stylesheet);
            })).then(function(styles) {
                styleJSON.Stylesheet = styles;
                return styleJSON;
            });
        }
        return Q().then(function() {
            return Q.nfcall(FS.readFile, mmlFile, 'utf8');
        }).then(function(str) {
            // var options = this.options || {};
            // str = _.template(str, options)
            return JSON.parse(str);
        }).then(function(json) {
            return Q.all([ downloadRemoteFiles(json), loadMmlStyles(json) ])//
            .then(function() {
                var renderer = new Carto.Renderer({
                    filename : xmlFile,
                    local_data_dir : Path.dirname(xmlFile),
                });
                var deferred = Q.defer();
                renderer.render(json, deferred.makeNodeResolver());
                return deferred.promise;
            });
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
                css = converter.serialize(stylesheet.cartocss);
            }
            stylesheet.data = css;
            delete stylesheet.cartocss;
            return Q(stylesheet);
        }
    },

    _getTilepinProjectFile : function(sourceKey) {
        return this._getTileSourceFile(sourceKey, 'project.tilepin.xml');
    },

    _prepareTileSourceFile : function(params) {
        var that = this;
        var sourceKey = params.source;
        var mmlFile = that._getTileSourceFile(sourceKey, 'project.mml');
        var xmlFile = that._getTileSourceFile(sourceKey, 'project.xml');
        var xmlTilepinFile = that._getTilepinProjectFile(sourceKey);
        var promise;
        if (FS.existsSync(xmlFile)) {
            return Q(xmlFile);
        } else if (FS.existsSync(xmlTilepinFile)) {
            return Q(xmlTilepinFile);
        } else {
            return that._buildXmlStyleFile(mmlFile, xmlTilepinFile, params)
                    .then(function() {
                        return xmlTilepinFile;
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
