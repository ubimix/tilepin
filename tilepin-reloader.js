/**
 * This module is based on the code provided by Benjamin Gleitzman
 * (gleitz@mit.edu): https://gist.github.com/gleitz/6896099
 */

// Reloading modules from the repl in Node.js
// Benjamin Gleitzman (gleitz@mit.edu)
//
// Inspired by Ben Barkay
// http://stackoverflow.com/a/14801711/305414
//
// Usage: `node reload.js`
// You can load the module as usual
// var mymodule = require('./mymodule')
// And the reload it when needed
// mymodule = require.reload('./mymodule')
//
// I suggest using an alias in your .bashrc/.profile:
// alias node_reload='node /path/to/reload.js'

function Reloader(require) {
    this.require = require;
}

/**
 * Removes a module from the cache.
 */
Reloader.prototype.uncache = function(moduleName) {
    var that = this;
    // Run over the cache looking for the files
    // loaded by the specified module name
    that._searchCache(moduleName, function(mod) {
        delete that.require.cache[mod.id];
    });
};

/**
 * Runs over the cache to search for all the cached files.
 */
Reloader.prototype._searchCache = function(moduleName, callback) {
    var that = this;
    // Resolve the module identified by the specified name
    var mod = that.require.resolve(moduleName);

    // Check if the module has been resolved and found within
    // the cache
    if (mod && ((mod = that.require.cache[mod]) !== undefined)) {
        // Recursively go over the results
        (function run(mod) {
            // Go over each of the module's children and
            // run over it
            mod.children.forEach(function(child) {
                run(child);
            });

            // Call the specified callback providing the
            // found module
            callback(mod);
        })(mod);
    }
};

/**
 * Load a module, clearing it from the cache if necessary.
 */
Reloader.prototype.reload = function(moduleName) {
    var that = this;
    that.uncache(moduleName);
    return that.require(moduleName);
};

/**
 * Loads and returns a module corresponding to the specified name.
 */
Reloader.prototype.load = function(moduleName) {
    var that = this;
    return that.require(moduleName);
};

module.exports = Reloader;
