var Tilepin = module.exports = require('./Tilepin');
require('./Tilepin.IO');
require('./Tilepin.ProjectConfig');

var _ = require('underscore');
var Path = require('path');

/**
 * This class provides access to individual functionalities of one project. It
 * allows to invoke services of one project, generate vector tiles and render
 * them and render directly maps for this project.
 * 
 * @param options.cacheDir
 *            path to the directory where temporary downloaded files should be
 *            stored; this directory is used when remote files referenced in
 *            datasource or in CSS are loaded on the local machine; default
 *            value is './tmp'
 * @param options.projectDir
 *            directory containing project configuration(s)
 */
Tilepin.Project = function(options) {
    this.options = options || {};
    _.defaults(this.options, {
        cacheDir : './tmp'
    })
}
_.extend(Tilepin.Project, {
    toHash : function(str) {
        return Crypto.createHash('sha1').update(str).digest('hex');
    }
})
_.extend(Tilepin.Project.prototype, {

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
        return that._loadingPromise = Tilepin.P.fin(Tilepin.P() //
        .then(function() {
            // TODO: Load project file and all

        }), function() {
            delete that._loadingPromise;
        });
    },

    /** Closes this project and removes all resources */
    close : function() {
        var that = this;
        return Tilepin.P().then(function() {
            // TODO:
        });
    },

// Functions:
// - Load tiles (vtile, png, svg, grid.json)
// - Generate a map (png, svg, pdf)
// - Call an service endpoint

// Steps:
// * Load ProjectConfig
// .. Registers adapters
// * Prepare config => layers / endpoints / ... - via adapters/wrappers? :
// .. Config#open => get all adapters and opens them
// * Get a prepared config:
// .. get an adapter ('mapnik', 'postgres', ...)
// .. prepare config via adapter: adapter.prepareConfig(params)
// .. Mapnik adapter produces a Mapnik XML file
// .. Db adapter produces a config for Postgres
// .. Each config contains a getCacheKey(params) method; keys are used to cache

});
