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
_.extend(Tilepin.Project.prototype, {

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
        var result = '';
        var script = that.options.getKey || that.options.getId;
        if (_.isFunction(script)) {
            result = script.call(that, params);
        }
        if (!result) {
            result = '';
        } else if (!_.isString(result)) {
            result = result + '';
        }
        result = Crypto.createHash('sha1').update(result).digest('hex');
        return result;
    },

    /**
     * Loads and compiles the project configuration to a ready-to-use Mapnik
     * XML.
     */
    loadAndCompileConfig : function(params, reload) {
        var that = this;
        return that.loadProjectConfig(reload).then(function(config) {
            // Creates a deep copy of the project configuration.
            config = JSON.parse(JSON.stringify(config));
            return that.compileConfig(config, params);
        });
    },

    /**
     * Compiles the underlying project configuration object to a ready-to-use
     * Mapnik XML configuration.
     */
    compileConfig : function(config, params) {
        var that = this;
        return that._processProjectConfig(config, params) //
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
    loadProjectConfig : function(reload) {
        var that = this;
        if (that._projectConfig && !reload) {
            return Tilepin.P(that._projectConfig);
        }
        if (that._loadingPromise) {
            return that._loadingPromise;
        }
        that._loadingPromise = Tilepin.P.fin(Tilepin.P().then(function() {
            delete that._projectConfig;
            // Load project file
            var projectFile = that._getProjectFile()
            return Tilepin.IO.readYaml(projectFile);
        }).then(
                function(config) {
                    // Load styles and queries from external files
                    return Tilepin.P.all(
                            [ that._loadProjectDataSources(config),
                                    that._loadProjectStyles(config) ]).then(
                            function() {
                                return config;
                            });
                })
        // Resolve all external references (download files, fix
        // references to images etc)
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
        return that._loadingPromise;
    },

    /**
     * Processes the specified configuration object using request parameters.
     * This method returns a promise for the modified configuration.
     */
    _processProjectConfig : function(config, params) {
        return Tilepin.P().then(function() {
            // FIXME: add map filtering logic here (SQL changes etc)
            return config;
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
