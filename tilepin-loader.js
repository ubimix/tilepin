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
var Yaml = require('js-yaml');

var CartoJsonCss = require('./carto-json-css');
var Carto = require('carto');
var AdmZip = require('adm-zip');
var LRU = require('lru-cache');
var Commons = require('./tilepin-commons');
var P = Commons.P;

module.exports = TileMillProjectLoader;

/* -------------------------------------------------------------------------- */
/**
 * 
 */
function TileMillProjectLoader(options) {
    this.options = options || {};
    if (!this.options.dir) {
        this.options.dir = './';
    }
    Commons.addEventTracing(this, [ 'clearProject', 'loadProject' ]);
}
_.extend(TileMillProjectLoader.prototype, Commons.Events, {

    clearProject : function(params) {
        var that = this;
        return P().then(function() {
            var sourceKey = params.source;
            var xmlTilepinFile = that._getTilepinProjectFile(sourceKey);
            if (!FS.existsSync(xmlTilepinFile))
                return true;
            return P.nfcall(FS.unlink, xmlTilepinFile).then(function() {
                return true;
            }, function(err) {
                // File does not exist anymore.
                if (err.code == 'ENOENT')
                    return true;
                throw err;
            });
        });
    },

    /**
     * This method loads and returns an object containing tilesource XML and a
     * base directory for this tilesource.
     */
    loadProject : function(params) {
        var that = this;
        var baseDir;
        var sourceFile;
        var that = this;
        return P().then(function() {
            return that._prepareTileSourceFile(params);
        }).then(function(file) {
            sourceFile = file;
            baseDir = Path.dirname(sourceFile);
            return {
                base : baseDir,
                pathname : sourceFile,
                path : sourceFile
            };
        }).then(
                function(uri) {
                    return P.ninvoke(FS, 'readFile', uri.pathname, 'UTF-8')
                            .then(function(xml) {
                                uri.xml = xml;
                                return uri;
                            })
                })
    },

    _getTileSourceDir : function(sourceKey) {
        var dir = this.options.dir || this.options.styleDir || __dirname;
        dir = Path.join(dir, sourceKey);
        dir = Path.resolve(dir);
        return dir;
    },
    _getTileSourceFile : function(sourceKey, fileName) {
        var dir = this._getTileSourceDir(sourceKey);
        var fullPath = Path.join(dir, fileName);
        return fullPath;
    },

    _findDataIndex : function(dir, url) {
        return P.nfcall(FS.readdir, dir).then(function(list) {
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
        var promise = P();
        if (!FS.existsSync(dataDir)) {
            promise = promise.then(function() {
                var segments = dataDir.split('/');
                var p = '';
                _.each(segments, function(segment) {
                    p = (p == '' && segment == '') ? '/' : Path
                            .join(p, segment);
                    if (!FS.existsSync(p)) {
                        FS.mkdirSync(p);
                    }
                });
            })
        }
        return promise.then(function() {
            if (!FS.existsSync(dataFileName)) {
                return that._download(dataFileName, url)
            }
        }).then(function() {
            return that._unzip(dataFileName, dataDir);
        }).then(function() {
            return dataDir;
        });
    },

    _getMaxRedirects : function() {
        return 10;
    },

    _download : function(dataFileName, url) {
        var that = this;
        function httpGet(options, redirectCount) {
            var diferred = P.defer();
            try {
                if (redirectCount >= that._getMaxRedirects()) {
                    throw new Error('Too many redirections. (' + redirectCount
                            + ').');
                }
                Http.get(options, function(res) {
                    try {
                        var result = null;
                        if (res.statusCode > 300 && res.statusCode < 400
                                && res.headers.location) {
                            var location = res.headers.location;
                            var newUrl = Url.parse(location);
                            if (!newUrl.hostname) {
                                options.path = location;
                            }
                            result = httpGet(newUrl, redirectCount++);
                        } else {
                            result = res;
                        }
                        diferred.resolve(result);
                    } catch (e) {
                        diferred.reject(e);
                    }
                });
            } catch (e) {
                diferred.reject(e);
            }
            return diferred.promise;
        }
        var dataDir = Path.dirname(dataFileName);
        function f() {
        }
        return P.nfcall(FS.mkdir, dataDir).then(f, f).then(function() {
            var options = Url.parse(url);
            return httpGet(options, 0).then(function(res) {
                var diferred = P.defer();
                try {
                    var file = FS.createWriteStream(dataFileName);
                    res.pipe(file);
                    file.on('finish', function() {
                        file.close();
                        diferred.resolve(true);
                    });
                } catch (e) {
                    diferred.reject(e);
                }
                return diferred.promise;
            });
        });
    },

    _unzip : function(zipFile, dataDir) {
        var zip = new AdmZip(zipFile);
        var zipEntries = zip.getEntries(); // an array of ZipEntry records
        return P.all(_.map(zipEntries, function(zipEntry) {
            var file = Path.join(dataDir, zipEntry.entryName);
            zip.extractEntryTo(zipEntry.entryName, dataDir, true, true);
        }));
    },

    _getDbCredentials : function(params, datasource) {
        var that = this;
        return P().then(function() {
            var sourceKey = params.source;
            if (_.isFunction(that.options.db)) {
                return that.options.db(sourceKey, datasource);
            } else {
                var dbOptions = that.options.db || {};
                return dbOptions[sourceKey];
            }
        })
    },

    _readProjectFile : (function() {
        var TYPES = [ {
            name : 'project.yml',
            parse : function(str) {
                var obj = Yaml.load(str);
                if (!obj.format) {
                    obj.format = 'pbf';
                }
                return obj;
            }
        }, {
            name : 'project.mml',
            parse : function(str) {
                return JSON.parse(str);
            },
        } ];
        return function(dir, params) {
            return P().then(function() {
                var fileInfo = null;
                var file = null;
                _.find(TYPES, function(info) {
                    var path = Path.join(dir, info.name);
                    if (FS.existsSync(path)) {
                        fileInfo = info;
                        file = path;
                    }
                    return !!fileInfo;
                })
                if (!fileInfo) {
                    var msg = 'Project file not found (';
                    msg += _.map(TYPES, function(info) {
                        return info.name;
                    }).join(' / ');
                    msg += '). Dir: "' + dir + '".';
                    throw new Error(msg);
                }
                return P.nfcall(FS.readFile, file, 'utf8').then(function(data) {
                    var obj = fileInfo.parse(data);
                    return obj;
                });
            });
        }
    })(),

    /**
     * @param projectDir
     * @param xmlFile
     * @param params
     * @returns a promise//
     */
    _buildXmlStyleFile : function(projectDir, xmlFile, params) {
        var that = this;
        var xmlDir = Path.dirname(xmlFile);
        return that._readProjectFile(projectDir, params).then(function(json) {
            console.log('CONFIGURATION: ', JSON.stringify(json, null, 2))
            return P.all([ processDataSources(json), loadMmlStyles(json) ])//
            .then(function() {
                var renderer = new Carto.Renderer({
                    filename : xmlFile,
                    local_data_dir : xmlDir,
                });
                return P.ninvoke(renderer, 'render', json);
            });
        }).then(function(xml) {
            return P.nfcall(FS.writeFile, xmlFile, xml);
        });
        function prepareFileSource(dataLayer) {
            var url = dataLayer.Datasource.file;
            var promise = P();
            if (url && url.match(/^https?:\/\/.*$/gim)) {
                var layersDir = Path.join(projectDir, 'layers');
                promise = that._downloadAndUnzip(url, layersDir).then(
                        function(dataDir) {
                            return that._findDataIndex(dataDir, url);
                        }).then(function(filePath) {
                    // dataLayer.Datasource.file = Path.relative(xmlDir,
                    // filePath);
                    dataLayer.Datasource.file = filePath;
                    dataLayer.Datasource.type = 'shape';
                });
            }
            return promise.then(function(result) {
                if (dataLayer.Datasource.file) {
                    dataLayer.Datasource.file = Path.resolve(xmlDir,
                            dataLayer.Datasource.file);
                }
                return result;
            });
        }
        function prepareDbSource(dataLayer) {
            return that._getDbCredentials(params, dataLayer.Datasource).then(
                    function(data) {
                        _.extend(dataLayer.Datasource, data);
                    });
        }
        function processDataSources(styleJSON) {
            return P.all(_.map(styleJSON.Layer, function(dataLayer) {
                if (!dataLayer.Datasource)
                    return;
                var result;
                var url = dataLayer.Datasource.file;
                switch (dataLayer.Datasource.type) {
                case 'postgis':
                    result = prepareDbSource(dataLayer);
                    break;
                default:
                    if (url) {
                        result = prepareFileSource(dataLayer);
                    }
                    break;
                }
                return result;
            }))
        }
        function loadMmlStyles(styleJSON) {
            return P.all(_.map(styleJSON.Stylesheet, function(stylesheet) {
                return that._loadMmlStyle(projectDir, stylesheet);
            })).then(function(styles) {
                styleJSON.Stylesheet = styles;
                return styleJSON;
            });
        }
    },

    _loadMmlStyle : function(dir, stylesheet) {
        var promise = P();
        var id;
        if (_.isString(stylesheet)) {
            id = stylesheet;
            var fullPath = Path.join(dir, stylesheet);
            if (Path.extname(fullPath) == '.js') {
                promise = P().then(function() {
                    var obj = require(fullPath);
                    return _.isFunction(obj) ? obj() : obj;
                })
            } else {
                promise = P.nfcall(FS.readFile, fullPath, 'utf8');
            }
        } else {
            promise = P(stylesheet.cartocss);
            delete stylesheet.cartocss;
            id = stylesheet.id;
        }
        return promise.then(function(css) {
            if (!id) {
                id = _.uniqueId('cartocss-');
            }
            if (_.isObject(css)) {
                var converter = new CartoJsonCss.CartoCssSerializer();
                css = converter.serialize(css);
            }
            return {
                id : id,
                data : css
            };
        })
    },

    _getTilepinProjectFile : function(sourceKey) {
        return this._getTileSourceFile(sourceKey, 'project.tilepin.xml');
    },

    _prepareTileSourceFile : function(params) {
        var that = this;
        var sourceKey = params.source;
        var xmlFile = that._getTileSourceFile(sourceKey, 'project.xml');
        var xmlTilepinFile = that._getTilepinProjectFile(sourceKey);
        var promise;
        if (FS.existsSync(xmlFile)) {
            return P(xmlFile);
        } else if (FS.existsSync(xmlTilepinFile)) {
            return P(xmlTilepinFile);
        } else {
            that._loadingStyles = that._loadingStyles || {};
            var promise = that._loadingStyles[xmlTilepinFile];
            if (!promise) {
                var projectDir = that._getTileSourceDir(sourceKey);
                promise = that._loadingStyles[xmlTilepinFile] = that
                        ._buildXmlStyleFile(projectDir, xmlTilepinFile, params)
                        .fin(function() {
                            delete that._loadingStyles[xmlTilepinFile];
                        });
            }
            return promise.then(function() {
                return xmlTilepinFile;
            });
        }
    },

});
