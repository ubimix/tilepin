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
var AdmZip = require('adm-zip');
var LRU = require('lru-cache');
var Tilepin = require('./lib/');

module.exports = ProjectLoader;

/* -------------------------------------------------------------------------- */
/**
 * 
 */
function ProjectLoader(options) {
    this.options = options || {};
    if (!this.options.dir) {
        this.options.dir = './';
    }
    this._promises = {};
    Tilepin.Events.Mixin
            .addEventTracing(this,
                    [ 'clearProjectConfig', 'loadProjectConfig' ]);
}

_.extend(ProjectLoader.prototype, Tilepin.Events, {

    clearProjectConfig : function(projectDir) {
        var that = this;
        var promise = that._promises[projectDir];
        delete that._promises[projectDir];
        return promise;
    },

    processProjectConfig : function(projectDir, projectInfo) {
        var that = this;
        var promises = [];
        var conf = projectInfo.config;
        promises.push(that._processDataSources(projectDir, conf));
        promises.push(that._loadProjectStyles(projectDir, conf));
        return Tilepin.P.all(promises).then(function() {
            return projectInfo;
        });
    },

    loadProjectConfig : function(projectDir) {
        var that = this;
        return that._readProjectFile(projectDir);
    },

    _findDataIndex : function(dir, url) {
        return Tilepin.P.ninvoke(FS, 'readdir', dir).then(function(list) {
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
        var promise = Tilepin.IO.mkdirs(dataDir);
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
            var diferred = Tilepin.P.defer();
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
        return Tilepin.P.ninvoke(FS, 'mkdir', dataDir).then(f, f).then(function() {
            var options = Url.parse(url);
            return httpGet(options, 0).then(function(res) {
                var diferred = Tilepin.P.defer();
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
        var zipEntries = zip.getEntries(); // an array of
        // ZipEntry records
        return Tilepin.P.all(_.map(zipEntries, function(zipEntry) {
            var file = Path.join(dataDir, zipEntry.entryName);
            zip.extractEntryTo(zipEntry.entryName, dataDir, true, true);
        }));
    },

    _readProjectFile : function(dir) {
        var names = [ 'project.yml', 'project.mml' ];
        return Tilepin.P().then(function() {
            var path = _.find(_.map(names, function(name) {
                return Path.join(dir, name);
            }), function(path) {
                return FS.existsSync(path);
            });
            if (!path) {
                var msg = 'Project file not found (';
                msg += names.join(' / ');
                msg += '). Dir: "' + dir + '".';
                throw new Error(msg);
            }
            return Tilepin.IO.readString(path).then(function(str) {
                var obj = Yaml.load(str);
                return {
                    pathname : path,
                    config : obj
                }
            });
        });
    },

    _processDataSources : function(projectDir, config) {
        var that = this
        return Tilepin.P.all(_.map(config.Layer, function(dataLayer) {
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
            return result;
        }));
        function prepareDbSource(dataLayer) {
            return Tilepin.P().then(function() {
                var file = dataLayer.Datasource.file //
                        || dataLayer.Datasource.query;
                var table = dataLayer.Datasource.table;
                if (file && !table) {
                    file = Path.join(projectDir, file);
                    return Tilepin.IO.readString(file).then(function(content) {
                        delete dataLayer.Datasource.file;
                        dataLayer.Datasource.table = '(' // 
                                + content + ') as data';
                    });
                }
            });
        }
        function prepareFileSource(dataLayer) {
            var url = dataLayer.Datasource.file;
            var promise = Tilepin.P();
            if (url && url.match(/^https?:\/\/.*$/gim)) {
                var layersDir = Path.join(projectDir, 'data');
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
    _loadProjectStyles : function(projectDir, config) {
        var that = this;
        return Tilepin.P.all(_.map(config.Stylesheet, function(stylesheet) {
            return that._loadProjectStyle(projectDir, stylesheet);
        })).then(function(styles) {
            config.Stylesheet = styles;
            return config;
        });
    },
    _loadProjectStyle : function(dir, stylesheet) {
        var promise = Tilepin.P();
        var id;
        if (_.isString(stylesheet)) {
            id = stylesheet;
            var fullPath = Path.join(dir, stylesheet);
            if (Path.extname(fullPath) == '.js') {
                promise = Tilepin.P().then(function() {
                    Tilepin.IO.clearObject(fullPath);
                    var obj = Tilepin.IO.loadObject(fullPath);
                    return obj;
                })
            } else {
                promise = Tilepin.IO.readString(fullPath);
            }
        } else {
            promise = Tilepin.P(stylesheet.cartocss);
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

});
