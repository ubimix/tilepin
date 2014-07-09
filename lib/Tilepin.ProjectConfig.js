var Tilepin = module.exports = require('./Tilepin');
require('./Tilepin.IO');
require('./Tilepin.P');
require('./Tilepin.Carto.Styles');

var Millstone = require('millstone');
var _ = require('underscore');
var Carto = require('carto');
var Crypto = require('crypto');
var Path = require('path');

/* ---------------------------------------------------------------------- */
/**
 * A common superclass for configuration adapters. Configuration adapters are
 * managed by configuration objects and they give simplified access and
 * transformation of specific configuration parameters.
 */
Tilepin.ConfigAdapter = Tilepin.Class.extend({
    initialize : function(options) {
        if (!options || !options.config) {
            throw new Error('Configuration adapter requires configuration.');
        }
        this.setOptions(options);
    },
    /** Returns the main Tilepin.ProjectConfig instance. */
    getConfiguration : function() {
        return this.options.config;
    }
});
Tilepin.ConfigAdapter.register = function(config) {
    config.registerExtension(this);
}

/**
 * Mapnik adapter is used to generate Mapnik XML configurations based on
 * parameters defined in the underlying Tilepin.ProjectConfig instance.
 */
Tilepin.MapnikConfigAdapter = Tilepin.ConfigAdapter.extend({

});

/* ---------------------------------------------------------------------- */
/**
 * This class is used to manage TileMill project configurations and transform
 * them in Mapnik XML configurations.
 */
Tilepin.ProjectConfig = Tilepin.Class.extend({

    /**
     * Constructor of this class. It sets and checks parameters used by Mapnik
     * projects.
     * 
     * @param options.cacheDir
     *            path to the directory where temporary downloaded files should
     *            be stored; this directory is used when remote files referenced
     *            in datasource or in CSS are loaded on the local machine;
     *            default value is './tmp'
     * @param options.projectFile
     *            path to the project file; if this parameter is not defined
     *            then it will be the current directory + '/project.mml'
     */
    initialize : function(options) {
        this.options = options || {};
        _.defaults(this.options, {
            cacheDir : './tmp'
        })
        that._adapterIndex = {};
    },

    /**
     * Returns a promise for an adapter instance of the specified type. If such
     * an instance already exist in this configuration then it is immediately
     * returned (via promise); otherwise a new instance is created, opened and
     * returned.
     */
    getAdapter : function(Type) {
        var that = this;
        return Tilepin.P().then(function() {
            var index = that._adapterIndex;
            var adapter = index[Type];
            if (adapter) {
                return adapter;
            }
            adapter = index[Type] = new Type({
                config : this
            });
            if (that._opened) {
                return adapter.open().then(function() {
                    return adapter;
                });
            }
            return adapter;
        });
    },

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
        result = Tilepin.ProjectConfig.toKey(result);
        return result;
    },

    /**
     * Compiles the underlying project configuration object to a ready-to-use
     * Mapnik XML configuration. This method returns an object with two fields:
     * the 'config' field contains the processed configuration file (a JSON
     * object); the 'xml' field contains the resulting Mapnik XML configuration
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
            var projectDir = that._getProjectDir();
            return Tilepin.ProjectConfig.compileCartoCSS({
                config : config,
                dir : projectDir,
            }).then(function(xml) {
                return {
                    config : config,
                    xml : xml
                }
            })
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
        if (that._opened && !reload) {
            return Tilepin.P(this);
        }
        if (that._loadingPromise) {
            return that._loadingPromise;
        }
        return that._loadingPromise = Tilepin.P.fin(Tilepin.P() //
        // Load project file
        .then(function() {
            delete that._projectConfig;
            delete that._rawProjectConfig;
            return that._loadProjectConfig();
        })
        // Load styles and queries from external files
        .then(function(config) {
            that._rawProjectConfig = config;
            var promises = [];
            promises.push(that._loadProjectHandlers());
            promises.push(that._loadProjectDataSources());
            promises.push(that._loadProjectStyles());
            return Tilepin.P.all(promises).then(function() {
                return that._rawProjectConfig;
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
            that._opened = true;
        }), function() {
            delete that._loadingPromise;
        });
    },

    /** Closes this project and removes all resources */
    close : function() {
        var that = this;
        return Tilepin.P().then(function() {
            var path = that._getQueryScriptPath();
            if (path) {
                Tilepin.IO.clearObject(path);
            }
            delete that._queryScript;
            delete that._handlers;
            delete that._loadingPromise;
            delete that._projectConfig;
            delete that._rawProjectConfig;
        });
    },

    /**
     * Loads and prepares all scripts and methods used to pre-process project
     * configuration and set/modify new parameters in the config.
     */
    _loadProjectHandlers : function() {
        var that = this;
        return Tilepin.P()
        // Load a script associated with this project
        .then(function() {
            return that._getConfigHandler();
        })
        // Initializes handlers modifying datasource parameters for this project
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
     * Returns a javascript module/object used to prepare/handle project
     * configuration
     */
    _getConfigHandler : function() {
        var that = this;
        if (that._queryScript)
            return that._queryScript;
        var path = that._getQueryScriptPath();
        if (!path)
            return;
        that._queryScript = that._loadObject(path);
        return that._queryScript;

    },

    /**
     * Process the datasources for the given project configuration. This method
     * loads external SQL queries etc.
     */
    _loadProjectDataSources : function() {
        var that = this;
        var config = that._rawProjectConfig;
        function prepareMapnikDatasources() {
            return Tilepin.P.all(_.map(config.Layer, function(dataLayer) {
                return Tilepin.P().then(
                        function() {
                            if (!dataLayer.Datasource)
                                return;
                            if (dataLayer.Datasource.type != 'postgis')
                                return;
                            var file = dataLayer.Datasource.file //
                                    || dataLayer.Datasource.query;
                            var table = dataLayer.Datasource.table;
                            if (file && !table) {
                                var projectDir = that._getProjectDir();
                                file = Path.join(projectDir, file);
                                return Tilepin.IO.readString(file).then(
                                        function(content) {
                                            delete dataLayer.Datasource.file;
                                            dataLayer.Datasource.table = '(' //
                                                    + content + ') as data';
                                        });
                            }
                        });
            }));
        }
        function prepareEndpoints() {
            return Tilepin.P.all(_.map(config.Endpoint, function(dataLayer) {
                return Tilepin.P().then(
                        function() {
                            var file = dataLayer.file;
                            if (file) {
                                var projectDir = that._getProjectDir();
                                file = Path.join(projectDir, file);
                                return Tilepin.IO.readString(file).then(
                                        function(content) {
                                            delete dataLayer.file;
                                            dataLayer.query = content;
                                        });
                            }
                        });
            }));
        }
        return Tilepin.P
                .all([ prepareMapnikDatasources(), prepareEndpoints() ]);
    },

    /** Load and resolves all project styles */
    _loadProjectStyles : function() {
        var that = this;
        var config = that._rawProjectConfig;
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
                css = Tilepin.Carto.Styles.serialize(css);
            }
            return {
                id : id,
                data : css
            };
        })
    },

    /** Returns a full path to the script associated with this project */
    _getQueryScriptPath : function() {
        var that = this;
        var config = that._rawProjectConfig;
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

    /** Loads project configuration file from the file */
    _loadProjectConfig : function() {
        var that = this;
        var config = that.options.config;
        // There is already pre-loaded configuration. Just return it.
        if (config) {
            return Tilepin.P(config);
        }

        // Try to load one of existing configurations.
        // Priority is for "splitted" projects where data access configuration
        // is separated from style configurations;
        return Tilepin.P.all(
                [
                        that._readConfigFile('project.data.yml',
                                'project.data.json', 'project.data.mml'),
                        that._readConfigFile('project.style.yml',
                                'project.style.json', 'project.style.mml') ])//
        .then(
                function(configs) {
                    var dataConfig = configs[0];
                    var styleConfig = configs[1];
                    if (dataConfig || styleConfig) {
                        return _.extend({}, dataConfig, styleConfig);
                    }
                    // Try to load a default configuration file
                    return that._readConfigFile('project.yml', 'project.json',
                            'project.mml').then(function(config) {
                        if (config) {
                            return config;
                        }
                        var msg = 'Configuration file was not found. ' //
                                + 'One of the following files are expected: '//
                                + '1) Generic config: ' //
                                + 'project.yml/project.json / ' //
                                + 'project.mml' //
                                + '2) Data config: ' //
                                + 'project.data.yml / ' //
                                + 'project.data.json / ' //
                                + 'project.data.mml' //
                                + '3) Style config: ' //
                                + 'project.style.yml / ' //
                                + 'project.style.json /' //
                                + 'project.style.mml';
                        throw new Error(msg + '');
                    });
                })
    },

    /**
     * Read a configuration file from the project directory and returns a
     * promise for a JSON object. Name of the files to read is taken from the
     * specified list of possible names.
     */
    _readConfigFile : function() {
        var that = this;
        var args = _.toArray(arguments);
        return Tilepin.P().then(function() {
            var projectDir = that._getProjectDir();
            var list = _.map(args, function(file) {
                return Path.join(projectDir, file);
            });
            var file = Tilepin.IO.findExistingFile(list);
            return file ? Tilepin.IO.readYaml(file, true) : null;
        });
    },

    /** Returns path to the project directory */
    _getProjectDir : function() {
        var projectDir = this.options.projectDir;
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

_.extend(Tilepin.ProjectConfig, {

    /** Generates and returns SHA-1 hash of the specified string. */
    toKey : function(str) {
        return Crypto.createHash('sha1').update(str).digest('hex');
    },

    /**
     * Compiles the specified CartoCSS configuration to Mapnik XML
     * configuration.
     * 
     * @param options.config
     *            CartoCSS configuration in JSON format to compile
     * @param options.file
     *            path to the CartoCSS file
     * @param options.dir
     *            style directory; all relative references are resolved using
     *            this value
     * @returns a string serialized Mapnik XML configuration
     */
    compileCartoCSS : function(options) {
        var deferred = Tilepin.P.defer();
        try {
            var dir = options.dir;
            // FIXME: do we really need it?
            var file = Path.join(dir, 'project.mml');
            var renderer = new Carto.Renderer({
                filename : file,
                local_data_dir : dir,
            });
            // Callback for CartoCSS < v0.11
            var callback = Tilepin.P.nresolver(deferred);
            var result = renderer.render(options.config, callback);
            if (result) {
                // In case of the synchroneous reply (Carto v0.11)
                deferred.resolve(result);
            }
        } catch (e) {
            deferred.reject(e);
        }
        return deferred.promise;
    }
})
