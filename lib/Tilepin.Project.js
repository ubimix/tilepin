var Tilepin = module.exports = require('./Tilepin');
require('./Tilepin.IO');
require('./Tilepin.P');
require('./Tilepin.Carto.Serializer');

var Millstone = require('millstone');
var _ = require('underscore');
var Carto = require('carto');
var Crypto = require('crypto');
var Path = require('path');

/**
 * Constructor of this class. It sets and checks parameters used by Mapnik
 * projects.
 * 
 * @param options.cacheDir
 *            path to the directory where temporary downloaded files should be
 *            stored; this directory is used when remote files referenced in
 *            datasource or in CSS are loaded on the local machine; default
 *            value is './tmp'
 * @param options.projectFile
 *            path to the project file; if this parameter is not defined then it
 *            will be the current directory + '/project.mml'
 */
Tilepin.Project = function(options) {
    this.options = options || {};
    _.defaults(this.options, {
        cacheDir : './tmp',
        projectFile : './project.mml'
    })
}
_.extend(Tilepin.Project, {
    toKey : function(str) {
        return Crypto.createHash('sha1').update(str).digest('hex');
    }
})
_.extend(Tilepin.Project.prototype, {

    /** Returns the internal non-prepared project configuration. */
    getProjectConfig : function() {
        return this._projectConfig;
    },

    /**
     * This method synchronously returns a caching key (SHA-1 hash)
     * corresponding to the specified parameters. If queries of this project
     * depend on input parameters then this method should return a unique key of
     * each new combination of such parameters. The returned value could be used
     * as a key for caching compiled Mapnik XML files as well as to cache
     * produced output results.
     */
    getCacheKey : function(params) {
        var that = this;
        var result;
        var script = that._getQueryScript();
        if (script) {
            var getKey = script.getKey || script.getId;
            if (_.isFunction(getKey)) {
                result = getKey.call(script, params);
            }
        }
        if (!result) {
            result = '';
        }
        result = Tilepin.Project.toKey(result);
        return result;
    },

    /**
     * Compiles the underlying project configuration object to a ready-to-use
     * Mapnik XML configuration.
     */
    prepareProjectConfig : function(params) {
        var that = this;
        return Tilepin.P()
        // Copy, process and return the project config using the specified
        // parameters
        .then(function() {
            return that._getProcessedConfig(params);
        })
        // Transform the modified config into a final Mapnik XML
        .then(function(config) {
            var projectFile = that._getProjectFile();
            var projectDir = that._getProjectDir();
            var renderer = new Carto.Renderer({
                filename : projectFile,
                local_data_dir : projectDir,
            });
            return renderer.render(config);
        });
    },

    /**
     * This method resolves the project - it downloads and fixes references to
     * all remote files referenced in datasources and CSS rules.
     * 
     * @param reload
     *            an optional flag forcing the project re-loading if it was
     *            already loaded
     */
    open : function(reload) {
        var that = this;
        if (that._projectConfig && reload == false) {
            return Tilepin.P(that._projectConfig);
        }
        if (that._loadingPromise) {
            return that._loadingPromise;
        }
        return that._loadingPromise = Tilepin.P.fin(Tilepin.P() //
        // Load project file
        .then(function() {
            delete that._projectConfig;
            var projectFile = that._getProjectFile()
            return Tilepin.IO.readYaml(projectFile);
        })
        // Load styles and queries from external files
        .then(function(config) {
            var promises = [];
            promises.push(that._loadProjectHandlers(config));
            promises.push(that._loadProjectDataSources(config));
            promises.push(that._loadProjectStyles(config));
            return Tilepin.P.all(promises).then(function() {
                return config;
            });
        })
        // Resolve all external references (download files, fix references to
        // style images etc)
        .then(function(mml) {
            return Tilepin.P.ninvoke(Millstone, 'resolve', {
                mml : mml,
                base : that._getProjectDir(),
                cache : that._getCacheDir()
            }).then(function(config) {
                that._projectConfig = config;
                return that._projectConfig;
            });
        }), function() {
            delete that._loadingPromise;
        });
    },

    /** Closes this project and removes all resources */
    close : function() {
        var that = this;
        var path = that._getQueryScriptPath(that._projectConfig);
        if (path) {
            Tilepin.IO.clearObject(path);
        }
        delete that._queryScript;
        delete that._handlers;
        delete that._loadingPromise;
        delete that._projectConfig;
    },

    /**
     * Loads and prepares all scripts and methods used to pre-process project
     * configuration and set/modify new parameters in the config.
     */
    _loadProjectHandlers : function(config) {
        var that = this;
        return Tilepin.P()
        // Load a script associated with this project
        .then(function() {
            var path = that._getQueryScriptPath(config);
            if (!path)
                return;
            that._queryScript = that._loadObject(path);
            return that._queryScript;
        })
        // Initializes handlers modifying datasource parameters for this
        // project
        .then(function(script) {
            that._handlers = [];
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

    /**
     * Process the datasources for the given project configuration. This method
     * loads external SQL queries etc.
     */
    _loadProjectDataSources : function(config) {
        var that = this;
        return Tilepin.P.all(_.map(config.Layer, function(dataLayer) {
            if (!dataLayer.Datasource)
                return;
            if (dataLayer.Datasource.type != 'postgis')
                return;
            return Tilepin.P().then(function() {
                var file = dataLayer.Datasource.file //
                        || dataLayer.Datasource.query;
                var table = dataLayer.Datasource.table;
                if (file && !table) {
                    var projectDir = that._getProjectDir();
                    file = Path.join(projectDir, file);
                    return Tilepin.IO.readString(file).then(function(content) {
                        delete dataLayer.Datasource.file;
                        dataLayer.Datasource.table = '(' //
                                + content + ') as data';
                    });
                }
            });
            return result;
        }));
    },

    /** Load and resolves all project styles */
    _loadProjectStyles : function(config) {
        var that = this;
        return Tilepin.P.all(_.map(config.Stylesheet, function(stylesheet) {
            return that._loadProjectStyle(stylesheet);
        })).then(function(styles) {
            config.Stylesheet = styles;
            return config;
        });
    },

    /**
     * Checks the specified style reference (or style object) if it contains
     * external references and tries to load these references.
     */
    _loadProjectStyle : function(stylesheet) {
        var that = this;
        var promise = Tilepin.P();
        var id;
        if (_.isString(stylesheet)) {
            id = stylesheet;
            var dir = that._getProjectDir();
            var fullPath = Path.resolve(dir, stylesheet);
            promise = Tilepin.P().then(function() {
                return that._loadObject(fullPath);
            }).then(function(config) {
                if (config)
                    return config;
                return Tilepin.IO.readString(fullPath);
            });
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
                css = Tilepin.Carto.Serializer.serialize(css);
            }
            return {
                id : id,
                data : css
            };
        })
    },

    /** Returns a full path to the script associated with this project */
    _getQueryScriptPath : function(config) {
        var that = this;
        var scriptName = config.handler || config.queryBuilder;
        if (!scriptName)
            return undefined;
        var projectDir = that._getProjectDir();
        var path = Path.resolve(projectDir, scriptName);
        return path;
    },

    /** Returns the script object associated with this project */
    _getQueryScript : function() {
        return this._queryScript;
    },

    /**
     * This method processes an internal project configuration into a new
     * instance with additional parameters injected by a project script and/or
     * by a method handing project credentials for data access.
     */
    _getProcessedConfig : function(params) {
        var that = this;
        var config = JSON.parse(JSON.stringify(that._projectConfig));
        return Tilepin.P().then(function() {
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
            var handlers = that._handlers;
            if (!handlers || !handlers.length)
                return;
            return Tilepin.P.all(_.map(config.Layer, function(dataLayer) {
                if (!dataLayer.Datasource)
                    return;
                var args = {
                    config : config,
                    dataLayer : dataLayer,
                    params : params
                };
                if (handlers.length == 1)
                    return handlers[0](args);
                return Tilepin.P.all(_.map(handlers, function(handler) {
                    return handler(args);
                }));
            }));
        }).then(function() {
            return config;
        })
    },

    /**
     * Loads and returns an external object corresponding to the specified path.
     * The given fullPath parameter could be a reference to a JSON file or to a
     * function returning such an object.
     */
    _loadObject : function(fullPath) {
        var result;
        var ext = Path.extname(fullPath);
        if (ext == '.js' || ext == '.json') {
            var args = _.toArray(arguments);
            Tilepin.IO.clearObject(fullPath);
            result = Tilepin.IO.loadObject.apply(Tilepin.IO, args);
        }
        return result;
    },

    /** Returns the full path to the project MML file/ */
    _getProjectFile : function() {
        return this.options.projectFile;
    },

    /** Returns path to the project directory */
    _getProjectDir : function() {
        var projectDir = this.options.projectDir;
        if (!projectDir) {
            var projectFile = this._getProjectFile();
            projectDir = Path.dirname(projectFile);
        }
        return projectDir;
    },

    /**
     * Returns full path to the temporary directory used to propertly
     * download/unzip project dependencies.
     */
    _getCacheDir : function() {
        var result = this.options.cacheDir;
        if (!result) {
            var projectDir = this._getProjectDir();
            result = Path.joint(projectDir, 'tmp');
        }
        return result;
    }

});
