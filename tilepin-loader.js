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

function deleteFile(file) {
    if (!FS.existsSync(file))
        return P(true);
    return P.nfcall(FS.unlink, file).then(function() {
        return true;
    }, function(err) {
        // File does not exist anymore.
        if (err.code == 'ENOENT')
            return true;
        throw err;
    });
}

function readString(file) {
    return P.ninvoke(FS, 'readFile', file, 'UTF-8');
}
function writeString(file, str) {
    return P.ninvoke(FS, 'writeFile', file, str, 'UTF-8');
}
function readJson(file) {
    return readString(file).then(function(str) {
        try {
            return JSON.parse(str);
        } catch (e) {
            return {};
        }
    });
}
function writeJson(file, json) {
    json = json || {};
    var str = JSON.stringify(json);
    return writeString(file, str);
}

_.extend(TileMillProjectLoader.prototype, Commons.Events, {

    clearProject : function(params) {
        var that = this;
        return P().then(function() {
            var sourceKey = that._getSourceKey(params);
            var files = [];
            files.push(that._getTilepinProjectFile(sourceKey));
            files.push(that._getTilepinPropertiesFile(sourceKey));
            return P.all(_.map(files, function(file) {
                return deleteFile(file);
            }));
        });
    },

    /**
     * This method loads and returns an object containing tilesource XML and a
     * base directory for this tilesource.
     */
    loadProject : function(params) {
        var that = this;
        if (that._isRemoteProject(params)) {
            return that._loadRemoteProject(params);
        } else {
            return that._loadLocalProject(params);
        }
    },

    _getSourceKey : function(params) {
        return params.source || '';
    },

    _isRemoteProject : function(params) {
        var sourceKey = this._getSourceKey(params);
        return sourceKey.indexOf(':') > 0;
    },

    _loadRemoteProject : function(params) {
        var sourceKey = this._getSourceKey(params);
        return P().then(function() {
            var result = Url.parse(sourceKey);
            return result;
        });
    },

    _loadLocalProject : function(params) {
        var files;
        var that = this;
        return P().then(function() {
            return that._prepareProjectFiles(params);
        }).then(function(f) {
            files = f;
            return P.all([ readString(files[0]), readJson(files[1]) ]);
        }).then(function(array) {
            var xml = array[0];
            var properties = array[1];
            return {
                base : Path.dirname(files[0]),
                pathname : files[0],
                path : files[0],
                properties : properties,
                protocol : 'mapnik:',
                xml : xml
            };
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

    _readProjectFile : (function() {
        var TYPES = [ {
            name : 'project.yml',
            parse : function(str) {
                var obj = Yaml.load(str);
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
                return readString(file).then(function(data) {
                    var obj = fileInfo.parse(data);
                    if (params.dumpConfigAsYaml) {
                        console.log(Yaml.dump(obj));
                    } else if (params.dumpConfigAsJSON) {
                        console.log(JSON.stringify(obj, null, 2));
                    }
                    return obj;
                });
            });
        }
    })(),

    _generateMapnikXml : function(xmlFile, json) {
        var xmlDir = Path.dirname(xmlFile);
        var renderer = new Carto.Renderer({
            filename : xmlFile,
            local_data_dir : xmlDir,
        });
        return P.ninvoke(renderer, 'render', json);
    },

    _prepareProjectConfiguration : function(projectDir, params) {
        var that = this;
        return that._readProjectFile(projectDir, params).then(function(json) {
            return P.all([ processDataSources(json), loadProjectStyles(json) ])
            //
            .then(function() {
                return json;
            });
        });
        function processDataSources(styleJSON) {
            var options = that.options;
            var f = options['handleDatalayer'];
            f = _.isFunction(f) ? f : undefined;
            return P.all(_.map(styleJSON.Layer, function(dataLayer) {
                if (!dataLayer.Datasource)
                    return;
                var result;
                switch (dataLayer.Datasource.type) {
                case 'postgis':
                    result = prepareDbSource(dataLayer);
                    break;
                default:
                    var url = dataLayer.Datasource.file;
                    if (url) {
                        result = prepareFileSource(dataLayer);
                    }
                    break;
                }
                if (!result) {
                    result = P();
                }
                return result.then(function() {
                    return f ? f.call(options, {
                        projectDir : projectDir,
                        params : params,
                        dataLayer : dataLayer
                    }) : undefined;
                });
            }))
        }
        function loadProjectStyles(styleJSON) {
            return P.all(_.map(styleJSON.Stylesheet, function(stylesheet) {
                return that._loadProjectStyle(projectDir, stylesheet);
            })).then(function(styles) {
                styleJSON.Stylesheet = styles;
                return styleJSON;
            });
        }
        function prepareDbSource(dataLayer) {
            return P() //
            .then(function() {
                var file = dataLayer.Datasource.file;
                var table = dataLayer.Datasource.table;
                if (file && !table) {
                    file = Path.join(projectDir, file);
                    return readString(file).then(function(content) {
                        delete dataLayer.Datasource.file;
                        dataLayer.Datasource.table = '(' // 
                                + content + ') as data';
                    });
                }
            });
        }
        function prepareFileSource(dataLayer) {
            var url = dataLayer.Datasource.file;
            var promise = P();
            if (url && url.match(/^https?:\/\/.*$/gim)) {
                var layersDir = Path.join(projectDir, 'layers');
                promise = that._downloadAndUnzip(url, layersDir).then(
                        function(dataDir) {
                            return that._findDataIndex(dataDir, url);
                        }).then(function(filePath) {
                    dataLayer.Datasource.file = filePath;
                    dataLayer.Datasource.type = 'shape';
                });
            }
            return promise.then(function(result) {
                if (dataLayer.Datasource.file) {
                    dataLayer.Datasource.file = Path.resolve(projectDir,
                            dataLayer.Datasource.file);
                }
                return result;
            });
        }

    },

    _loadProjectStyle : function(dir, stylesheet) {
        var promise = P();
        var id;
        if (_.isString(stylesheet)) {
            id = stylesheet;
            var fullPath = Path.join(dir, stylesheet);
            if (Path.extname(fullPath) == '.js') {
                promise = P().then(function() {
                    // Cleanup the cache
                    var name = require.resolve(fullPath);
                    delete require.cache[name];
                    // Load the module again
                    var obj = require(fullPath);
                    return _.isFunction(obj) ? obj() : obj;
                })
            } else {
                promise = readString(fullPath);
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
        var fileName = 'project.tilepin.xml';
        return this._getTileSourceFile(sourceKey, fileName);
    },
    _getTilepinPropertiesFile : function(sourceKey) {
        var fileName = 'project.tilepin.properties';
        return this._getTileSourceFile(sourceKey, fileName);
    },

    _prepareProjectFiles : function(params) {
        var that = this;
        var sourceKey = that._getSourceKey(params);
        var xmlTilepinFile = that._getTilepinProjectFile(sourceKey);
        var propertiesTilepinFile = that._getTilepinPropertiesFile(sourceKey);
        return P.all([ checkXmlFile(), checkPropertiesFile() ]).then(
                function(files) {
                    if (files[0] && files[1]) {
                        return files;
                    }
                    that._loadingStyles = that._loadingStyles || {};
                    var promise = that._loadingStyles[sourceKey];
                    if (!promise) {
                        var projectDir = that._getTileSourceDir(sourceKey);
                        promise = that._loadingStyles[sourceKey] = that
                                ._prepareProjectConfiguration(projectDir,
                                        params).then(function(json) {
                                    var promises = [];
                                    promises.push(writeXmlFile(json));
                                    promises.push(writePropertiesFile(json));
                                    return P.all(promises);
                                }).fin(function() {
                                    delete that._loadingStyles[sourceKey];
                                });
                    }
                    return promise.then(function() {
                        return [ xmlTilepinFile, propertiesTilepinFile ];
                    });
                });
        function checkXmlFile() {
            var xmlFile = that._getTileSourceFile(sourceKey, 'project.xml');
            if (FS.existsSync(xmlFile)) {
                return P(xmlFile);
            } else if (FS.existsSync(xmlTilepinFile)) {
                return P(xmlTilepinFile);
            } else {
                return P(null);
            }
        }
        function writeXmlFile(json) {
            return that._generateMapnikXml(xmlTilepinFile, json).then(
                    function(xml) {
                        return writeString(xmlTilepinFile, xml);
                    });
        }
        function checkPropertiesFile() {
            if (FS.existsSync(propertiesTilepinFile)) {
                return P(propertiesTilepinFile);
            } else {
                return P(null);
            }
        }
        function writePropertiesFile(json) {
            return writeJson(propertiesTilepinFile, json.properties);
        }
    },

});
