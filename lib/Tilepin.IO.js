var Tilepin = module.exports = require('./Tilepin');
var _ = require('underscore');
var FS = require('fs');
var Path = require('path');
var Yaml = require('js-yaml');

var IO = Tilepin.IO = {

    /**
     * Cleanup the cached loaded object.
     */
    clearObject : function(path) {
        var name = require(path);
        delete require.cache[name];
    },

    /**
     * Load an object corresponding to the specified path. It could be a JSON
     * object or a dynamic javascript module returning a module or a function
     * producing the final object.
     */
    loadObject : function(path) {
        IO.clearObject(path);
        var obj = require(path);
        var args = _.toArray(arguments);
        args.splice(0, 1);
        return _.isFunction(obj) ? obj.apply(obj, args) : obj;
    },

    /**
     * Finds and returns the first existing file from the specified list.
     */
    findExistingFile : function(files) {
        files = _.isString(files) ? [ files ] : _.toArray(files);
        return _.find(files, function(file) {
            return FS.existsSync(file);
        });
    },

    /** Read an UTF-8 encoded string from the specified file. */
    readString : function(file) {
        return Tilepin.P.ninvoke(FS, 'readFile', file, 'UTF-8');
    },

    /** Writes an UTF-8 encoded string in the specified file. */
    writeString : function(file, str) {
        return Tilepin.P.ninvoke(FS, 'writeFile', file, str, 'UTF-8');
    },

    /** Reads a JSON object from the specified file. */
    readJson : function(file) {
        return Tilepin.IO.readString(file).then(function(str) {
            try {
                return JSON.parse(str);
            } catch (e) {
                return {};
            }
        });
    },

    /** Writes a JSON object in the specified file. */
    writeJson : function(file, json) {
        json = json || {};
        var str = JSON.stringify(json);
        return Tilepin.IO.writeString(file, str);
    },

    /** Reads a Yaml object from the specified file. */
    readYaml : function(file, throwErr) {
        return Tilepin.IO.readString(file).then(function(str) {
            try {
                return Yaml.load(str, {
                    schema : Yaml.JSON_SCHEMA
                });
            } catch (e) {
                if (!!throwErr)
                    throw e;
                return {};
            }
        });
    },

    /** Writes a Yaml object in the specified file. */
    writeYaml : function(file, json) {
        json = json || {};
        var str = Yaml.safeDump(json);
        return Tilepin.IO.writeString(file, str);
    },

    deleteFile : function(file) {
        if (!FS.existsSync(file))
            return Tilepin.P(true);
        return Tilepin.P.ninvoke(FS, 'unlink', file).then(function() {
            return true;
        }, function(err) {
            // File does not exist anymore.
            if (err.code == 'ENOENT')
                return true;
            throw err;
        });
    },

    mkdirs : function(dir) {
        var promise = Tilepin.P();
        if (!FS.existsSync(dir)) {
            promise = promise.then(function() {
                var segments = dir.split('/');
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
        return promise;
    },

    visit : function visit(file, visitor) {
        return Tilepin.P
                .ninvoke(FS, 'stat', file)
                .then(
                        function(stat) {
                            var directory = !!stat && stat.isDirectory();
                            return Tilepin
                                    .P()
                                    .then(function() {
                                        return visitor(file, directory);
                                    })
                                    .then(
                                            function(result) {
                                                if (result === false
                                                        || !directory)
                                                    return;
                                                return Tilepin.P
                                                        .ninvoke(FS, 'readdir',
                                                                file)
                                                        .then(
                                                                function(list) {
                                                                    return Tilepin.P
                                                                            .all(_
                                                                                    .map(
                                                                                            list,
                                                                                            function(
                                                                                                f) {
                                                                                                var child = Path
                                                                                                        .join(
                                                                                                                file,
                                                                                                                f);
                                                                                                return visit(
                                                                                                        child,
                                                                                                        visitor);
                                                                                            }));
                                                                });
                                            })
                        })
    }
}
