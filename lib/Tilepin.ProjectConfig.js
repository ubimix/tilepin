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
        this.config = options.config;
        this.setOptions(options);
    },

    /** Opens this adapter. */
    open : function() {
        console.log('[Tilepin.ConfigAdapter#open]');
        return Tilepin.P();
    },

    /** Closes this adapter. */
    close : function() {
        return this.clear();
    },

    /** Clear all resources associated with this adapter. */
    clear : function() {
        return Tilepin.P();
    },

});

/** Generates and returns SHA-1 hash of the specified string. */
Tilepin.ConfigAdapter.getHash = function(str) {
    return Crypto.createHash('sha1').update(str).digest('hex');
};

/**
 * This adapter prepares Postgres datalayers. It loads SQL queries from external
 * files, inject credentials to access to the DB.
 */
Tilepin.ConfigAdapter.PostgresLayers = Tilepin.ConfigAdapter.extend({

    /** Loading all SQL queries for all datalayers. */
    open : function() {
        var that = this;
        return Tilepin.P().then(
                function() {
                    that._handlers = [];
                    return Tilepin.P.all([ that._loadSQL(),
                            that._prepareProcessingHandlers() ]);
                });
    },

    /** Clears all resources defined by this configuration adapter. */
    clear : function() {
        var that = this;
        return Tilepin.P().then(function() {
            delete that._getCacheKey;
            delete that._handlers;
        });
    },

    /**
     * This method synchronously returns a caching key reflecting the specified
     * set of important parameters. If final configuration of this project
     * depends on input parameters then this method should return a unique
     * string key of each new combination of such parameters. This method is
     * called by Tilepin.ConfigAdapter.MapnikAdapter instances to prepare
     * configuration.
     */
    $getMapnikCacheKey : function(params) {
        var that = this;
        params = params || {};
        if (!that._getCacheKey) {
            var names = [ 'getMapCacheKey', 'getCacheKey', //
            /* deprecated method names */
            'getKey', 'getId' ];
            that._getCacheKey = that.config.getConfigHandlerMethod(names);
        }
        return that._getCacheKey(params);
    },

    /**
     * Process the specified configuration object. This method is called by
     * Tilepin.ConfigAdapter.MapnikAdapter instances to prepare configuration.
     */
    $prepareMapnikConfig : function(obj, params) {
        var that = this;
        return Tilepin.P().then(function() {
            params = params || {};
            if (!obj.Layer || !obj.Layer.length)
                return;
            var handlers = that._handlers;
            if (!handlers || !handlers.length)
                return;
            return Tilepin.P.all(_.map(obj.Layer, function(dataLayer) {
                if (!dataLayer.Datasource)
                    return;
                var args = {
                    obj : obj,
                    config : obj,
                    dataLayer : dataLayer,
                    params : params
                };
                if (handlers.length == 1)
                    return handlers[0](args);
                return Tilepin.P.all(_.map(handlers, function(handler) {
                    return handler(args);
                }));
            }));
        });
    },

    /**
     * Loads SQL queries from external files and injects them in the
     * corresponding datalayers
     */
    _loadSQL : function() {
        var that = this;
        return Tilepin.P().then(function() {
            var obj = that.config.getConfigObject();
            return Tilepin.P.all(_.map(obj.Layer, function(dataLayer) {
                return Tilepin.P().then(function() {
                    if (!dataLayer.Datasource)
                        return;
                    if (dataLayer.Datasource.type != 'postgis')
                        return;
                    var file = dataLayer.Datasource.file //
                            || dataLayer.Datasource.query;
                    var table = dataLayer.Datasource.table;
                    if (file && !table) {
                        var projectDir = that.config.getProjectDir();
                        file = Path.join(projectDir, file);
                        return Tilepin.IO.readString(file)//
                        .then(function(content) {
                            delete dataLayer.Datasource.file;
                            dataLayer.Datasource.table = '(' //
                                    + content + ') as data';
                        });
                    }
                });
            }));
        })
    },

    /**
     * Checks and loads the "getKey" and "prepareDatasource" methods in a script
     * associated with the configuration. They are used to define hashing key
     * for input parameters and inject these parameter in SQL.
     */
    _prepareProcessingHandlers : function() {
        var that = this;
        return Tilepin.P().then(
                function() {
                    var method = that.config
                            .getConfigHandlerMethod([ 'prepareDatasource' ]);
                    that._handlers.push(method);
                    method = that.config
                            .getOptionsHandlerMethod([ 'handleDatalayer' ]);
                    that._handlers.push(method);
                });
    },
});

/** Prepares CartoCSS styles */
Tilepin.ConfigAdapter.CartoCSS = Tilepin.ConfigAdapter.extend({

    /** Opens this adapter. */
    open : function() {
        var that = this;
        return Tilepin.P().then(function() {
            var obj = that.config.getConfigObject();
            return Tilepin.P.all(_.map(obj.Stylesheet, function(stylesheet) {
                return that._loadProjectStyle(stylesheet);
            })).then(function(styles) {
                obj.Stylesheet = styles;
            });
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
            var projectDir = that.config.getProjectDir();
            var fullPath = Path.resolve(projectDir, stylesheet);
            promise = Tilepin.P().then(function() {
                return that.config._loadObject(fullPath);
            }).then(function(css) {
                if (css) {
                    return css;
                }
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
})

/**
 * Mapnik adapter is used to generate Mapnik XML configurations based on
 * parameters defined in the underlying Tilepin.ProjectConfig instance.
 */
Tilepin.ConfigAdapter.MapnikAdapter = Tilepin.ConfigAdapter.extend({

    /**
     * Resolve all external references (download files, fix references to style
     * images etc).
     */
    open : function() {
        var that = this;
        return Tilepin.P().then(function(mml) {
            var confObj = that.config.getConfigObject();
            var projectDir = that.config.getProjectDir();
            var cacheDir = that.config.getCacheDir();
            return Tilepin.P.ninvoke(Millstone, 'resolve', {
                mml : confObj,
                base : projectDir,
                cache : cacheDir
            }).then(function(obj) {
                // Set the processed object to the configuration
                that.config.setConfigObject(obj);
                return obj;
            });
        })
    },

    /** Clears all resources defined by this configuration adapter. */
    clear : function() {
        var that = this;
        return Tilepin.P().then(function() {
            delete that._getCacheKey;
            delete that._handlers;
        });
    },

    /**
     * This method synchronously returns a caching key reflecting set of
     * important parameters. If final configuration of this project depends on
     * input parameters then this method returns a unique string key of each new
     * combination of such parameters. The returned value is used to build a key
     * for caching for compiled Mapnik XML files as well as to cache produced
     * output results.
     */
    getMapnikCacheKey : function(params) {
        var that = this;
        if (!that._getCacheKey) {
            var adapters = _.filter(that.config.getAdapters(),
                    function(adapter) {
                        return _.isFunction(adapter.$getMapnikCacheKey);
                    });
            that._getCacheKey = function(params) {
                var str = '';
                _.each(adapters, function(adapter) {
                    var s = adapter.$getMapnikCacheKey(params);
                    if (s) {
                        str += s;
                    }
                })
                return Tilepin.ConfigAdapter.getHash(str);
            }
        }
        return that._getCacheKey(params);
    },

    /** Prepare and return a promise for a Mapnik XML configuration. */
    prepareMapnikConfig : function(params) {
        var that = this;
        // Transform the modified config into a final Mapnik XML
        return Tilepin.P().then(function() {
            var configObj = that.config.getConfigObject(true);
            var adapters = that.config.getAdapters();
            adapters = _.filter(adapters, function(adapter) {
                return _.isFunction(adapter.$prepareMapnikConfig);
            });
            return Tilepin.P.all(_.map(adapters, function(adapter) {
                return adapter.$prepareMapnikConfig(configObj, params);
            })).then(function() {
                var projectDir = that.config.getProjectDir();
                return that._compileCartoCSS({
                    config : configObj,
                    dir : projectDir,
                }).then(function(xml) {
                    return {
                        config : configObj,
                        xml : xml
                    }
                })
            });
        });
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
    _compileCartoCSS : function(options) {
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

/**
 * Tilepin.ProjectConfig class is responsible for preparation of configurations
 * used by Mapnik and by service endpoints. One configuration file on the disk
 * could generate a number of final configurations depending on request
 * parameters. To create a final configuration objects the Tilepin.ProjectConfig
 * class uses adapters. Each adapter is responsible for preparation of some
 * specific fields of the configuration object. For example
 * Tilepin.Config.CartoCSSAdapter could generate CartoCSS styles while
 * Tilepin.Config.PostgresAdapter generates SQL queries and injects credentials
 * required to access to the DB. Some adapters are used to generate Mapnik
 * configurations, while others are required to prepare service endpoints.
 */

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
        var that = this;
        that.options = options || {};
        _.defaults(that.options, {
            cacheDir : './tmp'
        })
        that._adapterIndex = {};
        // FIXME: move it outside
        _.each([ Tilepin.ConfigAdapter.PostgresLayers,
                Tilepin.ConfigAdapter.CartoCSS,
                Tilepin.ConfigAdapter.MapnikAdapter ], function(Type) {
            that._registerAdapter(Type);
        })
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
            that._projectConfig = JSON.parse(JSON.stringify(config));
            return that._callAdapters('open');
        }).then(function() {
            that._opened = true;
            return that;
        }), function() {
            delete that._loadingPromise;
        });
    },

    /** Clears all internal resources associated with this project */
    clear : function() {
        var that = this;
        return Tilepin.P().then(function() {
            that._doClear();
            return that._callAdapters('clear');
        });
    },

    /** Closes this project and removes all resources */
    close : function() {
        var that = this;
        return Tilepin.P.fin(Tilepin.P().then(function() {
            return that._callAdapters('close');
        }), function() {
            that._opened = false;
            that._doClear();
        });
    },

    /** Returns all already registered adapters for this configuration */
    getAdapters : function() {
        return _.values(this._adapterIndex);
    },

    /**
     * Returns an adapter instance of the specified type. If there is no such an
     * adapter then this method returns null.
     */
    getAdapter : function(Type) {
        var that = this;
        if (!Type) {
            throw new Error('Adapter type is not defined.');
        }
        if (!that._opened) {
            throw new Error('Configuration object was not open.');
        }
        var adapter = that._adapterIndex[Type.typeId];
        return adapter;
    },

    /** Returns the pre-processed configuration object loaded from the disk. */
    getConfigObject : function(clone) {
        return clone ? JSON.parse(JSON.stringify(this._projectConfig))
                : this._projectConfig;
    },

    /** Sets a new configuration object after data processing */
    setConfigObject : function(obj) {
        this._projectConfig = obj;
    },

    /** Returns the non processed raw configuration object loaded from the disk. */
    getRawConfigObject : function() {
        return this._rawProjectConfig;
    },

    /** Creates and registers a new adapter of the specified type. */
    _registerAdapter : function(Type) {
        var that = this;
        var adapter = that._adapterIndex[Type.typeId] = new Type({
            config : that
        });
        return adapter;
    },

    /** Returns path to the project directory */
    getProjectDir : function() {
        var projectDir = this.options.projectDir;
        return projectDir;
    },

    /**
     * Returns full path to the temporary directory used to propertly
     * download/unzip project dependencies.
     */
    getCacheDir : function() {
        var result = this.options.cacheDir;
        if (!result) {
            var projectDir = this.getProjectDir();
            result = Path.joint(projectDir, 'tmp');
        }
        return result;
    },

    /**
     * Returns a javascript module/object used to prepare/handle project
     * configuration
     */
    getConfigHandler : function() {
        var that = this;
        if (that._queryScript)
            return that._queryScript;
        var path = that._getConfigHandlerPath();
        if (!path)
            return;
        that._queryScript = that._loadObject(path);
        return that._queryScript;
    },

    /**
     * This method returns a function of the configuration handler script
     * corresponding to the specified name. If no such a method was found then
     * this method returns a "do-nothing" method.
     */
    getConfigHandlerMethod : function(names) {
        return this._getHandlerMethod(this.getConfigHandler(), names);
    },

    /**
     * This method returns a function of the configuration handler script
     * corresponding to the specified name. If no such a method was found then
     * this method returns a "do-nothing" method.
     */
    getOptionsHandlerMethod : function(names) {
        return this._getHandlerMethod(this.options, names);
    },

    /** Returns a named method of the specificified object. */
    _getHandlerMethod : function(script, names) {
        var f;
        if (script) {
            var name = _.find(names, function(name) {
                return _.isFunction(script[name]);
            });
            f = name ? script[name] : null;
        }
        return _.isFunction(f) ? function() {
            return f.apply(script, arguments);
        } : function() {
        };
    },

    /** Clear all internal variables */
    _doClear : function() {
        var that = this;
        var path = that._getConfigHandlerPath();
        if (path) {
            Tilepin.IO.clearObject(path);
        }
        delete that._queryScript;
        delete that._loadingPromise;
        delete that._projectConfig;
        delete that._rawProjectConfig;
    },

    /** Returns a full path to the script associated with this project */
    _getConfigHandlerPath : function() {
        var that = this;
        var config = that._rawProjectConfig;
        if (!config)
            return undefined;
        var scriptName = config.handler || config.queryBuilder;
        if (!scriptName)
            return undefined;
        var projectDir = that.getProjectDir();
        var path = Path.resolve(projectDir, scriptName);
        return path;
    },

    /** Calls the specified method on all adapters */
    _callAdapters : function(method) {
        var that = this;
        var args = _.toArray(arguments);
        args.splice(0, 1);
        var adapters = that.getAdapters();
        var promise = Tilepin.P();
        _.each(adapters, function(adapter) {
            var f = adapter[method];
            if (_.isFunction(f)) {
                promise = promise.then(function() {
                    return f.apply(adapter, args);
                })
            }
        })
        return promise;
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
                                + 'One of the following files is expected: '//
                                + '1) Generic config: ' //
                                + 'project.yml/project.json / ' //
                                + 'project.mml ' //
                                + '2) Data config: ' //
                                + 'project.data.yml / ' //
                                + 'project.data.json / ' //
                                + 'project.data.mml ' //
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
            var projectDir = that.getProjectDir();
            var list = _.map(args, function(file) {
                return Path.join(projectDir, file);
            });
            var file = Tilepin.IO.findExistingFile(list);
            return file ? Tilepin.IO.readYaml(file, true) : null;
        });
    },

});
